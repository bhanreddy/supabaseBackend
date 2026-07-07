import express from 'express';
import sql from '../db.js';
import { verifyToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/** Basic UPI VPA check: non-empty handle, contains @, non-empty provider/handle tail (e.g. school@okaxis). */
function isValidUpiId(raw) {
  const s = String(raw ?? '').trim();
  if (!s.includes('@')) return false;
  const at = s.lastIndexOf('@');
  const local = s.slice(0, at);
  const host = s.slice(at + 1);
  if (!local || !host || /\s/.test(s)) return false;
  return true;
}

/**
 * GET /upi — school UPI settings (accounts / admin / superadmin school role)
 * school_id from JWT only (req.schoolId set by middleware for this path).
 */
router.get(
  '/upi',
  verifyToken,
  requireRole('accounts', 'admin', 'superadmin', 'principal'),
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;

    const rows = await sql`
      SELECT key, value
      FROM school_settings
      WHERE school_id = ${schoolId}
        AND key IN ('upi_id', 'upi_display_name')
    `;

    const map = { upi_id: '', upi_display_name: '' };
    for (const row of rows) {
      if (row.key === 'upi_id') map.upi_id = row.value ?? '';
      if (row.key === 'upi_display_name') map.upi_display_name = row.value ?? '';
    }

    return sendSuccess(res, schoolId, {
      upi_id: map.upi_id,
      display_name: map.upi_display_name,
    });
  })
);

/**
 * PUT /upi — save UPI VPA + display name (admin / principal / superadmin)
 * Body: { upi_id, display_name } — school_id never from client.
 * Note: Admin layout allows principal; principals must be able to save school UPI.
 */
router.put(
  '/upi',
  verifyToken,
  requireRole('admin', 'superadmin', 'principal'),
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const upiId = typeof req.body?.upi_id === 'string' ? req.body.upi_id.trim() : '';
    const displayName =
      typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : '';

    if (!isValidUpiId(upiId)) {
      return res.status(400).json({
        error: 'Invalid UPI ID. Use a valid VPA (e.g. schoolname@okaxis).',
      });
    }

    if (!displayName || displayName.length > 80) {
      return res.status(400).json({
        error: 'display_name is required and must be at most 80 characters.',
      });
    }

    await sql`
      INSERT INTO school_settings (school_id, key, value, updated_at)
      VALUES (${schoolId}, 'upi_id', ${upiId}, now())
      ON CONFLICT (school_id, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;

    await sql`
      INSERT INTO school_settings (school_id, key, value, updated_at)
      VALUES (${schoolId}, 'upi_display_name', ${displayName}, now())
      ON CONFLICT (school_id, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;

    return sendSuccess(res, schoolId, {
      upi_id: upiId,
      display_name: displayName,
      message: 'UPI settings saved',
    });
  })
);

export default router;
