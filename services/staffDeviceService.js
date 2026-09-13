import crypto from 'node:crypto';
import sql from '../db.js';

/**
 * Verify ECDSA P-256 signature using SHA-256 digest.
 */
export function verifyEcdsaSignature(publicKeyPem, dataString, signatureBase64) {
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(Buffer.from(dataString, 'utf8'));
    return verifier.verify(publicKeyPem, Buffer.from(signatureBase64, 'base64'));
  } catch (err) {
    console.error('[verifyEcdsaSignature] Verification error:', err.message);
    return false;
  }
}

/**
 * Register a new mobile device for a staff member (status: 'pending').
 */
export async function registerDevice({
  schoolId,
  staffId,
  canonicalPersonId,
  installationId,
  deviceSessionPublicKey,
  attendancePublicKey,
  deviceModel,
  osName,
  osVersion,
  appVersion,
  proofNonce,
  proofSignature,
}) {
  if (!installationId || typeof installationId !== 'string' || installationId.length > 200) {
    const err = new Error('A valid mobile installation identifier is required');
    err.code = 'DEVICE_ID_REQUIRED';
    throw err;
  }
  if (typeof deviceSessionPublicKey !== 'string' || deviceSessionPublicKey.length > 4096 ||
      typeof attendancePublicKey !== 'string' || attendancePublicKey.length > 4096 ||
      typeof proofNonce !== 'string' || proofNonce.length > 300 ||
      typeof proofSignature !== 'string' || proofSignature.length > 2048) {
    const err = new Error('Device key registration data is invalid');
    err.code = 'INVALID_DEVICE_KEYS';
    throw err;
  }
  try {
    for (const pem of [deviceSessionPublicKey, attendancePublicKey]) {
      const key = crypto.createPublicKey(pem);
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error('Expected P-256');
      }
    }
  } catch {
    const err = new Error('Both device keys must be valid P-256 public keys');
    err.code = 'INVALID_DEVICE_KEYS';
    throw err;
  }

  // 1. Verify that the staff record belongs to this person and school
  const [staffRecord] = await sql`
    SELECT id, person_id, school_id, status_id
    FROM staff
    WHERE id = ${staffId} AND school_id = ${schoolId} AND person_id = ${canonicalPersonId} AND deleted_at IS NULL
    LIMIT 1
  `;

  if (!staffRecord) {
    const err = new Error('Staff record not found or does not match authenticated person');
    err.code = 'STAFF_NOT_FOUND';
    throw err;
  }

  // 2. Verify proof of possession of the device session key
  if (!proofNonce || !proofSignature || !verifyEcdsaSignature(deviceSessionPublicKey, proofNonce, proofSignature)) {
    const err = new Error('Cryptographic proof of key possession failed');
    err.code = 'INVALID_KEY_PROOF';
    throw err;
  }

  // Serialize registrations from one app installation so two accounts cannot
  // race through the pre-approval check. The installation ID supplements the
  // non-exportable session key and remains intentionally replaceable after an
  // administrator rejects or revokes a registration.
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-installation:${installationId}`}, 0))`;

    const [ownershipConflict] = await tx`
      SELECT id, canonical_person_id
      FROM staff_device_registrations
      WHERE (device_session_public_key = ${deviceSessionPublicKey}
          OR installation_id = ${installationId})
        AND status IN ('pending', 'approved')
        AND canonical_person_id <> ${canonicalPersonId}
      LIMIT 1
    `;
    if (ownershipConflict) {
      const err = new Error('This mobile installation is already registered to another staff member');
      err.code = 'DEVICE_OWNED_BY_ANOTHER_STAFF';
      throw err;
    }

    const [existingPending] = await tx`
      SELECT * FROM staff_device_registrations
      WHERE school_id = ${schoolId} AND staff_id = ${staffId}
        AND canonical_person_id = ${canonicalPersonId}
        AND installation_id = ${installationId}
        AND device_session_public_key = ${deviceSessionPublicKey}
        AND attendance_public_key = ${attendancePublicKey}
        AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (existingPending) return existingPending;

    const [reg] = await tx`
      INSERT INTO staff_device_registrations (
        school_id, staff_id, canonical_person_id, installation_id,
        device_session_public_key, attendance_public_key,
        device_model, os_name, os_version, app_version,
        status
      ) VALUES (
        ${schoolId}, ${staffId}, ${canonicalPersonId}, ${installationId},
        ${deviceSessionPublicKey}, ${attendancePublicKey},
        ${deviceModel || null}, ${osName || null}, ${osVersion || null}, ${appVersion || null},
        'pending'
      )
      RETURNING *
    `;
    return reg;
  });
}

/**
 * Get active approved device for a person.
 */
export async function getApprovedDeviceForPerson(canonicalPersonId) {
  const [row] = await sql`
    SELECT *
    FROM staff_device_registrations
    WHERE canonical_person_id = ${canonicalPersonId}
      AND status = 'approved'
    LIMIT 1
  `;
  return row || null;
}

/**
 * Get device registration by ID.
 */
export async function getDeviceRegistrationById(registrationId) {
  const [row] = await sql`
    SELECT sdr.*, p.display_name AS staff_name, st.staff_code
    FROM staff_device_registrations sdr
    JOIN staff st ON st.id = sdr.staff_id
    JOIN persons p ON p.id = sdr.canonical_person_id
    WHERE sdr.id = ${registrationId}
    LIMIT 1
  `;
  return row || null;
}

/**
 * Approve a pending device registration (Admin action).
 */
export async function approveDeviceRegistration(registrationId, adminUserId, schoolId) {
  const [target] = await sql`
    SELECT * FROM staff_device_registrations
    WHERE id = ${registrationId} AND school_id = ${schoolId}
    LIMIT 1
  `;

  if (!target) {
    const err = new Error('Device registration not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  // Prevent users from approving their own registration
  const [adminPerson] = await sql`
    SELECT person_id FROM users
    WHERE id = ${adminUserId} AND school_id = ${schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!adminPerson) {
    const err = new Error('Administrator was not found in this school');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (adminPerson.person_id === target.canonical_person_id) {
    const err = new Error('Administrators cannot approve their own device registration');
    err.code = 'SELF_APPROVAL_FORBIDDEN';
    throw err;
  }

  // Atomically archive previous active registrations for this person and activate this one
  return await sql.begin(async (tx) => {
    const [lockedTarget] = await tx`
      SELECT * FROM staff_device_registrations
      WHERE id = ${registrationId} AND school_id = ${schoolId} AND status = 'pending'
      FOR UPDATE
    `;
    if (!lockedTarget) {
      const err = new Error('Only a pending device registration can be approved');
      err.code = 'NOT_FOUND';
      throw err;
    }
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-device-approval:${schoolId}:${lockedTarget.canonical_person_id}`}, 0))`;
    if (lockedTarget.installation_id) {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-device-installation:${lockedTarget.installation_id}`}, 0))`;
    }
    const [deviceConflict] = await tx`
      SELECT id FROM staff_device_registrations
      WHERE (device_session_public_key = ${lockedTarget.device_session_public_key}
          OR (installation_id IS NOT NULL AND installation_id = ${lockedTarget.installation_id}))
        AND canonical_person_id <> ${lockedTarget.canonical_person_id}
        AND status = 'approved'
      FOR SHARE
    `;
    if (deviceConflict) {
      const err = new Error('This device is already approved for another staff member');
      err.code = 'DEVICE_OWNED_BY_ANOTHER_STAFF';
      throw err;
    }
    // 1. Mark any previously approved device for this person as 'replaced'
    await tx`
      UPDATE staff_device_registrations
      SET status = 'replaced',
          revoked_by = ${adminUserId},
          revoked_at = now(),
          revocation_reason = 'Replaced by newly approved device',
          updated_at = now()
      WHERE canonical_person_id = ${lockedTarget.canonical_person_id}
        AND school_id = ${schoolId}
        AND status = 'approved'
        AND id != ${registrationId}
    `;

    // 2. Revoke any prior device sessions
    await tx`
      UPDATE staff_device_sessions
      SET is_revoked = true, updated_at = now()
      WHERE registration_id IN (
        SELECT id FROM staff_device_registrations
        WHERE canonical_person_id = ${lockedTarget.canonical_person_id}
          AND school_id = ${schoolId} AND id != ${registrationId}
      )
    `;

    // 3. Invalidate any outstanding challenges for this person
    await tx`
      UPDATE attendance_challenges
      SET consumed_at = now()
      WHERE school_id = ${schoolId} AND staff_id = ${lockedTarget.staff_id} AND consumed_at IS NULL
    `;

    // 4. Approve the target registration
    const [approved] = await tx`
      UPDATE staff_device_registrations
      SET status = 'approved',
          approved_by = ${adminUserId},
          approved_at = now(),
          updated_at = now()
      WHERE id = ${registrationId} AND school_id = ${schoolId} AND status = 'pending'
      RETURNING *
    `;

    // 5. Write audit log
    await tx`
      INSERT INTO staff_attendance_audit_logs (
        school_id, actor_id, target_staff_id, action,
        reason, previous_state, new_state
      ) VALUES (
        ${schoolId}, ${adminUserId}, ${lockedTarget.staff_id}, 'DEVICE_APPROVED',
        'Device registration approved by admin',
        ${sql.json({ previous_status: lockedTarget.status })},
        ${sql.json({ new_status: 'approved', registration_id: approved.id, device_model: approved.device_model })}
      )
    `;

    return approved;
  });
}

