import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// ============== SUBJECTS ==============

/**
 * GET /results/subjects
 * List all subjects
 */
router.get('/subjects', requirePermission('exams.view'), asyncHandler(async (req, res) => {
  const subjects = await sql`
    SELECT id, name, code, description
    FROM subjects
    ORDER BY name
  `;
  res.json(subjects);
}));

/**
 * POST /results/subjects
 * Create a subject
 */
router.post('/subjects', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { name, code, description } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Subject name is required' });
  }

  const [subject] = await sql`
    INSERT INTO subjects (name, code, description)
    VALUES (${name}, ${code}, ${description})
    RETURNING *
  `;

  res.status(201).json({ message: 'Subject created', subject });
}));

/**
 * DELETE /results/subjects/:id
 * Delete a subject (if not linked to exams, classes, or LMS)
 */
router.delete('/subjects/:id', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  // 1. Check for Exam Subjects
  const [hasExams] = await sql`SELECT 1 FROM exam_subjects WHERE subject_id = ${id} LIMIT 1`;
  if (hasExams) {
    return res.status(400).json({ error: 'Cannot delete subject: Linked to one or more exams' });
  }

  // 2. Check for Class Subjects (mappings)
  const [hasClasses] = await sql`SELECT 1 FROM class_subjects WHERE subject_id = ${id} LIMIT 1`;
  if (hasClasses) {
    return res.status(400).json({ error: 'Cannot delete subject: Assigned to classes/sections' });
  }

  // 3. Check for LMS Materials
  const [hasLMS] = await sql`SELECT 1 FROM materials WHERE subject_id = ${id} LIMIT 1`;
  if (hasLMS) {
    return res.status(400).json({ error: 'Cannot delete subject: Linked to LMS materials' });
  }

  // 4. Check for Timetable Entries
  const [hasTimetable] = await sql`SELECT 1 FROM timetable_entries WHERE subject_id = ${id} LIMIT 1`;
  if (hasTimetable) {
    return res.status(400).json({ error: 'Cannot delete subject: Linked to timetable records' });
  }

  // 5. Check for Diary Entries
  const [hasDiary] = await sql`SELECT 1 FROM diary_entries WHERE subject_id = ${id} LIMIT 1`;
  if (hasDiary) {
    return res.status(400).json({ error: 'Cannot delete subject: Linked to diary/homework records' });
  }

  await sql`DELETE FROM subjects WHERE id = ${id}`;
  res.json({ message: 'Subject deleted successfully' });
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
      e.id, e.name, e.exam_type, e.start_date, e.end_date, e.status,
      ay.code as academic_year
    FROM exams e
    JOIN academic_years ay ON e.academic_year_id = ay.id
    WHERE TRUE
      ${academic_year_id ? sql`AND e.academic_year_id = ${academic_year_id}` : sql``}
      ${status ? sql`AND e.status = ${status}` : sql``}
    ORDER BY e.start_date DESC
  `;

  res.json(exams);
}));

/**
 * POST /results/exams
 * Create an exam
 */
router.post('/exams', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { name, academic_year_id, exam_type, start_date, end_date, status } = req.body;

  if (!name || !academic_year_id || !exam_type) {
    return res.status(400).json({ error: 'name, academic_year_id, and exam_type are required' });
  }

  const [exam] = await sql`
    INSERT INTO exams (name, academic_year_id, exam_type, start_date, end_date, status)
    VALUES (${name}, ${academic_year_id}, ${exam_type}, ${start_date}, ${end_date}, ${status || 'scheduled'})
    RETURNING *
  `;

  res.status(201).json({ message: 'Exam created', exam });
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
    WHERE e.id = ${id}
  `;

  if (!exam) {
    return res.status(404).json({ error: 'Exam not found' });
  }

  // Get exam subjects
  const subjects = await sql`
    SELECT 
      es.id, es.exam_date, es.max_marks, es.passing_marks,
      s.name as subject_name, s.code as subject_code,
      c.name as class_name
    FROM exam_subjects es
    JOIN subjects s ON es.subject_id = s.id
    JOIN classes c ON es.class_id = c.id
    WHERE es.exam_id = ${id}
    ORDER BY c.name, s.name
  `;

  res.json({ ...exam, subjects });
}));

/**
 * PUT /results/exams/:id
 * Update exam
 */
