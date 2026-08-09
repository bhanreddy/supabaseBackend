import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ACTIVE_STUDENT_STATUS_ID } from '../utils/activeStudentFilter.js';

const router = express.Router();

/** Remove soft-deleted rows that still hold FK references to a class-section mapping. */
async function purgeSoftDeletedClassSectionDeps(tx, classSectionId, schoolId) {
  await tx`
    DELETE FROM timetable_slots
    WHERE class_section_id = ${classSectionId} AND school_id = ${schoolId} AND deleted_at IS NOT NULL
  `;
  await tx`
    DELETE FROM class_subjects
    WHERE class_section_id = ${classSectionId} AND school_id = ${schoolId} AND deleted_at IS NOT NULL
  `;
  await tx`
    DELETE FROM diary_entries
    WHERE class_section_id = ${classSectionId} AND school_id = ${schoolId} AND deleted_at IS NOT NULL
  `;
  await tx`
    DELETE FROM student_enrollments
    WHERE class_section_id = ${classSectionId} AND school_id = ${schoolId} AND deleted_at IS NOT NULL
  `;
  await tx`
    DELETE FROM timetable_entries
    WHERE class_section_id = ${classSectionId} AND school_id = ${schoolId}
  `;
}

/** Remove soft-deleted rows that still hold FK references to a class. */
async function purgeSoftDeletedClassDeps(tx, classId, schoolId) {
  await tx`
    DELETE FROM student_fees sf
    USING fee_structures fs
    WHERE sf.fee_structure_id = fs.id
      AND fs.class_id = ${classId}
      AND fs.school_id = ${schoolId}
      AND fs.deleted_at IS NOT NULL
  `;
  await tx`
    DELETE FROM fee_structures
    WHERE class_id = ${classId} AND school_id = ${schoolId} AND deleted_at IS NOT NULL
  `;
  await tx`
    DELETE FROM exam_subjects
    WHERE class_id = ${classId} AND school_id = ${schoolId} AND deleted_at IS NOT NULL
  `;
  await tx`
    DELETE FROM lms_courses
    WHERE class_id = ${classId} AND school_id = ${schoolId} AND deleted_at IS NOT NULL
  `;
}

// ============== CLASSES ==============

router.get('/classes', requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const classes = await sql`
    SELECT id, name, code, sort_order
    FROM classes
    WHERE school_id = ${req.schoolId}
      AND deleted_at IS NULL
    ORDER BY sort_order ASC, name ASC
  `;
  return sendSuccess(res, req.schoolId, classes);
}));

router.post('/classes', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { name, code } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Class name is required' });
  }

  const [maxRow] = await sql`
    SELECT COALESCE(MAX(sort_order), 0) AS max_order
    FROM classes
    WHERE school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  const sort_order = maxRow.max_order + 1;

  const [newClass] = await sql`
    INSERT INTO classes (school_id, name, code, sort_order)
    VALUES (${req.schoolId}, ${name}, ${code}, ${sort_order})
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Class created', class: newClass }, 201);
}));

router.put('/classes/reorder', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { class_ids: classIds } = req.body;
  const schoolId = req.schoolId;

  if (!Array.isArray(classIds) || classIds.length === 0) {
    return res.status(400).json({ error: 'class_ids array is required' });
  }

  const existing = await sql`
    SELECT id FROM classes
    WHERE school_id = ${schoolId} AND deleted_at IS NULL
  `;
  const existingIds = new Set(existing.map((c) => c.id));

  if (classIds.length !== existingIds.size) {
    return res.status(400).json({ error: 'class_ids must include every class for this school' });
  }

  for (const id of classIds) {
    if (!existingIds.has(id)) {
      return res.status(400).json({ error: 'Invalid class id in reorder list' });
    }
  }

  await sql.begin(async (tx) => {
    for (let i = 0; i < classIds.length; i++) {
      await tx`
        UPDATE classes
        SET sort_order = ${i + 1}
        WHERE id = ${classIds[i]} AND school_id = ${schoolId}
      `;
    }
  });

  const classes = await sql`
    SELECT id, name, code, sort_order
    FROM classes
    WHERE school_id = ${schoolId} AND deleted_at IS NULL
    ORDER BY sort_order ASC, name ASC
  `;

  return sendSuccess(res, schoolId, classes);
}));

