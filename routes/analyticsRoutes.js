import express from 'express';
import sql from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';

const router = express.Router();

/** OPT-19: cache net-balance for identical school + date window (5 min). */
const _netBalanceCache = new Map();

/**
 * GET /admin/analytics/risk
 * AN1: scoped students query to school_id
 */
router.get('/risk', requireAuth, asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;

    const students = await sql`
        WITH attendance_stats AS (
            SELECT
                se.student_id,
                COUNT(*) FILTER (WHERE da.status IN ('present', 'late', 'half_day'))::FLOAT / NULLIF(COUNT(*), 0) * 100 as attendance_pct
            FROM daily_attendance da
            JOIN student_enrollments se ON da.student_enrollment_id = se.id
            JOIN students s ON se.student_id = s.id
            WHERE da.attendance_date > CURRENT_DATE - INTERVAL '60 days'
              AND s.school_id = ${schoolId}
            GROUP BY se.student_id
        ),
        academic_stats AS (
            SELECT
                m.student_enrollment_id,
                COUNT(*) FILTER (WHERE m.marks_obtained < 35) as failed_subjects,
                json_agg(sub.name) FILTER (WHERE m.marks_obtained < 35) as failed_subject_names
            FROM marks m
            JOIN exam_subjects es ON m.exam_subject_id = es.id
            JOIN subjects sub ON es.subject_id = sub.id
            JOIN student_enrollments se ON m.student_enrollment_id = se.id
            JOIN students s ON se.student_id = s.id
            WHERE m.created_at > CURRENT_DATE - INTERVAL '6 months'
              AND s.school_id = ${schoolId}
            GROUP BY m.student_enrollment_id
        ),
        discipline_stats AS (
            SELECT
                c.raised_for_student_id as student_id,
                COUNT(*) as incident_count,
                MAX(CASE WHEN c.priority = 'urgent' THEN 2 WHEN c.priority = 'high' THEN 1 ELSE 0 END) as max_severity
            FROM complaints c
            WHERE c.created_at > CURRENT_DATE - INTERVAL '6 months'
              AND c.raised_for_student_id IS NOT NULL
              AND c.school_id = ${schoolId}
            GROUP BY c.raised_for_student_id
        )
        SELECT
            s.id,
            p.display_name as name,
            s.admission_no,
            c.name || ' ' || sec.name as class_name,
            COALESCE(att.attendance_pct, 100) as attendance_pct,
            COALESCE(acad.failed_subjects, 0) as failed_count,
            COALESCE(acad.failed_subject_names, '[]'::json) as failed_names,
            COALESCE(disc.incident_count, 0) as discipline_count,
            COALESCE(disc.max_severity, 0) as discipline_severity,
            (
                SELECT COALESCE(json_agg(t.pct), '[]'::json)
                FROM (
                    SELECT (m.marks_obtained::FLOAT / es.max_marks * 100)::INT as pct
                    FROM marks m
                    JOIN exam_subjects es ON m.exam_subject_id = es.id
                    WHERE m.student_enrollment_id = se.id
                    ORDER BY m.created_at DESC
                    LIMIT 5
                ) t
            ) as trend
        FROM students s
        JOIN persons p ON s.person_id = p.id
        JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active'
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections sec ON cs.section_id = sec.id
        LEFT JOIN attendance_stats att ON s.id = att.student_id
        LEFT JOIN academic_stats acad ON se.id = acad.student_enrollment_id
        LEFT JOIN discipline_stats disc ON s.id = disc.student_id
        WHERE s.deleted_at IS NULL
          AND s.school_id = ${schoolId}
    `;

    /**
     * Composite risk score (0–100). Higher = more urgent.
     * Weights: attendance 40 · academics 30 · discipline 20 · mark trend 10
     * Multiple mid-level flags compound into CRITICAL so single-threshold
     * blind spots (e.g. 76% attendance + 1 fail) are not under-ranked.
     */
    const scoreTrendDecline = (rawTrend) => {
        const series = Array.isArray(rawTrend)
            ? rawTrend.map(Number).filter((n) => Number.isFinite(n))
            : [];
        if (series.length < 3) return { points: 0, label: null, values: series.length ? [...series].reverse() : [0, 0, 0, 0, 0] };
        const chronological = [...series].reverse(); // oldest → newest
        const first = chronological.slice(0, Math.ceil(chronological.length / 2));
        const last = chronological.slice(-Math.ceil(chronological.length / 2));
        const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
        const drop = avg(first) - avg(last);
        if (drop >= 20) return { points: 10, label: `Marks ↓ ${Math.round(drop)} pts`, values: chronological };
        if (drop >= 10) return { points: 6, label: `Marks soft ↓ ${Math.round(drop)} pts`, values: chronological };
        if (drop >= 5) return { points: 3, label: null, values: chronological };
        return { points: 0, label: null, values: chronological };
    };

    const riskProfiles = students.map((s) => {
        const attendance = Number(s.attendance_pct);
        const att = Number.isFinite(attendance) ? attendance : 100;
        const failedCount = Number(s.failed_count) || 0;
        const failedNames = Array.isArray(s.failed_names) ? s.failed_names.filter(Boolean) : [];
        const disciplineCount = Number(s.discipline_count) || 0;
        const disciplineSeverity = Number(s.discipline_severity) || 0;

        let score = 0;
        const factors = [];
        let hardCritical = false;

        // Attendance (0–40)
        if (att < 60) {
            score += 40;
            hardCritical = true;
            factors.push(`Attendance ${att.toFixed(0)}%`);
        } else if (att < 70) {
            score += 34;
            hardCritical = true;
            factors.push(`Attendance ${att.toFixed(0)}%`);
        } else if (att < 75) {
            score += 28;
            factors.push(`Attendance ${att.toFixed(0)}%`);
        } else if (att < 80) {
            score += 18;
            factors.push(`Attendance ${att.toFixed(0)}%`);
        } else if (att < 85) {
            score += 12;
            factors.push(`Attendance ${att.toFixed(0)}%`);
        } else if (att < 90) {
            score += 5;
        }

        // Academics (0–30)
        if (failedCount >= 3) {
            score += 30;
            hardCritical = true;
            factors.push(`${failedCount} failed subjects`);
        } else if (failedCount === 2) {
            score += 24;
            hardCritical = true;
            factors.push('2 failed subjects');
        } else if (failedCount === 1) {
            score += 14;
            factors.push(failedNames[0] ? `Failed ${failedNames[0]}` : '1 failed subject');
        }

        // Discipline (0–20)
        if (disciplineSeverity >= 2) {
            score += 20;
            hardCritical = true;
            factors.push('Urgent discipline case');
        } else if (disciplineSeverity === 1 || disciplineCount >= 3) {
            score += 12;
            factors.push(disciplineCount >= 3 ? `${disciplineCount} incidents` : 'Behavior warning');
        } else if (disciplineCount >= 1) {
            score += 6;
            factors.push(`${disciplineCount} incident${disciplineCount > 1 ? 's' : ''}`);
        }

        // Mark trend (0–10)
        const trendInfo = scoreTrendDecline(s.trend);
        score += trendInfo.points;
        if (trendInfo.label) factors.push(trendInfo.label);

        // Compound escalation: 2+ medium signals → treat as critical band
        const mediumSignals = factors.length;
        if (!hardCritical && mediumSignals >= 2 && score >= 22) {
            hardCritical = true;
        }

        let riskLevel = 'SAFE';
        if (hardCritical || score >= 36) riskLevel = 'CRITICAL';
        else if (score >= 14) riskLevel = 'WARNING';

        const primaryFactor = factors[0] || 'On track';
        let recommendation = 'Keep monitoring routine progress.';
        if (riskLevel === 'CRITICAL') {
            recommendation = att < 75
                ? 'Call parent this week — attendance recovery plan.'
                : failedCount >= 2
                    ? 'Schedule academic support / remedial meeting.'
                    : 'Escalate with counselor + parent conference.';
        } else if (riskLevel === 'WARNING') {
            recommendation = 'Soft check-in with class teacher this fortnight.';
        }

        return {
            id: s.id,
            name: s.name,
            class: s.class_name,
            riskLevel,
            riskScore: Math.min(100, Math.round(score)),
            attendancePct: Math.round(att),
            failedCount,
            factors: factors.slice(0, 4),
            primaryFactor,
            recommendation,
            trend: trendInfo.values.length ? trendInfo.values : [0, 0, 0, 0, 0],
        };
    });

    const sorted = riskProfiles.sort((a, b) => {
        const order = { CRITICAL: 0, WARNING: 1, SAFE: 2 };
        const byLevel = order[a.riskLevel] - order[b.riskLevel];
        if (byLevel !== 0) return byLevel;
        return b.riskScore - a.riskScore;
    });

    return sendSuccess(res, req.schoolId, sorted);
}));

