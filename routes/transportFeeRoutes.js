import express from 'express';
import sql from '../db.js';
import { verifyToken, requirePermission } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  resolveAcademicYearCode,
  getStudentTransportDue,
  getTransportPaidTotal,
} from '../services/transportFeeService.js';
import { generateReceiptNo } from '../services/receiptNumberService.js';

const router = express.Router();

const VALID_PAYMENT_METHODS = ['cash', 'card', 'upi', 'bank_transfer', 'cheque', 'online'];
const VALID_BILLING_CYCLES = ['monthly', 'quarterly', 'term', 'annual'];

const accountsGuard = [
  verifyToken,
  requireRole('accounts', 'admin', 'principal'),
];

function isUniqueViolation(err) {
  return err?.code === '23505';
}

async function validateRouteStopOwnership(routeId, stopId, schoolId) {
  const [stop] = await sql`
    SELECT ts.id, ts.route_id
    FROM transport_stops ts
    JOIN transport_routes tr ON ts.route_id = tr.id
    WHERE ts.id = ${stopId}
      AND ts.route_id = ${routeId}
      AND ts.school_id = ${schoolId}
      AND tr.school_id = ${schoolId}
      AND ts.deleted_at IS NULL
  `;
  return stop || null;
}

/**
 * GET /transport/routes-with-fees?academic_year=
 * Routes + stops annotated with fee for the requested year (null if unset).
 */
router.get(
  '/routes-with-fees',
  [...accountsGuard, requirePermission('fees.view')],
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const academicYear = await resolveAcademicYearCode(schoolId, req.query.academic_year);

    if (!academicYear) {
      return sendError(res, 400, 'No academic year configured. Pass academic_year or set an active year.');
    }

    const routes = await sql`
      SELECT
        r.id,
        r.name,
        r.code,
        r.direction,
        r.is_active,
        b.bus_no
      FROM transport_routes r
      LEFT JOIN buses b ON r.bus_id = b.id AND b.school_id = ${schoolId}
      WHERE r.school_id = ${schoolId}
        AND r.is_active = TRUE
      ORDER BY r.name
    `;

    const stops = await sql`
      SELECT
        ts.id AS stop_id,
        ts.route_id,
        ts.name AS stop_name,
        ts.stop_order,
        ts.pickup_time,
        ts.drop_time,
        tf.id AS fee_id,
        tf.fee_amount,
        tf.billing_cycle,
        tf.is_active AS fee_is_active,
        COUNT(DISTINCT st.id) FILTER (WHERE st.is_active = TRUE) AS student_count
      FROM transport_stops ts
      LEFT JOIN transport_fee tf
        ON tf.stop_id = ts.id
        AND tf.route_id = ts.route_id
        AND tf.academic_year = ${academicYear}
        AND tf.school_id = ${schoolId}
        AND tf.is_active = TRUE
      LEFT JOIN student_transport st
        ON st.stop_id = ts.id
        AND st.route_id = ts.route_id
        AND st.school_id = ${schoolId}
        AND st.is_active = TRUE
      WHERE ts.school_id = ${schoolId}
        AND ts.deleted_at IS NULL
      GROUP BY ts.id, tf.id
      ORDER BY ts.route_id, ts.stop_order
    `;

    const stopsByRoute = new Map();
    for (const stop of stops) {
      if (!stopsByRoute.has(stop.route_id)) stopsByRoute.set(stop.route_id, []);
      stopsByRoute.get(stop.route_id).push({
        stop_id: stop.stop_id,
        stop_name: stop.stop_name,
        stop_order: stop.stop_order,
        pickup_time: stop.pickup_time,
        drop_time: stop.drop_time,
        student_count: Number(stop.student_count || 0),
        fee: stop.fee_id
          ? {
              id: stop.fee_id,
              fee_amount: Number(stop.fee_amount),
              billing_cycle: stop.billing_cycle,
            }
          : null,
        fee_not_set: !stop.fee_id,
      });
    }

    const payload = routes.map((r) => ({
      ...r,
      stops: stopsByRoute.get(r.id) || [],
    }));

    return sendSuccess(res, schoolId, { academic_year: academicYear, routes: payload });
  })
);

