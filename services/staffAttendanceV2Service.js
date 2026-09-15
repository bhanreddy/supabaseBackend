import crypto from 'node:crypto';
import sql from '../db.js';
import { canonicalJsonStringify } from '../utils/canonicalPayload.js';
import { getCampusPolicy, evaluateLocationPolicy, getSchoolLocalDate, evaluateAttendanceWindow } from './campusPolicyService.js';
import { verifyEcdsaSignature } from './staffDeviceService.js';

const ADMIN_ATTENDANCE_STATUSES = new Set(['present', 'absent', 'late', 'half_day']);

function sameId(a, b) {
  if (a == null || b == null) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function assertValidAttendanceDateAndStatus(attendanceDate, status = null) {
  const value = String(attendanceDate || '');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value) {
    const err = new Error('attendance_date must be a valid date in YYYY-MM-DD format');
    err.code = 'INVALID_ATTENDANCE_DATE';
    throw err;
  }
  if (status !== null && !ADMIN_ATTENDANCE_STATUSES.has(status)) {
    const err = new Error('Attendance status is invalid');
    err.code = 'INVALID_ATTENDANCE_STATUS';
    throw err;
  }
}

/**
 * Generate a single-use attendance challenge.
 */
export async function createAttendanceChallenge({
  schoolId,
  staffId,
  canonicalPersonId,
  installationId,
  action,
  devicePublicKey,
}) {
  if (action !== 'check_in' && action !== 'check_out') {
    const err = new Error('Invalid attendance action');
    err.code = 'INVALID_ACTION';
    throw err;
  }

  // 1. Fetch campus policy and local date
  const policy = await getCampusPolicy(schoolId);
  const windowResult = evaluateAttendanceWindow(action, policy);
  if (!windowResult.ok) {
    const err = new Error(windowResult.message);
    err.code = windowResult.code;
    throw err;
  }
  const attendanceDate = getSchoolLocalDate(policy.school_timezone);

  // 2. Serialize challenge replacement and state validation for this staff/day.
  // This guarantees that concurrent taps leave exactly one usable challenge.
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-attendance-challenge:${schoolId}:${staffId}:${attendanceDate}`}, 0))`;

    const [device] = await tx`
      SELECT id, attendance_public_key, status
      FROM staff_device_registrations
      WHERE canonical_person_id = ${canonicalPersonId}
        AND school_id = ${schoolId}
        AND staff_id = ${staffId}
        AND installation_id = ${installationId}
        AND device_session_public_key = ${devicePublicKey}
        AND status = 'approved'
      LIMIT 1
      FOR SHARE
    `;
    if (!device) {
      const err = new Error('No approved mobile device registered for this staff member');
      err.code = 'NO_APPROVED_DEVICE';
      throw err;
    }

    const [existingSummary] = await tx`
      SELECT id, status, check_in_time, check_out_time, is_finalized
      FROM staff_attendance
      WHERE staff_id = ${staffId}
        AND school_id = ${schoolId}
        AND attendance_date = ${attendanceDate}::date
        AND deleted_at IS NULL
      LIMIT 1
      FOR UPDATE
    `;

    if (existingSummary?.is_finalized) {
      const err = new Error('Attendance for today has been finalized by school administration');
      err.code = 'ATTENDANCE_FINALIZED';
      throw err;
    }
    if (action === 'check_in' && existingSummary?.check_in_time) {
      const err = new Error('You have already checked in for today');
      err.code = 'ALREADY_CHECKED_IN';
      throw err;
    }
    if (action === 'check_out' && !existingSummary?.check_in_time) {
      const err = new Error('You must check in before checking out');
      err.code = 'CHECK_IN_REQUIRED';
      throw err;
    }
    if (action === 'check_out' && existingSummary?.check_out_time) {
      const err = new Error('You have already checked out for today');
      err.code = 'ALREADY_CHECKED_OUT';
      throw err;
    }

    await tx`
      UPDATE attendance_challenges
      SET consumed_at = now()
      WHERE staff_id = ${staffId}
        AND school_id = ${schoolId}
        AND consumed_at IS NULL
    `;

    const challengeNonce = crypto.randomBytes(32).toString('hex');
    const ttlSeconds = policy.challenge_expiry_seconds || 60;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const [challengeRecord] = await tx`
      INSERT INTO attendance_challenges (
        challenge, school_id, staff_id, registration_id,
        action, attendance_date, policy_version, expires_at
      ) VALUES (
        ${challengeNonce}, ${schoolId}, ${staffId}, ${device.id},
        ${action}, ${attendanceDate}::date, ${policy.policy_version || '1.0'}, ${expiresAt}
      )
      RETURNING *
    `;

    return {
      challengeId: challengeRecord.id,
      challenge: challengeRecord.challenge,
      action: challengeRecord.action,
      attendanceDate,
      expiresAt: challengeRecord.expires_at,
      policy: {
        campusId: policy.id,
        campusName: policy.campus_name,
        maxLocationAgeSeconds: policy.max_location_age_seconds,
        maxAccuracyMeters: policy.max_accuracy_meters,
        policyVersion: challengeRecord.policy_version,
      },
      registrationId: device.id,
    };
  });
}

