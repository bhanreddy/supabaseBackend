import sql from '../db.js';
import { getActiveAcademicYearCode } from './defaulterCarryForward.js';

/**
 * Resolve academic year code from query param or active year.
 */
export async function resolveAcademicYearCode(schoolId, academicYearParam, db = sql) {
  if (academicYearParam?.trim()) return academicYearParam.trim();
  return getActiveAcademicYearCode(schoolId, db);
}

/**
 * Sum of transport payments for a student in a given academic year.
 */
export async function getTransportPaidTotal(studentId, academicYear, schoolId, db = sql) {
  const [row] = await db`
    SELECT COALESCE(SUM(amount), 0)::numeric AS paid_total
    FROM transport_fee_payments
    WHERE student_id = ${studentId}
      AND school_id = ${schoolId}
      AND academic_year = ${academicYear}
  `;
  return Number(row?.paid_total || 0);
}

/**
 * Derived transport due for one student (fee from assigned stop, never stored per student).
 */
export async function getStudentTransportDue(studentId, academicYear, schoolId, db = sql) {
  const [row] = await db`
    SELECT
      st.id AS assignment_id,
      st.route_id,
      st.stop_id,
      tr.name AS route_name,
      ts.name AS stop_name,
      tf.id AS transport_fee_id,
      tf.fee_amount,
      tf.billing_cycle,
      COALESCE(adj.net_amount, 0)::numeric AS adjustment_total,
      COALESCE(adj.added_amount, 0)::numeric AS added_amount,
      COALESCE(adj.waived_amount, 0)::numeric AS waived_amount,
      COALESCE(adj.adjustment_count, 0)::int AS adjustment_count,
      ay.code AS academic_year
    FROM student_transport st
    JOIN academic_years ay ON st.academic_year_id = ay.id
    JOIN transport_routes tr ON st.route_id = tr.id AND tr.school_id = ${schoolId}
    LEFT JOIN transport_stops ts ON st.stop_id = ts.id AND ts.deleted_at IS NULL
    LEFT JOIN transport_fee tf
      ON tf.stop_id = st.stop_id
      AND tf.route_id = st.route_id
      AND tf.academic_year = ${academicYear}
      AND tf.school_id = ${schoolId}
      AND tf.is_active = TRUE
    LEFT JOIN LATERAL (
      SELECT
        SUM(CASE WHEN fa.adjustment_type = 'add' THEN fa.amount ELSE -fa.amount END) AS net_amount,
        SUM(fa.amount) FILTER (WHERE fa.adjustment_type = 'add') AS added_amount,
        SUM(fa.amount) FILTER (WHERE fa.adjustment_type = 'waive') AS waived_amount,
        COUNT(*) AS adjustment_count
      FROM fee_adjustments fa
      WHERE fa.school_id = ${schoolId}
        AND fa.student_id = ${studentId}
        AND fa.transport_fee_id = tf.id
    ) adj ON TRUE
    WHERE st.student_id = ${studentId}
      AND st.school_id = ${schoolId}
      AND st.is_active = TRUE
      AND ay.code = ${academicYear}
    LIMIT 1
  `;

  if (!row) return null;

  const paidAmount = await getTransportPaidTotal(studentId, academicYear, schoolId, db);
  const baseFeeAmount = row.transport_fee_id ? Number(row.fee_amount) : null;
  const adjustmentTotal = Number(row.adjustment_total || 0);
  const addedAmount = Number(row.added_amount || 0);
  const waivedAmount = Number(row.waived_amount || 0);
  const feeAmount = baseFeeAmount != null ? Math.max(baseFeeAmount + adjustmentTotal, 0) : null;
  const feeNotSet = !row.transport_fee_id || row.stop_id == null;
  const balanceDue = feeAmount != null ? Math.max(feeAmount - paidAmount, 0) : null;

  return {
    ...row,
    base_fee_amount: baseFeeAmount,
    fee_amount: feeAmount,
    adjustment_total: adjustmentTotal,
    added_amount: addedAmount,
    waived_amount: waivedAmount,
    paid_amount: paidAmount,
    balance_due: balanceDue,
    fee_not_set: feeNotSet,
    fee_type: 'transport',
  };
}

/**
 * Carry forward unpaid transport balances into defaulter_dues for the closing year.
 * Adds to an existing row when one already exists (tuition + transport combined).
 */
export async function carryForwardTransportUnpaid(tx, { schoolId, fromYearId, fromYearCode, createdBy }) {
  const unpaidRows = await tx`
    SELECT
      st.student_id,
      tf.fee_amount,
      COALESCE(adj.net_amount, 0)::numeric AS adjustment_total,
      COALESCE(pay.paid_total, 0)::numeric AS paid_total
    FROM student_transport st
    JOIN academic_years ay ON st.academic_year_id = ay.id
    JOIN transport_fee tf
      ON tf.stop_id = st.stop_id
      AND tf.route_id = st.route_id
      AND tf.academic_year = ay.code
      AND tf.school_id = ${schoolId}
      AND tf.is_active = TRUE
    LEFT JOIN LATERAL (
      SELECT SUM(CASE WHEN fa.adjustment_type = 'add' THEN fa.amount ELSE -fa.amount END) AS net_amount
      FROM fee_adjustments fa
      WHERE fa.student_id = st.student_id
        AND fa.school_id = ${schoolId}
        AND fa.transport_fee_id = tf.id
    ) adj ON TRUE
    LEFT JOIN LATERAL (
      SELECT SUM(amount) AS paid_total
      FROM transport_fee_payments tfp
      WHERE tfp.student_id = st.student_id
        AND tfp.school_id = ${schoolId}
        AND tfp.academic_year = ay.code
    ) pay ON TRUE
    WHERE st.school_id = ${schoolId}
      AND st.is_active = TRUE
      AND ay.id = ${fromYearId}
      AND st.stop_id IS NOT NULL
      AND GREATEST(tf.fee_amount + COALESCE(adj.net_amount, 0) - COALESCE(pay.paid_total, 0), 0) > 0
  `;

  if (unpaidRows.length === 0) {
    return { carried_count: 0 };
  }

  let carriedCount = 0;

  for (const row of unpaidRows) {
    const balance = Number(row.fee_amount) + Number(row.adjustment_total || 0) - Number(row.paid_total);
    if (!Number.isFinite(balance) || balance <= 0) continue;

    const [upserted] = await tx`
      INSERT INTO defaulter_dues (
        school_id,
        student_id,
        due_academic_year,
        original_amount,
        paid_amount,
        source,
        remarks,
        created_by
      )
      VALUES (
        ${schoolId},
        ${row.student_id},
        ${fromYearCode},
        ${balance},
        0,
        'carried_forward',
        ${'Transport fee arrears — ' + fromYearCode},
        ${createdBy}
      )
      ON CONFLICT (school_id, student_id, due_academic_year)
      DO UPDATE SET
        original_amount = defaulter_dues.original_amount + EXCLUDED.original_amount,
        remarks = CASE
          WHEN defaulter_dues.remarks IS NULL OR defaulter_dues.remarks = ''
            THEN EXCLUDED.remarks
          ELSE defaulter_dues.remarks || '; ' || EXCLUDED.remarks
        END,
        updated_at = NOW()
      RETURNING id
    `;

    if (upserted) carriedCount++;
  }

  return { carried_count: carriedCount, eligible_count: unpaidRows.length };
}
