import express from 'express';
import sql from '../db.js';
import { requirePermission, requireAnyPermission, requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { translateFields } from '../services/geminiTranslator.js';
import {
  generateExamTimetable,
  getSectionExamSchedule,
  getTeacherExamSchedule,
  normalizeSyllabus,
  ExamTimetableError,
} from '../services/examTimetableService.js';
import {
  generateExamAllocations,
  sessionKey,
  clearExamSeating,
} from '../services/examAllocationService.js';
import {
  ExamResultPublishingError,
  getExamResultReadiness,
  setExamResultsPublished,
} from '../services/examResultPublishingService.js';
import { ACTIVE_STUDENT_STATUS_ID } from '../utils/activeStudentFilter.js';
import { RESULT_PUBLICATION_GATED_EXAM_TYPES } from '../utils/examResultVisibility.js';
import {
  componentMaximumsFromRow,
  componentTotalMax,
  componentWeightage20,
  parseComponentMaximums,
} from '../utils/componentMaximums.js';
import {
  normalizeResultRankingMethod,
  rankResultRows,
} from '../services/resultRankingService.js';
import {
  calculateFinalSubjectResult,
  canonicalFinalSourceKey,
  summarizeCalculatedSubjects,
  weightedContribution,
} from '../services/finalResultCalculationService.js';
import { filterEnteredProgressReportSubjects } from '../services/progressReportService.js';

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ABSENT_RESULT_MARKS = new Set(['A', 'AB']);

const canPreviewUnpublishedResults = (req) =>
  req.user?.roles?.includes('admin') || Boolean(req.staffPortalAccess?.admin_user_id);

const familyResultVisibility = () => sql`
  AND (
    e.results_published = TRUE
    OR NOT (e.exam_type::text = ANY(${sql.array(RESULT_PUBLICATION_GATED_EXAM_TYPES)}::text[]))
  )
`;

async function resolveProgressCardClassTeacher(req, res) {
  const requestedStaffId = typeof req.query.staff_id === 'string' ? req.query.staff_id.trim() : '';
  let staff;

  if (requestedStaffId) {
    if (!UUID_RE.test(requestedStaffId)) {
      res.status(400).json({ error: 'Invalid staff_id' });
      return null;
    }
    const isAdmin = req.user?.roles?.includes('admin');
    if (!isAdmin && !req.staffPortalAccess) {
      res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
      return null;
    }
    if (req.staffPortalAccess && String(req.staffPortalAccess.target_staff_id) !== requestedStaffId) {
      res.status(403).json({ error: 'Staff portal target mismatch' });
      return null;
    }
    [staff] = await sql`
      SELECT id FROM staff
      WHERE id = ${requestedStaffId}
        AND school_id = ${req.schoolId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
  } else {
    [staff] = await sql`
      SELECT id FROM staff
      WHERE person_id = ${req.user.person_id}
        AND school_id = ${req.schoolId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
  }

  if (!staff) {
    res.status(404).json({ error: 'Staff profile not found' });
    return null;
  }

  const [classSection] = await sql`
    WITH chosen_year AS (
      SELECT id, code
      FROM academic_years
      WHERE school_id = ${req.schoolId}
        AND deleted_at IS NULL
      ORDER BY
        CASE WHEN CURRENT_DATE BETWEEN start_date AND end_date THEN 0 ELSE 1 END,
        start_date DESC
      LIMIT 1
    )
    SELECT
      cs.id, cs.class_id, cs.academic_year_id,
      class.name AS class_name, section.name AS section_name,
      year.code AS academic_year
    FROM class_sections cs
    JOIN chosen_year year ON year.id = cs.academic_year_id
    JOIN classes class ON class.id = cs.class_id AND class.school_id = ${req.schoolId}
    JOIN sections section ON section.id = cs.section_id AND section.school_id = ${req.schoolId}
    WHERE cs.school_id = ${req.schoolId}
      AND cs.class_teacher_id = ${staff.id}
      AND cs.deleted_at IS NULL
    ORDER BY cs.id
    LIMIT 1
  `;

  return { staff, classSection: classSection || null };
}

async function getSchoolRankingMethod(schoolId) {
  const [setting] = await sql`
    SELECT value FROM school_settings
    WHERE school_id = ${schoolId} AND key = 'result_ranking_method'
    LIMIT 1
  `;
  return normalizeResultRankingMethod(setting?.value);
}

async function notifyPublishedResultUsers(schoolId, exam) {
  try {
    const { sendNotificationToUsers } = await import('../services/notificationService.js');
    const users = await sql`
      WITH result_students AS (
        SELECT DISTINCT se.student_id
        FROM exam_subjects es
        JOIN class_sections cs
          ON cs.class_id = es.class_id
         AND cs.academic_year_id = ${exam.academic_year_id}
         AND cs.school_id = ${schoolId}
         AND cs.deleted_at IS NULL
        JOIN student_enrollments se
          ON se.class_section_id = cs.id
         AND se.academic_year_id = ${exam.academic_year_id}
         AND se.school_id = ${schoolId}
         AND se.status = 'active'
         AND se.deleted_at IS NULL
        JOIN students active_student
          ON active_student.id = se.student_id
         AND active_student.school_id = ${schoolId}
         AND active_student.deleted_at IS NULL
         AND active_student.status_id = ${ACTIVE_STUDENT_STATUS_ID}
        WHERE es.exam_id = ${exam.id}
          AND es.school_id = ${schoolId}
          AND es.deleted_at IS NULL
      )
      SELECT DISTINCT u.id AS user_id
      FROM result_students rs
      JOIN students st ON st.id = rs.student_id
        AND st.school_id = ${schoolId}
        AND st.deleted_at IS NULL
        AND st.status_id = ${ACTIVE_STUDENT_STATUS_ID}
      JOIN users u
        ON u.person_id = st.person_id
       AND u.school_id = ${schoolId}
       AND u.account_status = 'active'
       AND u.deleted_at IS NULL
      UNION
      SELECT DISTINCT u.id AS user_id
      FROM result_students rs
      JOIN student_parents sp
        ON sp.student_id = rs.student_id
       AND sp.school_id = ${schoolId}
       AND sp.deleted_at IS NULL
      JOIN parents p
        ON p.id = sp.parent_id
       AND p.school_id = ${schoolId}
       AND p.deleted_at IS NULL
      JOIN users u
        ON u.person_id = p.person_id
       AND u.school_id = ${schoolId}
       AND u.account_status = 'active'
       AND u.deleted_at IS NULL
    `;
    const userIds = users.map((user) => user.user_id);
    if (userIds.length > 0) {
      await sendNotificationToUsers(userIds, 'RESULT_RELEASED', {
        message: `Results for ${exam.name} are now available.`,
      });
    }
  } catch (error) {
    console.error('Failed to notify users about published results', error);
  }
}

// ============== SUBJECTS ==============

/**
 * GET /results/subjects
 * List all subjects
 */
router.get('/subjects', requireAnyPermission(['academics.view', 'exams.view']), asyncHandler(async (req, res) => {
  const subjects = await sql`
    SELECT id, name, name_te, code, description
    FROM subjects
    WHERE school_id = ${req.schoolId}
    ORDER BY name
  `;
  return sendSuccess(res, req.schoolId, subjects);
}));

/**
 * POST /results/subjects
 * Create a subject
 */
router.post('/subjects', requireAnyPermission(['academics.manage', 'exams.manage']), asyncHandler(async (req, res) => {
  const { name, code, description, name_te } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Subject name is required' });
  }

  const codeNorm = code != null && String(code).trim() !== '' ? String(code).trim() : null;
  const descNorm = description != null && String(description).trim() !== '' ? String(description).trim() : null;

  // Auto-translate if not provided
  let finalNameTe = name_te ?? null;
  if (!finalNameTe && name) {
    try {
      const te = await translateFields({ name });
      finalNameTe = te.name || null;
    } catch (e) {}
  }

  const [subject] = await sql`
    INSERT INTO subjects (school_id, name, name_te, code, description)
    VALUES (${req.schoolId}, ${name}, ${finalNameTe}, ${codeNorm}, ${descNorm})
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Subject created', subject }, 201);
}));

/**
 * DELETE /results/subjects/:id
 * Delete a subject (if not linked to exams, classes, or LMS)
 */
router.delete('/subjects/:id', requireAnyPermission(['academics.manage', 'exams.manage']), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [hasExams, hasClasses, hasLMS, hasTimetable, hasDiary] = await Promise.all([
    sql`SELECT 1 FROM exam_subjects WHERE subject_id = ${id} AND school_id = ${req.schoolId} LIMIT 1`,
    sql`SELECT 1 FROM class_subjects WHERE subject_id = ${id} AND school_id = ${req.schoolId} LIMIT 1`,
    sql`SELECT 1 FROM lms_courses WHERE subject_id = ${id} AND school_id = ${req.schoolId} LIMIT 1`,
    sql`
      SELECT 1 FROM timetable_slots ts
      JOIN class_sections cs ON ts.class_section_id = cs.id
      WHERE ts.subject_id = ${id} AND cs.school_id = ${req.schoolId}
      LIMIT 1
    `,
    sql`SELECT 1 FROM diary_entries WHERE subject_id = ${id} AND school_id = ${req.schoolId} LIMIT 1`,
  ]);

  if (hasExams.length) {
    return res.status(400).json({ error: 'Cannot delete subject: Linked to one or more exams' });
  }
  if (hasClasses.length) {
    return res.status(400).json({ error: 'Cannot delete subject: Assigned to classes/sections' });
  }
  if (hasLMS.length) {
    return res.status(400).json({ error: 'Cannot delete subject: Linked to LMS materials' });
  }
  if (hasTimetable.length) {
    return res.status(400).json({ error: 'Cannot delete subject: Linked to timetable records' });
  }
  if (hasDiary.length) {
    return res.status(400).json({ error: 'Cannot delete subject: Linked to diary/homework records' });
  }

  await sql`DELETE FROM subjects WHERE id = ${id} AND school_id = ${req.schoolId}`;
  return sendSuccess(res, req.schoolId, { message: 'Subject deleted successfully' });
}));

// ============== EXAMS ==============

/**
 * GET /results/exams
 * List exams (filter by academic_year_id, status)
 */
router.get('/exams', requirePermission('exams.view'), asyncHandler(async (req, res) => {
  const { academic_year_id, status } = req.query;

  const exams = await sql`
    SELECT
      e.id, e.name, e.name_te, e.exam_type,
      e.start_date::text AS start_date, e.end_date::text AS end_date, e.status,
      e.timetable_published, e.results_published, e.results_published_at,
      result_progress.papers_total AS papers_count,
      result_progress.scheduled_papers_total AS scheduled_papers_count,
      json_build_object(
        'ready', (
          result_progress.papers_total > 0
          AND result_progress.expected_entries > 0
          AND result_progress.missing_entries = 0
        ),
        'papers_total', result_progress.papers_total,
        'papers_complete', result_progress.papers_complete,
        'expected_entries', result_progress.expected_entries,
        'entered_entries', result_progress.entered_entries,
        'missing_entries', result_progress.missing_entries
      ) AS result_readiness,
      ay.code as academic_year
    FROM exams e
    JOIN academic_years ay ON e.academic_year_id = ay.id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS papers_total,
        COUNT(*) FILTER (WHERE paper_progress.exam_date IS NOT NULL)::int AS scheduled_papers_total,
        COUNT(*) FILTER (
          WHERE paper_progress.expected_entries = paper_progress.entered_entries
        )::int AS papers_complete,
        COALESCE(SUM(paper_progress.expected_entries), 0)::int AS expected_entries,
        COALESCE(SUM(paper_progress.entered_entries), 0)::int AS entered_entries,
        COALESCE(SUM(
          GREATEST(paper_progress.expected_entries - paper_progress.entered_entries, 0)
        ), 0)::int AS missing_entries
      FROM LATERAL (
        SELECT
          es.id,
          es.exam_date,
          COUNT(DISTINCT st.id)::int AS expected_entries,
          COUNT(DISTINCT m.student_enrollment_id)::int AS entered_entries
        FROM exam_subjects es
        LEFT JOIN class_sections cs
          ON cs.class_id = es.class_id
         AND cs.academic_year_id = e.academic_year_id
         AND cs.school_id = ${req.schoolId}
         AND cs.deleted_at IS NULL
        LEFT JOIN student_enrollments se
          ON se.class_section_id = cs.id
         AND se.academic_year_id = e.academic_year_id
         AND se.school_id = ${req.schoolId}
         AND se.status = 'active'
         AND se.deleted_at IS NULL
        LEFT JOIN students st
          ON st.id = se.student_id
         AND st.school_id = ${req.schoolId}
         AND st.deleted_at IS NULL
         AND st.status_id = ${ACTIVE_STUDENT_STATUS_ID}
        LEFT JOIN marks m
          ON m.exam_subject_id = es.id
         AND m.student_enrollment_id = se.id
         AND m.school_id = ${req.schoolId}
         AND st.id IS NOT NULL
        WHERE es.exam_id = e.id
          AND es.school_id = ${req.schoolId}
          AND es.deleted_at IS NULL
        GROUP BY es.id, es.exam_date
      ) paper_progress
    ) result_progress ON TRUE
    WHERE e.school_id = ${req.schoolId}
      AND e.deleted_at IS NULL
      ${academic_year_id ? sql`AND e.academic_year_id = ${academic_year_id}` : sql``}
      ${status ? sql`AND e.status = ${status}` : sql``}
    ORDER BY e.start_date DESC
  `;

  return sendSuccess(res, req.schoolId, exams);
}));

/**
 * POST /results/exams
 * Create an exam
 */
router.post('/exams', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { name, name_te, academic_year_id, exam_type, start_date, end_date, status } = req.body;

  if (!name || !academic_year_id || !exam_type) {
    return res.status(400).json({ error: 'name, academic_year_id, and exam_type are required' });
  }

  // Auto-translate if not provided
  let finalNameTe = name_te ?? null;
  if (!finalNameTe && name) {
    try {
      const te = await translateFields({ name });
      finalNameTe = te.name || null;
    } catch (e) {}
  }

  const [exam] = await sql`
    INSERT INTO exams (school_id, name, name_te, academic_year_id, exam_type, start_date, end_date, status)
    VALUES (${req.schoolId}, ${name}, ${finalNameTe}, ${academic_year_id}, ${exam_type}, ${start_date ?? null}, ${end_date ?? null}, ${status || 'scheduled'})
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Exam created', exam }, 201);
}));

/**
 * GET /results/exams/:id
 * Get exam details with subjects
 */