/**
 * GET /admin/analytics/heatmap
 * AN2: scoped marks/students query to school_id
 */
router.get('/heatmap', requireAuth, asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;

    const stats = await sql`
        SELECT
            c.name as class_name,
            sub.name as subject_name,
            AVG(m.marks_obtained::FLOAT / es.max_marks * 100)::INT as avg_pct
        FROM marks m
        JOIN exam_subjects es ON m.exam_subject_id = es.id
        JOIN subjects sub ON es.subject_id = sub.id
        JOIN student_enrollments se ON m.student_enrollment_id = se.id
        JOIN students s ON se.student_id = s.id
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        WHERE m.created_at > CURRENT_DATE - INTERVAL '1 year'
          AND s.school_id = ${schoolId}
        GROUP BY c.name, sub.name
        ORDER BY c.name, sub.name
    `;

    const classes = [...new Set(stats.map(s => s.class_name))];
    const subjects = [...new Set(stats.map(s => s.subject_name))];
    const data = {};

    classes.forEach(c => {
        data[c] = {};
        subjects.forEach(s => data[c][s] = 0);
    });

    stats.forEach(r => {
        if (data[r.class_name]) {
            data[r.class_name][r.subject_name] = r.avg_pct;
        }
    });

    return sendSuccess(res, req.schoolId, { classes, subjects, data });
}));

