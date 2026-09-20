import express from 'express';
import sql from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { activeStructureFilter, getSchoolFeeMode } from '../services/feeModeService.js';
import analyticsRouter from './analyticsRoutes.js';

const router = express.Router();

/**
 * Helper to get date range based on 'month', 'quarter', or 'year'
 */
function getDateRange(range) {
    const now = new Date();
    let startDate;
    switch (range) {
        case 'quarter':
            startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
            break;
        case 'year':
            startDate = new Date(now.getFullYear(), 0, 1);
            break;
        case 'month':
        default:
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            break;
    }
    return startDate;
}

/**
 * Validated attendance-period enum. AVG ATTENDANCE and WORKING DAYS honour this;
 * AT RISK is always academic-year-to-date regardless (it is an exam-eligibility
 * metric, not a windowed one). Default is the current academic year so every card
 * in the row describes the same window.
 */
const ATTENDANCE_PERIODS = new Set(['academic_year', 'month']);

function normalizeAttendancePeriod(period) {
    return ATTENDANCE_PERIODS.has(period) ? period : 'academic_year';
}

/**
 * resolveAttendancePeriod — returns { from, to, label } for the attendance cards.
 *
 * - 'academic_year' (default): the school's active academic year row
 *   (start_date → today), labelled by its code.
 * - 'month': first-of-current-month → today.
 *
 * Fallback: if the school has no active academic_years row, degrade to the
 * calendar year (Jan 1 → today) so the endpoint never crashes for a school that
 * hasn't configured a year yet.
 *
 * `to` is always CURRENT_DATE — we never count into the future, and the DB has a
 * chk_attendance_date_past constraint anyway.
 */
async function resolveAttendancePeriod(schoolId, period) {
    const today = new Date();
    const normalized = normalizeAttendancePeriod(period);

    if (normalized === 'month') {
        const from = new Date(today.getFullYear(), today.getMonth(), 1);
        return {
            from: toISODate(from),
            to: toISODate(today),
            label: from.toLocaleString('en-US', { month: 'short', year: 'numeric' }),
        };
    }

    // academic_year (default)
    const [ay] = await sql`
        SELECT start_date, end_date, code
        FROM academic_years
        WHERE now() BETWEEN start_date AND end_date
          AND school_id = ${schoolId}
          AND deleted_at IS NULL
        ORDER BY start_date DESC
        LIMIT 1
    `;

    if (ay) {
        return {
            from: toISODate(ay.start_date),
            to: toISODate(today),
            label: ay.code,
        };
    }

    // Fallback: calendar-year-to-date.
    const from = new Date(today.getFullYear(), 0, 1);
    return {
        from: toISODate(from),
        to: toISODate(today),
        label: String(today.getFullYear()),
    };
}

