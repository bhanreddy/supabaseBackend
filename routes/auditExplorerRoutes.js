import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { queryAuditLogs } from '../services/auditExplorerService.js';

const router = express.Router();

/**
 * GET /admin/audit-explorer
 * Admin-only searchable, paginated forensic audit query with automated secret masking.
 */
router.get('/', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const {
    from_date,
    to_date,
    actor_id,
    entity,
    action,
    limit = 50,
    offset = 0,
  } = req.query;

  const logs = await queryAuditLogs(req.schoolId, {
    fromDate: from_date,
    toDate: to_date,
    actorId: actor_id,
    entity,
    action,
    limit: Number(limit) || 50,
    offset: Number(offset) || 0,
  });

  return sendSuccess(res, req.schoolId, logs);
}));

export default router;
