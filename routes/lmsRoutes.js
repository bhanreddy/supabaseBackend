import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// ============== COURSES ==============

/**
 * GET /lms/all-materials
 * Get a flat feed of all materials (filtered by student's class if needed, here getting all public/latest)
 */
router.get('/all-materials', requirePermission('lms.view'), asyncHandler(async (req, res) => {
  const materials = await sql`
    SELECT 
      m.id, m.title, m.description, m.content_url, m.duration, m.material_type, m.created_at,
      c.title as course_title,
      cl.name as class_name,
      instructor.display_name as instructor_name
    FROM lms_materials m
    JOIN lms_courses c ON m.course_id = c.id
    LEFT JOIN classes cl ON c.class_id = cl.id
    LEFT JOIN staff st ON c.instructor_id = st.id
    LEFT JOIN persons instructor ON st.person_id = instructor.id
    WHERE m.is_published = true AND c.is_published = true
    ORDER BY m.created_at DESC
    LIMIT 100
  `;
  res.json(materials);
}));

/**
 * GET /lms/courses
 * List courses (filter by subject, class, instructor)
 */
router.get('/courses', requirePermission('lms.view'), asyncHandler(async (req, res) => {
  const { subject_id, class_id, instructor_id, published_only } = req.query;

  const courses = await sql`
    SELECT 
      c.id, c.title, c.description, c.is_published, c.created_at,
      s.name as subject_name,
      cl.name as class_name,
      instructor.display_name as instructor_name,
      COUNT(m.id) as material_count
    FROM lms_courses c
    LEFT JOIN subjects s ON c.subject_id = s.id
    LEFT JOIN classes cl ON c.class_id = cl.id
    LEFT JOIN staff st ON c.instructor_id = st.id
    LEFT JOIN persons instructor ON st.person_id = instructor.id
    LEFT JOIN lms_materials m ON c.id = m.course_id
    WHERE TRUE
      ${subject_id ? sql`AND c.subject_id = ${subject_id}` : sql``}
      ${class_id ? sql`AND c.class_id = ${class_id}` : sql``}
      ${instructor_id ? sql`AND c.instructor_id = ${instructor_id}` : sql``}
      ${published_only === 'true' ? sql`AND c.is_published = true` : sql``}
    GROUP BY c.id, s.name, cl.name, instructor.display_name
    ORDER BY c.created_at DESC
  `;

  res.json(courses);
}));

/**
 * GET /lms/courses/:id
 * Get course with materials
 */
router.get('/courses/:id', requirePermission('lms.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [course] = await sql`
    SELECT 
      c.*, 
      s.name as subject_name,
      cl.name as class_name,
      instructor.display_name as instructor_name
    FROM lms_courses c
    LEFT JOIN subjects s ON c.subject_id = s.id
    LEFT JOIN classes cl ON c.class_id = cl.id
    LEFT JOIN staff st ON c.instructor_id = st.id
    LEFT JOIN persons instructor ON st.person_id = instructor.id
    WHERE c.id = ${id}
  `;

  if (!course) {
    return res.status(404).json({ error: 'Course not found' });
  }

  const materials = await sql`
    SELECT id, title, description, material_type, content_url, file_size, duration, sort_order, is_published
    FROM lms_materials
    WHERE course_id = ${id}
    ORDER BY sort_order
  `;

  res.json({ ...course, materials });
}));

/**
 * POST /lms/courses
 * Create a course
 */
router.post('/courses', requirePermission('lms.create'), asyncHandler(async (req, res) => {
  const { title, description, subject_id, class_id, is_published } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Course title is required' });
  }

  // Get instructor from current user's staff record
  const [staff] = await sql`
    SELECT s.id FROM staff s
    JOIN users u ON s.person_id = u.person_id
    WHERE u.id = ${req.user?.internal_id}
  `;

  const [course] = await sql`
    INSERT INTO lms_courses (title, description, subject_id, class_id, instructor_id, is_published)
    VALUES (${title}, ${description}, ${subject_id}, ${class_id}, ${staff?.id}, ${is_published || false})
    RETURNING *
  `;

  res.status(201).json({ message: 'Course created', course });
}));

/**
 * PUT /lms/courses/:id
 * Update course
 */
router.put('/:id', requirePermission('lms.create'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, description, subject_id, class_id, is_published } = req.body;

  const [updated] = await sql`
    UPDATE lms_courses
    SET 
      title = COALESCE(${title}, title),
      description = COALESCE(${description}, description),
      subject_id = COALESCE(${subject_id}, subject_id),
      class_id = COALESCE(${class_id}, class_id),
      is_published = COALESCE(${is_published}, is_published)
    WHERE id = ${id}
    RETURNING *
  `;

  if (!updated) {
    return res.status(404).json({ error: 'Course not found' });
  }

  res.json({ message: 'Course updated', course: updated });
}));

// ============== MATERIALS ==============

/**
 * POST /lms/courses/:id/materials
 * Add material to course
 */
router.post('/courses/:id/materials', requirePermission('lms.create'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, description, material_type, content_url, file_size, duration, sort_order } = req.body;

  if (!title || !material_type) {
    return res.status(400).json({ error: 'title and material_type are required' });
  }

  const validTypes = ['video', 'document', 'link', 'quiz', 'assignment'];
  if (!validTypes.includes(material_type)) {
    return res.status(400).json({ error: `material_type must be one of: ${validTypes.join(', ')}` });
  }

  const [material] = await sql`
    INSERT INTO lms_materials (course_id, title, description, material_type, content_url, file_size, duration, sort_order)
    VALUES (${id}, ${title}, ${description}, ${material_type}, ${content_url}, ${file_size}, ${duration}, ${sort_order || 0})
    RETURNING *
  `;

  res.status(201).json({ message: 'Material added', material });
}));

/**
 * PUT /lms/materials/:id
 * Update material
 */
router.put('/materials/:id', requirePermission('lms.create'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, description, content_url, file_size, duration, sort_order, is_published } = req.body;

  const [updated] = await sql`
    UPDATE lms_materials
    SET 
      title = COALESCE(${title}, title),
      description = COALESCE(${description}, description),
      content_url = COALESCE(${content_url}, content_url),
      file_size = COALESCE(${file_size}, file_size),
      duration = COALESCE(${duration}, duration),
      sort_order = COALESCE(${sort_order}, sort_order),
      is_published = COALESCE(${is_published}, is_published)
    WHERE id = ${id}
    RETURNING *
  `;

  if (!updated) {
    return res.status(404).json({ error: 'Material not found' });
  }

  res.json({ message: 'Material updated', material: updated });
}));

/**
 * DELETE /lms/materials/:id
 * Delete material
 */
router.delete('/materials/:id', requirePermission('lms.create'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [deleted] = await sql`DELETE FROM lms_materials WHERE id = ${id} RETURNING id`;

  if (!deleted) {
    return res.status(404).json({ error: 'Material not found' });
  }

  res.json({ message: 'Material deleted' });
}));

export default router;
