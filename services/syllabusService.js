import sql from '../db.js';
import logger from '../utils/logger.js';
import { emitSchoolEvent } from './automationEventService.js';

export const SYLLABUS_STATUS = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  DELAYED: 'DELAYED',
};

export const SYLLABUS_HEALTH = {
  ON_TRACK: 'ON_TRACK',
  AT_RISK: 'AT_RISK',
  DELAYED: 'DELAYED',
  PLANNING_INCOMPLETE: 'PLANNING_INCOMPLETE',
};

function scopedError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function resolveAcademicYearId(schoolId, academicYearId = null) {
  const [year] = academicYearId
    ? await sql`SELECT id FROM academic_years WHERE id=${academicYearId} AND school_id=${schoolId} AND deleted_at IS NULL`
    : await sql`SELECT id FROM academic_years WHERE school_id=${schoolId} AND deleted_at IS NULL
        AND CURRENT_DATE BETWEEN start_date AND end_date ORDER BY start_date DESC LIMIT 1`;
  if (!year) throw scopedError(academicYearId ? 'Academic year does not belong to this school' : 'No active academic year is configured', 409);
  return year.id;
}

async function validateCurriculumScope(schoolId, classId, subjectId, academicYearId) {
  const [scope] = await sql`
    SELECT c.id AS class_id, s.id AS subject_id
    FROM classes c
    JOIN subjects s ON s.id=${subjectId} AND s.school_id=${schoolId} AND s.deleted_at IS NULL
    WHERE c.id=${classId} AND c.school_id=${schoolId} AND c.deleted_at IS NULL
  `;
  if (!scope) throw scopedError('Class or subject does not belong to this school', 404);
  return resolveAcademicYearId(schoolId, academicYearId);
}

export async function validateSyllabusLinks(schoolId, { chapterId = null, topicId = null } = {}) {
  if (!chapterId && !topicId) return true;
  const [row] = await sql`
    SELECT sc.id AS chapter_id, st.id AS topic_id
    FROM syllabus_chapters sc
    LEFT JOIN syllabus_topics st ON st.chapter_id=sc.id AND st.school_id=${schoolId}
      AND st.id=${topicId || null}
    WHERE sc.school_id=${schoolId}
      AND sc.id=${chapterId || sql`(SELECT chapter_id FROM syllabus_topics WHERE id=${topicId} AND school_id=${schoolId})`}
  `;
  if (!row || (topicId && !row.topic_id)) throw scopedError('Syllabus chapter or topic does not belong to this school', 404);
  return true;
}

export async function canAccessTeacherSyllabus(schoolId, userId, classId, subjectId) {
  const [row] = await sql`
    SELECT 1
    FROM users u
    JOIN staff st ON st.person_id=u.person_id AND st.school_id=${schoolId} AND st.deleted_at IS NULL
    JOIN class_subjects cs ON cs.teacher_id=st.id AND cs.subject_id=${subjectId} AND cs.deleted_at IS NULL
    JOIN class_sections csec ON csec.id=cs.class_section_id AND csec.class_id=${classId}
      AND csec.school_id=${schoolId} AND csec.deleted_at IS NULL
    WHERE u.id=${userId} AND u.school_id=${schoolId} AND u.deleted_at IS NULL
    LIMIT 1
  `;
  return Boolean(row);
}

/**
 * Create or update a syllabus chapter.
 */
