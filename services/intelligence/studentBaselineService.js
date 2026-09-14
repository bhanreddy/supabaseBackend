import sql from '../../db.js';
import logger from '../../utils/logger.js';

/**
 * Calculates a student's personal historical baseline across attendance, assessments, and homework.
 * Baseline window is configurable (defaults to 60 days).
 */
export async function getStudentBaseline({ schoolId, studentId, windowDays = 60 }) {
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // 1. Attendance Baseline (% of days attended over window)
  const [attendanceRow] = await sql`
    SELECT
      count(*)::int AS total_days,
      SUM(CASE WHEN da.status IN ('present', 'late') THEN 1 WHEN da.status = 'half_day' THEN 0.5 ELSE 0 END)::float AS present_days,
      ROUND(
        100.0 * SUM(CASE WHEN da.status IN ('present', 'late') THEN 1 WHEN da.status = 'half_day' THEN 0.5 ELSE 0 END)::numeric / NULLIF(count(*), 0),
        1
      )::float AS attendance_percentage
    FROM public.daily_attendance da
    JOIN public.student_enrollments se ON se.id = da.student_enrollment_id
    WHERE se.school_id = ${schoolId}
      AND se.student_id = ${studentId}
      AND da.attendance_date >= ${windowStart}::date
      AND da.deleted_at IS NULL
  `;

  // 2. Academic Assessment Baseline (Average % across published exams in window)
  const [academicRow] = await sql`
    SELECT
      count(DISTINCT es.exam_id)::int AS exam_count,
      ROUND(
        100.0 * SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END)::numeric / NULLIF(SUM(es.max_marks), 0),
        1
      )::float AS academic_average_pct
    FROM public.marks m
    JOIN public.exam_subjects es ON es.id = m.exam_subject_id
    JOIN public.student_enrollments se ON se.id = m.student_enrollment_id
    WHERE se.school_id = ${schoolId}
      AND se.student_id = ${studentId}
      AND m.created_at >= ${windowStart}::timestamptz
  `;

  // 3. Observations Breakdown (Positive vs Concern)
  const [anecdoteStats] = await sql`
    SELECT
      COUNT(CASE WHEN sentiment IN ('POSITIVE', 'ACHIEVEMENT') THEN 1 END)::int AS positive_count,
      COUNT(CASE WHEN sentiment IN ('ATTENTION', 'CONCERN') THEN 1 END)::int AS concern_count,
      COUNT(*)::int AS total_observations
    FROM public.anecdotes
    WHERE school_id = ${schoolId}
      AND student_id = ${studentId}
      AND observed_at >= ${windowStart}::timestamptz
      AND deleted_at IS NULL
  `;

  const attendanceBaseline = attendanceRow?.attendance_percentage != null ? attendanceRow.attendance_percentage : null;
  const academicBaseline = academicRow?.academic_average_pct != null ? academicRow.academic_average_pct : null;
  const hasAttendanceData = (attendanceRow?.total_days || 0) >= 5;
  const hasAcademicData = (academicRow?.exam_count || 0) >= 2;

  // Persist only measured metrics. Never write placeholder "typical" scores.
  try {
    const periodType = `${windowDays}d`;
    if (hasAttendanceData && attendanceBaseline != null) {
      await sql`
        INSERT INTO public.student_intelligence_metrics (
          school_id, student_id, metric_key, metric_value, period_type, calculated_at
        ) VALUES (${schoolId}, ${studentId}, 'attendance_baseline', ${attendanceBaseline}, ${periodType}, now())
        ON CONFLICT (school_id, student_id, metric_key, period_type)
        DO UPDATE SET metric_value = EXCLUDED.metric_value, calculated_at = now()
      `;
    }
    if (hasAcademicData && academicBaseline != null) {
      await sql`
        INSERT INTO public.student_intelligence_metrics (
          school_id, student_id, metric_key, metric_value, period_type, calculated_at
        ) VALUES (${schoolId}, ${studentId}, 'academic_baseline', ${academicBaseline}, ${periodType}, now())
        ON CONFLICT (school_id, student_id, metric_key, period_type)
        DO UPDATE SET metric_value = EXCLUDED.metric_value, calculated_at = now()
      `;
    }
    await sql`
      INSERT INTO public.student_intelligence_metrics (
        school_id, student_id, metric_key, metric_value, period_type, calculated_at
      ) VALUES
        (${schoolId}, ${studentId}, 'observations_positive', ${anecdoteStats?.positive_count || 0}, ${periodType}, now()),
        (${schoolId}, ${studentId}, 'observations_concern', ${anecdoteStats?.concern_count || 0}, ${periodType}, now())
      ON CONFLICT (school_id, student_id, metric_key, period_type)
      DO UPDATE SET metric_value = EXCLUDED.metric_value, calculated_at = now()
    `;
  } catch (err) {
    logger.warn({ err: err.message, studentId }, 'Error caching student intelligence metrics');
  }

  return {
    studentId,
    windowDays,
    attendance: {
      totalDays: attendanceRow?.total_days || 0,
      presentDays: attendanceRow?.present_days || 0,
      baselinePct: attendanceBaseline,
      insufficientData: !hasAttendanceData,
    },
    academic: {
      examCount: academicRow?.exam_count || 0,
      baselinePct: academicBaseline,
      insufficientData: !hasAcademicData,
    },
    observations: {
      positiveCount: anecdoteStats?.positive_count || 0,
      concernCount: anecdoteStats?.concern_count || 0,
      totalCount: anecdoteStats?.total_observations || 0,
    },
  };
}

/**
 * Calculates the delta percentage from a personal baseline.
 * E.g., if baseline is 80% and current is 60%, delta is -25.0%.
 */
export function calculateBaselineDeviation(currentValue, baselineValue) {
  if (baselineValue == null || baselineValue === 0) return 0;
  const diff = Number(currentValue) - Number(baselineValue);
  return Number(((diff / Number(baselineValue)) * 100).toFixed(1));
}