/**
 * Verify signed attendance payload, geofence, and record event atomically.
 */
export async function verifyAndRecordAttendance({
  schoolId,
  staffId,
  canonicalPersonId,
  challengeId,
  payload,
  signature,
  idempotencyKey,
  ipAddress,
  userAgent,
}) {
  if (!idempotencyKey) {
    const err = new Error('idempotency_key is required');
    err.code = 'MISSING_IDEMPOTENCY_KEY';
    throw err;
  }

  // 1. Idempotency check: if this request was already processed, return original accepted result
  const [existingEvent] = await sql`
    SELECT sae.*, ac.attendance_date::text AS challenge_attendance_date,
      sa.status AS summary_status, sa.check_in_time, sa.check_out_time
    FROM staff_attendance_events sae
    LEFT JOIN attendance_challenges ac ON ac.id = sae.challenge_id
    LEFT JOIN staff_attendance sa ON sa.staff_id = sae.staff_id 
      AND sa.school_id = sae.school_id
      AND sa.attendance_date = ac.attendance_date
    WHERE sae.idempotency_key = ${idempotencyKey}
      AND sae.school_id = ${schoolId}
      AND sae.staff_id = ${staffId}
    LIMIT 1
  `;

  if (existingEvent) {
    return {
      success: true,
      isIdempotentReplay: true,
      action: existingEvent.action,
      attendanceDate: existingEvent.challenge_attendance_date || getSchoolLocalDate('Asia/Kolkata', new Date(existingEvent.event_timestamp)),
      eventTimestamp: existingEvent.event_timestamp,
      verificationStatus: existingEvent.verification_status,
      summary: {
        status: existingEvent.summary_status,
        checkInTime: existingEvent.check_in_time,
        checkOutTime: existingEvent.check_out_time,
      },
    };
  }

  // 2. Fetch challenge and active approved device
  const [challenge] = await sql`
    SELECT *, attendance_date::text AS attendance_date
    FROM attendance_challenges
    WHERE id = ${challengeId}
      AND school_id = ${schoolId}
      AND staff_id = ${staffId}
    LIMIT 1
  `;

  if (!challenge) {
    const err = new Error('Attendance challenge not found');
    err.code = 'CHALLENGE_NOT_FOUND';
    throw err;
  }

  if (challenge.consumed_at) {
    const err = new Error('Attendance challenge has already been consumed (replay rejected)');
    err.code = 'CHALLENGE_ALREADY_USED';
    throw err;
  }

  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    const err = new Error('Attendance challenge has expired. Please try again.');
    err.code = 'CHALLENGE_EXPIRED';
    throw err;
  }

  const [device] = await sql`
    SELECT *
    FROM staff_device_registrations
    WHERE id = ${challenge.registration_id}
      AND canonical_person_id = ${canonicalPersonId}
      AND school_id = ${schoolId}
      AND staff_id = ${staffId}
      AND status = 'approved'
    LIMIT 1
  `;

  if (!device) {
    const err = new Error('Device registration is not approved or has been revoked');
    err.code = 'DEVICE_NOT_APPROVED';
    throw err;
  }

  // 3. Verify canonical payload content and structure
  if (!payload || typeof payload !== 'object') {
    const err = new Error('Invalid attendance payload');
    err.code = 'INVALID_PAYLOAD';
    throw err;
  }

  if (
    payload.action !== challenge.action ||
    payload.challenge_id !== challenge.id ||
    payload.registration_id !== device.id ||
    Number(payload.school_id) !== Number(schoolId) ||
    String(payload.staff_id) !== String(staffId) ||
    payload.idempotency_key !== idempotencyKey ||
    payload.policy_version !== challenge.policy_version
  ) {
    const err = new Error('Payload attributes do not match challenge context');
    err.code = 'PAYLOAD_CONTEXT_MISMATCH';
    throw err;
  }

  // 4. Verify cryptographic signature over deterministic canonical JSON
  const canonicalString = canonicalJsonStringify(payload);
  const signatureValid = verifyEcdsaSignature(
    device.attendance_public_key,
    canonicalString,
    signature
  );

  if (!signatureValid) {
    const err = new Error('Cryptographic signature verification failed');
    err.code = 'INVALID_SIGNATURE';
    throw err;
  }

  // 5. Evaluate geofence policy
  const policy = await getCampusPolicy(schoolId, payload.campus_id);
  if (!policy.id || String(policy.id) !== String(payload.campus_id)) {
    const err = new Error('The signed campus does not match an active school campus');
    err.code = 'PAYLOAD_CONTEXT_MISMATCH';
    throw err;
  }
  const windowResult = evaluateAttendanceWindow(challenge.action, policy);
  if (!windowResult.ok) {
    const err = new Error(windowResult.message);
    err.code = windowResult.code;
    throw err;
  }
  const locationResult = evaluateLocationPolicy(payload.location, policy);

  if (!locationResult.ok) {
    const err = new Error(locationResult.message);
    err.code = locationResult.code;
    err.details = locationResult;
    throw err;
  }

  const attendanceDate = challenge.attendance_date;

  // 6. Execute atomic database transaction
  return await sql.begin(async (tx) => {
    // Serialize state transitions even when a daily summary row does not exist.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${schoolId}:${staffId}:${attendanceDate}`}, 0))`;

    const [lockedDevice] = await tx`
      SELECT id FROM staff_device_registrations
      WHERE id = ${device.id} AND school_id = ${schoolId} AND staff_id = ${staffId}
        AND canonical_person_id = ${canonicalPersonId} AND status = 'approved'
      FOR SHARE
    `;
    if (!lockedDevice) {
      const err = new Error('Device registration is not approved or has been revoked');
      err.code = 'DEVICE_NOT_APPROVED';
      throw err;
    }

    const [lockedPolicy] = await tx`
      SELECT * FROM campus_attendance_policies
      WHERE id = ${policy.id} AND school_id = ${schoolId} AND is_active = true
      FOR SHARE
    `;
    if (!lockedPolicy || lockedPolicy.policy_version !== challenge.policy_version) {
      const err = new Error('The campus attendance policy changed. Please try again.');
      err.code = 'POLICY_CHANGED';
      throw err;
    }
    // Lock waits can outlive the challenge or GPS fix. Recheck against the
    // actual time after locking, and keep school dates as DATE text throughout.
    const serverNow = new Date();
    const lockedWindowResult = evaluateAttendanceWindow(challenge.action, lockedPolicy, serverNow);
    const lockedLocationResult = evaluateLocationPolicy(payload.location, lockedPolicy, serverNow);
    const lockedFailure = !lockedWindowResult.ok ? lockedWindowResult : lockedLocationResult;
    if (!lockedFailure.ok) {
      const err = new Error(lockedFailure.message);
      err.code = lockedFailure.code;
      err.details = lockedFailure;
      throw err;
    }

    const [idempotentEvent] = await tx`
      SELECT sae.*, sa.status AS summary_status, sa.check_in_time, sa.check_out_time
      FROM staff_attendance_events sae
      LEFT JOIN staff_attendance sa ON sa.staff_id = sae.staff_id
        AND sa.school_id = sae.school_id AND sa.attendance_date = ${attendanceDate}::date
      WHERE sae.idempotency_key = ${idempotencyKey}
        AND sae.school_id = ${schoolId} AND sae.staff_id = ${staffId}
      LIMIT 1
    `;
    if (idempotentEvent) {
      return {
        success: true,
        isIdempotentReplay: true,
        action: idempotentEvent.action,
        attendanceDate,
        eventTimestamp: idempotentEvent.event_timestamp,
        verificationStatus: idempotentEvent.verification_status,
        summary: {
          status: idempotentEvent.summary_status,
          checkInTime: idempotentEvent.check_in_time,
          checkOutTime: idempotentEvent.check_out_time,
        },
      };
    }

    // Consume exactly once and recheck expiry in the same transaction.
    const [consumedChallenge] = await tx`
      UPDATE attendance_challenges
      SET consumed_at = ${serverNow}
      WHERE id = ${challenge.id}
        AND school_id = ${schoolId}
        AND staff_id = ${staffId}
        AND consumed_at IS NULL
        AND expires_at >= ${serverNow}
      RETURNING id
    `;
    if (!consumedChallenge) {
      const [currentChallenge] = await tx`
        SELECT consumed_at, expires_at FROM attendance_challenges
        WHERE id = ${challenge.id} AND school_id = ${schoolId} AND staff_id = ${staffId}
      `;
      const err = new Error(
        currentChallenge && new Date(currentChallenge.expires_at).getTime() < serverNow.getTime()
          ? 'Attendance challenge has expired. Please try again.'
          : 'Attendance challenge has already been consumed (replay rejected)'
      );
      err.code = currentChallenge && new Date(currentChallenge.expires_at).getTime() < serverNow.getTime()
        ? 'CHALLENGE_EXPIRED'
        : 'CHALLENGE_ALREADY_USED';
      throw err;
    }

    // B. Check again for existing summary and finalized state inside transaction
    const [summaryCheck] = await tx`
      SELECT id, status, check_in_time, check_out_time, is_finalized
      FROM staff_attendance
      WHERE staff_id = ${staffId}
        AND school_id = ${schoolId}
        AND attendance_date = ${attendanceDate}
        AND deleted_at IS NULL
      FOR UPDATE
    `;

    if (summaryCheck?.is_finalized) {
      const err = new Error('Attendance has been administratively finalized and cannot be modified');
      err.code = 'ATTENDANCE_FINALIZED';
      throw err;
    }

    if (challenge.action === 'check_in' && summaryCheck?.check_in_time) {
      const err = new Error('Already checked in today');
      err.code = 'ALREADY_CHECKED_IN';
      throw err;
    }

    if (challenge.action === 'check_out' && !summaryCheck?.check_in_time) {
      const err = new Error('Check in required before checking out');
      err.code = 'CHECK_IN_REQUIRED';
      throw err;
    }
    if (challenge.action === 'check_out' && summaryCheck?.check_out_time) {
      const err = new Error('Already checked out today');
      err.code = 'ALREADY_CHECKED_OUT';
      throw err;
    }

    // C. Append immutable attendance event
    const [event] = await tx`
      INSERT INTO staff_attendance_events (
        school_id, staff_id, campus_id, action,
        event_timestamp, client_location, device_registration_id,
        challenge_id, idempotency_key, verification_status,
        source, policy_version, metadata
      ) VALUES (
        ${schoolId}, ${staffId}, ${policy.id || null}, ${challenge.action},
        ${serverNow}, ${sql.json(payload.location)}, ${device.id},
        ${challenge.id}, ${idempotencyKey}, 'verified',
        'mobile_v2', ${policy.policy_version || '1.0'},
        ${sql.json({ distance_meters: lockedLocationResult.distanceMeters, accuracy: lockedLocationResult.accuracy })}
      )
      RETURNING *
    `;

    // D. Reconcile daily summary in staff_attendance
    let updatedSummary;
    if (challenge.action === 'check_in') {
      [updatedSummary] = await tx`
        INSERT INTO staff_attendance (
          school_id, staff_id, attendance_date, status,
          check_in_time, check_in_event_id, verification_source,
          is_verified, marked_at, marked_by
        ) VALUES (
          ${schoolId}, ${staffId}, ${attendanceDate}, 'present',
          ${serverNow}, ${event.id}, 'mobile_v2',
          true, ${serverNow}, NULL
        )
        ON CONFLICT (staff_id, attendance_date) DO UPDATE SET
          status = 'present',
          check_in_time = ${serverNow},
          check_in_event_id = ${event.id},
          verification_source = 'mobile_v2',
          is_verified = true,
          updated_at = now()
        RETURNING *
      `;
    } else {
      // check_out action
      [updatedSummary] = await tx`
        UPDATE staff_attendance
        SET check_out_time = ${serverNow},
            check_out_event_id = ${event.id},
            updated_at = now()
        WHERE staff_id = ${staffId}
          AND school_id = ${schoolId}
          AND attendance_date = ${attendanceDate}
          AND check_out_time IS NULL
        RETURNING *
      `;
      if (!updatedSummary) {
        const err = new Error('Already checked out today');
        err.code = 'ALREADY_CHECKED_OUT';
        throw err;
      }
    }

    // E. Append audit log
    await tx`
      INSERT INTO staff_attendance_audit_logs (
        school_id, actor_id, target_staff_id, action,
        reason, previous_state, new_state, ip_address, user_agent
      ) VALUES (
        ${schoolId}, NULL, ${staffId}, ${`MOBILE_${challenge.action.toUpperCase()}`},
        'Biometric mobile attendance marked',
        ${sql.json(summaryCheck || {})},
        ${sql.json(updatedSummary)},
        ${ipAddress || null}, ${userAgent || null}
      )
    `;

    return {
      success: true,
      action: challenge.action,
      attendanceDate,
      eventTimestamp: event.event_timestamp,
      verificationStatus: 'verified',
      campus: policy.campus_name,
      summary: {
        status: updatedSummary.status,
        checkInTime: updatedSummary.check_in_time,
        checkOutTime: updatedSummary.check_out_time,
      },
    };
  });
}

