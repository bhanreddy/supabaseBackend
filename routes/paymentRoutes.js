/**
 * paymentRoutes.js — Phase 2: PG credential-save path ONLY.
 *
 * Mounted at /api/v1/admin/payments (see server.js).
 *
 * SECURITY:
 *   - school_id is ALWAYS req.schoolId, which requireSchoolId derives from the JWT
 *     because these paths are listed in middleware/schoolId.js -> JWT_SCHOOL_ID_PATHS.
 *     Any school_id sent in the request body/query is ignored.
 *   - Admin-only (requireRole).
 *   - POST /credentials is additionally gated by the live pg_enabled flag (read from DB).
 *   - Responses NEVER include credentials, ciphertext, IVs, or tags.
 */

import express from 'express';
import sql from '../db.js';
import { verifyToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { saveCredentials, getStatus } from '../services/cashfreeService.js';

const router = express.Router();

/**
 * Gate: actually reads schools.pg_enabled and 403s if it is not true.
 * (Not a comment-only gate — this hits the DB.) school_id is JWT-derived (req.schoolId).
 */
const requirePgEnabled = asyncHandler(async (req, res, next) => {
  const schoolId = parseInt(req.schoolId, 10);
  if (!Number.isInteger(schoolId) || schoolId <= 0) {
    return sendError(res, 401, 'Unauthorized');
  }
  const [school] = await sql`SELECT pg_enabled FROM schools WHERE id = ${schoolId} LIMIT 1`;
  if (!school) return sendError(res, 404, 'School not found');
  if (school.pg_enabled !== true) {
    return sendError(res, 403, 'Payment gateway is not enabled for this school');
  }
  next();
});

/**
 * POST /api/v1/admin/payments/credentials
 * Body: { app_id, secret_key, environment: 'sandbox' | 'production' }
 * Saves Cashfree PG credentials for the authenticated admin's school (JWT-derived).
 */
router.post(
  '/credentials',
  verifyToken,
  requireRole('admin', 'superadmin'),
  requirePgEnabled,
  asyncHandler(async (req, res) => {
    const schoolId = parseInt(req.schoolId, 10); // JWT-derived ONLY — body school_id is ignored
    const { app_id, secret_key, environment } = req.body || {};

    if (!app_id || !secret_key || !environment) {
      return sendError(res, 400, 'app_id, secret_key and environment are required');
    }
    if (environment !== 'sandbox' && environment !== 'production') {
      return sendError(res, 400, "environment must be 'sandbox' or 'production'");
    }

    const result = await saveCredentials(schoolId, {
      appId: String(app_id),
      secretKey: String(secret_key),
      environment,
    });

    // result is lifecycle status only — { state, environment, configuredAt }. No secrets.
    return sendSuccess(res, String(schoolId), result, 201);
  })
);

/**
 * GET /api/v1/admin/payments/status
 * Returns lifecycle status only. Never returns ciphertext, IVs, tags, or any credential.
 * Not gated by pg_enabled — an admin can read NOT_CONFIGURED before NexSyrus enables PG.
 */
router.get(
  '/status',
  verifyToken,
  requireRole('admin', 'superadmin'),
  asyncHandler(async (req, res) => {
    const schoolId = parseInt(req.schoolId, 10); // JWT-derived ONLY
    const status = await getStatus(schoolId);
    return sendSuccess(res, String(schoolId), status);
  })
);

export default router;