router.get('/exams/:id', requirePermission('exams.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [exam] = await sql`
    SELECT e.*, ay.code as academic_year
    FROM exams e
    JOIN academic_years ay ON e.academic_year_id = ay.id
    WHERE e.id = ${id} AND e.school_id = ${req.schoolId}
  `;

  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }

  // Get exam subjects
  const subjects = await sql`
    SELECT 
      es.id, es.exam_date, es.max_marks, es.passing_marks,
      s.name as subject_name, s.name_te as subject_name_te, s.code as subject_code,
      c.name as class_name
    FROM exam_subjects es
    JOIN subjects s ON es.subject_id = s.id
    JOIN classes c ON es.class_id = c.id
    WHERE es.exam_id = ${id}
    ORDER BY c.name, s.name
  `;

  return sendSuccess(res, req.schoolId, { ...exam, subjects });
}));

/**
 * PUT /results/exams/:id
 * Update exam
 */
router.put('/exams/:id', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, exam_type, start_date, end_date, status, academic_year_id } = req.body;

  // RES2 FIX: Ownership check first
  const [examCheck] = await sql`SELECT id FROM exams WHERE id = ${id} AND school_id = ${req.schoolId}`;
  if (!examCheck) {
    return res.status(404).json({ error: 'Exam not found' });
  }

  // SECURITY: If academic_year_id is being changed, verify no marks exist for this exam
  if (academic_year_id) {
    const [hasMarks] = await sql`
            SELECT 1 FROM marks m
            JOIN exam_subjects es ON m.exam_subject_id = es.id
            WHERE es.exam_id = ${id} LIMIT 1
        `;
    if (hasMarks) {
      return res.status(400).json({ error: 'Cannot change academic year of an exam that has recorded marks' });
    }
  }

  const [updated] = await sql`
    UPDATE exams
    SET 
      name = COALESCE(${name ?? null}, name),
      academic_year_id = COALESCE(${academic_year_id ?? null}, academic_year_id),
      exam_type = COALESCE(${exam_type ?? null}, exam_type),
      start_date = COALESCE(${start_date ?? null}, start_date),
      end_date = COALESCE(${end_date ?? null}, end_date),
      status = COALESCE(${status ?? null}, status)
    WHERE id = ${id} AND school_id = ${req.schoolId}
    RETURNING *
  `;

  if (!updated) {
    return res.status(404).json({ error: 'Exam not found' });
  }

  return sendSuccess(res, req.schoolId, { message: 'Exam updated', exam: updated });
}));

/**
 * DELETE /results/exams/:id
 * Delete an exam. By default this is blocked when marks exist. The explicit
 * force=true path is reserved for the admin UI's fully destructive reset.
 */
router.delete('/exams/:id', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const force = String(req.query.force || '').toLowerCase() === 'true';

  const [exam] = await sql`
    SELECT id
    FROM exams
    WHERE id = ${id} AND school_id = ${req.schoolId}
  `;
  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }

  if (!force) {
    const [hasMarks] = await sql`
      SELECT 1
      FROM marks m
      JOIN exam_subjects es ON m.exam_subject_id = es.id
      WHERE es.exam_id = ${id}
        AND es.school_id = ${req.schoolId}
        AND m.school_id = ${req.schoolId}
      LIMIT 1
    `;
    if (hasMarks) {
      return res.status(400).json({ error: 'Cannot delete exam: Student marks have already been recorded' });
    }
  }

  // exam_subjects, marks, room allocations and seat assignments are all
  // protected by ON DELETE CASCADE. One scoped delete is therefore atomic.
  await sql`DELETE FROM exams WHERE id = ${id} AND school_id = ${req.schoolId}`;
  return sendSuccess(res, req.schoolId, { message: 'Exam deleted successfully' });
}));

/**
 * POST /results/exams/:id/subjects
 * Add subjects to exam
 */
router.post('/exams/:id/subjects', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { subject_id, class_id, exam_date, start_time, end_time, max_marks, passing_marks } = req.body;

  if (!subject_id || !class_id) {
    return res.status(400).json({ error: 'subject_id and class_id are required' });
  }

  // RES3 FIX: Verify exam ownership
  const [examCheck] = await sql`
    SELECT id, results_published FROM exams WHERE id = ${id} AND school_id = ${req.schoolId}
  `;
  if (!examCheck) {
    return res.status(404).json({ error: 'Exam not found' });
  }
  if (examCheck.results_published) {
    return res.status(409).json({ error: 'Unpublish the exam results before adding a paper.' });
  }

  // RES3 FIX: Add school_id to exam_subjects INSERT
  const [examSubject] = await sql`
    INSERT INTO exam_subjects (school_id, exam_id, subject_id, class_id, exam_date, start_time, end_time, max_marks, passing_marks)
    VALUES (${req.schoolId}, ${id}, ${subject_id}, ${class_id}, ${exam_date ?? null}, ${start_time ?? null}, ${end_time ?? null}, ${max_marks || 100}, ${passing_marks || 35})
    RETURNING *
  `;

  // A new scheduled paper means unseated students — clear stale seating.
  let seatingCleared = 0;
  if (exam_date) {
    seatingCleared = await clearExamSeating(sql, req.schoolId, id);
  }

  return sendSuccess(res, req.schoolId, {
    message:
      seatingCleared > 0
        ? 'Subject added. Seating & invigilation were cleared — reallocate rooms.'
        : 'Subject added to exam',
    seating_cleared: seatingCleared,
    exam_subject: examSubject,
  }, 201);
}));

// ============== MARKS ==============

/**
 * POST /results/marks/upload
 * Upload marks (bulk)
 * Body: { exam_subject_id, marks: [{ student_enrollment_id, marks_obtained, is_absent, remarks }] }
 */
router.post('/marks/upload', requirePermission('marks.enter'), asyncHandler(async (req, res) => {
  const { exam_subject_id, marks } = req.body;

  if (!exam_subject_id || !marks || !Array.isArray(marks)) {
    return res.status(400).json({ error: 'exam_subject_id and marks array are required' });
  }

  // RES4 FIX: Validate exam_subject ownership against both exam_subjects and exams school_id.
  const [examSubject] = await sql`
    SELECT es.id, es.max_marks, es.exam_id, e.school_id, e.results_published
    FROM exam_subjects es
    JOIN exams e ON es.exam_id = e.id
    WHERE es.id = ${exam_subject_id}
      AND es.school_id = ${req.schoolId}
      AND e.school_id = ${req.schoolId}
  `;

  if (!examSubject) {
    return res.status(404).json({ error: 'Exam subject not found' });
  }
  if (examSubject.results_published) {
    return res.status(409).json({ error: 'Results are published. Ask an admin to unpublish them before changing marks.' });
  }

  const enteredBy = req.user?.internal_id;
  const results = [];

  for (const m of marks) {
    const { student_enrollment_id, marks_obtained, is_absent, remarks } = m;

    if (!student_enrollment_id) continue;

    // Validate marks
    if (!is_absent && (marks_obtained < 0 || marks_obtained > examSubject.max_marks)) {
      results.push({ student_enrollment_id, error: `Marks must be between 0 and ${examSubject.max_marks}` });
      continue;
    }

    // Check if mark already exists to prevent duplicate notifications
    const [existingMark] = await sql`
        SELECT id FROM marks 
        WHERE exam_subject_id = ${exam_subject_id} 
          AND student_enrollment_id = ${student_enrollment_id}
        LIMIT 1
    `;

    try {
      // Auto-translate remarks
      let remarks_te = null;
      if (remarks) {
        try { const te = await translateFields({ remarks }); remarks_te = te.remarks || null; } catch (e) {}
      }

      // Upsert marks (B2: school_id required)
      const [result] = await sql`
        INSERT INTO marks (school_id, exam_subject_id, student_enrollment_id, marks_obtained, is_absent, remarks, remarks_te, entered_by)
        VALUES (${req.schoolId}, ${exam_subject_id}, ${student_enrollment_id}, ${is_absent ? null : marks_obtained}, ${is_absent || false}, ${remarks}, ${remarks_te}, ${enteredBy})
        ON CONFLICT (school_id, exam_subject_id, student_enrollment_id) 
        DO UPDATE SET 
          marks_obtained = EXCLUDED.marks_obtained,
          is_absent = EXCLUDED.is_absent,
          remarks = EXCLUDED.remarks,
          remarks_te = EXCLUDED.remarks_te,
          entered_by = EXCLUDED.entered_by
        RETURNING id
      `;

      // ONLY notify if this was a new insert (not an update)
      const isNewInsert = !existingMark;

      results.push({
        student_enrollment_id,
        id: result.id,
        success: true,
        isNew: isNewInsert
      });

    } catch (err) {
      results.push({ student_enrollment_id, error: err.message });
    }
  }

  return sendSuccess(res, req.schoolId, { message: 'Marks uploaded', results });
}));

/**
 * GET /results/marks/student/:studentId
 * Get marks for a student
 */
router.get('/marks/student/:studentId', requirePermission('marks.view'), asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { exam_id, academic_year_id } = req.query;

  // B2/B5: Verify student belongs to this school
  const [studentCheck] = await sql`SELECT id FROM students WHERE id = ${studentId} AND school_id = ${req.schoolId} AND deleted_at IS NULL`;
  if (!studentCheck) return res.status(404).json({ error: 'Student not found' });

  let marksQuery;
  if (exam_id) {
    marksQuery = await sql`
      SELECT 
        m.id, m.marks_obtained, m.is_absent, m.remarks, m.remarks_te,
        s.name as subject_name, s.name_te as subject_name_te, s.code as subject_code,
        es.max_marks, es.passing_marks,
        e.name as exam_name, e.name_te as exam_name_te
      FROM marks m
      JOIN exam_subjects es ON m.exam_subject_id = es.id AND es.school_id = ${req.schoolId}
      JOIN subjects s ON es.subject_id = s.id
      JOIN exams e ON es.exam_id = e.id AND e.school_id = ${req.schoolId}
      JOIN student_enrollments se ON m.student_enrollment_id = se.id AND se.school_id = ${req.schoolId}
      WHERE se.student_id = ${studentId}
        AND es.exam_id = ${exam_id}
      ORDER BY s.name
    `;
  } else {
    marksQuery = await sql`
      SELECT 
        m.id, m.marks_obtained, m.is_absent, m.remarks,
        s.name as subject_name, s.name_te as subject_name_te,
        es.max_marks, es.passing_marks,
        e.name as exam_name, e.name_te as exam_name_te, e.exam_type,
        ay.code as academic_year
      FROM marks m
      JOIN exam_subjects es ON m.exam_subject_id = es.id AND es.school_id = ${req.schoolId}
      JOIN subjects s ON es.subject_id = s.id
      JOIN exams e ON es.exam_id = e.id AND e.school_id = ${req.schoolId}
      JOIN academic_years ay ON e.academic_year_id = ay.id
      JOIN student_enrollments se ON m.student_enrollment_id = se.id AND se.school_id = ${req.schoolId}
      WHERE se.student_id = ${studentId}
        ${academic_year_id ? sql`AND e.academic_year_id = ${academic_year_id}` : sql``}
      ORDER BY ay.start_date DESC, e.start_date DESC, s.name
    `;
  }

  return sendSuccess(res, req.schoolId, marksQuery);
}));

/**
 * GET /results/marks/class/:classId/exam/:examId
 * Get marks for a class in an exam
 */
router.get('/marks/class/:classId/exam/:examId', requirePermission('marks.view'), asyncHandler(async (req, res) => {
  const { classId, examId } = req.params;
  const { subject_id } = req.query;

  // B2/B5: Verify class and exam belong to this school
  const [classCheck] = await sql`SELECT id FROM classes WHERE id = ${classId} AND school_id = ${req.schoolId}`;
  const [examCheck] = await sql`SELECT id FROM exams WHERE id = ${examId} AND school_id = ${req.schoolId}`;
  if (!classCheck || !examCheck) return res.status(404).json({ error: 'Class or exam not found' });

  let marks;
  if (subject_id) {
    marks = await sql`
      SELECT 
        m.id, m.marks_obtained, m.is_absent, m.remarks,
        s.id as student_id, s.admission_no, se.roll_number,
        p.display_name as student_name,
        sub.name as subject_name,
        es.max_marks, es.passing_marks
      FROM marks m
      JOIN exam_subjects es ON m.exam_subject_id = es.id AND es.school_id = ${req.schoolId}
      JOIN subjects sub ON es.subject_id = sub.id
      JOIN student_enrollments se ON m.student_enrollment_id = se.id AND se.school_id = ${req.schoolId}
      JOIN students s ON se.student_id = s.id AND s.school_id = ${req.schoolId}
      JOIN persons p ON s.person_id = p.id
      JOIN class_sections cs ON se.class_section_id = cs.id AND cs.school_id = ${req.schoolId}
      WHERE cs.class_id = ${classId}
        AND es.exam_id = ${examId}
        AND es.subject_id = ${subject_id}
        AND se.status = 'active'
        AND s.status_id = ${ACTIVE_STUDENT_STATUS_ID}
        AND s.deleted_at IS NULL
      ORDER BY se.roll_number ASC NULLS LAST, p.display_name ASC
    `;
  } else {
    marks = await sql`
      SELECT 
        s.id as student_id, s.admission_no, se.roll_number,
        p.display_name as student_name,
        json_agg(json_build_object(
          'subject', sub.name,
          'marks_obtained', m.marks_obtained,
          'max_marks', es.max_marks,
          'is_absent', m.is_absent
        )) as subjects
      FROM students s
      JOIN persons p ON s.person_id = p.id
      JOIN student_enrollments se ON s.id = se.student_id AND se.school_id = ${req.schoolId}
      JOIN class_sections cs ON se.class_section_id = cs.id AND cs.school_id = ${req.schoolId}
      LEFT JOIN marks m ON m.student_enrollment_id = se.id AND m.school_id = ${req.schoolId}
      LEFT JOIN exam_subjects es ON m.exam_subject_id = es.id AND es.exam_id = ${examId} AND es.school_id = ${req.schoolId}
      LEFT JOIN subjects sub ON es.subject_id = sub.id
      WHERE cs.class_id = ${classId}
        AND se.status = 'active'
        AND s.deleted_at IS NULL
        AND s.status_id = ${ACTIVE_STUDENT_STATUS_ID}
        AND s.school_id = ${req.schoolId}
      GROUP BY s.id, s.admission_no, se.roll_number, p.display_name
      ORDER BY se.roll_number ASC NULLS LAST, p.display_name ASC
    `;
  }

  return sendSuccess(res, req.schoolId, marks);
}));

/**
 * PUT /results/marks/:id
 * Update a mark entry
 */
router.put('/marks/:id', requirePermission('marks.enter'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { marks_obtained, is_absent, remarks } = req.body;

  // RES5 FIX: Ownership check — verify mark belongs to this school via exam_subjects
  const [markCheck] = await sql`
    SELECT m.id, e.results_published FROM marks m
    JOIN exam_subjects es ON m.exam_subject_id = es.id
    JOIN exams e ON e.id = es.exam_id AND e.school_id = ${req.schoolId}
    WHERE m.id = ${id} AND es.school_id = ${req.schoolId}
  `;
  if (!markCheck) {
    return res.status(404).json({ error: 'Mark entry not found' });
  }
  if (markCheck.results_published) {
    return res.status(409).json({ error: 'Results are published. Ask an admin to unpublish them before changing marks.' });
  }

  const [updated] = await sql`
    UPDATE marks
    SET 
      marks_obtained = ${is_absent ? null : marks_obtained},
      is_absent = COALESCE(${is_absent ?? null}, is_absent),
      remarks = COALESCE(${remarks ?? null}, remarks),
      entered_by = ${req.user?.internal_id},
      updated_at = NOW()
    WHERE id = ${id}
      AND school_id = ${req.schoolId}
    RETURNING *
  `;

  if (!updated) {
    return res.status(404).json({ error: 'Mark entry not found' });
  }

  return sendSuccess(res, req.schoolId, { message: 'Mark updated', mark: updated });
}));

// ============== RESULTS ==============

/**
 * GET /results/student/:studentId
 * Get comprehensive result for a student
 */
router.get('/student/:studentId', requirePermission('results.view'), asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { exam_id, academic_year_id } = req.query;
  const resultVisibility = () => canPreviewUnpublishedResults(req)
    ? sql``
    : familyResultVisibility();
  const resultCompleteness = () => canPreviewUnpublishedResults(req)
    ? sql``
    : sql`
        HAVING
          NOT (e.exam_type::text = ANY(${sql.array(RESULT_PUBLICATION_GATED_EXAM_TYPES)}::text[]))
          OR COUNT(m.id) = COUNT(es.id)
      `;

  // Get student info
  const [student] = await sql`
    SELECT s.id, s.admission_no, p.display_name, p.photo_url,
           c.name as class_name, sec.name as section_name
    FROM students s
    JOIN persons p ON s.person_id = p.id
    LEFT JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active'
    LEFT JOIN class_sections cs ON se.class_section_id = cs.id
    LEFT JOIN classes c ON cs.class_id = c.id
    LEFT JOIN sections sec ON cs.section_id = sec.id
    WHERE s.id = ${studentId} AND s.deleted_at IS NULL AND s.school_id = ${req.schoolId}
  `;

  if (!student) {
    return res.status(404).json({ error: 'Student not found' });
  }

  // Get exam results
  let results;
  if (exam_id) {
    // Scope papers to the student's active class so other classes' subjects
    // do not appear as duplicate zero / null rows.
    const [enrollment] = await sql`
      SELECT se.id AS enrollment_id, cs.class_id
      FROM student_enrollments se
      JOIN class_sections cs ON se.class_section_id = cs.id
        AND cs.school_id = ${req.schoolId}
        AND cs.deleted_at IS NULL
      WHERE se.student_id = ${studentId}
        AND se.school_id = ${req.schoolId}
        AND se.status = 'active'
        AND se.deleted_at IS NULL
      LIMIT 1
    `;

    if (!enrollment) {
      return sendSuccess(res, req.schoolId, { student, results: [] });
    }

    results = await sql`
      SELECT 
        e.id as exam_id, e.name as exam_name, e.name_te as exam_name_te, e.exam_type,
        COALESCE(
          json_agg(json_build_object(
            'subject', sub.name,
            'marks_obtained', m.marks_obtained,
            'max_marks', es.max_marks,
            'passing_marks', es.passing_marks,
            'is_absent', COALESCE(m.is_absent, false),
            'remarks', m.remarks,
            'percentage', CASE
              WHEN m.is_absent THEN 0
              ELSE ROUND((m.marks_obtained / es.max_marks) * 100, 2)
            END,
            'passed', CASE
              WHEN m.is_absent THEN false
              ELSE m.marks_obtained >= es.passing_marks
            END
          ) ORDER BY sub.name) FILTER (WHERE m.id IS NOT NULL),
          '[]'::json
        ) as subjects,
        COALESCE(
          SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END)
            FILTER (WHERE m.id IS NOT NULL),
          0
        ) as total_obtained,
        COALESCE(SUM(es.max_marks) FILTER (WHERE m.id IS NOT NULL), 0) as total_max,
        ROUND(
          CAST(
            COALESCE(
              SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END)
                FILTER (WHERE m.id IS NOT NULL),
              0
            ) AS NUMERIC
          )
          / NULLIF(SUM(es.max_marks) FILTER (WHERE m.id IS NOT NULL), 0) * 100,
          2
        ) as percentage
      FROM exams e
      JOIN exam_subjects es ON e.id = es.exam_id
        AND es.class_id = ${enrollment.class_id}
        AND es.school_id = ${req.schoolId}
        AND es.deleted_at IS NULL
      JOIN subjects sub ON es.subject_id = sub.id
      LEFT JOIN marks m ON m.exam_subject_id = es.id
        AND m.student_enrollment_id = ${enrollment.enrollment_id}
        AND m.school_id = ${req.schoolId}
      WHERE e.id = ${exam_id}
        AND e.school_id = ${req.schoolId}
        ${resultVisibility()}
      GROUP BY e.id, e.name, e.exam_type
      ${resultCompleteness()}
    `;
  } else {
    results = await sql`
      SELECT 
        e.id as exam_id, e.name as exam_name, e.name_te as exam_name_te, e.exam_type,
        ay.code as academic_year,
        COUNT(DISTINCT es.subject_id) as subjects_count,
        SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END) as total_obtained,
        SUM(es.max_marks) as total_max,
        ROUND(CAST(SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END) AS NUMERIC) / NULLIF(SUM(es.max_marks), 0) * 100, 2) as percentage
      FROM marks m
      JOIN exam_subjects es ON m.exam_subject_id = es.id
      JOIN exams e ON es.exam_id = e.id
      JOIN academic_years ay ON e.academic_year_id = ay.id
      JOIN student_enrollments se ON m.student_enrollment_id = se.id
      WHERE se.student_id = ${studentId}
        AND e.school_id = ${req.schoolId}
        AND es.school_id = ${req.schoolId}
        AND m.school_id = ${req.schoolId}
        ${resultVisibility()}
        ${academic_year_id ? sql`AND e.academic_year_id = ${academic_year_id}` : sql``}
      GROUP BY e.id, e.name, e.exam_type, ay.code
      ORDER BY e.start_date DESC
    `;
  }

  // Get grade based on percentage (B2: grading_scales may be school-scoped or global; use school_id if column exists)
  const getGrade = async (percentage) => {
    const [grade] = await sql`
      SELECT grade, grade_point FROM grading_scales
      WHERE ${percentage} >= min_percentage AND ${percentage} < max_percentage
      LIMIT 1
    `;
    return grade;
  };

  return sendSuccess(res, req.schoolId, { student, results });
}));

/**
 * GET /results/exam-analytics/context?class_section_id=...
 * Admin-only selector data for class/exam analytics.
 */
router.get('/exam-analytics/context', requirePermission('admin.manage'), asyncHandler(async (req, res) => {
  const requestedClassSectionId = typeof req.query.class_section_id === 'string'
    ? req.query.class_section_id.trim()
    : '';
  if (requestedClassSectionId && !UUID_RE.test(requestedClassSectionId)) {
    return res.status(400).json({ error: 'Invalid class_section_id' });
  }

  const classSections = await sql`
    WITH chosen_year AS (
      SELECT id, code
      FROM academic_years
      WHERE school_id = ${req.schoolId}
        AND deleted_at IS NULL
      ORDER BY
        CASE WHEN CURRENT_DATE BETWEEN start_date AND end_date THEN 0 ELSE 1 END,
        start_date DESC
      LIMIT 1
    )
    SELECT
      class_section.id, class_section.class_id, class_section.academic_year_id,
      class.name AS class_name, section.name AS section_name,
      chosen_year.code AS academic_year,
      COUNT(enrollment.id)::int AS student_count
    FROM class_sections class_section
    JOIN chosen_year ON chosen_year.id = class_section.academic_year_id
    JOIN classes class ON class.id = class_section.class_id
      AND class.school_id = ${req.schoolId}
      AND class.deleted_at IS NULL
    JOIN sections section ON section.id = class_section.section_id
      AND section.school_id = ${req.schoolId}
      AND section.deleted_at IS NULL
    LEFT JOIN student_enrollments enrollment ON enrollment.class_section_id = class_section.id
      AND enrollment.school_id = ${req.schoolId}
      AND enrollment.status = 'active'
      AND enrollment.deleted_at IS NULL
    WHERE class_section.school_id = ${req.schoolId}
      AND class_section.deleted_at IS NULL
    GROUP BY
      class_section.id, class_section.class_id, class_section.academic_year_id,
      class.name, section.name, chosen_year.code, class.sort_order
    ORDER BY class.sort_order NULLS LAST, class.name, section.name
  `;

  if (classSections.length === 0) {
    return sendSuccess(res, req.schoolId, {
      selected_class_section_id: null,
      class_sections: [],
      exams: [],
      students: [],
    });
  }

  const selectedClassSection = requestedClassSectionId
    ? classSections.find((item) => String(item.id) === requestedClassSectionId)
    : classSections[0];
  if (!selectedClassSection) {
    return res.status(404).json({ error: 'Class section not found for the current academic year' });
  }

  const [exams, students] = await Promise.all([
    sql`
      SELECT DISTINCT exam.id, exam.name, exam.exam_type, exam.start_date, exam.end_date,
        exam.results_published
      FROM exams exam
      JOIN exam_subjects paper ON paper.exam_id = exam.id
        AND paper.class_id = ${selectedClassSection.class_id}
        AND paper.school_id = ${req.schoolId}
        AND paper.deleted_at IS NULL
      WHERE exam.school_id = ${req.schoolId}
        AND exam.academic_year_id = ${selectedClassSection.academic_year_id}
        AND exam.deleted_at IS NULL
      ORDER BY exam.start_date DESC NULLS LAST, exam.name
    `,
    sql`
      SELECT
        student.id, student.admission_no, enrollment.roll_number,
        person.display_name, person.photo_url
      FROM student_enrollments enrollment
      JOIN students student ON student.id = enrollment.student_id
        AND student.school_id = ${req.schoolId}
        AND student.status_id = ${ACTIVE_STUDENT_STATUS_ID}
        AND student.deleted_at IS NULL
      JOIN persons person ON person.id = student.person_id
      WHERE enrollment.class_section_id = ${selectedClassSection.id}
        AND enrollment.school_id = ${req.schoolId}
        AND enrollment.status = 'active'
        AND enrollment.deleted_at IS NULL
      ORDER BY enrollment.roll_number NULLS LAST, student.admission_no, person.display_name
    `,
  ]);

  return sendSuccess(res, req.schoolId, {
    selected_class_section_id: selectedClassSection.id,
    class_sections: classSections,
    exams,
    students,
  });
}));

/**
 * GET /results/exam-analytics?class_section_id=...&exam_id=...&student_id=...
 * Highest, lowest and average subject scores with an optional student overlay.
 */
router.get('/exam-analytics', requirePermission('admin.manage'), asyncHandler(async (req, res) => {
  const classSectionId = typeof req.query.class_section_id === 'string'
    ? req.query.class_section_id.trim()
    : '';
  const examId = typeof req.query.exam_id === 'string' ? req.query.exam_id.trim() : '';
  const studentId = typeof req.query.student_id === 'string' ? req.query.student_id.trim() : '';
  if (!UUID_RE.test(classSectionId) || !UUID_RE.test(examId) || (studentId && !UUID_RE.test(studentId))) {
    return res.status(400).json({ error: 'Valid class_section_id and exam_id are required' });
  }

  const [classSection] = await sql`
    SELECT
      class_section.id, class_section.class_id, class_section.academic_year_id,
      class.name AS class_name, section.name AS section_name,
      academic_year.code AS academic_year
    FROM class_sections class_section
    JOIN classes class ON class.id = class_section.class_id AND class.school_id = ${req.schoolId}
    JOIN sections section ON section.id = class_section.section_id AND section.school_id = ${req.schoolId}
    JOIN academic_years academic_year ON academic_year.id = class_section.academic_year_id
      AND academic_year.school_id = ${req.schoolId}
    WHERE class_section.id = ${classSectionId}
      AND class_section.school_id = ${req.schoolId}
      AND class_section.deleted_at IS NULL
    LIMIT 1
  `;
  if (!classSection) return res.status(404).json({ error: 'Class section not found' });

  const [exam] = await sql`
    SELECT id, name, exam_type, start_date, end_date, results_published
    FROM exams
    WHERE id = ${examId}
      AND school_id = ${req.schoolId}
      AND academic_year_id = ${classSection.academic_year_id}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!exam) return res.status(404).json({ error: 'Exam not found for this class year' });

  let selectedStudent = null;
  if (studentId) {
    [selectedStudent] = await sql`
      SELECT
        student.id, student.admission_no, enrollment.roll_number,
        person.display_name, person.photo_url
      FROM student_enrollments enrollment
      JOIN students student ON student.id = enrollment.student_id
        AND student.school_id = ${req.schoolId}
        AND student.status_id = ${ACTIVE_STUDENT_STATUS_ID}
        AND student.deleted_at IS NULL
      JOIN persons person ON person.id = student.person_id
      WHERE student.id = ${studentId}
        AND enrollment.class_section_id = ${classSection.id}
        AND enrollment.school_id = ${req.schoolId}
        AND enrollment.status = 'active'
        AND enrollment.deleted_at IS NULL
      LIMIT 1
    `;
    if (!selectedStudent) return res.status(404).json({ error: 'Student not found in the selected class' });
  }

  const selectedStudentId = selectedStudent?.id || null;
  const rawSubjects = await sql`
    SELECT
      subject.id AS subject_id, subject.name AS subject_name,
      paper.assessment_schema, paper.max_marks,
      COUNT(DISTINCT active_student.id)::int AS total_students,
      COUNT(mark.id) FILTER (
        WHERE mark.is_absent = FALSE AND mark.marks_obtained IS NOT NULL
      )::int AS graded_students,
      MIN(mark.marks_obtained) FILTER (
        WHERE mark.is_absent = FALSE AND mark.marks_obtained IS NOT NULL
      ) AS lowest_score,
      MAX(mark.marks_obtained) FILTER (
        WHERE mark.is_absent = FALSE AND mark.marks_obtained IS NOT NULL
      ) AS highest_score,
      ROUND((AVG(mark.marks_obtained) FILTER (
        WHERE mark.is_absent = FALSE AND mark.marks_obtained IS NOT NULL
      ))::numeric, 2) AS average_score,
      MAX(mark.marks_obtained) FILTER (
        WHERE enrollment.student_id = ${selectedStudentId} AND mark.is_absent = FALSE
      ) AS student_score,
      COALESCE(BOOL_OR(
        enrollment.student_id = ${selectedStudentId} AND mark.is_absent = TRUE
      ), FALSE) AS student_absent
    FROM exam_subjects paper
    JOIN subjects subject ON subject.id = paper.subject_id
      AND subject.school_id = ${req.schoolId}
      AND subject.deleted_at IS NULL
    LEFT JOIN student_enrollments enrollment ON enrollment.class_section_id = ${classSection.id}
      AND enrollment.school_id = ${req.schoolId}
      AND enrollment.status = 'active'
      AND enrollment.deleted_at IS NULL
    LEFT JOIN students active_student ON active_student.id = enrollment.student_id
      AND active_student.school_id = ${req.schoolId}
      AND active_student.status_id = ${ACTIVE_STUDENT_STATUS_ID}
      AND active_student.deleted_at IS NULL
    LEFT JOIN marks mark ON mark.exam_subject_id = paper.id
      AND mark.student_enrollment_id = enrollment.id
      AND mark.school_id = ${req.schoolId}
      AND active_student.id IS NOT NULL
    WHERE paper.exam_id = ${exam.id}
      AND paper.class_id = ${classSection.class_id}
      AND paper.school_id = ${req.schoolId}
      AND paper.deleted_at IS NULL
    GROUP BY subject.id, subject.name, paper.assessment_schema, paper.max_marks
    ORDER BY subject.name
  `;

  const numberOrNull = (value) => value == null ? null : Number(value);
  const subjects = rawSubjects.map((subject) => {
    const maximum = Number(subject.max_marks || 0);
    const lowestScore = numberOrNull(subject.lowest_score);
    const highestScore = numberOrNull(subject.highest_score);
    const averageScore = numberOrNull(subject.average_score);
    const studentScore = numberOrNull(subject.student_score);
    const toPercentage = (score) => score == null || maximum <= 0
      ? null
      : Number(((score / maximum) * 100).toFixed(2));
    return {
      ...subject,
      max_marks: maximum,
      total_students: Number(subject.total_students || 0),
      graded_students: Number(subject.graded_students || 0),
      lowest_score: lowestScore,
      highest_score: highestScore,
      average_score: averageScore,
      student_score: studentScore,
      lowest_percentage: toPercentage(lowestScore),
      highest_percentage: toPercentage(highestScore),
      average_percentage: toPercentage(averageScore),
      student_percentage: toPercentage(studentScore),
      student_status: !selectedStudent
        ? null
        : subject.student_absent
          ? 'absent'
          : studentScore == null
            ? 'missing'
            : 'graded',
    };
  });

  const totalPossibleEntries = subjects.reduce(
    (total, subject) => total + subject.total_students,
    0,
  );
  const totalGradedEntries = subjects.reduce(
    (total, subject) => total + subject.graded_students,
    0,
  );
  const subjectsWithAverages = subjects.filter((subject) => subject.average_percentage != null);
  const strongestSubject = [...subjectsWithAverages]
    .sort((a, b) => b.average_percentage - a.average_percentage)[0] || null;
  const focusSubject = [...subjectsWithAverages]
    .sort((a, b) => a.average_percentage - b.average_percentage)[0] || null;
  const selectedStudentSubjects = subjects.filter((subject) => subject.student_percentage != null);
  const studentAveragePercentage = selectedStudentSubjects.length
    ? Number((selectedStudentSubjects.reduce(
      (total, subject) => total + subject.student_percentage,
      0,
    ) / selectedStudentSubjects.length).toFixed(2))
    : null;

  return sendSuccess(res, req.schoolId, {
    class_section: classSection,
    exam,
    selected_student: selectedStudent,
    subjects,
    summary: {
      subject_count: subjects.length,
      student_count: subjects[0]?.total_students || 0,
      graded_entries: totalGradedEntries,
      possible_entries: totalPossibleEntries,
      completion_percentage: totalPossibleEntries > 0
        ? Number(((totalGradedEntries / totalPossibleEntries) * 100).toFixed(2))
        : 0,
      strongest_subject: strongestSubject?.subject_name || null,
      focus_subject: focusSubject?.subject_name || null,
      student_average_percentage: studentAveragePercentage,
      student_above_class_average: selectedStudent
        ? subjects.filter((subject) =>
          subject.student_percentage != null
          && subject.average_percentage != null
          && subject.student_percentage >= subject.average_percentage
        ).length
        : null,
    },
  });
}));