router.delete('/classes/:id', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

  // Ownership check
  const [cls] = await sql`SELECT id FROM classes WHERE id = ${id} AND school_id = ${schoolId}`;
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const [hasSections] = await sql`
    SELECT 1 FROM class_sections
    WHERE class_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (hasSections) return res.status(400).json({ error: 'Cannot delete class: Linked to active class-sections' });

  const [hasFees] = await sql`
    SELECT 1 FROM fee_structures
    WHERE class_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (hasFees) return res.status(400).json({ error: 'Cannot delete class: Financial fee structures are defined for this class' });

  const [hasExams] = await sql`
    SELECT 1 FROM exam_subjects
    WHERE class_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (hasExams) return res.status(400).json({ error: 'Cannot delete class: Linked to exam subjects' });

  const [hasLMS] = await sql`
    SELECT 1 FROM lms_courses
    WHERE class_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (hasLMS) return res.status(400).json({ error: 'Cannot delete class: Linked to LMS courses' });

  const [hasNotices] = await sql`SELECT 1 FROM notices WHERE target_class_id = ${id} AND school_id = ${req.schoolId} LIMIT 1`;
  if (hasNotices) return res.status(400).json({ error: 'Cannot delete class: Targeted in active announcements' });

  await sql.begin(async (tx) => {
    await purgeSoftDeletedClassDeps(tx, id, schoolId);
    await tx`DELETE FROM classes WHERE id = ${id} AND school_id = ${schoolId}`;
  });
  return sendSuccess(res, req.schoolId, { message: 'Class deleted successfully' });
}));

// ============== SECTIONS ==============

router.get('/sections', requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const sections = await sql`
    SELECT id, name, code
    FROM sections
    WHERE school_id = ${req.schoolId}
    ORDER BY name
  `;
  return sendSuccess(res, req.schoolId, sections);
}));

router.post('/sections', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { name, code } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Section name is required' });
  }

  const [newSection] = await sql`
    INSERT INTO sections (school_id, name, code)
    VALUES (${req.schoolId}, ${name}, ${code})
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Section created', section: newSection }, 201);
}));

router.delete('/sections/:id', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

  // Ownership check
  const [sec] = await sql`SELECT id FROM sections WHERE id = ${id} AND school_id = ${schoolId}`;
  if (!sec) return res.status(404).json({ error: 'Section not found' });

  const [hasMappings] = await sql`
    SELECT 1 FROM class_sections
    WHERE section_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (hasMappings) return res.status(400).json({ error: 'Cannot delete section: Linked to active class-sections in one or more academic years' });

  await sql`DELETE FROM sections WHERE id = ${id} AND school_id = ${schoolId} AND school_id = ${req.schoolId}`;
  return sendSuccess(res, req.schoolId, { message: 'Section deleted successfully' });
}));

// ============== ACADEMIC YEARS ==============

router.get('/academic-years', requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const years = await sql`
    SELECT id, code, start_date, end_date,
           CASE WHEN NOW() BETWEEN start_date AND end_date THEN true ELSE false END as is_current
    FROM academic_years
    WHERE school_id = ${req.schoolId}
    ORDER BY start_date DESC
  `;
  return sendSuccess(res, req.schoolId, years);
}));

