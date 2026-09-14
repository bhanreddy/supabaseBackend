import sql from '../../db.js';
import { resolveStaffId } from '../anecdote/anecdoteAccessService.js';

/**
 * Generates aggregated school-wide intelligence cockpit data for Principal / School Admin.
 */
export async function getSchoolIntelligenceOverview({ schoolId }) {
  // 1. Total Enrolled Active Students
  const [studentStats] = await sql`
    SELECT count(DISTINCT s.id)::int AS total_students
    FROM public.students s
    JOIN public.student_enrollments se ON se.student_id = s.id
    WHERE s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
      AND se.status = 'active'
  `;

  // 2. Status Tier Distribution from student_intelligence_profiles
  const tierRows = await sql`
    SELECT
      status_tier,
      count(*)::int AS count
    FROM public.student_intelligence_profiles
    WHERE school_id = ${schoolId}
    GROUP BY status_tier
  `;

  const tierMap = { STABLE: 0, WATCH: 0, ATTENTION: 0, GROWTH: 0 };
  for (const row of tierRows) {
    if (tierMap[row.status_tier] !== undefined) {
      tierMap[row.status_tier] = row.count;
    }
  }

  // Any students without a profile yet are considered STABLE
  const profiledCount = Object.values(tierMap).reduce((a, b) => a + b, 0);
  const totalStudents = studentStats?.total_students || 0;
  if (totalStudents > profiledCount) {
    tierMap.STABLE += totalStudents - profiledCount;
  }

  // 3. Today's Operational Intelligence Metrics
  const today = new Date().toISOString().split('T')[0];

  // Emerging patterns in last 7 days
  const [patternStats] = await sql`
    SELECT count(*)::int AS count
    FROM public.intelligence_patterns
    WHERE school_id = ${schoolId}
      AND detected_at >= now() - INTERVAL '7 days'
  `;

  // Active strengths / positive milestones
  const [strengthStats] = await sql`
    SELECT count(*)::int AS count
    FROM public.intelligence_insights
    WHERE school_id = ${schoolId}
      AND insight_type IN ('GROWTH', 'STRENGTH')
      AND status = 'ACTIVE'
  `;

  // Review queue: Insights of type ATTENTION or CRITICAL_REVIEW requiring review
  const [reviewStats] = await sql`
    SELECT count(*)::int AS count
    FROM public.intelligence_insights
    WHERE school_id = ${schoolId}
      AND insight_type IN ('ATTENTION', 'CRITICAL_REVIEW')
      AND status = 'ACTIVE'
  `;

  // Follow-ups due today or overdue
  const [followupStats] = await sql`
    SELECT count(*)::int AS count
    FROM public.anecdote_followups
    WHERE school_id = ${schoolId}
      AND due_date <= ${today}::date
      AND status = 'PENDING'
  `;

  // Active interventions count
  const [interventionStats] = await sql`
    SELECT count(*)::int AS count
    FROM public.student_interventions
    WHERE school_id = ${schoolId}
      AND status IN ('RECOMMENDED', 'ACCEPTED', 'IN_PROGRESS', 'FOLLOW_UP')
  `;

  // 4. Class Trends (Academic avg, attendance avg, concern count per class)
  const classTrends = await sql`
    SELECT
      cs.id AS class_section_id,
      c.name AS class_name,
      s.name AS section_name,
      count(DISTINCT se.student_id)::int AS student_count,
      COALESCE(
        ROUND((AVG(p.attendance_rate_30d) FILTER (WHERE p.attendance_rate_30d IS NOT NULL))::numeric, 1),
        NULL
      )::float AS avg_attendance_rate,
      COALESCE(
        ROUND((AVG(p.assessment_avg_recent) FILTER (WHERE p.assessment_avg_recent IS NOT NULL))::numeric, 1),
        NULL
      )::float AS avg_assessment_score,
      COALESCE(
        SUM(CASE WHEN p.status_tier = 'ATTENTION' THEN 1 ELSE 0 END)::int,
        0
      ) AS attention_students_count,
      COALESCE(
        SUM(CASE WHEN p.status_tier = 'GROWTH' THEN 1 ELSE 0 END)::int,
        0
      ) AS growth_students_count,
      (
        SELECT count(*)::int
        FROM public.anecdotes a
        JOIN public.student_enrollments se2 ON se2.student_id = a.student_id
        WHERE a.school_id = ${schoolId}
          AND se2.class_section_id = cs.id
          AND se2.status = 'active'
          AND a.deleted_at IS NULL
          AND a.observed_at >= now() - INTERVAL '30 days'
      ) AS observation_count
    FROM public.class_sections cs
    JOIN public.classes c ON c.id = cs.class_id
    JOIN public.sections s ON s.id = cs.section_id
    LEFT JOIN public.student_enrollments se ON se.class_section_id = cs.id AND se.status = 'active'
    LEFT JOIN public.student_intelligence_profiles p ON p.student_id = se.student_id AND p.school_id = ${schoolId}
    WHERE cs.school_id = ${schoolId}
      AND cs.deleted_at IS NULL
    GROUP BY cs.id, c.name, s.name
    ORDER BY c.name ASC, s.name ASC
    LIMIT 20
  `;

  // 5. Recent High-Priority Review Items
  const reviewQueue = await sql`
    SELECT
      i.id,
      i.title,
      i.summary,
      i.insight_type,
      i.confidence,
      i.created_at,
      p.display_name AS student_name,
      p.photo_url AS student_photo_url,
      s.admission_no,
      c.name AS class_name,
      sec.name AS section_name
    FROM public.intelligence_insights i
    JOIN public.students s ON s.id = i.student_id
    JOIN public.persons p ON p.id = s.person_id
    LEFT JOIN public.class_sections cs ON cs.id = i.class_section_id
    LEFT JOIN public.classes c ON c.id = cs.class_id
    LEFT JOIN public.sections sec ON sec.id = cs.section_id
    WHERE i.school_id = ${schoolId}
      AND i.insight_type IN ('ATTENTION', 'CRITICAL_REVIEW')
      AND i.status = 'ACTIVE'
    ORDER BY i.created_at DESC
    LIMIT 10
  `;

  return {
    overview: {
      totalStudents,
      stableCount: tierMap.STABLE,
      watchCount: tierMap.WATCH,
      attentionCount: tierMap.ATTENTION,
      growthCount: tierMap.GROWTH,
    },
    today: {
      emergingPatterns: patternStats?.count || 0,
      studentStrengths: strengthStats?.count || 0,
      itemsRequiringReview: reviewStats?.count || 0,
      followupsDue: followupStats?.count || 0,
      activeInterventions: interventionStats?.count || 0,
    },
    classTrends: classTrends.map((row) => ({
      ...row,
      total_students: row.student_count,
      attention_count: row.attention_students_count,
      growth_count: row.growth_students_count,
      attendance_rate: row.avg_attendance_rate,
      homework_rate: null,
      academic_trend: row.avg_assessment_score != null ? `${row.avg_assessment_score}%` : null,
    })),
    reviewQueue,
  };
}