/**
 * GET /results/progress-card-assistant/context
 * Class-teacher-only roster and exam context for physical progress-card work.
 */
router.get('/progress-card-assistant/context', requireAnyPermission(['results.view', 'marks.view']), asyncHandler(async (req, res) => {
  const context = await resolveProgressCardClassTeacher(req, res);
  if (!context) return;
  const { classSection } = context;
  const rankingMethod = await getSchoolRankingMethod(req.schoolId);

  if (!classSection) {
    return sendSuccess(res, req.schoolId, {
      class_section: null,
      students: [],
      exams: [],
      ranking_method: rankingMethod,
    });
  }

  const [students, exams] = await Promise.all([
    sql`
      SELECT
        student.id, student.admission_no, enrollment.roll_number,
        person.display_name, person.photo_url
      FROM student_enrollments enrollment
      JOIN students student ON student.id = enrollment.student_id
        AND student.school_id = ${req.schoolId}
        AND student.deleted_at IS NULL
        AND student.status_id = ${ACTIVE_STUDENT_STATUS_ID}
      JOIN persons person ON person.id = student.person_id
      WHERE enrollment.class_section_id = ${classSection.id}
        AND enrollment.school_id = ${req.schoolId}
        AND enrollment.status = 'active'
        AND enrollment.deleted_at IS NULL
      ORDER BY enrollment.roll_number NULLS LAST, student.admission_no, person.display_name
    `,
    sql`
      SELECT DISTINCT exam.id, exam.name, exam.exam_type, exam.start_date, exam.end_date,
        exam.results_published
      FROM exams exam
      JOIN exam_subjects paper ON paper.exam_id = exam.id
        AND paper.class_id = ${classSection.class_id}
        AND paper.school_id = ${req.schoolId}
        AND paper.deleted_at IS NULL
      WHERE exam.school_id = ${req.schoolId}
        AND exam.academic_year_id = ${classSection.academic_year_id}
        AND exam.deleted_at IS NULL
      ORDER BY exam.start_date DESC NULLS LAST, exam.name DESC
    `,
  ]);

  return sendSuccess(res, req.schoolId, {
    class_section: {
      id: classSection.id,
      class_name: classSection.class_name,
      section_name: classSection.section_name,
      academic_year: classSection.academic_year,
    },
    students,
    exams,
    ranking_method: rankingMethod,
  });
}));