router.post('/academic-years', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { code, start_date, end_date } = req.body;

  if (!code || !start_date || !end_date) {
    return res.status(400).json({ error: 'Code, start_date, and end_date are required' });
  }

  const [newYear] = await sql`
    INSERT INTO academic_years (school_id, code, start_date, end_date)
    VALUES (${req.schoolId}, ${code}, ${start_date}, ${end_date})
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Academic year created', academic_year: newYear }, 201);
}));

router.delete('/academic-years/:id', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

  // Ownership check
  const [yr] = await sql`SELECT id FROM academic_years WHERE id = ${id} AND school_id = ${schoolId}`;
  if (!yr) return res.status(404).json({ error: 'Academic year not found' });

  const [hasMappings] = await sql`
    SELECT 1 FROM class_sections
    WHERE academic_year_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (hasMappings) return res.status(400).json({ error: 'Cannot delete academic year: Class mappings exist for this year' });

  const [hasEnrollments] = await sql`
    SELECT 1 FROM student_enrollments
    WHERE academic_year_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (hasEnrollments) return res.status(400).json({ error: 'Cannot delete academic year: Existing student enrollments found' });

  const [hasFees] = await sql`
    SELECT 1 FROM fee_structures
    WHERE academic_year_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (hasFees) return res.status(400).json({ error: 'Cannot delete academic year: Linked fee structures exist' });

  const [hasExams] = await sql`
    SELECT 1 FROM exams
    WHERE academic_year_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (hasExams) return res.status(400).json({ error: 'Cannot delete academic year: Linked exams exist' });

  const [hasTransport] = await sql`SELECT 1 FROM student_transport WHERE academic_year_id = ${id} AND school_id = ${req.schoolId} LIMIT 1`;
  if (hasTransport) return res.status(400).json({ error: 'Cannot delete academic year: Linked transport assignments exist' });

  const [hasHostel] = await sql`SELECT 1 FROM hostel_allocations WHERE academic_year_id = ${id} AND school_id = ${req.schoolId} LIMIT 1`;
  if (hasHostel) return res.status(400).json({ error: 'Cannot delete academic year: Linked hostel allocations exist' });

  await sql`DELETE FROM academic_years WHERE id = ${id} AND school_id = ${schoolId} AND school_id = ${req.schoolId}`;
  return sendSuccess(res, req.schoolId, { message: 'Academic year deleted successfully' });
}));

// ============== CLASS SECTIONS ==============

/**
 * GET /academics/class-sections
 * AC1: Both query branches now filter by school_id via academic_years join.
 */
router.get('/class-sections', requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const { academic_year_id } = req.query;
  const schoolId = req.schoolId;

  let classSections;
  if (academic_year_id) {
    classSections = await sql`
      SELECT cs.id, c.name as class_name, c.id as class_id,
             s.name as section_name, s.id as section_id,
             ay.code as academic_year, ay.id as academic_year_id,
             cs.class_teacher_id, p_teacher.display_name as class_teacher_name
      FROM class_sections cs
      JOIN classes c ON cs.class_id = c.id
      JOIN sections s ON cs.section_id = s.id
      JOIN academic_years ay ON cs.academic_year_id = ay.id
      LEFT JOIN staff st ON cs.class_teacher_id = st.id
      LEFT JOIN persons p_teacher ON st.person_id = p_teacher.id
      WHERE cs.academic_year_id = ${academic_year_id}
        AND cs.school_id = ${schoolId}
      ORDER BY c.name, s.name
    `;
  } else {
    classSections = await sql`
      SELECT cs.id, c.name as class_name, c.id as class_id,
             s.name as section_name, s.id as section_id,
             ay.code as academic_year, ay.id as academic_year_id,
             cs.class_teacher_id, p_teacher.display_name as class_teacher_name
      FROM class_sections cs
      JOIN classes c ON cs.class_id = c.id
      JOIN sections s ON cs.section_id = s.id
      JOIN academic_years ay ON cs.academic_year_id = ay.id
      LEFT JOIN staff st ON cs.class_teacher_id = st.id
      LEFT JOIN persons p_teacher ON st.person_id = p_teacher.id
      WHERE cs.school_id = ${schoolId}
      ORDER BY ay.start_date DESC, c.name, s.name
    `;
  }

  return sendSuccess(res, req.schoolId, classSections);
}));

router.post('/class-sections', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { class_id, section_id, academic_year_id, class_teacher_id } = req.body;

  if (!class_id || !section_id || !academic_year_id) {
    return res.status(400).json({ error: 'class_id, section_id, and academic_year_id are required' });
  }

  const [newMapping] = await sql`
    INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id, class_teacher_id)
    VALUES (${req.schoolId}, ${class_id}, ${section_id}, ${academic_year_id}, ${class_teacher_id || null})
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Class-section created', class_section: newMapping }, 201);
}));

/**
 * DELETE /academics/class-sections/:id
 * AC2: Ownership check — verify the class_section belongs to this school before deleting.
 */
router.delete('/class-sections/:id', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

  // AC2: Ownership check
  const [cs] = await sql`SELECT id FROM class_sections WHERE id = ${id} AND school_id = ${schoolId}`;
  if (!cs) return res.status(404).json({ error: 'Class-section not found' });

  const [hasEnrollments] = await sql`
    SELECT 1 FROM student_enrollments
    WHERE class_section_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (hasEnrollments) return res.status(400).json({ error: 'Cannot delete mapping: Students are enrolled in this class-section' });

  const [hasSubjects] = await sql`
    SELECT 1 FROM class_subjects
    WHERE class_section_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (hasSubjects) return res.status(400).json({ error: 'Cannot delete mapping: Subjects are assigned to this class-section' });

  const [hasDiary] = await sql`
    SELECT 1 FROM diary_entries
    WHERE class_section_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (hasDiary) return res.status(400).json({ error: 'Cannot delete mapping: Diary/Homework entries exist for this class-section' });

  const [hasTimetable] = await sql`
    SELECT 1 FROM timetable_slots
    WHERE class_section_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (hasTimetable) return res.status(400).json({ error: 'Cannot delete mapping: Timetable slots are defined for this class-section' });

  await sql.begin(async (tx) => {
    await purgeSoftDeletedClassSectionDeps(tx, id, schoolId);
    await tx`DELETE FROM class_sections WHERE id = ${id} AND school_id = ${schoolId}`;
  });
  return sendSuccess(res, req.schoolId, { message: 'Class-section mapping deleted successfully' });
}));

