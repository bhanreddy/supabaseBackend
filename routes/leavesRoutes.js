import express from 'express';
import sql from '../db.js';
import { requirePermission, requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendNotificationToUsers } from '../services/notificationService.js';
import { translateFields } from '../services/geminiTranslator.js';

const router = express.Router();

/**
 * GET /leaves
 * List leave applications — admins see all within school; others see own
 */
router.get('/', requirePermission('leaves.view'), asyncHandler(async (req, res) => {
  const { status, leave_type, from_date, to_date, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  const schoolId = req.schoolId;

  const isAdmin = req.user?.roles.includes('admin') || req.user?.permissions.includes('leaves.approve');

  let leaves;
  if (isAdmin) {
    leaves = await sql`
      SELECT
        la.id, la.leave_type, la.start_date, la.end_date, la.reason, la.reason_te, la.status,
        la.review_remarks, la.review_remarks_te, la.created_at,
        applicant.display_name as applicant_name,
        (SELECT r.code FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.user_id = u.id LIMIT 1) as applicant_role,
        reviewer.display_name as reviewed_by_name,
        la.reviewed_at
      FROM leave_applications la
      JOIN users u ON la.applicant_id = u.id
      JOIN persons applicant ON u.person_id = applicant.id
      LEFT JOIN users ru ON la.reviewed_by = ru.id
      LEFT JOIN persons reviewer ON ru.person_id = reviewer.id
      WHERE u.school_id = ${schoolId}
        ${status ? sql`AND la.status = ${status}` : sql``}
        ${leave_type ? sql`AND la.leave_type = ${leave_type}` : sql``}
        ${from_date ? sql`AND la.start_date >= ${from_date}` : sql``}
        ${to_date ? sql`AND la.end_date <= ${to_date}` : sql``}
        ${req.query.role ? sql`AND EXISTS (
          SELECT 1 FROM user_roles ur
          JOIN roles r ON ur.role_id = r.id
          WHERE ur.user_id = u.id AND r.code = ${req.query.role}
        )` : sql``}
      ORDER BY la.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    leaves = await sql`
      SELECT
        la.id, la.leave_type, la.start_date, la.end_date, la.reason, la.reason_te, la.status,
        la.review_remarks, la.review_remarks_te, la.created_at, la.reviewed_at,
        reviewer.display_name as reviewed_by_name
      FROM leave_applications la
      LEFT JOIN users ru ON la.reviewed_by = ru.id
      LEFT JOIN persons reviewer ON ru.person_id = reviewer.id
      WHERE la.applicant_id = ${req.user.internal_id}
        AND la.school_id = ${schoolId}
        ${status ? sql`AND la.status = ${status}` : sql``}
      ORDER BY la.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return sendSuccess(res, req.schoolId, leaves);
}));

/**
 * GET /leaves/:id
 * LV1: school_id scoped via users join
 */
router.get('/:id', requirePermission('leaves.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

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
      AND la.school_id = ${schoolId}
      AND u.school_id = ${schoolId}
  `;

  if (!leave) {
    return res.status(404).json({ error: 'Leave application not found' });
  }

  const isAdmin = req.user?.roles.includes('admin') || req.user?.permissions.includes('leaves.approve');
  if (!isAdmin && leave.applicant_id !== req.user.internal_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  return sendSuccess(res, req.schoolId, leave);
}));

/**
 * POST /leaves — Apply for leave
 */
router.post('/', requirePermission('leaves.apply'), asyncHandler(async (req, res) => {
  const { leave_type, start_date, end_date, reason } = req.body;
  const schoolId = req.schoolId;

  if (!leave_type || !start_date || !end_date || !reason) {
    return res.status(400).json({ error: 'leave_type, start_date, end_date, and reason are required' });
  }

  const validTypes = ['casual', 'sick', 'earned', 'maternity', 'paternity', 'unpaid', 'other'];
  if (!validTypes.includes(leave_type)) {
    return res.status(400).json({ error: `leave_type must be one of: ${validTypes.join(', ')}` });
  }

  const overlapping = await sql`
    SELECT id FROM leave_applications
    WHERE applicant_id = ${req.user.internal_id}
      AND status IN ('pending', 'approved')
      AND daterange(start_date, end_date, '[]') && daterange(${start_date}::date, ${end_date}::date, '[]')
  `;

  if (overlapping.length > 0) {
    return res.status(400).json({ error: 'You have overlapping leave applications' });
  }

  let reason_te = null;
  try {
    const te = await translateFields({ reason });
    reason_te = te.reason || null;
  } catch (e) {}

  const [leave] = await sql`
    INSERT INTO leave_applications (school_id, applicant_id, leave_type, start_date, end_date, reason, reason_te)
    VALUES (${schoolId}, ${req.user.internal_id}, ${leave_type}, ${start_date}, ${end_date}, ${reason}, ${reason_te})
    RETURNING *
  `;

  // Notify admins at this school
  (async () => {
    try {
      const admins = await sql`
        SELECT u.id
        FROM users u
        JOIN user_roles ur ON u.id = ur.user_id
        JOIN roles r ON ur.role_id = r.id
        WHERE r.code = 'admin'
          AND u.account_status = 'active'
          AND u.school_id = ${schoolId}
      `;

      if (admins.length > 0) {
        const adminIds = [...new Set(admins.map((a) => a.id))];
        await sendNotificationToUsers(adminIds, 'LEAVE_SUBMITTED', { message: 'New leave request submitted.' });
      }
    } catch (err) {}
  })();

  return sendSuccess(res, req.schoolId, { message: 'Leave application submitted', leave }, 201);
}));

/**
 * PUT /leaves/:id
 * LV2: ownership check scoped to school_id via users join
 */
router.put('/:id', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, review_remarks, leave_type, start_date, end_date, reason } = req.body;
  const schoolId = req.schoolId;

  // LV2: Fetch with school-scoped ownership
  const [existing] = await sql`
    SELECT la.applicant_id, la.status
    FROM leave_applications la
    JOIN users u ON la.applicant_id = u.id
    WHERE la.id = ${id}
      AND u.school_id = ${schoolId}
  `;
  if (!existing) return res.status(404).json({ error: 'Leave application not found' });

  const isApprover = req.user?.roles.includes('admin') || req.user?.permissions.includes('leaves.approve');
  const isOwner = existing.applicant_id === req.user.internal_id;

  if (status && (status === 'approved' || status === 'rejected')) {
    if (!isApprover) {
      return res.status(403).json({ error: 'Only authorized users can approve/reject leaves' });
    }

    let sql_review_remarks_te = sql`review_remarks_te`;
    if (review_remarks) {
      try {
        const te = await translateFields({ review_remarks });
        if (te.review_remarks) sql_review_remarks_te = sql`${te.review_remarks}`;
      } catch (e) {}
    }

    const [updated] = await sql`
      UPDATE leave_applications
      SET
        status = ${status},
        review_remarks = ${review_remarks || null},
        review_remarks_te = ${sql_review_remarks_te},
        reviewed_by = ${req.user.internal_id},
        reviewed_at = NOW()
      WHERE id = ${id}
      AND school_id = ${req.schoolId}
      RETURNING *
    `;

    (async () => {
      try {
        if (status && existing.status !== status) {
          let eventType = null;
          if (status === 'approved') eventType = 'LEAVE_APPROVED';
          else if (status === 'rejected') eventType = 'LEAVE_REJECTED';

          if (eventType) {
            await sendNotificationToUsers(
              [existing.applicant_id],
              eventType,
              { message: `Your leave application has been ${status}.` }
            );
          }
        }
      } catch (err) {}
    })();

    return sendSuccess(res, req.schoolId, { message: `Leave ${status}`, leave: updated });
  }

  if (isOwner) {
    if (existing.status !== 'pending' && status !== 'cancelled') {
      return res.status(400).json({ error: 'Can only update pending leaves' });
    }

    let sql_reason_te = sql`reason_te`;
    if (reason) {
      try {
        const te = await translateFields({ reason });
        if (te.reason) sql_reason_te = sql`${te.reason}`;
      } catch (e) {}
    }

    const [updated] = await sql`
      UPDATE leave_applications
      SET
        status = COALESCE(${status ?? null}, status),
        leave_type = COALESCE(${leave_type ?? null}, leave_type),
        start_date = COALESCE(${start_date ?? null}, start_date),
        end_date = COALESCE(${end_date ?? null}, end_date),
        reason = COALESCE(${reason ?? null}, reason),
        reason_te = ${sql_reason_te}
      WHERE id = ${id} AND school_id = ${schoolId}
      RETURNING *
    `;

    return sendSuccess(res, req.schoolId, { message: 'Leave updated', leave: updated });
  }

  return res.status(403).json({ error: 'Access denied' });
}));

/**
 * DELETE /leaves/:id
 * LV2: ownership check scoped to school_id
 */
router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

  // LV2: School-scoped ownership
  const [existing] = await sql`
    SELECT la.applicant_id, la.status
    FROM leave_applications la
    JOIN users u ON la.applicant_id = u.id
    WHERE la.id = ${id}
      AND u.school_id = ${schoolId}
  `;
  if (!existing) return res.status(404).json({ error: 'Leave application not found' });

  const isAdmin = req.user?.roles.includes('admin');
  if (!isAdmin && existing.applicant_id !== req.user.internal_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!isAdmin && existing.status !== 'pending') {
    return res.status(400).json({ error: 'Can only delete pending leaves' });
  }

  await sql`DELETE FROM leave_applications WHERE id = ${id} AND school_id = ${schoolId} AND school_id = ${req.schoolId}`;
  return sendSuccess(res, req.schoolId, { message: 'Leave application deleted' });
}));

export default router;