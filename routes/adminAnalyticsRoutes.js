import express from 'express';
import sql from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { activeStructureFilter, getSchoolFeeMode } from '../services/feeModeService.js';

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
 * fetchFinancials — 100% DB-driven
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
    ]);

    const totalCollected = parseFloat(collected.total) || 0;
    const todayCollection = parseFloat(todayRow.total) || 0;      // collected today (across all time)
    const allTimeCollected = parseFloat(allTimeRow.total) || 0;   // lifetime collected (all transactions)
    const totalInvoiced = parseFloat(invoiced.total) || 0;
    const totalDiscount = parseFloat(discounts.total) || 0;
    const outstandingDues = parseFloat(outstanding.total) || 0;

    // Invoiced / discounts / outstanding all describe the full active fee book
    // (not just fees created in the selected range), so efficiency must be
    // computed from the same population. Net billed = amount owed after
    // discounts; lifetime collected = net billed minus what is still
    // outstanding (i.e. the sum of amount_paid across all fees).
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
        by_class: [],
        top_pending: []
    };
}

/**
 * fetchAttendance — 100% DB-driven, null-safe.
 *
 * Four independent aggregations, one round trip:
 *   - avg_attendance  : % over the selected period. number | null (null = no data).
 *   - chronic_absentees (AT RISK <75%): count of ACTIVE students whose
 *     academic-year-to-date cumulative % < 75. Always YTD, never the period.
 *   - total_working_days: COUNT(DISTINCT date) attendance was taken in the
 *     period (Fork A — no calendar table exists). integer | null.
 *   - staff_attendance: % over the period on staff_attendance. number | null
 *     (null = not tracked / no data — the table exists but may hold no rows).
 *
 * "Present" = present + late + half_day everywhere.
 * NULLIF(COUNT(*),0) makes an empty period return NULL, not 0 — do NOT coerce.
 * All queries filter da.deleted_at IS NULL (soft-deleted marks must not count).
 *
 * @param {string} period  'academic_year' (default) | 'month'
 * @param {number|string} schoolId  from JWT — never client input
 */
async function fetchAttendance(period, schoolId) {
    // Window for AVG ATTENDANCE, WORKING DAYS and the trend.
    const { from, to, label } = await resolveAttendancePeriod(schoolId, period);

    // AT RISK is ALWAYS academic-year-to-date, independent of the selected
    // period — it is the exam-eligibility bar. Resolve its own window.
    const atRiskWindow = await resolveAttendancePeriod(schoolId, 'academic_year');

    const [
        [avgAtt],
        [chronic],
        [workingDays],
        [staffAtt],
        trend,
        [presentDays],
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
        // ③ WORKING DAYS — Fork A. NULL when no attendance taken (no data).
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
        // Trend — last 14 days of student attendance % (unchanged intent).
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
        // Aggregate present student-days over the period (context, not a card).
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
    ]);

    const workingDaysCount = workingDays.count === null || workingDays.count === undefined
        ? null
        : parseInt(workingDays.count, 10);

    return {
        // Window context so the frontend can render empty states / labels.
        period: { from, to, label },
        // number | null — null means "no attendance data", render "—" not "0%".
        avg_attendance: toPct(avgAtt.pct),
        // integer — 0 is a genuine, good-news value.
        chronic_absentees: parseInt(chronic.count, 10) || 0,
        total_present_days: parseInt(presentDays.count, 10) || 0,
        // integer | null — null means no attendance taken in the window.
        total_working_days: workingDaysCount,
        // number | null — null means staff attendance not tracked / no data.
        staff_attendance: toPct(staffAtt.pct),
        trend: trend.map(t => ({ label: t.label, value: toPct(t.value) ?? 0 })),
        by_class: [],
        low_attendance_students: []
    };
}

