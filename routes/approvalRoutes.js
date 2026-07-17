import express from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  listApprovalRequests,
  approveApprovalRequest,
  rejectApprovalRequest,
} from '../services/approvalService.js';

const router = express.Router();

/**
 * GET /approvals
 * List approval requests (default: PENDING). Gated by fee.underpayment.approve
 * for now — future types can use requireAnyPermission.
 */
router.get('/', requireAuth, requirePermission('fee.underpayment.approve'), asyncHandler(async (req, res) => {
  const { status = 'PENDING', type } = req.query;
  const isAdmin = req.user?.roles?.includes('admin');
  if (type === 'fee_payment_deletion' && !isAdmin) {
    return res.status(403).json({ error: 'Only an admin can review payment deletion requests' });
  }
  const rows = await listApprovalRequests(req.schoolId, {
    status: typeof status === 'string' ? status : 'PENDING',
    type: typeof type === 'string' ? type : undefined,
    includePaymentDeletion: isAdmin,
  });
  return sendSuccess(res, req.schoolId, rows);
}));

/**
 * POST /approvals/:id/approve
 * Execute the registered handler for this request type atomically.
 */
router.post('/:id/approve', requireAuth, requirePermission('fee.underpayment.approve'), asyncHandler(async (req, res) => {
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
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
}));

/**
 * POST /approvals/:id/reject
 * Reject without posting any ledger mutation.
 */
router.post('/:id/reject', requireAuth, requirePermission('fee.underpayment.approve'), asyncHandler(async (req, res) => {
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
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
}));

export default router;
