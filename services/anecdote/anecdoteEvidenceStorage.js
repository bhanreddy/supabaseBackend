import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../../db.js';
import logger from '../../utils/logger.js';

export const ANECDOTE_EVIDENCE_BUCKET = 'anecdote-evidence';
const MAX_STORED_BYTES = 10 * 1024 * 1024; // 10 MB

let ensureBucketPromise = null;

export async function ensureAnecdoteEvidenceBucket() {
  if (ensureBucketPromise) return ensureBucketPromise;

  ensureBucketPromise = (async () => {
    try {
      const { data: existing } = await supabaseAdmin.storage.getBucket(ANECDOTE_EVIDENCE_BUCKET);
      if (existing) return;

      const { error } = await supabaseAdmin.storage.createBucket(ANECDOTE_EVIDENCE_BUCKET, {
        public: true,
        fileSizeLimit: `${MAX_STORED_BYTES}`,
        allowedMimeTypes: [
          'image/jpeg', 'image/png', 'image/webp',
          'application/pdf',
          'audio/mp4', 'audio/mpeg', 'audio/webm', 'audio/wav', 'audio/x-m4a',
        ],
      });
      if (error && !/already exists/i.test(error.message || '')) throw error;
    } catch (err) {
      if (!/already exists/i.test(err.message || '')) {
        logger.warn({ err: err.message }, 'ensureAnecdoteEvidenceBucket warning');
      }
    }
  })().catch((error) => {
    ensureBucketPromise = null;
    throw error;
  });

  return ensureBucketPromise;
}

export function anecdoteEvidencePath(schoolId, anecdoteId, fileId, ext) {
  return `${schoolId}/${anecdoteId}/${fileId}.${ext}`;
}

export async function uploadAnecdoteEvidence({
  schoolId,
  anecdoteId,
  buffer,
  mimeType,
  originalFileName = '',
}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Evidence attachment is empty');
  }
  if (buffer.length > MAX_STORED_BYTES) {
    throw new Error('Evidence attachment exceeds 10 MB storage limit');
  }

  await ensureAnecdoteEvidenceBucket();
  const fileId = randomUUID();
  const ext = extensionForMime(mimeType, originalFileName);
  const storagePath = anecdoteEvidencePath(schoolId, anecdoteId, fileId, ext);

  const { error } = await supabaseAdmin.storage
    .from(ANECDOTE_EVIDENCE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: mimeType || 'application/octet-stream',
      cacheControl: '31536000',
      upsert: false,
    });
  if (error) throw error;

  const { data } = supabaseAdmin.storage.from(ANECDOTE_EVIDENCE_BUCKET).getPublicUrl(storagePath);
  if (!data?.publicUrl) throw new Error('Failed to resolve evidence attachment URL');

  return {
    url: data.publicUrl,
    storagePath,
    fileId,
    fileSize: buffer.length,
    fileName: originalFileName || `${fileId}.${ext}`,
    mimeType,
  };
}

function extensionForMime(mimeType, fileName = '') {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (fileName.includes('.')) {
    const parts = fileName.split('.');
    return parts[parts.length - 1].toLowerCase();
  }
  return 'jpg';
}
