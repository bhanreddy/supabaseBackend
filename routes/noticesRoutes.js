import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendNotificationToUsers } from '../services/notificationService.js';
import { translateFields } from '../services/geminiTranslator.js';

const router = express.Router();

const VALID_AUDIENCES = new Set(['all', 'students', 'staff', 'parents', 'class']);

/** Normalize to a non-empty unique audience list. "all" is exclusive. */
function normalizeAudiences(audiences, audience) {
  let list = Array.isArray(audiences) ? audiences : [];
  if (!list.length && audience) list = [audience];
  list = [...new Set(list.filter((a) => VALID_AUDIENCES.has(a)))];
  if (!list.length || list.includes('all')) return ['all'];
  return list;
}

function primaryAudience(list) {
  return list.includes('all') ? 'all' : list[0];
}

async function recipientsForAudience(schoolId, audience, targetClassId) {
  if (audience === 'class' && targetClassId) {
    return sql`
      SELECT DISTINCT u.id
      FROM users u
      JOIN students s ON u.person_id = s.person_id
      JOIN student_enrollments se ON s.id = se.student_id
      JOIN class_sections cs ON se.class_section_id = cs.id
      WHERE cs.class_id = ${targetClassId}
        AND cs.school_id = ${schoolId}
        AND se.school_id = ${schoolId}
        AND u.school_id = ${schoolId}
        AND se.status = 'active'
        AND u.account_status = 'active'

      UNION

      SELECT DISTINCT u.id
      FROM users u
      JOIN parents p ON u.person_id = p.person_id
      JOIN student_parents sp ON p.id = sp.parent_id
      JOIN students s ON sp.student_id = s.id
      JOIN student_enrollments se ON s.id = se.student_id
      JOIN class_sections cs ON se.class_section_id = cs.id
      WHERE cs.class_id = ${targetClassId}
        AND s.school_id = ${schoolId}
        AND cs.school_id = ${schoolId}
        AND se.school_id = ${schoolId}
        AND u.school_id = ${schoolId}
        AND se.status = 'active'
        AND u.account_status = 'active'
    `;
  }
  if (audience === 'students') {
    return sql`
      SELECT DISTINCT u.id
      FROM users u
      JOIN students s ON u.person_id = s.person_id
      JOIN student_enrollments se ON s.id = se.student_id
      WHERE se.school_id = ${schoolId}
        AND u.school_id = ${schoolId}
        AND se.status = 'active'
        AND u.account_status = 'active'
    `;
  }
  if (audience === 'parents') {
    return sql`
      SELECT DISTINCT u.id
      FROM users u
      JOIN parents p ON u.person_id = p.person_id
      JOIN student_parents sp ON p.id = sp.parent_id
      JOIN students s ON sp.student_id = s.id
      WHERE s.school_id = ${schoolId}
        AND u.school_id = ${schoolId}
        AND u.account_status = 'active'
    `;
  }
  if (audience === 'staff') {
    return sql`
      SELECT DISTINCT u.id
      FROM users u
      JOIN staff s ON u.person_id = s.person_id
      WHERE s.school_id = ${schoolId}
        AND u.school_id = ${schoolId}
        AND s.deleted_at IS NULL
        AND u.account_status = 'active'
    `;
  }
  if (audience === 'all') {
    return sql`
      SELECT DISTINCT u.id
      FROM users u
      WHERE u.school_id = ${schoolId}
        AND u.account_status = 'active'
    `;
  }
  return [];
}

async function recipientsForAudiences(schoolId, audiences, targetClassId) {
  const buckets = await Promise.all(
    audiences.map((a) => recipientsForAudience(schoolId, a, targetClassId))
  );
  const ids = new Set();
  for (const rows of buckets) {
    for (const row of rows) ids.add(row.id);
  }
  return [...ids];
}

/**
 * GET /notices
 * List notices (filtered by audience/role)
 */