router.put('/exams/:id', requirePermission('exams.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, exam_type, start_date, end_date, status, academic_year_id } = req.body;

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
      name = COALESCE(${name}, name),
      academic_year_id = COALESCE(${academic_year_id}, academic_year_id),
      exam_type = COALESCE(${exam_type}, exam_type),
      start_date = COALESCE(${start_date}, start_date),
      end_date = COALESCE(${end_date}, end_date),
      status = COALESCE(${status}, status)
    WHERE id = ${id}
    RETURNING *
  `;

  if (!updated) {
    return res.status(404).json({ error: 'Exam not found' });
  }

  res.json({ message: 'Exam updated', exam: updated });
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

  await sql`DELETE FROM exams WHERE id = ${id}`;
  res.json({ message: 'Exam deleted successfully' });
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

  const [examSubject] = await sql`
    INSERT INTO exam_subjects (exam_id, subject_id, class_id, exam_date, max_marks, passing_marks)
    VALUES (${id}, ${subject_id}, ${class_id}, ${exam_date}, ${max_marks || 100}, ${passing_marks || 35})
    RETURNING *
  `;

  res.status(201).json({ message: 'Subject added to exam', exam_subject: examSubject });
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

  // Verify exam subject exists
  const [examSubject] = await sql`
    SELECT id, max_marks FROM exam_subjects WHERE id = ${exam_subject_id}
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

    try {
      // Upsert marks
      const [result] = await sql`
        INSERT INTO marks (exam_subject_id, student_enrollment_id, marks_obtained, is_absent, remarks, entered_by)
        VALUES (${exam_subject_id}, ${student_enrollment_id}, ${is_absent ? null : marks_obtained}, ${is_absent || false}, ${remarks}, ${enteredBy})
        ON CONFLICT (exam_subject_id, student_enrollment_id) 
        DO UPDATE SET 
          marks_obtained = EXCLUDED.marks_obtained,
          is_absent = EXCLUDED.is_absent,
          remarks = EXCLUDED.remarks,
          entered_by = EXCLUDED.entered_by
        RETURNING id
      `;
      results.push({ student_enrollment_id, id: result.id, success: true });
    } catch (err) {
      results.push({ student_enrollment_id, error: err.message });
    }
  }

  res.json({ message: 'Marks uploaded', results });
}));

/**
 * GET /results/marks/student/:studentId
 * Get marks for a student
 */
router.get('/marks/student/:studentId', requirePermission('marks.view'), asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { exam_id, academic_year_id } = req.query;

  let marksQuery;
  if (exam_id) {
    marksQuery = await sql`
      SELECT 
        m.id, m.marks_obtained, m.is_absent, m.remarks,
        s.name as subject_name, s.code as subject_code,
        es.max_marks, es.passing_marks,
        e.name as exam_name
      FROM marks m
      JOIN exam_subjects es ON m.exam_subject_id = es.id
      JOIN subjects s ON es.subject_id = s.id
      JOIN exams e ON es.exam_id = e.id
      JOIN student_enrollments se ON m.student_enrollment_id = se.id
      WHERE se.student_id = ${studentId}
        AND es.exam_id = ${exam_id}
      ORDER BY s.name
    `;
  } else {
    marksQuery = await sql`
      SELECT 
        m.id, m.marks_obtained, m.is_absent,
        s.name as subject_name,
        es.max_marks, es.passing_marks,
        e.name as exam_name, e.exam_type,
        ay.code as academic_year
      FROM marks m
      JOIN exam_subjects es ON m.exam_subject_id = es.id
      JOIN subjects s ON es.subject_id = s.id
      JOIN exams e ON es.exam_id = e.id
      JOIN academic_years ay ON e.academic_year_id = ay.id
      JOIN student_enrollments se ON m.student_enrollment_id = se.id
      WHERE se.student_id = ${studentId}
        ${academic_year_id ? sql`AND e.academic_year_id = ${academic_year_id}` : sql``}
      ORDER BY ay.start_date DESC, e.start_date DESC, s.name
    `;
  }

  res.json(marksQuery);
}));

/**
 * GET /results/marks/class/:classId/exam/:examId
 * Get marks for a class in an exam
 */