/**
 * Record administrative manual attendance or correction.
 */
export async function recordAdminAttendanceAction({
  schoolId,
  adminUserId,
  targetStaffId,
  attendanceDate,
  status,
  reason,
  idempotencyKey,
  isFinalized = false,
  ipAddress,
  userAgent,
}) {
  assertValidAttendanceDateAndStatus(attendanceDate, status);
  if (!reason || !reason.trim()) {
    const err = new Error('A reason is required for administrative attendance actions');
    err.code = 'REASON_REQUIRED';
    throw err;
  }
  if (!idempotencyKey || !String(idempotencyKey).trim()) {
    const err = new Error('idempotency_key is required for administrative attendance actions');
    err.code = 'MISSING_IDEMPOTENCY_KEY';
    throw err;
  }

  // Prevent admin from modifying their own attendance through this endpoint
  const [adminUser] = await sql`SELECT person_id FROM users WHERE id = ${adminUserId} AND school_id = ${schoolId} LIMIT 1`;
  const [targetStaff] = await sql`
    SELECT person_id FROM staff
    WHERE id = ${targetStaffId} AND school_id = ${schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;

  if (!targetStaff) {
    const err = new Error('Staff member was not found in this school');
    err.code = 'STAFF_NOT_FOUND';
    throw err;
  }

  if (adminUser?.person_id === targetStaff?.person_id) {
    const err = new Error('Administrators cannot manually mark or correct their own attendance');
    err.code = 'SELF_MODIFICATION_FORBIDDEN';
    throw err;
  }
  return await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${schoolId}:${targetStaffId}:${attendanceDate}`}, 0))`;

    const [priorEvent] = await tx`
      SELECT id FROM staff_attendance_events
      WHERE school_id = ${schoolId} AND staff_id = ${targetStaffId}
        AND idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    if (priorEvent) {
      const [current] = await tx`
        SELECT * FROM staff_attendance
        WHERE school_id = ${schoolId} AND staff_id = ${targetStaffId}
          AND attendance_date = ${attendanceDate}::date AND deleted_at IS NULL
      `;
      return { success: true, isIdempotentReplay: true, attendanceDate, summary: current };
    }

    const [prevSummary] = await tx`
      SELECT * FROM staff_attendance
      WHERE staff_id = ${targetStaffId}
        AND school_id = ${schoolId}
        AND attendance_date = ${attendanceDate}::date
        AND deleted_at IS NULL
      FOR UPDATE
    `;

    const isCorrection = Boolean(prevSummary);
    const source = isCorrection ? 'admin_correction' : 'admin_manual';
    const serverNow = new Date();

    // Append immutable event
    const [event] = await tx`
      INSERT INTO staff_attendance_events (
        school_id, staff_id, action, event_timestamp,
        client_location, idempotency_key, verification_status,
        source, actor_id, metadata
      ) VALUES (
        ${schoolId}, ${targetStaffId}, 'admin_action', ${serverNow},
        ${sql.json({ note: 'administrative mark' })}, ${idempotencyKey}, 'admin_override',
        ${source}, ${adminUserId},
        ${sql.json({ reason, previous_status: prevSummary?.status || null, new_status: status })}
      )
      RETURNING *
    `;

    // Upsert staff_attendance daily summary
    const [updatedSummary] = await tx`
      INSERT INTO staff_attendance (
        school_id, staff_id, attendance_date, status,
        verification_source, is_verified, is_finalized,
        finalized_by, finalized_at, marked_by, marked_at
      ) VALUES (
        ${schoolId}, ${targetStaffId}, ${attendanceDate}::date, ${status}::attendance_status_enum,
        ${source}, false, ${isFinalized},
        ${isFinalized ? adminUserId : null}, ${isFinalized ? serverNow : null},
        ${adminUserId}, ${serverNow}
      )
      ON CONFLICT (staff_id, attendance_date) DO UPDATE SET
        status = EXCLUDED.status,
        verification_source = EXCLUDED.verification_source,
        is_verified = false,
        is_finalized = EXCLUDED.is_finalized,
        finalized_by = EXCLUDED.finalized_by,
        finalized_at = EXCLUDED.finalized_at,
        marked_by = EXCLUDED.marked_by,
        marked_at = EXCLUDED.marked_at,
        deleted_at = NULL,
        updated_at = now()
      RETURNING *
    `;

    // Audit log
    await tx`
      INSERT INTO staff_attendance_audit_logs (
        school_id, actor_id, target_staff_id, action,
        reason, previous_state, new_state, ip_address, user_agent
      ) VALUES (
        ${schoolId}, ${adminUserId}, ${targetStaffId}, ${isCorrection ? 'ADMIN_CORRECTION' : 'ADMIN_MANUAL_MARK'},
        ${reason},
        ${sql.json(prevSummary || {})},
        ${sql.json(updatedSummary)},
        ${ipAddress || null}, ${userAgent || null}
      )
    `;

    return {
      success: true,
      action: isCorrection ? 'correction' : 'manual_mark',
      attendanceDate,
      summary: updatedSummary,
    };
  });
}