/**
 * GET /admin/analytics/talking-points/:id
 * AN3: student lookup and all stats scoped to school_id
 */
const COMMON_SUBJECT_NAMES_TE = new Map([
    ['english', 'ఆంగ్లం'],
    ['telugu', 'తెలుగు'],
    ['hindi', 'హిందీ'],
    ['mathematics', 'గణితం'],
    ['maths', 'గణితం'],
    ['math', 'గణితం'],
    ['science', 'సైన్స్'],
    ['social science', 'సాంఘిక శాస్త్రం'],
    ['social studies', 'సాంఘిక శాస్త్రం'],
    ['social', 'సాంఘిక శాస్త్రం'],
    ['physics', 'భౌతిక శాస్త్రం'],
    ['chemistry', 'రసాయన శాస్త్రం'],
    ['biology', 'జీవ శాస్త్రం'],
    ['computer science', 'కంప్యూటర్ సైన్స్'],
    ['computers', 'కంప్యూటర్ సైన్స్'],
    ['environmental science', 'పర్యావరణ శాస్త్రం'],
    ['evs', 'పర్యావరణ శాస్త్రం'],
    ['sanskrit', 'సంస్కృతం'],
    ['general knowledge', 'సాధారణ జ్ఞానం'],
    ['gk', 'సాధారణ జ్ఞానం'],
]);

function subjectNameTe(subject) {
    const translated = String(subject.subject_name_te || '').trim();
    if (translated) return translated;
    const original = String(subject.subject_name || '').trim();
    return COMMON_SUBJECT_NAMES_TE.get(original.toLowerCase()) || original || 'తెలియని విషయం';
}

function roundOne(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 10) / 10 : null;
}

function formatPct(value) {
    const number = roundOne(value);
    return number == null ? 'డేటా లేదు' : `${number}%`;
}

/**
 * Build only from calculated database facts. Generative text was deliberately
 * removed here: it could alter counts, mix marks from unrelated subjects, and
 * return English despite a Telugu prompt.
 */