router.get('/', requirePermission('notices.view'), asyncHandler(async (req, res) => {
  const { audience, class_id, pinned_only, lastSyncedAt, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  const notices = await sql`
    SELECT 
      n.id, n.title, n.content, n.title_te, n.content_te, n.audience, n.audiences, n.priority,
      n.is_pinned, 
      n.publish_at as published_at,
      n.expires_at,
      (n.publish_at <= NOW()) as is_published,
      n.target_class_id,
      c.name as target_class_name,
      creator.display_name as author_name,
      n.created_at
    FROM notices n
    LEFT JOIN classes c ON n.target_class_id = c.id
    JOIN users u ON n.created_by = u.id
    JOIN persons creator ON u.person_id = creator.id
    WHERE n.publish_at <= NOW()
      AND n.school_id = ${req.schoolId}
      AND (n.expires_at IS NULL OR n.expires_at > NOW())
      ${audience ? sql`AND (
        n.audience = ${audience}
        OR n.audience = 'all'
        OR ${audience} = ANY(n.audiences)
        OR 'all' = ANY(n.audiences)
      )` : sql``}
      ${class_id ? sql`AND (n.target_class_id = ${class_id} OR n.target_class_id IS NULL)` : sql``}
      ${pinned_only === 'true' ? sql`AND n.is_pinned = true` : sql``}
      ${lastSyncedAt ? sql`AND (n.created_at >= ${lastSyncedAt} OR n.publish_at >= ${lastSyncedAt})` : sql``}
    ORDER BY n.publish_at DESC, n.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return sendSuccess(res, req.schoolId, notices);
}));

/**
 * GET /notices/:id
 * Get notice details
 */
router.get('/:id', requirePermission('notices.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [notice] = await sql`
    SELECT 
      n.*,
      c.name as target_class_name,
      creator.display_name as created_by_name
    FROM notices n
    LEFT JOIN classes c ON n.target_class_id = c.id
    JOIN users u ON n.created_by = u.id
    JOIN persons creator ON u.person_id = creator.id
    WHERE n.id = ${id} AND n.school_id = ${req.schoolId}
  `;

  if (!notice) {
    return res.status(404).json({ error: 'Notice not found' });
  }

  return sendSuccess(res, req.schoolId, notice);
}));

/**
 * POST /notices
 * Create a new notice
 */
router.post('/', requirePermission('notices.create'), asyncHandler(async (req, res) => {
  const { title, content, audience, audiences, target_class_id, priority, is_pinned, publish_at, expires_at } = req.body;

  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content are required' });
  }

  const safeAudiences = normalizeAudiences(audiences, audience);
  const safeAudience = primaryAudience(safeAudiences);

  if (safeAudiences.includes('class') && !target_class_id) {
    return res.status(400).json({ error: 'target_class_id is required when audience includes "class"' });
  }

  // Sanitize inputs
  const safeTargetClassId = target_class_id && target_class_id !== '' ? target_class_id : null;
  const safePriority = priority || 'medium';
  const safePublishAt = publish_at || new Date();

  try {
    let title_te = null;
    let content_te = null;

    // Auto-generate Telugu translation
    try {
      const te = await translateFields({ title, content });
      title_te = te.title || null;
      content_te = te.content || null;
    } catch (e) {

    }

    const [notice] = await sql`
        INSERT INTO notices (school_id, title, content, title_te, content_te, audience, audiences, target_class_id, priority, is_pinned, publish_at, expires_at, created_by)
        VALUES (${req.schoolId}, ${title}, ${content}, ${title_te}, ${content_te}, ${safeAudience}, ${safeAudiences}, ${safeTargetClassId}, 
                ${safePriority}, ${is_pinned || false}, ${safePublishAt}, ${expires_at || null}, ${req.user.internal_id})
        RETURNING *
      `;

    // Notification Logic (Async)
    (async () => {
      try {
        const userIds = await recipientsForAudiences(req.schoolId, safeAudiences, safeTargetClassId);
        if (userIds.length > 0) {
          await sendNotificationToUsers(
            userIds,
            'NOTICE_ADMIN_STUDENT',
            { message: `New notice: ${title}` }
          );
        }
      } catch (notifyErr) {

      }
    })();

    return sendSuccess(res, req.schoolId, { message: 'Notice created', notice }, 201);
  } catch (err) {

    res.status(500).json({ error: 'Failed to create notice: ' + err.message });
  }
}));

/**
 * PUT /notices/:id
 * Update a notice
 */
router.put('/:id', requirePermission('notices.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, content, audience, audiences, target_class_id, priority, is_pinned, publish_at, expires_at } = req.body;

  let sql_title_te = sql`title_te`;
  let sql_content_te = sql`content_te`;

  if (title || content) {
    try {
      const fields = {};
      if (title) fields.title = title;
      if (content) fields.content = content;
      const te = await translateFields(fields);
      if (te.title) sql_title_te = sql`${te.title}`;
      if (te.content) sql_content_te = sql`${te.content}`;
    } catch (e) {

    }
  }

  const hasAudiences = Array.isArray(audiences) || audience != null;
  const safeAudiences = hasAudiences ? normalizeAudiences(audiences, audience) : null;
  const safeAudience = safeAudiences ? primaryAudience(safeAudiences) : null;

  if (safeAudiences?.includes('class') && !target_class_id) {
    return res.status(400).json({ error: 'target_class_id is required when audience includes "class"' });
  }

  const [updated] = await sql`
    UPDATE notices
    SET 
      title = COALESCE(${title || null}, title),
      content = COALESCE(${content || null}, content),
      title_te = ${sql_title_te},
      content_te = ${sql_content_te},
      ${safeAudience ? sql`audience = ${safeAudience},` : sql``}
      ${safeAudiences ? sql`audiences = ${safeAudiences},` : sql``}
      target_class_id = COALESCE(${target_class_id ?? null}, target_class_id),
      priority = COALESCE(${priority ?? null}, priority),
      is_pinned = COALESCE(${is_pinned ?? null}, is_pinned),
      publish_at = COALESCE(${publish_at ?? null}, publish_at),
      expires_at = COALESCE(${expires_at ?? null}, expires_at)
    WHERE id = ${id} AND school_id = ${req.schoolId}
    RETURNING *
  `;

  if (!updated) {
    return res.status(404).json({ error: 'Notice not found' });
  }

  return sendSuccess(res, req.schoolId, { message: 'Notice updated', notice: updated });
}));

/**
 * DELETE /notices/:id
 * Delete a notice
 */
router.delete('/:id', requirePermission('notices.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [deleted] = await sql`DELETE FROM notices WHERE id = ${id} AND school_id = ${req.schoolId} RETURNING id`;

  if (!deleted) {
    return res.status(404).json({ error: 'Notice not found' });
  }

  return sendSuccess(res, req.schoolId, { message: 'Notice deleted' });
}));

export default router;