/**
 * POST /transport/fee
 * Set a stop's fee for an academic year.
 */
router.post(
  '/fee',
  [...accountsGuard, requirePermission('fees.manage')],
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { route_id, stop_id, academic_year, fee_amount, billing_cycle } = req.body;

    if (!route_id || !stop_id || !academic_year || fee_amount == null) {
      return sendError(res, 400, 'route_id, stop_id, academic_year, and fee_amount are required.');
    }

    const parsedAmount = Number(fee_amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
      return sendError(res, 400, 'fee_amount must be a non-negative number.');
    }

    const cycle = billing_cycle || 'term';
    if (!VALID_BILLING_CYCLES.includes(cycle)) {
      return sendError(res, 400, `billing_cycle must be one of: ${VALID_BILLING_CYCLES.join(', ')}`);
    }

    const stop = await validateRouteStopOwnership(route_id, stop_id, schoolId);
    if (!stop) {
      return sendError(res, 404, 'Route/stop not found for this school.');
    }

    try {
      const [fee] = await sql`
        INSERT INTO transport_fee (
          school_id, route_id, stop_id, academic_year,
          fee_amount, billing_cycle, created_by
        )
        VALUES (
          ${schoolId}, ${route_id}, ${stop_id}, ${academic_year},
          ${parsedAmount}, ${cycle}, ${req.user?.internal_id || null}
        )
        RETURNING *
      `;
      return sendSuccess(res, schoolId, fee, 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return sendError(
          res,
          409,
          'A fee for this stop and academic year already exists; edit it instead.'
        );
      }
      throw err;
    }
  })
);

/**
 * PATCH /transport/fee/:id
 */
router.patch(
  '/fee/:id',
  [...accountsGuard, requirePermission('fees.manage')],
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { id } = req.params;
    const { fee_amount, billing_cycle } = req.body;

    if (fee_amount == null && billing_cycle == null) {
      return sendError(res, 400, 'Provide fee_amount and/or billing_cycle to update.');
    }

    if (billing_cycle != null && !VALID_BILLING_CYCLES.includes(billing_cycle)) {
      return sendError(res, 400, `billing_cycle must be one of: ${VALID_BILLING_CYCLES.join(', ')}`);
    }

    if (fee_amount != null) {
      const parsed = Number(fee_amount);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return sendError(res, 400, 'fee_amount must be a non-negative number.');
      }
    }

    const [existing] = await sql`
      SELECT * FROM transport_fee
      WHERE id = ${id} AND school_id = ${schoolId} AND is_active = TRUE
    `;
    if (!existing) {
      return sendError(res, 404, 'Transport fee not found.');
    }

    const [updated] = await sql`
      UPDATE transport_fee
      SET
        fee_amount = ${fee_amount != null ? Number(fee_amount) : existing.fee_amount},
        billing_cycle = ${billing_cycle != null ? billing_cycle : existing.billing_cycle},
        updated_at = NOW()
      WHERE id = ${id}
        AND school_id = ${schoolId}
        AND is_active = TRUE
      RETURNING *
    `;

    return sendSuccess(res, schoolId, updated);
  })
);

/**
 * DELETE /transport/fee/:id — soft-delete
 */
router.delete(
  '/fee/:id',
  [...accountsGuard, requirePermission('fees.manage')],
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { id } = req.params;

    const [updated] = await sql`
      UPDATE transport_fee
      SET is_active = FALSE, updated_at = NOW()
      WHERE id = ${id}
        AND school_id = ${schoolId}
        AND is_active = TRUE
      RETURNING id, route_id, stop_id, academic_year
    `;

    if (!updated) {
      return sendError(res, 404, 'Transport fee not found.');
    }

    return sendSuccess(res, schoolId, { message: 'Transport fee deactivated', fee: updated });
  })
);

