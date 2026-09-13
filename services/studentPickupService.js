import crypto from 'node:crypto';
import sql from '../db.js';
import { sendNotificationToUsers } from './notificationService.js';
import { encryptPassToken } from './visitorPassCrypto.js';

export function hashPickupOtp(otp) {
  return crypto.createHash('sha256').update(String(otp).trim()).digest('hex');
}

export function generatePickupOtp() {
  return crypto.randomInt(100000, 999999).toString();
}

export function generatePickupToken() {
  return `pkup_${crypto.randomBytes(32).toString('hex')}`;
}

export function generateShortPickupCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return `P-${code.slice(0, 3)}-${code.slice(3)}`;
}

function timeToMinutes(value) {
  const text = String(value || '').slice(0, 5);
  const [h, m] = text.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

function sanitizePickupRecord(record) {
  if (!record) return record;
  const { otp_hash, token_hash, token_encrypted, ...safe } = record;
  return safe;
}

/**
 * Creates an authorized guardian for a student
 */
export async function addAuthorizedGuardian({
  schoolId,
  studentId,
  parentUserId,
  name,
  relationship,
  mobile,
  photoUrl = null,
  idReferenceMasked = null,
  validFrom = null,
  validUntil = null,
  notes = null,
}) {
  const [guardian] = await sql`
    INSERT INTO public.authorized_guardians (
      school_id, student_id, parent_user_id, name, relationship, mobile,
      photo_url, id_reference_masked, valid_from, valid_until, notes
    ) VALUES (
      ${schoolId}, ${studentId}, ${parentUserId}, ${name.trim()}, ${relationship.trim()},
      ${mobile.trim()}, ${photoUrl}, ${idReferenceMasked},
      ${validFrom || sql`CURRENT_DATE`}, ${validUntil}, ${notes}
    )
    RETURNING *
  `;
  return guardian;
}

/**
 * Creates a student pickup authorization with secure QR and optional OTP
 */
export async function createPickupAuthorization({
  schoolId,
  studentId,
  parentUserId,
  guardianId = null,
  pickupName,
  pickupRelationship,
  pickupMobile,
  pickupPhotoUrl = null,
  pickupDate,
  validStartTime,
  validEndTime,
  vehicleNumber = null,
  requireOtp = true,
  notes = null,
}) {
  const rawToken = generatePickupToken();
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const tokenEncrypted = encryptPassToken(rawToken);
  const passCode = generateShortPickupCode();

  let plainOtp = null;
  let otpHashed = null;
  let otpExpiresAt = null;

  if (requireOtp) {
    plainOtp = generatePickupOtp();
    otpHashed = hashPickupOtp(plainOtp);
    // OTP valid for 60 minutes or end of valid window
    otpExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  }

  const [auth] = await sql`
    INSERT INTO public.student_pickup_authorizations (
      school_id, student_id, guardian_id, parent_user_id, pickup_name,
      pickup_relationship, pickup_mobile,       pickup_photo_url, token_hash, token_encrypted,
      pass_code, pickup_date, valid_start_time, valid_end_time,
      vehicle_number, otp_hash, otp_expires_at, notes
    ) VALUES (
      ${schoolId}, ${studentId}, ${guardianId}, ${parentUserId},
      ${pickupName.trim()}, ${pickupRelationship.trim()}, ${pickupMobile.trim()},
      ${pickupPhotoUrl}, ${tokenHash}, ${tokenEncrypted}, ${passCode}, ${pickupDate},
      ${validStartTime}, ${validEndTime}, ${vehicleNumber},
      ${otpHashed}, ${otpExpiresAt}, ${notes}
    )
    RETURNING *
  `;

  return {
    authorization: auth,
    qrToken: rawToken,
    otp: plainOtp,
  };
}

/**
 * Validates a pickup QR token and optional OTP
 */
export async function validatePickup({ schoolId, token, otp = null }) {
  if (!token) {
    return { isValid: false, reason: 'INVALID', message: 'Missing pickup token' };
  }

  const cleanToken = String(token).trim();
  const tokenHash = crypto.createHash('sha256').update(cleanToken).digest('hex');

  const [record] = await sql`
    SELECT 
      spa.*,
      s.admission_no,
      p.display_name AS student_name,
      p.photo_url AS student_photo_url,
      c.name AS class_name,
      sec.name AS section_name,
      parent_p.display_name AS parent_name,
      parent_contact.contact_value AS parent_mobile
    FROM public.student_pickup_authorizations spa
    JOIN public.students s ON s.id = spa.student_id AND s.school_id = spa.school_id
    JOIN public.persons p ON p.id = s.person_id
    LEFT JOIN public.student_enrollments se ON se.student_id = s.id AND se.school_id = spa.school_id AND se.status = 'active' AND se.deleted_at IS NULL
    LEFT JOIN public.class_sections cs ON cs.id = se.class_section_id
    LEFT JOIN public.classes c ON c.id = cs.class_id
    LEFT JOIN public.sections sec ON sec.id = cs.section_id
    LEFT JOIN public.users parent_u ON parent_u.id = spa.parent_user_id
    LEFT JOIN public.persons parent_p ON parent_p.id = parent_u.person_id
    LEFT JOIN public.person_contacts parent_contact ON parent_contact.person_id = parent_p.id AND parent_contact.contact_type = 'phone' AND parent_contact.is_primary = true
    WHERE spa.token_hash = ${tokenHash} OR spa.pass_code = ${cleanToken}
    LIMIT 1
  `;

  if (!record) {
    return { isValid: false, reason: 'INVALID', message: 'Pickup pass not found or invalid' };
  }

  if (Number(record.school_id) !== Number(schoolId)) {
    return { isValid: false, reason: 'WRONG_SCHOOL', message: 'Pass belongs to another school' };
  }

  if (record.status === 'RELEASED') {
    return {
      isValid: false,
      reason: 'ALREADY_RELEASED',
      message: `Student was already released on ${new Date(record.released_at).toLocaleTimeString()}`,
      record,
    };
  }

  if (record.status === 'CANCELLED') {
    return { isValid: false, reason: 'CANCELLED', message: 'Pickup authorization was cancelled by parent', record };
  }

  // Date match
  const todayStr = new Date().toISOString().split('T')[0];
  const pickupDateStr = new Date(record.pickup_date).toISOString().split('T')[0];
  if (todayStr !== pickupDateStr) {
    return {
      isValid: false,
      reason: 'WRONG_DATE',
      message: `Pickup is scheduled for ${pickupDateStr}, today is ${todayStr}`,
      record: sanitizePickupRecord(record),
    };
  }

  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
  const startMins = timeToMinutes(record.valid_start_time);
  const endMins = timeToMinutes(record.valid_end_time);
  if (Number.isFinite(startMins) && nowMins < startMins - 15) {
    return { isValid: false, reason: 'NOT_YET_VALID', message: 'Pickup window has not started yet', record: sanitizePickupRecord(record) };
  }
  if (Number.isFinite(endMins) && nowMins > endMins + 30) {
    return { isValid: false, reason: 'EXPIRED', message: 'Pickup window has ended', record: sanitizePickupRecord(record) };
  }

  // OTP check if required
  if (record.otp_hash) {
    if (record.otp_expires_at && new Date(record.otp_expires_at).getTime() < Date.now()) {
      return { isValid: false, reason: 'OTP_EXPIRED', message: 'Pickup OTP has expired. Ask the parent to generate a new authorization.', record };
    }
    if (!otp) {
      return {
        isValid: false,
        reason: 'OTP_REQUIRED',
        message: 'Security policy requires a 6-digit OTP verification code',
        record,
      };
    }

    if (record.otp_attempts >= 5) {
      return {
        isValid: false,
        reason: 'OTP_EXCEEDED',
        message: 'Too many incorrect OTP attempts. Authorization locked.',
        record,
      };
    }

    const hashedInput = hashPickupOtp(otp);
    if (hashedInput !== record.otp_hash) {
      await sql`
        UPDATE public.student_pickup_authorizations
        SET otp_attempts = otp_attempts + 1
        WHERE id = ${record.id}
      `;
      return {
        isValid: false,
        reason: 'INVALID_OTP',
        message: 'Invalid OTP code. Please check with parent.',
        record,
      };
    }
  }

  return {
    isValid: true,
    reason: 'VALID',
    message: 'Pickup authorization verified',
    record: sanitizePickupRecord(record),
  };
}

/**
 * Releases a student to the authorized guardian at the gate
 */
export async function releaseStudentToGuardian({
  schoolId,
  authorizationId,
  gatekeeperUserId,
  gateId,
  notes = null,
}) {
  const [updated] = await sql`
    UPDATE public.student_pickup_authorizations
    SET 
      status = 'RELEASED',
      released_at = NOW(),
      released_by_gatekeeper_id = ${gatekeeperUserId},
      released_at_gate_id = ${gateId},
      notes = COALESCE(notes, '') || CASE WHEN ${notes} IS NOT NULL THEN ' | ' || ${notes} ELSE '' END
    WHERE id = ${authorizationId}
      AND school_id = ${schoolId}
      AND status <> 'RELEASED'
    RETURNING *
  `;

  if (!updated) {
    throw new Error('Could not release student: Authorization not found or already processed');
  }

  // Log audit event
  await sql`
    INSERT INTO public.visitor_audit_events (
      school_id, user_id, user_role, gate_id, event_type, entity_type, entity_id, metadata
    ) VALUES (
      ${schoolId}, ${gatekeeperUserId}, 'gate_keeper', ${gateId},
      'STUDENT_RELEASED', 'student_pickup_authorizations', ${authorizationId},
      ${sql.json({
        studentId: updated.student_id,
        pickupName: updated.pickup_name,
        pickupMobile: updated.pickup_mobile,
        releasedAt: new Date().toISOString(),
      })}
    )
  `;

  // Notify parent in real-time
  if (updated.parent_user_id) {
    try {
      const [student] = await sql`
        SELECT p.display_name FROM public.students s JOIN public.persons p ON p.id = s.person_id WHERE s.id = ${updated.student_id} LIMIT 1
      `;
      const [gate] = await sql`SELECT name FROM public.school_gates WHERE id = ${gateId} LIMIT 1`;
      const studentName = student?.display_name || 'Your child';
      const gateName = gate?.name || 'School Gate';
      const timeStr = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

      await sendNotificationToUsers(
        [updated.parent_user_id],
        'STUDENT_RELEASED',
        {
          title: 'Student Released from Gate',
          body: `${studentName} was released to ${updated.pickup_name} at ${timeStr} from ${gateName}.`,
          studentName,
          guardianName: updated.pickup_name,
          gateName,
          time: timeStr,
          message: `${studentName} was released to ${updated.pickup_name} at ${timeStr} from ${gateName}.`,
        },
        { schoolId }
      );
    } catch (notifErr) {
      console.error('[StudentPickupService] Notification failed:', notifErr.message);
    }
  }

  return updated;
}