/**
 * GET /results/progress-card-assistant/student/:studentId?exam_id=...
 * Full subject-detail worksheet for one student in the class teacher's class.
 */
router.get('/progress-card-assistant/student/:studentId', requireAnyPermission(['results.view', 'marks.view']), asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const examId = typeof req.query.exam_id === 'string' ? req.query.exam_id.trim() : '';
  if (!UUID_RE.test(studentId) || !UUID_RE.test(examId)) {
    return res.status(400).json({ error: 'Valid studentId and exam_id are required' });
  }

  const context = await resolveProgressCardClassTeacher(req, res);
  if (!context) return;
  const { classSection } = context;
  if (!classSection) {
    return res.status(403).json({ error: 'Only the assigned class teacher can use this assistant' });
  }

  const [student] = await sql`
    SELECT
      student.id, student.admission_no, enrollment.id AS enrollment_id,
      enrollment.roll_number, person.display_name, person.photo_url
    FROM student_enrollments enrollment
    JOIN students student ON student.id = enrollment.student_id
      AND student.school_id = ${req.schoolId}
      AND student.deleted_at IS NULL
      AND student.status_id = ${ACTIVE_STUDENT_STATUS_ID}
    JOIN persons person ON person.id = student.person_id
    WHERE student.id = ${studentId}
      AND enrollment.class_section_id = ${classSection.id}
      AND enrollment.school_id = ${req.schoolId}
      AND enrollment.status = 'active'
      AND enrollment.deleted_at IS NULL
    LIMIT 1
  `;
  if (!student) return res.status(404).json({ error: 'Student not found in your class' });

  const [exam] = await sql`
    SELECT id, name, exam_type, start_date, end_date, results_published
    FROM exams
    WHERE id = ${examId}
      AND school_id = ${req.schoolId}
      AND academic_year_id = ${classSection.academic_year_id}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!exam) return res.status(404).json({ error: 'Exam not found for this academic year' });

  const rawSubjects = await sql`
    SELECT
      subject.id AS subject_id, subject.name AS subject_name,
      paper.assessment_schema, paper.max_marks, paper.consolidated_max_marks,
      paper.participation_max_marks, paper.written_work_max_marks,
      paper.project_work_max_marks, paper.slip_test_max_marks,
      mark.id AS mark_id, mark.marks_obtained, mark.consolidated_marks_obtained,
      mark.participation_marks, mark.written_work_marks,
      mark.project_work_marks, mark.slip_test_marks, mark.is_absent
    FROM exam_subjects paper
    JOIN subjects subject ON subject.id = paper.subject_id AND subject.school_id = ${req.schoolId}
    LEFT JOIN marks mark ON mark.exam_subject_id = paper.id
      AND mark.student_enrollment_id = ${student.enrollment_id}
      AND mark.school_id = ${req.schoolId}
    WHERE paper.exam_id = ${exam.id}
      AND paper.class_id = ${classSection.class_id}
      AND paper.school_id = ${req.schoolId}
      AND paper.deleted_at IS NULL
    ORDER BY subject.name
  `;

  const numberOrNull = (value) => value == null ? null : Number(value);
  const enteredRawSubjects = filterEnteredProgressReportSubjects(rawSubjects);
  const subjects = enteredRawSubjects.map((subject) => {
    const componentTotal = [
      subject.participation_marks,
      subject.written_work_marks,
      subject.project_work_marks,
      subject.slip_test_marks,
    ].reduce((total, value) => total + Number(value || 0), 0);
    const obtained = numberOrNull(subject.marks_obtained);
    const maximum = Number(subject.max_marks || 0);
    const componentMaximums = componentMaximumsFromRow(subject);
    return {
      ...subject,
      max_marks: maximum,
      marks_obtained: obtained,
      consolidated_max_marks: Number(subject.consolidated_max_marks || 25),
      consolidated_marks_obtained: numberOrNull(subject.consolidated_marks_obtained),
      participation_marks: numberOrNull(subject.participation_marks),
      written_work_marks: numberOrNull(subject.written_work_marks),
      project_work_marks: numberOrNull(subject.project_work_marks),
      slip_test_marks: numberOrNull(subject.slip_test_marks),
      component_maximums: componentMaximums,
      component_total: subject.mark_id ? componentTotal : null,
      weightage_20: subject.mark_id && subject.assessment_schema === 'component'
        ? componentWeightage20(componentTotal, componentMaximums)
        : null,
      percentage: subject.mark_id && maximum > 0
        ? Number(((Number(obtained || 0) / maximum) * 100).toFixed(2))
        : null,
      entry_status: subject.is_absent ? 'absent' : subject.mark_id ? 'complete' : 'missing',
    };
  });

  const cohort = await sql`
    SELECT
      enrolled_student.id AS student_id, enrolled_student.admission_no,
      COALESCE(
        SUM(CASE WHEN mark.is_absent THEN 0 ELSE mark.marks_obtained END)
          FILTER (WHERE mark.id IS NOT NULL),
        0
      ) AS total_obtained,
      COALESCE(SUM(paper.max_marks) FILTER (WHERE mark.id IS NOT NULL), 0) AS total_max,
      ROUND(
        COALESCE(
          SUM(CASE WHEN mark.is_absent THEN 0 ELSE mark.marks_obtained END)
            FILTER (WHERE mark.id IS NOT NULL),
          0
        )::numeric
        / NULLIF(SUM(paper.max_marks) FILTER (WHERE mark.id IS NOT NULL), 0) * 100,
        2
      ) AS percentage
    FROM student_enrollments enrollment
    JOIN students enrolled_student ON enrolled_student.id = enrollment.student_id
      AND enrolled_student.school_id = ${req.schoolId}
      AND enrolled_student.deleted_at IS NULL
      AND enrolled_student.status_id = ${ACTIVE_STUDENT_STATUS_ID}
    CROSS JOIN exam_subjects paper
    LEFT JOIN marks mark ON mark.exam_subject_id = paper.id
      AND mark.student_enrollment_id = enrollment.id
      AND mark.school_id = ${req.schoolId}
    WHERE enrollment.class_section_id = ${classSection.id}
      AND enrollment.school_id = ${req.schoolId}
      AND enrollment.status = 'active'
      AND enrollment.deleted_at IS NULL
      AND paper.exam_id = ${exam.id}
      AND paper.class_id = ${classSection.class_id}
      AND paper.school_id = ${req.schoolId}
      AND paper.deleted_at IS NULL
    GROUP BY enrolled_student.id, enrolled_student.admission_no
  `;

  const attendanceRows = await sql`
    SELECT
      enrollment.student_id,
      COUNT(daily.id)::int AS working_days,
      COALESCE(SUM(CASE
        WHEN daily.status IN ('present', 'late') THEN 1
        WHEN daily.status = 'half_day' THEN 0.5
        ELSE 0
      END), 0)::float AS days_present,
      ROUND(
        100 * COALESCE(SUM(CASE
          WHEN daily.status IN ('present', 'late') THEN 1
          WHEN daily.status = 'half_day' THEN 0.5
          ELSE 0
        END), 0)::numeric / NULLIF(COUNT(daily.id), 0),
        2
      ) AS attendance_percentage
    FROM student_enrollments enrollment
    JOIN academic_years year ON year.id = enrollment.academic_year_id
      AND year.id = ${classSection.academic_year_id}
      AND year.school_id = ${req.schoolId}
      AND year.deleted_at IS NULL
    LEFT JOIN daily_attendance daily ON daily.student_enrollment_id = enrollment.id
      AND daily.school_id = ${req.schoolId}
      AND daily.attendance_date BETWEEN year.start_date AND year.end_date
      AND daily.deleted_at IS NULL
    WHERE enrollment.class_section_id = ${classSection.id}
      AND enrollment.school_id = ${req.schoolId}
      AND enrollment.status = 'active'
    GROUP BY enrollment.student_id
  `;
  const monthlyAttendanceRows = await sql`
    SELECT
      TO_CHAR(DATE_TRUNC('month', daily.attendance_date), 'YYYY-MM') AS month,
      TO_CHAR(DATE_TRUNC('month', daily.attendance_date), 'FMMonth YYYY') AS month_label,
      COUNT(daily.id)::int AS working_days,
      COALESCE(SUM(CASE
        WHEN daily.status IN ('present', 'late') THEN 1
        WHEN daily.status = 'half_day' THEN 0.5
        ELSE 0
      END), 0)::float AS days_present,
      ROUND(
        100 * COALESCE(SUM(CASE
          WHEN daily.status IN ('present', 'late') THEN 1
          WHEN daily.status = 'half_day' THEN 0.5
          ELSE 0
        END), 0)::numeric / NULLIF(COUNT(daily.id), 0),
        2
      ) AS percentage
    FROM daily_attendance daily
    JOIN academic_years year ON year.id = ${classSection.academic_year_id}
      AND year.school_id = ${req.schoolId}
      AND year.deleted_at IS NULL
    WHERE daily.student_enrollment_id = ${student.enrollment_id}
      AND daily.school_id = ${req.schoolId}
      AND daily.attendance_date BETWEEN year.start_date AND year.end_date
      AND daily.deleted_at IS NULL
    GROUP BY DATE_TRUNC('month', daily.attendance_date)
    ORDER BY DATE_TRUNC('month', daily.attendance_date)
  `;
  const attendanceByStudent = new Map(attendanceRows.map((row) => [String(row.student_id), row]));
  const rankingMethod = await getSchoolRankingMethod(req.schoolId);
  const rankedCohort = rankResultRows(cohort.map((row) => ({
    ...row,
    attendance_percentage: attendanceByStudent.get(String(row.student_id))?.attendance_percentage ?? null,
  })), rankingMethod);
  const rankedStudent = rankedCohort.find((row) => String(row.student_id) === String(student.id));
  const attendance = attendanceByStudent.get(String(student.id)) || {
    working_days: 0,
    days_present: 0,
    attendance_percentage: null,
  };

  const totalObtained = subjects.reduce((total, subject) => total + Number(subject.marks_obtained || 0), 0);
  const totalMax = subjects.reduce((total, subject) => total + Number(subject.max_marks || 0), 0);
  const percentage = totalMax > 0 ? Number(((totalObtained / totalMax) * 100).toFixed(2)) : 0;

  return sendSuccess(res, req.schoolId, {
    class_section: {
      id: classSection.id,
      class_name: classSection.class_name,
      section_name: classSection.section_name,
      academic_year: classSection.academic_year,
    },
    student,
    exam,
    subjects,
    summary: {
      total_obtained: totalObtained,
      total_max: totalMax,
      percentage,
      rank: rankedStudent?.rank ?? null,
      subject_count: rawSubjects.length,
      completed_subjects: subjects.length,
      missing_subjects: rawSubjects.length - subjects.length,
      ranking_method: rankingMethod,
    },
    attendance: {
      working_days: Number(attendance.working_days || 0),
      days_present: Number(attendance.days_present || 0),
      percentage: numberOrNull(attendance.attendance_percentage),
      monthly: monthlyAttendanceRows.map((month) => ({
        month: month.month,
        month_label: month.month_label,
        working_days: Number(month.working_days || 0),
        days_present: Number(month.days_present || 0),
        percentage: numberOrNull(month.percentage),
      })),
    },
  });
}));

/**
 * GET /results/progress-card-assistant/student/:studentId/final-calculations
 * Derived Summative-I, Summative-II and Annual results from FA-1…FA-4 + SA-1…SA-2.
 */
router.get('/progress-card-assistant/student/:studentId/final-calculations', requireAnyPermission(['results.view', 'marks.view']), asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  if (!UUID_RE.test(studentId)) return res.status(400).json({ error: 'Invalid studentId' });

  const context = await resolveProgressCardClassTeacher(req, res);
  if (!context) return;
  const { classSection } = context;
  if (!classSection) {
    return res.status(403).json({ error: 'Only the assigned class teacher can use this assistant' });
  }

  const rows = await sql`
    SELECT
      student.id AS student_id, student.admission_no, enrollment.roll_number,
      person.display_name, person.photo_url,
      subject.id AS subject_id, subject.name AS subject_name,
      exam.id AS exam_id, exam.name AS exam_name, exam.exam_type,
      exam.start_date, paper.max_marks,
      mark.id AS mark_id, mark.marks_obtained, mark.is_absent
    FROM student_enrollments enrollment
    JOIN students student ON student.id = enrollment.student_id
      AND student.school_id = ${req.schoolId}
      AND student.status_id = ${ACTIVE_STUDENT_STATUS_ID}
      AND student.deleted_at IS NULL
    JOIN persons person ON person.id = student.person_id
    JOIN exams exam ON exam.school_id = ${req.schoolId}
      AND exam.academic_year_id = ${classSection.academic_year_id}
      AND exam.exam_type IN ('fa_results', 'sa_results')
      AND exam.deleted_at IS NULL
    JOIN exam_subjects paper ON paper.exam_id = exam.id
      AND paper.class_id = ${classSection.class_id}
      AND paper.school_id = ${req.schoolId}
      AND paper.deleted_at IS NULL
    JOIN subjects subject ON subject.id = paper.subject_id
      AND subject.school_id = ${req.schoolId}
      AND subject.deleted_at IS NULL
    LEFT JOIN marks mark ON mark.exam_subject_id = paper.id
      AND mark.student_enrollment_id = enrollment.id
      AND mark.school_id = ${req.schoolId}
    WHERE enrollment.class_section_id = ${classSection.id}
      AND enrollment.school_id = ${req.schoolId}
      AND enrollment.status = 'active'
      AND enrollment.deleted_at IS NULL
    ORDER BY exam.start_date DESC NULLS LAST, exam.created_at DESC, subject.name
  `;

  const studentMap = new Map();
  for (const row of rows) {
    const sourceKey = canonicalFinalSourceKey(row.exam_type, row.exam_name);
    if (!sourceKey) continue;
    const studentKey = String(row.student_id);
    if (!studentMap.has(studentKey)) {
      studentMap.set(studentKey, {
        student: {
          id: row.student_id,
          admission_no: row.admission_no,
          roll_number: row.roll_number,
          display_name: row.display_name,
          photo_url: row.photo_url,
        },
        subjects: new Map(),
      });
    }
    const studentEntry = studentMap.get(studentKey);
    const subjectKey = String(row.subject_id);
    if (!studentEntry.subjects.has(subjectKey)) {
      studentEntry.subjects.set(subjectKey, {
        subject_id: row.subject_id,
        subject_name: row.subject_name,
        sources: {},
      });
    }
    const subjectEntry = studentEntry.subjects.get(subjectKey);
    // Rows are newest first. Keep the latest configured exam for each canonical source.
    if (!(sourceKey in subjectEntry.sources)) {
      subjectEntry.sources[sourceKey] = !row.mark_id || (row.marks_obtained == null && !row.is_absent)
        ? { status: 'missing', score: null, maximum: Number(row.max_marks || 0) }
        : row.is_absent
          ? { status: 'absent', score: 0, maximum: Number(row.max_marks || 0) }
          : {
            status: 'graded',
            score: Number(row.marks_obtained),
            maximum: Number(row.max_marks || 0),
          };
    }
  }

  const selectedEntry = studentMap.get(String(studentId));
  if (!selectedEntry) return res.status(404).json({ error: 'Student or formative/summative papers not found in your class' });

  const calculateStudentSubjects = (entry) => [...entry.subjects.values()]
    .map((subject) => {
      const calculated = calculateFinalSubjectResult(subject.sources);
      const sourceMarks = Object.fromEntries(
        ['fa1', 'fa2', 'fa3', 'fa4', 'sa1', 'sa2'].map((key) => {
          const source = subject.sources[key] || { status: 'missing', score: null, maximum: null };
          return [key, {
            ...source,
            contribution: key.startsWith('fa')
              ? weightedContribution(source, 20)
              : weightedContribution(source, 80),
          }];
        }),
      );
      return { ...subject, sources: sourceMarks, ...calculated };
    })
    .sort((a, b) => a.subject_name.localeCompare(b.subject_name));

  const calculatedCohort = [...studentMap.values()].map((entry) => {
    const subjects = calculateStudentSubjects(entry);
    return {
      ...entry.student,
      subjects,
      summaries: {
        summative_1: summarizeCalculatedSubjects(subjects, 'summative_1'),
        summative_2: summarizeCalculatedSubjects(subjects, 'summative_2'),
        annual: summarizeCalculatedSubjects(subjects, 'annual'),
      },
    };
  });

  const attendanceRows = await sql`
    SELECT
      enrollment.student_id,
      ROUND(
        100 * COALESCE(SUM(CASE
          WHEN attendance.status IN ('present', 'late') THEN 1
          WHEN attendance.status = 'half_day' THEN 0.5
          ELSE 0
        END), 0)::numeric / NULLIF(COUNT(attendance.id), 0),
        2
      ) AS attendance_percentage
    FROM student_enrollments enrollment
    LEFT JOIN daily_attendance attendance ON attendance.student_enrollment_id = enrollment.id
      AND attendance.school_id = ${req.schoolId}
      AND attendance.deleted_at IS NULL
    WHERE enrollment.class_section_id = ${classSection.id}
      AND enrollment.school_id = ${req.schoolId}
      AND enrollment.status = 'active'
      AND enrollment.deleted_at IS NULL
    GROUP BY enrollment.student_id
  `;
  const attendanceByStudent = new Map(
    attendanceRows.map((row) => [String(row.student_id), row.attendance_percentage]),
  );
  const rankingMethod = await getSchoolRankingMethod(req.schoolId);
  const periods = ['summative_1', 'summative_2', 'annual'];
  const ranksByPeriod = Object.fromEntries(periods.map((period) => {
    const rankable = calculatedCohort.flatMap((entry) => {
      const summary = entry.summaries[period];
      if (summary.status !== 'complete' || summary.percentage == null) return [];
      return [{
        student_id: entry.id,
        admission_no: entry.admission_no,
        percentage: summary.percentage,
        attendance_percentage: attendanceByStudent.get(String(entry.id)) ?? null,
      }];
    });
    return [period, new Map(
      rankResultRows(rankable, rankingMethod).map((entry) => [String(entry.student_id), entry.rank]),
    )];
  }));

  const selectedCalculated = calculatedCohort.find((entry) => String(entry.id) === String(studentId));
  for (const period of periods) {
    selectedCalculated.summaries[period].rank = ranksByPeriod[period].get(String(studentId)) ?? null;
  }

  return sendSuccess(res, req.schoolId, {
    class_section: {
      id: classSection.id,
      class_name: classSection.class_name,
      section_name: classSection.section_name,
      academic_year: classSection.academic_year,
    },
    student: selectedCalculated,
    ranking_method: rankingMethod,
    formulas: {
      summative_1: 'average(FA-1, FA-2) /20 + SA-1 exam /80',
      summative_2: 'average(FA-3, FA-4) /20 + SA-2 exam /80',
      annual: 'average(FA-1…FA-4) /20 + average(SA-1, SA-2) /80',
    },
  });
}));

/**
 * GET /results/generate
 * Generate progress report data for a class/exam
 */
router.get('/generate', requirePermission('results.generate'), asyncHandler(async (req, res) => {
  const { exam_id, class_section_id } = req.query;

  if (!exam_id || !class_section_id) {
    return res.status(400).json({ error: 'exam_id and class_section_id are required' });
  }

  // RES6 FIX: Add school_id filter to exam and class section lookups
  const [exam] = await sql`SELECT name, exam_type FROM exams WHERE id = ${exam_id} AND school_id = ${req.schoolId}`;
  const [classSection] = await sql`
    SELECT cs.class_id, c.name as class_name, s.name as section_name
    FROM class_sections cs
    JOIN classes c ON cs.class_id = c.id
    JOIN sections s ON cs.section_id = s.id
    WHERE cs.id = ${class_section_id}
      AND cs.school_id = ${req.schoolId}
      AND c.school_id = ${req.schoolId}
      AND s.school_id = ${req.schoolId}
  `;
  if (!exam || !classSection) {
    return res.status(404).json({ error: 'Exam or class section not found' });
  }

  // Get all students with their results
  const results = await sql`
    SELECT 
      st.id as student_id, st.admission_no,
      p.display_name as student_name,
      COALESCE(
        json_agg(json_build_object(
          'subject', sub.name,
          'marks_obtained', m.marks_obtained,
          'is_absent', m.is_absent,
          'remarks', m.remarks,
          'max_marks', es.max_marks
        ) ORDER BY sub.name) FILTER (WHERE m.id IS NOT NULL),
        '[]'::json
      ) as subjects,
      COALESCE(
        SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END)
          FILTER (WHERE m.id IS NOT NULL),
        0
      ) as total_obtained,
      COALESCE(SUM(es.max_marks) FILTER (WHERE m.id IS NOT NULL), 0) as total_max,
      ROUND(
        COALESCE(
          SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END)
            FILTER (WHERE m.id IS NOT NULL),
          0
        )::numeric
        / NULLIF(SUM(es.max_marks) FILTER (WHERE m.id IS NOT NULL), 0) * 100,
        2
      ) as percentage
    FROM student_enrollments se
    JOIN students st ON se.student_id = st.id
    JOIN persons p ON st.person_id = p.id
    LEFT JOIN exam_subjects es ON es.exam_id = ${exam_id}
      AND es.class_id = ${classSection?.class_id}
      AND es.school_id = ${req.schoolId}
      AND es.deleted_at IS NULL
    LEFT JOIN subjects sub ON es.subject_id = sub.id
    LEFT JOIN marks m ON m.student_enrollment_id = se.id
      AND m.exam_subject_id = es.id
      AND m.school_id = ${req.schoolId}
    WHERE se.class_section_id = ${class_section_id}
      AND se.school_id = ${req.schoolId}
      AND se.status = 'active'
      AND st.deleted_at IS NULL
      AND st.status_id = ${ACTIVE_STUDENT_STATUS_ID}
      AND st.school_id = ${req.schoolId}
    GROUP BY st.id, st.admission_no, p.display_name
  `;

  const attendanceRows = await sql`
    SELECT
      se.student_id,
      ROUND(
        (
          COUNT(da.id) FILTER (WHERE da.status IN ('present', 'late'))
          + 0.5 * COUNT(da.id) FILTER (WHERE da.status = 'half_day')
        )::numeric / NULLIF(COUNT(da.id), 0) * 100,
        2
      ) AS attendance_percentage
    FROM student_enrollments se
    LEFT JOIN daily_attendance da
      ON da.student_enrollment_id = se.id
     AND da.school_id = ${req.schoolId}
     AND da.deleted_at IS NULL
    WHERE se.class_section_id = ${class_section_id}
      AND se.school_id = ${req.schoolId}
      AND se.status = 'active'
    GROUP BY se.student_id
  `;
  const attendanceByStudent = new Map(
    attendanceRows.map((row) => [String(row.student_id), row.attendance_percentage]),
  );
  const [rankingSetting] = await sql`
    SELECT value
    FROM school_settings
    WHERE school_id = ${req.schoolId} AND key = 'result_ranking_method'
    LIMIT 1
  `;
  const rankingMethod = normalizeResultRankingMethod(rankingSetting?.value);
  const rankedResults = rankResultRows(
    results.map((result) => ({
      ...result,
      attendance_percentage: attendanceByStudent.get(String(result.student_id)) ?? null,
    })),
    rankingMethod,
  );

  return sendSuccess(res, req.schoolId, {
    exam: exam?.name,
    exam_type: exam?.exam_type,
    class: classSection?.class_name,
    section: classSection?.section_name,
    ranking_method: rankingMethod,
    total_students: rankedResults.length,
    results: rankedResults
  });
}));

/**
 * GET /results/summary/student/:studentId
 * Get summary of exam results for a student, grouped by exam type
 * Used for the main Results screen cards
 */
router.get('/summary/student/:studentId', requirePermission('results.view'), asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { academic_year_id } = req.query;
  const resultVisibility = () => canPreviewUnpublishedResults(req)
    ? sql``
    : familyResultVisibility();

  // Query to get counts and latest info for each exam type
  // Only includes exams where the student has at least one mark entry
  const summary = await sql`
    SELECT 
      e.exam_type,
      COUNT(DISTINCT e.id) as exam_count,
      MAX(e.start_date) as last_exam_date
    FROM marks m
    JOIN exam_subjects es ON m.exam_subject_id = es.id
    JOIN exams e ON es.exam_id = e.id
    JOIN student_enrollments se ON m.student_enrollment_id = se.id
    WHERE se.student_id = ${studentId}
      AND e.school_id = ${req.schoolId}
      AND es.school_id = ${req.schoolId}
      AND m.school_id = ${req.schoolId}
      ${resultVisibility()}
      ${academic_year_id ? sql`AND e.academic_year_id = ${academic_year_id}` : sql``}
    GROUP BY e.exam_type
    ORDER BY MAX(e.start_date) DESC
  `;

  return sendSuccess(res, req.schoolId, summary);
}));

/**
 * GET /results/list/student/:studentId
 * Get list of exams for a specific type
 */
router.get('/list/student/:studentId', requirePermission('results.view'), asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { exam_type, academic_year_id, page, limit } = req.query;

  if (!exam_type) {
    return res.status(400).json({ error: 'exam_type is required' });
  }

  const usePaging = page !== undefined || limit !== undefined;
  const lim = Math.min(parseInt(limit, 10) || 15, 50);
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (pg - 1) * lim;
  const resultVisibility = () => canPreviewUnpublishedResults(req)
    ? sql``
    : familyResultVisibility();

  const exams = usePaging
    ? await sql`
    SELECT 
      e.id, e.name, e.name_te, e.exam_type, e.start_date, e.end_date, e.status,
      ay.code as academic_year,
      COUNT(DISTINCT es.subject_id) as subjects_count,
      SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END) as total_obtained,
      SUM(es.max_marks) as total_max,
      ROUND(CAST(SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END) AS NUMERIC) / NULLIF(SUM(es.max_marks), 0) * 100, 2) as percentage
    FROM marks m
    JOIN exam_subjects es ON m.exam_subject_id = es.id
    JOIN exams e ON es.exam_id = e.id
    JOIN academic_years ay ON e.academic_year_id = ay.id
    JOIN student_enrollments se ON m.student_enrollment_id = se.id
    WHERE se.student_id = ${studentId}
      AND e.exam_type = ${exam_type}
      AND e.school_id = ${req.schoolId}
      AND es.school_id = ${req.schoolId}
      AND m.school_id = ${req.schoolId}
      ${resultVisibility()}
      ${academic_year_id ? sql`AND e.academic_year_id = ${academic_year_id}` : sql``}
    GROUP BY e.id, e.name, e.exam_type, e.start_date, e.end_date, e.status, ay.code
    ORDER BY e.start_date DESC
    LIMIT ${lim} OFFSET ${offset}
  `
    : await sql`
    SELECT 
      e.id, e.name, e.name_te, e.exam_type, e.start_date, e.end_date, e.status,
      ay.code as academic_year,
      COUNT(DISTINCT es.subject_id) as subjects_count,
      SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END) as total_obtained,
      SUM(es.max_marks) as total_max,
      ROUND(CAST(SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END) AS NUMERIC) / NULLIF(SUM(es.max_marks), 0) * 100, 2) as percentage
    FROM marks m
    JOIN exam_subjects es ON m.exam_subject_id = es.id
    JOIN exams e ON es.exam_id = e.id
    JOIN academic_years ay ON e.academic_year_id = ay.id
    JOIN student_enrollments se ON m.student_enrollment_id = se.id
    WHERE se.student_id = ${studentId}
      AND e.exam_type = ${exam_type}
      AND e.school_id = ${req.schoolId}
      AND es.school_id = ${req.schoolId}
      AND m.school_id = ${req.schoolId}
      ${resultVisibility()}
      ${academic_year_id ? sql`AND e.academic_year_id = ${academic_year_id}` : sql``}
    GROUP BY e.id, e.name, e.exam_type, e.start_date, e.end_date, e.status, ay.code
    ORDER BY e.start_date DESC
  `;

  if (usePaging) {
    const [countRow] = await sql`
      SELECT count(DISTINCT e.id)::int as total
      FROM marks m
      JOIN exam_subjects es ON m.exam_subject_id = es.id
      JOIN exams e ON es.exam_id = e.id
      JOIN student_enrollments se ON m.student_enrollment_id = se.id
      WHERE se.student_id = ${studentId}
        AND e.exam_type = ${exam_type}
        AND e.school_id = ${req.schoolId}
        AND es.school_id = ${req.schoolId}
        AND m.school_id = ${req.schoolId}
        ${resultVisibility()}
        ${academic_year_id ? sql`AND e.academic_year_id = ${academic_year_id}` : sql``}
    `;
    return sendSuccess(res, req.schoolId, {
      records: exams,
      meta: {
        total: countRow.total,
        page: pg,
        limit: lim,
        total_pages: Math.ceil(countRow.total / lim) || 1,
      },
    });
  }

  return sendSuccess(res, req.schoolId, exams);
}));

/**
 * GET /results/marks
 * Fetch existing marks for a specific exam/subject/class
 * Used to pre-fill the marks entry form
 */
router.get('/marks', requirePermission('marks.view'), asyncHandler(async (req, res) => {
  const { class_section_id, exam_category, sub_exam, subject_id } = req.query;

  if (!class_section_id || !exam_category || !sub_exam || !subject_id) {
    return res.status(400).json({
      error: 'Missing required query params: class_section_id, exam_category, sub_exam, subject_id'
    });
  }

  // 1. Resolve Class Section info (B2: school_id scoped)
  const [classSection] = await sql`
    SELECT cs.class_id, cs.academic_year_id 
    FROM class_sections cs 
    WHERE cs.id = ${class_section_id} AND cs.school_id = ${req.schoolId}
  `;

  if (!classSection) {
    return res.status(404).json({ error: 'Class section not found' });
  }

  const { class_id, academic_year_id } = classSection;

  const attendance = await sql`
    SELECT
      se.student_id,
      ROUND(
        (
          COUNT(da.id) FILTER (WHERE da.status IN ('present', 'late'))
          + 0.5 * COUNT(da.id) FILTER (WHERE da.status = 'half_day')
        )::numeric / NULLIF(COUNT(da.id), 0) * 100,
        2
      ) AS attendance_percentage
    FROM student_enrollments se
    JOIN students st ON st.id = se.student_id
      AND st.school_id = ${req.schoolId}
      AND st.deleted_at IS NULL
      AND st.status_id = ${ACTIVE_STUDENT_STATUS_ID}
    LEFT JOIN daily_attendance da
      ON da.student_enrollment_id = se.id
     AND da.school_id = ${req.schoolId}
     AND da.deleted_at IS NULL
    WHERE se.class_section_id = ${class_section_id}
      AND se.school_id = ${req.schoolId}
      AND se.status = 'active'
    GROUP BY se.student_id
  `;

  // 2. Find Exam (B2: school_id scoped)
  const [exam] = await sql`
    SELECT id
    FROM exams
    WHERE academic_year_id = ${academic_year_id}
      AND exam_type = ${exam_category}
      AND name = ${sub_exam}
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;

  if (!exam) {
    const defaultMaximum = exam_category === 'sa_results' ? 80 : 25;
    return sendSuccess(res, req.schoolId, {
      marks: [],
      attendance,
      max_marks: defaultMaximum,
      consolidated_max_marks: defaultMaximum,
      assessment_schema: 'consolidated',
      component_maximums: parseComponentMaximums(),
    });
  }

  // 3. Find Exam Subject (B2: school_id scoped)
  const [examSubject] = await sql`
    SELECT id, max_marks, assessment_schema, consolidated_max_marks,
      participation_max_marks, written_work_max_marks,
      project_work_max_marks, slip_test_max_marks
    FROM exam_subjects
    WHERE exam_id = ${exam.id}
      AND subject_id = ${subject_id}
      AND class_id = ${class_id}
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;

  if (!examSubject) {
    const defaultMaximum = exam_category === 'sa_results' ? 80 : 25;
    return sendSuccess(res, req.schoolId, {
      marks: [],
      attendance,
      max_marks: defaultMaximum,
      consolidated_max_marks: defaultMaximum,
      assessment_schema: 'consolidated',
      component_maximums: parseComponentMaximums(),
    });
  }

  // 4. Fetch Marks for enrolled students (B2: scoped via student_enrollments)
  const marks = await sql`
    SELECT 
      se.student_id,
      m.marks_obtained,
      m.consolidated_marks_obtained,
      m.participation_marks,
      m.written_work_marks,
      m.project_work_marks,
      m.slip_test_marks,
      m.is_absent,
      m.remarks
    FROM student_enrollments se
    JOIN students st ON st.id = se.student_id
      AND st.school_id = ${req.schoolId}
      AND st.deleted_at IS NULL
      AND st.status_id = ${ACTIVE_STUDENT_STATUS_ID}
    JOIN marks m ON m.student_enrollment_id = se.id AND m.school_id = ${req.schoolId}
    WHERE se.class_section_id = ${class_section_id}
      AND se.school_id = ${req.schoolId}
      AND m.exam_subject_id = ${examSubject.id}
      AND se.status = 'active'
  `;

  return sendSuccess(res, req.schoolId, {
    marks,
    attendance,
    max_marks: examSubject.max_marks || 25,
    consolidated_max_marks: examSubject.consolidated_max_marks || 25,
    assessment_schema: examSubject.assessment_schema || 'consolidated',
    component_maximums: componentMaximumsFromRow(examSubject),
  });
}));

/**
 * POST /results/upload
 * Dynamic Results Upload Endpoint
 * Handles on-the-fly creation of exams and exam_subjects if they don't exist
 */
router.post('/upload', requirePermission('marks.enter'), asyncHandler(async (req, res) => {
  const { class_section_id, exam_category, sub_exam, subject_id, results, max_marks } = req.body;
  const assessmentSchema = req.body.assessment_schema || 'consolidated';

  if (!class_section_id || !exam_category || !sub_exam || !subject_id || !results || !Array.isArray(results)) {
    return res.status(400).json({
      error: 'Missing required fields: class_section_id, exam_category, sub_exam, subject_id, results (array)'
    });
  }

  if (!['component', 'consolidated'].includes(assessmentSchema)) {
    return res.status(400).json({ error: 'assessment_schema must be component or consolidated' });
  }

  const componentMaximums = parseComponentMaximums(req.body.component_maximums);
  const requestedMaxMarks = assessmentSchema === 'component'
    ? componentTotalMax(componentMaximums)
    : Number(max_marks || 25);
  if (!Number.isFinite(requestedMaxMarks) || requestedMaxMarks <= 0 || requestedMaxMarks > 3996) {
    return res.status(400).json({ error: 'max_marks must be between 1 and 3996' });
  }

  const normalizedResults = [];
  for (const result of results) {
    if (!result?.student_id) {
      return res.status(400).json({ error: 'Every result requires student_id' });
    }

    const isAbsent = result.is_absent === true || (
      typeof result.marks === 'string' && ABSENT_RESULT_MARKS.has(result.marks.trim().toUpperCase())
    );

    if (isAbsent) {
      normalizedResults.push({
        student_id: result.student_id,
        marks: null,
        participation_marks: null,
        written_work_marks: null,
        project_work_marks: null,
        slip_test_marks: null,
        is_absent: true,
      });
    } else if (assessmentSchema === 'component') {
      const participation = Number(result.participation_marks);
      const writtenWork = Number(result.written_work_marks);
      const projectWork = Number(result.project_work_marks);
      const slipTest = Number(result.slip_test_marks);
      const componentValues = [participation, writtenWork, projectWork, slipTest];
      if (
        componentValues.some((value) => !Number.isFinite(value) || value < 0) ||
        participation > componentMaximums.participation ||
        writtenWork > componentMaximums.written_work ||
        projectWork > componentMaximums.project_work ||
        slipTest > componentMaximums.slip_test
      ) {
        return res.status(400).json({
          error: `Component marks exceed their limits (${componentMaximums.participation}, ${componentMaximums.written_work}, ${componentMaximums.project_work}, ${componentMaximums.slip_test})`
        });
      }
      normalizedResults.push({
        student_id: result.student_id,
        marks: participation + writtenWork + projectWork + slipTest,
        participation_marks: participation,
        written_work_marks: writtenWork,
        project_work_marks: projectWork,
        slip_test_marks: slipTest,
        is_absent: false,
      });
    } else {
      const marks = Number(result.marks);
      if (!Number.isFinite(marks) || marks < 0 || marks > requestedMaxMarks) {
        return res.status(400).json({ error: `Marks must be between 0 and ${requestedMaxMarks}` });
      }
      normalizedResults.push({ student_id: result.student_id, marks, is_absent: false });
    }
  }

  // 1. Resolve Academic Year & Class ID (B2: school_id scoped)
  const [classSection] = await sql`
    SELECT cs.class_id, cs.academic_year_id 
    FROM class_sections cs 
    WHERE cs.id = ${class_section_id} AND cs.school_id = ${req.schoolId}
  `;

  if (!classSection) {
    return res.status(404).json({ error: 'Class section not found' });
  }

  const { class_id, academic_year_id } = classSection;

  // 2. Find or Create Exam (B2: school_id scoped)
  let [exam] = await sql`
    SELECT id, name, exam_type, results_published
    FROM exams
    WHERE academic_year_id = ${academic_year_id}
      AND exam_type = ${exam_category}
      AND name = ${sub_exam}
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;

  if (!exam) {
    let autoNameTe = null;
    try { const te = await translateFields({ name: sub_exam }); autoNameTe = te.name || null; } catch (e) {}
    [exam] = await sql`
      INSERT INTO exams (school_id, name, name_te, academic_year_id, exam_type, start_date, status)
      VALUES (${req.schoolId}, ${sub_exam}, ${autoNameTe}, ${academic_year_id}, ${exam_category}, CURRENT_DATE, 'ongoing')
      RETURNING id, name, exam_type, results_published
    `;
  }

  if (exam.results_published) {
    return res.status(409).json({ error: 'Results are published. Ask an admin to unpublish them before changing marks.' });
  }

  // 3. Find or Create Exam Subject (B2: school_id scoped)
  let [examSubject] = await sql`
    SELECT id, max_marks, assessment_schema, consolidated_max_marks,
      participation_max_marks, written_work_max_marks,
      project_work_max_marks, slip_test_max_marks
    FROM exam_subjects
    WHERE exam_id = ${exam.id}
      AND subject_id = ${subject_id}
      AND class_id = ${class_id}
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;

  const targetMaxMarks = requestedMaxMarks;
  const targetPassingMarks = Math.ceil(targetMaxMarks * 0.35); // 35% passing
  const consolidatedMaxMarks = assessmentSchema === 'consolidated'
    ? targetMaxMarks
    : Number(examSubject?.consolidated_max_marks || 25);
  const storedComponentMaximums = componentMaximumsFromRow(examSubject);
  const componentMaximumsChanged =
    storedComponentMaximums.participation !== componentMaximums.participation ||
    storedComponentMaximums.written_work !== componentMaximums.written_work ||
    storedComponentMaximums.project_work !== componentMaximums.project_work ||
    storedComponentMaximums.slip_test !== componentMaximums.slip_test;

  if (!examSubject) {
    [examSubject] = await sql`
      INSERT INTO exam_subjects (
        school_id, exam_id, subject_id, class_id, max_marks, passing_marks,
        assessment_schema, consolidated_max_marks,
        participation_max_marks, written_work_max_marks,
        project_work_max_marks, slip_test_max_marks
      )
      VALUES (
        ${req.schoolId}, ${exam.id}, ${subject_id}, ${class_id}, ${targetMaxMarks},
        ${targetPassingMarks}, ${assessmentSchema}, ${consolidatedMaxMarks},
        ${componentMaximums.participation}, ${componentMaximums.written_work},
        ${componentMaximums.project_work}, ${componentMaximums.slip_test}
      )
      RETURNING id, max_marks, assessment_schema, consolidated_max_marks,
        participation_max_marks, written_work_max_marks,
        project_work_max_marks, slip_test_max_marks
    `;
  } else if (
    Number(examSubject.max_marks) !== targetMaxMarks ||
    examSubject.assessment_schema !== assessmentSchema ||
    Number(examSubject.consolidated_max_marks) !== consolidatedMaxMarks ||
    componentMaximumsChanged
  ) {
    [examSubject] = await sql`
      UPDATE exam_subjects
      SET max_marks = ${targetMaxMarks},
          passing_marks = ${targetPassingMarks},
          assessment_schema = ${assessmentSchema},
          consolidated_max_marks = ${consolidatedMaxMarks},
          participation_max_marks = ${componentMaximums.participation},
          written_work_max_marks = ${componentMaximums.written_work},
          project_work_max_marks = ${componentMaximums.project_work},
          slip_test_max_marks = ${componentMaximums.slip_test}
      WHERE id = ${examSubject.id}
      AND school_id = ${req.schoolId}
      RETURNING id, max_marks, assessment_schema, consolidated_max_marks,
        participation_max_marks, written_work_max_marks,
        project_work_max_marks, slip_test_max_marks
    `;
  }

  // 4. Process Results (Bulk Upsert Marks)
  const enteredBy = req.user?.internal_id;
  const processedResults = [];

  for (const r of normalizedResults) {
    const { student_id, marks } = r;

    // We need student_enrollment_id, not student_id directly for the marks table
    // But we have student_id and class_section_id
    const [enrollment] = await sql`
      SELECT se.id
      FROM student_enrollments se
      JOIN students s ON s.id = se.student_id
        AND s.school_id = ${req.schoolId}
        AND s.deleted_at IS NULL
        AND s.status_id = ${ACTIVE_STUDENT_STATUS_ID}
      WHERE se.student_id = ${student_id}
        AND se.class_section_id = ${class_section_id}
        AND se.school_id = ${req.schoolId}
        AND se.status = 'active'
      LIMIT 1
    `;

    if (!enrollment) {
      processedResults.push({ student_id, error: 'Active enrollment not found' });
      continue;
    }

    try {
      const [existingMark] = await sql`
        SELECT id FROM marks 
        WHERE exam_subject_id = ${examSubject.id} 
          AND student_enrollment_id = ${enrollment.id}
        LIMIT 1
      `;

      // Upsert Mark (B2: school_id required)
      const [markEntry] = await sql`
        INSERT INTO marks (
          school_id, exam_subject_id, student_enrollment_id, marks_obtained,
          consolidated_marks_obtained, participation_marks, written_work_marks,
          project_work_marks, slip_test_marks, is_absent, entered_by
        )
        VALUES (
          ${req.schoolId},
          ${examSubject.id}, 
          ${enrollment.id}, 
          ${marks}, 
          ${assessmentSchema === 'consolidated' ? marks : null},
          ${r.participation_marks ?? null},
          ${r.written_work_marks ?? null},
          ${r.project_work_marks ?? null},
          ${r.slip_test_marks ?? null},
          ${r.is_absent},
          ${enteredBy}
        )
        ON CONFLICT (school_id, exam_subject_id, student_enrollment_id)
        DO UPDATE SET
          marks_obtained = EXCLUDED.marks_obtained,
          consolidated_marks_obtained = CASE
            WHEN EXCLUDED.is_absent THEN NULL
            ELSE COALESCE(EXCLUDED.consolidated_marks_obtained, marks.consolidated_marks_obtained)
          END,
          participation_marks = CASE WHEN EXCLUDED.is_absent THEN NULL ELSE COALESCE(EXCLUDED.participation_marks, marks.participation_marks) END,
          written_work_marks = CASE WHEN EXCLUDED.is_absent THEN NULL ELSE COALESCE(EXCLUDED.written_work_marks, marks.written_work_marks) END,
          project_work_marks = CASE WHEN EXCLUDED.is_absent THEN NULL ELSE COALESCE(EXCLUDED.project_work_marks, marks.project_work_marks) END,
          slip_test_marks = CASE WHEN EXCLUDED.is_absent THEN NULL ELSE COALESCE(EXCLUDED.slip_test_marks, marks.slip_test_marks) END,
          is_absent = EXCLUDED.is_absent,
          entered_by = EXCLUDED.entered_by,
          updated_at = NOW()
        RETURNING id
      `;
      processedResults.push({
        student_id,
        mark_id: markEntry.id,
        success: true,
        isNew: !existingMark,
        enrollment_id: enrollment.id
      });
    } catch (err) {
      processedResults.push({ student_id, error: err.message });
    }
  }

  return sendSuccess(res, req.schoolId, {
    message: 'Marks uploaded successfully',
    exam_id: exam.id,
    exam_subject_id: examSubject.id,
    results: processedResults.map((r) => ({
      student_id: r.student_id,
      mark_id: r.mark_id,
      success: r.success,
      error: r.error
    }))
  });
}));

// ============== EXAM TIMETABLE ==============
// One exam_subjects row = one paper (exam x class x subject) with a date and
// session time. The admin generates these from parameters, edits them
// cell-by-cell, then publishes; students and teachers only ever see published
// timetables.

/**
 * POST /results/exams/:id/timetable/generate
 * Auto-generate (or regenerate) the timetable from parameters.
 * Body: { class_ids, start_date, end_date, start_time?, end_time?,
 *         include_saturdays?, exclude_holidays?, excluded_dates?, gap_days?,
 *         max_marks?, passing_marks?, subject_order?, mode? }
 */
router.post('/exams/:id/timetable/generate', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  try {
    const result = await generateExamTimetable({
      schoolId: req.schoolId,
      examId: req.params.id,
      params: req.body,
    });
    return sendSuccess(res, req.schoolId, { message: 'Timetable generated', ...result });
  } catch (err) {
    if (err instanceof ExamTimetableError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    throw err;
  }
}));

/**
 * GET /results/exams/:id/timetable
 * Full schedule for the admin editor: exam meta + every paper + marks flag.
 */
router.get('/exams/:id/timetable', requirePermission('exams.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [exam] = await sql`
    SELECT e.id, e.name, e.name_te, e.exam_type,
           e.start_date::text AS start_date, e.end_date::text AS end_date, e.status,
           e.timetable_published, e.timetable_published_at, e.timetable_params,
           e.results_published, e.results_published_at, e.results_published_by,
           e.academic_year_id, ay.code AS academic_year
    FROM exams e
    JOIN academic_years ay ON e.academic_year_id = ay.id
    WHERE e.id = ${id} AND e.school_id = ${req.schoolId} AND e.deleted_at IS NULL
  `;
  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }

  const papers = await sql`
    SELECT
      es.id, es.class_id, es.subject_id, es.exam_date::text AS exam_date,
      es.start_time::text AS start_time, es.end_time::text AS end_time,
      es.max_marks, es.passing_marks, es.syllabus,
      c.name AS class_name,
      s.name AS subject_name, s.name_te AS subject_name_te,
      EXISTS (SELECT 1 FROM marks m WHERE m.exam_subject_id = es.id) AS has_marks,
      -- Whether a subject teacher is assigned for this class+subject in the
      -- exam's year. Schools may keep that assignment in Academics or only in
      -- the timetable, so the hint must check both sources.
      (
        EXISTS (
          SELECT 1 FROM class_subjects csub
          JOIN class_sections cs ON csub.class_section_id = cs.id AND cs.deleted_at IS NULL
          WHERE cs.class_id = es.class_id
            AND csub.subject_id = es.subject_id
            AND cs.academic_year_id = ${exam.academic_year_id}
            AND cs.school_id = ${req.schoolId}
            AND csub.teacher_id IS NOT NULL
            AND csub.deleted_at IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM timetable_slots ts
          JOIN class_sections cs ON ts.class_section_id = cs.id AND cs.deleted_at IS NULL
          WHERE cs.class_id = es.class_id
            AND ts.subject_id = es.subject_id
            AND ts.academic_year_id = ${exam.academic_year_id}
            AND cs.academic_year_id = ${exam.academic_year_id}
            AND cs.school_id = ${req.schoolId}
            AND ts.school_id = ${req.schoolId}
            AND ts.teacher_id IS NOT NULL
            AND ts.deleted_at IS NULL
        )
      ) AS has_teacher
    FROM exam_subjects es
    JOIN classes c ON es.class_id = c.id
    JOIN subjects s ON es.subject_id = s.id
    WHERE es.exam_id = ${id} AND es.school_id = ${req.schoolId} AND es.deleted_at IS NULL
    ORDER BY es.exam_date NULLS LAST, es.start_time NULLS LAST, c.sort_order NULLS LAST, c.name, s.name
  `;

  const resultReadiness = await getExamResultReadiness({
    schoolId: req.schoolId,
    examId: id,
  });

  return sendSuccess(res, req.schoolId, {
    exam,
    papers,
    result_readiness: resultReadiness,
  });
}));

/**
 * GET /results/exams/:id/hall-tickets?class_id=&section_id=
 * Complete, academic-year-safe source data for one class/section hall-ticket
 * batch. The PDF itself is rendered client-side so it can be downloaded on web
 * and shared from native apps.
 */
router.get('/exams/:id/hall-tickets', requirePermission('exams.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const classId = String(req.query.class_id || '').trim();
  const sectionId = String(req.query.section_id || '').trim();

  if (!classId || !sectionId) {
    return res.status(400).json({ error: 'class_id and section_id are required' });
  }

  const [exam] = await sql`
    SELECT e.id, e.name, e.name_te, e.exam_type,
           e.start_date::text AS start_date, e.end_date::text AS end_date,
           e.academic_year_id, ay.code AS academic_year
    FROM exams e
    JOIN academic_years ay ON e.academic_year_id = ay.id
    WHERE e.id = ${id}
      AND e.school_id = ${req.schoolId}
      AND e.deleted_at IS NULL
  `;
  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }

  const [classSection] = await sql`
    SELECT cs.id, cs.class_id, cs.section_id,
           c.name AS class_name, s.name AS section_name
    FROM class_sections cs
    JOIN classes c ON cs.class_id = c.id
    JOIN sections s ON cs.section_id = s.id
    WHERE cs.school_id = ${req.schoolId}
      AND cs.academic_year_id = ${exam.academic_year_id}
      AND cs.class_id = ${classId}
      AND cs.section_id = ${sectionId}
      AND cs.deleted_at IS NULL
    LIMIT 1
  `;
  if (!classSection) {
    return res.status(404).json({ error: 'Class and section are not mapped for this exam academic year' });
  }

  const papers = await sql`
    SELECT
      es.id, es.class_id, es.subject_id, es.exam_date::text AS exam_date,
      es.start_time::text AS start_time, es.end_time::text AS end_time,
      es.max_marks, es.passing_marks, es.syllabus,
      c.name AS class_name,
      s.name AS subject_name, s.name_te AS subject_name_te,
      false AS has_marks, false AS has_teacher
    FROM exam_subjects es
    JOIN classes c ON es.class_id = c.id
    JOIN subjects s ON es.subject_id = s.id
    WHERE es.exam_id = ${id}
      AND es.class_id = ${classId}
      AND es.school_id = ${req.schoolId}
      AND es.deleted_at IS NULL
    ORDER BY es.exam_date NULLS LAST, es.start_time NULLS LAST, s.name
  `;

  if (papers.length === 0) {
    return res.status(404).json({ error: 'No exam papers are scheduled for this class' });
  }

  const students = await sql`
    SELECT
      st.id,
      p.display_name,
      p.photo_url,
      st.admission_no,
      se.roll_number,
      father_info.father_name
    FROM student_enrollments se
    JOIN students st ON se.student_id = st.id
    JOIN persons p ON st.person_id = p.id
    LEFT JOIN LATERAL (
      SELECT pp.display_name AS father_name
      FROM student_parents sp
      JOIN parents par ON sp.parent_id = par.id AND par.deleted_at IS NULL
      JOIN persons pp ON par.person_id = pp.id
      JOIN relationship_types rt ON sp.relationship_id = rt.id AND rt.name = 'Father'
      WHERE sp.student_id = st.id
        AND sp.school_id = ${req.schoolId}
        AND sp.deleted_at IS NULL
      ORDER BY sp.is_primary_contact DESC NULLS LAST, sp.created_at
      LIMIT 1
    ) father_info ON true
    WHERE se.school_id = ${req.schoolId}
      AND se.class_section_id = ${classSection.id}
      AND se.academic_year_id = ${exam.academic_year_id}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
      AND st.deleted_at IS NULL
      AND st.status_id = ${ACTIVE_STUDENT_STATUS_ID}
    ORDER BY se.roll_number NULLS LAST, p.display_name, st.admission_no
  `;

  return sendSuccess(res, req.schoolId, {
    exam,
    class_section: classSection,
    papers,
    students,
  });
}));

/**
 * PATCH /results/exam-subjects/:id
 * Manual edit of one paper: date, session time, marks settings.
 */
router.patch('/exam-subjects/:id', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { exam_date, start_time, end_time, max_marks, passing_marks, syllabus } = req.body;

  let normalizedSyllabus;
  if (syllabus !== undefined) {
    try {
      normalizedSyllabus = normalizeSyllabus(syllabus);
    } catch (err) {
      if (err instanceof ExamTimetableError) {
        return res.status(err.status).json({ error: err.message });
      }
      throw err;
    }
  }

  const [paper] = await sql`
    SELECT es.id, es.exam_id, es.exam_date::text AS exam_date,
           es.max_marks, es.passing_marks, es.start_time::text AS start_time, es.end_time,
           e.results_published
    FROM exam_subjects es
    JOIN exams e ON e.id = es.exam_id AND e.school_id = ${req.schoolId}
    WHERE es.id = ${id} AND es.school_id = ${req.schoolId} AND es.deleted_at IS NULL
  `;
  if (!paper) {
    return res.status(404).json({ error: 'Exam paper not found' });
  }
  if (paper.results_published) {
    return res.status(409).json({ error: 'Unpublish the exam results before changing a paper.' });
  }

  const newMax = max_marks !== undefined ? Number(max_marks) : Number(paper.max_marks);
  const newPass = passing_marks !== undefined ? Number(passing_marks) : Number(paper.passing_marks);
  if (!(newMax > 0) || Number.isNaN(newPass) || newPass < 0 || newPass > newMax) {
    return res.status(400).json({ error: 'passing_marks must be between 0 and max_marks' });
  }

  // Never let max_marks drop below marks a teacher has already entered.
  if (max_marks !== undefined) {
    const [{ highest }] = await sql`
      SELECT MAX(marks_obtained) AS highest FROM marks WHERE exam_subject_id = ${id}
    `;
    if (highest !== null && Number(highest) > newMax) {
      return res.status(400).json({ error: `Cannot set max marks below already-recorded marks (${highest})` });
    }
  }

  const newStart = start_time !== undefined ? (start_time || null) : paper.start_time;
  const newEnd = end_time !== undefined ? (end_time || null) : paper.end_time;
  if (newStart && newEnd && String(newEnd) <= String(newStart)) {
    return res.status(400).json({ error: 'end_time must be after start_time' });
  }

  const [updated] = await sql`
    UPDATE exam_subjects
    SET exam_date = ${exam_date !== undefined ? (exam_date || null) : sql`exam_date`},
        start_time = ${newStart},
        end_time = ${newEnd},
        max_marks = ${newMax},
        passing_marks = ${newPass},
        syllabus = ${syllabus !== undefined ? (normalizedSyllabus === null ? null : sql.json(normalizedSyllabus)) : sql`syllabus`}
    WHERE id = ${id} AND school_id = ${req.schoolId}
    RETURNING id, class_id, subject_id, exam_date::text AS exam_date, start_time::text AS start_time, end_time::text AS end_time, max_marks, passing_marks, syllabus
  `;

  // Seating is keyed by (date, session start): if either moved, existing room
  // and seat assignments no longer match the schedule — clear them and say so.
  const sittingMoved =
    (updated.exam_date || null) !== (paper.exam_date || null) ||
    sessionKey(updated.start_time) !== sessionKey(paper.start_time);
  let seatingCleared = 0;
  if (sittingMoved) {
    seatingCleared = await clearExamSeating(sql, req.schoolId, paper.exam_id);
  }

  return sendSuccess(res, req.schoolId, {
    message:
      seatingCleared > 0
        ? 'Paper updated. Seating & invigilation were cleared because the schedule changed — reallocate rooms.'
        : 'Paper updated',
    seating_cleared: seatingCleared,
    paper: updated,
  });
}));

/**
 * PATCH /results/exam-subjects/:id/syllabus
 * Teacher-scoped: the subject teacher sets the syllabus & weightage for a paper
 * of a subject they actually teach. Only the syllabus is touched — dates, times
 * and marks stay admin-only. Body: { syllabus: [{ topic, marks }] | null }.
 */
router.patch('/exam-subjects/:id/syllabus', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;

  let normalizedSyllabus;
  try {
    normalizedSyllabus = normalizeSyllabus(req.body?.syllabus);
  } catch (err) {
    if (err instanceof ExamTimetableError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }

  // Resolve the caller's staff row.
  const [staff] = await sql`
    SELECT st.id
    FROM staff st
    JOIN persons p ON st.person_id = p.id
    JOIN users u ON u.person_id = p.id
    WHERE u.id = ${req.user.id} AND st.school_id = ${req.schoolId} AND st.deleted_at IS NULL
  `;
  const isAdmin = req.user.roles?.includes('admin');
  if (!staff && !isAdmin) {
    return res.status(404).json({ error: 'Staff profile not found' });
  }

  // Load the paper (school-scoped) with its exam's academic year.
  const [paper] = await sql`
    SELECT es.id, es.class_id, es.subject_id, e.academic_year_id
    FROM exam_subjects es
    JOIN exams e ON es.exam_id = e.id AND e.deleted_at IS NULL
    WHERE es.id = ${id} AND es.school_id = ${req.schoolId} AND es.deleted_at IS NULL
  `;
  if (!paper) {
    return res.status(404).json({ error: 'Exam paper not found' });
  }

  // Authorize: admins always; otherwise the caller must teach this subject in
  // this class for the exam's academic year.
  if (!isAdmin) {
    const [teaches] = await sql`
      SELECT 1
      FROM class_subjects csub
      JOIN class_sections cs ON csub.class_section_id = cs.id AND cs.deleted_at IS NULL
      WHERE csub.teacher_id = ${staff.id}
        AND csub.subject_id = ${paper.subject_id}
        AND cs.class_id = ${paper.class_id}
        AND cs.academic_year_id = ${paper.academic_year_id}
        AND cs.school_id = ${req.schoolId}
        AND csub.deleted_at IS NULL
      LIMIT 1
    `;
    if (!teaches) {
      return res.status(403).json({ error: 'You can only edit the syllabus for subjects you teach' });
    }
  }

  const [updated] = await sql`
    UPDATE exam_subjects
    SET syllabus = ${normalizedSyllabus === null ? null : sql.json(normalizedSyllabus)}
    WHERE id = ${id} AND school_id = ${req.schoolId}
    RETURNING id, syllabus
  `;

  return sendSuccess(res, req.schoolId, { message: 'Syllabus updated', paper: updated });
}));

/**
 * DELETE /results/exam-subjects/:id
 * Remove a paper from the schedule (blocked once marks exist).
 */
router.delete('/exam-subjects/:id', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [paper] = await sql`
    SELECT es.id, e.results_published
    FROM exam_subjects es
    JOIN exams e ON e.id = es.exam_id AND e.school_id = ${req.schoolId}
    WHERE es.id = ${id} AND es.school_id = ${req.schoolId} AND es.deleted_at IS NULL
  `;
  if (!paper) {
    return res.status(404).json({ error: 'Exam paper not found' });
  }
  if (paper.results_published) {
    return res.status(409).json({ error: 'Unpublish the exam results before removing a paper.' });
  }

  const [hasMarks] = await sql`SELECT 1 FROM marks WHERE exam_subject_id = ${id} LIMIT 1`;
  if (hasMarks) {
    return res.status(400).json({ error: 'Cannot remove: marks already recorded for this paper' });
  }

  const [deleted] = await sql`
    UPDATE exam_subjects SET deleted_at = now()
    WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    RETURNING id, exam_id, exam_date
  `;
  if (!deleted) {
    return res.status(404).json({ error: 'Exam paper not found' });
  }

  // A scheduled paper leaving the timetable invalidates the derived seating.
  let seatingCleared = 0;
  if (deleted.exam_date) {
    seatingCleared = await clearExamSeating(sql, req.schoolId, deleted.exam_id);
  }
  return sendSuccess(res, req.schoolId, {
    message:
      seatingCleared > 0
        ? 'Paper removed. Seating & invigilation were cleared — reallocate rooms.'
        : 'Paper removed',
    seating_cleared: seatingCleared,
  });
}));

/**
 * POST /results/exams/:id/timetable/publish
 * Body: { published: boolean }. Publishing requires every paper to have a date.
 */
router.post('/exams/:id/timetable/publish', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const published = req.body?.published !== false;

  const [exam] = await sql`
    SELECT id FROM exams WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }

  if (published) {
    const [{ total, undated }] = await sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE exam_date IS NULL)::int AS undated
      FROM exam_subjects
      WHERE exam_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    `;
    if (total === 0) {
      return res.status(400).json({ error: 'Generate the timetable before publishing' });
    }
    if (undated > 0) {
      return res.status(400).json({ error: `${undated} paper(s) have no date set` });
    }
  }

  const [updated] = await sql`
    UPDATE exams
    SET timetable_published = ${published},
        timetable_published_at = ${published ? sql`now()` : null}
    WHERE id = ${id} AND school_id = ${req.schoolId}
    RETURNING id, timetable_published, timetable_published_at
  `;

  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, req.schoolId, {
    message: published ? 'Exam timetable published' : 'Exam timetable unpublished',
    exam: updated,
  });
}));

/**
 * POST /results/exams/:id/results/publish
 * Body: { published: boolean }. Publishing is exam-wide and is allowed only
 * after every active student has an entry for every scheduled paper.
 */
router.post('/exams/:id/results/publish', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  if (!canPreviewUnpublishedResults(req)) {
    return res.status(403).json({ error: 'Only an admin can publish exam results' });
  }
  const published = req.body?.published !== false;

  try {
    const result = await setExamResultsPublished({
      schoolId: req.schoolId,
      examId: req.params.id,
      published,
      publishedBy: req.user?.internal_id,
    });

    if (published && result.changed) {
      void notifyPublishedResultUsers(req.schoolId, result.exam);
    }

    return sendSuccess(res, req.schoolId, {
      message: published ? 'Exam results published' : 'Exam results unpublished',
      exam: result.exam,
      result_readiness: result.readiness,
    });
  } catch (error) {
    if (error instanceof ExamResultPublishingError) {
      return res.status(error.status).json({
        error: error.message,
        ...(error.details ? { result_readiness: error.details } : {}),
      });
    }
    throw error;
  }
}));

/**
 * GET /results/exam-timetable/class-subjects?class_ids=a,b,c
 * Union of subjects taught by the given classes (for the generator wizard's
 * subject picker). class_count says how many of the selected classes teach it.
 */
router.get('/exam-timetable/class-subjects', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const classIds = String(req.query.class_ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (classIds.length === 0) {
    return sendSuccess(res, req.schoolId, []);
  }

  const requestedAcademicYearId = String(req.query.academic_year_id || '').trim();
  const [academicYear] = requestedAcademicYearId
    ? await sql`
        SELECT id
        FROM academic_years
        WHERE id = ${requestedAcademicYearId}
          AND school_id = ${req.schoolId}
        LIMIT 1
      `
    : await sql`
        SELECT id
        FROM academic_years
        WHERE school_id = ${req.schoolId}
        ORDER BY
          CASE WHEN CURRENT_DATE BETWEEN start_date AND end_date THEN 0 ELSE 1 END,
          start_date DESC
        LIMIT 1
      `;
  if (!academicYear) {
    return res.status(404).json({ error: 'Academic year not found' });
  }

  const rows = await sql`
    WITH taught_subjects AS (
      SELECT cs.class_id, csub.subject_id
      FROM class_subjects csub
      JOIN class_sections cs ON csub.class_section_id = cs.id
      WHERE cs.class_id = ANY(${classIds})
        AND cs.academic_year_id = ${academicYear.id}
        AND cs.school_id = ${req.schoolId}
        AND csub.school_id = ${req.schoolId}
        AND csub.deleted_at IS NULL
        AND cs.deleted_at IS NULL

      UNION

      SELECT cs.class_id, ts.subject_id
      FROM timetable_slots ts
      JOIN class_sections cs ON ts.class_section_id = cs.id
      WHERE cs.class_id = ANY(${classIds})
        AND cs.academic_year_id = ${academicYear.id}
        AND ts.academic_year_id = ${academicYear.id}
        AND cs.school_id = ${req.schoolId}
        AND ts.school_id = ${req.schoolId}
        AND ts.deleted_at IS NULL
        AND cs.deleted_at IS NULL
    )
    SELECT sub.id, sub.name, sub.name_te,
           COUNT(DISTINCT taught.class_id)::int AS class_count
    FROM taught_subjects taught
    JOIN subjects sub ON taught.subject_id = sub.id
    WHERE sub.school_id = ${req.schoolId}
      AND sub.deleted_at IS NULL
    GROUP BY sub.id, sub.name, sub.name_te
    ORDER BY sub.name
  `;

  return sendSuccess(res, req.schoolId, rows);
}));

/**
 * GET /results/exam-timetable/section/:classSectionId
 * Student/parent read. Published timetables only (unless caller can manage
 * exams), scoped to the section's class and academic year. The section id is
 * verified against the caller's school, so no cross-tenant reads.
 */
router.get('/exam-timetable/section/:classSectionId', requireAuth, asyncHandler(async (req, res) => {
  const { classSectionId } = req.params;

  const canSeeUnpublished =
    req.user.roles?.includes('admin') || req.user.permissions?.includes('exams.manage');

  const rows = await getSectionExamSchedule({
    schoolId: req.schoolId,
    classSectionId,
    includeUnpublished: canSeeUnpublished,
  });
  if (rows === null) {
    return res.status(404).json({ error: 'Class section not found' });
  }

  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, req.schoolId, rows);
}));

/**
 * GET /results/exam-timetable/teacher
 * Teacher read: published exam papers for every class the teacher teaches,
 * with a flag on the papers of their own subject(s).
 */
router.get('/exam-timetable/teacher', requireAuth, asyncHandler(async (req, res) => {
  const [staff] = await sql`
    SELECT st.id
    FROM staff st
    JOIN persons p ON st.person_id = p.id
    JOIN users u ON u.person_id = p.id
    WHERE u.id = ${req.user.internal_id || req.user.id}
      AND u.school_id = ${req.schoolId}
      AND u.deleted_at IS NULL
      AND st.school_id = ${req.schoolId}
      AND st.deleted_at IS NULL
  `;
  if (!staff) {
    return res.status(404).json({ error: 'Staff profile not found' });
  }

  const rows = await getTeacherExamSchedule({
    schoolId: req.schoolId,
    staffId: staff.id,
  });

  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, req.schoolId, rows);
}));

// ============== EXAM ROOMS (registry) ==============
// Reusable per-school rooms used by the seating allocator. Fully editable.

/**
 * GET /results/exam-rooms
 */
router.get('/exam-rooms', requirePermission('exams.view'), asyncHandler(async (req, res) => {
  const rooms = await sql`
    SELECT id, name, row_count AS rows, column_count AS columns, capacity, sort_order
    FROM exam_rooms
    WHERE school_id = ${req.schoolId} AND deleted_at IS NULL
    ORDER BY sort_order, name
  `;
  return sendSuccess(res, req.schoolId, rooms);
}));

/**
 * POST /results/exam-rooms  { name, rows, columns }
 */
router.post('/exam-rooms', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const legacyCapacity = req.body?.capacity !== undefined ? Number(req.body.capacity) : null;
  const rows = Number(req.body?.rows ?? (legacyCapacity ? 1 : NaN));
  const columns = Number(req.body?.columns ?? legacyCapacity);
  if (!name) return res.status(400).json({ error: 'Room name is required' });
  if (!Number.isInteger(rows) || rows < 1 || rows > 100) {
    return res.status(400).json({ error: 'Rows must be a whole number between 1 and 100' });
  }
  if (!Number.isInteger(columns) || columns < 1 || columns > 100) {
    return res.status(400).json({ error: 'Columns must be a whole number between 1 and 100' });
  }
  const capacity = rows * columns;

  try {
    const [room] = await sql`
      INSERT INTO exam_rooms (school_id, name, row_count, column_count, capacity)
      VALUES (${req.schoolId}, ${name}, ${rows}, ${columns}, ${capacity})
      RETURNING id, name, row_count AS rows, column_count AS columns, capacity, sort_order
    `;
    return sendSuccess(res, req.schoolId, { message: 'Room added', room }, 201);
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(400).json({ error: 'A room with this name already exists' });
    }
    throw err;
  }
}));

/**
 * PATCH /results/exam-rooms/:id  { name?, rows?, columns? }
 */
router.patch('/exam-rooms/:id', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : null;
  const legacyCapacity = req.body?.capacity !== undefined ? Number(req.body.capacity) : null;
  const rows = req.body?.rows !== undefined ? Number(req.body.rows) : legacyCapacity !== null ? 1 : null;
  const columns = req.body?.columns !== undefined
    ? Number(req.body.columns)
    : legacyCapacity;
  if (name !== null && !name) return res.status(400).json({ error: 'Room name cannot be empty' });
  if (rows !== null && (!Number.isInteger(rows) || rows < 1 || rows > 100)) {
    return res.status(400).json({ error: 'Rows must be a whole number between 1 and 100' });
  }
  if (columns !== null && (!Number.isInteger(columns) || columns < 1 || columns > 100)) {
    return res.status(400).json({ error: 'Columns must be a whole number between 1 and 100' });
  }

  try {
    const [room] = await sql`
      UPDATE exam_rooms
      SET name = COALESCE(${name}, name),
          row_count = COALESCE(${rows}, row_count),
          column_count = COALESCE(${columns}, column_count),
          capacity = COALESCE(${rows}, row_count) * COALESCE(${columns}, column_count)
      WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
      RETURNING id, name, row_count AS rows, column_count AS columns, capacity, sort_order
    `;
    if (!room) return res.status(404).json({ error: 'Room not found' });
    return sendSuccess(res, req.schoolId, { message: 'Room updated', room });
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(400).json({ error: 'A room with this name already exists' });
    }
    throw err;
  }
}));

/**
 * DELETE /results/exam-rooms/:id — blocked while the room is in an active allocation.
 */
router.delete('/exam-rooms/:id', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [inUse] = await sql`
    SELECT 1 FROM exam_room_allocations
    WHERE room_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (inUse) {
    return res.status(400).json({ error: 'Room is used in an exam allocation. Reallocate first.' });
  }
  const [deleted] = await sql`
    UPDATE exam_rooms SET deleted_at = now()
    WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    RETURNING id
  `;
  if (!deleted) return res.status(404).json({ error: 'Room not found' });
  return sendSuccess(res, req.schoolId, { message: 'Room removed' });
}));