/** Apply an administrator's bulk attendance sheet as one atomic V2 action. */
export async function recordAdminAttendanceBatch({
  schoolId,
  adminUserId,
  attendanceDate,
  rows,
  reason,
  idempotencyKey,
  ipAddress,
  userAgent,
}) {
  assertValidAttendanceDateAndStatus(attendanceDate);
  if (!Array.isArray(rows)) {
    const err = new Error('Attendance rows must be an array');
    err.code = 'INVALID_ADMIN_REQUEST';
    throw err;
  }
  if (!reason || !reason.trim() || !idempotencyKey || !String(idempotencyKey).trim()) {
    const err = new Error('reason and idempotency_key are required for bulk staff attendance');
    err.code = 'INVALID_ADMIN_REQUEST';
    throw err;
  }
  const normalized = [...new Map(rows.map((row) => [String(row.staff_id), row.status])).entries()]
    .map(([staffId, status]) => ({ staffId, status }))
    .sort((a, b) => a.staffId.localeCompare(b.staffId));
  if (!normalized.length) {
    const err = new Error('At least one staff attendance row is required');
    err.code = 'INVALID_ADMIN_REQUEST';
    throw err;
  }
  for (const row of normalized) assertValidAttendanceDateAndStatus(attendanceDate, row.status);

  const [adminUser] = await sql`SELECT person_id FROM users WHERE id = ${adminUserId} AND school_id = ${schoolId} LIMIT 1`;
  const targetIds = normalized.map((row) => row.staffId);
  const targetStaff = await sql`
    SELECT id, person_id FROM staff
    WHERE id = ANY(${sql.array(targetIds)}::uuid[])
      AND school_id = ${schoolId} AND deleted_at IS NULL
  `;
  if (!adminUser || targetStaff.length !== targetIds.length) {
    const err = new Error('One or more staff members were not found in this school');
    err.code = 'STAFF_NOT_FOUND';
    throw err;
  }
  const selfStaffIds = new Set(
    targetStaff
      .filter((staff) => sameId(staff.person_id, adminUser.person_id))
      .map((staff) => String(staff.id).toLowerCase())
  );
  const writable = normalized.filter((row) => !selfStaffIds.has(String(row.staffId).toLowerCase()));
  if (!writable.length) {
    const err = new Error('Administrators cannot manually mark or correct their own attendance');
    err.code = 'SELF_MODIFICATION_FORBIDDEN';
    throw err;
  }

  return sql.begin(async (tx) => {
    const results = [];
    for (const row of writable) {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${schoolId}:${row.staffId}:${attendanceDate}`}, 0))`;
      const rowKey = `${idempotencyKey}:${row.staffId}`;
      const [priorEvent] = await tx`
        SELECT id FROM staff_attendance_events
        WHERE school_id = ${schoolId} AND staff_id = ${row.staffId}
          AND idempotency_key = ${rowKey}
      `;
      if (priorEvent) {
        const [current] = await tx`
          SELECT * FROM staff_attendance
          WHERE school_id = ${schoolId} AND staff_id = ${row.staffId}
            AND attendance_date = ${attendanceDate}::date AND deleted_at IS NULL
        `;
        results.push(current);
        continue;
      }

      const [previous] = await tx`
        SELECT * FROM staff_attendance
        WHERE school_id = ${schoolId} AND staff_id = ${row.staffId}
          AND attendance_date = ${attendanceDate}::date AND deleted_at IS NULL
        FOR UPDATE
      `;
      const source = previous ? 'admin_correction' : 'admin_manual';
      const [event] = await tx`
        INSERT INTO staff_attendance_events (
          school_id, staff_id, action, event_timestamp, client_location,
          idempotency_key, verification_status, source, actor_id, metadata
        ) VALUES (
          ${schoolId}, ${row.staffId}, 'admin_action', now(), ${sql.json({})},
          ${rowKey}, 'admin_override', ${source}, ${adminUserId},
          ${sql.json({ reason, previous_status: previous?.status || null, new_status: row.status, bulk: true })}
        ) RETURNING id
      `;
      const [summary] = await tx`
        INSERT INTO staff_attendance (
          school_id, staff_id, attendance_date, status, verification_source,
          is_verified, is_finalized, marked_by, marked_at, deleted_at
        ) VALUES (
          ${schoolId}, ${row.staffId}, ${attendanceDate}::date, ${row.status}::attendance_status_enum,
          ${source}, false, false, ${adminUserId}, now(), NULL
        )
        ON CONFLICT (staff_id, attendance_date) DO UPDATE SET
          school_id = EXCLUDED.school_id, status = EXCLUDED.status,
          verification_source = EXCLUDED.verification_source, is_verified = false,
          is_finalized = false, finalized_by = NULL, finalized_at = NULL,
          marked_by = EXCLUDED.marked_by, marked_at = EXCLUDED.marked_at,
          deleted_at = NULL, updated_at = now()
        RETURNING *
      `;
      await tx`
        INSERT INTO staff_attendance_audit_logs (
          school_id, actor_id, target_staff_id, action, reason,
          previous_state, new_state, ip_address, user_agent
        ) VALUES (
          ${schoolId}, ${adminUserId}, ${row.staffId},
          ${previous ? 'ADMIN_BULK_CORRECTION' : 'ADMIN_BULK_MARK'}, ${reason},
          ${sql.json(previous || {})},
          ${sql.json({ ...summary, event_id: event.id })},
          ${ipAddress || null}, ${userAgent || null}
        )
      `;
      results.push(summary);
    }
    return results;
  });
}

