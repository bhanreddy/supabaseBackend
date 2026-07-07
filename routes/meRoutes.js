import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { resolveFeatures, registryDefaults } from '../utils/featureRegistry.js';

const router = express.Router();

/**
 * GET /api/v1/me/features
 * Effective { feature_key: boolean } map for the school in the JWT.
 * school_id is derived from req.user only — never from query/body.
 * Fail-safe: on any error, return registry defaults so the app never blanks.
 */
router.get(
  '/features',
  requireAuth,
  asyncHandler(async (req, res) => {
    const schoolId = req.user?.schoolId;
    if (schoolId == null || schoolId === '') {
      return res.status(403).json({ error: 'No school associated with this account' });
    }

    try {
      const features = await resolveFeatures(schoolId);
      return res.json({ features });
    } catch (error) {
      req.log?.warn({ err: error.message }, 'Feature resolve failed — serving registry defaults');
      return res.json({ features: registryDefaults() });
    }
  })
);

export default router;
