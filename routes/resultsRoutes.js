import express from 'express';
import sql from '../db.js';
import { requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { translateFields } from '../services/geminiTranslator.js';

const router = express.Router();

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
      e.id, e.name, e.name_te, e.exam_type, e.start_date, e.end_date, e.status,
      ay.code as academic_year
    FROM exams e
    JOIN academic_years ay ON e.academic_year_id = ay.id
    WHERE e.school_id = ${req.schoolId}
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
 * Delete an exam (only if no marks recorded)
 */
router.delete('/exams/:id', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  // 1. Check for recorded marks
  const [hasMarks] = await sql`
        SELECT 1 FROM marks m
        JOIN exam_subjects es ON m.exam_subject_id = es.id
        WHERE es.exam_id = ${id} LIMIT 1
    `;
  if (hasMarks) {
    return res.status(400).json({ error: 'Cannot delete exam: Student marks have already been recorded' });
  }

  // 2. Clear exam subjects (Cascade handles this usually, but let's be explicit if needed, 
  // though schema has ON DELETE CASCADE on exam_id in exam_subjects)

  await sql`DELETE FROM exams WHERE id = ${id} AND school_id = ${req.schoolId} AND school_id = ${req.schoolId}`;
  return sendSuccess(res, req.schoolId, { message: 'Exam deleted successfully' });
}));

/**
 * POST /results/exams/:id/subjects
 * Add subjects to exam
 */