export async function upsertChapter({
  schoolId,
  academicYearId = null,
  classId,
  subjectId,
  term = 'Term 1',
  chapterNumber,
  title,
  estimatedPeriods = 1,
  targetCompletionDate = null,
  status = 'NOT_STARTED',
}) {
  if (!schoolId || !classId || !subjectId || !chapterNumber || !title) {
    throw new Error('schoolId, classId, subjectId, chapterNumber, and title are required');
  }

  const resolvedAcademicYearId = await validateCurriculumScope(schoolId, classId, subjectId, academicYearId);
  const [row] = await sql`
    INSERT INTO syllabus_chapters (
      school_id, academic_year_id, class_id, subject_id, term,
      chapter_number, title, estimated_periods, target_completion_date, status
    )
    VALUES (
      ${schoolId}, ${resolvedAcademicYearId}, ${classId}, ${subjectId}, ${term},
      ${chapterNumber}, ${title}, ${estimatedPeriods}, ${targetCompletionDate || null}, ${status}
    )
    ON CONFLICT (school_id, academic_year_id, class_id, subject_id, term, chapter_number) DO UPDATE SET
      title = EXCLUDED.title,
      estimated_periods = EXCLUDED.estimated_periods,
      target_completion_date = EXCLUDED.target_completion_date,
      status = EXCLUDED.status,
      updated_at = now()
    RETURNING *
  `;
  return row;
}

/**
 * Create a syllabus topic within a chapter.
 */
export async function createTopic({
  chapterId,
  schoolId,
  topicNumber,
  title,
  targetDate = null,
  status = 'NOT_STARTED',
}) {
  if (!chapterId || !schoolId || !topicNumber || !title) {
    throw new Error('chapterId, schoolId, topicNumber, and title are required');
  }

  await validateSyllabusLinks(schoolId, { chapterId });
  const [row] = await sql`
    INSERT INTO syllabus_topics (
      chapter_id, school_id, topic_number, title, target_date, status
    )
    VALUES (
      ${chapterId}, ${schoolId}, ${topicNumber}, ${title}, ${targetDate || null}, ${status}
    )
    ON CONFLICT (school_id, chapter_id, topic_number) DO UPDATE SET
      title=EXCLUDED.title, target_date=EXCLUDED.target_date, status=EXCLUDED.status
    RETURNING *
  `;
  return row;
}

/**
 * Get complete syllabus structure for a class and subject.
 */
export async function getSyllabusStructure(schoolId, { classId, subjectId, academicYearId = null }) {
  if (!schoolId || !classId || !subjectId) {
    throw new Error('schoolId, classId, and subjectId are required');
  }

  const resolvedAcademicYearId = await validateCurriculumScope(schoolId, classId, subjectId, academicYearId);
  const chapters = await sql`
    SELECT
      sc.*,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', st.id,
            'topic_number', st.topic_number,
            'title', st.title,
            'target_date', st.target_date,
            'status', st.status,
            'completed_at', st.completed_at
          ) ORDER BY st.topic_number ASC
        ) FILTER (WHERE st.id IS NOT NULL),
        '[]'::jsonb
      ) AS topics
    FROM syllabus_chapters sc
    LEFT JOIN syllabus_topics st ON st.chapter_id = sc.id AND st.school_id = ${schoolId}
    WHERE sc.school_id = ${schoolId}
      AND sc.class_id = ${classId}
      AND sc.subject_id = ${subjectId}
      AND sc.academic_year_id = ${resolvedAcademicYearId}
    GROUP BY sc.id
    ORDER BY sc.chapter_number ASC
  `;

  return chapters;
}

/**
 * Calculate explainable progress and delay projection.
 *
 * Methodology:
 *  - Total topics: T
 *  - Completed topics: C
 *  - Actual %: round(C / T * 100, 1)
 *  - Expected topics due by today: E (based on topic or chapter target dates)
 *  - Expected %: round(E / T * 100, 1)
 *  - Variance %: Actual % - Expected %
 *  - Health status:
 *      If T == 0: PLANNING_INCOMPLETE
 *      If Variance >= -5%: ON_TRACK
 *      If Variance between -5% and -15%: AT_RISK
 *      If Variance < -15%: DELAYED
 */