/** Format a Date (or date-like) as an ISO YYYY-MM-DD string. */
function toISODate(value) {
    const d = value instanceof Date ? value : new Date(value);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * Round a raw percentage to one decimal, preserving null.
 * NULL denominator (no attendance marked) stays null — the frontend renders "—",
 * NOT "0%". Never COALESCE this to 0.
 */
function toPct(raw) {
    if (raw === null || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/**
 * fetchFinancials — 100% DB-driven including by_class and top_pending breakdowns
 */
async function fetchFinancials(range, schoolId) {
    const start = getDateRange(range);
    const feeMode = await getSchoolFeeMode(schoolId);
    const structureModeFilter = activeStructureFilter(feeMode);

    const [
        [collected],
        [todayRow],
        [allTimeRow],
        [outstanding],
        [invoiced],
        [discounts],
        [refunds],
        [enrollments],
        trend,
        byClass,
        topPending,
    ] = await Promise.all([
        sql`
        SELECT
          COALESCE((
            SELECT SUM(ft.amount)
            FROM fee_transactions ft
            WHERE ft.paid_at >= ${start}
              AND ft.school_id = ${schoolId}
          ), 0) +
          COALESCE((
            SELECT SUM(tfp.amount)
            FROM transport_fee_payments tfp
            WHERE tfp.paid_at >= ${start}
              AND tfp.school_id = ${schoolId}
          ), 0) AS total
    `,
        sql`
        SELECT
          COALESCE((
            SELECT SUM(ft.amount)
            FROM fee_transactions ft
            WHERE ft.paid_at >= CURRENT_DATE
              AND ft.school_id = ${schoolId}
          ), 0) +
          COALESCE((
            SELECT SUM(tfp.amount)
            FROM transport_fee_payments tfp
            WHERE tfp.paid_at >= CURRENT_DATE
              AND tfp.school_id = ${schoolId}
          ), 0) AS total
    `,
        sql`
        SELECT
          COALESCE((
            SELECT SUM(ft.amount)
            FROM fee_transactions ft
            WHERE ft.school_id = ${schoolId}
          ), 0) +
          COALESCE((
            SELECT SUM(tfp.amount)
            FROM transport_fee_payments tfp
            WHERE tfp.school_id = ${schoolId}
          ), 0) AS total
    `,
        sql`
        SELECT COALESCE(SUM(sf.amount_due - sf.discount - sf.amount_paid), 0) as total
        FROM student_fees sf
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        WHERE sf.status != 'paid'
          AND sf.deleted_at IS NULL
          AND fs.deleted_at IS NULL
          AND sf.school_id = ${schoolId}
          ${structureModeFilter}
    `,
        sql`
        SELECT COALESCE(SUM(sf.amount_due), 0) as total
        FROM student_fees sf
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        WHERE sf.deleted_at IS NULL
          AND fs.deleted_at IS NULL
          AND sf.school_id = ${schoolId}
          ${structureModeFilter}
    `,
        sql`
        SELECT COALESCE(SUM(sf.discount), 0) as total
        FROM student_fees sf
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        WHERE sf.deleted_at IS NULL
          AND fs.deleted_at IS NULL
          AND sf.school_id = ${schoolId}
          ${structureModeFilter}
    `,
        sql`
        SELECT COALESCE(SUM(ABS(ft.amount)), 0) as total
        FROM fee_transactions ft
        WHERE ft.refund_of IS NOT NULL
          AND ft.paid_at >= ${start}
          AND ft.school_id = ${schoolId}
    `,
        sql`
        SELECT COUNT(*) as count
        FROM students
        WHERE created_at >= ${start}
          AND deleted_at IS NULL
          AND status_id = 1
          AND school_id = ${schoolId}
    `,
        sql`
        SELECT
            TO_CHAR(ft.paid_at, 'Mon') as label,
            SUM(ft.amount) as value
        FROM fee_transactions ft
        JOIN student_fees sf ON ft.student_fee_id = sf.id
        WHERE ft.paid_at > CURRENT_DATE - INTERVAL '6 months'
          AND sf.school_id = ${schoolId}
        GROUP BY TO_CHAR(ft.paid_at, 'Mon'), DATE_TRUNC('month', ft.paid_at)
        ORDER BY DATE_TRUNC('month', ft.paid_at)
    `,
        sql`
        SELECT 
            c.name as class_name,
            sec.name as section_name,
            COALESCE(SUM(sf.amount_due), 0)::numeric as total_invoiced,
            COALESCE(SUM(sf.amount_paid), 0)::numeric as collected,
            COALESCE(SUM(sf.amount_due - sf.discount - sf.amount_paid), 0)::numeric as outstanding,
            CASE 
                WHEN SUM(sf.amount_due - sf.discount) > 0 
                THEN ROUND((SUM(sf.amount_paid)::numeric / SUM(sf.amount_due - sf.discount)::numeric) * 100, 1)::float
                ELSE 0 
            END as efficiency
        FROM student_fees sf
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        JOIN students s ON sf.student_id = s.id
        JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active'
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections sec ON cs.section_id = sec.id
        WHERE sf.deleted_at IS NULL
          AND fs.deleted_at IS NULL
          AND s.deleted_at IS NULL
          AND sf.school_id = ${schoolId}
          ${structureModeFilter}
        GROUP BY c.id, c.name, sec.id, sec.name
        ORDER BY c.name, sec.name
    `,
        sql`
        SELECT 
            p.display_name as student_name,
            c.name || ' ' || sec.name as class_section,
            SUM(sf.amount_due - sf.discount - sf.amount_paid)::numeric as amount_due,
            GREATEST(0, (CURRENT_DATE - MIN(COALESCE(sf.due_date, sf.created_at::date))))::int as overdue_days
        FROM student_fees sf
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        JOIN students s ON sf.student_id = s.id
        JOIN persons p ON s.person_id = p.id
        JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active'
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections sec ON cs.section_id = sec.id
        WHERE sf.status != 'paid'
          AND sf.deleted_at IS NULL
          AND fs.deleted_at IS NULL
          AND s.deleted_at IS NULL
          AND sf.school_id = ${schoolId}
          ${structureModeFilter}
        GROUP BY s.id, p.display_name, c.name, sec.name
        HAVING SUM(sf.amount_due - sf.discount - sf.amount_paid) > 0
        ORDER BY amount_due DESC
        LIMIT 25
    `,
    ]);

    const totalCollected = parseFloat(collected.total) || 0;
    const todayCollection = parseFloat(todayRow.total) || 0;
    const allTimeCollected = parseFloat(allTimeRow.total) || 0;
    const totalInvoiced = parseFloat(invoiced.total) || 0;
    const totalDiscount = parseFloat(discounts.total) || 0;
    const outstandingDues = parseFloat(outstanding.total) || 0;

    const netBilled = totalInvoiced - totalDiscount;
    const lifetimeCollected = Math.max(netBilled - outstandingDues, 0);
    const efficiency = netBilled > 0 ? Math.round((lifetimeCollected / netBilled) * 100) : 0;

    return {
        total_collected: totalCollected,
        today_collection: todayCollection,
        lifetime_collected: allTimeCollected,
        outstanding_dues: outstandingDues,
        collection_efficiency: efficiency,
        total_invoiced: totalInvoiced,
        discount_given: totalDiscount,
        refunds_issued: parseFloat(refunds.total) || 0,
        new_enrollments: parseInt(enrollments.count) || 0,
        trend: trend.map(t => ({ label: t.label, value: parseFloat(t.value) || 0 })),
        by_class: byClass.map(r => ({
            class_name: r.class_name,
            section_name: r.section_name,
            total_invoiced: parseFloat(r.total_invoiced) || 0,
            collected: parseFloat(r.collected) || 0,
            outstanding: parseFloat(r.outstanding) || 0,
            efficiency: parseFloat(r.efficiency) || 0
        })),
        top_pending: topPending.map(r => ({
            student_name: r.student_name,
            class_section: r.class_section,
            amount_due: parseFloat(r.amount_due) || 0,
            overdue_days: parseInt(r.overdue_days, 10) || 0
        }))
    };
}

/**
 * fetchAttendance — 100% DB-driven, null-safe including by_class and low_attendance_students.
 */
async function fetchAttendance(period, schoolId) {
    const { from, to, label } = await resolveAttendancePeriod(schoolId, period);
    const atRiskWindow = await resolveAttendancePeriod(schoolId, 'academic_year');

    const [
        [avgAtt],
        [chronic],
        [workingDays],
        [staffAtt],
        trend,
        [presentDays],
        byClass,
        lowAttendance,
    ] = await Promise.all([
        // ① AVG ATTENDANCE — % over the period, null when nothing marked.
        sql`
        SELECT ROUND(
            100.0 * COUNT(*) FILTER (WHERE da.status IN ('present', 'late', 'half_day'))
            / NULLIF(COUNT(*), 0), 1
        ) AS pct
        FROM daily_attendance da
        JOIN student_enrollments se ON se.id = da.student_enrollment_id
        JOIN students s ON s.id = se.student_id
        WHERE s.school_id = ${schoolId}
          AND da.deleted_at IS NULL
          AND da.attendance_date BETWEEN ${from} AND ${to}
    `,
        // ② AT RISK (<75%) — active students, academic-YTD cumulative. 0 is real.
        sql`
        WITH per_student AS (
            SELECT se.student_id,
                   COUNT(*) FILTER (WHERE da.status IN ('present', 'late', 'half_day')) AS present_days,
                   COUNT(*) AS total_days
            FROM daily_attendance da
            JOIN student_enrollments se ON se.id = da.student_enrollment_id
            JOIN students s ON s.id = se.student_id
            WHERE s.school_id = ${schoolId}
              AND s.status_id = 1
              AND s.deleted_at IS NULL
              AND da.deleted_at IS NULL
              AND da.attendance_date BETWEEN ${atRiskWindow.from} AND ${atRiskWindow.to}
            GROUP BY se.student_id
        )
        SELECT COUNT(*)::int AS count
        FROM per_student
        WHERE total_days > 0
          AND (present_days::numeric / total_days) < 0.75
    `,
        // ③ WORKING DAYS — NULL when no attendance taken (no data).
        sql`
        SELECT NULLIF(COUNT(DISTINCT da.attendance_date), 0) AS count
        FROM daily_attendance da
        JOIN student_enrollments se ON se.id = da.student_enrollment_id
        JOIN students s ON s.id = se.student_id
        WHERE s.school_id = ${schoolId}
          AND da.deleted_at IS NULL
          AND da.attendance_date BETWEEN ${from} AND ${to}
    `,
        // ④ STAFF ATT. — % over the period, null when nothing tracked.
        sql`
        SELECT ROUND(
            100.0 * COUNT(*) FILTER (WHERE sa.status IN ('present', 'late', 'half_day'))
            / NULLIF(COUNT(*), 0), 1
        ) AS pct
        FROM staff_attendance sa
        JOIN staff st ON st.id = sa.staff_id
        WHERE sa.school_id = ${schoolId}
          AND sa.deleted_at IS NULL
          AND st.deleted_at IS NULL
          AND st.status_id = 1
          AND sa.attendance_date BETWEEN ${from} AND ${to}
    `,
        // ⑤ Trend — last 14 days of student attendance %
        sql`
        SELECT
            TO_CHAR(da.attendance_date, 'DD Mon') as label,
            ROUND(
                100.0 * COUNT(*) FILTER (WHERE da.status IN ('present', 'late', 'half_day'))
                / NULLIF(COUNT(*), 0), 1
            ) as value
        FROM daily_attendance da
        JOIN student_enrollments se ON se.id = da.student_enrollment_id
        JOIN students s ON s.id = se.student_id
        WHERE s.school_id = ${schoolId}
          AND da.deleted_at IS NULL
          AND da.attendance_date > CURRENT_DATE - INTERVAL '14 days'
        GROUP BY da.attendance_date
        ORDER BY da.attendance_date
    `,
        // ⑥ Aggregate present student-days over the period
        sql`
        SELECT COUNT(*)::int AS count
        FROM daily_attendance da
        JOIN student_enrollments se ON se.id = da.student_enrollment_id
        JOIN students s ON s.id = se.student_id
        WHERE s.school_id = ${schoolId}
          AND da.deleted_at IS NULL
          AND da.status IN ('present', 'late', 'half_day')
          AND da.attendance_date BETWEEN ${from} AND ${to}
    `,
        // ⑦ Class attendance breakdown
        sql`
        WITH class_att AS (
            SELECT 
                cs.id as class_section_id,
                c.name as class_name,
                sec.name as section_name,
                COUNT(DISTINCT s.id) as total_students,
                COUNT(*) FILTER (WHERE da.status IN ('present', 'late', 'half_day')) as present_count,
                COUNT(*) as total_marks
            FROM daily_attendance da
            JOIN student_enrollments se ON se.id = da.student_enrollment_id
            JOIN students s ON s.id = se.student_id
            JOIN class_sections cs ON se.class_section_id = cs.id
            JOIN classes c ON cs.class_id = c.id
            JOIN sections sec ON cs.section_id = sec.id
            WHERE s.school_id = ${schoolId}
              AND s.status_id = 1
              AND s.deleted_at IS NULL
              AND da.deleted_at IS NULL
              AND da.attendance_date BETWEEN ${from} AND ${to}
            GROUP BY cs.id, c.name, sec.name
        ),
        class_risk AS (
            SELECT 
                se.class_section_id,
                COUNT(DISTINCT se.student_id) as below_threshold
            FROM (
                SELECT 
                    se.class_section_id,
                    se.student_id,
                    COUNT(*) FILTER (WHERE da.status IN ('present', 'late', 'half_day')) as present_days,
                    COUNT(*) as total_days
                FROM daily_attendance da
                JOIN student_enrollments se ON se.id = da.student_enrollment_id
                JOIN students s ON s.id = se.student_id
                WHERE s.school_id = ${schoolId}
                  AND s.status_id = 1
                  AND s.deleted_at IS NULL
                  AND da.deleted_at IS NULL
                  AND da.attendance_date BETWEEN ${atRiskWindow.from} AND ${atRiskWindow.to}
                GROUP BY se.class_section_id, se.student_id
                HAVING COUNT(*) > 0 AND (COUNT(*) FILTER (WHERE da.status IN ('present', 'late', 'half_day'))::float / COUNT(*)) < 0.75
            ) se
            GROUP BY se.class_section_id
        )
        SELECT 
            ca.class_name,
            ca.section_name,
            ROUND((ca.present_count::numeric / NULLIF(ca.total_marks, 0)::numeric) * 100, 1)::float as avg_pct,
            ca.total_students::int,
            COALESCE(cr.below_threshold, 0)::int as below_threshold
        FROM class_att ca
        LEFT JOIN class_risk cr ON ca.class_section_id = cr.class_section_id
        ORDER BY ca.class_name, ca.section_name
    `,
        // ⑧ Low attendance students (under 75% YTD)
        sql`
        SELECT 
            p.display_name as student_name,
            c.name || ' ' || sec.name as class_section,
            ROUND((COUNT(*) FILTER (WHERE da.status IN ('present', 'late', 'half_day'))::numeric / NULLIF(COUNT(*), 0)::numeric) * 100, 1)::float as attendance_pct,
            COUNT(*) FILTER (WHERE da.status = 'absent')::int as absent_days
        FROM daily_attendance da
        JOIN student_enrollments se ON se.id = da.student_enrollment_id
        JOIN students s ON s.id = se.student_id
        JOIN persons p ON s.person_id = p.id
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections sec ON cs.section_id = sec.id
        WHERE s.school_id = ${schoolId}
          AND s.status_id = 1
          AND s.deleted_at IS NULL
          AND da.deleted_at IS NULL
          AND da.attendance_date BETWEEN ${atRiskWindow.from} AND ${atRiskWindow.to}
        GROUP BY s.id, p.display_name, c.name, sec.name
        HAVING COUNT(*) > 0 
           AND (COUNT(*) FILTER (WHERE da.status IN ('present', 'late', 'half_day'))::numeric / COUNT(*)::numeric) < 0.75
        ORDER BY attendance_pct ASC
        LIMIT 25
    `,
    ]);

    const workingDaysCount = workingDays.count === null || workingDays.count === undefined
        ? null
        : parseInt(workingDays.count, 10);

    return {
        period: { from, to, label },
        avg_attendance: toPct(avgAtt.pct),
        chronic_absentees: parseInt(chronic.count, 10) || 0,
        total_present_days: parseInt(presentDays.count, 10) || 0,
        total_working_days: workingDaysCount,
        staff_attendance: toPct(staffAtt.pct),
        trend: trend.map(t => ({ label: t.label, value: toPct(t.value) ?? 0 })),
        by_class: byClass.map(r => ({
            class_name: r.class_name,
            section_name: r.section_name,
            avg_pct: toPct(r.avg_pct) ?? 0,
            total_students: parseInt(r.total_students, 10) || 0,
            below_threshold: parseInt(r.below_threshold, 10) || 0,
        })),
        low_attendance_students: lowAttendance.map(r => ({
            student_name: r.student_name,
            class_section: r.class_section,
            attendance_pct: toPct(r.attendance_pct) ?? 0,
            absent_days: parseInt(r.absent_days, 10) || 0,
        }))
    };
}

/**
 * fetchAcademics — 100% DB-driven including by_subject breakdown
 */
async function fetchAcademics(range, schoolId) {
    const start = getDateRange(range);

    const [
        [avgScore],
        [passRate],
        topSubjects,
        weakSubjects,
        [examsCount],
        trend,
        bySubject,
    ] = await Promise.all([
        sql`
        SELECT COALESCE(AVG(m.marks_obtained::FLOAT / NULLIF(es.max_marks, 0) * 100), 0)::FLOAT as avg
        FROM marks m
        JOIN exam_subjects es ON m.exam_subject_id = es.id
        JOIN student_enrollments se ON m.student_enrollment_id = se.id
        JOIN students s ON se.student_id = s.id
        WHERE s.school_id = ${schoolId}
          AND m.created_at >= ${start}
    `,
        sql`
        WITH student_pass AS (
            SELECT se.student_id,
                   CASE WHEN AVG(m.marks_obtained::FLOAT / NULLIF(es.max_marks, 0) * 100) >= 35 THEN 1 ELSE 0 END as passed
            FROM marks m
            JOIN exam_subjects es ON m.exam_subject_id = es.id
            JOIN student_enrollments se ON m.student_enrollment_id = se.id
            JOIN students s ON se.student_id = s.id
            WHERE s.school_id = ${schoolId}
              AND m.created_at >= ${start}
            GROUP BY se.student_id
        )
        SELECT
            CASE WHEN COUNT(*) > 0 THEN (SUM(passed)::FLOAT / COUNT(*) * 100) ELSE 0 END as rate
        FROM student_pass
    `,
        sql`
        SELECT sub.name, AVG(m.marks_obtained::FLOAT / NULLIF(es.max_marks, 0) * 100) as avg_pct
        FROM marks m
        JOIN exam_subjects es ON m.exam_subject_id = es.id
        JOIN subjects sub ON es.subject_id = sub.id
        JOIN student_enrollments se ON m.student_enrollment_id = se.id
        JOIN students s ON se.student_id = s.id
        WHERE s.school_id = ${schoolId}
          AND m.created_at >= ${start}
        GROUP BY sub.name
        ORDER BY avg_pct DESC
        LIMIT 1
    `,
        sql`
        SELECT sub.name, AVG(m.marks_obtained::FLOAT / NULLIF(es.max_marks, 0) * 100) as avg_pct
        FROM marks m
        JOIN exam_subjects es ON m.exam_subject_id = es.id
        JOIN subjects sub ON es.subject_id = sub.id
        JOIN student_enrollments se ON m.student_enrollment_id = se.id
        JOIN students s ON se.student_id = s.id
        WHERE s.school_id = ${schoolId}
          AND m.created_at >= ${start}
        GROUP BY sub.name
        ORDER BY avg_pct ASC
        LIMIT 1
    `,
        sql`
        SELECT COUNT(DISTINCT e.id) as count
        FROM exams e
        JOIN exam_subjects es ON e.id = es.exam_id
        JOIN marks m ON es.id = m.exam_subject_id
        JOIN student_enrollments se ON m.student_enrollment_id = se.id
        JOIN students s ON se.student_id = s.id
        WHERE s.school_id = ${schoolId}
          AND m.created_at >= ${start}
    `,
        sql`
        SELECT
            e.name as label,
            AVG(m.marks_obtained::FLOAT / NULLIF(es.max_marks, 0) * 100) as value
        FROM marks m
        JOIN exam_subjects es ON m.exam_subject_id = es.id
        JOIN exams e ON es.exam_id = e.id
        JOIN student_enrollments se ON m.student_enrollment_id = se.id
        JOIN students s ON se.student_id = s.id
        WHERE s.school_id = ${schoolId}
          AND m.created_at >= ${start}
        GROUP BY e.id, e.name, e.start_date
        ORDER BY e.start_date
    `,
        sql`
        SELECT 
            sub.name as subject_name,
            ROUND(AVG(m.marks_obtained::FLOAT / NULLIF(es.max_marks, 0) * 100)::numeric, 1)::float as avg_score,
            ROUND((COUNT(*) FILTER (WHERE (m.marks_obtained::FLOAT / NULLIF(es.max_marks, 0) * 100) >= 35)::numeric / NULLIF(COUNT(*), 0)::numeric * 100), 1)::float as pass_rate,
            ROUND(MAX(m.marks_obtained::FLOAT / NULLIF(es.max_marks, 0) * 100)::numeric, 1)::float as highest,
            ROUND(MIN(m.marks_obtained::FLOAT / NULLIF(es.max_marks, 0) * 100)::numeric, 1)::float as lowest
        FROM marks m
        JOIN exam_subjects es ON m.exam_subject_id = es.id
        JOIN subjects sub ON es.subject_id = sub.id
        JOIN student_enrollments se ON m.student_enrollment_id = se.id
        JOIN students s ON se.student_id = s.id
        WHERE s.school_id = ${schoolId}
          AND m.created_at >= ${start}
        GROUP BY sub.id, sub.name
        ORDER BY avg_score DESC
    `,
    ]);

    return {
        avg_score: Math.round(parseFloat(avgScore.avg) || 0),
        pass_rate: Math.round(parseFloat(passRate.rate) || 0),
        top_subject: topSubjects.length > 0 ? topSubjects[0].name : '—',
        weakest_subject: weakSubjects.length > 0 ? weakSubjects[0].name : '—',
        exams_conducted: parseInt(examsCount.count) || 0,
        trend: trend.map(t => ({ label: t.label, value: Math.round(parseFloat(t.value) || 0) })),
        by_subject: bySubject.map(s => ({
            subject_name: s.subject_name,
            avg_score: parseFloat(s.avg_score) || 0,
            pass_rate: parseFloat(s.pass_rate) || 0,
            highest: parseFloat(s.highest) || 0,
            lowest: parseFloat(s.lowest) || 0,
        }))
    };
}

/**
 * fetchStaff — 100% DB-driven including by_department breakdown
 */
async function fetchStaff(schoolId) {
    const start = getDateRange('month');

    const [
        [total],
        [active],
        [onLeave],
        [staffAttPct],
        [newJoins],
        [resigned],
        byDept,
    ] = await Promise.all([
        sql`
        SELECT COUNT(*)::int as count FROM staff WHERE deleted_at IS NULL AND school_id = ${schoolId}
    `,
        sql`
        SELECT COUNT(*)::int as count FROM staff WHERE status_id = 1 AND deleted_at IS NULL AND school_id = ${schoolId}
    `,
        sql`
        SELECT COUNT(DISTINCT st.id) as count
        FROM leave_applications la
        JOIN users u ON la.applicant_id = u.id
        JOIN staff st ON st.person_id = u.person_id
        WHERE la.status = 'approved'
          AND CURRENT_DATE BETWEEN la.start_date AND la.end_date
          AND st.school_id = ${schoolId}
          AND st.deleted_at IS NULL
    `,
        sql`
        SELECT
            (COUNT(*) FILTER (WHERE sa.status IN ('present', 'late', 'half_day')))::FLOAT
            / NULLIF(COUNT(*), 0) * 100 as pct
        FROM staff_attendance sa
        JOIN staff st ON sa.staff_id = st.id
        WHERE sa.attendance_date >= ${start}
          AND st.school_id = ${schoolId}
          AND st.deleted_at IS NULL
    `,
        sql`
        SELECT COUNT(*) as count
        FROM staff
        WHERE created_at >= ${start}
          AND deleted_at IS NULL
          AND school_id = ${schoolId}
    `,
        sql`
        SELECT COUNT(*) as count
        FROM staff
        WHERE deleted_at IS NOT NULL
          AND deleted_at >= ${start}
          AND school_id = ${schoolId}
    `,
        sql`
        SELECT 
            COALESCE(sd.name, 'General') as department,
            COUNT(st.id)::int as count,
            COUNT(st.id) FILTER (
                WHERE EXISTS (
                    SELECT 1 FROM staff_attendance sa 
                    WHERE sa.staff_id = st.id 
                      AND sa.attendance_date = CURRENT_DATE 
                      AND sa.status IN ('present', 'late', 'half_day')
                      AND sa.deleted_at IS NULL
                )
            )::int as present
        FROM staff st
        LEFT JOIN staff_designations sd ON st.designation_id = sd.id
        WHERE st.school_id = ${schoolId} AND st.deleted_at IS NULL AND st.status_id = 1
        GROUP BY sd.id, sd.name
        ORDER BY count DESC
    `,
    ]);

    return {
        total_staff: parseInt(total.count) || 0,
        active_staff: parseInt(active.count) || 0,
        on_leave_today: parseInt(onLeave.count) || 0,
        avg_staff_attendance: Math.round(parseFloat(staffAttPct.pct) || 0),
        new_joinings: parseInt(newJoins.count) || 0,
        resignations: parseInt(resigned.count) || 0,
        by_department: byDept.map(d => {
            const count = parseInt(d.count, 10) || 0;
            const present = parseInt(d.present, 10) || 0;
            return {
                department: d.department,
                count,
                present,
                attendance_pct: count > 0 ? Math.round((present / count) * 100) : 0,
            };
        })
    };
}

/**
 * generateInsights — dynamically generate alerts based on real DB data with actionable routes.
 */
function generateInsights(financials, attendance, academics, staff) {
    const insights = [];
    let id = 1;

    // Finance alerts
    if (financials.outstanding_dues > 50000) {
        insights.push({
            id: String(id++),
            severity: 'high',
            category: 'finance',
            message: `Outstanding dues at ₹${(financials.outstanding_dues / 1000).toFixed(1)}K — needs immediate attention.`,
            action_route: '/admin/finance',
            created_at: new Date().toISOString()
        });
    }
    if (financials.collection_efficiency < 70) {
        insights.push({
            id: String(id++),
            severity: 'high',
            category: 'finance',
            message: `Collection efficiency is only ${financials.collection_efficiency}% — significantly below target.`,
            action_route: '/admin/finance',
            created_at: new Date().toISOString()
        });
    } else if (financials.collection_efficiency < 85) {
        insights.push({
            id: String(id++),
            severity: 'medium',
            category: 'finance',
            message: `Collection efficiency at ${financials.collection_efficiency}% — room for improvement.`,
            action_route: '/admin/finance',
            created_at: new Date().toISOString()
        });
    }

    // Attendance alerts
    if (attendance.avg_attendance !== null) {
        if (attendance.avg_attendance < 75) {
            insights.push({
                id: String(id++),
                severity: 'high',
                category: 'attendance',
                message: `Average attendance critically low at ${attendance.avg_attendance}%.`,
                action_route: '/admin/attendance-risk',
                created_at: new Date().toISOString()
            });
        } else if (attendance.avg_attendance < 85) {
            insights.push({
                id: String(id++),
                severity: 'medium',
                category: 'attendance',
                message: `Average attendance at ${attendance.avg_attendance}% — below target of 85%.`,
                action_route: '/admin/attendance-risk',
                created_at: new Date().toISOString()
            });
        }
    }
    if (attendance.chronic_absentees > 10) {
        insights.push({
            id: String(id++),
            severity: 'high',
            category: 'attendance',
            message: `${attendance.chronic_absentees} students with attendance below 75% — immediate intervention needed.`,
            action_route: '/admin/attendance-risk',
            created_at: new Date().toISOString()
        });
    } else if (attendance.chronic_absentees > 0) {
        insights.push({
            id: String(id++),
            severity: 'medium',
            category: 'attendance',
            message: `${attendance.chronic_absentees} student(s) at risk with attendance below 75%.`,
            action_route: '/admin/attendance-risk',
            created_at: new Date().toISOString()
        });
    }

    // Academic alerts
    if (academics.pass_rate < 70) {
        insights.push({
            id: String(id++),
            severity: 'high',
            category: 'academic',
            message: `Pass rate is only ${academics.pass_rate}% — academic support programs recommended.`,
            action_route: '/admin/exam-analytics',
            created_at: new Date().toISOString()
        });
    } else if (academics.pass_rate < 85) {
        insights.push({
            id: String(id++),
            severity: 'medium',
            category: 'academic',
            message: `Pass rate at ${academics.pass_rate}% — consider additional tutoring sessions.`,
            action_route: '/admin/exam-analytics',
            created_at: new Date().toISOString()
        });
    }

    // Staff alerts
    if (staff.on_leave_today > 5) {
        insights.push({
            id: String(id++),
            severity: 'medium',
            category: 'staff',
            message: `${staff.on_leave_today} staff members on leave today — may affect class schedules.`,
            action_route: '/admin/manage-staff',
            created_at: new Date().toISOString()
        });
    }
    if (staff.avg_staff_attendance > 0 && staff.avg_staff_attendance < 85) {
        insights.push({
            id: String(id++),
            severity: 'medium',
            category: 'staff',
            message: `Staff attendance at ${staff.avg_staff_attendance}% this month — below expected standard.`,
            action_route: '/admin/manage-staff',
            created_at: new Date().toISOString()
        });
    }

    return insights.slice(0, 10);
}

const ANALYTICS_CACHE_TTL_MS = 30_000;
const _analyticsCache = new Map();
const _analyticsInFlight = new Map();

async function getOrFetchAnalytics(range, period, schoolId, force = false) {
    const key = `${schoolId}:${range}:${period}`;
    const cached = _analyticsCache.get(key);
    if (!force && cached && Date.now() < cached.expiresAt) return cached.data;

    // A dashboard load can fan out into 30+ aggregate queries. Multiple mounts,
    // refreshes, or callers asking for / and /insights at the same time used to
    // launch a duplicate fan-out for every request and exhaust the 10-connection
    // pool. Share the active load for this school/range, including forced loads;
    // force bypasses only completed cached data, not an identical query already
    // running against the database.
    const active = _analyticsInFlight.get(key);
    if (active) return active;

    const load = (async () => {
        const [financials, attendance, academics, staff] = await Promise.all([
            fetchFinancials(range, schoolId),
            fetchAttendance(period, schoolId),
            fetchAcademics(range, schoolId),
            fetchStaff(schoolId),
        ]);
        const data = { financials, attendance, academics, staff };
        _analyticsCache.set(key, {
            data,
            expiresAt: Date.now() + ANALYTICS_CACHE_TTL_MS,
        });
        return data;
    })();

    _analyticsInFlight.set(key, load);
    try {
        return await load;
    } finally {
        if (_analyticsInFlight.get(key) === load) {
            _analyticsInFlight.delete(key);
        }
    }
}

/**
 * GET /admin/analytics — Full dashboard snapshot, 100% DB-driven.
 */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
    const { range = 'month' } = req.query;
    const period = normalizeAttendancePeriod(req.query.period);
    const force = req.query.force === 'true';
    const schoolId = req.schoolId;

    const { financials, attendance, academics, staff } = await getOrFetchAnalytics(range, period, schoolId, force);
    const insights = generateInsights(financials, attendance, academics, staff);

    return sendSuccess(res, req.schoolId, {
        range,
        period,
        generated_at: new Date().toISOString(),
        financials,
        attendance,
        academics,
        staff,
        insights
    });
}));

