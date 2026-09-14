import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import {
  resolveFeatureAccess,
  getAllFeatureEntitlements,
  requestFeatureAccess,
  subscribeFeatureNotification,
  getAdminFeatureAccessRequests,
  respondToFeatureAccessRequest,
} from '../services/featureAccessService.js';

const router = express.Router();

// All feature-access endpoints require authenticated user
router.use(requireAuth);

/**
 * GET /api/v1/feature-access
 * Bulk feature entitlement resolution for current session/school.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const schoolId = req.user.schoolId;
    const userId = req.user.id || req.user.internal_id;
    const role = (req.user.roles || [])[0] || 'student';

    const entitlements = await getAllFeatureEntitlements(schoolId, userId, role);
    return sendSuccess(res, schoolId, entitlements);
  })
);

/**
 * GET /api/v1/feature-access/admin/requests
 * School administrator view of pending feature access requests.
 */
router.get(
  '/admin/requests',
  requireRole('admin', 'principal'),
  asyncHandler(async (req, res) => {
    const schoolId = req.user.schoolId;
    const requests = await getAdminFeatureAccessRequests(schoolId);
    return sendSuccess(res, schoolId, { requests });
  })
);

/**
 * POST /api/v1/feature-access/admin/requests/:requestId/respond
 * Administrator approves or denies a feature access request.
 */
router.post(
  '/admin/requests/:requestId/respond',
  requireRole('admin', 'principal'),
  asyncHandler(async (req, res) => {
    const schoolId = req.user.schoolId;
    const adminId = req.user.id || req.user.internal_id;
    const { requestId } = req.params;
    const { status } = req.body;

    if (!['APPROVED', 'REJECTED'].includes(status)) {
      return sendError(res, 400, "Status must be either 'APPROVED' or 'REJECTED'");
    }

    const updated = await respondToFeatureAccessRequest({
      schoolId,
      requestId,
      status,
      reviewedBy: adminId,
    });

    return sendSuccess(res, schoolId, { request: updated });
  })
);

/**
 * GET /api/v1/feature-access/:featureKey
 * Resolves access state, normalized UI content, and role-sensitive actions for a single feature.
 */
router.get(
  '/:featureKey',
  asyncHandler(async (req, res) => {
    const { featureKey } = req.params;
    const schoolId = req.user.schoolId;
    const userId = req.user.id || req.user.internal_id;
    const role = (req.user.roles || [])[0] || 'student';

    const decision = await resolveFeatureAccess({
      schoolId,
      userId,
      role,
      featureKey,
    });

    return sendSuccess(res, schoolId, decision);
  })
);

/**
 * POST /api/v1/feature-access/:featureKey/request-access
 * Ask Administrator workflow. Creates a request with deduplication.
 */
router.post(
  '/:featureKey/request-access',
  asyncHandler(async (req, res) => {
    const { featureKey } = req.params;
    const schoolId = req.user.schoolId;
    const userId = req.user.id || req.user.internal_id;
    const role = (req.user.roles || [])[0] || 'staff';
    const { message, userName } = req.body;

    const result = await requestFeatureAccess({
      schoolId,
      userId,
      role,
      userName,
      featureKey,
      requestMessage: message,
    });

    return sendSuccess(res, schoolId, result, result.alreadyRequested ? 200 : 201);
  })
);

/**
 * POST /api/v1/feature-access/:featureKey/notify-me
 * Subscribe to notifications for a coming-soon feature.
 */
router.post(
  '/:featureKey/notify-me',
  asyncHandler(async (req, res) => {
    const { featureKey } = req.params;
    const schoolId = req.user.schoolId;
    const userId = req.user.id || req.user.internal_id;

    const result = await subscribeFeatureNotification({
      schoolId,
      userId,
      featureKey,
    });

    return sendSuccess(res, schoolId, result, result.alreadySubscribed ? 200 : 201);
  })
);

export default router;