/**
 * GET /transport/student-fees?academic_year=&class_filter=&search=
 * Transport-opted students with DERIVED fee from assigned stop.
 */
router.get(
  '/student-fees',
  [...accountsGuard, requirePermission('fees.view')],
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { class_filter, search } = req.query;
    const academicYear = await resolveAcademicYearCode(schoolId, req.query.academic_year);

    if (!academicYear) {
      return sendError(res, 400, 'No academic year configured.');
    }

    const rows = await sql`
      SELECT
        s.id AS student_id,
        s.admission_no,
        p.display_name AS student_name,
        enroll.class_id,
        enroll.class_name,
        enroll.section_name,
        tr.id AS route_id,
        tr.name AS route_name,
        ts.id AS stop_id,
        ts.name AS stop_name,
        tf.id AS transport_fee_id,
        tf.fee_amount,
        tf.billing_cycle,
        COALESCE(adj.net_amount, 0)::numeric AS adjustment_total,
        COALESCE(adj.added_amount, 0)::numeric AS added_amount,
        COALESCE(adj.waived_amount, 0)::numeric AS waived_amount,
        COALESCE(adj.adjustment_count, 0)::int AS adjustment_count,
        COALESCE(pay.paid_total, 0)::numeric AS paid_amount
      FROM student_transport st
      JOIN students s ON st.student_id = s.id AND s.school_id = ${schoolId}
      JOIN persons p ON s.person_id = p.id
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
        WHERE fa.student_id = s.id
          AND fa.school_id = ${schoolId}
          AND fa.transport_fee_id = tf.id
      ) adj ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(amount) AS paid_total
        FROM transport_fee_payments tfp
        WHERE tfp.student_id = s.id
          AND tfp.school_id = ${schoolId}
          AND tfp.academic_year = ${academicYear}
      ) pay ON TRUE
      LEFT JOIN LATERAL (
        SELECT c.id AS class_id, c.name AS class_name, sec.name AS section_name
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections sec ON cs.section_id = sec.id
        WHERE se.student_id = s.id
          AND se.school_id = ${schoolId}
          AND se.status = 'active'
          AND se.deleted_at IS NULL
        ORDER BY se.created_at DESC
        LIMIT 1
      ) enroll ON TRUE
      WHERE st.school_id = ${schoolId}
        AND st.is_active = TRUE
        AND ay.code = ${academicYear}
        AND s.deleted_at IS NULL
        ${search ? sql`AND (
          p.display_name ILIKE ${'%' + search + '%'}
          OR s.admission_no ILIKE ${'%' + search + '%'}
        )` : sql``}
        ${class_filter ? sql`AND enroll.class_id = ${class_filter}` : sql``}
      ORDER BY p.display_name ASC
    `;

    const students = rows.map((r) => {
      const feeNotSet = !r.transport_fee_id || !r.stop_id;
      const baseFeeAmount = r.transport_fee_id ? Number(r.fee_amount) : null;
      const adjustmentTotal = Number(r.adjustment_total || 0);
      const feeAmount = baseFeeAmount != null ? Math.max(baseFeeAmount + adjustmentTotal, 0) : null;
      const paidAmount = Number(r.paid_amount || 0);
      const balanceDue = feeAmount != null ? Math.max(feeAmount - paidAmount, 0) : null;

      return {
        student_id: r.student_id,
        admission_no: r.admission_no,
        student_name: r.student_name,
        class_id: r.class_id,
        class_name: r.class_name,
        section_name: r.section_name,
        route_id: r.route_id,
        route_name: r.route_name,
        stop_id: r.stop_id,
        stop_name: r.stop_name,
        transport_fee_id: r.transport_fee_id,
        base_fee_amount: baseFeeAmount,
        fee_amount: feeAmount,
        adjustment_total: adjustmentTotal,
        added_amount: Number(r.added_amount || 0),
        waived_amount: Number(r.waived_amount || 0),
        adjustment_count: Number(r.adjustment_count || 0),
        billing_cycle: r.billing_cycle,
        paid_amount: paidAmount,
        balance_due: balanceDue,
        fee_not_set: feeNotSet,
        fee_type: 'transport',
        can_collect: !feeNotSet && balanceDue != null && balanceDue > 0,
      };
    });

    return sendSuccess(res, schoolId, { academic_year: academicYear, students });
  })
);

