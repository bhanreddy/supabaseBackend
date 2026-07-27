import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanRequiredText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

function cleanOptionalText(value, maxLength) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

/**
 * GET /admin/parent-visits
 * Paginated school register. Search matches student/admission/parent/purpose.
 */
router.get('/', requirePermission('students.view'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const studentId = typeof req.query.student_id === 'string' ? req.query.student_id.trim() : '';
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
  const offset = (page - 1) * limit;
  const pattern = search ? `%${search}%` : null;

  if (studentId && !UUID_RE.test(studentId)) {
    return res.status(400).json({ error: 'Invalid student_id' });
  }

  const [visits, [countRow], [summary]] = await Promise.all([
    sql`
      SELECT
        pv.id,
        pv.student_id,
        pv.parent_id,
        pv.parent_name,
        pv.relationship,
        pv.purpose,
        pv.notes,
        pv.visited_at,
        pv.created_at,
        s.admission_no,
        sp.display_name AS student_name,
        c.name AS class_name,
        sec.name AS section_name,
        recorder.display_name AS recorded_by_name
      FROM parent_visits pv
      JOIN students s
        ON s.id = pv.student_id
       AND s.school_id = ${schoolId}
       AND s.deleted_at IS NULL
      JOIN persons sp ON sp.id = s.person_id
      LEFT JOIN student_enrollments se
        ON se.student_id = s.id
       AND se.school_id = ${schoolId}
       AND se.status = 'active'
       AND se.deleted_at IS NULL
      LEFT JOIN class_sections cs ON cs.id = se.class_section_id
      LEFT JOIN classes c ON c.id = cs.class_id
      LEFT JOIN sections sec ON sec.id = cs.section_id
      LEFT JOIN users recorder_user ON recorder_user.id = pv.recorded_by
      LEFT JOIN persons recorder ON recorder.id = recorder_user.person_id
      WHERE pv.school_id = ${schoolId}
        AND pv.deleted_at IS NULL
        ${studentId ? sql`AND pv.student_id = ${studentId}` : sql``}
        ${pattern ? sql`
          AND (
            sp.display_name ILIKE ${pattern}
            OR s.admission_no ILIKE ${pattern}
            OR pv.parent_name ILIKE ${pattern}
            OR pv.purpose ILIKE ${pattern}
          )
        ` : sql``}
      ORDER BY pv.visited_at DESC, pv.created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `,
    sql`
      SELECT COUNT(*)::int AS total
      FROM parent_visits pv
      JOIN students s
        ON s.id = pv.student_id
       AND s.school_id = ${schoolId}
       AND s.deleted_at IS NULL
      JOIN persons sp ON sp.id = s.person_id
      WHERE pv.school_id = ${schoolId}
        AND pv.deleted_at IS NULL
        ${studentId ? sql`AND pv.student_id = ${studentId}` : sql``}
        ${pattern ? sql`
          AND (
            sp.display_name ILIKE ${pattern}
            OR s.admission_no ILIKE ${pattern}
            OR pv.parent_name ILIKE ${pattern}
            OR pv.purpose ILIKE ${pattern}
          )
        ` : sql``}
    `,
    sql`
      SELECT
        COUNT(*)::int AS total_visits,
        COUNT(*) FILTER (
          WHERE visited_at >= date_trunc('month', CURRENT_DATE)
        )::int AS visits_this_month,
        COUNT(DISTINCT student_id)::int AS students_visited
      FROM parent_visits
      WHERE school_id = ${schoolId}
        AND deleted_at IS NULL
    `,
  ]);

  const total = Number(countRow?.total) || 0;
  return sendSuccess(res, schoolId, {
    visits,
    summary: {
      total_visits: Number(summary?.total_visits) || 0,
      visits_this_month: Number(summary?.visits_this_month) || 0,
      students_visited: Number(summary?.students_visited) || 0,
    },
    meta: {
      page,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / limit)),
    },
  });
}));

/**
 * POST /admin/parent-visits
 * Add one visit. A visit is an event, never a manually edited counter.
 */
router.post('/', requirePermission('students.edit'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const studentId = typeof req.body.student_id === 'string' ? req.body.student_id.trim() : '';
  const parentName = cleanRequiredText(req.body.parent_name, 150);
  const relationship = cleanOptionalText(req.body.relationship, 50);
  const purpose = cleanRequiredText(req.body.purpose, 1000);
  const notes = cleanOptionalText(req.body.notes, 4000);
  const parentId = req.body.parent_id == null || req.body.parent_id === ''
    ? null
    : String(req.body.parent_id).trim();

  if (!UUID_RE.test(studentId)) {
    return res.status(400).json({ error: 'A valid student_id is required' });
  }
  if (!parentName) {
    return res.status(400).json({ error: 'Parent/guardian name is required' });
  }
  if (!purpose) {
    return res.status(400).json({ error: 'Visit purpose is required' });
  }
  if (parentId && !UUID_RE.test(parentId)) {
    return res.status(400).json({ error: 'Invalid parent_id' });
  }

  const visitedAt = req.body.visited_at ? new Date(req.body.visited_at) : new Date();
  if (Number.isNaN(visitedAt.getTime())) {
    return res.status(400).json({ error: 'Invalid visited_at date' });
  }
  if (visitedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    return res.status(400).json({ error: 'Visit time cannot be in the future' });
  }

  const [student] = await sql`
    SELECT id
    FROM students
    WHERE id = ${studentId}
      AND school_id = ${schoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!student) return res.status(404).json({ error: 'Student not found' });

  if (parentId) {
    const [linkedParent] = await sql`
      SELECT p.id
      FROM parents p
      JOIN student_parents student_parent
        ON student_parent.parent_id = p.id
       AND student_parent.student_id = ${studentId}
       AND student_parent.school_id = ${schoolId}
       AND student_parent.deleted_at IS NULL
      WHERE p.id = ${parentId}
        AND p.school_id = ${schoolId}
        AND p.deleted_at IS NULL
      LIMIT 1
    `;
    if (!linkedParent) {
      return res.status(400).json({ error: 'Parent is not linked to this student' });
    }
  }

  const [visit] = await sql`
    INSERT INTO parent_visits (
      school_id,
      student_id,
      parent_id,
      parent_name,
      relationship,
      purpose,
      notes,
      visited_at,
      recorded_by
    )
    VALUES (
      ${schoolId},
      ${studentId},
      ${parentId},
      ${parentName},
      ${relationship},
      ${purpose},
      ${notes},
      ${visitedAt.toISOString()},
      ${req.user.internal_id}
    )
    RETURNING *
  `;

  const [countRow] = await sql`
    SELECT COUNT(*)::int AS visit_count
    FROM parent_visits
    WHERE school_id = ${schoolId}
      AND student_id = ${studentId}
      AND deleted_at IS NULL
  `;

  return sendSuccess(res, schoolId, {
    visit,
    student_visit_count: Number(countRow?.visit_count) || 0,
    message: 'Parent visit recorded',
  }, 201);
}));

/**
 * DELETE /admin/parent-visits/:id
 * Soft-delete an incorrectly entered visit while retaining audit history.
 */
router.delete('/:id', requirePermission('students.edit'), asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid visit id' });
  }

  const [visit] = await sql`
    UPDATE parent_visits
    SET deleted_at = NOW(), updated_at = NOW()
    WHERE id = ${req.params.id}
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
    RETURNING id
  `;
  if (!visit) return res.status(404).json({ error: 'Visit not found' });

  return sendSuccess(res, req.schoolId, { message: 'Parent visit removed' });
}));

export default router;