router.get('/financials', requireAuth, asyncHandler(async (req, res) => {
    const data = await fetchFinancials(req.query.range || 'month', req.schoolId);
    return sendSuccess(res, req.schoolId, data);
}));

router.get('/attendance', requireAuth, asyncHandler(async (req, res) => {
    const period = normalizeAttendancePeriod(req.query.period);
    const data = await fetchAttendance(period, req.schoolId);
    return sendSuccess(res, req.schoolId, data);
}));

router.get('/academics', requireAuth, asyncHandler(async (req, res) => {
    const data = await fetchAcademics(req.query.range || 'month', req.schoolId);
    return sendSuccess(res, req.schoolId, data);
}));

router.get('/staff', requireAuth, asyncHandler(async (req, res) => {
    const data = await fetchStaff(req.schoolId);
    return sendSuccess(res, req.schoolId, data);
}));

router.get('/insights', requireAuth, asyncHandler(async (req, res) => {
    const range = req.query.range || 'month';
    const period = normalizeAttendancePeriod(req.query.period);
    const force = req.query.force === 'true';
    const schoolId = req.schoolId;
    const { financials, attendance, academics, staff } = await getOrFetchAnalytics(range, period, schoolId, force);
    const insights = generateInsights(financials, attendance, academics, staff);
    return sendSuccess(res, req.schoolId, insights);
}));