/**
 * Revoke an approved device registration (Admin action).
 */
export async function revokeDeviceRegistration(registrationId, adminUserId, schoolId, reason) {
  const [target] = await sql`
    SELECT * FROM staff_device_registrations
    WHERE id = ${registrationId} AND school_id = ${schoolId}
    LIMIT 1
  `;

  if (!target) {
    const err = new Error('Device registration not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  return await sql.begin(async (tx) => {
    const [revoked] = await tx`
      UPDATE staff_device_registrations
      SET status = 'revoked',
          revoked_by = ${adminUserId},
          revoked_at = now(),
          revocation_reason = ${reason || 'Revoked by administrator'},
          updated_at = now()
      WHERE id = ${registrationId} AND school_id = ${schoolId} AND status = 'approved'
      RETURNING *
    `;
    if (!revoked) {
      const err = new Error('Approved device registration not found');
      err.code = 'NOT_FOUND';
      throw err;
    }

    // Revoke all active device sessions for this registration
    await tx`
      UPDATE staff_device_sessions
      SET is_revoked = true, updated_at = now()
      WHERE registration_id = ${registrationId}
    `;

    // Invalidate outstanding challenges
    await tx`
      UPDATE attendance_challenges
      SET consumed_at = now()
      WHERE registration_id = ${registrationId} AND consumed_at IS NULL
    `;

    // Audit log
    await tx`
      INSERT INTO staff_attendance_audit_logs (
        school_id, actor_id, target_staff_id, action,
        reason, previous_state, new_state
      ) VALUES (
        ${schoolId}, ${adminUserId}, ${target.staff_id}, 'DEVICE_REVOKED',
        ${reason || 'Revoked by administrator'},
        ${sql.json({ previous_status: target.status })},
        ${sql.json({ new_status: 'revoked', registration_id: registrationId })}
      )
    `;

    return revoked;
  });
}

