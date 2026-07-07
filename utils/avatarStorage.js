import { supabaseAdmin } from '../db.js';

export const AVATAR_BUCKET = 'avatars';

let ensureBucketPromise = null;

/**
 * Ensure the public-read `avatars` bucket exists. Idempotent and memoised so it
 * runs at most once per process. All writes go through supabaseAdmin (service
 * role, bypasses RLS); a public bucket makes the stored objects directly
 * fetchable via getPublicUrl — matching how persons.photo_url is consumed
 * everywhere else in the app (plain URLs, no signed-URL refresh logic).
 */
export async function ensureAvatarBucket() {
  if (ensureBucketPromise) return ensureBucketPromise;

  ensureBucketPromise = (async () => {
    const { data: existing } = await supabaseAdmin.storage.getBucket(AVATAR_BUCKET);
    if (existing) return;

    const { error } = await supabaseAdmin.storage.createBucket(AVATAR_BUCKET, {
      public: true,
      fileSizeLimit: '1MB',
      allowedMimeTypes: ['image/jpeg'],
    });
    // Ignore "already exists" races between concurrent boots.
    if (error && !/already exists/i.test(error.message || '')) {
      throw error;
    }
  })().catch((e) => {
    // Reset so a transient failure can be retried on the next request.
    ensureBucketPromise = null;
    throw e;
  });

  return ensureBucketPromise;
}

/** Deterministic path so a re-upload overwrites in place (no orphan cleanup). */
export function avatarObjectPath(schoolId, personId) {
  return `${schoolId}/${personId}.jpg`;
}

/**
 * Upload (upsert) a normalised JPEG buffer and return its public URL with a
 * cache-busting query param. The storage path is stable, so RN <Image> /
 * expo-image would otherwise serve a stale cached copy after re-upload.
 */
export async function uploadAvatar(schoolId, personId, jpegBuffer) {
  await ensureAvatarBucket();
  const path = avatarObjectPath(schoolId, personId);

  const { error: uploadError } = await supabaseAdmin.storage
    .from(AVATAR_BUCKET)
    .upload(path, jpegBuffer, {
      contentType: 'image/jpeg',
      upsert: true,
      cacheControl: '3600',
    });
  if (uploadError) throw uploadError;

  const { data } = supabaseAdmin.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  const base = data?.publicUrl;
  if (!base) throw new Error('Failed to resolve avatar public URL');
  return `${base}?v=${Date.now()}`;
}

/** Remove a user's avatar object (best-effort — used by DELETE /users/me/photo). */
export async function removeAvatar(schoolId, personId) {
  await ensureAvatarBucket();
  const path = avatarObjectPath(schoolId, personId);
  const { error } = await supabaseAdmin.storage.from(AVATAR_BUCKET).remove([path]);
  if (error && !/not found/i.test(error.message || '')) throw error;
}