router.post('/exams/:id/subjects', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { subject_id, class_id, exam_date, max_marks, passing_marks } = req.body;

  if (!subject_id || !class_id) {
    return res.status(400).json({ error: 'subject_id and class_id are required' });
  }

  // RES3 FIX: Verify exam ownership
  const [examCheck] = await sql`SELECT id FROM exams WHERE id = ${id} AND school_id = ${req.schoolId}`;
  if (!examCheck) {
    return res.status(404).json({ error: 'Exam not found' });
  }

  // RES3 FIX: Add school_id to exam_subjects INSERT
  const [examSubject] = await sql`
    INSERT INTO exam_subjects (school_id, exam_id, subject_id, class_id, exam_date, max_marks, passing_marks)
    VALUES (${req.schoolId}, ${id}, ${subject_id}, ${class_id}, ${exam_date ?? null}, ${max_marks || 100}, ${passing_marks || 35})
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Subject added to exam', exam_subject: examSubject }, 201);
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
    SELECT es.id, es.max_marks, es.exam_id, e.school_id
    FROM exam_subjects es
    JOIN exams e ON es.exam_id = e.id
    WHERE es.id = ${exam_subject_id}
      AND es.school_id = ${req.schoolId}
      AND e.school_id = ${req.schoolId}
  `;

  if (!examSubject) {
    return res.status(404).json({ error: 'Exam subject not found' });
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

  // 3. Send Notification (Async)
  (async () => {
    try {
      const { sendNotificationToUsers } = await import('../services/notificationService.js');

      // a. Fetch Exam Status
      const [exam] = await sql`
        SELECT e.name, e.status
        FROM exams e
        JOIN exam_subjects es ON e.id = es.exam_id
        WHERE es.id = ${exam_subject_id}
      `;

      if (!exam || exam.status !== 'published') return;

      // b. Identify Affected Students (Only NEW inserts)
      const successEnrollmentIds = results.
        filter((r) => r.success && r.isNew).
        map((r) => r.student_enrollment_id);

      if (successEnrollmentIds.length === 0) return;

      // c. Resolve User IDs (Students & Parents)
      const usersToNotify = await sql`
        -- Student Users
        SELECT u.id as user_id 
        FROM users u
        JOIN students s ON u.person_id = s.person_id
        JOIN student_enrollments se ON s.id = se.student_id
        WHERE se.id IN ${sql(successEnrollmentIds)}
          AND u.account_status = 'active'

        UNION

        -- Parent Users
        SELECT u.id as user_id
        FROM users u
        JOIN parents p ON u.person_id = p.person_id
        JOIN student_parents sp ON p.id = sp.parent_id
        JOIN students s ON sp.student_id = s.id
        JOIN student_enrollments se ON s.id = se.student_id
        WHERE se.id IN ${sql(successEnrollmentIds)}
          AND u.account_status = 'active'
      `;

      const userIds = usersToNotify.map((u) => u.user_id);

      await sendNotificationToUsers(
        userIds,
        'RESULT_RELEASED',
        { message: `Results for ${exam.name} are now available.` }
      );

    } catch (err) {

    }
  })();

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
        s.id as student_id, s.admission_no,
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
      ORDER BY p.display_name
    `;
  } else {
    marks = await sql`
      SELECT 
        s.id as student_id, s.admission_no,
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
        AND s.school_id = ${req.schoolId}
      GROUP BY s.id, s.admission_no, p.display_name
      ORDER BY p.display_name
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
    SELECT m.id FROM marks m
    JOIN exam_subjects es ON m.exam_subject_id = es.id
    WHERE m.id = ${id} AND es.school_id = ${req.schoolId}
  `;
  if (!markCheck) {
    return res.status(404).json({ error: 'Mark entry not found' });
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
    results = await sql`
      SELECT 
        e.id as exam_id, e.name as exam_name, e.name_te as exam_name_te, e.exam_type,
        json_agg(json_build_object(
          'subject', sub.name,
          'marks_obtained', m.marks_obtained,
          'max_marks', es.max_marks,
          'passing_marks', es.passing_marks,
          'is_absent', m.is_absent,
          'remarks', m.remarks,
          'percentage', CASE WHEN m.is_absent THEN 0 ELSE ROUND((m.marks_obtained / es.max_marks) * 100, 2) END,
          'passed', CASE WHEN m.is_absent THEN false ELSE m.marks_obtained >= es.passing_marks END
        ) ORDER BY sub.name) as subjects,
        SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END) as total_obtained,
        SUM(es.max_marks) as total_max,
        ROUND(CAST(SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END) AS NUMERIC) / NULLIF(SUM(es.max_marks), 0) * 100, 2) as percentage
      FROM exams e
      JOIN exam_subjects es ON e.id = es.exam_id
      JOIN subjects sub ON es.subject_id = sub.id
      LEFT JOIN marks m ON m.exam_subject_id = es.id 
        AND m.student_enrollment_id IN (
          SELECT id FROM student_enrollments WHERE student_id = ${studentId}
        )
      WHERE e.id = ${exam_id}
      GROUP BY e.id, e.name, e.exam_type
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
    SELECT c.name as class_name, s.name as section_name
    FROM class_sections cs
    JOIN classes c ON cs.class_id = c.id
    JOIN sections s ON cs.section_id = s.id
    WHERE cs.id = ${class_section_id}
      AND cs.school_id = ${req.schoolId}
      AND c.school_id = ${req.schoolId}
      AND s.school_id = ${req.schoolId}
  `;

  // Get all students with their results
  const results = await sql`
    SELECT 
      st.id as student_id, st.admission_no,
      p.display_name as student_name,
      json_agg(json_build_object(
        'subject', sub.name,
        'marks_obtained', m.marks_obtained,
        'is_absent', m.is_absent,
        'remarks', m.remarks,
        'max_marks', es.max_marks
      ) ORDER BY sub.name) as subjects,
      SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END) as total_obtained,
      SUM(es.max_marks) as total_max,
      ROUND(SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END)::numeric / NULLIF(SUM(es.max_marks), 0) * 100, 2) as percentage
    FROM student_enrollments se
    JOIN students st ON se.student_id = st.id
    JOIN persons p ON st.person_id = p.id
    LEFT JOIN marks m ON m.student_enrollment_id = se.id
      AND m.school_id = ${req.schoolId}
    LEFT JOIN exam_subjects es ON m.exam_subject_id = es.id
      AND es.exam_id = ${exam_id}
      AND es.school_id = ${req.schoolId}
    LEFT JOIN subjects sub ON es.subject_id = sub.id
    WHERE se.class_section_id = ${class_section_id}
      AND se.school_id = ${req.schoolId}
      AND se.status = 'active'
      AND st.deleted_at IS NULL
      AND st.school_id = ${req.schoolId}
    GROUP BY st.id, st.admission_no, p.display_name
    ORDER BY percentage DESC NULLS LAST
  `;

  // Add rank
  const rankedResults = results.map((r, index) => ({
    ...r,
    rank: index + 1
  }));

  return sendSuccess(res, req.schoolId, {
    exam: exam?.name,
    exam_type: exam?.exam_type,
    class: classSection?.class_name,
    section: classSection?.section_name,
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

  // 2. Find Exam (B2: school_id scoped)
  const [exam] = await sql`
    SELECT id 
    FROM exams 
    WHERE academic_year_id = ${academic_year_id}
      AND exam_type = ${exam_category}
      AND name = ${sub_exam}
      AND school_id = ${req.schoolId}
    LIMIT 1
  `;

  if (!exam) {
    return sendSuccess(res, req.schoolId, { marks: [], max_marks: 100 }); // Exam doesn't exist yet, return empty
  }

  // 3. Find Exam Subject (B2: school_id scoped)
  const [examSubject] = await sql`
    SELECT id, max_marks
    FROM exam_subjects
    WHERE exam_id = ${exam.id}
      AND subject_id = ${subject_id}
      AND class_id = ${class_id}
      AND school_id = ${req.schoolId}
    LIMIT 1
  `;

  if (!examSubject) {
    return sendSuccess(res, req.schoolId, { marks: [], max_marks: 100 }); // Exam exists but subject not linked, return empty
  }

  // 4. Fetch Marks for enrolled students (B2: scoped via student_enrollments)
  const marks = await sql`
    SELECT 
      se.student_id,
      m.marks_obtained,
      m.is_absent,
      m.remarks
    FROM student_enrollments se
    JOIN marks m ON m.student_enrollment_id = se.id AND m.school_id = ${req.schoolId}
    WHERE se.class_section_id = ${class_section_id}
      AND se.school_id = ${req.schoolId}
      AND m.exam_subject_id = ${examSubject.id}
      AND se.status = 'active'
  `;

  return sendSuccess(res, req.schoolId, {
    marks,
    max_marks: examSubject.max_marks || 100
  });
}));

/**
 * POST /results/upload
 * Dynamic Results Upload Endpoint
 * Handles on-the-fly creation of exams and exam_subjects if they don't exist
 */
router.post('/upload', requirePermission('marks.enter'), asyncHandler(async (req, res) => {
  const { class_section_id, exam_category, sub_exam, subject_id, results, max_marks } = req.body;

  if (!class_section_id || !exam_category || !sub_exam || !subject_id || !results || !Array.isArray(results)) {
    return res.status(400).json({
      error: 'Missing required fields: class_section_id, exam_category, sub_exam, subject_id, results (array)'
    });
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
    SELECT id, name, exam_type 
    FROM exams 
    WHERE academic_year_id = ${academic_year_id}
      AND exam_type = ${exam_category}
      AND name = ${sub_exam}
      AND school_id = ${req.schoolId}
    LIMIT 1
  `;

  if (!exam) {
    let autoNameTe = null;
    try { const te = await translateFields({ name: sub_exam }); autoNameTe = te.name || null; } catch (e) {}
    [exam] = await sql`
      INSERT INTO exams (school_id, name, name_te, academic_year_id, exam_type, start_date, status)
      VALUES (${req.schoolId}, ${sub_exam}, ${autoNameTe}, ${academic_year_id}, ${exam_category}, CURRENT_DATE, 'ongoing')
      RETURNING id, name, exam_type
    `;
  }

  // 3. Find or Create Exam Subject (B2: school_id scoped)
  let [examSubject] = await sql`
    SELECT id, max_marks
    FROM exam_subjects
    WHERE exam_id = ${exam.id}
      AND subject_id = ${subject_id}
      AND class_id = ${class_id}
      AND school_id = ${req.schoolId}
    LIMIT 1
  `;

  const targetMaxMarks = max_marks ? Number(max_marks) : 100;
  const targetPassingMarks = Math.ceil(targetMaxMarks * 0.35); // 35% passing

  if (!examSubject) {
    [examSubject] = await sql`
      INSERT INTO exam_subjects (school_id, exam_id, subject_id, class_id, max_marks, passing_marks)
      VALUES (${req.schoolId}, ${exam.id}, ${subject_id}, ${class_id}, ${targetMaxMarks}, ${targetPassingMarks})
      RETURNING id, max_marks
    `;
  } else if (examSubject.max_marks !== targetMaxMarks) {
    // Update max_marks if different
    [examSubject] = await sql`
      UPDATE exam_subjects
      SET max_marks = ${targetMaxMarks}, passing_marks = ${targetPassingMarks}
      WHERE id = ${examSubject.id}
      AND school_id = ${req.schoolId}
      RETURNING id, max_marks
    `;
  }

  // 4. Process Results (Bulk Upsert Marks)
  const enteredBy = req.user?.internal_id;
  const processedResults = [];

  for (const r of results) {
    const { student_id, marks } = r;

    // We need student_enrollment_id, not student_id directly for the marks table
    // But we have student_id and class_section_id
    const [enrollment] = await sql`
      SELECT id 
      FROM student_enrollments 
      WHERE student_id = ${student_id} 
        AND class_section_id = ${class_section_id}
        AND school_id = ${req.schoolId}
        AND status = 'active'
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
        INSERT INTO marks (school_id, exam_subject_id, student_enrollment_id, marks_obtained, is_absent, entered_by)
        VALUES (
          ${req.schoolId},
          ${examSubject.id}, 
          ${enrollment.id}, 
          ${marks}, 
          ${marks === null},
          ${enteredBy}
        )
        ON CONFLICT (school_id, exam_subject_id, student_enrollment_id)
        DO UPDATE SET
          marks_obtained = EXCLUDED.marks_obtained,
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

  // 5. Send Notification (Async)
  (async () => {
    try {
      const { sendNotificationToUsers } = await import('../services/notificationService.js');

      const successEnrollmentIds = processedResults.
        filter((r) => r.success && r.isNew).
        map((r) => r.enrollment_id);

      if (successEnrollmentIds.length === 0) return;

      const usersToNotify = await sql`
        SELECT u.id as user_id 
        FROM users u
        JOIN students s ON u.person_id = s.person_id
        JOIN student_enrollments se ON s.id = se.student_id
        WHERE se.id IN ${sql(successEnrollmentIds)}
          AND u.account_status = 'active'
        UNION
        SELECT u.id as user_id
        FROM users u
        JOIN parents p ON u.person_id = p.person_id
        JOIN student_parents sp ON p.id = sp.parent_id
        JOIN students s ON sp.student_id = s.id
        JOIN student_enrollments se ON s.id = se.student_id
        WHERE se.id IN ${sql(successEnrollmentIds)}
          AND u.account_status = 'active'
      `;

      const userIds = usersToNotify.map((u) => u.user_id);
      if (userIds.length > 0) {
        await sendNotificationToUsers(
          userIds,
          'RESULT_RELEASED',
          { message: `Results for ${exam.name} are now available.` }
        );
      }
    } catch (err) {

    }
  })();

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

export default router;