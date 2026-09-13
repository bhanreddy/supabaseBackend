import sql from '../db.js';
import { recoveryFees, feeToday, assertFiniteRecoveryAmounts } from './feeRecoveryScope.js';

/**
 * Get aggregated fee recovery intelligence:
 * totals, collection efficiency, 6 deterministic ageing buckets, and class-wise breakdown.
 */
export async function getFeeRecoveryOverview(schoolId, { academicYearId = null } = {}) {
  const { query: fees } = await recoveryFees(schoolId);
  const today = feeToday();
  // 1. Core totals & 6 ageing buckets in a single optimized pass
  const [totals] = await sql`
    SELECT
      COALESCE(SUM(sf.amount_due - sf.discount), 0)::numeric AS total_expected,
      COALESCE(SUM(sf.amount_paid), 0)::numeric AS total_collected,
      COALESCE(SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)), 0)::numeric AS total_outstanding,
      COUNT(DISTINCT sf.student_id) FILTER (
        WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0
      )::int AS outstanding_students_count,

      -- Current (due today or in the future, or null due date)
      COALESCE(SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)) FILTER (
        WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0 AND (sf.due_date >= ${today}::date OR sf.due_date IS NULL)
      ), 0)::numeric AS amount_current,
      COUNT(DISTINCT sf.student_id) FILTER (
        WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0 AND (sf.due_date >= ${today}::date OR sf.due_date IS NULL)
      )::int AS count_current,

      -- 1-7 Days
      COALESCE(SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)) FILTER (
        WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0 AND ${today}::date - sf.due_date BETWEEN 1 AND 7
      ), 0)::numeric AS amount_1_7d,
      COUNT(DISTINCT sf.student_id) FILTER (
        WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0 AND ${today}::date - sf.due_date BETWEEN 1 AND 7
      )::int AS count_1_7d,

      -- 8-30 Days
      COALESCE(SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)) FILTER (
        WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0 AND ${today}::date - sf.due_date BETWEEN 8 AND 30
      ), 0)::numeric AS amount_8_30d,
      COUNT(DISTINCT sf.student_id) FILTER (
        WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0 AND ${today}::date - sf.due_date BETWEEN 8 AND 30
      )::int AS count_8_30d,

      -- 31-60 Days
      COALESCE(SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)) FILTER (
        WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0 AND ${today}::date - sf.due_date BETWEEN 31 AND 60
      ), 0)::numeric AS amount_31_60d,
      COUNT(DISTINCT sf.student_id) FILTER (
        WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0 AND ${today}::date - sf.due_date BETWEEN 31 AND 60
      )::int AS count_31_60d,

      -- 61-90 Days
      COALESCE(SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)) FILTER (
        WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0 AND ${today}::date - sf.due_date BETWEEN 61 AND 90
      ), 0)::numeric AS amount_61_90d,
      COUNT(DISTINCT sf.student_id) FILTER (
        WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0 AND ${today}::date - sf.due_date BETWEEN 61 AND 90
      )::int AS count_61_90d,

      -- 90+ Days
      COALESCE(SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)) FILTER (
        WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0 AND ${today}::date - sf.due_date > 90
      ), 0)::numeric AS amount_90_plus_d,
      COUNT(DISTINCT sf.student_id) FILTER (
        WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0 AND ${today}::date - sf.due_date > 90
      )::int AS count_90_plus_d

    FROM (${fees}) sf
    JOIN fee_structures fs ON sf.fee_structure_id = fs.id AND fs.school_id = ${schoolId}
    WHERE sf.school_id = ${schoolId}
      AND sf.deleted_at IS NULL
      ${academicYearId ? sql`AND fs.academic_year_id = ${academicYearId}` : sql``}
  `;

  assertFiniteRecoveryAmounts(totals.total_expected, totals.total_collected, totals.total_outstanding);
  const totalExpected = Number(totals?.total_expected || 0);
  const totalCollected = Number(totals?.total_collected || 0);
  const totalOutstanding = Number(totals?.total_outstanding || 0);
  const collectionEfficiency = totalExpected > 0 ? Math.round((totalCollected / totalExpected) * 1000) / 10 : 0;

  // 2. Class-wise outstanding breakdown
  const classBreakdown = await sql`
    SELECT
      c.id AS class_id,
      COALESCE(c.name, 'Unassigned') AS class_name,
      COUNT(DISTINCT sf.student_id) FILTER (
        WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0
      )::int AS defaulters_count,
      COALESCE(SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)), 0)::numeric AS outstanding_amount
    FROM (${fees}) sf
    JOIN fee_structures fs ON sf.fee_structure_id = fs.id AND fs.school_id = ${schoolId}
    JOIN students s ON sf.student_id = s.id AND s.school_id = ${schoolId}
    LEFT JOIN LATERAL (SELECT e.* FROM student_enrollments e WHERE e.student_id = s.id AND e.school_id = ${schoolId} AND e.status = 'active' AND e.deleted_at IS NULL ORDER BY e.start_date DESC, e.id LIMIT 1) se ON true
    LEFT JOIN class_sections cs ON se.class_section_id = cs.id AND cs.school_id = ${schoolId}
    LEFT JOIN classes c ON cs.class_id = c.id AND c.school_id = ${schoolId}
    WHERE sf.school_id = ${schoolId}
      AND sf.deleted_at IS NULL
      AND s.deleted_at IS NULL
      ${academicYearId ? sql`AND fs.academic_year_id = ${academicYearId}` : sql``}
    GROUP BY c.id, c.name
    HAVING SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)) > 0
    ORDER BY outstanding_amount DESC
  `;

  // 3. Count reminders sent in the last 30 days
  const [reminderStats] = await sql`
    SELECT COUNT(*)::int AS reminders_sent_30d
    FROM automation_execution_logs
    WHERE school_id = ${schoolId}
      AND rule_key = 'fee_due_reminder'
      AND status = 'completed'
      AND executed_at > now() - interval '30 days'
  `;

  const result = {
    school_id: schoolId,
    summary: {
      total_expected: totalExpected,
      total_collected: totalCollected,
      total_outstanding: totalOutstanding,
      collection_efficiency: collectionEfficiency,
      outstanding_students_count: Number(totals?.outstanding_students_count || 0),
      reminders_sent_30d: Number(reminderStats?.reminders_sent_30d || 0),
    },
    ageing_buckets: {
      current: { label: 'Current', amount: Number(totals?.amount_current || 0), count: Number(totals?.count_current || 0) },
      days_1_7: { label: '1–7 Days', amount: Number(totals?.amount_1_7d || 0), count: Number(totals?.count_1_7d || 0) },
      days_8_30: { label: '8–30 Days', amount: Number(totals?.amount_8_30d || 0), count: Number(totals?.count_8_30d || 0) },
      days_31_60: { label: '31–60 Days', amount: Number(totals?.amount_31_60d || 0), count: Number(totals?.count_31_60d || 0) },
      days_61_90: { label: '61–90 Days', amount: Number(totals?.amount_61_90d || 0), count: Number(totals?.count_61_90d || 0) },
      days_90_plus: { label: '90+ Days', amount: Number(totals?.amount_90_plus_d || 0), count: Number(totals?.count_90_plus_d || 0) },
    },
    class_breakdown: classBreakdown.map((r) => ({
      class_id: r.class_id,
      class_name: r.class_name,
      defaulters_count: Number(r.defaulters_count || 0),
      outstanding_amount: Number(r.outstanding_amount || 0),
    })),
    generated_at: new Date().toISOString(),
  };

  return result;
}

