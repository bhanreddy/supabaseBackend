import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendNotificationToUsers } from '../services/notificationService.js';
import {
  extractYoutubeVideoId,
  fetchYoutubeDurationSeconds,
} from '../utils/youtubeDuration.js';
import { isStudentPortalRequest, resolveStudentClassId } from '../utils/studentPortal.js';

const LMS_YT_DURATION_BACKFILL_MAX = 25;

const router = express.Router();

// Helper to get staff ID from user's internal_id
async function getStaffId(internalId) {
  const [res] = await sql`
    SELECT s.id FROM staff s
    JOIN users u ON s.person_id = u.person_id
    WHERE u.id = ${internalId}
  `;
  return res?.id;
}

// ============== COURSES ==============

/**
 * GET /lms/all-materials
 * LM4: Scoped to school_id
 */
router.get('/all-materials', requirePermission('lms.view'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  let studentClassId = null;

  if (isStudentPortalRequest(req)) {
    studentClassId = await resolveStudentClassId(req);
  }

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
    WHERE m.is_published = true
      AND c.is_published = true
      AND c.school_id = ${schoolId}
      ${studentClassId ? sql`AND c.class_id = ${studentClassId}` : sql``}
    ORDER BY m.created_at DESC
    LIMIT 100
  `;

  // Backfill missing video lengths (seconds) from YouTube for legacy rows; cap work per request.
  let filled = 0;
  for (const row of materials) {
    if (filled >= LMS_YT_DURATION_BACKFILL_MAX) break;
    const d = row.duration;
    if (d != null && Number(d) > 0) continue;
    if (row.material_type !== 'video' || !row.content_url) continue;
    const vid = extractYoutubeVideoId(row.content_url);
    if (!vid) continue;
    const sec = await fetchYoutubeDurationSeconds(vid);
    if (sec == null || sec <= 0) continue;
    await sql`
      UPDATE lms_materials
      SET duration = ${sec}
      WHERE id = ${row.id} AND school_id = ${schoolId}
    `;
    row.duration = sec;
    filled += 1;
  }

  return sendSuccess(res, req.schoolId, materials);
}));

/**
 * POST /lms/material/:id/view
 * Records a completed video view (client should call once per completion). Increments view_count.
 */
router.post('/material/:id/view', requirePermission('lms.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;
  let studentClassId = null;

  if (isStudentPortalRequest(req)) {
    studentClassId = await resolveStudentClassId(req);
  }

  const [row] = await sql`
    UPDATE lms_materials m
    SET view_count = COALESCE(m.view_count, 0) + 1
    FROM lms_courses c
    WHERE m.id = ${id}
      AND m.course_id = c.id
      AND m.is_published = true
      AND c.is_published = true
      AND c.school_id = ${schoolId}
      AND m.school_id = ${schoolId}
      AND (m.deleted_at IS NULL)
      ${studentClassId ? sql`AND c.class_id = ${studentClassId}` : sql``}
    RETURNING m.id, m.view_count
  `;

  if (!row) {
    return res.status(404).json({ error: 'Material not found or not accessible' });
  }

  return sendSuccess(res, req.schoolId, { material_id: row.id, view_count: row.view_count });
}));

/**
 * GET /lms/courses
 * LM1: Scoped to school_id
 */
router.get('/courses', requirePermission('lms.view'), asyncHandler(async (req, res) => {
  const { subject_id, class_id, instructor_id, published_only } = req.query;
  const schoolId = req.schoolId;

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
    WHERE c.school_id = ${schoolId}
      ${subject_id ? sql`AND c.subject_id = ${subject_id}` : sql``}
      ${class_id ? sql`AND c.class_id = ${class_id}` : sql``}
      ${instructor_id ? sql`AND c.instructor_id = ${instructor_id}` : sql``}
      ${published_only === 'true' ? sql`AND c.is_published = true` : sql``}
    GROUP BY c.id, s.name, cl.name, instructor.display_name
    ORDER BY c.created_at DESC
  `;

  return sendSuccess(res, req.schoolId, courses);
}));

/**
 * GET /lms/courses/:id
 * LM1: Ownership check via school_id
 */
