import express from 'express';
import { requireAuth, requireAnyPermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  listApprovalRequests,
  approveApprovalRequest,
  rejectApprovalRequest,
  allowedApprovalTypes,
} from '../services/approvalService.js';

const router = express.Router();

const APPROVAL_PERMISSIONS = ['fee.underpayment.approve', 'approvals.manage', 'leaves.approve'];

/**
 * GET /approvals
 * List approval requests (default: PENDING).
 * Filter by status ('PENDING', 'APPROVED', 'REJECTED') or type/types.
 */
router.get('/', requireAuth, requireAnyPermission(APPROVAL_PERMISSIONS), asyncHandler(async (req, res) => {
  const { status = 'PENDING', type, types } = req.query;
  const isAdmin = req.user?.roles?.includes('admin');
  const allowedTypes = allowedApprovalTypes(req.user);

  const requestedTypes = types
    ? String(types).split(',').map((t) => t.trim()).filter(Boolean)
    : (typeof type === 'string' ? [type] : allowedTypes);
  const parsedTypes = requestedTypes.filter((candidate) => allowedTypes.includes(candidate));
  if (requestedTypes.length && !parsedTypes.length) {
    return res.status(403).json({ error: 'You do not have permission to review the requested approval type' });
  }

  const rows = await listApprovalRequests(req.schoolId, {
    status: typeof status === 'string' ? status : 'PENDING',
    types: parsedTypes,
    includePaymentDeletion: isAdmin,
  });
  return sendSuccess(res, req.schoolId, rows);
}));

/**
 * POST /approvals/:id/approve
 * Execute the registered handler for this request type atomically.
 */
router.post('/:id/approve', requireAuth, requireAnyPermission(APPROVAL_PERMISSIONS), asyncHandler(async (req, res) => {
  try {
    const outcome = await approveApprovalRequest(req.params.id, {
      schoolId: req.schoolId,
      reviewerId: req.user.internal_id,
      user: req.user,
    });
    return sendSuccess(res, req.schoolId, {
      message: 'Approval request approved',
      ...outcome,
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({
        error: error.code || error.message,
        message: error.message,
      });
    }
    throw error;
  }
}));

/**
 * POST /approvals/:id/reject
 * Reject without posting any ledger mutation.
 */
router.post('/:id/reject', requireAuth, requireAnyPermission(APPROVAL_PERMISSIONS), asyncHandler(async (req, res) => {
  const { reason } = req.body || {};
  try {
    const request = await rejectApprovalRequest(req.params.id, {
      schoolId: req.schoolId,
      reviewerId: req.user.internal_id,
      reviewReason: reason,
      user: req.user,
    });
    return sendSuccess(res, req.schoolId, {
      message: 'Approval request rejected',
      request,
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({
        error: error.code || error.message,
        message: error.message,
      });
    }
    throw error;
  }
}));

export default router;