router.patch('/insights/:id/dismiss', requireAuth, asyncHandler(async (req, res) => {
    return sendSuccess(res, req.schoolId, { success: true });
}));

router.post('/export', requireAuth, asyncHandler(async (req, res) => {
    return sendSuccess(res, req.schoolId, { download_url: 'https://example.com/report.pdf' });
}));

/**
 * GET /admin/analytics/student-progress-tracker/:query
 * Live DB student lookup with attendance, complaints, and subject performance comparison.
 */
router.get('/student-progress-tracker/:query', requireAuth, asyncHandler(async (req, res) => {
    const rawQuery = decodeURIComponent(req.params.query || '').trim();
    const schoolId = req.schoolId;

    if (!rawQuery) {
        return res.status(400).json({ error: 'Search query is required' });
    }

    const [student] = await sql`
        SELECT s.id, s.admission_no, p.display_name as name,
               c.name || ' ' || sec.name as class,
               COALESCE(se.roll_number::text, '—') as roll_no,
               COALESCE(
                 (SELECT contact_value FROM person_contacts WHERE person_id = p.id AND contact_type = 'phone' LIMIT 1),
                 '—'
               ) as contact,
               COALESCE(
                 (SELECT pp.display_name FROM student_parents sp JOIN parents par ON sp.parent_id = par.id JOIN persons pp ON par.person_id = pp.id WHERE sp.student_id = s.id LIMIT 1),
                 '—'
               ) as guardian,
               se.id as enrollment_id
        FROM students s
        JOIN persons p ON s.person_id = p.id
        JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active'
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections sec ON cs.section_id = sec.id
        WHERE s.school_id = ${schoolId}
          AND s.deleted_at IS NULL
          AND (s.id::text = ${rawQuery} OR s.admission_no ILIKE ${rawQuery} OR s.admission_no ILIKE ${rawQuery + '%'} OR p.display_name ILIKE ${'%' + rawQuery + '%'})
        ORDER BY CASE WHEN s.admission_no ILIKE ${rawQuery} THEN 0 WHEN p.display_name ILIKE ${rawQuery} THEN 1 ELSE 2 END
        LIMIT 1
    `;

    if (!student) {
        return res.status(404).json({ error: `Student '${rawQuery}' not found` });
    }

    const [[att], [comp], marks] = await Promise.all([
        sql`
            SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE da.status IN ('present', 'late', 'half_day')) / NULLIF(COUNT(*), 0), 1)::float as pct
            FROM daily_attendance da
            WHERE da.student_enrollment_id = ${student.enrollment_id}
              AND da.deleted_at IS NULL
        `,
        sql`
            SELECT 
                COUNT(*)::int as total,
                COUNT(*) FILTER (WHERE status = 'resolved')::int as resolved,
                COUNT(*) FILTER (WHERE status IN ('open', 'in_progress'))::int as pending,
                COUNT(*) FILTER (WHERE priority = 'urgent')::int as critical
            FROM complaints
            WHERE raised_for_student_id = ${student.id}
              AND deleted_at IS NULL
        `,
        sql`
            WITH recent_exams AS (
                SELECT DISTINCT e.id, e.name, e.start_date
                FROM marks m
                JOIN exam_subjects es ON m.exam_subject_id = es.id
                JOIN exams e ON es.exam_id = e.id
                WHERE m.student_enrollment_id = ${student.enrollment_id}
                ORDER BY e.start_date DESC NULLS LAST
                LIMIT 2
            ),
            exam_ranks AS (
                SELECT id, ROW_NUMBER() OVER (ORDER BY start_date DESC NULLS LAST) as rn
                FROM recent_exams
            )
            SELECT 
                sub.name as subject,
                COALESCE(MAX(m.marks_obtained) FILTER (WHERE er.rn = 2), MAX(m.marks_obtained) FILTER (WHERE er.rn = 1), 0)::float as prev_marks,
                COALESCE(MAX(m.marks_obtained) FILTER (WHERE er.rn = 1), 0)::float as curr_marks,
                COALESCE(MAX(es.max_marks), 100)::float as max_marks
            FROM marks m
            JOIN exam_subjects es ON m.exam_subject_id = es.id
            JOIN subjects sub ON es.subject_id = sub.id
            JOIN exam_ranks er ON es.exam_id = er.id
            WHERE m.student_enrollment_id = ${student.enrollment_id}
            GROUP BY sub.id, sub.name
            ORDER BY sub.name
        `
    ]);

    const performance = marks.map(m => ({
        subject: m.subject,
        prevMarks: parseFloat(m.prev_marks) || 0,
        currMarks: parseFloat(m.curr_marks) || 0,
        maxMarks: parseFloat(m.max_marks) || 100
    }));

    let status = 'stable';
    if (performance.length > 0) {
        const deltas = performance.map(p => ((p.currMarks - p.prevMarks) / (p.maxMarks || 100)) * 100);
        const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
        if (avgDelta > 2) status = 'improving';
        else if (avgDelta < -2) status = 'declining';
    }

    const payload = {
        id: student.admission_no || String(student.id),
        name: student.name,
        class: student.class,
        rollNo: student.roll_no,
        guardian: student.guardian,
        contact: student.contact,
        attendance: att?.pct != null ? parseFloat(att.pct) : 100,
        complaints: {
            total: parseInt(comp.total, 10) || 0,
            resolved: parseInt(comp.resolved, 10) || 0,
            pending: parseInt(comp.pending, 10) || 0,
            critical: parseInt(comp.critical, 10) || 0
        },
        performance,
        status
    };

    return sendSuccess(res, req.schoolId, payload);
}));

// Route fallback for /risk, /heatmap, /talking-points/:id, /net-balance
router.use('/', analyticsRouter);

export default router;