router.get('/courses/:id', requirePermission('lms.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

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
      AND c.school_id = ${schoolId}
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

  return sendSuccess(res, req.schoolId, { ...course, materials });
}));

/**
 * POST /lms/courses
 * LM2: school_id included in INSERT
 */
router.post('/courses', requirePermission('lms.create'), asyncHandler(async (req, res) => {
  const { title, description, subject_id, class_id, is_published } = req.body;
  const schoolId = req.schoolId;

  if (!title) {
    return res.status(400).json({ error: 'Course title is required' });
  }

  const [staff] = await sql`
    SELECT s.id FROM staff s
    JOIN users u ON s.person_id = u.person_id
    WHERE u.id = ${req.user?.internal_id}
      AND s.school_id = ${schoolId}
  `;

  if (!staff) return res.status(403).json({ error: 'User is not a staff member' });

  const isAdmin = req.user?.roles.includes('admin');
  if (!isAdmin) {
    // Must match GET /teachers/me/classes: teachers may appear from class_subjects
    // or only from timetable_slots; LMS picker uses that list, so authorize the same way.
    const [authorized] = await sql`
      SELECT (
        EXISTS (
          SELECT 1
          FROM class_subjects cs
          JOIN class_sections sec ON cs.class_section_id = sec.id
          WHERE sec.class_id = ${class_id}
            AND cs.subject_id = ${subject_id}
            AND cs.teacher_id = ${staff.id}
            AND sec.school_id = ${schoolId}
            AND cs.school_id = ${schoolId}
            AND cs.deleted_at IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM timetable_slots ts
          JOIN class_sections sec ON ts.class_section_id = sec.id
          WHERE sec.class_id = ${class_id}
            AND ts.subject_id = ${subject_id}
            AND ts.teacher_id = ${staff.id}
            AND ts.school_id = ${schoolId}
            AND sec.school_id = ${schoolId}
        )
      ) AS ok
    `;

    if (!authorized?.ok) {
      return res.status(403).json({ error: 'You are not assigned to teach this subject in this class' });
    }
  }

  // LM2: school_id in INSERT
  const [course] = await sql`
    INSERT INTO lms_courses (school_id, title, description, subject_id, class_id, instructor_id, is_published)
    VALUES (${schoolId}, ${title}, ${description}, ${subject_id}, ${class_id}, ${staff?.id}, ${is_published || false})
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Course created', course }, 201);
}));

/**
 * PUT /lms/courses/:id
 * LM3: school_id ownership check added
 */
router.put('/courses/:id', requirePermission('lms.create'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, description, subject_id, class_id, is_published } = req.body;
  const schoolId = req.schoolId;

  // LM3: Ownership check must include school_id
  const [course] = await sql`
    SELECT instructor_id FROM lms_courses WHERE id = ${id} AND school_id = ${schoolId}
  `;
  if (!course) return res.status(404).json({ error: 'Course not found' });

  const isAdmin = req.user?.roles.includes('admin');
  const staffId = await getStaffId(req.user.internal_id);
  const isOwner = course.instructor_id === staffId;

  if (!isAdmin && !isOwner) {
    return res.status(403).json({ error: 'Only the instructor or admin can edit this course' });
  }

  const [updated] = await sql`
    UPDATE lms_courses
    SET
      title = COALESCE(${title ?? null}, title),
      description = COALESCE(${description ?? null}, description),
      subject_id = COALESCE(${subject_id ?? null}, subject_id),
      class_id = COALESCE(${class_id ?? null}, class_id),
      is_published = COALESCE(${is_published ?? null}, is_published),
      updated_at = NOW()
    WHERE id = ${id}
      AND school_id = ${req.schoolId}
    RETURNING *
  `;

  if (!updated) {
    return res.status(404).json({ error: 'Course not found' });
  }

  return sendSuccess(res, req.schoolId, { message: 'Course updated', course: updated });
}));

// ============== MATERIALS ==============

/**
 * POST /lms/courses/:id/materials — Add material to course
 */
router.post('/courses/:id/materials', requirePermission('lms.create'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, description, material_type, content_url, file_size, duration, sort_order, is_published } = req.body;
  const schoolId = req.schoolId;

  if (!title || !material_type) {
    return res.status(400).json({ error: 'title and material_type are required' });
  }

  const validTypes = ['video', 'document', 'link', 'quiz', 'assignment'];
  if (!validTypes.includes(material_type)) {
    return res.status(400).json({ error: `material_type must be one of: ${validTypes.join(', ')}` });
  }

  // Ownership check: course must belong to this school
  const [courseCheck] = await sql`SELECT id FROM lms_courses WHERE id = ${id} AND school_id = ${schoolId}`;
  if (!courseCheck) return res.status(404).json({ error: 'Course not found' });

  const safeTitle = title || '';
  const safeDescription = description || '';
  const safeContentUrl = content_url || '';
  const safeFileSize = file_size ?? null;
  let safeDuration =
    duration != null && duration !== '' ? parseInt(String(duration), 10) : null;
  if (safeDuration != null && !Number.isFinite(safeDuration)) safeDuration = null;

  if (
    (safeDuration == null || safeDuration <= 0) &&
    material_type === 'video' &&
    safeContentUrl
  ) {
    const vid = extractYoutubeVideoId(safeContentUrl);
    if (vid) {
      const sec = await fetchYoutubeDurationSeconds(vid);
      if (sec != null && sec > 0) safeDuration = sec;
    }
  }

  const safeIsPublished = is_published === true;

  const [material] = await sql`
    INSERT INTO lms_materials (school_id, course_id, title, description, material_type, content_url, file_size, duration, sort_order, is_published)
    VALUES (${req.schoolId}, ${id}, ${safeTitle}, ${safeDescription}, ${material_type}, ${safeContentUrl}, ${safeFileSize}, ${safeDuration}, ${sort_order || 0}, ${safeIsPublished})
    RETURNING *
  `;

  // Notification — scoped to school
  (async () => {
    try {
      if (!safeIsPublished) return;

      const [courseInfo] = await sql`SELECT class_id FROM lms_courses WHERE id = ${id}`;
      const targetClassId = courseInfo?.class_id;
      if (!targetClassId) return;

      const recipients = await sql`
        SELECT DISTINCT u.id
        FROM users u
        JOIN students s ON u.person_id = s.person_id
        JOIN student_enrollments se ON s.id = se.student_id
        JOIN class_sections cs ON se.class_section_id = cs.id
        WHERE cs.class_id = ${targetClassId}
          AND se.status = 'active'
          AND u.account_status = 'active'
          AND s.school_id = ${schoolId}

        UNION

        SELECT DISTINCT u.id
        FROM users u
        JOIN parents p ON u.person_id = p.person_id
        JOIN student_parents sp ON p.id = sp.parent_id
        JOIN students s ON sp.student_id = s.id
        JOIN student_enrollments se ON s.id = se.student_id
        JOIN class_sections cs ON se.class_section_id = cs.id
        WHERE cs.class_id = ${targetClassId}
          AND se.status = 'active'
          AND u.account_status = 'active'
          AND s.school_id = ${schoolId}
      `;

      if (recipients.length > 0) {
        const userIds = recipients.map((r) => r.id);
        await sendNotificationToUsers(userIds, 'LMS_CONTENT', { message: `New study material uploaded: ${safeTitle}` });
      }
    } catch (notifyErr) {}
  })();

  return sendSuccess(res, req.schoolId, { message: 'Material added', material }, 201);
}));

/**
 * PUT /lms/materials/:id
 * LM3: school_id ownership check added
 */
router.put('/materials/:id', requirePermission('lms.create'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, description, content_url, file_size, duration, sort_order, is_published } = req.body;
  const schoolId = req.schoolId;

  // LM3: Ownership check includes school_id scope
  const [material] = await sql`
    SELECT m.content_url AS existing_url, m.material_type, c.instructor_id
    FROM lms_materials m
    JOIN lms_courses c ON m.course_id = c.id
    WHERE m.id = ${id}
      AND c.school_id = ${schoolId}
  `;

  if (!material) return res.status(404).json({ error: 'Material not found' });

  const isAdmin = req.user?.roles.includes('admin');
  const staffId = await getStaffId(req.user.internal_id);
  const isOwner = material.instructor_id === staffId;

  if (!isAdmin && !isOwner) {
    return res.status(403).json({ error: 'Only the course instructor or admin can edit this material' });
  }

  let durationCoalesce = duration ?? null;
  if (duration != null && duration !== '') {
    const d = parseInt(String(duration), 10);
    durationCoalesce = Number.isFinite(d) && d > 0 ? d : null;
  } else if (
    material.material_type === 'video' &&
    content_url != null &&
    content_url !== '' &&
    content_url !== material.existing_url
  ) {
    const vid = extractYoutubeVideoId(content_url);
    if (vid) {
      const sec = await fetchYoutubeDurationSeconds(vid);
      if (sec != null && sec > 0) durationCoalesce = sec;
    }
  }

  const [updated] = await sql`
    UPDATE lms_materials
    SET
      title = COALESCE(${title ?? null}, title),
      description = COALESCE(${description ?? null}, description),
      content_url = COALESCE(${content_url ?? null}, content_url),
      file_size = COALESCE(${file_size ?? null}, file_size),
      duration = COALESCE(${durationCoalesce}, duration),
      sort_order = COALESCE(${sort_order ?? null}, sort_order),
      is_published = COALESCE(${is_published ?? null}, is_published)
    WHERE id = ${id}
      AND school_id = ${req.schoolId}
    RETURNING *
  `;

  // Notification — scoped to school
  (async () => {
    try {
      if (!updated?.is_published) return;

      const [courseInfo] = await sql`
        SELECT c.class_id, c.title as course_title
        FROM lms_materials m
        JOIN lms_courses c ON m.course_id = c.id
        WHERE m.id = ${id}
      `;
      const targetClassId = courseInfo?.class_id;
      if (!targetClassId) return;

      const recipients = await sql`
        SELECT DISTINCT u.id
        FROM users u
        JOIN students s ON u.person_id = s.person_id
        JOIN student_enrollments se ON s.id = se.student_id
        JOIN class_sections cs ON se.class_section_id = cs.id
        WHERE cs.class_id = ${targetClassId}
          AND se.status = 'active'
          AND u.account_status = 'active'
          AND s.school_id = ${schoolId}

        UNION

        SELECT DISTINCT u.id
        FROM users u
        JOIN parents p ON u.person_id = p.person_id
        JOIN student_parents sp ON p.id = sp.parent_id
        JOIN students s ON sp.student_id = s.id
        JOIN student_enrollments se ON s.id = se.student_id
        JOIN class_sections cs ON se.class_section_id = cs.id
        WHERE cs.class_id = ${targetClassId}
          AND se.status = 'active'
          AND u.account_status = 'active'
          AND s.school_id = ${schoolId}
      `;

      if (recipients.length > 0) {
        const userIds = recipients.map((r) => r.id);
        await sendNotificationToUsers(userIds, 'LMS_CONTENT', { message: `Study material updated: ${updated.title || 'In Course: ' + courseInfo.course_title}` });
      }
    } catch (notifyErr) {}
  })();

  return sendSuccess(res, req.schoolId, { message: 'Material updated', material: updated });
}));

/**
 * DELETE /lms/materials/:id
 * LM3: school_id ownership check added
 */
router.delete('/materials/:id', requirePermission('lms.create'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

  // LM3: Ownership check with school_id scope
  const [material] = await sql`
    SELECT c.instructor_id
    FROM lms_materials m
    JOIN lms_courses c ON m.course_id = c.id
    WHERE m.id = ${id}
      AND c.school_id = ${schoolId}
  `;

  if (!material) return res.status(404).json({ error: 'Material not found' });

  const isAdmin = req.user?.roles.includes('admin');
  const staffId = await getStaffId(req.user.internal_id);
  const isOwner = material.instructor_id === staffId;

  if (!isAdmin && !isOwner) {
    return res.status(403).json({ error: 'Only the course instructor or admin can delete this material' });
  }

  await sql`DELETE FROM lms_materials WHERE id = ${id} AND school_id = ${req.schoolId}`;

  return sendSuccess(res, req.schoolId, { message: 'Material deleted' });
}));

export default router;