import { randomUUID } from 'node:crypto';
import express from 'express';
import sql from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import {
  handleWebsiteGalleryUploadError,
  singleWebsiteGalleryImage,
} from '../middleware/websiteGalleryUpload.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { normalizeWebsiteGalleryImage } from '../utils/websiteGalleryImage.js';
import {
  removeWebsiteGalleryImage,
  uploadWebsiteGalleryImage,
} from '../utils/websiteGalleryStorage.js';

const router = express.Router();
const MAX_GALLERY_ITEMS = 100;

export function normalizeGalleryText(value, maxLength, fallback = null) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  return normalized.slice(0, maxLength);
}

function parseSchoolId(value) {
  const schoolId = Number(value);
  return Number.isSafeInteger(schoolId) && schoolId > 0 ? schoolId : null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));
}

function gallerySelect(schoolId) {
  return sql`
    SELECT id, image_url, alt_text, caption, category, display_order, created_at
    FROM school_website_gallery
    WHERE school_id = ${schoolId}
    ORDER BY display_order ASC, created_at ASC, id ASC
  `;
}

// Public, read-only endpoint used by every school landing page. The caller's
// school_id selects content but grants no mutation authority.
router.get('/public/website-gallery', asyncHandler(async (req, res) => {
  const schoolId = parseSchoolId(req.schoolId);
  if (!schoolId) return res.status(400).json({ error: 'A valid school_id is required' });

  const [school] = await sql`
    SELECT id FROM schools WHERE id = ${schoolId} AND is_active = true LIMIT 1
  `;
  if (!school) return res.status(404).json({ error: 'School not found' });

  const items = await gallerySelect(schoolId);
  res.set('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=300');
  return sendSuccess(res, schoolId, { items });
}));

// Authenticated admin list. req.schoolId is JWT-derived by schoolId middleware.
router.get(
  '/admin/website-gallery',
  requireAuth,
  requirePermission('admin.manage'),
  asyncHandler(async (req, res) => {
    const items = await gallerySelect(req.schoolId);
    return sendSuccess(res, req.schoolId, { items });
  }),
);

router.post(
  '/admin/website-gallery',
  requireAuth,
  requirePermission('admin.manage'),
  singleWebsiteGalleryImage,
  handleWebsiteGalleryUploadError,
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'Attach an image under the "image" field.' });
    }

    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count
      FROM school_website_gallery
      WHERE school_id = ${schoolId}
    `;
    if (count >= MAX_GALLERY_ITEMS) {
      return res.status(400).json({ error: `A school gallery can contain up to ${MAX_GALLERY_ITEMS} photos.` });
    }

    const category = normalizeGalleryText(req.body.category, 60, 'School Life');
    const caption = normalizeGalleryText(req.body.caption, 180);
    const altText = normalizeGalleryText(
      req.body.alt_text,
      180,
      caption || `${category} at school`,
    );

    let normalized;
    try {
      normalized = await normalizeWebsiteGalleryImage(req.file.buffer);
    } catch (error) {
      const message = /optimize/i.test(error?.message || '')
        ? error.message
        : 'The uploaded file is not a valid supported image.';
      return res.status(400).json({ error: message });
    }

    const imageId = randomUUID();
    const { imageUrl, storagePath } = await uploadWebsiteGalleryImage(
      schoolId,
      imageId,
      normalized.buffer,
    );

    try {
      const [item] = await sql`
        INSERT INTO school_website_gallery (
          id, school_id, image_url, storage_path, alt_text, caption,
          category, display_order, uploaded_by
        )
        VALUES (
          ${imageId}, ${schoolId}, ${imageUrl}, ${storagePath}, ${altText}, ${caption},
          ${category},
          COALESCE((SELECT MAX(display_order) + 1 FROM school_website_gallery WHERE school_id = ${schoolId}), 0),
          ${req.user.internal_id || req.user.id}
        )
        RETURNING id, image_url, alt_text, caption, category, display_order, created_at
      `;
      return sendSuccess(res, schoolId, { item }, 201);
    } catch (error) {
      await removeWebsiteGalleryImage(storagePath).catch(() => {});
      throw error;
    }
  }),
);

router.delete(
  '/admin/website-gallery/:id',
  requireAuth,
  requirePermission('admin.manage'),
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid gallery photo id' });
    const [removed] = await sql`
      DELETE FROM school_website_gallery
      WHERE id = ${req.params.id} AND school_id = ${schoolId}
      RETURNING id, storage_path
    `;
    if (!removed) return res.status(404).json({ error: 'Gallery photo not found' });

    await removeWebsiteGalleryImage(removed.storage_path).catch((error) => {
      req.log?.warn({ error, storagePath: removed.storage_path }, 'Gallery storage cleanup failed');
    });
    return sendSuccess(res, schoolId, { id: removed.id, message: 'Photo removed' });
  }),
);

export default router;
