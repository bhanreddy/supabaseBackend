import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getActionCenterData } from '../services/actionCenterService.js';
import { requireRole } from '../middleware/requireRole.js';

const router = express.Router();

/**
 * GET /admin/action-center
 * Aggregated principal and leadership action center cockpit.
 * Consolidates critical alerts, attention items, and operational health.
 */
router.get(
  '/',
  requireAuth,
  requireRole('admin', 'principal', 'management', 'superadmin'),
  asyncHandler(async (req, res) => {
    const data = await getActionCenterData(req.schoolId, req.user);
    return sendSuccess(res, req.schoolId, data);
  }),
);

export default router;
