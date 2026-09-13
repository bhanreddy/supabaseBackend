import express from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  listEligiblePopups,
  listInbox,
  unreadCount,
  markPopupViewed,
  markPopupClicked,
  markPopupDismissed,
  markPopupAcknowledged,
  markInboxRead,
} from '../services/popupService.js';

const router = express.Router();

function httpError(err, res) {
  const status = err.statusCode || 500;
  if (status >= 500) throw err;
  return res.status(status).json({ error: err.message });
}

router.get(
  '/eligible',
  requireAuth,
  requirePermission('popups.view'),
  asyncHandler(async (req, res) => {
    try {
      const items = await listEligiblePopups(req.schoolId, req.user, {
        sessionId: String(req.query.session_id || req.get('x-popup-session') || '').slice(0, 64) || null,
      });
      return sendSuccess(res, req.schoolId, { items });
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.get(
  '/inbox',
  requireAuth,
  requirePermission('popups.view'),
  asyncHandler(async (req, res) => {
    try {
      const items = await listInbox(req.schoolId, req.user, {
        unreadOnly: String(req.query.unread_only || '') === 'true',
        limit: req.query.limit,
      });
      return sendSuccess(res, req.schoolId, { items });
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.get(
  '/unread-count',
  requireAuth,
  requirePermission('popups.view'),
  asyncHandler(async (req, res) => {
    try {
      const count = await unreadCount(req.schoolId, req.user);
      return sendSuccess(res, req.schoolId, { count });
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.post(
  '/:popupId/view',
  requireAuth,
  requirePermission('popups.view'),
  asyncHandler(async (req, res) => {
    try {
      const result = await markPopupViewed(req.schoolId, req.params.popupId, req.user, {
        sessionId: String(req.body?.session_id || req.get('x-popup-session') || '').slice(0, 64) || null,
      });
      return sendSuccess(res, req.schoolId, result);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.post(
  '/:popupId/click',
  requireAuth,
  requirePermission('popups.view'),
  asyncHandler(async (req, res) => {
    try {
      const result = await markPopupClicked(req.schoolId, req.params.popupId, req.user, {
        actionType: req.body?.actionType || req.body?.action_type || null,
        target: req.body?.target || null,
      });
      return sendSuccess(res, req.schoolId, result);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.post(
  '/:popupId/dismiss',
  requireAuth,
  requirePermission('popups.view'),
  asyncHandler(async (req, res) => {
    try {
      const result = await markPopupDismissed(req.schoolId, req.params.popupId, req.user);
      return sendSuccess(res, req.schoolId, result);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.post(
  '/:popupId/acknowledge',
  requireAuth,
  requirePermission('popups.view'),
  asyncHandler(async (req, res) => {
    try {
      const result = await markPopupAcknowledged(req.schoolId, req.params.popupId, req.user);
      return sendSuccess(res, req.schoolId, result);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.post(
  '/:popupId/read',
  requireAuth,
  requirePermission('popups.view'),
  asyncHandler(async (req, res) => {
    try {
      const result = await markInboxRead(req.schoolId, req.params.popupId, req.user);
      return sendSuccess(res, req.schoolId, result);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

export default router;
