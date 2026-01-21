import express from 'express';
import sql from '../db.js';
import { requirePermission, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// ============== CLASSES ==============

/**
 * GET /academics/classes
 * List all classes
 */
router.get('/classes', requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const classes = await sql`
    SELECT id, name, code
    FROM classes
    ORDER BY name
  `;
  res.json(classes);
}));

/**
 * POST /academics/classes
 * Create a new class
 */
router.post('/classes', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { name, code } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Class name is required' });
  }

  const [newClass] = await sql`
    INSERT INTO classes (name, code)
    VALUES (${name}, ${code})
    RETURNING *
  `;

  res.status(201).json({ message: 'Class created', class: newClass });
}));

/**
 * DELETE /academics/classes/:id
 * Delete a class (if no sections/students linked)
 */
router.delete('/classes/:id', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  // 1. Check for sections Mapping
  const [hasSections] = await sql`SELECT 1 FROM class_sections WHERE class_id = ${id} LIMIT 1`;
  if (hasSections) {
    return res.status(400).json({ error: 'Cannot delete class: Linked to active class-sections' });
  }

  // 2. Check for Fee Structures
  const [hasFees] = await sql`SELECT 1 FROM fee_structures WHERE class_id = ${id} LIMIT 1`;
  if (hasFees) {
    return res.status(400).json({ error: 'Cannot delete class: Financial fee structures are defined for this class' });
  }

  // 3. Check for Exams
  const [hasExams] = await sql`SELECT 1 FROM exam_subjects WHERE class_id = ${id} LIMIT 1`;
  if (hasExams) {
    return res.status(400).json({ error: 'Cannot delete class: Linked to exam subjects' });
  }

  // 4. Check for LMS Courses
  const [hasLMS] = await sql`SELECT 1 FROM lms_courses WHERE class_id = ${id} LIMIT 1`;
  if (hasLMS) {
    return res.status(400).json({ error: 'Cannot delete class: Linked to LMS courses' });
  }

  // 5. Check for targeted Notices
  const [hasNotices] = await sql`SELECT 1 FROM notices WHERE target_class_id = ${id} LIMIT 1`;
  if (hasNotices) {
    return res.status(400).json({ error: 'Cannot delete class: Targeted in active announcements' });
  }

  await sql`DELETE FROM classes WHERE id = ${id}`;
  res.json({ message: 'Class deleted successfully' });
}));

// ============== SECTIONS ==============

/**
 * GET /academics/sections
 * List all sections
 */
router.get('/sections', requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const sections = await sql`
    SELECT id, name, code
    FROM sections
    ORDER BY name
  `;
  res.json(sections);
}));

/**
 * POST /academics/sections
 * Create a new section
 */
router.post('/sections', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { name, code } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Section name is required' });
  }

  const [newSection] = await sql`
    INSERT INTO sections (name, code)
    VALUES (${name}, ${code})
    RETURNING *
  `;

  res.status(201).json({ message: 'Section created', section: newSection });
}));

/**
 * DELETE /academics/sections/:id
 * Delete a section (if no class-sections linked)
 */
router.delete('/sections/:id', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [hasMappings] = await sql`SELECT 1 FROM class_sections WHERE section_id = ${id} LIMIT 1`;
  if (hasMappings) {
    return res.status(400).json({ error: 'Cannot delete section: Linked to active class-sections in one or more academic years' });
  }

  await sql`DELETE FROM sections WHERE id = ${id}`;
  res.json({ message: 'Section deleted successfully' });
}));

// ============== ACADEMIC YEARS ==============

/**
 * GET /academics/academic-years
 * List all academic years
 */
router.get('/academic-years', requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const years = await sql`
        SELECT id, code, start_date, end_date,
               CASE WHEN NOW() BETWEEN start_date AND end_date THEN true ELSE false END as is_current
        FROM academic_years
        ORDER BY start_date DESC
    `;
  res.json(years);
}));

/**
 * POST /academics/academic-years
 * Create a new academic year
 */
router.post('/academic-years', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { code, start_date, end_date } = req.body;

  if (!code || !start_date || !end_date) {
    return res.status(400).json({ error: 'Code, start_date, and end_date are required' });
  }

  const [newYear] = await sql`
    INSERT INTO academic_years (code, start_date, end_date)
    VALUES (${code}, ${start_date}, ${end_date})
    RETURNING *
  `;

  res.status(201).json({ message: 'Academic year created', academic_year: newYear });
}));

/**
 * DELETE /academics/academic-years/:id
 * Delete an academic year (if no enrollments/fees linked)
 */