/**
 * Get paginated list of fee defaulters with explainable segmentation badges,
 * ageing stages, last payment, and last reminder history.
 */
export async function getFeeDefaultersList(schoolId, {
  classId = null,
  sectionId = null,
  ageingStage = null,
  segmentation = null,
  search = null,
  minPaidPercent = null,
  maxPaidPercent = null,
  page = 1,
  limit = 50,
} = {}) {
  const safePage = Math.min(1000000, Math.max(1, parseInt(String(page), 10) || 1));
  const safeLimit = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 50));
  const offset = (safePage - 1) * safeLimit;

  const { query: fees } = await recoveryFees(schoolId);
  const today = feeToday();
  const baseQuery = sql`
    WITH student_arrears AS MATERIALIZED (
      SELECT
        sf.student_id,
        s.admission_no,
        p.display_name AS student_name,
        COALESCE(c.name, 'Unassigned') AS class_name,
        COALESCE(sec.name, '') AS section_name,
        c.id AS class_id,
        sec.id AS section_id,
        SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0))::numeric AS total_outstanding,
        SUM(GREATEST(sf.amount_due - sf.discount, 0))::numeric AS total_due,
        SUM(GREATEST(sf.amount_paid, 0))::numeric AS total_paid,
        ROUND(
          CASE
            WHEN SUM(GREATEST(sf.amount_due - sf.discount, 0)) <= 0 THEN 0
            ELSE LEAST(100, (SUM(GREATEST(sf.amount_paid, 0)) / SUM(GREATEST(sf.amount_due - sf.discount, 0))) * 100)
          END,
          1
        )::float AS paid_percentage,
        MIN(sf.due_date) AS oldest_due_date,
        GREATEST(${today}::date - MIN(sf.due_date), 0)::int AS days_overdue,
        COUNT(sf.id) FILTER (WHERE sf.due_date < ${today}::date)::int AS overdue_fees_count
      FROM (${fees}) sf
      JOIN students s ON sf.student_id = s.id AND s.school_id = ${schoolId}
      JOIN persons p ON s.person_id = p.id AND p.school_id = ${schoolId}
      LEFT JOIN LATERAL (SELECT e.* FROM student_enrollments e WHERE e.student_id = s.id AND e.school_id = ${schoolId} AND e.status = 'active' AND e.deleted_at IS NULL ORDER BY e.start_date DESC, e.id LIMIT 1) se ON true
      LEFT JOIN class_sections cs ON se.class_section_id = cs.id AND cs.school_id = ${schoolId}
      LEFT JOIN classes c ON cs.class_id = c.id AND c.school_id = ${schoolId}
      LEFT JOIN sections sec ON cs.section_id = sec.id AND sec.school_id = ${schoolId}
      WHERE sf.school_id = ${schoolId}
        AND sf.deleted_at IS NULL
        AND s.deleted_at IS NULL
          AND (sf.amount_due - sf.discount - sf.amount_paid) > 0
        ${classId ? sql`AND c.id = ${classId}` : sql``}
        ${sectionId ? sql`AND sec.id = ${sectionId}` : sql``}
        ${search ? sql`AND (p.display_name ILIKE ${'%' + search + '%'} OR s.admission_no ILIKE ${'%' + search + '%'})` : sql``}
      GROUP BY sf.student_id, s.admission_no, p.display_name, c.name, sec.name, c.id, sec.id
    ), segmented AS (
      SELECT
        sa.*,
        CASE
          WHEN sa.days_overdue > 30 THEN 'persistent'
          WHEN sa.overdue_fees_count > 1 THEN 'repeat'
          ELSE 'new'
        END AS segmentation,
        CASE
          WHEN sa.days_overdue <= 0 THEN 'current'
          WHEN sa.days_overdue <= 7 THEN '1-7 days'
          WHEN sa.days_overdue <= 30 THEN '8-30 days'
          WHEN sa.days_overdue <= 60 THEN '31-60 days'
          WHEN sa.days_overdue <= 90 THEN '61-90 days'
          ELSE '90+ days'
        END AS ageing_stage
      FROM student_arrears sa
    ), paged AS MATERIALIZED (
      SELECT seg.*, COUNT(*) OVER()::int AS full_count
    FROM segmented seg
    WHERE 1=1
      ${segmentation ? sql`AND seg.segmentation = ${segmentation}` : sql``}
      ${ageingStage ? sql`AND seg.ageing_stage = ${ageingStage}` : sql``}
      ${minPaidPercent != null ? sql`AND seg.paid_percentage >= ${minPaidPercent}` : sql``}
      ${maxPaidPercent != null ? sql`AND seg.paid_percentage <= ${maxPaidPercent}` : sql``}
    ORDER BY seg.total_outstanding DESC, seg.student_id
    LIMIT ${safeLimit} OFFSET ${offset}
    )
    SELECT
      seg.*,
      -- Fetch parent contact details
      (
        SELECT json_build_object(
          'parent_name', parent_p.display_name,
          'phone', pc.contact_value
        )
        FROM student_parents sp
        JOIN parents pr ON sp.parent_id = pr.id AND pr.school_id = ${schoolId} AND pr.deleted_at IS NULL
        JOIN persons parent_p ON pr.person_id = parent_p.id AND parent_p.school_id = ${schoolId} AND parent_p.deleted_at IS NULL
        LEFT JOIN person_contacts pc ON parent_p.id = pc.person_id AND pc.contact_type = 'phone' AND pc.is_primary = true AND pc.school_id = ${schoolId} AND pc.deleted_at IS NULL
        WHERE sp.student_id = seg.student_id AND sp.school_id = ${schoolId} AND sp.deleted_at IS NULL AND (sp.valid_to IS NULL OR sp.valid_to >= ${today}::date)
        LIMIT 1
      ) AS parent_contact,

      -- Latest payment
      (
        SELECT json_build_object(
          'amount', ft.amount,
          'paid_at', ft.paid_at,
          'receipt_no', r.receipt_no
        )
        FROM fee_transactions ft
        JOIN student_fees sf_prev ON ft.student_fee_id = sf_prev.id AND sf_prev.school_id = ${schoolId}
        LEFT JOIN receipt_items ri ON ft.id = ri.fee_transaction_id AND ri.school_id = ${schoolId}
        LEFT JOIN receipts r ON ri.receipt_id = r.id AND r.school_id = ${schoolId}
        WHERE sf_prev.student_id = seg.student_id
          AND ft.school_id = ${schoolId} AND ft.refund_of IS NULL AND NOT EXISTS (SELECT 1 FROM fee_transactions reversed WHERE reversed.school_id = ${schoolId} AND reversed.refund_of = ft.id GROUP BY reversed.refund_of HAVING -SUM(reversed.amount) >= ft.amount)
        ORDER BY ft.paid_at DESC
        LIMIT 1
      ) AS last_payment,

      -- Latest reminder
      (
        SELECT json_build_object(
          'sent_at', ael.executed_at,
          'stage', ael.stage,
          'channel', ael.channel
        )
        FROM automation_execution_logs ael
        WHERE ael.school_id = ${schoolId}
          AND ael.entity_id = seg.student_id::text AND ael.rule_key = 'fee_due_reminder'
          AND ael.status = 'completed'
        ORDER BY ael.executed_at DESC NULLS LAST
        LIMIT 1
      ) AS last_reminder,

      -- Total reminders sent
      (
        SELECT COUNT(*)::int
        FROM automation_execution_logs ael
        WHERE ael.school_id = ${schoolId}
          AND ael.entity_id = seg.student_id::text AND ael.rule_key = 'fee_due_reminder'
          AND ael.status = 'completed'
      ) AS reminder_count
    FROM paged seg
    ORDER BY seg.total_outstanding DESC, seg.student_id
  `;

  const rows = await baseQuery;
  const totalCount = rows.length > 0 ? rows[0].full_count : safePage > 1
    ? (await getFeeDefaultersList(schoolId, { classId, sectionId, ageingStage, segmentation, search, page: 1, limit: 1 })).pagination.total
    : 0;

  return {
    data: rows.map((r) => {
      assertFiniteRecoveryAmounts(r.total_outstanding);
      const { full_count, ...clean } = r;
      return {
        ...clean,
        total_outstanding: Number(r.total_outstanding || 0),
        reminder_count: Number(r.reminder_count || 0),
      };
    }),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total: totalCount,
      total_pages: Math.ceil(totalCount / safeLimit) || 1,
    },
  };
}

