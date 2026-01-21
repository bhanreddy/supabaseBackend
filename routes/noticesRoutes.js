import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * GET /notices
 * List notices (filtered by audience/role)
 */
router.get('/', requirePermission('notices.view'), asyncHandler(async (req, res) => {
    const { audience, class_id, pinned_only, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const notices = await sql`
    SELECT 
      n.id, n.title, n.content, n.audience, n.priority,
      n.is_pinned, n.publish_at, n.expires_at,
      c.name as target_class_name,
      creator.display_name as created_by_name,
      n.created_at
    FROM notices n
    LEFT JOIN classes c ON n.target_class_id = c.id
    JOIN users u ON n.created_by = u.id
    JOIN persons creator ON u.person_id = creator.id
    WHERE n.publish_at <= NOW()
      AND (n.expires_at IS NULL OR n.expires_at > NOW())
      ${audience ? sql`AND n.audience = ${audience}` : sql``}
      ${class_id ? sql`AND n.target_class_id = ${class_id}` : sql``}
      ${pinned_only === 'true' ? sql`AND n.is_pinned = true` : sql``}
    ORDER BY n.is_pinned DESC, n.publish_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

    res.json(notices);
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
    WHERE n.id = ${id}
  `;

    if (!notice) {
        return res.status(404).json({ error: 'Notice not found' });
    }

    res.json(notice);
}));

/**
 * POST /notices
 * Create a new notice
 */
router.post('/', requirePermission('notices.create'), asyncHandler(async (req, res) => {
    const { title, content, audience, target_class_id, priority, is_pinned, publish_at, expires_at } = req.body;

    if (!title || !content) {
        return res.status(400).json({ error: 'Title and content are required' });
    }

    if (audience === 'class' && !target_class_id) {
        return res.status(400).json({ error: 'target_class_id is required when audience is "class"' });
    }

    const [notice] = await sql`
    INSERT INTO notices (title, content, audience, target_class_id, priority, is_pinned, publish_at, expires_at, created_by)
    VALUES (${title}, ${content}, ${audience || 'all'}, ${target_class_id}, 
            ${priority || 'medium'}, ${is_pinned || false}, ${publish_at || sql`NOW()`}, ${expires_at}, ${req.user.internal_id})
    RETURNING *
  `;

    res.status(201).json({ message: 'Notice created', notice });
}));

/**
 * PUT /notices/:id
 * Update a notice
 */
router.put('/:id', requirePermission('notices.manage'), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { title, content, audience, target_class_id, priority, is_pinned, publish_at, expires_at } = req.body;

    const [updated] = await sql`
    UPDATE notices
    SET 
      title = COALESCE(${title}, title),
      content = COALESCE(${content}, content),
      audience = COALESCE(${audience}, audience),
      target_class_id = COALESCE(${target_class_id}, target_class_id),
      priority = COALESCE(${priority}, priority),
      is_pinned = COALESCE(${is_pinned}, is_pinned),
      publish_at = COALESCE(${publish_at}, publish_at),
      expires_at = COALESCE(${expires_at}, expires_at)
    WHERE id = ${id}
    RETURNING *
  `;

    if (!updated) {
        return res.status(404).json({ error: 'Notice not found' });
    }

    res.json({ message: 'Notice updated', notice: updated });
}));

/**
 * DELETE /notices/:id
 * Delete a notice
 */
router.delete('/:id', requirePermission('notices.manage'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [deleted] = await sql`DELETE FROM notices WHERE id = ${id} RETURNING id`;

    if (!deleted) {
        return res.status(404).json({ error: 'Notice not found' });
    }

    res.json({ message: 'Notice deleted' });
}));

export default router;