router.delete('/academic-years/:id', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  // 1. Check for Class-Section Mappings
  const [hasMappings] = await sql`SELECT 1 FROM class_sections WHERE academic_year_id = ${id} LIMIT 1`;
  if (hasMappings) {
    return res.status(400).json({ error: 'Cannot delete academic year: Class mappings exist for this year' });
  }

  // 2. Check for enrollments (redundant but safe)
  const [hasEnrollments] = await sql`SELECT 1 FROM student_enrollments WHERE academic_year_id = ${id} LIMIT 1`;
  if (hasEnrollments) {
    return res.status(400).json({ error: 'Cannot delete academic year: Existing student enrollments found' });
  }

  // 3. Check for fees
  const [hasFees] = await sql`SELECT 1 FROM fee_structures WHERE academic_year_id = ${id} LIMIT 1`;
  if (hasFees) {
    return res.status(400).json({ error: 'Cannot delete academic year: Linked fee structures exist' });
  }

  // 4. Check for Exams
  const [hasExams] = await sql`SELECT 1 FROM exams WHERE academic_year_id = ${id} LIMIT 1`;
  if (hasExams) {
    return res.status(400).json({ error: 'Cannot delete academic year: Linked exams exist' });
  }

  // 5. Check for Transport
  const [hasTransport] = await sql`SELECT 1 FROM student_transport WHERE academic_year_id = ${id} LIMIT 1`;
  if (hasTransport) {
    return res.status(400).json({ error: 'Cannot delete academic year: Linked transport assignments exist' });
  }

  // 6. Check for Hostel
  const [hasHostel] = await sql`SELECT 1 FROM hostel_allocations WHERE academic_year_id = ${id} LIMIT 1`;
  if (hasHostel) {
    return res.status(400).json({ error: 'Cannot delete academic year: Linked hostel allocations exist' });
  }

  await sql`DELETE FROM academic_years WHERE id = ${id}`;
  res.json({ message: 'Academic year deleted successfully' });
}));

// ============== CLASS SECTIONS ==============

/**
 * GET /academics/class-sections
 * List all class-section mappings (optionally by academic year)
 */
router.get('/class-sections', requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const { academic_year_id } = req.query;

  let classSections;
  if (academic_year_id) {
    classSections = await sql`
      SELECT cs.id, c.name as class_name, c.id as class_id, 
             s.name as section_name, s.id as section_id,
             ay.code as academic_year, ay.id as academic_year_id
      FROM class_sections cs
      JOIN classes c ON cs.class_id = c.id
      JOIN sections s ON cs.section_id = s.id
      JOIN academic_years ay ON cs.academic_year_id = ay.id
      WHERE cs.academic_year_id = ${academic_year_id}
      ORDER BY c.name, s.name
    `;
  } else {
    classSections = await sql`
      SELECT cs.id, c.name as class_name, c.id as class_id, 
             s.name as section_name, s.id as section_id,
             ay.code as academic_year, ay.id as academic_year_id
      FROM class_sections cs
      JOIN classes c ON cs.class_id = c.id
      JOIN sections s ON cs.section_id = s.id
      JOIN academic_years ay ON cs.academic_year_id = ay.id
      ORDER BY ay.start_date DESC, c.name, s.name
    `;
  }

  res.json(classSections);
}));

/**
 * POST /academics/class-sections
 * Create a class-section mapping for an academic year
 */
router.post('/class-sections', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { class_id, section_id, academic_year_id } = req.body;

  if (!class_id || !section_id || !academic_year_id) {
    return res.status(400).json({ error: 'class_id, section_id, and academic_year_id are required' });
  }

  const [newMapping] = await sql`
    INSERT INTO class_sections (class_id, section_id, academic_year_id)
    VALUES (${class_id}, ${section_id}, ${academic_year_id})
    RETURNING *
  `;

  res.status(201).json({ message: 'Class-section created', class_section: newMapping });
}));

/**
 * GET /academics/class-sections/:id/students
 * Get students enrolled in a specific class-section
 */
router.get('/class-sections/:id/students', requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const students = await sql`
    SELECT 
      s.id, s.admission_no,
      p.first_name, p.last_name, p.display_name, p.photo_url,
      se.status as enrollment_status, se.start_date, se.end_date
    FROM student_enrollments se
    JOIN students s ON se.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    WHERE se.class_section_id = ${id}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
      AND s.deleted_at IS NULL
    ORDER BY p.first_name, p.last_name
  `;

  res.json(students);
}));

// ============== ENROLLMENTS ==============

/**
 * GET /academics/enrollments
 * List enrollments with filters
 */
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
  `;

  // Apply filters (simple approach for now)
  if (student_id) {
    query = sql`${query} AND se.student_id = ${student_id}`;
  }

  const enrollments = await query;
  res.json(enrollments);
}));

/**
 * POST /academics/enrollments
 * Enroll a student in a class-section
 */
router.post('/enrollments', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { student_id, class_section_id, academic_year_id, start_date } = req.body;

  if (!student_id || !class_section_id || !academic_year_id || !start_date) {
    return res.status(400).json({
      error: 'student_id, class_section_id, academic_year_id, and start_date are required'
    });
  }

  const [enrollment] = await sql`
    INSERT INTO student_enrollments (student_id, class_section_id, academic_year_id, start_date, status)
    VALUES (${student_id}, ${class_section_id}, ${academic_year_id}, ${start_date}, 'active')
    RETURNING *
  `;

  res.status(201).json({ message: 'Student enrolled successfully', enrollment });
}));

/**
 * GET /academics/enrollments/:id
 * Get enrollment details
 */
router.get('/enrollments/:id', requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;

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
  `;

  if (!enrollment) {
    return res.status(404).json({ error: 'Enrollment not found' });
  }

  res.json(enrollment);
}));

/**
 * PUT /academics/enrollments/:id
 * Update enrollment (e.g., transfer, withdraw)
 */
router.put('/enrollments/:id', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, end_date, class_section_id } = req.body;

  const [updated] = await sql`
    UPDATE student_enrollments
    SET 
      status = COALESCE(${status}, status),
      end_date = COALESCE(${end_date}, end_date),
      class_section_id = COALESCE(${class_section_id}, class_section_id)
    WHERE id = ${id}
    RETURNING *
  `;

  if (!updated) {
    return res.status(404).json({ error: 'Enrollment not found' });
  }

  res.json({ message: 'Enrollment updated', enrollment: updated });
}));

export default router;