/**
 * POST /transport/collect
 * Collect transport fee for a student (derived from assigned stop).
 */
router.post(
  '/collect',
  [...accountsGuard, requirePermission('fees.collect')],
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { student_id, academic_year, amount, payment_method, transaction_ref, remarks } = req.body;

    if (!student_id || !amount || !payment_method || !transaction_ref) {
      return sendError(res, 400, 'student_id, amount, payment_method, and transaction_ref are required.');
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return sendError(res, 400, 'amount must be a positive number.');
    }

    if (!VALID_PAYMENT_METHODS.includes(payment_method)) {
      return sendError(res, 400, `payment_method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`);
    }

    const yearCode = await resolveAcademicYearCode(schoolId, academic_year);
    if (!yearCode) {
      return sendError(res, 400, 'No academic year configured.');
    }

    const due = await getStudentTransportDue(student_id, yearCode, schoolId);
    if (!due) {
      return sendError(res, 404, 'Student has no active transport assignment for this year.');
    }
    if (due.fee_not_set) {
      return sendError(res, 400, 'Fee not set for this stop. Set the stop fee before collecting.');
    }
    if (parsedAmount > Number(due.balance_due)) {
      return sendError(res, 400, `Amount exceeds remaining balance of ${due.balance_due}.`);
    }

    try {
      const result = await sql.begin(async (tx) => {
        const [existingTx] = await tx`
          SELECT id FROM transport_fee_payments
          WHERE school_id = ${schoolId} AND transaction_ref = ${transaction_ref}
        `;
        if (existingTx) {
          const err = new Error(`Transaction reference '${transaction_ref}' already exists.`);
          err.status = 409;
          throw err;
        }

        const [payment] = await tx`
          INSERT INTO transport_fee_payments (
            school_id,
            student_id,
            academic_year,
            transport_fee_id,
            amount,
            payment_method,
            transaction_ref,
            received_by,
            remarks
          )
          VALUES (
            ${schoolId},
            ${student_id},
            ${yearCode},
            ${due.transport_fee_id},
            ${parsedAmount},
            ${payment_method},
            ${transaction_ref},
            ${req.user?.internal_id || null},
            ${remarks || null}
          )
          RETURNING *
        `;

        const receiptNo = await generateReceiptNo(tx, schoolId);
        const receiptRemarks = remarks || `Transport fee — ${due.route_name} / ${due.stop_name} (${yearCode})`;

        const [receipt] = await tx`
          INSERT INTO receipts (
            school_id,
            receipt_no,
            student_id,
            total_amount,
            issued_by,
            remarks,
            payment_type,
            fee_type,
            transport_payment_id
          )
          VALUES (
            ${schoolId},
            ${receiptNo},
            ${student_id},
            ${parsedAmount},
            ${req.user?.internal_id || null},
            ${receiptRemarks},
            'fee',
            'transport',
            ${payment.id}
          )
          RETURNING *
        `;

        const paidTotal = await getTransportPaidTotal(student_id, yearCode, schoolId, tx);

        return { payment, receipt, due: { ...due, paid_amount: paidTotal, balance_due: Math.max(Number(due.fee_amount) - paidTotal, 0) } };
      });

      return sendSuccess(res, schoolId, { message: 'Transport fee collected', ...result }, 201);
    } catch (err) {
      if (err.status) return sendError(res, err.status, err.message);
      throw err;
    }
  })
);

export default router;