export function buildVerifiedTeluguPoints({
    attendance,
    exams,
    weakSubjects,
    complaints,
    parentVisits,
}) {
    const points = [];
    const totalDays = Number(attendance?.total_days) || 0;
    const fullPresentDays = Number(attendance?.full_present_days) || 0;
    const halfDays = Number(attendance?.half_days) || 0;
    const absentDays = Number(attendance?.absent_days) || 0;
    const effectivePresentDays = roundOne(attendance?.effective_present_days) || 0;
    const attendancePct = totalDays > 0 ? roundOne((effectivePresentDays / totalDays) * 100) : null;

    if (totalDays > 0) {
        const halfDayDetail = halfDays > 0
            ? ` ఇందులో ${halfDays} అర్ధదినాల వల్ల లెక్కించిన హాజరు ${effectivePresentDays} రోజులు.`
            : '';
        const action = attendancePct < 75
            ? 'హాజరు తక్కువగా ఉంది; గైర్హాజరు కారణాలు తెలుసుకొని వారపు హాజరు ప్రణాళిక అమలు చేయాలి.'
            : attendancePct < 85
                ? 'హాజరులో మెరుగుదల అవసరం; ప్రతి వారం హాజరును తల్లిదండ్రులతో సమీక్షించాలి.'
                : 'హాజరు స్థిరంగా ఉంది; ఇదే క్రమాన్ని కొనసాగించాలి.';
        points.push(
            `గత అరవై రోజుల నమోదులో మొత్తం ${totalDays} పాఠశాల రోజులలో ${fullPresentDays} పూర్తి రోజులు హాజరు, ${absentDays} రోజులు గైర్హాజరు.${halfDayDetail} మొత్తం హాజరు శాతం ${attendancePct}%. ${action}`,
        );
    } else {
        points.push(
            'గత అరవై రోజుల హాజరు నమోదు అందుబాటులో లేదు; హాజరు శాతాన్ని ఊహించకుండా, ముందుగా హాజరు నమోదులు పూర్తయ్యాయో లేదో పరిశీలించాలి.',
        );
    }

    const latestExam = exams?.[0];
    const previousExam = exams?.[1];
    if (latestExam && previousExam) {
        const latestPct = roundOne(latestExam.avg_pct);
        const previousPct = roundOne(previousExam.avg_pct);
        const delta = latestPct - previousPct;
        const trendText = delta > 0.5
            ? `${Math.abs(roundOne(delta))} శాతం పాయింట్లు మెరుగయ్యారు`
            : delta < -0.5
                ? `${Math.abs(roundOne(delta))} శాతం పాయింట్లు తగ్గారు`
                : 'గణనీయమైన మార్పు లేదు';
        points.push(
            `మునుపటి పరీక్ష “${previousExam.exam_name_te || previousExam.exam_name}”లో సగటు ${formatPct(previousPct)}, తాజా పరీక్ష “${latestExam.exam_name_te || latestExam.exam_name}”లో ${formatPct(latestPct)}; అందువల్ల ${trendText}. తదుపరి పరీక్షకు ఇదే విధంగా పరీక్షల వారీ సగటును పోల్చాలి.`,
        );
    } else if (latestExam) {
        points.push(
            `తాజా పరీక్ష “${latestExam.exam_name_te || latestExam.exam_name}”లో సగటు ${formatPct(latestExam.avg_pct)}. మెరుగుదల ఉందో లేదో చెప్పడానికి మరో మునుపటి పరీక్ష ఫలితం అవసరం; ప్రస్తుతం తప్పుడు పోలిక చేయలేదు.`,
        );
    } else {
        points.push(
            'పరీక్ష మార్కులు నమోదు కాలేదు; విద్యా మెరుగుదల లేదా తగ్గుదల గురించి నిర్ణయం చెప్పడానికి కనీసం రెండు పరీక్షల ఫలితాలు నమోదు చేయాలి.',
        );
    }

    if (Array.isArray(weakSubjects) && weakSubjects.length > 0) {
        const subjectDetails = weakSubjects.map((subject) => {
            const name = subjectNameTe(subject);
            const currentPct = formatPct(subject.current_pct);
            if (subject.is_absent) return `${name}లో పరీక్షకు గైర్హాజరు`;
            if (subject.previous_pct == null) return `${name}లో ${currentPct} (మునుపటి మార్కు లేదు)`;
            const delta = roundOne(Number(subject.current_pct) - Number(subject.previous_pct));
            const comparison = delta > 0.5
                ? `మునుపటి కంటే ${Math.abs(delta)} పాయింట్లు మెరుగుదల`
                : delta < -0.5
                    ? `మునుపటి కంటే ${Math.abs(delta)} పాయింట్లు తగ్గుదల`
                    : 'మునుపటి స్థాయిలోనే';
            return `${name}లో ${currentPct} (${comparison})`;
        });
        points.push(
            `తాజా పరీక్ష ఆధారంగా ప్రత్యేక శ్రద్ధ అవసరమైన విషయాలు: ${subjectDetails.join('; ')}. ఈ విషయాలకు వారానికి ఒక లక్ష్య పునశ్చరణ మరియు చిన్న పరీక్ష పెట్టాలి.`,
        );
    } else if (latestExam) {
        points.push(
            'తాజా పరీక్షలో ఉత్తీర్ణత మార్కులకు దిగువన లేదా యాభై శాతం కంటే తక్కువగా ఉన్న విషయం కనిపించలేదు; అయినా విషయాల వారీ పురోగతిని తదుపరి పరీక్షలో మళ్లీ పోల్చాలి.',
        );
    }

    const complaintCount = Number(complaints?.behaviour_count) || 0;
    const openComplaintCount = Number(complaints?.open_behaviour_count) || 0;
    const seriousComplaintCount = Number(complaints?.serious_behaviour_count) || 0;
    if (complaintCount > 0) {
        points.push(
            `గత ఆరు నెలల్లో ప్రవర్తనకు సంబంధించిన ${complaintCount} క్రమశిక్షణ ఫిర్యాదులు నమోదయ్యాయి; వాటిలో పరిష్కారం కానివి ${openComplaintCount}, అధిక ప్రాధాన్యంతో నమోదైనవి ${seriousComplaintCount}. ఫిర్యాదులలో కనిపించే పునరావృత కారణంపై ఉపాధ్యాయుడు–తల్లిదండ్రి సంయుక్త కార్యాచరణ నిర్ణయించి, రెండు వారాల తర్వాత సమీక్షించాలి.`,
        );
    } else {
        points.push(
            'గత ఆరు నెలల నమోదుల ప్రకారం ప్రవర్తన ఫిర్యాదులు లేవు; ఇది ఫిర్యాదు రికార్డు ఆధారంగా మాత్రమే చెప్పిన విషయం, కాబట్టి తరగతి ఉపాధ్యాయుడి ప్రత్యక్ష అభిప్రాయాన్ని కూడా అడగాలి.',
        );
    }

    const visitCount = Number(parentVisits?.total_count) || 0;
    if (visitCount > 0) {
        const latestVisit = parentVisits?.last_visited_on
            ? ` చివరి సందర్శన తేదీ ${parentVisits.last_visited_on}.`
            : '';
        points.push(
            `ఈ విద్యార్థి గురించి తల్లిదండ్రులు ఇప్పటివరకు ${visitCount} సార్లు పాఠశాలను సందర్శించారు.${latestVisit} ఈ సమావేశంలో గత సందర్శనలో నిర్ణయించిన చర్యలు అమలయ్యాయో లేదో నమోదు చేయాలి.`,
        );
    } else {
        points.push(
            'ఈ విద్యార్థి గురించి తల్లిదండ్రుల పాఠశాల సందర్శన ఇంకా నమోదు కాలేదు; ఈ సమావేశాన్ని మొదటి సందర్శనగా నమోదు చేసి చర్చించిన చర్యలను భద్రపరచాలి.',
        );
    }

    return points;
}

