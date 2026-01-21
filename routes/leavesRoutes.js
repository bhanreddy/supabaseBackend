import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * GET /leaves
 * List leave applications
 */
router.get('/', requirePermission('leaves.view'), asyncHandler(async (req, res) => {
    const { status, leave_type, from_date, to_date, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const isAdmin = req.user?.roles.includes('admin') || req.user?.permissions.includes('leaves.approve');

    let leaves;
    if (isAdmin) {
        // Admin/approvers see all
        leaves = await sql`
      SELECT 
        la.id, la.leave_type, la.start_date, la.end_date, la.reason, la.status,
        la.review_remarks, la.created_at,
        applicant.display_name as applicant_name,
        reviewer.display_name as reviewed_by_name,
        la.reviewed_at
      FROM leave_applications la
      JOIN users u ON la.applicant_id = u.id
      JOIN persons applicant ON u.person_id = applicant.id
      LEFT JOIN users ru ON la.reviewed_by = ru.id
      LEFT JOIN persons reviewer ON ru.person_id = reviewer.id
      WHERE TRUE
        ${status ? sql`AND la.status = ${status}` : sql``}
        ${leave_type ? sql`AND la.leave_type = ${leave_type}` : sql``}
        ${from_date ? sql`AND la.start_date >= ${from_date}` : sql``}
        ${to_date ? sql`AND la.end_date <= ${to_date}` : sql``}
      ORDER BY la.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    } else {
        // Regular users see only their leaves
        leaves = await sql`
      SELECT 
        la.id, la.leave_type, la.start_date, la.end_date, la.reason, la.status,
        la.review_remarks, la.created_at, la.reviewed_at
      FROM leave_applications la
      WHERE la.applicant_id = ${req.user.internal_id}
        ${status ? sql`AND la.status = ${status}` : sql``}
      ORDER BY la.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    }

    res.json(leaves);
}));

/**
 * GET /leaves/:id
 * Get leave application details
 */
router.get('/:id', requirePermission('leaves.view'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [leave] = await sql`
    SELECT 
      la.*,
      applicant.display_name as applicant_name,
      reviewer.display_name as reviewed_by_name
    FROM leave_applications la
    JOIN users u ON la.applicant_id = u.id
    JOIN persons applicant ON u.person_id = applicant.id
    LEFT JOIN users ru ON la.reviewed_by = ru.id
    LEFT JOIN persons reviewer ON ru.person_id = reviewer.id
    WHERE la.id = ${id}
  `;

    if (!leave) {
        return res.status(404).json({ error: 'Leave application not found' });
    }

    // Check access
    const isAdmin = req.user?.roles.includes('admin') || req.user?.permissions.includes('leaves.approve');
    if (!isAdmin && leave.applicant_id !== req.user.internal_id) {
        return res.status(403).json({ error: 'Access denied' });
    }

    res.json(leave);
}));

/**
 * POST /leaves
 * Apply for leave
 */
router.post('/', requirePermission('leaves.apply'), asyncHandler(async (req, res) => {
    const { leave_type, start_date, end_date, reason } = req.body;

    if (!leave_type || !start_date || !end_date || !reason) {
        return res.status(400).json({ error: 'leave_type, start_date, end_date, and reason are required' });
    }

    const validTypes = ['casual', 'sick', 'earned', 'maternity', 'paternity', 'unpaid', 'other'];
    if (!validTypes.includes(leave_type)) {
        return res.status(400).json({ error: `leave_type must be one of: ${validTypes.join(', ')}` });
    }

    // Check for overlapping leaves
    const overlapping = await sql`
    SELECT id FROM leave_applications
    WHERE applicant_id = ${req.user.internal_id}
      AND status IN ('pending', 'approved')
      AND daterange(start_date, end_date, '[]') && daterange(${start_date}::date, ${end_date}::date, '[]')
  `;

    if (overlapping.length > 0) {
        return res.status(400).json({ error: 'You have overlapping leave applications' });
    }

    const [leave] = await sql`
    INSERT INTO leave_applications (applicant_id, leave_type, start_date, end_date, reason)
    VALUES (${req.user.internal_id}, ${leave_type}, ${start_date}, ${end_date}, ${reason})
    RETURNING *
  `;

    res.status(201).json({ message: 'Leave application submitted', leave });
}));

/**
 * PUT /leaves/:id
 * Approve/reject leave (admin) or update own pending leave
 */
router.put('/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, review_remarks, leave_type, start_date, end_date, reason } = req.body;

    const [existing] = await sql`SELECT applicant_id, status FROM leave_applications WHERE id = ${id}`;
    if (!existing) {
        return res.status(404).json({ error: 'Leave application not found' });
    }

    const isApprover = req.user?.roles.includes('admin') || req.user?.permissions.includes('leaves.approve');
    const isOwner = existing.applicant_id === req.user.internal_id;

    // Only approvers can approve/reject
    if (status && (status === 'approved' || status === 'rejected')) {
        if (!isApprover) {
            return res.status(403).json({ error: 'Only authorized users can approve/reject leaves' });
        }

        const [updated] = await sql`
      UPDATE leave_applications
      SET 
        status = ${status},
        review_remarks = ${review_remarks},
        reviewed_by = ${req.user.internal_id},
        reviewed_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;

        return res.json({ message: `Leave ${status}`, leave: updated });
    }

    // Owner can update pending leaves or cancel
    if (isOwner) {
        if (existing.status !== 'pending' && status !== 'cancelled') {
            return res.status(400).json({ error: 'Can only update pending leaves' });
        }

        const [updated] = await sql`
      UPDATE leave_applications
      SET 
        status = COALESCE(${status}, status),
        leave_type = COALESCE(${leave_type}, leave_type),
        start_date = COALESCE(${start_date}, start_date),
        end_date = COALESCE(${end_date}, end_date),
        reason = COALESCE(${reason}, reason)
      WHERE id = ${id}
      RETURNING *
    `;

        return res.json({ message: 'Leave updated', leave: updated });
    }

    return res.status(403).json({ error: 'Access denied' });
}));

/**
 * DELETE /leaves/:id
 * Cancel/delete leave (owner only, pending status)
 */
router.delete('/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [existing] = await sql`SELECT applicant_id, status FROM leave_applications WHERE id = ${id}`;
    if (!existing) {
        return res.status(404).json({ error: 'Leave application not found' });
    }

    const isAdmin = req.user?.roles.includes('admin');
    if (!isAdmin && existing.applicant_id !== req.user.internal_id) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (!isAdmin && existing.status !== 'pending') {
        return res.status(400).json({ error: 'Can only delete pending leaves' });
    }

    await sql`DELETE FROM leave_applications WHERE id = ${id}`;
    res.json({ message: 'Leave application deleted' });
}));

export default router;
