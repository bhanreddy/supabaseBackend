import express from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  handleWebsiteGalleryUploadError,
  singleWebsiteGalleryImage,
} from '../middleware/websiteGalleryUpload.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { isUuid } from '../utils/schoolPortalMedia.js';
import {
  createStory,
  deleteStory,
  listActiveStories,
  listManagedStories,
  markStoryViewed,
} from '../services/schoolStoriesService.js';

const router = express.Router();

function httpError(err, res) {
  const status = err.statusCode || 500;
  if (status >= 500) throw err;
  return res.status(status).json({ error: err.message });
}

function viewerId(req) {
  return req.user?.internal_id || req.user?.id;
}

router.get(
  '/school-stories',
  requireAuth,
  asyncHandler(async (req, res) => {
    const authors = await listActiveStories(req.schoolId, viewerId(req));
    return sendSuccess(res, req.schoolId, { authors });
  }),
);

router.get(
  '/school-stories/manage',
  requireAuth,
  requireRole('admin', 'principal', 'staff', 'teacher'),
  asyncHandler(async (req, res) => {
    const all = String(req.query.all || '') === '1' || String(req.query.all || '').toLowerCase() === 'true';
    const authors = await listManagedStories(req.schoolId, req.user, { all });
    return sendSuccess(res, req.schoolId, { authors });
  }),
);

router.post(
  '/school-stories',
  requireAuth,
  requireRole('admin', 'principal', 'staff', 'teacher'),
  singleWebsiteGalleryImage,
  handleWebsiteGalleryUploadError,
  asyncHandler(async (req, res) => {
    try {
      const item = await createStory(req.schoolId, req.user, {
        buffer: req.file?.buffer,
        caption: req.body?.caption,
      });
      return sendSuccess(res, req.schoolId, { item }, 201);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.post(
  '/school-stories/:id/view',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid story id' });
    try {
      const result = await markStoryViewed(req.schoolId, req.user, req.params.id);
      return sendSuccess(res, req.schoolId, result);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

router.delete(
  '/school-stories/:id',
  requireAuth,
  requireRole('admin', 'principal', 'staff', 'teacher'),
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid story id' });
    try {
      const result = await deleteStory(req.schoolId, req.user, req.params.id);
      return sendSuccess(res, req.schoolId, result);
    } catch (error) {
      return httpError(error, res);
    }
  }),
);

export default router;
