import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../../db.js';
import logger from '../../utils/logger.js';

export const ANECDOTE_EVIDENCE_BUCKET = 'anecdote-evidence';
export const ANECDOTE_EVIDENCE_SIGNED_URL_TTL_SECONDS = 15 * 60;
const MAX_STORED_BYTES = 10 * 1024 * 1024; // 10 MB

const BUCKET_OPTIONS = {
  public: false,
  fileSizeLimit: `${MAX_STORED_BYTES}`,
  allowedMimeTypes: [
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf',
    'audio/mp4', 'audio/mpeg', 'audio/webm', 'audio/wav', 'audio/x-m4a',
  ],
};

let ensureBucketPromise = null;

export async function ensureAnecdoteEvidenceBucket(storage = supabaseAdmin.storage) {
  if (ensureBucketPromise) return ensureBucketPromise;

  ensureBucketPromise = (async () => {
    try {
      const { data: existing, error: lookupError } = await storage.getBucket(ANECDOTE_EVIDENCE_BUCKET);
      if (existing) {
        const { error } = await storage.updateBucket(ANECDOTE_EVIDENCE_BUCKET, BUCKET_OPTIONS);
        if (error) throw error;
        return;
      }
      if (lookupError && !/not found|404/i.test(lookupError.message || '')) throw lookupError;

      const { error } = await storage.createBucket(ANECDOTE_EVIDENCE_BUCKET, BUCKET_OPTIONS);
      if (error && !/already exists/i.test(error.message || '')) throw error;
    } catch (err) {
      if (!/already exists/i.test(err.message || '')) {
        logger.error({ err: err.message }, 'ensureAnecdoteEvidenceBucket failed');
        throw err;
      }
    }
  })().catch((error) => {
    ensureBucketPromise = null;
    throw error;
  });

  return ensureBucketPromise;
}

export function resetAnecdoteEvidenceBucketCache() {
  ensureBucketPromise = null;
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
  storage = supabaseAdmin.storage,
}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Evidence attachment is empty');
  }
  if (buffer.length > MAX_STORED_BYTES) {
    throw new Error('Evidence attachment exceeds 10 MB storage limit');
  }

  await ensureAnecdoteEvidenceBucket(storage);
  const fileId = randomUUID();
  const ext = extensionForMime(mimeType, originalFileName);
  const storagePath = anecdoteEvidencePath(schoolId, anecdoteId, fileId, ext);

  const { error } = await storage
    .from(ANECDOTE_EVIDENCE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: mimeType || 'application/octet-stream',
      cacheControl: '31536000',
      upsert: false,
    });
  if (error) throw error;

  const url = await getAnecdoteEvidenceSignedUrl({ schoolId, storagePath, storage });

  return {
    url,
    storagePath,
    fileId,
    fileSize: buffer.length,
    fileName: originalFileName || `${fileId}.${ext}`,
    mimeType,
  };
}

/**
 * Produce a short-lived URL only after confirming the object belongs to the
 * authenticated school. This prevents a caller from signing another tenant's
 * object path even if that path is somehow disclosed.
 */
export async function getAnecdoteEvidenceSignedUrl({
  schoolId,
  storagePath,
  expiresIn = ANECDOTE_EVIDENCE_SIGNED_URL_TTL_SECONDS,
  storage = supabaseAdmin.storage,
}) {
  const normalizedSchoolId = String(schoolId || '').trim();
  const normalizedPath = String(storagePath || '').replace(/^\/+/, '');
  if (!normalizedSchoolId || !normalizedPath.startsWith(`${normalizedSchoolId}/`)) {
    const error = new Error('Anecdote evidence path does not belong to this school');
    error.status = 403;
    throw error;
  }

  const startedAt = Date.now();
  const { data, error } = await storage
    .from(ANECDOTE_EVIDENCE_BUCKET)
    .createSignedUrl(normalizedPath, expiresIn);
  if (error) throw error;
  if (!data?.signedUrl) throw new Error('Failed to create evidence attachment signed URL');

  logger.info({
    schoolId: normalizedSchoolId,
    durationMs: Date.now() - startedAt,
    expiresIn,
  }, 'anecdote_evidence_signed_url_created');
  return data.signedUrl;
}

export async function signAnecdoteEvidenceList(evidence, schoolId, options = {}) {
  if (!Array.isArray(evidence) || evidence.length === 0) return evidence || [];

  return Promise.all(evidence.map(async (item) => {
    if (!item?.storage_path) return item;
    try {
      const fileUrl = await getAnecdoteEvidenceSignedUrl({
        schoolId,
        storagePath: item.storage_path,
        ...options,
      });
      const { storage_path: _storagePath, ...safeItem } = item;
      return { ...safeItem, file_url: fileUrl };
    } catch (err) {
      logger.warn({
        schoolId,
        evidenceId: item.id,
        status: err.status,
        err: err.message,
      }, 'anecdote_evidence_signed_url_failed');
      const { storage_path: _storagePath, ...safeItem } = item;
      return { ...safeItem, file_url: null };
    }
  }));
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