router.get('/talking-points/:id', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const schoolId = req.schoolId;

    // AN3: Ownership check — student must belong to this school
    const [student] = await sql`
        SELECT
            s.id,
            p.display_name,
            s.admission_no,
            c.name || ' ' || sec.name as class_name
        FROM students s
        JOIN persons p ON s.person_id = p.id
        JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active'
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections sec ON cs.section_id = sec.id
        WHERE (s.id::text = ${id} OR s.admission_no = ${id})
          AND s.school_id = ${schoolId}
        LIMIT 1
    `;

    if (!student) return res.status(404).json({ error: 'Student not found' });

    const [[complaintStats], [attendance], examSummaries, [parentVisitStats]] = await Promise.all([
        sql`
        SELECT
            COUNT(*)::int AS total_count,
            COUNT(*) FILTER (WHERE status IN ('open', 'in_progress'))::int AS open_count,
            COUNT(*) FILTER (
                WHERE lower(COALESCE(category, '')) = 'disciplinary'
            )::int AS behaviour_count,
            COUNT(*) FILTER (
                WHERE lower(COALESCE(category, '')) = 'disciplinary'
                  AND status IN ('open', 'in_progress')
            )::int AS open_behaviour_count,
            COUNT(*) FILTER (
                WHERE lower(COALESCE(category, '')) = 'disciplinary'
                  AND priority IN ('high', 'urgent')
            )::int AS serious_behaviour_count
        FROM complaints
        WHERE raised_for_student_id = ${student.id}
          AND school_id = ${schoolId}
          AND deleted_at IS NULL
          AND created_at > CURRENT_DATE - INTERVAL '6 months'
    `,
        sql`
        SELECT
            COUNT(*)::int AS total_days,
            COUNT(*) FILTER (WHERE da.status IN ('present', 'late'))::int AS full_present_days,
            COUNT(*) FILTER (WHERE da.status = 'half_day')::int AS half_days,
            COUNT(*) FILTER (WHERE da.status = 'absent')::int AS absent_days,
            (
                COUNT(*) FILTER (WHERE da.status IN ('present', 'late'))
                + 0.5 * COUNT(*) FILTER (WHERE da.status = 'half_day')
            )::float AS effective_present_days
        FROM daily_attendance da
        JOIN student_enrollments se ON da.student_enrollment_id = se.id
        JOIN students s ON se.student_id = s.id
        WHERE se.student_id = ${student.id}
          AND s.school_id = ${schoolId}
          AND da.deleted_at IS NULL
          AND da.attendance_date > CURRENT_DATE - INTERVAL '60 days'
    `,
        sql`
        SELECT
            e.id AS exam_id,
            e.name AS exam_name,
            e.name_te AS exam_name_te,
            COALESCE(e.end_date, e.start_date, MAX(m.created_at)::date) AS exam_date,
            ROUND(AVG(
                CASE WHEN m.is_absent THEN 0
                     ELSE m.marks_obtained::numeric / NULLIF(es.max_marks, 0) * 100
                END
            ), 1)::float AS avg_pct
        FROM marks m
        JOIN exam_subjects es ON m.exam_subject_id = es.id
        JOIN exams e ON es.exam_id = e.id
        JOIN student_enrollments se ON m.student_enrollment_id = se.id
        JOIN students s ON se.student_id = s.id
        WHERE se.student_id = ${student.id}
          AND s.school_id = ${schoolId}
          AND m.school_id = ${schoolId}
          AND es.deleted_at IS NULL
          AND e.deleted_at IS NULL
          AND e.status <> 'cancelled'
        GROUP BY e.id, e.name, e.name_te, e.end_date, e.start_date
        ORDER BY exam_date DESC NULLS LAST, MAX(m.created_at) DESC
        LIMIT 2
    `,
        sql`
        SELECT
            COUNT(*)::int AS total_count,
            TO_CHAR(MAX(visited_at) AT TIME ZONE 'Asia/Kolkata', 'DD-MM-YYYY') AS last_visited_on
        FROM parent_visits
        WHERE student_id = ${student.id}
          AND school_id = ${schoolId}
          AND deleted_at IS NULL
    `,
    ]);

    const latestExamId = examSummaries[0]?.exam_id || null;
    const weakSubjects = latestExamId
        ? await sql`
            SELECT
                sub.name AS subject_name,
                sub.name_te AS subject_name_te,
                m.is_absent,
                ROUND(
                    CASE WHEN m.is_absent THEN 0
                         ELSE m.marks_obtained::numeric / NULLIF(es.max_marks, 0) * 100
                    END,
                    1
                )::float AS current_pct,
                previous.previous_pct
            FROM marks m
            JOIN exam_subjects es ON m.exam_subject_id = es.id
            JOIN subjects sub ON es.subject_id = sub.id
            JOIN student_enrollments se ON m.student_enrollment_id = se.id
            LEFT JOIN LATERAL (
                SELECT ROUND(
                    CASE WHEN pm.is_absent THEN 0
                         ELSE pm.marks_obtained::numeric / NULLIF(pes.max_marks, 0) * 100
                    END,
                    1
                )::float AS previous_pct
                FROM marks pm
                JOIN exam_subjects pes ON pm.exam_subject_id = pes.id
                JOIN exams pe ON pes.exam_id = pe.id
                JOIN student_enrollments pse ON pm.student_enrollment_id = pse.id
                WHERE pse.student_id = ${student.id}
                  AND pm.school_id = ${schoolId}
                  AND pes.subject_id = es.subject_id
                  AND pe.id <> ${latestExamId}
                  AND pe.status <> 'cancelled'
                  AND pe.deleted_at IS NULL
                  AND pes.deleted_at IS NULL
                ORDER BY COALESCE(pe.end_date, pe.start_date, pm.created_at::date) DESC, pm.created_at DESC
                LIMIT 1
            ) previous ON TRUE
            WHERE se.student_id = ${student.id}
              AND m.school_id = ${schoolId}
              AND es.exam_id = ${latestExamId}
              AND es.deleted_at IS NULL
              AND (
                  m.is_absent
                  OR m.marks_obtained < es.passing_marks
                  OR (m.marks_obtained::numeric / NULLIF(es.max_marks, 0) * 100) < 50
              )
            ORDER BY current_pct ASC
            LIMIT 4
        `
        : [];

    const effectivePresentDays = roundOne(attendance?.effective_present_days) || 0;
    const totalDays = Number(attendance?.total_days) || 0;
    const attendancePct = totalDays > 0
        ? roundOne((effectivePresentDays / totalDays) * 100)
        : null;
    const latestExam = examSummaries[0] || null;
    const previousExam = examSummaries[1] || null;
    const examDelta = latestExam && previousExam
        ? roundOne(Number(latestExam.avg_pct) - Number(previousExam.avg_pct))
        : null;
    const resultTrend = examDelta == null
        ? 'insufficient_data'
        : examDelta > 0.5
            ? 'improved'
            : examDelta < -0.5
                ? 'declined'
                : 'unchanged';

    const points = buildVerifiedTeluguPoints({
        attendance,
        exams: examSummaries,
        weakSubjects,
        complaints: complaintStats,
        parentVisits: parentVisitStats,
    });

    return sendSuccess(res, req.schoolId, {
        points,
        source: 'calculated',
        language: 'te',
        summary: {
            attendance: {
                total_days: totalDays,
                present_days: effectivePresentDays,
                full_present_days: Number(attendance?.full_present_days) || 0,
                half_days: Number(attendance?.half_days) || 0,
                absent_days: Number(attendance?.absent_days) || 0,
                percentage: attendancePct,
            },
            complaints: {
                total: Number(complaintStats?.total_count) || 0,
                open: Number(complaintStats?.open_count) || 0,
                behaviour: Number(complaintStats?.behaviour_count) || 0,
                open_behaviour: Number(complaintStats?.open_behaviour_count) || 0,
                serious: Number(complaintStats?.serious_behaviour_count) || 0,
            },
            parent_visits: {
                total: Number(parentVisitStats?.total_count) || 0,
                last_visited_on: parentVisitStats?.last_visited_on || null,
            },
            result: {
                trend: resultTrend,
                change_points: examDelta,
                latest_exam: latestExam,
                previous_exam: previousExam,
                weak_subjects: weakSubjects.map((subject) => ({
                    name: subjectNameTe(subject),
                    current_pct: roundOne(subject.current_pct),
                    previous_pct: roundOne(subject.previous_pct),
                    is_absent: Boolean(subject.is_absent),
                })),
            },
        },
    });
}));