/**
 * Class-specific intelligence overview for teacher or coordinator.
 */
export async function getClassIntelligence({ schoolId, classSectionId }) {
  const [classInfo] = await sql`
    SELECT
      cs.id,
      c.name AS class_name,
      s.name AS section_name
    FROM public.class_sections cs
    JOIN public.classes c ON c.id = cs.class_id
    JOIN public.sections s ON s.id = cs.section_id
    WHERE cs.school_id = ${schoolId}
      AND cs.id = ${classSectionId}
      AND cs.deleted_at IS NULL
    LIMIT 1
  `;

  if (!classInfo) throw new Error('Class section not found');

  const students = await sql`
    SELECT
      s.id,
      s.admission_no,
      se.roll_number,
      p.display_name,
      p.photo_url,
      COALESCE(prof.status_tier, 'STABLE') AS status_tier,
      prof.attendance_rate_30d,
      prof.assessment_avg_recent,
      prof.active_insights_count,
      prof.active_interventions_count,
      prof.last_evaluated_at
    FROM public.student_enrollments se
    JOIN public.students s ON s.id = se.student_id
    JOIN public.persons p ON p.id = s.person_id
    LEFT JOIN public.student_intelligence_profiles prof ON prof.student_id = s.id AND prof.school_id = ${schoolId}
    WHERE se.school_id = ${schoolId}
      AND se.class_section_id = ${classSectionId}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
    ORDER BY se.roll_number ASC NULLS LAST, p.display_name ASC
  `;

  return {
    classInfo,
    students,
  };
}