/**
 * Check whether a mobile device is bound to another staff member.
 * Used during login, restore, and account switching.
 */
export async function checkDeviceOwnershipConflict(deviceSessionPublicKey, incomingPersonId, installationId = null) {
  if ((!deviceSessionPublicKey && !installationId) || !incomingPersonId) return { conflict: false };

  const [activeReg] = await sql`
    SELECT id, canonical_person_id, staff_id
    FROM staff_device_registrations
    WHERE (device_session_public_key = ${deviceSessionPublicKey}
        OR (${installationId}::text IS NOT NULL AND installation_id = ${installationId}))
      AND status IN ('pending', 'approved')
      AND canonical_person_id <> ${incomingPersonId}
    LIMIT 1
  `;

  if (!activeReg) return { conflict: false };
  return {
    conflict: true,
    registeredPersonId: activeReg.canonical_person_id,
    staffId: activeReg.staff_id,
  };
}

/**
 * Require a fresh signature from the approved device-session key whenever a
 * staff account already has an approved phone. The signed method/path and
 * one-time nonce stop a copied public-key header or replayed proof from being
 * treated as device possession.
 */
export async function enforceStaffDeviceProof({
  schoolId,
  userId,
  personId,
  publicKey,
  installationId,
  proofTimestamp,
  proofNonce,
  proofSignature,
  method,
  path,
  requireRegistration = false,
}) {
  const [approved] = await sql`
    SELECT id, device_session_public_key
    FROM staff_device_registrations
    WHERE canonical_person_id = ${personId}
      AND school_id = ${schoolId}
      AND status = 'approved'
    LIMIT 1
  `;

  if (!approved) {
    const conflict = await checkDeviceOwnershipConflict(publicKey, personId, installationId);
    if (conflict.conflict) {
      const err = new Error('This device is registered to another staff member');
      err.code = 'DEVICE_OWNED_BY_ANOTHER_STAFF';
      throw err;
    }
    if (requireRegistration) {
      const [policy] = await sql`
        SELECT enforcement_mode FROM campus_attendance_policies
        WHERE school_id = ${schoolId} AND is_active = true
        ORDER BY created_at ASC LIMIT 1
      `;
      if (policy?.enforcement_mode === 'enforced') {
        const err = new Error('An approved staff device registration is required');
        err.code = 'DEVICE_REGISTRATION_REQUIRED';
        throw err;
      }
    }
    return { required: false };
  }

  if (!publicKey || publicKey !== approved.device_session_public_key) {
    const err = new Error('This staff account must be used from its approved mobile device');
    err.code = 'DEVICE_PROOF_REQUIRED';
    throw err;
  }
  const timestamp = Number(proofTimestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 60_000 ||
      typeof proofNonce !== 'string' || !proofNonce || proofNonce.length > 300 ||
      typeof proofSignature !== 'string' || !proofSignature || proofSignature.length > 2048) {
    const err = new Error('A fresh approved-device proof is required');
    err.code = 'INVALID_DEVICE_PROOF';
    throw err;
  }
  const proofPayload = `staff-device-session:v1:${proofTimestamp}:${proofNonce}:${String(method).toUpperCase()}:${path}`;
  if (!verifyEcdsaSignature(publicKey, proofPayload, proofSignature)) {
    const err = new Error('Approved-device signature verification failed');
    err.code = 'INVALID_DEVICE_PROOF';
    throw err;
  }

  await sql.begin(async (tx) => {
    await tx`DELETE FROM staff_device_request_nonces WHERE expires_at < now()`;
    const [nonce] = await tx`
      INSERT INTO staff_device_request_nonces (registration_id, nonce, expires_at)
      VALUES (${approved.id}, ${proofNonce}, now() + interval '2 minutes')
      ON CONFLICT (registration_id, nonce) DO NOTHING
      RETURNING nonce
    `;
    if (!nonce) {
      const err = new Error('Approved-device proof has already been used');
      err.code = 'DEVICE_PROOF_REPLAYED';
      throw err;
    }
    await tx`
      INSERT INTO staff_device_sessions (
        registration_id, user_id, school_id, device_public_key,
        is_revoked, last_verified_at
      ) VALUES (
        ${approved.id}, ${userId}, ${schoolId}, ${publicKey}, false, now()
      )
      ON CONFLICT (registration_id, user_id, school_id) WHERE is_revoked = false
      DO UPDATE SET last_verified_at = now(), device_public_key = EXCLUDED.device_public_key,
        updated_at = now()
    `;
  });
  return { required: true, registrationId: approved.id };
}