/**
 * GET /academics/class-sections/:id/students
 * AC3: Verify class_section belongs to this school before returning students.
 */
router.get('/class-sections/:id/students', requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

  // AC3: Ownership check
  const [cs] = await sql`SELECT id FROM class_sections WHERE id = ${id} AND school_id = ${schoolId}`;
  if (!cs) return res.status(404).json({ error: 'Class-section not found' });

  const students = await sql`
    SELECT
      s.id, s.admission_no,
      p.first_name, p.last_name, p.display_name, p.photo_url,
      se.roll_number,
      se.status as enrollment_status, se.start_date, se.end_date
    FROM student_enrollments se
    JOIN students s ON se.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    WHERE se.class_section_id = ${id} AND school_id = ${req.schoolId}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
      AND s.deleted_at IS NULL
      AND s.status_id = ${ACTIVE_STUDENT_STATUS_ID}
    ORDER BY se.roll_number ASC NULLS LAST, p.display_name ASC
  `;

  return sendSuccess(res, req.schoolId, students);
}));

// ============== ENROLLMENTS ==============

router.get('/enrollments', requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const { student_id, class_section_id, academic_year_id, status } = req.query;

  let query = sql`
    SELECT
      se.id, se.status, se.start_date, se.end_date, se.created_at,
      s.id as student_id, s.admission_no,
      p.display_name as student_name,
      c.name as class_name, sec.name as section_name,
      ay.code as academic_year
    FROM student_enrollments se
    JOIN students s ON se.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    JOIN class_sections cs ON se.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    JOIN academic_years ay ON se.academic_year_id = ay.id
    WHERE se.deleted_at IS NULL
      AND s.school_id = ${req.schoolId}
  `;

  if (student_id) {
    query = sql`${query} AND se.student_id = ${student_id} AND s.school_id = ${req.schoolId}`;
  }

  const enrollments = await query;
  return sendSuccess(res, req.schoolId, enrollments);
}));

router.post('/enrollments', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { student_id, class_section_id, academic_year_id, start_date } = req.body;

  if (!student_id || !class_section_id || !academic_year_id || !start_date) {
    return res.status(400).json({
      error: 'student_id, class_section_id, academic_year_id, and start_date are required'
    });
  }

  const [enrollment] = await sql`
    INSERT INTO student_enrollments (school_id, student_id, class_section_id, academic_year_id, start_date, status)
    VALUES (${req.schoolId}, ${student_id}, ${class_section_id}, ${academic_year_id}, ${start_date}, 'active')
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Student enrolled successfully', enrollment }, 201);
}));

/**
 * GET /academics/enrollments/:id
 * AC3: Ownership check via students.school_id.
 */
router.get('/enrollments/:id', requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

  const [enrollment] = await sql`
    SELECT
      se.*,
      s.admission_no, p.display_name as student_name,
      c.name as class_name, sec.name as section_name,
      ay.code as academic_year
    FROM student_enrollments se
    JOIN students s ON se.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    JOIN class_sections cs ON se.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    JOIN academic_years ay ON se.academic_year_id = ay.id
    WHERE se.id = ${id}
      AND s.school_id = ${schoolId}
  `;

  if (!enrollment) {
    return res.status(404).json({ error: 'Enrollment not found' });
  }

  return sendSuccess(res, req.schoolId, enrollment);
}));

/**
 * PUT /academics/enrollments/:id
 * AC3: Ownership check via students.school_id before update.
 */
router.put('/enrollments/:id', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, end_date, class_section_id } = req.body;
  const schoolId = req.schoolId;

  // AC3: Ownership check
  const [existing] = await sql`
    SELECT se.id FROM student_enrollments se
    JOIN students s ON se.student_id = s.id
    WHERE se.id = ${id} AND s.school_id = ${schoolId}
  `;
  if (!existing) return res.status(404).json({ error: 'Enrollment not found' });

  const [updated] = await sql`
    UPDATE student_enrollments
    SET
      status = COALESCE(${status ?? null}, status),
      end_date = COALESCE(${end_date ?? null}, end_date),
      class_section_id = COALESCE(${class_section_id ?? null}, class_section_id)
    WHERE id = ${id}
      AND school_id = ${req.schoolId}
    RETURNING *
  `;

  if (!updated) {
    return res.status(404).json({ error: 'Enrollment not found' });
  }

  return sendSuccess(res, req.schoolId, { message: 'Enrollment updated', enrollment: updated });
}));

export default router;