/**
 * fetchAcademics — 100% DB-driven
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
    ]);

    return {
        avg_score: Math.round(parseFloat(avgScore.avg) || 0),
        pass_rate: Math.round(parseFloat(passRate.rate) || 0),
        top_subject: topSubjects.length > 0 ? topSubjects[0].name : '—',
        weakest_subject: weakSubjects.length > 0 ? weakSubjects[0].name : '—',
        exams_conducted: parseInt(examsCount.count) || 0,
        trend: trend.map(t => ({ label: t.label, value: Math.round(parseFloat(t.value) || 0) })),
        by_subject: []
    };
}

/**
 * fetchStaff — 100% DB-driven
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
    ]);

    return {
        total_staff: parseInt(total.count) || 0,
        active_staff: parseInt(active.count) || 0,
        on_leave_today: parseInt(onLeave.count) || 0,
        avg_staff_attendance: Math.round(parseFloat(staffAttPct.pct) || 0),
        new_joinings: parseInt(newJoins.count) || 0,
        resignations: parseInt(resigned.count) || 0
    };
}

/**
 * generateInsights — dynamically generate alerts based on real DB data.
 * Attendance metrics may now be null (no data) — insights must skip nulls
 * rather than treat them as 0 and raise a false "critically low" alarm.
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
            created_at: new Date().toISOString()
        });
    }
    if (financials.collection_efficiency < 70) {
        insights.push({
            id: String(id++),
            severity: 'high',
            category: 'finance',
            message: `Collection efficiency is only ${financials.collection_efficiency}% — significantly below target.`,
            created_at: new Date().toISOString()
        });
    } else if (financials.collection_efficiency < 85) {
        insights.push({
            id: String(id++),
            severity: 'medium',
            category: 'finance',
            message: `Collection efficiency at ${financials.collection_efficiency}% — room for improvement.`,
            created_at: new Date().toISOString()
        });
    }

    // Attendance alerts — only when we actually have an attendance figure.
    if (attendance.avg_attendance !== null) {
        if (attendance.avg_attendance < 75) {
            insights.push({
                id: String(id++),
                severity: 'high',
                category: 'attendance',
                message: `Average attendance critically low at ${attendance.avg_attendance}%.`,
                created_at: new Date().toISOString()
            });
        } else if (attendance.avg_attendance < 85) {
            insights.push({
                id: String(id++),
                severity: 'medium',
                category: 'attendance',
                message: `Average attendance at ${attendance.avg_attendance}% — below target of 85%.`,
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
            created_at: new Date().toISOString()
        });
    } else if (attendance.chronic_absentees > 0) {
        insights.push({
            id: String(id++),
            severity: 'medium',
            category: 'attendance',
            message: `${attendance.chronic_absentees} student(s) at risk with attendance below 75%.`,
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
            created_at: new Date().toISOString()
        });
    } else if (academics.pass_rate < 85) {
        insights.push({
            id: String(id++),
            severity: 'medium',
            category: 'academic',
            message: `Pass rate at ${academics.pass_rate}% — consider additional tutoring sessions.`,
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
            created_at: new Date().toISOString()
        });
    }
    if (staff.avg_staff_attendance > 0 && staff.avg_staff_attendance < 85) {
        insights.push({
            id: String(id++),
            severity: 'medium',
            category: 'staff',
            message: `Staff attendance at ${staff.avg_staff_attendance}% this month — below expected standard.`,
            created_at: new Date().toISOString()
        });
    }

    return insights.slice(0, 5); // Return top 5 most relevant
}

const _analyticsCache = new Map();

async function getOrFetchAnalytics(range, period, schoolId) {
    const key = `${schoolId}:${range}:${period}`;
    const cached = _analyticsCache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    const [financials, attendance, academics, staff] = await Promise.all([
        fetchFinancials(range, schoolId),
        fetchAttendance(period, schoolId),
        fetchAcademics(range, schoolId),
        fetchStaff(schoolId),
    ]);
    const data = { financials, attendance, academics, staff };
    _analyticsCache.set(key, { data, expiresAt: Date.now() + 5 * 60_000 });
    return data;
}

/**
 * GET /admin/analytics — Full dashboard snapshot, 100% DB-driven.
 * `range`  drives financials/academics (month|quarter|year).
 * `period` drives the attendance cards (academic_year|month, default academic_year).
 * AT RISK is always academic-year-to-date regardless of `period`.
 */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
    const { range = 'month' } = req.query;
    const period = normalizeAttendancePeriod(req.query.period);
    const schoolId = req.schoolId;

    const { financials, attendance, academics, staff } = await getOrFetchAnalytics(range, period, schoolId);

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
    const schoolId = req.schoolId;
    const { financials, attendance, academics, staff } = await getOrFetchAnalytics(range, period, schoolId);
    const insights = generateInsights(financials, attendance, academics, staff);
    return sendSuccess(res, req.schoolId, insights);
}));

router.patch('/insights/:id/dismiss', requireAuth, asyncHandler(async (req, res) => {
    return sendSuccess(res, req.schoolId, { success: true });
}));

router.post('/export', requireAuth, asyncHandler(async (req, res) => {
    return sendSuccess(res, req.schoolId, { download_url: 'https://example.com/report.pdf' });
}));

export default router;