/**
 * List registrations for administrative management.
 */
export async function listSchoolDeviceRegistrations(schoolId, statusFilter = null) {
  return await sql`
    SELECT
      sdr.*,
      p.display_name AS staff_name,
      p.photo_url,
      st.staff_code,
      sd.name AS designation,
      (SELECT pc.contact_value FROM person_contacts pc WHERE pc.person_id = u_app.person_id
        AND pc.school_id = u_app.school_id AND pc.contact_type = 'email' AND pc.deleted_at IS NULL
        ORDER BY pc.is_primary DESC, pc.created_at ASC LIMIT 1) AS approver_email,
      (SELECT pc.contact_value FROM person_contacts pc WHERE pc.person_id = u_rev.person_id
        AND pc.school_id = u_rev.school_id AND pc.contact_type = 'email' AND pc.deleted_at IS NULL
        ORDER BY pc.is_primary DESC, pc.created_at ASC LIMIT 1) AS revoker_email
    FROM staff_device_registrations sdr
    JOIN staff st ON st.id = sdr.staff_id
    JOIN persons p ON p.id = sdr.canonical_person_id
    LEFT JOIN staff_designations sd ON sd.id = st.designation_id
    LEFT JOIN users u_app ON u_app.id = sdr.approved_by
    LEFT JOIN users u_rev ON u_rev.id = sdr.revoked_by
    WHERE sdr.school_id = ${schoolId}
      ${statusFilter ? sql`AND sdr.status = ${statusFilter}` : sql``}
    ORDER BY sdr.created_at DESC
  `;
}
