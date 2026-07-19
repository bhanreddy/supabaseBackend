/**
 * PaperForge gateway routes — mounted at /api/v1/paperforge.
 *
 * SchoolIMS remains the single auth authority. Every route:
 *   1. requireAuth        — explicit JWT gate (identifyUser is global but
 *                           non-rejecting, so we must require auth per route).
 *   2. requireSchoolId    — GLOBAL middleware; for these paths (registered in
 *                           JWT_SCHOOL_ID_PATHS) it derives req.schoolId from
 *                           the verified token, never from client input.
 *   3. pfEnabled          — per-school feature gate (403 PF_NOT_ENABLED if off).
 *   4. handler            — proxies to the internal PaperForge Engine.
 *
 * SECURITY INVARIANT: schoolId and userId forwarded to the engine come ONLY
 * from the verified token (req.user.schoolId / req.user.internal_id) — never
 * from req.body, req.query, or client headers.
 *
 * Generation and export use the same verified, tenant-bound identity contract.
 */
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { pfEnabled } from '../middleware/pfEnabled.middleware.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { isPaperForgeEnabled } from '../config/env.js';
import {
  forwardIngest,
  forwardIngestStatus,
  forwardHealth,
  forwardGenerate,
  forwardExport,
} from '../services/paperforgeProxy.service.js';

const router = express.Router();

const PAPERFORGE_ROLES = new Set([
  'admin', 'superadmin', 'principal', 'hod', 'head of department',
  'staff', 'teacher', 'instructor',
]);
const PAPERFORGE_PERMISSIONS = new Set(['academics.view', 'exams.view', 'marks.enter']);

function requirePaperForgeAccess(req, res, next) {
  const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
  const permissions = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
  const allowed =
    roles.some((role) => PAPERFORGE_ROLES.has(String(role).trim().toLowerCase())) ||
    permissions.some((permission) => PAPERFORGE_PERMISSIONS.has(String(permission).trim()));
  if (!allowed) {
    return res.status(403).json({ error: 'Forbidden: Paper generation access is required', code: 'PF_FORBIDDEN' });
  }
  return next();
}

/**
 * Infra guard: if the PaperForge Engine URL is not configured (env var unset),
 * the integration is disabled. Short-circuit every PaperForge route with a clear
 * 503 instead of attempting a proxy call against a missing engine URL. When the
 * env var IS set this is a no-op and behaviour is identical to before.
 */
router.use((req, res, next) => {
  if (!isPaperForgeEnabled()) {
    return res.status(503).json({ error: 'PaperForge integration is not configured' });
  }
  return next();
});

/**
 * POST /api/v1/paperforge/ingest
 * Multipart PDF upload, STREAMED to engine POST /ingest (no in-memory buffering).
 * Returns the engine's { job_id, document_id }.
 */
router.post(
  '/ingest',
  requireAuth,
  requirePaperForgeAccess,
  pfEnabled,
  asyncHandler(async (req, res) => {
    const data = await forwardIngest({
      schoolId: req.user.schoolId,       // token-derived
      userId: req.user.internal_id,      // token-derived (users.id)
      stream: req,                       // raw multipart body, piped through
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
    });
    return sendSuccess(res, req.schoolId, data, 202);
  })
);

/**
 * GET /api/v1/paperforge/ingest/:jobId
 * Proxies engine GET /ingest/{job_id}.
 */
router.get(
  '/ingest/:jobId',
  requireAuth,
  requirePaperForgeAccess,
  pfEnabled,
  asyncHandler(async (req, res) => {
    const data = await forwardIngestStatus({
      schoolId: req.user.schoolId,       // token-derived
      userId: req.user.internal_id,      // token-derived (users.id)
      jobId: req.params.jobId,
    });
    return sendSuccess(res, req.schoolId, data);
  })
);

/**
 * GET /api/v1/paperforge/health
 * Proxies engine health (auth required on our side; useful for ops).
 */
router.get(
  '/health',
  requireAuth,
  requirePaperForgeAccess,
  pfEnabled,
  asyncHandler(async (req, res) => {
    const data = await forwardHealth({
      schoolId: req.user.schoolId,       // token-derived
      userId: req.user.internal_id,      // token-derived (users.id)
    });
    return sendSuccess(res, req.schoolId, data);
  })
);

router.post(
  '/generate',
  requireAuth,
  requirePaperForgeAccess,
  pfEnabled,
  asyncHandler(async (req, res) => {
    const data = await forwardGenerate({
      schoolId: req.user.schoolId,
      userId: req.user.internal_id,
      blueprint: req.body,
    });
    return sendSuccess(res, req.schoolId, data);
  })
);

router.get(
  '/export/:paperId',
  requireAuth,
  requirePaperForgeAccess,
  pfEnabled,
  asyncHandler(async (req, res) => {
    const format = req.query.format === 'docx' ? 'docx' : 'pdf';
    const response = await forwardExport({
      schoolId: req.user.schoolId,
      userId: req.user.internal_id,
      paperId: req.params.paperId,
      format,
    });
    res.status(response.status);
    if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
    if (response.headers['content-disposition']) res.setHeader('Content-Disposition', response.headers['content-disposition']);
    response.data.pipe(res);
  })
);

export default router;
