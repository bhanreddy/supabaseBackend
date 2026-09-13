import sql from '../db.js';
import { randomUUID } from 'node:crypto';
import { normalizeWebsiteGalleryImage } from '../utils/websiteGalleryImage.js';
import {
  actorUserId,
  normalizePortalText,
  schoolHeroSlideObjectPath,
  uploadSchoolPortalImage,
  removeSchoolPortalImage,
} from '../utils/schoolPortalMedia.js';
import { getCelebrationSlides } from './celebration/celebrationService.js';
import { CELEBRATION_PRIORITIES } from './celebration/celebration.types.js';
import logger from '../utils/logger.js';

export const MAX_HERO_SLIDES = 12;

function missingRelation(error) {
  return error?.code === '42P01' || /does not exist/i.test(error?.message || '');
}

export async function listActiveSlides(schoolId, user = null) {
  let normalSlides = [];
  try {
    normalSlides = await sql`
      SELECT id, image_url, title, caption, display_order
      FROM school_hero_slides
      WHERE school_id = ${schoolId}
        AND is_active = TRUE
      ORDER BY display_order ASC, created_at ASC, id ASC
    `;
  } catch (error) {
    if (!missingRelation(error)) throw error;
  }

  const normalWithMeta = normalSlides.map((slide) => ({
    ...slide,
    slide_type: 'IMAGE',
    priority: CELEBRATION_PRIORITIES.NORMAL_BANNER,
  }));

  let celebrationSlides = [];
  try {
    celebrationSlides = await getCelebrationSlides(schoolId, user);
  } catch (err) {
    logger.error({ event: 'celebration_banner_failed', schoolId, err }, 'Failed to load celebration slides, continuing with normal slides');
  }

  return [...celebrationSlides, ...normalWithMeta].sort((a, b) => {
    const priorityDelta = (b.priority || 0) - (a.priority || 0);
    if (priorityDelta !== 0) return priorityDelta;
    return (a.display_order || 0) - (b.display_order || 0);
  });
}

export async function listManagedSlides(schoolId) {
  return sql`
    SELECT id, image_url, title, caption, display_order, is_active, created_at, updated_at
    FROM school_hero_slides
    WHERE school_id = ${schoolId}
    ORDER BY display_order ASC, created_at ASC, id ASC
  `;
}

export async function createSlide(schoolId, user, { buffer, title, caption } = {}) {
  if (!buffer?.length) {
    const error = new Error('Attach an image under the "image" field.');
    error.statusCode = 400;
    throw error;
  }

  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count
    FROM school_hero_slides
    WHERE school_id = ${schoolId}
  `;
  if (count >= MAX_HERO_SLIDES) {
    const error = new Error(`A school can have up to ${MAX_HERO_SLIDES} hero slides.`);
    error.statusCode = 400;
    throw error;
  }

  let normalized;
  try {
    normalized = await normalizeWebsiteGalleryImage(buffer);
  } catch (err) {
    const error = new Error(
      /optimize/i.test(err?.message || '') ? err.message : 'The uploaded file is not a valid supported image.',
    );
    error.statusCode = 400;
    throw error;
  }

  const imageId = randomUUID();
  const storagePath = schoolHeroSlideObjectPath(schoolId, imageId);
  const { imageUrl } = await uploadSchoolPortalImage(storagePath, normalized.buffer);

  try {
    const [item] = await sql`
      INSERT INTO school_hero_slides (
        id, school_id, image_url, storage_path, title, caption,
        display_order, uploaded_by
      )
      VALUES (
        ${imageId},
        ${schoolId},
        ${imageUrl},
        ${storagePath},
        ${normalizePortalText(title, 80)},
        ${normalizePortalText(caption, 180)},
        COALESCE((SELECT MAX(display_order) + 1 FROM school_hero_slides WHERE school_id = ${schoolId}), 0),
        ${actorUserId(user)}
      )
      RETURNING id, image_url, title, caption, display_order, is_active, created_at, updated_at
    `;
    return item;
  } catch (error) {
    await removeSchoolPortalImage(storagePath).catch(() => {});
    throw error;
  }
}

export async function updateSlide(schoolId, slideId, patch = {}) {
  const title = Object.prototype.hasOwnProperty.call(patch, 'title')
    ? normalizePortalText(patch.title, 80)
    : undefined;
  const caption = Object.prototype.hasOwnProperty.call(patch, 'caption')
    ? normalizePortalText(patch.caption, 180)
    : undefined;
  const isActive = typeof patch.is_active === 'boolean' ? patch.is_active : undefined;

  const [item] = await sql`
    UPDATE school_hero_slides
    SET
      title = COALESCE(${title}, title),
      caption = COALESCE(${caption}, caption),
      is_active = COALESCE(${isActive}, is_active)
    WHERE id = ${slideId} AND school_id = ${schoolId}
    RETURNING id, image_url, title, caption, display_order, is_active, created_at, updated_at
  `;
  if (!item) {
    const error = new Error('Slide not found');
    error.statusCode = 404;
    throw error;
  }
  return item;
}

export async function reorderSlides(schoolId, ids) {
  const uniqueIds = [...new Set((ids || []).map((id) => String(id)))];
  const existing = await sql`
    SELECT id FROM school_hero_slides WHERE school_id = ${schoolId}
  `;
  const existingIds = new Set(existing.map((row) => String(row.id)));
  if (uniqueIds.length !== existingIds.size || uniqueIds.some((id) => !existingIds.has(id))) {
    const error = new Error('Reorder list must include every slide exactly once.');
    error.statusCode = 400;
    throw error;
  }

  await sql.begin(async (tx) => {
    for (let index = 0; index < uniqueIds.length; index += 1) {
      await tx`
        UPDATE school_hero_slides
        SET display_order = ${index}
        WHERE id = ${uniqueIds[index]} AND school_id = ${schoolId}
      `;
    }
  });

  return listManagedSlides(schoolId);
}

export async function deleteSlide(schoolId, slideId) {
  const [removed] = await sql`
    DELETE FROM school_hero_slides
    WHERE id = ${slideId} AND school_id = ${schoolId}
    RETURNING id, storage_path
  `;
  if (!removed) {
    const error = new Error('Slide not found');
    error.statusCode = 404;
    throw error;
  }
  await removeSchoolPortalImage(removed.storage_path).catch(() => {});
  return { id: removed.id };
}
