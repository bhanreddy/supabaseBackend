/**
 * PaperForge Engine proxy.
 *
 * Forwards SchoolIMS requests to the internal PaperForge Engine, injecting the
 * trusted identity headers `X-School-Id` / `X-User-Id`. Those values come ONLY
 * from the caller (the verified-token-derived schoolId/userId passed in by the
 * route) — never from any client-controlled source. The engine never sees the
 * raw JWT; the client never talks to the engine.
 *
 * Security/operational invariants:
 *  - The engine URL (config.paperforge.engineUrl) is internal config and is
 *    NEVER logged and NEVER returned to the client.
 *  - Errors are normalised into PaperForgeProxyError with a safe message + http
 *    status, so the global error handler can respond without leaking internals.
 *  - The upload route STREAMS the request body to the engine — the PDF is never
 *    buffered in this process.
 */
import axios from 'axios';
import config from '../config/env.js';

const ENGINE_URL = config.paperforge.engineUrl;

/**
 * Error type carrying a client-safe message + HTTP status. The global
 * errorHandler maps `.status` -> response code and emits `.message` as `error`.
 * No engine URL, host, or forwarded identity header is ever placed on it.
 */
export class PaperForgeProxyError extends Error {
  constructor(status, message, code = 'PF_ENGINE_ERROR') {
    super(message);
    this.name = 'PaperForgeProxyError';
    this.status = status;
    this.code = code;
  }
}

/** Build identity headers from server-derived values ONLY (token-derived in the route). */
function identityHeaders(schoolId, userId) {
  return {
    'X-School-Id': String(schoolId),
    'X-User-Id': String(userId),
  };
}

/** Pull a safe, human-readable message out of an engine error body without leaking internals. */
function extractEngineMessage(data, fallback) {
  if (data && typeof data === 'object') {
    if (typeof data.detail === 'string') return data.detail;
    // FastAPI validation errors come back as an array under `detail`.
    if (Array.isArray(data.detail)) return 'PaperForge rejected the request payload.';
    if (typeof data.error === 'string') return data.error;
  }
  if (typeof data === 'string' && data.trim()) return data.trim();
  return fallback;
}

/**
 * Convert any axios/network failure into a client-safe PaperForgeProxyError.
 * Crucially, we DO NOT attach the original axios error (its `.config.url`
 * contains the engine URL) — we construct a brand-new error with a clean stack.
 */
function normaliseError(err) {
  // Engine responded with a non-2xx status.
  if (err.response) {
    const status = err.response.status;
    if (status >= 500) {
      return new PaperForgeProxyError(502, 'PaperForge service error. Please try again later.', 'PF_ENGINE_ERROR');
    }
    // Forward client-actionable 4xx (e.g. 422 page cap / blur, 404 unknown job).
    const message = extractEngineMessage(err.response.data, 'PaperForge could not process the request.');
    return new PaperForgeProxyError(status, message, 'PF_ENGINE_ERROR');
  }

  // Timeout.
  if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '')) {
    return new PaperForgeProxyError(504, 'PaperForge request timed out. Please try again.', 'PF_ENGINE_TIMEOUT');
  }

  // Connection / DNS failures — never echo host or URL.
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH'].includes(err.code)) {
    return new PaperForgeProxyError(503, 'PaperForge service is temporarily unavailable.', 'PF_ENGINE_UNAVAILABLE');
  }

  return new PaperForgeProxyError(502, 'PaperForge request failed.', 'PF_ENGINE_ERROR');
}

/**
 * POST /ingest — stream the multipart PDF upload to the engine.
 * @param {object} args
 * @param {number|string} args.schoolId  Verified, token-derived school id.
 * @param {string}        args.userId    Verified, token-derived user id (users.id).
 * @param {import('stream').Readable} args.stream  The raw inbound request stream (multipart body).
 * @param {object}        args.contentType    Original request Content-Type (preserves multipart boundary).
 * @param {string|number} [args.contentLength] Original Content-Length, forwarded when present.
 * @returns {Promise<object>} Engine response body, e.g. { job_id, document_id }.
 */
export async function forwardIngest({ schoolId, userId, stream, contentType, contentLength }) {
  try {
    const headers = {
      ...identityHeaders(schoolId, userId),
      'Content-Type': contentType || 'application/octet-stream',
    };
    if (contentLength != null && String(contentLength).length > 0) {
      headers['Content-Length'] = String(contentLength);
    }

    const response = await axios.post(`${ENGINE_URL}/ingest`, stream, {
      headers,
      timeout: config.paperforge.uploadTimeoutMs,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      maxRedirects: 0,
    });
    return response.data;
  } catch (err) {
    throw normaliseError(err);
  }
}

/**
 * GET /ingest/{job_id} — proxy the ingestion status.
 * @returns {Promise<object>} Engine status body.
 */
export async function forwardIngestStatus({ schoolId, userId, jobId }) {
  try {
    const response = await axios.get(`${ENGINE_URL}/ingest/${encodeURIComponent(jobId)}`, {
      headers: identityHeaders(schoolId, userId),
      timeout: config.paperforge.timeoutMs,
      maxRedirects: 0,
    });
    return response.data;
  } catch (err) {
    throw normaliseError(err);
  }
}

/**
 * GET /health — proxy the engine health probe (auth required on our side).
 * @returns {Promise<object>} Engine health body.
 */
export async function forwardHealth({ schoolId, userId }) {
  try {
    const response = await axios.get(`${ENGINE_URL}/health`, {
      headers: identityHeaders(schoolId, userId),
      timeout: config.paperforge.timeoutMs,
      maxRedirects: 0,
    });
    return response.data;
  } catch (err) {
    throw normaliseError(err);
  }
}