export function evaluateProgressMetrics({
  totalTopics = 0,
  completedTopics = 0,
  expectedDueTopics = 0,
  targetDatesConfigured = 0,
}) {
  if (totalTopics === 0 || targetDatesConfigured === 0) {
    return {
      planning_incomplete: true,
      total_topics: totalTopics,
      completed_topics: completedTopics,
      actual_pct: totalTopics > 0 ? Math.round((completedTopics / totalTopics) * 100) : 0,
      expected_pct: null,
      variance_pct: null,
      status: SYLLABUS_HEALTH.PLANNING_INCOMPLETE,
      status_label: 'Planning incomplete',
      topics_behind: 0,
      delay_days: null,
    };
  }

  const actualPct = Math.round((completedTopics / totalTopics) * 1000) / 10;
  const expectedPct = Math.min(100, Math.round((expectedDueTopics / totalTopics) * 1000) / 10);
  const variancePct = Math.round((actualPct - expectedPct) * 10) / 10;

  let status = SYLLABUS_HEALTH.ON_TRACK;
  let statusLabel = 'On Track';

  if (variancePct < -15) {
    status = SYLLABUS_HEALTH.DELAYED;
    statusLabel = 'Delayed';
  } else if (variancePct < -5) {
    status = SYLLABUS_HEALTH.AT_RISK;
    statusLabel = 'At Risk';
  }

  const topicsBehind = Math.max(0, expectedDueTopics - completedTopics);

  return {
    planning_incomplete: false,
    total_topics: totalTopics,
    completed_topics: completedTopics,
    expected_due_topics: expectedDueTopics,
    actual_pct: actualPct,
    expected_pct: expectedPct,
    variance_pct: variancePct,
    status,
    status_label: statusLabel,
    topics_behind: topicsBehind,
    delay_days: null,
  };
}

/**
 * Get Syllabus Progress calculation for a specific class-subject.
 */
export async function getSubjectProgress(schoolId, { classId, subjectId, academicYearId = null }) {
  const resolvedAcademicYearId = await validateCurriculumScope(schoolId, classId, subjectId, academicYearId);
  const [stats] = await sql`
    SELECT
      COUNT(st.id)::int AS total_topics,
      COUNT(st.id) FILTER (WHERE st.status = 'COMPLETED')::int AS completed_topics,
      COUNT(st.id) FILTER (
        WHERE st.target_date IS NOT NULL AND st.target_date <= CURRENT_DATE
      )::int AS expected_due_topics,
      COUNT(st.id) FILTER (WHERE st.target_date IS NOT NULL)::int AS target_dates_configured
    FROM syllabus_chapters sc
    JOIN syllabus_topics st ON st.chapter_id = sc.id
    WHERE sc.school_id = ${schoolId}
      AND sc.class_id = ${classId}
      AND sc.subject_id = ${subjectId}
      AND sc.academic_year_id = ${resolvedAcademicYearId}
  `;

  return evaluateProgressMetrics({
    totalTopics: stats?.total_topics || 0,
    completedTopics: stats?.completed_topics || 0,
    expectedDueTopics: stats?.expected_due_topics || 0,
    targetDatesConfigured: stats?.target_dates_configured || 0,
  });
}

/**
 * Academic Coordinator / Management Overview:
 * Compares class, section, subject, assigned teacher, expected %, actual %, variance, and status.
 */