// ============== EXAM SEATING & INVIGILATION ==============

/**
 * POST /results/exams/:id/allocations/generate
 * Body: {
 *   room_ids (fill order),
 *   room_configs: [{ room_id, class_ids }],
 *   strategy: 'maximize'|'mixed'|'balanced'|'sequential',
 *   invigilator_staff_ids
 * }
 */
router.post('/exams/:id/allocations/generate', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  try {
    const result = await generateExamAllocations({
      schoolId: req.schoolId,
      examId: req.params.id,
      params: req.body,
    });
    return sendSuccess(res, req.schoolId, { message: 'Seating allocated', ...result });
  } catch (err) {
    if (err instanceof ExamTimetableError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    throw err;
  }
}));

/**
 * GET /results/exams/:id/allocations
 * Room allocations for the admin editor, flat (client groups by sitting).
 */
router.get('/exams/:id/allocations', requirePermission('exams.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [exam] = await sql`
    SELECT id, allocation_params FROM exams
    WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!exam) return res.status(404).json({ error: 'Exam not found' });

  const allocations = await sql`
    SELECT
      era.id, era.exam_date::text AS exam_date, era.session_start::text AS session_start,
      era.room_id, r.name AS room_name, r.row_count AS rows, r.column_count AS columns, r.capacity,
      era.invigilator_staff_id, p.display_name AS invigilator_name,
      (SELECT COUNT(*)::int FROM exam_seat_assignments esa
        WHERE esa.room_allocation_id = era.id AND esa.deleted_at IS NULL) AS seats_count,
      (SELECT string_agg(DISTINCT c.name, ', ') FROM exam_seat_assignments esa
        JOIN classes c ON esa.class_id = c.id
        WHERE esa.room_allocation_id = era.id AND esa.deleted_at IS NULL) AS class_names
    FROM exam_room_allocations era
    JOIN exam_rooms r ON era.room_id = r.id
    LEFT JOIN staff st ON era.invigilator_staff_id = st.id
    LEFT JOIN persons p ON st.person_id = p.id
    WHERE era.exam_id = ${id} AND era.school_id = ${req.schoolId} AND era.deleted_at IS NULL
    ORDER BY era.exam_date, era.session_start, r.name
  `;

  return sendSuccess(res, req.schoolId, {
    allocations,
    allocation_params: exam.allocation_params,
  });
}));

