import { supabaseAdmin } from '../db.js';
import {
  ensureSchoolWebsiteBucket,
  removeWebsiteGalleryImage,
  SCHOOL_WEBSITE_BUCKET,
} from './websiteGalleryStorage.js';

export function schoolStoryObjectPath(schoolId, imageId) {
  return `${schoolId}/stories/${imageId}.jpg`;
}

export function schoolHeroSlideObjectPath(schoolId, imageId) {
  return `${schoolId}/hero-slides/${imageId}.jpg`;
}

export async function uploadSchoolPortalImage(storagePath, jpegBuffer) {
  await ensureSchoolWebsiteBucket();
  const { error } = await supabaseAdmin.storage
    .from(SCHOOL_WEBSITE_BUCKET)
    .upload(storagePath, jpegBuffer, {
      contentType: 'image/jpeg',
      cacheControl: '31536000',
      upsert: false,
    });
  if (error) throw error;

  const { data } = supabaseAdmin.storage.from(SCHOOL_WEBSITE_BUCKET).getPublicUrl(storagePath);
  if (!data?.publicUrl) throw new Error('Failed to resolve uploaded image URL');
  return { imageUrl: data.publicUrl, storagePath };
}

export async function removeSchoolPortalImage(storagePath) {
  return removeWebsiteGalleryImage(storagePath);
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value));
}

export function normalizePortalText(value, maxLength, fallback = null) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  return normalized.slice(0, maxLength);
}

export function resolveStoryAuthorRole(roles = []) {
  return roles.some((role) => ['admin', 'principal'].includes(role)) ? 'admin' : 'staff';
}

export function actorUserId(user) {
  return user?.internal_id || user?.id || null;
}

export function groupStoriesByAuthor(rows) {
  const byAuthor = new Map();
  for (const row of rows) {
    const key = row.uploaded_by || row.id;
    if (!byAuthor.has(key)) {
      byAuthor.set(key, {
        author_id: row.uploaded_by,
        author_name: row.author_name || 'School',
        author_photo_url: row.author_photo_url || null,
        author_role: row.author_role || 'staff',
        stories: [],
      });
    }
    byAuthor.get(key).stories.push({
      id: row.id,
      media_url: row.media_url,
      caption: row.caption || null,
      created_at: row.created_at,
      expires_at: row.expires_at,
      seen: Boolean(row.seen),
      can_delete: Boolean(row.can_delete),
    });
  }

  return [...byAuthor.values()].map((author) => ({
    ...author,
    stories: author.stories.slice().sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    ),
    has_unseen: author.stories.some((story) => !story.seen),
  }));
}