/**
 * GET /admin/analytics/net-balance
 * AN4: All 3 financial sub-queries scoped to school_id
 */
router.get('/net-balance', requireAuth, asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;
    const schoolId = req.schoolId;

    if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    const cacheKey = `${schoolId}:${startDate}:${endDate}`;
    const cached = _netBalanceCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
        return sendSuccess(res, req.schoolId, cached.payload);
    }

    const [[feeStats], [salaryStats], [expenseStats]] = await Promise.all([
        sql`
        SELECT COALESCE(SUM(ft.amount), 0) as total
        FROM fee_transactions ft
        JOIN student_fees sf ON ft.student_fee_id = sf.id
        WHERE ft.paid_at BETWEEN ${startDate} AND ${endDate}::date + INTERVAL '1 day'
          AND sf.school_id = ${schoolId}
    `,
        sql`
        SELECT COALESCE(SUM(sp.net_salary), 0) as total
        FROM staff_payroll sp
        JOIN staff st ON sp.staff_id = st.id
        WHERE sp.status = 'paid'
          AND sp.payment_date BETWEEN ${startDate} AND ${endDate}
          AND st.school_id = ${schoolId}
    `,
        sql`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM expenses
        WHERE status = 'paid'
          AND expense_date BETWEEN ${startDate} AND ${endDate}
          AND school_id = ${schoolId}
    `,
    ]);

    const totalFee = parseFloat(feeStats.total);
    const totalSalary = parseFloat(salaryStats.total);
    const totalExpenses = parseFloat(expenseStats.total);
    const netBalance = totalFee - totalSalary - totalExpenses;

    const payload = { totalFee, totalSalary, totalExpenses, netBalance };
    _netBalanceCache.set(cacheKey, { payload, expiresAt: Date.now() + 5 * 60_000 });

    return sendSuccess(res, req.schoolId, payload);
}));

export default router;