/**
 * POST /results/exams/:id/allocations
 * Manually add an (empty) room to a sitting. { exam_date, session_start?, room_id }
 */
router.post('/exams/:id/allocations', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { exam_date, session_start, room_id } = req.body || {};
  if (!exam_date || !room_id) {
    return res.status(400).json({ error: 'exam_date and room_id are required' });
  }
  const [exam] = await sql`
    SELECT id FROM exams WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!exam) return res.status(404).json({ error: 'Exam not found' });
  const [room] = await sql`
    SELECT id FROM exam_rooms WHERE id = ${room_id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!room) return res.status(404).json({ error: 'Room not found' });

  try {
    const [alloc] = await sql`
      INSERT INTO exam_room_allocations (school_id, exam_id, exam_date, session_start, room_id)
      VALUES (${req.schoolId}, ${id}, ${exam_date}, ${sessionKey(session_start)}, ${room_id})
      RETURNING id
    `;
    return sendSuccess(res, req.schoolId, { message: 'Room added to sitting', allocation_id: alloc.id }, 201);
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(400).json({ error: 'This room is already allocated for that sitting' });
    }
    throw err;
  }
}));

/**
 * GET /results/exam-allocations/:id/students
 * Seat list of one room in one sitting.
 */
router.get('/exam-allocations/:id/students', requirePermission('exams.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [alloc] = await sql`
    SELECT id FROM exam_room_allocations
    WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!alloc) return res.status(404).json({ error: 'Allocation not found' });

  const students = await sql`
    SELECT esa.id AS seat_id, esa.seat_no, esa.student_enrollment_id,
           c.name AS class_name, sec.name AS section_name,
           se.roll_number, p.display_name, s.admission_no
    FROM exam_seat_assignments esa
    JOIN student_enrollments se ON esa.student_enrollment_id = se.id
    JOIN class_sections cs ON se.class_section_id = cs.id
    JOIN sections sec ON cs.section_id = sec.id
    JOIN classes c ON esa.class_id = c.id
    JOIN students s ON se.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    WHERE esa.room_allocation_id = ${id} AND esa.school_id = ${req.schoolId} AND esa.deleted_at IS NULL
    ORDER BY esa.seat_no NULLS LAST, p.display_name
  `;
  return sendSuccess(res, req.schoolId, students);
}));

