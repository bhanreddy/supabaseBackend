import express from 'express';
import sql from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { singleSignatureUpload, handleAvatarMulterError } from '../middleware/avatarUpload.js';
import { normalizePrincipalSignature } from '../utils/principalSignatureImage.js';
import { uploadPrincipalSignature, removePrincipalSignature } from '../utils/schoolAssetStorage.js';

const router = express.Router();

const SETTING_KEYS = [
  'school_name',
  'school_address',
  'school_phone',
  'school_email',
  'school_website',
  'school_logo_url',
  'school_tagline',
  'school_affiliation',
  'school_principal',
  'principal_signature_url',
  'school_recognition',
  'school_medium',
  'school_board',
  'enable_driver_bus_attendance',
  'result_ranking_method',
];

const RESULT_RANKING_METHODS = new Set(['competition', 'attendance_tiebreak', 'dense']);

function normalizeSettingValue(value) {
  if (value == null) return '';
  return String(value).trim();
}

function buildSettingsPayload(rows, schoolRow) {
  const settings = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }

  const payload = {};
  for (const key of SETTING_KEYS) {
    payload[key] = normalizeSettingValue(settings[key]);
  }

  if (!payload.school_name && schoolRow?.name) payload.school_name = schoolRow.name;
  if (!payload.school_address && schoolRow?.address) payload.school_address = schoolRow.address;
  if (!payload.school_logo_url && schoolRow?.logo_url) payload.school_logo_url = schoolRow.logo_url;

  return payload;
}

// ── GET /school-settings ───────────────────────────────────────────────────────
// Returns school branding/config for the authenticated user's school only.
// Tenant: users.school_id (see middleware/schoolId.js — this path uses JWT school, not query/body).
// SS1: Rows restricted with WHERE school_id = authenticated user's school.
// Any active school user (student, staff, etc.) may read; updates remain admin.manage.
//
// NOTE: this assumes school_settings has a school_id column.
// Schema: school_settings (school_id, key, value, updated_at)
// UNIQUE constraint: (school_id, key)
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const schoolId = req.user.schoolId;
    if (schoolId == null || schoolId === '') {
      return res.status(403).json({ error: 'No school associated with this account' });
    }
    if (req.schoolId != null && String(req.schoolId) !== String(schoolId)) {
      return res.status(403).json({ error: 'School scope mismatch' });
    }

    const rows = await sql`
      SELECT key, value
      FROM school_settings
      WHERE school_id = ${schoolId}
    `;

    const [schoolRow] = await sql`
      SELECT name, address, logo_url
      FROM schools
      WHERE id = ${schoolId}
    `;

    return sendSuccess(res, schoolId, buildSettingsPayload(rows, schoolRow));
  })
);

// ── PUT /school-settings ───────────────────────────────────────────────────────
// Admin-only — update school settings for the authenticated school only.
// SS2: UPSERT scoped to users.school_id (same JWT tenant as GET).
// SS3: requireAuth + requirePermission('admin.manage') guard.
router.put(
  '/',
  requireAuth,
  requirePermission('admin.manage'),
  asyncHandler(async (req, res) => {
    const schoolId = req.user.schoolId;
    if (schoolId == null || schoolId === '') {
      return res.status(403).json({ error: 'No school associated with this account' });
    }
    if (req.schoolId != null && String(req.schoolId) !== String(schoolId)) {
      return res.status(403).json({ error: 'School scope mismatch' });
    }
    const updates = { ...req.body }; // { school_name: 'XYZ', school_address: '...' }
    delete updates.school_id;

    if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: 'Request body must be a non-empty object of key-value pairs',
      });
    }

    const validKeys = SETTING_KEYS;

    for (const [key, value] of Object.entries(updates)) {
      if (!validKeys.includes(key)) {
        return res.status(400).json({ error: `Invalid setting key: ${key}` });
      }
      if (key === 'result_ranking_method' && !RESULT_RANKING_METHODS.has(value)) {
        return res.status(400).json({
          error: 'result_ranking_method must be competition, attendance_tiebreak, or dense',
        });
      }

      // SS2: UPSERT with (school_id, key) unique constraint — no cross-tenant writes possible
      await sql`
        INSERT INTO school_settings (school_id, key, value, updated_at)
        VALUES (${schoolId}, ${key}, ${value}, now())
        ON CONFLICT (school_id, key)
        DO UPDATE SET
          value      = EXCLUDED.value,
          updated_at = now()
      `;
    }

    // Return updated settings for this school only
    const rows = await sql`
      SELECT key, value
      FROM school_settings
      WHERE school_id = ${schoolId}
    `;

    const [schoolRow] = await sql`
      SELECT name, address, logo_url
      FROM schools
      WHERE id = ${schoolId}
    `;

    return sendSuccess(res, schoolId, {
      message: 'Settings updated',
      settings: buildSettingsPayload(rows, schoolRow),
    });
  })
);

// ── PATCH /school-settings/principal-signature ────────────────────────────────
// One school-scoped signature used on generated documents such as hall tickets.
router.patch(
  '/principal-signature',
  requireAuth,
  requirePermission('admin.manage'),
  singleSignatureUpload,
  handleAvatarMulterError,
  asyncHandler(async (req, res) => {
    const schoolId = req.user.schoolId;
    if (!req.file?.buffer?.length) {
      return res.status(400).json({
        error: 'No image provided. Attach an image under the "signature" field.',
      });
    }

    try {
      const { buffer } = await normalizePrincipalSignature(req.file.buffer);
      const signatureUrl = await uploadPrincipalSignature(schoolId, buffer);

      await sql`
        INSERT INTO school_settings (school_id, key, value, updated_at)
        VALUES (${schoolId}, 'principal_signature_url', ${signatureUrl}, now())
        ON CONFLICT (school_id, key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `;

      return sendSuccess(res, schoolId, {
        message: 'Principal signature updated',
        principal_signature_url: signatureUrl,
      });
    } catch (error) {
      if (/not a valid image/i.test(error?.message || '')) {
        return res.status(400).json({ error: 'The uploaded file is not a valid image.' });
      }
      throw error;
    }
  }),
);

router.delete(
  '/principal-signature',
  requireAuth,
  requirePermission('admin.manage'),
  asyncHandler(async (req, res) => {
    const schoolId = req.user.schoolId;
    await removePrincipalSignature(schoolId).catch(() => {});
    await sql`
      DELETE FROM school_settings
      WHERE school_id = ${schoolId} AND key = 'principal_signature_url'
    `;
    return sendSuccess(res, schoolId, {
      message: 'Principal signature removed',
      principal_signature_url: null,
    });
  }),
);

export default router;
