import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../db.js';
import { DIARY_ATTACHMENTS_BUCKET } from './diaryStoragePath.js';

export { DIARY_ATTACHMENTS_BUCKET };
const MAX_STORED_BYTES = 8 * 1024 * 1024;

let ensureBucketPromise = null;

export async function ensureDiaryAttachmentsBucket() {
  if (ensureBucketPromise) return ensureBucketPromise;

  ensureBucketPromise = (async () => {
    const { data: existing } = await supabaseAdmin.storage.getBucket(DIARY_ATTACHMENTS_BUCKET);
    if (existing) return;

    const { error } = await supabaseAdmin.storage.createBucket(DIARY_ATTACHMENTS_BUCKET, {
      public: true,
      fileSizeLimit: `${MAX_STORED_BYTES}`,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'audio/mp4', 'audio/mpeg', 'audio/webm', 'audio/wav', 'audio/x-m4a'],
    });
    if (error && !/already exists/i.test(error.message || '')) throw error;
  })().catch((error) => {
    ensureBucketPromise = null;
    throw error;
  });

  return ensureBucketPromise;
}

export function diaryAttachmentPath(schoolId, kind, id, ext) {
  return `${schoolId}/${kind}/${id}.${ext}`;
}

export async function uploadDiaryAttachment({ schoolId, buffer, mimeType, kind = 'photos' }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Diary attachment is empty');
  }
  if (buffer.length > MAX_STORED_BYTES) {
    throw new Error('Diary attachment exceeds the 8 MB storage limit');
  }

  await ensureDiaryAttachmentsBucket();
  const id = randomUUID();
  const ext = extensionForMime(mimeType);
  const storagePath = diaryAttachmentPath(schoolId, kind, id, ext);
  const { error } = await supabaseAdmin.storage
    .from(DIARY_ATTACHMENTS_BUCKET)
    .upload(storagePath, buffer, {
      contentType: mimeType || 'application/octet-stream',
      cacheControl: '31536000',
      upsert: false,
    });
  if (error) throw error;

  const { data } = supabaseAdmin.storage.from(DIARY_ATTACHMENTS_BUCKET).getPublicUrl(storagePath);
  if (!data?.publicUrl) throw new Error('Failed to resolve diary attachment URL');
  return { url: data.publicUrl, storagePath, id };
}

export async function supabaseRemovePaths(paths) {
  const list = (paths || []).filter((item) => typeof item === 'string' && item.trim());
  if (list.length === 0) return { removed: 0 };
  await ensureDiaryAttachmentsBucket();
  const { error } = await supabaseAdmin.storage.from(DIARY_ATTACHMENTS_BUCKET).remove(list);
  if (error) throw error;
  return { removed: list.length };
}

function extensionForMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  return 'jpg';
}
