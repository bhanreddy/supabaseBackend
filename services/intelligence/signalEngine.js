import sql from '../../db.js';
import logger from '../../utils/logger.js';
import { getStudentBaseline, calculateBaselineDeviation } from './studentBaselineService.js';

/**
 * Extracts and normalizes signals for a single student across SchoolIMS modules.
 */
export async function extractStudentSignals({ schoolId, studentId }) {
  const signals = [];
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const twentyOneDaysAgo = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // 1. Fetch personal baseline
  const baseline = await getStudentBaseline({ schoolId, studentId, windowDays: 60 });

  // 2. Attendance Signals (Recent 14-day window vs personal baseline)
  const [recentAttendance] = await sql`
    SELECT
      count(*)::int AS total_days,
      SUM(CASE WHEN da.status IN ('present', 'late') THEN 1 WHEN da.status = 'half_day' THEN 0.5 ELSE 0 END)::float AS present_days,
      ROUND(
        100.0 * SUM(CASE WHEN da.status IN ('present', 'late') THEN 1 WHEN da.status = 'half_day' THEN 0.5 ELSE 0 END)::numeric / NULLIF(count(*), 0),
        1
      )::float AS recent_pct
    FROM public.daily_attendance da
    JOIN public.student_enrollments se ON se.id = da.student_enrollment_id
    WHERE se.school_id = ${schoolId}
      AND se.student_id = ${studentId}
      AND da.attendance_date >= ${fourteenDaysAgo}::date
      AND da.deleted_at IS NULL
  `;

  if (recentAttendance && recentAttendance.total_days >= 5 && baseline.attendance?.baselinePct != null && !baseline.attendance.insufficientData) {
    const recentPct = recentAttendance.recent_pct;
    const deviation = calculateBaselineDeviation(recentPct, baseline.attendance.baselinePct);

    if (deviation <= -10.0 || recentPct < 75.0) {
      signals.push({
        signal_type: 'ATTENDANCE_DROP',
        source_module: 'ATTENDANCE',
        severity: deviation <= -20.0 ? 'LEVEL_3_ATTENTION' : 'LEVEL_2_WATCH',
        confidence: recentAttendance.total_days >= 10 ? 'HIGH' : 'MODERATE',
        value_numeric: recentPct,
        baseline_value: baseline.attendance.baselinePct,
        delta_percentage: deviation,
        window_days: 14,
        metadata: {
          days_evaluated: recentAttendance.total_days,
          present_days: recentAttendance.present_days,
          note: `Attendance in last 14 days dropped to ${recentPct}% (baseline: ${baseline.attendance.baselinePct}%)`,
        },
      });
    } else if (recentPct >= 98.0 && recentAttendance.total_days >= 10) {
      signals.push({
        signal_type: 'ATTENDANCE_REGULARITY',
        source_module: 'ATTENDANCE',
        severity: 'LEVEL_1_POSITIVE',
        confidence: 'HIGH',
        value_numeric: recentPct,
        baseline_value: baseline.attendance.baselinePct,
        delta_percentage: deviation,
        window_days: 14,
        metadata: {
          days_evaluated: recentAttendance.total_days,
          note: `Exceptional attendance punctuality (${recentPct}%) over the last 14 days`,
        },
      });
    }
  }

  // 3. Academic Consecutive Change Signals (Marks across published assessments)
  const recentMarks = await sql`
    SELECT
      e.id AS exam_id,
      e.name AS exam_name,
      to_char(e.start_date, 'YYYY-MM-DD') AS exam_date,
      ROUND(
        100.0 * SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END)::numeric / NULLIF(SUM(es.max_marks), 0),
        1
      )::float AS score_percentage
    FROM public.marks m
    JOIN public.exam_subjects es ON es.id = m.exam_subject_id
    JOIN public.exams e ON e.id = es.exam_id
    JOIN public.student_enrollments se ON se.id = m.student_enrollment_id
    WHERE se.school_id = ${schoolId}
      AND se.student_id = ${studentId}
      AND e.deleted_at IS NULL
      AND e.results_published = true
    GROUP BY e.id, e.name, e.start_date
    ORDER BY e.start_date DESC
    LIMIT 4
  `;

  if (recentMarks.length >= 3) {
    const s0 = recentMarks[0].score_percentage; // most recent
    const s1 = recentMarks[1].score_percentage;
    const s2 = recentMarks[2].score_percentage; // oldest in window

    // Check consecutive decline (s2 > s1 > s0)
    if (s2 > s1 && s1 > s0) {
      const dropPct = Number((s2 - s0).toFixed(1));
      signals.push({
        signal_type: 'ACADEMIC_DECLINE',
        source_module: 'EXAMS',
        severity: dropPct >= 15 ? 'LEVEL_3_ATTENTION' : 'LEVEL_2_WATCH',
        confidence: 'HIGH',
        value_numeric: s0,
        baseline_value: s2,
        delta_percentage: -dropPct,
        window_days: 60,
        metadata: {
          sequence: [s2, s1, s0],
          exams: [recentMarks[2].exam_name, recentMarks[1].exam_name, recentMarks[0].exam_name],
          note: `Assessment performance declined across 3 consecutive exams (${s2}% → ${s1}% → ${s0}%)`,
        },
      });
    }
    // Check consecutive gain (s0 > s1 > s2)
    else if (s0 > s1 && s1 > s2) {
      const gainPct = Number((s0 - s2).toFixed(1));
      signals.push({
        signal_type: 'ACADEMIC_IMPROVEMENT',
        source_module: 'EXAMS',
        severity: 'LEVEL_1_POSITIVE',
        confidence: 'HIGH',
        value_numeric: s0,
        baseline_value: s2,
        delta_percentage: gainPct,
        window_days: 60,
        metadata: {
          sequence: [s2, s1, s0],
          exams: [recentMarks[2].exam_name, recentMarks[1].exam_name, recentMarks[0].exam_name],
          note: `Assessment performance improved across 3 consecutive exams (${s2}% → ${s1}% → ${s0}%)`,
        },
      });
    }
  }

  // 4. Observation Signals from Anecdotes (last 30 days)
  const recentAnecdotes = await sql`
    SELECT
      a.id,
      a.observation_type,
      a.sentiment,
      a.severity,
      cat.code AS category_code,
      sub.code AS subcategory_code,
      a.observed_at
    FROM public.anecdotes a
    LEFT JOIN public.anecdote_categories cat ON cat.id = a.category_id
    LEFT JOIN public.anecdote_subcategories sub ON sub.id = a.subcategory_id
    WHERE a.school_id = ${schoolId}
      AND a.student_id = ${studentId}
      AND a.observed_at >= ${thirtyDaysAgo}::timestamptz
      AND a.deleted_at IS NULL
  `;

  const leadershipWindow = await sql`
    SELECT a.id, sub.code AS subcategory_code, a.sentiment
    FROM public.anecdotes a
    LEFT JOIN public.anecdote_subcategories sub ON sub.id = a.subcategory_id
    WHERE a.school_id = ${schoolId}
      AND a.student_id = ${studentId}
      AND a.observed_at >= ${sixtyDaysAgo}::timestamptz
      AND a.deleted_at IS NULL
  `;

  const behaviourWindow = await sql`
    SELECT a.id, cat.code AS category_code, a.sentiment
    FROM public.anecdotes a
    LEFT JOIN public.anecdote_categories cat ON cat.id = a.category_id
    WHERE a.school_id = ${schoolId}
      AND a.student_id = ${studentId}
      AND a.observed_at >= ${twentyOneDaysAgo}::timestamptz
      AND a.deleted_at IS NULL
  `;

  const leadershipRows = leadershipWindow.filter(
    (a) => a.subcategory_code === 'LEADERSHIP' || a.subcategory_code === 'PEER_SUPPORT'
  );
  const leadershipCount = leadershipRows.length;

  const homeworkConcernRows = recentAnecdotes.filter(
    (a) => a.subcategory_code === 'HOMEWORK' && (a.sentiment === 'ATTENTION' || a.sentiment === 'CONCERN')
  );
  const homeworkConcernCount = homeworkConcernRows.length;

  const behaviourConcernRows = behaviourWindow.filter(
    (a) => a.category_code === 'BEHAVIOUR' && (a.sentiment === 'ATTENTION' || a.sentiment === 'CONCERN')
  );
  const behaviourConcernCount = behaviourConcernRows.length;

  if (leadershipCount >= 3) {
    signals.push({
      signal_type: 'LEADERSHIP_POSITIVE',
      source_module: 'ANECDOTE',
      severity: 'LEVEL_1_POSITIVE',
      confidence: leadershipCount >= 4 ? 'HIGH' : 'MODERATE',
      value_numeric: leadershipCount,
      baseline_value: 0,
      delta_percentage: null,
      window_days: 60,
      metadata: {
        count: leadershipCount,
        anecdote_ids: leadershipRows.map((row) => row.id),
        note: `${leadershipCount} leadership & peer support observations recorded in the last 60 days`,
      },
    });
  }

  if (homeworkConcernCount >= 2) {
    signals.push({
      signal_type: 'HOMEWORK_INCOMPLETE',
      source_module: 'ANECDOTE',
      severity: homeworkConcernCount >= 3 ? 'LEVEL_3_ATTENTION' : 'LEVEL_2_WATCH',
      confidence: 'HIGH',
      value_numeric: homeworkConcernCount,
      baseline_value: 0,
      delta_percentage: null,
      window_days: 30,
      metadata: {
        count: homeworkConcernCount,
        anecdote_ids: homeworkConcernRows.map((row) => row.id),
        note: `${homeworkConcernCount} observations noting incomplete homework/preparation in 30 days`,
      },
    });
  }

  if (behaviourConcernCount >= 3) {
    signals.push({
      signal_type: 'BEHAVIOUR_CONCERN',
      source_module: 'ANECDOTE',
      severity: behaviourConcernCount >= 4 ? 'LEVEL_3_ATTENTION' : 'LEVEL_2_WATCH',
      confidence: behaviourConcernCount >= 4 ? 'HIGH' : 'MODERATE',
      value_numeric: behaviourConcernCount,
      baseline_value: 0,
      delta_percentage: null,
      window_days: 21,
      metadata: {
        count: behaviourConcernCount,
        anecdote_ids: behaviourConcernRows.map((row) => row.id),
        note: `${behaviourConcernCount} behavioural concerns logged in the last 21 days`,
      },
    });
  }

  // 5. Cross-Module Convergence Signal
  // When Attendance Drop + Homework/Academic concern are active concurrently
  const hasAttendanceDrop = signals.some((s) => s.signal_type === 'ATTENDANCE_DROP');
  const hasAcademicDecline = signals.some((s) => s.signal_type === 'ACADEMIC_DECLINE');
  const hasHomeworkIncomplete = signals.some((s) => s.signal_type === 'HOMEWORK_INCOMPLETE');

  if ((hasAttendanceDrop && hasAcademicDecline) || (hasAttendanceDrop && hasHomeworkIncomplete) || (hasAcademicDecline && hasHomeworkIncomplete)) {
    signals.push({
      signal_type: 'CROSS_MODULE_CORRELATION',
      source_module: 'CROSS_MODULE',
      severity: 'LEVEL_3_ATTENTION',
      confidence: 'HIGH',
      value_numeric: 2,
      baseline_value: null,
      delta_percentage: null,
      window_days: 30,
      metadata: {
        domains: [
          hasAttendanceDrop ? 'Attendance' : null,
          hasAcademicDecline ? 'Assessment Marks' : null,
          hasHomeworkIncomplete ? 'Homework Completion' : null,
        ].filter(Boolean),
        note: 'Multiple operational indicators (attendance, homework, and assessment) occurred together over the last 30 days.',
      },
    });
  }

  // 6. Persist generated signals into public.intelligence_signals
  const savedSignals = [];
  for (const sig of signals) {
    const [existing] = await sql`
      SELECT id, value_numeric
      FROM public.intelligence_signals
      WHERE school_id = ${schoolId}
        AND student_id = ${studentId}
        AND signal_type = ${sig.signal_type}
        AND detected_at >= now() - INTERVAL '12 hours'
      ORDER BY detected_at DESC
      LIMIT 1
    `;
    if (existing && Number(existing.value_numeric) === Number(sig.value_numeric)) {
      const [row] = await sql`SELECT * FROM public.intelligence_signals WHERE id = ${existing.id} LIMIT 1`;
      savedSignals.push(row);
      continue;
    }

    const [saved] = await sql`
      INSERT INTO public.intelligence_signals (
        school_id,
        student_id,
        signal_type,
        source_module,
        severity,
        confidence,
        value_numeric,
        baseline_value,
        delta_percentage,
        window_days,
        metadata
      ) VALUES (
        ${schoolId},
        ${studentId},
        ${sig.signal_type},
        ${sig.source_module},
        ${sig.severity},
        ${sig.confidence},
        ${sig.value_numeric},
        ${sig.baseline_value},
        ${sig.delta_percentage},
        ${sig.window_days},
        ${sql.json(sig.metadata)}
      )
      RETURNING *
    `;
    savedSignals.push(saved);
  }

  return savedSignals;
}