export async function getAcademicCoordinatorOverview(schoolId, { academicYearId = null } = {}) {
  const resolvedAcademicYearId = await resolveAcademicYearId(schoolId, academicYearId);
  const rows = await sql`
    SELECT
      c.id AS class_id,
      c.name AS class_name,
      s.id AS subject_id,
      s.name AS subject_name,
      COALESCE(p.display_name, 'Unassigned') AS teacher_name,
      COUNT(st.id)::int AS total_topics,
      COUNT(st.id) FILTER (WHERE st.status = 'COMPLETED')::int AS completed_topics,
      COUNT(st.id) FILTER (
        WHERE st.target_date IS NOT NULL AND st.target_date <= CURRENT_DATE
      )::int AS expected_due_topics,
      COUNT(st.id) FILTER (WHERE st.target_date IS NOT NULL)::int AS target_dates_configured
    FROM classes c
    CROSS JOIN subjects s
    LEFT JOIN class_subjects cs ON cs.class_section_id IN (
      SELECT id FROM class_sections WHERE class_id = c.id AND school_id = ${schoolId}
    ) AND cs.subject_id = s.id AND cs.deleted_at IS NULL
    LEFT JOIN staff stf ON cs.teacher_id = stf.id
    LEFT JOIN persons p ON stf.person_id = p.id
    LEFT JOIN syllabus_chapters sc ON sc.class_id = c.id AND sc.subject_id = s.id AND sc.school_id = ${schoolId}
      AND sc.academic_year_id = ${resolvedAcademicYearId}
    LEFT JOIN syllabus_topics st ON st.chapter_id = sc.id AND st.school_id = ${schoolId}
    WHERE c.school_id = ${schoolId}
      AND s.school_id = ${schoolId}
      AND c.deleted_at IS NULL
      AND s.deleted_at IS NULL
    GROUP BY c.id, c.name, s.id, s.name, p.display_name
    HAVING COUNT(sc.id) > 0
    ORDER BY c.name ASC, s.name ASC
  `;

  return rows.map((r) => {
    const metrics = evaluateProgressMetrics({
      totalTopics: r.total_topics,
      completedTopics: r.completed_topics,
      expectedDueTopics: r.expected_due_topics,
      targetDatesConfigured: r.target_dates_configured,
    });

    return {
      class_id: r.class_id,
      class_name: r.class_name,
      subject_id: r.subject_id,
      subject_name: r.subject_name,
      teacher_name: r.teacher_name,
      ...metrics,
    };
  });
}

/**
 * Teacher View:
 * Returns quick syllabus status for a teacher's assigned class and subject.
 */
export async function getTeacherSyllabusSummary(schoolId, { classId, subjectId, academicYearId = null }) {
  const resolvedAcademicYearId = await validateCurriculumScope(schoolId, classId, subjectId, academicYearId);
  const [currentChapter] = await sql`
    SELECT id, chapter_number, title, status, target_completion_date
    FROM syllabus_chapters
    WHERE school_id = ${schoolId}
      AND class_id = ${classId}
      AND subject_id = ${subjectId}
      AND academic_year_id = ${resolvedAcademicYearId}
      AND status IN ('IN_PROGRESS', 'NOT_STARTED')
    ORDER BY chapter_number ASC
    LIMIT 1
  `;

  const [nextTopic] = await sql`
    SELECT id, topic_number, title, target_date
    FROM syllabus_topics
    WHERE school_id = ${schoolId}
      AND chapter_id = ${currentChapter?.id || null}
      AND status != 'COMPLETED'
    ORDER BY topic_number ASC
    LIMIT 1
  `;

  const progress = await getSubjectProgress(schoolId, { classId, subjectId, academicYearId: resolvedAcademicYearId });

  return {
    current_chapter: currentChapter ? `Ch ${currentChapter.chapter_number}: ${currentChapter.title}` : 'None in progress',
    next_topic: nextTopic ? `Topic ${nextTopic.topic_number}: ${nextTopic.title}` : 'All caught up',
    target_date: nextTopic?.target_date || currentChapter?.target_completion_date || null,
    actual_pct: progress.actual_pct,
    expected_pct: progress.expected_pct,
    status: progress.status,
    status_label: progress.status_label,
    delay_days: progress.delay_days,
    topics_behind: progress.topics_behind,
  };
}

/**
 * Update topic status when linked from Daily Diary.
 */
export async function linkDiaryToSyllabus(schoolId, { chapterId, topicId, status = 'IN_PROGRESS' }) {
  if (!schoolId) return;
  await validateSyllabusLinks(schoolId, { chapterId, topicId });

  if (topicId) {
    await sql`
      UPDATE syllabus_topics
      SET
        status = ${status},
        completed_at = CASE WHEN ${status} = 'COMPLETED' THEN CURRENT_DATE ELSE completed_at END
      WHERE id = ${topicId} AND school_id = ${schoolId}
    `;
  }

  if (chapterId && status === 'IN_PROGRESS') {
    await sql`
      UPDATE syllabus_chapters
      SET status = 'IN_PROGRESS', updated_at = now()
      WHERE id = ${chapterId} AND school_id = ${schoolId} AND status = 'NOT_STARTED'
    `;
  }
}
