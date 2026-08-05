import { supabaseAdmin } from '../db.js';
import { MAX_GALLERY_IMAGE_BYTES } from './websiteGalleryImage.js';

export const SCHOOL_WEBSITE_BUCKET = 'school-website-assets';

let ensureBucketPromise = null;

export async function ensureSchoolWebsiteBucket() {
  if (ensureBucketPromise) return ensureBucketPromise;

  ensureBucketPromise = (async () => {
    const { data: existing } = await supabaseAdmin.storage.getBucket(SCHOOL_WEBSITE_BUCKET);
    if (existing) return;

    const { error } = await supabaseAdmin.storage.createBucket(SCHOOL_WEBSITE_BUCKET, {
      public: true,
      fileSizeLimit: `${MAX_GALLERY_IMAGE_BYTES}`,
      allowedMimeTypes: ['image/jpeg'],
    });
    if (error && !/already exists/i.test(error.message || '')) throw error;
  })().catch((error) => {
    ensureBucketPromise = null;
    throw error;
  });

  return ensureBucketPromise;
}

export function websiteGalleryObjectPath(schoolId, imageId) {
  return `${schoolId}/gallery/${imageId}.jpg`;
}

export async function uploadWebsiteGalleryImage(schoolId, imageId, jpegBuffer) {
  await ensureSchoolWebsiteBucket();
  const storagePath = websiteGalleryObjectPath(schoolId, imageId);
  const { error } = await supabaseAdmin.storage
    .from(SCHOOL_WEBSITE_BUCKET)
    .upload(storagePath, jpegBuffer, {
      contentType: 'image/jpeg',
      cacheControl: '31536000',
      upsert: false,
    });
  if (error) throw error;

  const { data } = supabaseAdmin.storage.from(SCHOOL_WEBSITE_BUCKET).getPublicUrl(storagePath);
  if (!data?.publicUrl) throw new Error('Failed to resolve gallery image URL');
  return { imageUrl: data.publicUrl, storagePath };
}

export async function removeWebsiteGalleryImage(storagePath) {
  if (!storagePath) return;
  await ensureSchoolWebsiteBucket();
  const { error } = await supabaseAdmin.storage.from(SCHOOL_WEBSITE_BUCKET).remove([storagePath]);
  if (error && !/not found/i.test(error.message || '')) throw error;
}