/**
 * Teacher Intelligence Dashboard:
 * Returns the list of authorized students for the logged-in teacher's classes.
 */
export async function getTeacherStudentsIntelligence({ schoolId, staffId, userId = null, personId = null, classSectionId = null }) {
  const resolvedStaffId = staffId
    || await resolveStaffId({ schoolId, userId, personId });
  const classConditions = [sql`cs.school_id = ${schoolId}`, sql`cs.deleted_at IS NULL`];

  if (!resolvedStaffId) {
    return {
      summary: { total: 0, stable: 0, watch: 0, attention: 0, growth: 0 },
      students: [],
    };
  }

  if (classSectionId) {
    classConditions.push(sql`cs.id = ${classSectionId}`);
  }

  classConditions.push(sql`
    (
      cs.class_teacher_id = ${resolvedStaffId}
      OR EXISTS (
        SELECT 1 FROM public.timetable_slots ts
        WHERE ts.class_section_id = cs.id
          AND ts.teacher_id = ${resolvedStaffId}
          AND ts.deleted_at IS NULL
      )
    )
  `);

  const whereClass = classConditions.reduce((a, b) => sql`${a} AND ${b}`);

  const students = await sql`
    SELECT
      s.id,
      s.admission_no,
      se.roll_number,
      p.display_name,
      p.photo_url,
      c.name AS class_name,
      sec.name AS section_name,
      cs.id AS class_section_id,
      COALESCE(prof.status_tier, 'STABLE') AS status_tier,
      prof.attendance_rate_30d,
      prof.assessment_avg_recent,
      prof.total_anecdotes_positive,
      prof.total_anecdotes_concern,
      prof.active_insights_count,
      prof.active_interventions_count,
      (
        SELECT count(*)::int
        FROM public.anecdote_followups f
        JOIN public.anecdotes a ON a.id = f.anecdote_id
        WHERE a.student_id = s.id
          AND f.status = 'PENDING'
          AND f.due_date <= current_date
      ) AS followups_due_count,
      (
        SELECT json_build_object(
          'id', i.id,
          'student_id', i.student_id,
          'title', i.title,
          'summary', i.summary,
          'insight_type', i.insight_type,
          'confidence', i.confidence,
          'rule_code', i.rule_code,
          'recommendations', i.recommendations,
          'bullet_points', e.bullet_points,
          'explanation_text', e.explanation_text,
          'explanation_bullets', e.bullet_points,
          'recommended_actions', i.recommendations,
          'baseline_comparison', e.baseline_comparison,
          'data_sources', e.data_sources,
          'status', i.status
        )
        FROM public.intelligence_insights i
        LEFT JOIN public.intelligence_explanations e ON e.insight_id = i.id
        WHERE i.school_id = ${schoolId}
          AND i.student_id = s.id
          AND i.status = 'ACTIVE'
        ORDER BY
          CASE
            WHEN i.insight_type = 'CRITICAL_REVIEW' THEN 0
            WHEN i.insight_type = 'ATTENTION' THEN 1
            WHEN i.insight_type = 'WATCH' THEN 2
            ELSE 3
          END,
          i.created_at DESC
        LIMIT 1
      ) AS latest_insight
    FROM public.student_enrollments se
    JOIN public.students s ON s.id = se.student_id
    JOIN public.persons p ON p.id = s.person_id
    JOIN public.class_sections cs ON cs.id = se.class_section_id
    JOIN public.classes c ON c.id = cs.class_id
    JOIN public.sections sec ON sec.id = cs.section_id
    LEFT JOIN public.student_intelligence_profiles prof ON prof.student_id = s.id AND prof.school_id = ${schoolId}
    WHERE ${whereClass}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
    ORDER BY p.display_name ASC
  `;

  // Summary counts
  const stable = students.filter((s) => s.status_tier === 'STABLE').length;
  const watch = students.filter((s) => s.status_tier === 'WATCH').length;
  const attention = students.filter((s) => s.status_tier === 'ATTENTION').length;
  const growth = students.filter((s) => s.status_tier === 'GROWTH').length;

  return {
    summary: {
      total: students.length,
      stable,
      watch,
      attention,
      growth,
    },
    students: students.map((row) => ({
      ...row,
      student_id: row.id,
      name: row.display_name,
    })),
  };
}