/**
 * Reopen administratively finalized attendance for a staff member.
 */
export async function reopenStaffAttendance({
  schoolId,
  adminUserId,
  targetStaffId,
  attendanceDate,
  reason,
  idempotencyKey,
  ipAddress,
  userAgent,
}) {
  assertValidAttendanceDateAndStatus(attendanceDate);
  if (!reason || !reason.trim()) {
    const err = new Error('A reason is required to reopen attendance');
    err.code = 'REASON_REQUIRED';
    throw err;
  }
  if (!idempotencyKey || !String(idempotencyKey).trim()) {
    const err = new Error('idempotency_key is required to reopen attendance');
    err.code = 'MISSING_IDEMPOTENCY_KEY';
    throw err;
  }

  const [targetStaff] = await sql`
    SELECT person_id FROM staff
    WHERE id = ${targetStaffId} AND school_id = ${schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!targetStaff) {
    const err = new Error('Staff member was not found in this school');
    err.code = 'STAFF_NOT_FOUND';
    throw err;
  }
  const [adminUser] = await sql`SELECT person_id FROM users WHERE id = ${adminUserId} AND school_id = ${schoolId} LIMIT 1`;
  if (!adminUser) {
    const err = new Error('Administrator was not found in this school');
    err.code = 'ADMIN_NOT_FOUND';
    throw err;
  }
  if (adminUser.person_id === targetStaff.person_id) {
    const err = new Error('Administrators cannot reopen their own attendance');
    err.code = 'SELF_MODIFICATION_FORBIDDEN';
    throw err;
  }

  return await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${schoolId}:${targetStaffId}:${attendanceDate}`}, 0))`;
    const [priorEvent] = await tx`
      SELECT id FROM staff_attendance_events
      WHERE school_id = ${schoolId} AND staff_id = ${targetStaffId}
        AND idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    if (priorEvent) {
      const [current] = await tx`
        SELECT * FROM staff_attendance
        WHERE school_id = ${schoolId} AND staff_id = ${targetStaffId}
          AND attendance_date = ${attendanceDate}::date AND deleted_at IS NULL
      `;
      return current;
    }

    const [prevSummary] = await tx`
      SELECT * FROM staff_attendance
      WHERE staff_id = ${targetStaffId}
        AND school_id = ${schoolId}
        AND attendance_date = ${attendanceDate}::date
        AND deleted_at IS NULL
      FOR UPDATE
    `;

    if (!prevSummary) {
      const err = new Error('No attendance record found to reopen');
      err.code = 'NOT_FOUND';
      throw err;
    }

    await tx`
      INSERT INTO staff_attendance_events (
        school_id, staff_id, action, event_timestamp, client_location,
        idempotency_key, verification_status, source, actor_id, metadata
      ) VALUES (
        ${schoolId}, ${targetStaffId}, 'admin_reopen', now(), ${sql.json({})},
        ${idempotencyKey}, 'admin_override', 'admin_correction', ${adminUserId},
        ${sql.json({ reason })}
      )
    `;

    const [updated] = await tx`
      UPDATE staff_attendance
      SET is_finalized = false,
          reopened_by = ${adminUserId},
          reopened_at = now(),
          reopen_reason = ${reason},
          updated_at = now()
      WHERE id = ${prevSummary.id}
        AND school_id = ${schoolId}
      RETURNING *
    `;

    await tx`
      INSERT INTO staff_attendance_audit_logs (
        school_id, actor_id, target_staff_id, action,
        reason, previous_state, new_state, ip_address, user_agent
      ) VALUES (
        ${schoolId}, ${adminUserId}, ${targetStaffId}, 'ATTENDANCE_REOPENED',
        ${reason},
        ${sql.json(prevSummary)},
        ${sql.json(updated)},
        ${ipAddress || null}, ${userAgent || null}
      )
    `;

    return updated;
  });
}

