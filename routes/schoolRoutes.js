import express from 'express';
import sql from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { setSchoolFeeMode } from '../services/feeModeService.js';

const router = express.Router();

// GET /schools/:id/profile
// :id is cosmetic for REST shape — tenant is always req.schoolId from JWT, never req.params.
router.get(
  '/:id/profile',
  requireAuth,
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    if (schoolId == null || schoolId === '') {
      return res.status(403).json({ error: 'No school associated with this account' });
    }

    const [schoolRow] = await sql`
      SELECT name, logo_url
      FROM schools
      WHERE id = ${schoolId}
        AND is_active = true
      LIMIT 1
    `;

    const settingsRows = await sql`
      SELECT key, value
      FROM school_settings
      WHERE school_id = ${schoolId}
        AND key IN (
          'school_name',
          'school_address',
          'school_phone',
          'school_email',
          'school_website',
          'school_logo_url',
          'school_affiliation'
        )
    `;

    const settings = {};
    for (const row of settingsRows) {
      settings[row.key] = row.value;
    }

    const pick = (...values) => {
      for (const value of values) {
        const text = String(value ?? '').trim();
        if (text.length > 0) return text;
      }
      return null;
    };

    const profile = {
      name: pick(settings.school_name, schoolRow?.name),
      address: pick(settings.school_address),
      phone: pick(settings.school_phone),
      email: pick(settings.school_email),
      website: pick(settings.school_website),
      affiliation: pick(settings.school_affiliation),
      logo_url: pick(settings.school_logo_url, schoolRow?.logo_url),
    };

    return sendSuccess(res, schoolId, profile);
  })
);

/**
 * PATCH /schools/:id/fee-mode
 * Toggle per-class vs per-section fee structure mode.
 * :id is cosmetic — tenant is always req.schoolId from JWT.
 */
router.patch(
  '/:id/fee-mode',
  requirePermission('fees.manage'),
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    if (schoolId == null || schoolId === '') {
      return res.status(403).json({ error: 'No school associated with this account' });
    }

    const { fee_mode } = req.body;
    if (!fee_mode || !['per_class', 'per_section'].includes(fee_mode)) {
      return res.status(400).json({ error: "fee_mode must be 'per_class' or 'per_section'" });
    }

    try {
      const result = await setSchoolFeeMode(schoolId, fee_mode);
      return sendSuccess(res, schoolId, result);
    } catch (error) {
      if (error.status) {
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }
  })
);

export default router;