router.get('/marks/class/:classId/exam/:examId', requirePermission('marks.view'), asyncHandler(async (req, res) => {
  const { classId, examId } = req.params;
  const { subject_id } = req.query;

  let marks;
  if (subject_id) {
    // Marks for specific subject
    marks = await sql`
      SELECT 
        m.id, m.marks_obtained, m.is_absent, m.remarks,
        s.id as student_id, s.admission_no,
        p.display_name as student_name,
        sub.name as subject_name,
        es.max_marks, es.passing_marks
      FROM marks m
      JOIN exam_subjects es ON m.exam_subject_id = es.id
      JOIN subjects sub ON es.subject_id = sub.id
      JOIN student_enrollments se ON m.student_enrollment_id = se.id
      JOIN students s ON se.student_id = s.id
      JOIN persons p ON s.person_id = p.id
      JOIN class_sections cs ON se.class_section_id = cs.id
      WHERE cs.class_id = ${classId}
        AND es.exam_id = ${examId}
        AND es.subject_id = ${subject_id}
        AND se.status = 'active'
      ORDER BY p.display_name
    `;
  } else {
    // All subjects for the class
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
      JOIN student_enrollments se ON s.id = se.student_id
      JOIN class_sections cs ON se.class_section_id = cs.id
      LEFT JOIN marks m ON m.student_enrollment_id = se.id
      LEFT JOIN exam_subjects es ON m.exam_subject_id = es.id AND es.exam_id = ${examId}
      LEFT JOIN subjects sub ON es.subject_id = sub.id
      WHERE cs.class_id = ${classId}
        AND se.status = 'active'
        AND s.deleted_at IS NULL
      GROUP BY s.id, s.admission_no, p.display_name
      ORDER BY p.display_name
    `;
  }

  res.json(marks);
}));

/**
 * PUT /results/marks/:id
 * Update a mark entry
 */
router.put('/marks/:id', requirePermission('marks.enter'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { marks_obtained, is_absent, remarks } = req.body;

  const [updated] = await sql`
    UPDATE marks
    SET 
      marks_obtained = ${is_absent ? null : marks_obtained},
      is_absent = COALESCE(${is_absent}, is_absent),
      remarks = COALESCE(${remarks}, remarks),
      entered_by = ${req.user?.internal_id}
    WHERE id = ${id}
    RETURNING *
  `;

  if (!updated) {
    return res.status(404).json({ error: 'Mark entry not found' });
  }

  res.json({ message: 'Mark updated', mark: updated });
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
    WHERE s.id = ${studentId} AND s.deleted_at IS NULL
  `;

  if (!student) {
    return res.status(404).json({ error: 'Student not found' });
  }

  // Get exam results
  let results;
  if (exam_id) {
    results = await sql`
      SELECT 
        e.id as exam_id, e.name as exam_name, e.exam_type,
        json_agg(json_build_object(
          'subject', sub.name,
          'marks_obtained', m.marks_obtained,
          'max_marks', es.max_marks,
          'passing_marks', es.passing_marks,
          'is_absent', m.is_absent,
          'percentage', CASE WHEN m.is_absent THEN 0 ELSE ROUND((m.marks_obtained / es.max_marks) * 100, 2) END,
          'passed', CASE WHEN m.is_absent THEN false ELSE m.marks_obtained >= es.passing_marks END
        ) ORDER BY sub.name) as subjects,
        SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END) as total_obtained,
        SUM(es.max_marks) as total_max,
        ROUND(SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END)::numeric / NULLIF(SUM(es.max_marks), 0) * 100, 2) as percentage
      FROM exams e
      JOIN exam_subjects es ON e.id = es.exam_id
      JOIN subjects sub ON es.subject_id = sub.id
      LEFT JOIN marks m ON m.exam_subject_id = es.id
      LEFT JOIN student_enrollments se ON m.student_enrollment_id = se.id AND se.student_id = ${studentId}
      WHERE e.id = ${exam_id}
      GROUP BY e.id, e.name, e.exam_type
    `;
  } else {
    results = await sql`
      SELECT 
        e.id as exam_id, e.name as exam_name, e.exam_type,
        ay.code as academic_year,
        COUNT(DISTINCT es.subject_id) as subjects_count,
        SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END) as total_obtained,
        SUM(es.max_marks) as total_max,
        ROUND(SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END)::numeric / NULLIF(SUM(es.max_marks), 0) * 100, 2) as percentage
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

  // Get grade based on percentage
  const getGrade = async (percentage) => {
    const [grade] = await sql`
      SELECT grade, grade_point FROM grading_scales
      WHERE ${percentage} >= min_percentage AND ${percentage} < max_percentage
      LIMIT 1
    `;
    return grade;
  };

  res.json({ student, results });
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

  // Get exam and class info
  const [exam] = await sql`SELECT name, exam_type FROM exams WHERE id = ${exam_id}`;
  const [classSection] = await sql`
    SELECT c.name as class_name, s.name as section_name
    FROM class_sections cs
    JOIN classes c ON cs.class_id = c.id
    JOIN sections s ON cs.section_id = s.id
    WHERE cs.id = ${class_section_id}
  `;

  // Get all students with their results
  const results = await sql`
    SELECT 
      st.id as student_id, st.admission_no,
      p.display_name as student_name,
      json_agg(json_build_object(
        'subject', sub.name,
        'marks_obtained', m.marks_obtained,
        'max_marks', es.max_marks,
        'is_absent', m.is_absent
      ) ORDER BY sub.name) as subjects,
      SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END) as total_obtained,
      SUM(es.max_marks) as total_max,
      ROUND(SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END)::numeric / NULLIF(SUM(es.max_marks), 0) * 100, 2) as percentage
    FROM student_enrollments se
    JOIN students st ON se.student_id = st.id
    JOIN persons p ON st.person_id = p.id
    LEFT JOIN marks m ON m.student_enrollment_id = se.id
    LEFT JOIN exam_subjects es ON m.exam_subject_id = es.id AND es.exam_id = ${exam_id}
    LEFT JOIN subjects sub ON es.subject_id = sub.id
    WHERE se.class_section_id = ${class_section_id}
      AND se.status = 'active'
      AND st.deleted_at IS NULL
    GROUP BY st.id, st.admission_no, p.display_name
    ORDER BY percentage DESC NULLS LAST
  `;

  // Add rank
  const rankedResults = results.map((r, index) => ({
    ...r,
    rank: index + 1
  }));

  res.json({
    exam: exam?.name,
    exam_type: exam?.exam_type,
    class: classSection?.class_name,
    section: classSection?.section_name,
    total_students: rankedResults.length,
    results: rankedResults
  });
}));

export default router;
