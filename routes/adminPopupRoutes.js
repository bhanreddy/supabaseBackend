import express from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import {
  handleWebsiteGalleryUploadError,
  singleWebsiteGalleryImage,
} from '../middleware/websiteGalleryUpload.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  listAdminPopups,
  getAdminPopup,
  createPopup,
  updatePopup,
  archivePopup,
  duplicatePopup,
  publishPopup,
  pausePopup,
  resumePopup,
  queueTestPopup,
  uploadPopupImage,
  estimateAudience,
  getPopupAnalytics,
  getAdminOverview,
} from '../services/popupService.js';

const router = express.Router();

function httpError(err, res) {
  const status = err.statusCode || 500;
  if (status >= 500) throw err;
  return res.status(status).json({ error: err.message });
}

router.get(
  '/',
  requireAuth,
  requirePermission('popups.create'),
  asyncHandler(async (req, res) => {
    try {
      const data = await listAdminPopups(req.schoolId, {
        status: req.query.status,
        search: req.query.search,
        page: req.query.page,
        pageSize: req.query.page_size || req.query.pageSize,
      });
      return sendSuccess(res, req.schoolId, data);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.get(
  '/overview',
  requireAuth,
  requirePermission('popups.analytics'),
  asyncHandler(async (req, res) => {
    try {
      const data = await getAdminOverview(req.schoolId);
      return sendSuccess(res, req.schoolId, data);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.post(
  '/estimate-audience',
  requireAuth,
  requirePermission('popups.create'),
  asyncHandler(async (req, res) => {
    try {
      const data = await estimateAudience(req.schoolId, req.body?.targeting || req.body);
      return sendSuccess(res, req.schoolId, data);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.post(
  '/',
  requireAuth,
  requirePermission('popups.create'),
  asyncHandler(async (req, res) => {
    try {
      const item = await createPopup(req.schoolId, req.user, req.body);
      return sendSuccess(res, req.schoolId, { item }, 201);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.get(
  '/:id',
  requireAuth,
  requirePermission('popups.create'),
  asyncHandler(async (req, res) => {
    try {
      const item = await getAdminPopup(req.schoolId, req.params.id);
      return sendSuccess(res, req.schoolId, { item });
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.patch(
  '/:id',
  requireAuth,
  requirePermission('popups.update'),
  asyncHandler(async (req, res) => {
    try {
      const item = await updatePopup(req.schoolId, req.params.id, req.user, req.body);
      return sendSuccess(res, req.schoolId, { item });
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.delete(
  '/:id',
  requireAuth,
  requirePermission('popups.delete'),
  asyncHandler(async (req, res) => {
    try {
      const result = await archivePopup(req.schoolId, req.params.id, req.user);
      return sendSuccess(res, req.schoolId, result);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.post(
  '/:id/duplicate',
  requireAuth,
  requirePermission('popups.create'),
  asyncHandler(async (req, res) => {
    try {
      const item = await duplicatePopup(req.schoolId, req.params.id, req.user);
      return sendSuccess(res, req.schoolId, { item }, 201);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.post(
  '/:id/publish',
  requireAuth,
  requirePermission('popups.publish'),
  asyncHandler(async (req, res) => {
    try {
      const item = await publishPopup(req.schoolId, req.params.id, req.user);
      return sendSuccess(res, req.schoolId, { item });
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.post(
  '/:id/pause',
  requireAuth,
  requirePermission('popups.publish'),
  asyncHandler(async (req, res) => {
    try {
      const item = await pausePopup(req.schoolId, req.params.id, req.user);
      return sendSuccess(res, req.schoolId, { item });
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.post(
  '/:id/resume',
  requireAuth,
  requirePermission('popups.publish'),
  asyncHandler(async (req, res) => {
    try {
      const item = await resumePopup(req.schoolId, req.params.id, req.user);
      return sendSuccess(res, req.schoolId, { item });
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.post(
  '/:id/test-send',
  requireAuth,
  requirePermission('popups.create'),
  asyncHandler(async (req, res) => {
    try {
      const result = await queueTestPopup(req.schoolId, req.params.id, req.user);
      return sendSuccess(res, req.schoolId, result);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.get(
  '/:id/analytics',
  requireAuth,
  requirePermission('popups.analytics'),
  asyncHandler(async (req, res) => {
    try {
      const data = await getPopupAnalytics(req.schoolId, req.params.id);
      return sendSuccess(res, req.schoolId, data);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.post(
  '/:id/image',
  requireAuth,
  requirePermission('popups.update'),
  singleWebsiteGalleryImage,
  handleWebsiteGalleryUploadError,
  asyncHandler(async (req, res) => {
    try {
      const item = await uploadPopupImage(req.schoolId, req.params.id, req.file?.buffer);
      return sendSuccess(res, req.schoolId, { item });
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

export default router;
