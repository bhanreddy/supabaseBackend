import express from 'express';
import sql from '../db.js';
import { requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { getFeeCollectionAccess, FEE_COLLECTION_RESTRICTED } from '../services/feeCollectionAccessService.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();
router.use(requireAnyPermission(['fees.view', 'fees.collect']));

router.get('/', asyncHandler(async (req, res) => {
  // Status is a normal response so the UI can show an inline restriction.
  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, req.schoolId, await getFeeCollectionAccess(req.user));
}));

router.post('/request', requirePermission('fees.collect'), asyncHandler(async (req, res) => {
  const access = await getFeeCollectionAccess(req.user);
  if (access.allowed) return res.status(400).json({ error: 'Fee collection access is already available.' });
  if (access.code !== FEE_COLLECTION_RESTRICTED) {
    return res.status(403).json({ error: access.message, code: access.code });
  }
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  if (!note || note.length > 1000) {
    return res.status(400).json({ error: 'Enter a reason of up to 1000 characters.' });
  }
  // Identity and tenant come from authentication, never the request body.
  await sql`
    INSERT INTO access_requests (school_id, requested_by, department, request_note, status)
    SELECT ${req.user.schoolId}, ${req.user.internal_id || req.user.id}, 'accounts', ${note}, 'pending'
    WHERE NOT EXISTS (
      SELECT 1 FROM access_requests
      WHERE school_id = ${req.user.schoolId} AND requested_by = ${req.user.internal_id || req.user.id}
        AND department = 'accounts' AND status = 'pending'
    )
  `;
  return sendSuccess(res, req.schoolId, { message: 'Your fee collection access request is pending administrator approval.' });
}));

export default router;
