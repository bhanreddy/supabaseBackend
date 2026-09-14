import sql from '../db.js';
import { activeStructureFilter, getSchoolFeeMode } from './feeModeService.js';
import { resolveAcademicYearCode } from './transportFeeService.js';
import { feeToday } from './feeRecoveryScope.js';

function money(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
}

/**
 * Resolves the active or selected academic year row for a school.
 */
export async function resolveFeeDueAcademicYear(schoolId, academicYearId = null) {
  if (academicYearId) {
    const [ay] = await sql`
      SELECT id, code, name, start_date, end_date, status
      FROM academic_years
      WHERE id = ${academicYearId}
        AND school_id = ${schoolId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (ay) return ay;
  }

  // Active academic year fallback
  const [activeAy] = await sql`
    SELECT id, code, name, start_date, end_date, status
    FROM academic_years
    WHERE school_id = ${schoolId}
      AND deleted_at IS NULL
      AND (status = 'ACTIVE' OR status = 'active')
    ORDER BY start_date DESC
    LIMIT 1
  `;
  if (activeAy) return activeAy;

  // Most recent academic year
  const [latestAy] = await sql`
    SELECT id, code, name, start_date, end_date, status
    FROM academic_years
    WHERE school_id = ${schoolId}
      AND deleted_at IS NULL
    ORDER BY start_date DESC
    LIMIT 1
  `;
  return latestAy || null;
}

/**
 * Authoritative student fee balance calculation and filtering query.
 *
 * Conforms strictly to SchoolIMS financial invariants:
 *   Total Fee - Concessions/Discounts - Amount Paid = Outstanding Due
 *
 * Includes transport pending fee, active fine balances, and previous-year arrears
 * where applicable.
 */
export async function getStudentsWithDueFees(schoolId, filters = {}) {
  const {
    academic_year_id = null,
    class_id = null,
    section_id = null,
    fee_status = 'Pending', // 'All', 'Pending', 'Partial', 'Paid', 'Overdue', 'Advance'
    min_due = null,
    max_due = null,
    fee_type_id = null,
    due_date_before = null,
    overdue_days_min = null,
    village_id = null,
    search = '',
    student_ids = null,
    page = 1,
    limit = 50,
    sort_by = 'student_name', // 'student_name', 'admission_no', 'class_name', 'due_amount', 'due_date'
    sort_dir = 'asc',
  } = filters;

  const academicYear = await resolveFeeDueAcademicYear(schoolId, academic_year_id);
  if (!academicYear) {
    return {
      academic_year: null,
      summary: { total_students: 0, total_fee: 0, total_paid: 0, total_concession: 0, total_due: 0 },
      students: [],
      pagination: { total: 0, page: 1, limit, total_pages: 0 },
    };
  }

  const feeMode = await getSchoolFeeMode(schoolId);
  const structureModeFilter = activeStructureFilter(feeMode);
  const today = feeToday();

  const safeLimit = limit === 'all' ? 10000 : Math.min(500, Math.max(1, parseInt(String(limit), 10) || 50));
  const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
  const offset = (pageNum - 1) * safeLimit;
  const searchText = typeof search === 'string' ? search.trim() : '';

  // Specific student IDs filter if provided
  const specificStudentFilter = Array.isArray(student_ids) && student_ids.length > 0
    ? sql`AND s.id = ANY(${student_ids}::uuid[])`
    : sql``;

  const classFilter = class_id ? sql`AND cs.class_id = ${class_id}` : sql``;
  const sectionFilter = section_id ? sql`AND cs.section_id = ${section_id}` : sql``;
  const villageFilter = village_id ? sql`AND st.stop_id = ${village_id}` : sql``;

  const searchFilter = searchText
    ? sql`AND (
        p.display_name ILIKE ${'%' + searchText + '%'}
        OR s.admission_no ILIKE ${'%' + searchText + '%'}
        OR se.roll_number ILIKE ${'%' + searchText + '%'}
        OR EXISTS (
          SELECT 1 FROM student_parents sp
          JOIN parents par ON par.id = sp.parent_id AND par.deleted_at IS NULL
          JOIN persons pp ON pp.id = par.person_id
          WHERE sp.student_id = s.id AND sp.school_id = ${schoolId} AND sp.deleted_at IS NULL
            AND pp.display_name ILIKE ${'%' + searchText + '%'}
        )
      )`
    : sql``;

  // Single-pass CTE query aggregating fees at student grain, joining deduped enrollments and transport
  const rawRows = await sql`
    WITH waiver_ledger AS (
      SELECT
        fa.student_id,
        COALESCE(SUM(fa.amount), 0)::numeric AS waived_amount
      FROM fee_adjustments fa
      JOIN student_fees sf ON sf.id = fa.student_fee_id
      JOIN fee_structures fs ON fs.id = sf.fee_structure_id
      WHERE fa.school_id = ${schoolId}
        AND fa.adjustment_type = 'waive'
        AND fa.student_fee_id IS NOT NULL
        AND fs.academic_year_id = ${academicYear.id}
        ${fee_type_id ? sql`AND fs.fee_type_id = ${fee_type_id}` : sql``}
      GROUP BY fa.student_id
    ),
    fee_agg AS (
      SELECT
        sf.student_id,
        COALESCE(SUM(sf.amount_due), 0)::numeric AS school_total_fee,
        GREATEST(
          COALESCE(SUM(sf.discount), 0),
          COALESCE(MAX(wl.waived_amount), 0)
        )::numeric AS discount_given,
        (
          COALESCE(SUM(sf.amount_due), 0)
          - GREATEST(
              COALESCE(SUM(sf.discount), 0),
              COALESCE(MAX(wl.waived_amount), 0)
            )
        )::numeric AS final_fee,
        COALESCE(SUM(sf.amount_paid), 0)::numeric AS paid_fee,
        GREATEST(
          COALESCE(SUM(sf.amount_due), 0)
          - GREATEST(
              COALESCE(SUM(sf.discount), 0),
              COALESCE(MAX(wl.waived_amount), 0)
            )
          - COALESCE(SUM(sf.amount_paid), 0),
          0
        )::numeric AS school_due_amount,
        COUNT(sf.id) FILTER (
          WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0
        )::int AS fee_item_count,
        MIN(sf.due_date) FILTER (
          WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0
        ) AS earliest_due_date,
        BOOL_OR(
          sf.due_date < CURRENT_DATE
          AND (sf.amount_due - sf.discount - sf.amount_paid) > 0
        ) AS is_school_overdue
      FROM student_fees sf
      JOIN fee_structures fs ON fs.id = sf.fee_structure_id
      LEFT JOIN waiver_ledger wl ON wl.student_id = sf.student_id
      WHERE sf.school_id = ${schoolId}
        AND fs.academic_year_id = ${academicYear.id}
        AND sf.deleted_at IS NULL
        AND fs.deleted_at IS NULL
        ${fee_type_id ? sql`AND fs.fee_type_id = ${fee_type_id}` : sql``}
        ${structureModeFilter}
      GROUP BY sf.student_id
    ),
    transport_agg AS (
      SELECT
        st.student_id,
        GREATEST(
          tf.fee_amount
          + COALESCE(adj.net_amount, 0)
          - COALESCE(pay.paid_amount, 0),
          0
        )::numeric AS transport_pending_fee,
        ay.end_date AS transport_due_date,
        (
          ay.end_date < CURRENT_DATE
          AND GREATEST(
            tf.fee_amount
            + COALESCE(adj.net_amount, 0)
            - COALESCE(pay.paid_amount, 0),
            0
          ) > 0
        ) AS is_transport_overdue
      FROM student_transport st
      JOIN academic_years ay ON ay.id = st.academic_year_id AND ay.school_id = ${schoolId} AND ay.deleted_at IS NULL
      JOIN transport_fee tf ON tf.stop_id = st.stop_id AND tf.route_id = st.route_id AND tf.academic_year = ay.code AND tf.school_id = ${schoolId} AND tf.is_active = TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(
          CASE WHEN fadj.adjustment_type = 'add' THEN fadj.amount ELSE -fadj.amount END
        )::numeric AS net_amount
        FROM fee_adjustments fadj
        WHERE fadj.school_id = ${schoolId}
          AND fadj.student_id = st.student_id
          AND fadj.transport_fee_id = tf.id
      ) adj ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(tfp.amount), 0)::numeric AS paid_amount
        FROM transport_fee_payments tfp
        WHERE tfp.school_id = ${schoolId}
          AND tfp.student_id = st.student_id
          AND tfp.academic_year = ay.code
      ) pay ON TRUE
      WHERE st.school_id = ${schoolId}
        AND st.academic_year_id = ${academicYear.id}
        AND st.is_active = TRUE
    ),
    fine_agg AS (
      SELECT
        f.student_id,
        COALESCE(SUM(f.outstanding_amount), 0)::numeric AS fine_pending_fee
      FROM fines f
      WHERE f.school_id = ${schoolId}
        AND f.status IN ('POSTED', 'PARTIALLY_PAID', 'PARTIALLY_WAIVED', 'DISPUTED')
      GROUP BY f.student_id
    ),
    enrollment_deduped AS (
      SELECT DISTINCT ON (se.student_id)
        se.student_id,
        se.roll_number,
        cs.class_id,
        cs.section_id,
        c.name AS class_name,
        sec.name AS section_name
      FROM student_enrollments se
      JOIN class_sections cs ON cs.id = se.class_section_id AND cs.deleted_at IS NULL
      JOIN classes c ON c.id = cs.class_id AND c.deleted_at IS NULL
      JOIN sections sec ON sec.id = cs.section_id AND sec.deleted_at IS NULL
      WHERE se.academic_year_id = ${academicYear.id}
        AND se.school_id = ${schoolId}
        AND se.status = 'active'
        AND se.deleted_at IS NULL
      ORDER BY se.student_id, se.start_date DESC, se.created_at DESC
    ),
    combined_students AS (
      SELECT
        s.id AS student_id,
        s.admission_no,
        p.display_name AS student_name,
        p.photo_url,
        ed.class_id,
        ed.class_name,
        ed.section_id,
        ed.section_name,
        ed.roll_number,
        ts.name AS village,
        tr.name AS route_name,
        COALESCE(fa.school_total_fee, 0)::numeric AS total_fee,
        COALESCE(fa.discount_given, 0)::numeric AS concession_amount,
        COALESCE(fa.paid_fee, 0)::numeric AS paid_amount,
        COALESCE(fa.school_due_amount, 0)::numeric AS tuition_due,
        COALESCE(ta.transport_pending_fee, 0)::numeric AS transport_due,
        COALESCE(fna.fine_pending_fee, 0)::numeric AS fine_due,
        (
          COALESCE(fa.school_due_amount, 0)
          + COALESCE(ta.transport_pending_fee, 0)
          + COALESCE(fna.fine_pending_fee, 0)
        )::numeric AS total_due,
        CASE
          WHEN fa.earliest_due_date IS NULL THEN ta.transport_due_date
          WHEN COALESCE(ta.transport_pending_fee, 0) > 0 THEN LEAST(fa.earliest_due_date, ta.transport_due_date)
          ELSE fa.earliest_due_date
        END AS earliest_due_date,
        (COALESCE(fa.is_school_overdue, FALSE) OR COALESCE(ta.is_transport_overdue, FALSE)) AS is_overdue,
        CASE
          WHEN (COALESCE(fa.school_due_amount, 0) + COALESCE(ta.transport_pending_fee, 0) + COALESCE(fna.fine_pending_fee, 0)) <= 0
               AND (COALESCE(fa.paid_fee, 0) > 0 OR COALESCE(fa.discount_given, 0) > 0) THEN 'Paid'
          WHEN (COALESCE(fa.is_school_overdue, FALSE) OR COALESCE(ta.is_transport_overdue, FALSE)) THEN 'Overdue'
          WHEN COALESCE(fa.paid_fee, 0) > 0
               AND (COALESCE(fa.school_due_amount, 0) + COALESCE(ta.transport_pending_fee, 0) + COALESCE(fna.fine_pending_fee, 0)) > 0 THEN 'Partial'
          WHEN (COALESCE(fa.school_due_amount, 0) + COALESCE(ta.transport_pending_fee, 0) + COALESCE(fna.fine_pending_fee, 0)) > 0 THEN 'Pending'
          ELSE 'All'
        END AS calculated_status
      FROM students s
      JOIN persons p ON p.id = s.person_id
      JOIN enrollment_deduped ed ON ed.student_id = s.id
      LEFT JOIN fee_agg fa ON fa.student_id = s.id
      LEFT JOIN transport_agg ta ON ta.student_id = s.id
      LEFT JOIN fine_agg fna ON fna.student_id = s.id
      LEFT JOIN student_transport st ON st.student_id = s.id
        AND st.academic_year_id = ${academicYear.id}
        AND st.school_id = ${schoolId}
        AND st.is_active = TRUE
      LEFT JOIN transport_stops ts ON ts.id = st.stop_id AND ts.deleted_at IS NULL
      LEFT JOIN transport_routes tr ON tr.id = st.route_id AND tr.deleted_at IS NULL
      WHERE s.school_id = ${schoolId}
        AND s.deleted_at IS NULL
        ${specificStudentFilter}
        ${classFilter}
        ${sectionFilter}
        ${villageFilter}
        ${searchFilter}
    )
    SELECT
      cs.*,
      CASE
        WHEN cs.earliest_due_date IS NOT NULL AND cs.earliest_due_date < CURRENT_DATE
        THEN (CURRENT_DATE - cs.earliest_due_date)::int
        ELSE 0
      END AS overdue_days
    FROM combined_students cs
    WHERE TRUE
      ${fee_status === 'Pending' ? sql`AND (cs.calculated_status = 'Pending' OR cs.calculated_status = 'Partial' OR cs.calculated_status = 'Overdue') AND cs.total_due > 0` : sql``}
      ${fee_status === 'Overdue' ? sql`AND cs.is_overdue = TRUE AND cs.total_due > 0` : sql``}
      ${fee_status === 'Partial' ? sql`AND cs.calculated_status = 'Partial' AND cs.total_due > 0` : sql``}
      ${fee_status === 'Paid' ? sql`AND cs.calculated_status = 'Paid'` : sql``}
      ${min_due != null && min_due !== '' ? sql`AND cs.total_due >= ${Number(min_due)}` : sql``}
      ${max_due != null && max_due !== '' ? sql`AND cs.total_due <= ${Number(max_due)}` : sql``}
      ${due_date_before ? sql`AND cs.earliest_due_date <= ${due_date_before}::date` : sql``}
      ${overdue_days_min ? sql`AND cs.earliest_due_date <= (CURRENT_DATE - ${parseInt(overdue_days_min, 10)} * INTERVAL '1 day') AND cs.total_due > 0` : sql``}
  `;

  // Compute aggregate totals across all matching rows
  const summary = rawRows.reduce(
    (acc, row) => ({
      total_students: acc.total_students + 1,
      total_fee: acc.total_fee + money(row.total_fee),
      total_concession: acc.total_concession + money(row.concession_amount),
      total_paid: acc.total_paid + money(row.paid_amount),
      total_due: acc.total_due + money(row.total_due),
      total_transport_pending: acc.total_transport_pending + money(row.transport_due),
    }),
    { total_students: 0, total_fee: 0, total_concession: 0, total_paid: 0, total_due: 0, total_transport_pending: 0 }
  );

  // Sorting
  const sortedRows = [...rawRows].sort((a, b) => {
    let comparison = 0;
    if (sort_by === 'student_name') {
      comparison = (a.student_name || '').localeCompare(b.student_name || '');
    } else if (sort_by === 'admission_no') {
      comparison = (a.admission_no || '').localeCompare(b.admission_no || '');
    } else if (sort_by === 'class_name') {
      comparison = (a.class_name || '').localeCompare(b.class_name || '');
    } else if (sort_by === 'due_amount') {
      comparison = Number(a.total_due || 0) - Number(b.total_due || 0);
    } else if (sort_by === 'due_date') {
      const da = a.earliest_due_date ? new Date(a.earliest_due_date).getTime() : 0;
      const db = b.earliest_due_date ? new Date(b.earliest_due_date).getTime() : 0;
      comparison = da - db;
    }
    return sort_dir === 'desc' ? -comparison : comparison;
  });

  // Pagination slice
  const paginatedRows = sortedRows.slice(offset, offset + safeLimit);

  // For the current page rows, resolve parent details efficiently via LATERAL
  const studentIdsForPage = paginatedRows.map((r) => r.student_id);
  const parentMap = new Map();

  if (studentIdsForPage.length > 0) {
    const parentDetails = await sql`
      SELECT
        sp.student_id,
        par.id as parent_id,
        pp.display_name AS parent_name,
        rt.name AS relation,
        COALESCE(
          (
            SELECT pc.contact_value
            FROM person_contacts pc
            WHERE pc.person_id = pp.id
              AND pc.school_id = ${schoolId}
              AND pc.contact_type = 'phone'
              AND pc.deleted_at IS NULL
              AND NULLIF(btrim(pc.contact_value), '') IS NOT NULL
            ORDER BY pc.is_primary DESC, pc.created_at
            LIMIT 1
          ),
          ''
        ) AS phone
      FROM student_parents sp
      JOIN parents par ON par.id = sp.parent_id AND par.deleted_at IS NULL
      JOIN persons pp ON pp.id = par.person_id
      LEFT JOIN relationship_types rt ON rt.id = sp.relationship_id
      WHERE sp.student_id = ANY(${studentIdsForPage}::uuid[])
        AND sp.school_id = ${schoolId}
        AND sp.deleted_at IS NULL
      ORDER BY
        CASE WHEN rt.name = 'Father' THEN 0 WHEN rt.name = 'Mother' THEN 1 ELSE 2 END,
        sp.is_primary_contact DESC
    `;

    for (const p of parentDetails) {
      if (!parentMap.has(p.student_id)) {
        parentMap.set(p.student_id, {
          father_name: p.relation === 'Father' ? p.parent_name : '',
          mother_name: p.relation === 'Mother' ? p.parent_name : '',
          primary_phone: p.phone || '',
        });
      } else {
        const entry = parentMap.get(p.student_id);
        if (p.relation === 'Father' && !entry.father_name) entry.father_name = p.parent_name;
        if (p.relation === 'Mother' && !entry.mother_name) entry.mother_name = p.parent_name;
        if (!entry.primary_phone && p.phone) entry.primary_phone = p.phone;
      }
    }
  }

  const enrichedStudents = paginatedRows.map((r) => {
    const parent = parentMap.get(r.student_id) || {};
    return {
      student_id: r.student_id,
      admission_no: r.admission_no,
      student_name: r.student_name,
      photo_url: r.photo_url,
      class_id: r.class_id,
      class_name: r.class_name,
      section_id: r.section_id,
      section_name: r.section_name,
      roll_number: r.roll_number,
      village: r.village || 'Not assigned',
      route_name: r.route_name || '',
      father_name: parent.father_name || 'Guardian',
      mother_name: parent.mother_name || '',
      contact_number: parent.primary_phone || '',
      total_fee: money(r.total_fee),
      concession_amount: money(r.concession_amount),
      paid_amount: money(r.paid_amount),
      tuition_due: money(r.tuition_due),
      transport_due: money(r.transport_due),
      fine_due: money(r.fine_due),
      due_amount: money(r.total_due),
      earliest_due_date: r.earliest_due_date ? new Date(r.earliest_due_date).toISOString().slice(0, 10) : null,
      is_overdue: Boolean(r.is_overdue),
      overdue_days: Number(r.overdue_days || 0),
      status: r.calculated_status,
      academic_year: academicYear.code,
    };
  });

  return {
    academic_year: {
      id: academicYear.id,
      code: academicYear.code,
      name: academicYear.name,
    },
    summary,
    students: enrichedStudents,
    pagination: {
      total: sortedRows.length,
      page: pageNum,
      limit: safeLimit,
      total_pages: Math.ceil(sortedRows.length / safeLimit),
    },
  };
}

/**
 * Retrieves full fee breakdown for a specific student for document rendering.
 */
export async function getStudentDetailedFeeBreakdown(schoolId, studentId, academicYearId = null) {
  const feeMode = await getSchoolFeeMode(schoolId);
  const structureModeFilter = activeStructureFilter(feeMode);

  const academicYear = await resolveFeeDueAcademicYear(schoolId, academicYearId);

  const feeItems = await sql`
    SELECT
      sf.id,
      sf.amount_due,
      sf.amount_paid,
      sf.discount,
      sf.due_date,
      sf.status,
      ft.name AS fee_type_name,
      ft.name_te AS fee_type_te,
      GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)::numeric AS balance_due
    FROM student_fees sf
    JOIN fee_structures fs ON fs.id = sf.fee_structure_id
    JOIN fee_types ft ON ft.id = fs.fee_type_id
    WHERE sf.student_id = ${studentId}
      AND sf.school_id = ${schoolId}
      AND fs.academic_year_id = ${academicYear.id}
      AND sf.deleted_at IS NULL
      AND fs.deleted_at IS NULL
      ${structureModeFilter}
    ORDER BY ft.sort_order ASC, sf.due_date ASC NULLS LAST
  `;

  return {
    academic_year: academicYear,
    items: feeItems.map((item) => ({
      id: item.id,
      fee_type: item.fee_type_name,
      fee_type_te: item.fee_type_te,
      amount_due: money(item.amount_due),
      discount: money(item.discount),
      amount_paid: money(item.amount_paid),
      balance_due: money(item.balance_due),
      due_date: item.due_date ? String(item.due_date).slice(0, 10) : null,
      status: item.status,
    })),
  };
}