/**
 * PATCH /results/exam-allocations/:id  { invigilator_staff_id: uuid|null }
 */
router.patch('/exam-allocations/:id', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const staffId = req.body?.invigilator_staff_id ?? null;

  if (staffId) {
    const [staffRow] = await sql`
      SELECT id FROM staff WHERE id = ${staffId} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    `;
    if (!staffRow) return res.status(404).json({ error: 'Staff member not found' });
  }

  try {
    const [updated] = await sql`
      UPDATE exam_room_allocations
      SET invigilator_staff_id = ${staffId}
      WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
      RETURNING id, invigilator_staff_id
    `;
    if (!updated) return res.status(404).json({ error: 'Allocation not found' });
    return sendSuccess(res, req.schoolId, { message: 'Invigilator updated', allocation: updated });
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(400).json({ error: 'This staff member already invigilates another room in the same sitting' });
    }
    throw err;
  }
}));

/**
 * DELETE /results/exam-allocations/:id — only when the room has no seated students.
 */
router.delete('/exam-allocations/:id', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [hasSeats] = await sql`
    SELECT 1 FROM exam_seat_assignments
    WHERE room_allocation_id = ${id} AND deleted_at IS NULL LIMIT 1
  `;
  if (hasSeats) {
    return res.status(400).json({ error: 'Move the seated students out before removing this room' });
  }
  const [deleted] = await sql`
    UPDATE exam_room_allocations SET deleted_at = now()
    WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    RETURNING id
  `;
  if (!deleted) return res.status(404).json({ error: 'Allocation not found' });
  return sendSuccess(res, req.schoolId, { message: 'Room removed from sitting' });
}));

