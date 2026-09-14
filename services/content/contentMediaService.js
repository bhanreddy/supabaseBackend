import sharp from 'sharp';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../../db.js';
import { ensureSchoolWebsiteBucket, SCHOOL_WEBSITE_BUCKET } from '../../utils/websiteGalleryStorage.js';
import logger from '../../utils/logger.js';

export const MAX_CONTENT_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
export const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Optimize an uploaded image buffer and create a compressed JPEG + a lightweight thumbnail.
 */
export async function processContentImage(buffer, mimeType) {
  if (!buffer || buffer.length === 0) {
    throw new Error('Image buffer is empty.');
  }
  if (buffer.length > MAX_CONTENT_IMAGE_BYTES) {
    throw new Error(`Image exceeds maximum allowed size of ${MAX_CONTENT_IMAGE_BYTES / (1024 * 1024)}MB.`);
  }

  // Full image: max width 1600, quality 82 JPEG
  const fullJpegBuffer = await sharp(buffer)
    .rotate() // auto-orient from EXIF
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, progressive: true })
    .toBuffer();

  // Thumbnail: max width 400, quality 75 JPEG
  const thumbJpegBuffer = await sharp(buffer)
    .rotate()
    .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75, progressive: true })
    .toBuffer();

  return { fullJpegBuffer, thumbJpegBuffer };
}

/**
 * Upload an image and its thumbnail to Supabase Storage under the school's tenant directory.
 */
export async function uploadContentMedia({ schoolId, buffer, mimeType, caption = null }) {
  await ensureSchoolWebsiteBucket();
  const mediaId = randomUUID();
  const { fullJpegBuffer, thumbJpegBuffer } = await processContentImage(buffer, mimeType);

  const fullStoragePath = `${schoolId}/content/${mediaId}.jpg`;
  const thumbStoragePath = `${schoolId}/content/${mediaId}_thumb.jpg`;

  // Upload full image
  const { error: fullErr } = await supabaseAdmin.storage
    .from(SCHOOL_WEBSITE_BUCKET)
    .upload(fullStoragePath, fullJpegBuffer, {
      contentType: 'image/jpeg',
      cacheControl: '31536000',
      upsert: false,
    });
  if (fullErr) {
    logger.error({ fullErr, schoolId }, 'Failed to upload full content image to storage');
    throw fullErr;
  }

  // Upload thumbnail
  const { error: thumbErr } = await supabaseAdmin.storage
    .from(SCHOOL_WEBSITE_BUCKET)
    .upload(thumbStoragePath, thumbJpegBuffer, {
      contentType: 'image/jpeg',
      cacheControl: '31536000',
      upsert: false,
    });
  if (thumbErr) {
    logger.error({ thumbErr, schoolId }, 'Failed to upload thumbnail to storage');
    // Continue if full image succeeded
  }

  const { data: fullUrlData } = supabaseAdmin.storage.from(SCHOOL_WEBSITE_BUCKET).getPublicUrl(fullStoragePath);
  const { data: thumbUrlData } = supabaseAdmin.storage.from(SCHOOL_WEBSITE_BUCKET).getPublicUrl(thumbStoragePath);

  return {
    mediaId,
    url: fullUrlData.publicUrl,
    storagePath: fullStoragePath,
    thumbnailUrl: thumbUrlData?.publicUrl || fullUrlData.publicUrl,
    caption,
  };
}

/**
 * Delete a media file and its thumbnail from Supabase Storage.
 */
export async function deleteContentMedia(storagePath) {
  if (!storagePath) return;
  try {
    await ensureSchoolWebsiteBucket();
    const thumbPath = storagePath.replace(/\.jpg$/, '_thumb.jpg');
    await supabaseAdmin.storage.from(SCHOOL_WEBSITE_BUCKET).remove([storagePath, thumbPath]);
  } catch (err) {
    logger.warn({ err: err.message, storagePath }, 'Error removing content media from storage');
  }
}
