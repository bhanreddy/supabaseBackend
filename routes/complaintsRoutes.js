import express from 'express';
import sql from '../db.js';
import { requirePermission, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * GET /complaints
 * List complaints (own complaints for regular users, all for admin)
 */
router.get('/', requirePermission('complaints.view'), asyncHandler(async (req, res) => {
  const { status, category, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  const isAdmin = req.user?.roles.includes('admin');

  let complaints;
  if (isAdmin) {
    complaints = await sql`
      SELECT 
        c.id, c.ticket_no, c.title, c.category, c.priority, c.status,
        c.created_at, c.resolved_at,
        raiser.display_name as raised_by_name,
        assignee.display_name as assigned_to_name
      FROM complaints c
      JOIN users u ON c.raised_by = u.id
      JOIN persons raiser ON u.person_id = raiser.id
      LEFT JOIN users au ON c.assigned_to = au.id
      LEFT JOIN persons assignee ON au.person_id = assignee.id
      WHERE TRUE
        ${status ? sql`AND c.status = ${status}` : sql``}
        ${category ? sql`AND c.category = ${category}` : sql``}
      ORDER BY c.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    // Regular users see complaints they raised OR complaints raised FOR them (if they are a student)
    // We need to find if this user is a student
    const [studentProfile] = await sql`
            SELECT s.id 
            FROM students s 
            JOIN persons p ON s.person_id = p.id 
            JOIN users u ON p.id = u.person_id 
            WHERE u.id = ${req.user.internal_id}
        `;

    const studentId = studentProfile?.id;

    complaints = await sql`
      SELECT 
        c.id, c.ticket_no, c.title, c.category, c.priority, c.status,
        c.created_at, c.resolved_at,
        raiser.display_name as raised_by_name
      FROM complaints c
      JOIN users u ON c.raised_by = u.id
      JOIN persons raiser ON u.person_id = raiser.id
      WHERE (c.raised_by = ${req.user.internal_id} ${studentId ? sql`OR c.raised_for_student_id = ${studentId}` : sql``})
        ${status ? sql`AND c.status = ${status}` : sql``}
      ORDER BY c.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  res.json(complaints);
}));

/**
 * GET /complaints/:id
 * Get complaint details
 */
router.get('/:id', requirePermission('complaints.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [complaint] = await sql`
    SELECT 
      c.*,
      raiser.display_name as raised_by_name,
      assignee.display_name as assigned_to_name,
      resolver.display_name as resolved_by_name,
      s.admission_no as student_admission_no,
      sp.display_name as student_name
    FROM complaints c
    JOIN users u ON c.raised_by = u.id
    JOIN persons raiser ON u.person_id = raiser.id
    LEFT JOIN users au ON c.assigned_to = au.id
    LEFT JOIN persons assignee ON au.person_id = assignee.id
    LEFT JOIN users ru ON c.resolved_by = ru.id
    LEFT JOIN persons resolver ON ru.person_id = resolver.id
    LEFT JOIN students s ON c.raised_for_student_id = s.id
    LEFT JOIN persons sp ON s.person_id = sp.id
    WHERE c.id = ${id}
  `;

  if (!complaint) {
    return res.status(404).json({ error: 'Complaint not found' });
  }

  // Check access
  const isAdmin = req.user?.roles.includes('admin');
  if (!isAdmin && complaint.raised_by !== req.user.internal_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  res.json(complaint);
}));

/**
 * POST /complaints
 * Create a new complaint
 */
router.post('/', requirePermission('complaints.create'), asyncHandler(async (req, res) => {
  const { title, description, category, priority, raised_for_student_id } = req.body;

  if (!title || !description) {
    return res.status(400).json({ error: 'Title and description are required' });
  }

  const [complaint] = await sql`
    INSERT INTO complaints (title, description, category, priority, raised_by, raised_for_student_id)
    VALUES (${title}, ${description}, ${category || 'other'}, ${priority || 'medium'}, 
            ${req.user.internal_id}, ${raised_for_student_id})
    RETURNING *
  `;

  res.status(201).json({ message: 'Complaint submitted', complaint });
}));

/**
 * PUT /complaints/:id
 * Update complaint (status, assignment, resolution)
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, priority, assigned_to, resolution } = req.body;

  // Check if user can manage or is owner
  const [existing] = await sql`SELECT raised_by, status FROM complaints WHERE id = ${id}`;
  if (!existing) {
    return res.status(404).json({ error: 'Complaint not found' });
  }

  const isAdmin = req.user?.roles.includes('admin');
  const isOwner = existing.raised_by === req.user.internal_id;

  if (!isAdmin && !isOwner) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Only admin can change status to resolved/closed or assign
  if (!isAdmin && (status === 'resolved' || status === 'closed' || assigned_to)) {
    return res.status(403).json({ error: 'Only admin can resolve or assign complaints' });
  }

  let resolved_by = null;
  let resolved_at = null;
  if (status === 'resolved' || status === 'closed') {
    resolved_by = req.user.internal_id;
    resolved_at = sql`NOW()`;
  }

  const [updated] = await sql`
    UPDATE complaints
    SET 
      status = COALESCE(${status}, status),
      priority = COALESCE(${priority}, priority),
      assigned_to = COALESCE(${assigned_to}, assigned_to),
      resolution = COALESCE(${resolution}, resolution),
      resolved_by = COALESCE(${resolved_by}, resolved_by),
      resolved_at = ${status === 'resolved' || status === 'closed' ? sql`NOW()` : sql`resolved_at`}
    WHERE id = ${id}
    RETURNING *
  `;

  res.json({ message: 'Complaint updated', complaint: updated });
}));

/**
 * DELETE /complaints/:id
 * Delete complaint (owner or admin only)
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [existing] = await sql`SELECT raised_by FROM complaints WHERE id = ${id}`;
  if (!existing) {
    return res.status(404).json({ error: 'Complaint not found' });
  }

  const isAdmin = req.user?.roles.includes('admin');
  if (!isAdmin && existing.raised_by !== req.user.internal_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  await sql`DELETE FROM complaints WHERE id = ${id}`;
  res.json({ message: 'Complaint deleted' });
}));

export default router;
