import express from 'express';
import sql from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

const FALLBACK_VERSION_RESPONSE = {
  minimum_version: '0.0.0',
  force_update_enabled: false,
};

// GET /app/version-check?school_id=<build-time school id>
// Public pre-login route. This is the only app route allowed to read school_id
// from the request because the value is baked into each school build.
router.get('/version-check', async (req, res) => {
  const schoolId = String(req.query?.school_id ?? '').trim();

  if (!schoolId) {
    return res.json(FALLBACK_VERSION_RESPONSE);
  }

  try {
    const [school] = await sql`
      SELECT minimum_app_version, force_update_enabled
      FROM schools
      WHERE id = ${schoolId}
        AND is_active = true
      LIMIT 1
    `;

    if (!school) {
      return res.json(FALLBACK_VERSION_RESPONSE);
    }

    return res.json({
      minimum_version: school.minimum_app_version || '0.0.0',
      force_update_enabled: Boolean(school.force_update_enabled),
    });
  } catch (error) {
    req.log?.warn({ err: error.message }, 'Version check failed open');
    return res.json(FALLBACK_VERSION_RESPONSE);
  }
});

// GET /app/payment-banner
// Authenticated route: school_id is derived from JWT only. Ignore any client
// school_id in query/body so tenants cannot inspect another school's config.
router.get(
  '/payment-banner',
  requireAuth,
  asyncHandler(async (req, res) => {
    const schoolId = req.user?.schoolId;
    if (schoolId == null || schoolId === '') {
      return res.status(403).json({ error: 'No school associated with this account' });
    }

    try {
      const [school] = await sql`
        SELECT payment_banner_enabled, payment_banner_reason
        FROM schools
        WHERE id = ${schoolId}
          AND is_active = true
        LIMIT 1
      `;

      if (!school) {
        return res.json({ enabled: false, reason: null });
      }

      return res.json({
        enabled: Boolean(school.payment_banner_enabled),
        reason: school.payment_banner_reason ?? null,
      });
    } catch (error) {
      req.log?.warn({ err: error.message }, 'Payment banner check failed closed');
      return res.json({ enabled: false, reason: null });
    }
  })
);

export default router;
