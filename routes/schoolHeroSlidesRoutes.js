import express from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import {
  handleWebsiteGalleryUploadError,
  singleWebsiteGalleryImage,
} from '../middleware/websiteGalleryUpload.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { isUuid } from '../utils/schoolPortalMedia.js';
import {
  createSlide,
  deleteSlide,
  listActiveSlides,
  listManagedSlides,
  reorderSlides,
  updateSlide,
} from '../services/schoolHeroSlidesService.js';

const router = express.Router();

function httpError(err, res) {
  const status = err.statusCode || 500;
  if (status >= 500) throw err;
  return res.status(status).json({ error: err.message });
}

import {
  getCelebrationSettings,
  updateCelebrationSettings,
} from '../services/celebration/celebrationSettingsService.js';
import { invalidateCelebrationCache } from '../services/celebration/celebrationService.js';

router.get(
  '/school-hero-slides',
  requireAuth,
  asyncHandler(async (req, res) => {
    const items = await listActiveSlides(req.schoolId, req.user);
    return sendSuccess(res, req.schoolId, { items });
  }),
);

router.get(
  '/admin/celebrations/settings',
  requireAuth,
  requirePermission('admin.manage'),
  asyncHandler(async (req, res) => {
    const settings = await getCelebrationSettings(req.schoolId);
    return sendSuccess(res, req.schoolId, { settings });
  }),
);

router.put(
  '/admin/celebrations/settings',
  requireAuth,
  requirePermission('admin.manage'),
  asyncHandler(async (req, res) => {
    try {
      const settings = await updateCelebrationSettings(req.schoolId, req.body || {});
      invalidateCelebrationCache(req.schoolId);
      return sendSuccess(res, req.schoolId, { settings });
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.get(
  '/admin/school-hero-slides',
  requireAuth,
  requirePermission('admin.manage'),
  asyncHandler(async (req, res) => {
    const items = await listManagedSlides(req.schoolId);
    return sendSuccess(res, req.schoolId, { items });
  }),
);

router.post(
  '/admin/school-hero-slides',
  requireAuth,
  requirePermission('admin.manage'),
  singleWebsiteGalleryImage,
  handleWebsiteGalleryUploadError,
  asyncHandler(async (req, res) => {
    try {
      const item = await createSlide(req.schoolId, req.user, {
        buffer: req.file?.buffer,
        title: req.body?.title,
        caption: req.body?.caption,
      });
      return sendSuccess(res, req.schoolId, { item }, 201);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.put(
  '/admin/school-hero-slides/reorder',
  requireAuth,
  requirePermission('admin.manage'),
  asyncHandler(async (req, res) => {
    try {
      const items = await reorderSlides(req.schoolId, req.body?.ids);
      return sendSuccess(res, req.schoolId, { items });
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.patch(
  '/admin/school-hero-slides/:id',
  requireAuth,
  requirePermission('admin.manage'),
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid slide id' });
    try {
      const patch = {};
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'title')) patch.title = req.body.title;
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'caption')) patch.caption = req.body.caption;
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'is_active')) patch.is_active = req.body.is_active;
      const item = await updateSlide(req.schoolId, req.params.id, patch);
      return sendSuccess(res, req.schoolId, { item });
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.delete(
  '/admin/school-hero-slides/:id',
  requireAuth,
  requirePermission('admin.manage'),
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid slide id' });
    try {
      const result = await deleteSlide(req.schoolId, req.params.id);
      return sendSuccess(res, req.schoolId, result);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

export default router;
