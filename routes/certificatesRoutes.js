import express from 'express';
import sql from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess, sendError, sendResponse } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { publicCertificateLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

const VALID_TYPES = new Set(['TC', 'BONAFIDE']);

export function maskStudentName(name) {
  if (!name || typeof name !== 'string') return '***';
  return name
    .trim()
    .split(/\s+/)
    .map((part) => {
      if (part.length <= 2) return part[0] + '*';
      return part[0] + '***' + part[part.length - 1];
    })
    .join(' ');
}

/**
 * GET /certificates/verify/:identifier
 * Public certificate verification endpoint (unauthenticated).
 * Lookup by certificate UUID or serial_no.
 * Zero private PII returned (masked student name, school name, serial, type, date, status).
 */
router.get(
  '/verify/:identifier',
  publicCertificateLimiter,
  asyncHandler(async (req, res) => {
    const rawId = String(req.params.identifier || '').trim();
    if (!rawId) {
      return sendResponse(res, 400, {
        success: false,
        valid: false,
        status: 'INVALID',
        error: 'Identifier is required',
      });
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
    const schoolIdFilter = req.query.school_id ? Number.parseInt(String(req.query.school_id), 10) : null;

    let certs = [];
    if (isUuid) {
      certs = await sql`
        SELECT
          ic.serial_no,
          ic.type,
          ic.issued_at,
          ic.data,
          sch.name AS school_name,
          p.display_name AS student_name
        FROM issued_certificates ic
        JOIN schools sch ON sch.id = ic.school_id
        JOIN students s ON s.id = ic.student_id
        JOIN persons p ON p.id = s.person_id
        WHERE ic.id = ${rawId}::uuid
        LIMIT 1
      `;
    } else {
      certs = await sql`
        SELECT
          ic.serial_no,
          ic.type,
          ic.issued_at,
          ic.data,
          sch.name AS school_name,
          p.display_name AS student_name
        FROM issued_certificates ic
        JOIN schools sch ON sch.id = ic.school_id
        JOIN students s ON s.id = ic.student_id
        JOIN persons p ON p.id = s.person_id
        WHERE LOWER(TRIM(ic.serial_no)) = LOWER(TRIM(${rawId}))
          ${schoolIdFilter ? sql`AND ic.school_id = ${schoolIdFilter}` : sql``}
        ORDER BY ic.issued_at DESC
        LIMIT 1
      `;
    }

    if (!certs || certs.length === 0) {
      return sendResponse(res, 404, {
        success: false,
        valid: false,
        status: 'INVALID',
        error: 'Certificate not found',
      });
    }

    const cert = certs[0];
    const isRevoked = Boolean(
      cert.data?.revoked ||
      cert.data?.status === 'REVOKED' ||
      cert.data?.is_revoked
    );
    const status = isRevoked ? 'REVOKED' : 'VALID';

    return sendResponse(res, 200, {
      success: true,
      valid: !isRevoked,
      status,
      certificate: {
        serial_no: cert.serial_no,
        type: cert.type,
        issued_at: cert.issued_at,
        school_name: cert.school_name,
        student_name_masked: maskStudentName(cert.student_name),
        status,
      },
    });
  }),
);

/**
 * GET /certificates/next-serial?type=TC&year=2026
 * Allocate the next school-scoped certificate serial number.
 */
router.get(
  '/next-serial',
  requireAuth,
  requirePermission('certificates.issue'),
  asyncHandler(async (req, res) => {
    const type = String(req.query.type || '').toUpperCase();
    const year = Number.parseInt(String(req.query.year || ''), 10);

    if (!VALID_TYPES.has(type)) {
      return sendError(res, 400, 'type must be TC or BONAFIDE');
    }
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      return sendError(res, 400, 'year must be a valid 4-digit year');
    }

    const [row] = await sql`
      SELECT public.get_next_certificate_serial(
        ${req.schoolId}::integer,
        ${type}::text,
        ${year}::integer
      ) AS serial_no
    `;

    return sendSuccess(res, req.schoolId, { serial_no: row.serial_no });
  }),
);

/**
 * POST /certificates
 * Persist an issued certificate record for the authenticated school.
 */
router.post(
  '/',
  requireAuth,
  requirePermission('certificates.issue'),
  asyncHandler(async (req, res) => {
    const {
      student_id: studentId,
      type,
      serial_no: serialNo,
      issued_at: issuedAt,
      data,
    } = req.body || {};

    const certType = String(type || '').toUpperCase();

    if (!studentId || !serialNo || !VALID_TYPES.has(certType)) {
      return sendError(res, 400, 'student_id, type (TC|BONAFIDE), and serial_no are required');
    }

    const [student] = await sql`
      SELECT id
      FROM students
      WHERE id = ${studentId}
        AND school_id = ${req.schoolId}
      LIMIT 1
    `;

    if (!student) {
      return sendError(res, 404, 'Student not found');
    }

    const [row] = await sql`
      INSERT INTO issued_certificates (
        school_id,
        student_id,
        type,
        serial_no,
        issued_at,
        data,
        issued_by
      )
      VALUES (
        ${req.schoolId},
        ${studentId},
        ${certType},
        ${String(serialNo).trim()},
        ${issuedAt || new Date().toISOString()},
        ${data ? sql.json(data) : null},
        ${req.user.internal_id || null}
      )
      RETURNING
        id,
        school_id,
        student_id,
        type,
        serial_no,
        issued_at,
        created_at
    `;

    return sendSuccess(res, req.schoolId, row, 201);
  }),
);

/**
 * GET /certificates
 * List issued certificates for the authenticated school (most recent first).
 * Optional filters: student_id, type (TC|BONAFIDE).
 * Includes snapshot `data` so clients can re-render school copies.
 */
router.get(
  '/',
  requireAuth,
  requirePermission('certificates.issue'),
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(String(req.query.offset || '0'), 10) || 0, 0);
    const studentId = req.query.student_id ? String(req.query.student_id) : null;
    const typeRaw = req.query.type ? String(req.query.type).toUpperCase() : null;
    const typeFilter = typeRaw && VALID_TYPES.has(typeRaw) ? typeRaw : null;

    if (typeRaw && !typeFilter) {
      return sendError(res, 400, 'type must be TC or BONAFIDE');
    }

    const rows = await sql`
      SELECT
        ic.id,
        ic.student_id,
        ic.type,
        ic.serial_no,
        ic.issued_at,
        ic.created_at,
        ic.data,
        s.admission_no,
        p.display_name AS student_name
      FROM issued_certificates ic
      JOIN students s ON s.id = ic.student_id AND s.school_id = ${req.schoolId}
      JOIN persons p ON p.id = s.person_id
      WHERE ic.school_id = ${req.schoolId}
        ${studentId ? sql`AND ic.student_id = ${studentId}` : sql``}
        ${typeFilter ? sql`AND ic.type = ${typeFilter}` : sql``}
      ORDER BY ic.issued_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    return sendSuccess(res, req.schoolId, rows);
  }),
);

export default router;