/**
 * Get chronological fee reminder history logs for a school or specific student.
 */
export async function getFeeReminderHistory(schoolId, { studentId = null, page = 1, limit = 50 } = {}) {
  const safePage = Math.min(1000000, Math.max(1, parseInt(String(page), 10) || 1));
  const safeLimit = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 50));
  const offset = (safePage - 1) * safeLimit;

  const rows = await sql`
    SELECT
      ael.id,
      ael.entity_id,
      ael.entity_type,
      ael.stage,
      ael.channel,
      ael.status,
      ael.executed_at,
      ael.scheduled_at,
      ael.error_summary,
      ael.student_id,
      ael.metadata,
      p.display_name AS student_name,
      s.admission_no,
      COALESCE(c.name, 'Unassigned') AS class_name
    FROM automation_execution_logs ael
    LEFT JOIN students s ON ael.student_id = s.id AND s.school_id = ${schoolId}
    LEFT JOIN persons p ON s.person_id = p.id AND p.school_id = ${schoolId}
    LEFT JOIN LATERAL (SELECT e.* FROM student_enrollments e WHERE e.student_id = s.id AND e.school_id = ${schoolId} AND e.status = 'active' AND e.deleted_at IS NULL ORDER BY e.start_date DESC, e.id LIMIT 1) se ON true
    LEFT JOIN class_sections cs ON se.class_section_id = cs.id AND cs.school_id = ${schoolId}
    LEFT JOIN classes c ON cs.class_id = c.id AND c.school_id = ${schoolId}
    WHERE ael.school_id = ${schoolId}
      AND ael.rule_key = 'fee_due_reminder'
      ${studentId ? sql`AND ael.student_id = ${studentId}` : sql``}
    ORDER BY ael.created_at DESC
    LIMIT ${safeLimit} OFFSET ${offset}
  `;

  return rows;
}
