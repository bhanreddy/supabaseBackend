import { readStaffDevicePublicKey } from '../utils/staffDeviceHeaders.js';
import express from 'express';
import sql from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  createAttendanceChallenge,
  verifyAndRecordAttendance,
  recordAdminAttendanceAction,
  reopenStaffAttendance,
  getAuthoritativeTodayAttendance,
  submitAttendanceException,
} from '../services/staffAttendanceV2Service.js';
import {
  registerDevice,
  approveDeviceRegistration,
  revokeDeviceRegistration,
  listSchoolDeviceRegistrations,
} from '../services/staffDeviceService.js';
import { getCampusPolicy, validateCampusPolicyUpdate } from '../services/campusPolicyService.js';

const router = express.Router();

/**
 * Helper: Resolve staff_id strictly from the authenticated identity.
 * Never trust client-supplied request body or query string identifiers.
 */
async function resolveAuthenticatedStaff(req) {
  if (!req.user || !req.user.person_id) return null;
  const [staff] = await sql`
    SELECT id, staff_code, school_id
    FROM staff
    WHERE person_id = ${req.user.person_id}
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return staff || null;
}

function sendAdminAttendanceError(res, err) {
  if (err.code === 'SELF_MODIFICATION_FORBIDDEN' || err.code === 'SELF_APPROVAL_FORBIDDEN') {
    return res.status(403).json({ error: err.message, code: err.code });
  }
  if (err.code === 'STAFF_NOT_FOUND' || err.code === 'ADMIN_NOT_FOUND' || err.code === 'NOT_FOUND') {
    return res.status(404).json({ error: err.message, code: err.code });
  }
  if (err.code === 'ATTENDANCE_FINALIZED') {
    return res.status(409).json({ error: err.message, code: err.code });
  }
  if (['INVALID_ATTENDANCE_DATE', 'INVALID_ATTENDANCE_STATUS', 'INVALID_ADMIN_REQUEST',
    'REASON_REQUIRED', 'MISSING_IDEMPOTENCY_KEY'].includes(err.code)) {
    return res.status(400).json({ error: err.message, code: err.code });
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// STAFF SELF-ATTENDANCE V2 ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /attendance/v2/challenge
 * Request a single-use attendance challenge for check-in or check-out.
 */
router.post('/challenge', requireAuth, asyncHandler(async (req, res) => {
  const staff = await resolveAuthenticatedStaff(req);
  if (!staff) {
    return res.status(403).json({ error: 'Staff profile not found for this user in this school' });
  }

  const { action } = req.body || {};
  if (action !== 'check_in' && action !== 'check_out') {
    return res.status(400).json({ error: 'Action must be check_in or check_out' });
  }

  try {
    const challenge = await createAttendanceChallenge({
      schoolId: req.schoolId,
      staffId: staff.id,
      canonicalPersonId: req.user.person_id,
      installationId: req.headers['x-device-id'] || null,
      action,
      devicePublicKey: readStaffDevicePublicKey(req.headers),
    });
    return sendSuccess(res, req.schoolId, challenge);
  } catch (err) {
    if (err.code === 'NO_APPROVED_DEVICE' || err.code === 'ATTENDANCE_V2_DISABLED') {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    if (err.code === 'OUTSIDE_ATTENDANCE_WINDOW' || err.code === 'INVALID_ATTENDANCE_WINDOW') {
      return res.status(422).json({ error: err.message, code: err.code });
    }
    if (err.code === 'ALREADY_CHECKED_IN' || err.code === 'CHECK_IN_REQUIRED' || err.code === 'ALREADY_CHECKED_OUT' || err.code === 'ATTENDANCE_FINALIZED') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    throw err;
  }
}));

/**
 * POST /attendance/v2/verify
 * Submit signed canonical attendance payload and location evidence.
 */
router.post('/verify', requireAuth, asyncHandler(async (req, res) => {
  const staff = await resolveAuthenticatedStaff(req);
  if (!staff) {
    return res.status(403).json({ error: 'Staff profile not found for this user in this school' });
  }

  const { challenge_id, payload, signature, idempotency_key } = req.body || {};
  if (!challenge_id || !payload || !signature || !idempotency_key) {
    return res.status(400).json({
      error: 'challenge_id, payload, signature, and idempotency_key are required',
    });
  }

  try {
    const result = await verifyAndRecordAttendance({
      schoolId: req.schoolId,
      staffId: staff.id,
      canonicalPersonId: req.user.person_id,
      challengeId: challenge_id,
      payload,
      signature,
      idempotencyKey: idempotency_key,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return sendSuccess(res, req.schoolId, result);
  } catch (err) {
    if (
      err.code === 'OUTSIDE_CAMPUS' ||
      err.code === 'LOCATION_UNCERTAIN_AT_BOUNDARY' ||
      err.code === 'POOR_GPS_ACCURACY' ||
      err.code === 'LOCATION_TOO_OLD' ||
      err.code === 'LOCATION_MISSING' ||
      err.code === 'INVALID_TIMESTAMP' ||
      err.code === 'LOCATION_IN_FUTURE' ||
      err.code === 'INVALID_ACCURACY' ||
      err.code === 'MOCK_LOCATION_DETECTED' ||
      err.code === 'INVALID_COORDINATES' ||
      err.code === 'COORDINATES_OUT_OF_BOUNDS' ||
      err.code === 'OUTSIDE_ATTENDANCE_WINDOW' ||
      err.code === 'INVALID_ATTENDANCE_WINDOW'
    ) {
      return res.status(422).json({
        error: err.message,
        code: err.code,
        details: err.details,
      });
    }

    if (
      err.code === 'INVALID_SIGNATURE' ||
      err.code === 'PAYLOAD_CONTEXT_MISMATCH' ||
      err.code === 'CHALLENGE_NOT_FOUND' ||
      err.code === 'CHALLENGE_ALREADY_USED' ||
      err.code === 'CHALLENGE_EXPIRED' ||
      err.code === 'DEVICE_NOT_APPROVED'
    ) {
      return res.status(401).json({ error: err.message, code: err.code });
    }

    if (err.code === 'ATTENDANCE_V2_DISABLED') {
      return res.status(403).json({ error: err.message, code: err.code });
    }

    if (err.code === 'INVALID_PAYLOAD' || err.code === 'MISSING_IDEMPOTENCY_KEY') {
      return res.status(400).json({ error: err.message, code: err.code });
    }

    if (err.code === 'ATTENDANCE_FINALIZED' || err.code === 'ALREADY_CHECKED_IN' || err.code === 'ALREADY_CHECKED_OUT' || err.code === 'CHECK_IN_REQUIRED' || err.code === 'POLICY_CHANGED') {
      return res.status(409).json({ error: err.message, code: err.code });
    }

    throw err;
  }
}));

/**
 * GET /attendance/v2/status/today
 * Real-time authoritative status contract consumed by dashboard quick action and attendance screen.
 */
router.get('/status/today', requireAuth, asyncHandler(async (req, res) => {
  const staff = await resolveAuthenticatedStaff(req);
  if (!staff) {
    return res.status(404).json({ error: 'Staff profile not found' });
  }

  const status = await getAuthoritativeTodayAttendance(
    req.schoolId,
    staff.id,
    req.user.person_id,
    readStaffDevicePublicKey(req.headers)
  );
  return sendSuccess(res, req.schoolId, status);
}));

/**
 * POST /attendance/v2/exceptions
 * Submit exception request for approval by school administration.
 */
router.post('/exceptions', requireAuth, asyncHandler(async (req, res) => {
  const staff = await resolveAuthenticatedStaff(req);
  if (!staff) {
    return res.status(403).json({ error: 'Staff profile not found' });
  }

  const { attendance_date, action, reason } = req.body || {};
  if (!attendance_date || !action || !reason) {
    return res.status(400).json({ error: 'attendance_date, action, and reason are required' });
  }

  try {
    const record = await submitAttendanceException({
      schoolId: req.schoolId,
      staffId: staff.id,
      attendanceDate: attendance_date,
      action,
      reason,
    });
    return sendSuccess(res, req.schoolId, record, 201);
  } catch (err) {
    if (['REASON_REQUIRED', 'INVALID_ACTION', 'INVALID_ATTENDANCE_DATE'].includes(err.code)) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    throw err;
  }
}));

/**
 * POST /attendance/v2/device/register
 * Initialize pending device registration.
 */
router.post('/device/register', requireAuth, asyncHandler(async (req, res) => {
  const staff = await resolveAuthenticatedStaff(req);
  if (!staff) {
    return res.status(403).json({ error: 'Staff profile not found' });
  }

  const {
    device_session_public_key,
    attendance_public_key,
    device_model,
    os_name,
    os_version,
    app_version,
    proof_nonce,
    proof_signature,
  } = req.body || {};

  if (!device_session_public_key || !attendance_public_key || !proof_nonce || !proof_signature) {
    return res.status(400).json({
      error: 'device_session_public_key, attendance_public_key, proof_nonce, and proof_signature are required',
    });
  }

  try {
    const reg = await registerDevice({
      schoolId: req.schoolId,
      staffId: staff.id,
      canonicalPersonId: req.user.person_id,
      installationId: req.headers['x-device-id'],
      deviceSessionPublicKey: device_session_public_key,
      attendancePublicKey: attendance_public_key,
      deviceModel: device_model,
      osName: os_name,
      osVersion: os_version,
      appVersion: app_version,
      proofNonce: proof_nonce,
      proofSignature: proof_signature,
    });

    return sendSuccess(res, req.schoolId, reg, 201);
  } catch (err) {
    if (err.code === 'DEVICE_OWNED_BY_ANOTHER_STAFF') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    if (err.code === 'INVALID_KEY_PROOF') {
      return res.status(401).json({ error: err.message, code: err.code });
    }
    if (err.code === 'DEVICE_ID_REQUIRED' || err.code === 'INVALID_DEVICE_KEYS') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    throw err;
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// ADMINISTRATOR V2 MANAGEMENT ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /attendance/v2/admin/registrations
 * List device registrations for review.
 */
router.get('/admin/registrations', requirePermission('staff_attendance.manage'), asyncHandler(async (req, res) => {
  const { status } = req.query;
  const list = await listSchoolDeviceRegistrations(req.schoolId, status || null);
  return sendSuccess(res, req.schoolId, list);
}));

/**
 * POST /attendance/v2/admin/registrations/:id/approve
 * Approve staff device registration.
 */
router.post('/admin/registrations/:id/approve', requirePermission('staff_attendance.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const adminUserId = req.user.internal_id || req.user.id;

  try {
    const approved = await approveDeviceRegistration(id, adminUserId, req.schoolId);
    return sendSuccess(res, req.schoolId, approved);
  } catch (err) {
    if (err.code === 'SELF_APPROVAL_FORBIDDEN') {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    if (err.code === 'DEVICE_OWNED_BY_ANOTHER_STAFF') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    throw err;
  }
}));

/** Reject a pending registration without ever activating its keys. */
router.post('/admin/registrations/:id/reject', requirePermission('staff_attendance.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A rejection reason is required' });
  const adminUserId = req.user.internal_id || req.user.id;
  const rejected = await sql.begin(async (tx) => {
    const [row] = await tx`
      UPDATE staff_device_registrations
      SET status = 'rejected', revoked_by = ${adminUserId}, revoked_at = now(),
          revocation_reason = ${reason}, updated_at = now()
      WHERE id = ${id} AND school_id = ${req.schoolId} AND status = 'pending'
      RETURNING *
    `;
    if (!row) return null;
    await tx`
      INSERT INTO staff_attendance_audit_logs
        (school_id, actor_id, target_staff_id, action, reason, previous_state, new_state)
      VALUES (${req.schoolId}, ${adminUserId}, ${row.staff_id}, 'DEVICE_REJECTED', ${reason},
        ${sql.json({ previous_status: 'pending' })},
        ${sql.json({ new_status: 'rejected', registration_id: row.id })})
    `;
    return row;
  });
  if (!rejected) return res.status(404).json({ error: 'Pending device registration not found' });
  return sendSuccess(res, req.schoolId, rejected);
}));

/**
 * POST /attendance/v2/admin/registrations/:id/revoke
 * Revoke approved staff device registration.
 */
router.post('/admin/registrations/:id/revoke', requirePermission('staff_attendance.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body || {};
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'A revocation reason is required' });
  }
  const adminUserId = req.user.internal_id || req.user.id;

  try {
    const revoked = await revokeDeviceRegistration(id, adminUserId, req.schoolId, reason);
    return sendSuccess(res, req.schoolId, revoked);
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    throw err;
  }
}));

/**
 * POST /attendance/v2/admin/mark
 * Administrator manual attendance entry.
 */
router.post('/admin/mark', requirePermission('staff_attendance.manage'), asyncHandler(async (req, res) => {
  const { staff_id, attendance_date, status, reason, is_finalized, idempotency_key } = req.body || {};
  if (!staff_id || !attendance_date || !status || !reason || !idempotency_key) {
    return res.status(400).json({ error: 'staff_id, attendance_date, status, reason, and idempotency_key are required' });
  }

  const adminUserId = req.user.internal_id || req.user.id;

  try {
    const result = await recordAdminAttendanceAction({
      schoolId: req.schoolId,
      adminUserId,
      targetStaffId: staff_id,
      attendanceDate: attendance_date,
      status,
      reason,
      idempotencyKey: idempotency_key,
      isFinalized: Boolean(is_finalized),
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return sendSuccess(res, req.schoolId, result);
  } catch (err) {
    const response = sendAdminAttendanceError(res, err);
    if (response) return response;
    throw err;
  }
}));

/**
 * POST /attendance/v2/admin/correct
 * Administrator correction with Before → After confirmation.
 */
router.post('/admin/correct', requirePermission('staff_attendance.correct'), asyncHandler(async (req, res) => {
  const { staff_id, attendance_date, status, reason, is_finalized, idempotency_key } = req.body || {};
  if (!staff_id || !attendance_date || !status || !reason || !idempotency_key) {
    return res.status(400).json({ error: 'staff_id, attendance_date, status, reason, and idempotency_key are required' });
  }

  const adminUserId = req.user.internal_id || req.user.id;

  try {
    const result = await recordAdminAttendanceAction({
      schoolId: req.schoolId,
      adminUserId,
      targetStaffId: staff_id,
      attendanceDate: attendance_date,
      status,
      reason,
      idempotencyKey: idempotency_key,
      isFinalized: is_finalized !== undefined ? Boolean(is_finalized) : true,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return sendSuccess(res, req.schoolId, result);
  } catch (err) {
    const response = sendAdminAttendanceError(res, err);
    if (response) return response;
    throw err;
  }
}));

/**
 * POST /attendance/v2/admin/reopen
 * Reopen administratively finalized attendance record.
 */
router.post('/admin/reopen', requirePermission('staff_attendance.correct'), asyncHandler(async (req, res) => {
  const { staff_id, attendance_date, reason, idempotency_key } = req.body || {};
  if (!staff_id || !attendance_date || !reason || !idempotency_key) {
    return res.status(400).json({ error: 'staff_id, attendance_date, reason, and idempotency_key are required' });
  }

  const adminUserId = req.user.internal_id || req.user.id;
  try {
    const reopened = await reopenStaffAttendance({
      schoolId: req.schoolId,
      adminUserId,
      targetStaffId: staff_id,
      attendanceDate: attendance_date,
      reason,
      idempotencyKey: idempotency_key,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return sendSuccess(res, req.schoolId, reopened);
  } catch (err) {
    const response = sendAdminAttendanceError(res, err);
    if (response) return response;
    throw err;
  }
}));

/**
 * GET /attendance/v2/admin/policy
 * Fetch campus policy.
 */
router.get('/admin/policy', requirePermission('staff_attendance.manage'), asyncHandler(async (req, res) => {
  const policy = await getCampusPolicy(req.schoolId);
  return sendSuccess(res, req.schoolId, policy);
}));

/**
 * PUT /attendance/v2/admin/policy
 * Update campus policy (coordinates, radius, timings, enforcement mode).
 */
router.put('/admin/policy', requirePermission('staff_attendance.manage'), asyncHandler(async (req, res) => {
  const {
    campus_name = null,
    center_latitude = null,
    center_longitude = null,
    radius_meters = null,
    max_location_age_seconds = null,
    max_accuracy_meters = null,
    enforcement_mode = null,
    check_in_start_time = null,
    check_in_end_time = null,
    check_out_start_time = null,
    check_out_end_time = null,
    grace_period_minutes = null,
    school_timezone = null,
    challenge_expiry_seconds = null,
  } = req.body || {};

  const validation = validateCampusPolicyUpdate(req.body || {});
  if (!validation.ok) {
    return res.status(400).json({ error: 'Invalid attendance policy', details: validation.errors });
  }

  const [existing] = await sql`
    SELECT id FROM campus_attendance_policies WHERE school_id = ${req.schoolId} AND is_active = true ORDER BY created_at ASC LIMIT 1
  `;

  if (!existing && (center_latitude == null || center_longitude == null)) {
    return res.status(400).json({ error: 'Explicit campus latitude and longitude are required for a new policy' });
  }

  let updated;
  if (existing) {
    [updated] = await sql`
      UPDATE campus_attendance_policies SET
        campus_name = COALESCE(${campus_name}, campus_name),
        center_latitude = COALESCE(${center_latitude}, center_latitude),
        center_longitude = COALESCE(${center_longitude}, center_longitude),
        radius_meters = COALESCE(${radius_meters}, radius_meters),
        max_location_age_seconds = COALESCE(${max_location_age_seconds}, max_location_age_seconds),
        max_accuracy_meters = COALESCE(${max_accuracy_meters}, max_accuracy_meters),
        enforcement_mode = COALESCE(${enforcement_mode}, enforcement_mode),
        check_in_start_time = COALESCE(${check_in_start_time}, check_in_start_time),
        check_in_end_time = COALESCE(${check_in_end_time}, check_in_end_time),
        check_out_start_time = COALESCE(${check_out_start_time}, check_out_start_time),
        check_out_end_time = COALESCE(${check_out_end_time}, check_out_end_time),
        grace_period_minutes = COALESCE(${grace_period_minutes}, grace_period_minutes),
        school_timezone = COALESCE(${school_timezone}, school_timezone),
        challenge_expiry_seconds = COALESCE(${challenge_expiry_seconds}, challenge_expiry_seconds),
        policy_version = md5(random()::text || clock_timestamp()::text),
        updated_at = now()
      WHERE id = ${existing.id}
      RETURNING *
    `;
  } else {
    [updated] = await sql`
      INSERT INTO campus_attendance_policies (
        school_id, campus_name, center_latitude, center_longitude,
        radius_meters, max_location_age_seconds, max_accuracy_meters,
        enforcement_mode, check_in_start_time, check_in_end_time,
        check_out_start_time, check_out_end_time, grace_period_minutes, school_timezone, challenge_expiry_seconds
      ) VALUES (
        ${req.schoolId}, ${campus_name ?? 'Main Campus'}, ${center_latitude ?? 17.385044}, ${center_longitude ?? 78.486671},
        ${radius_meters ?? 150.0}, ${max_location_age_seconds ?? 30}, ${max_accuracy_meters ?? 50.0},
        ${enforcement_mode ?? 'disabled'}, ${check_in_start_time ?? '07:30'}, ${check_in_end_time ?? '10:00'},
        ${check_out_start_time ?? '15:30'}, ${check_out_end_time ?? '19:00'}, ${grace_period_minutes ?? 15},
        ${school_timezone ?? 'Asia/Kolkata'}, ${challenge_expiry_seconds ?? 60}
      )
      RETURNING *
    `;
  }

  return sendSuccess(res, req.schoolId, updated);
}));

/**
 * GET /attendance/v2/admin/exceptions
 * List attendance exception requests.
 */
router.get('/admin/exceptions', requirePermission('staff_attendance.manage'), asyncHandler(async (req, res) => {
  const { status } = req.query;
  const rows = await sql`
    SELECT
      sae.*,
      p.display_name AS staff_name,
      p.photo_url,
      st.staff_code,
      sd.name AS designation,
      (SELECT pc.contact_value FROM person_contacts pc WHERE pc.person_id = u.person_id
        AND pc.school_id = u.school_id AND pc.contact_type = 'email' AND pc.deleted_at IS NULL
        ORDER BY pc.is_primary DESC, pc.created_at ASC LIMIT 1) AS reviewer_email
    FROM staff_attendance_exceptions sae
    JOIN staff st ON st.id = sae.staff_id
    JOIN persons p ON p.id = st.person_id
    LEFT JOIN staff_designations sd ON sd.id = st.designation_id
    LEFT JOIN users u ON u.id = sae.reviewed_by
    WHERE sae.school_id = ${req.schoolId}
      ${status ? sql`AND sae.status = ${status}` : sql``}
    ORDER BY sae.created_at DESC
  `;
  return sendSuccess(res, req.schoolId, rows);
}));

/**
 * POST /attendance/v2/admin/exceptions/:id/review
 * Approve or reject an exception request.
 */
router.post('/admin/exceptions/:id/review', requirePermission('staff_attendance.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { decision, notes, mark_status } = req.body || {}; // decision: 'approved' | 'rejected'

  if (decision !== 'approved' && decision !== 'rejected') {
    return res.status(400).json({ error: 'decision must be approved or rejected' });
  }
  if (decision === 'approved' && !['present', 'absent', 'half_day'].includes(mark_status)) {
    return res.status(400).json({ error: 'A valid mark_status is required when approving an exception' });
  }

  const adminUserId = req.user.internal_id || req.user.id;

  try {
    const result = await sql.begin(async (tx) => {
    const [request] = await tx`
      SELECT sae.*, sae.attendance_date::text AS attendance_date, st.person_id
      FROM staff_attendance_exceptions sae
      JOIN staff st ON st.id = sae.staff_id AND st.school_id = sae.school_id
      WHERE sae.id = ${id} AND sae.school_id = ${req.schoolId} AND sae.status = 'pending'
      FOR UPDATE
    `;
    if (!request) {
      const err = new Error('Pending exception request not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const [admin] = await tx`SELECT person_id FROM users WHERE id = ${adminUserId} AND school_id = ${req.schoolId}`;
    if (!admin || admin.person_id === request.person_id) {
      const err = new Error('Administrators cannot review their own attendance exception');
      err.code = 'SELF_MODIFICATION_FORBIDDEN';
      throw err;
    }
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${req.schoolId}:${request.staff_id}:${request.attendance_date}`}, 0))`;

    const [reviewed] = await tx`
      UPDATE staff_attendance_exceptions
      SET status = ${decision},
          reviewed_by = ${adminUserId},
          reviewed_at = now(),
          review_notes = ${notes || null}
      WHERE id = ${id} AND school_id = ${req.schoolId} AND status = 'pending'
      RETURNING *, attendance_date::text AS attendance_date
    `;

    let summary = null;
    if (decision === 'approved') {
      const [previous] = await tx`
        SELECT * FROM staff_attendance
        WHERE school_id = ${req.schoolId} AND staff_id = ${reviewed.staff_id}
          AND attendance_date = ${reviewed.attendance_date} AND deleted_at IS NULL
        FOR UPDATE
      `;
      if (previous?.is_finalized) {
        const err = new Error('Finalized attendance must be reopened before approving this exception');
        err.code = 'ATTENDANCE_FINALIZED';
        throw err;
      }
      const [event] = await tx`
        INSERT INTO staff_attendance_events (
          school_id, staff_id, action, event_timestamp, client_location,
          idempotency_key, verification_status, source, actor_id, metadata
        ) VALUES (
          ${req.schoolId}, ${reviewed.staff_id}, 'exception_approved', now(), ${sql.json({})},
          ${`exception:${reviewed.id}`}, 'admin_override', 'exception_approved', ${adminUserId},
          ${sql.json({ reason: reviewed.reason, review_notes: notes || null, new_status: mark_status })}
        ) RETURNING id
      `;
      [summary] = await tx`
        INSERT INTO staff_attendance (
          school_id, staff_id, attendance_date, status,
          verification_source, is_verified, marked_by, marked_at, deleted_at
        ) VALUES (
          ${req.schoolId}, ${reviewed.staff_id}, ${reviewed.attendance_date}, ${mark_status}::attendance_status_enum,
          'exception_approved', false, ${adminUserId}, now(), NULL
        )
        ON CONFLICT (staff_id, attendance_date) DO UPDATE SET
          status = EXCLUDED.status,
          verification_source = 'exception_approved',
          is_verified = false,
          marked_by = EXCLUDED.marked_by,
          marked_at = now(),
          deleted_at = NULL,
          updated_at = now()
        RETURNING *
      `;
      await tx`
        INSERT INTO staff_attendance_audit_logs (
          school_id, actor_id, target_staff_id, action, reason, previous_state, new_state
        ) VALUES (
          ${req.schoolId}, ${adminUserId}, ${reviewed.staff_id}, 'EXCEPTION_APPROVED',
          ${notes || reviewed.reason}, ${sql.json(previous || {})},
          ${sql.json({ ...summary, event_id: event.id, exception_id: reviewed.id })}
        )
      `;
    } else {
      await tx`
        INSERT INTO staff_attendance_audit_logs (
          school_id, actor_id, target_staff_id, action, reason, previous_state, new_state
        ) VALUES (
          ${req.schoolId}, ${adminUserId}, ${reviewed.staff_id}, 'EXCEPTION_REJECTED',
          ${notes || 'Attendance exception rejected'}, ${sql.json({ status: 'pending' })},
          ${sql.json({ status: 'rejected', exception_id: reviewed.id })}
        )
      `;
    }

    return { ...reviewed, summary };
    });
    return sendSuccess(res, req.schoolId, result);
  } catch (err) {
    const response = sendAdminAttendanceError(res, err);
    if (response) return response;
    throw err;
  }
}));

export default router;
