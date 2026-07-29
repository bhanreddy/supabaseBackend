import { supabaseAdmin } from '../db.js';
import { AVATAR_BUCKET, ensureAvatarBucket } from './avatarStorage.js';

export function principalSignatureObjectPath(schoolId) {
  return `school-assets/${schoolId}/principal-signature.jpg`;
}

export async function uploadPrincipalSignature(schoolId, jpegBuffer) {
  await ensureAvatarBucket();
  const path = principalSignatureObjectPath(schoolId);

  const { error } = await supabaseAdmin.storage
    .from(AVATAR_BUCKET)
    .upload(path, jpegBuffer, {
      contentType: 'image/jpeg',
      upsert: true,
      cacheControl: '3600',
    });
  if (error) throw error;

  const { data } = supabaseAdmin.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error('Failed to resolve principal signature URL');
  return `${data.publicUrl}?v=${Date.now()}`;
}

export async function removePrincipalSignature(schoolId) {
  await ensureAvatarBucket();
  const path = principalSignatureObjectPath(schoolId);
  const { error } = await supabaseAdmin.storage.from(AVATAR_BUCKET).remove([path]);
  if (error && !/not found/i.test(error.message || '')) throw error;
}