/**
 * Authoritative response contract for staff attendance status.
 * Consumed by both the Staff Dashboard Quick Action Card and the Staff Attendance Page.
 */
export async function getAuthoritativeTodayAttendance(schoolId, staffId, canonicalPersonId, devicePublicKey = null) {
  const policy = await getCampusPolicy(schoolId);
  const attendanceDate = getSchoolLocalDate(policy.school_timezone);

  // 1. Get approved device registration
  const [device] = await sql`
    SELECT id, device_model, status, approved_at
    FROM staff_device_registrations
    WHERE canonical_person_id = ${canonicalPersonId}
      AND school_id = ${schoolId}
      AND staff_id = ${staffId}
      AND device_session_public_key = ${devicePublicKey}
      AND status = 'approved'
    LIMIT 1
  `;

  // 2. Resolve this phone's latest non-approved registration so the client can
  // reconcile approval, rejection, or revocation into protected local state.
  const [currentDevice] = device ? [null] : await sql`
    SELECT id, device_model, status, created_at
    FROM staff_device_registrations
    WHERE canonical_person_id = ${canonicalPersonId}
      AND school_id = ${schoolId}
      AND staff_id = ${staffId}
      AND device_session_public_key = ${devicePublicKey}
    ORDER BY created_at DESC
    LIMIT 1
  `;

  // 3. Get today's daily summary
  const [summary] = await sql`
    SELECT
      sa.id, sa.attendance_date, sa.status, sa.check_in_time,
      sa.check_out_time, sa.verification_source, sa.is_verified,
      sa.is_finalized
    FROM staff_attendance sa
    WHERE sa.staff_id = ${staffId}
      AND sa.school_id = ${schoolId}
      AND sa.attendance_date = ${attendanceDate}::date
      AND sa.deleted_at IS NULL
    LIMIT 1
  `;

  // 4. Pending exception request
  const [exception] = await sql`
    SELECT id, status, reason, created_at
    FROM staff_attendance_exceptions
    WHERE staff_id = ${staffId}
      AND school_id = ${schoolId}
      AND attendance_date = ${attendanceDate}::date
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const hasCheckedIn = Boolean(summary?.check_in_time);
  const hasCheckedOut = Boolean(summary?.check_out_time);
  const isFinalized = Boolean(summary?.is_finalized);
  const isApproved = Boolean(device);

  const checkInWindow = evaluateAttendanceWindow('check_in', policy);
  const checkOutWindow = evaluateAttendanceWindow('check_out', policy);
  const canCheckIn = isApproved && checkInWindow.ok && !hasCheckedIn && !isFinalized;
  const canCheckOut = isApproved && checkOutWindow.ok && hasCheckedIn && !hasCheckedOut && !isFinalized;

  return {
    attendance_date: attendanceDate,
    daily_status: summary?.status || 'not_marked',
    check_in_at: summary?.check_in_time || null,
    check_out_at: summary?.check_out_time || null,
    source: summary?.verification_source || 'none',
    verification_source: summary?.verification_source || null,
    is_verified: summary?.is_verified || false,
    is_finalized: isFinalized,
    campus: { name: policy.campus_name },
    can_check_in: canCheckIn,
    can_check_out: canCheckOut,
    device_registration_status: device ? 'approved' : (currentDevice?.status || 'none'),
    device_registration_id: device?.id || currentDevice?.id || null,
    device_model: device?.device_model || currentDevice?.device_model || null,
    exception_status: exception?.status || null,
    enforcement_mode: policy.enforcement_mode || 'disabled',
    last_updated_at: new Date().toISOString(),
  };
}

/**
 * Submit an attendance exception request.
 */
export async function submitAttendanceException({
  schoolId,
  staffId,
  attendanceDate,
  action,
  reason,
}) {
  if (!reason || !reason.trim()) {
    const err = new Error('Reason is required for an exception request');
    err.code = 'REASON_REQUIRED';
    throw err;
  }
  if (action !== 'check_in' && action !== 'check_out') {
    const err = new Error('Action must be check_in or check_out');
    err.code = 'INVALID_ACTION';
    throw err;
  }
  assertValidAttendanceDateAndStatus(attendanceDate);
  const policy = await getCampusPolicy(schoolId);
  if (String(attendanceDate) > getSchoolLocalDate(policy.school_timezone)) {
    const err = new Error('An attendance exception cannot be submitted for a future date');
    err.code = 'INVALID_ATTENDANCE_DATE';
    throw err;
  }

  const [record] = await sql`
    INSERT INTO staff_attendance_exceptions (
      school_id, staff_id, attendance_date, action, reason, status
    ) VALUES (
      ${schoolId}, ${staffId}, ${attendanceDate}::date, ${action}, ${reason}, 'pending'
    )
    ON CONFLICT (school_id, staff_id, attendance_date, action) WHERE status = 'pending'
    DO UPDATE SET reason = EXCLUDED.reason
    RETURNING *
  `;

  return record;
}