/**
 * POST /results/exam-seats/:id/move  { to_allocation_id }
 * Move one student to another room of the same sitting.
 */
router.post('/exam-seats/:id/move', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { to_allocation_id } = req.body || {};
  if (!to_allocation_id) return res.status(400).json({ error: 'to_allocation_id is required' });

  const [seat] = await sql`
    SELECT esa.id, esa.exam_id, esa.exam_date, esa.session_start, esa.room_allocation_id
    FROM exam_seat_assignments esa
    WHERE esa.id = ${id} AND esa.school_id = ${req.schoolId} AND esa.deleted_at IS NULL
  `;
  if (!seat) return res.status(404).json({ error: 'Seat not found' });
  if (String(seat.room_allocation_id) === String(to_allocation_id)) {
    return res.status(400).json({ error: 'Student is already in that room' });
  }

  const [target] = await sql`
    SELECT era.id, era.exam_id, era.exam_date, era.session_start, r.capacity,
           (SELECT COUNT(*)::int FROM exam_seat_assignments x
             WHERE x.room_allocation_id = era.id AND x.deleted_at IS NULL) AS seats_count,
           (SELECT COALESCE(MAX(x.seat_no), 0) FROM exam_seat_assignments x
             WHERE x.room_allocation_id = era.id AND x.deleted_at IS NULL) AS max_seat
    FROM exam_room_allocations era
    JOIN exam_rooms r ON era.room_id = r.id
    WHERE era.id = ${to_allocation_id} AND era.school_id = ${req.schoolId} AND era.deleted_at IS NULL
  `;
  if (!target) return res.status(404).json({ error: 'Target room allocation not found' });
  if (
    String(target.exam_id) !== String(seat.exam_id) ||
    String(target.exam_date) !== String(seat.exam_date) ||
    String(target.session_start) !== String(seat.session_start)
  ) {
    return res.status(400).json({ error: 'Target room belongs to a different sitting' });
  }
  if (target.seats_count >= target.capacity) {
    return res.status(400).json({ error: 'Target room is already full' });
  }

  const [moved] = await sql`
    UPDATE exam_seat_assignments
    SET room_allocation_id = ${to_allocation_id}, seat_no = ${Number(target.max_seat) + 1}
    WHERE id = ${id} AND school_id = ${req.schoolId}
    RETURNING id, room_allocation_id, seat_no
  `;
  return sendSuccess(res, req.schoolId, { message: 'Student moved', seat: moved });
}));

/**
 * GET /results/exam-timetable/my-duties
 * Staff read: invigilation duties for published exams.
 */
router.get('/exam-timetable/my-duties', requireAuth, asyncHandler(async (req, res) => {
  const [staff] = await sql`
    SELECT st.id
    FROM staff st
    JOIN persons p ON st.person_id = p.id
    JOIN users u ON u.person_id = p.id
    WHERE u.id = ${req.user.id} AND st.school_id = ${req.schoolId}
  `;
  if (!staff) {
    return res.status(404).json({ error: 'Staff profile not found' });
  }

  const duties = await sql`
    SELECT
      era.id, era.exam_date::text AS exam_date, era.session_start::text AS session_start,
      e.id AS exam_id, e.name AS exam_name, e.name_te AS exam_name_te, e.exam_type,
      r.name AS room_name,
      (SELECT COUNT(*)::int FROM exam_seat_assignments esa
        WHERE esa.room_allocation_id = era.id AND esa.deleted_at IS NULL) AS seats_count,
      (SELECT string_agg(DISTINCT c.name, ', ') FROM exam_seat_assignments esa
        JOIN classes c ON esa.class_id = c.id
        WHERE esa.room_allocation_id = era.id AND esa.deleted_at IS NULL) AS class_names,
      (SELECT MAX(es2.end_time)::text FROM exam_subjects es2
        WHERE es2.exam_id = e.id AND es2.exam_date = era.exam_date
          AND COALESCE(es2.start_time, '00:00'::time) = era.session_start
          AND es2.deleted_at IS NULL) AS session_end
    FROM exam_room_allocations era
    JOIN exams e ON era.exam_id = e.id
    JOIN exam_rooms r ON era.room_id = r.id
    WHERE era.school_id = ${req.schoolId}
      AND era.invigilator_staff_id = ${staff.id}
      AND era.deleted_at IS NULL
      AND e.deleted_at IS NULL
      AND e.status <> 'cancelled'
      AND e.timetable_published = TRUE
    ORDER BY era.exam_date, era.session_start
  `;
  return sendSuccess(res, req.schoolId, duties);
}));

/**
 * GET /results/exam-timetable/my-allocations?student_id=
 * Student/parent read: the student's room + seat for published exams.
 */
router.get('/exam-timetable/my-allocations', requireAuth, asyncHandler(async (req, res) => {
  const { student_id } = req.query;
  if (!student_id) return res.status(400).json({ error: 'student_id is required' });

  const [student] = await sql`
    SELECT id FROM students
    WHERE id = ${student_id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const seats = await sql`
    SELECT esa.exam_id, esa.exam_date::text AS exam_date,
           esa.session_start::text AS session_start,
           esa.seat_no, r.name AS room_name
    FROM exam_seat_assignments esa
    JOIN student_enrollments se ON esa.student_enrollment_id = se.id
    JOIN exam_room_allocations era ON esa.room_allocation_id = era.id
    JOIN exam_rooms r ON era.room_id = r.id
    JOIN exams e ON esa.exam_id = e.id
    WHERE esa.school_id = ${req.schoolId}
      AND se.student_id = ${student_id}
      AND esa.deleted_at IS NULL
      AND era.deleted_at IS NULL
      AND e.deleted_at IS NULL
      AND e.timetable_published = TRUE
    ORDER BY esa.exam_date, esa.session_start
  `;
  return sendSuccess(res, req.schoolId, seats);
}));

export default router;
