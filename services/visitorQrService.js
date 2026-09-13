import crypto from 'node:crypto';
import sql from '../db.js';
import { encryptPassToken, decryptPassToken } from './visitorPassCrypto.js';

export function generateSecurePassToken() {
  const randomBytes = crypto.randomBytes(32).toString('hex');
  return `vpass_${randomBytes}`;
}

export function hashPassToken(token) {
  return crypto.createHash('sha256').update(String(token).trim()).digest('hex');
}

export function generateShortPassCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return `V-${code.slice(0, 3)}-${code.slice(3)}`;
}

/**
 * Validates an opaque visitor pass token against the database.
 * Never leaks raw credentials, validates school isolation, time windows,
 * entry limits, revocation, watchlist alerts, and current check-in state.
 */
export async function validateVisitorPassToken({ schoolId, token, gateId = null }) {
  if (!token || typeof token !== 'string') {
    return { isValid: false, reason: 'INVALID', message: 'Invalid or missing QR token' };
  }

  const tokenHash = hashPassToken(token);
  const cleanToken = String(token).trim();

  const [pass] = await sql`
    SELECT 
      vp.id AS pass_id,
      vp.school_id,
      vp.visitor_request_id,
      vp.pass_code,
      vp.valid_from,
      vp.valid_until,
      vp.max_entries,
      vp.entry_count,
      vp.pass_type,
      vp.status AS pass_status,
      vp.revoked_at,
      vp.revocation_reason,
      vr.id AS request_id,
      vr.purpose,
      vr.destination_department,
      vr.visitor_type,
      vr.visit_date,
      vr.start_time,
      vr.end_time,
      vr.approval_status,
      vr.visitor_count,
      vr.vehicle_number,
      vr.student_id,
      vr.host_user_id,
      vprof.id AS profile_id,
      vprof.full_name AS visitor_name,
      vprof.mobile_number AS visitor_mobile,
      vprof.email AS visitor_email,
      vprof.relationship,
      vprof.profile_photo_url,
      vprof.id_type,
      vprof.id_reference_masked,
      vprof.is_watchlisted,
      stud_p.display_name AS student_name,
      stud.admission_no AS student_admission_no,
      cls.name AS class_name,
      sec.name AS section_name,
      host_p.display_name AS host_name
    FROM public.visitor_passes vp
    JOIN public.visitor_requests vr ON vr.id = vp.visitor_request_id
    JOIN public.visitor_profiles vprof ON vprof.id = vr.visitor_profile_id
    LEFT JOIN public.students stud ON stud.id = vr.student_id AND stud.school_id = vp.school_id
    LEFT JOIN public.persons stud_p ON stud_p.id = stud.person_id
    LEFT JOIN public.student_enrollments se ON se.student_id = stud.id AND se.school_id = vp.school_id AND se.status = 'active' AND se.deleted_at IS NULL
    LEFT JOIN public.class_sections cs ON cs.id = se.class_section_id
    LEFT JOIN public.classes cls ON cls.id = cs.class_id
    LEFT JOIN public.sections sec ON sec.id = cs.section_id
    LEFT JOIN public.users host_u ON host_u.id = vr.host_user_id
    LEFT JOIN public.persons host_p ON host_p.id = host_u.person_id
    WHERE vp.token_hash = ${tokenHash} OR vp.pass_code = ${cleanToken}
    LIMIT 1
  `;

  if (!pass) {
    return { isValid: false, reason: 'INVALID', message: 'Pass not found or QR code is invalid' };
  }

  // 1. Cross-school protection
  if (Number(pass.school_id) !== Number(schoolId)) {
    return { isValid: false, reason: 'WRONG_SCHOOL', message: 'Pass belongs to another school' };
  }

  // 2. Revocation check
  if (pass.pass_status === 'REVOKED' || pass.revoked_at) {
    return {
      isValid: false,
      reason: 'REVOKED',
      message: `Pass was revoked: ${pass.revocation_reason || 'Administrative revocation'}`,
      pass,
    };
  }

  // 3. Approval check
  if (pass.approval_status === 'REJECTED') {
    return { isValid: false, reason: 'APPROVAL_REQUIRED', message: 'Visit request was rejected', pass };
  }
  if (pass.approval_status === 'PENDING') {
    return { isValid: false, reason: 'APPROVAL_REQUIRED', message: 'Visit request is pending approval', pass };
  }

  // 4. Time Window Check (with school settings early/late buffer)
  const [settings] = await sql`
    SELECT allowed_early_entry_minutes, allowed_late_entry_minutes, default_visit_duration_minutes
    FROM public.school_visitor_settings
    WHERE school_id = ${schoolId}
    LIMIT 1
  `;
  const earlyMarginMs = (settings?.allowed_early_entry_minutes ?? 30) * 60 * 1000;
  const lateMarginMs = (settings?.allowed_late_entry_minutes ?? 60) * 60 * 1000;

  const now = Date.now();
  const validFromMs = new Date(pass.valid_from).getTime() - earlyMarginMs;
  const validUntilMs = new Date(pass.valid_until).getTime() + lateMarginMs;

  if (now < validFromMs) {
    return {
      isValid: false,
      reason: 'NOT_YET_VALID',
      message: `Pass is not yet active. Allowed entry starts at ${new Date(pass.valid_from).toLocaleTimeString()}`,
      pass,
    };
  }

  if (now > validUntilMs) {
    return {
      isValid: false,
      reason: 'EXPIRED',
      message: `Pass has expired. Validity ended at ${new Date(pass.valid_until).toLocaleTimeString()}`,
      pass,
    };
  }

  // 5. Entry limit check
  if (pass.entry_count >= pass.max_entries && pass.pass_type === 'ONE_TIME') {
    return {
      isValid: false,
      reason: 'ALREADY_USED',
      message: 'This pass has already been used for entry',
      pass,
    };
  }

  // 6. Currently Inside check
  const [activeCheckin] = await sql`
    SELECT id, checked_in_at, gate_id
    FROM public.visitor_checkins
    WHERE pass_id = ${pass.pass_id}
      AND school_id = ${schoolId}
      AND checked_out_at IS NULL
    LIMIT 1
  `;
  if (activeCheckin) {
    return {
      isValid: false,
      reason: 'ALREADY_INSIDE',
      message: 'Visitor is currently inside campus. Check-out is required first.',
      pass,
      activeCheckin,
    };
  }

  // 7. Security Watchlist Check
  const watchlistMatches = await sql`
    SELECT id, restriction_level, reason
    FROM public.visitor_watchlist
    WHERE school_id = ${schoolId}
      AND is_active = true
      AND (
        mobile = ${pass.visitor_mobile}
        OR visitor_profile_id = ${pass.profile_id}
        OR (vehicle_number IS NOT NULL AND vehicle_number = ${pass.vehicle_number || 'NONE'})
      )
    LIMIT 1
  `;

  let watchlistAlert = null;
  if (watchlistMatches.length > 0) {
    const match = watchlistMatches[0];
    if (match.restriction_level === 'BLOCKED') {
      return {
        isValid: false,
        reason: 'BLACKLISTED',
        message: `SECURITY ALERT: Visitor is blocked on campus watchlist. Reason: ${match.reason}`,
        pass,
        watchlist: match,
      };
    }
    watchlistAlert = {
      level: match.restriction_level,
      reason: match.reason,
    };
  }

  return {
    isValid: true,
    reason: 'VALID',
    message: 'Pass is valid for entry',
    pass,
    watchlistAlert,
  };
}

export async function issueVisitorPass({
  schoolId,
  requestId,
  visitDate,
  startTime,
  endTime,
  passType = 'ONE_TIME',
  maxEntries = 1,
  executor = sql,
}) {
  const rawToken = generateSecurePassToken();
  const tokenHash = hashPassToken(rawToken);
  const tokenEncrypted = encryptPassToken(rawToken);
  const passCode = generateShortPassCode();

  const visitDateStr = new Date(visitDate).toISOString().split('T')[0];
  const start = String(startTime).slice(0, 8);
  const end = String(endTime).slice(0, 8);
  const validFrom = new Date(`${visitDateStr}T${start.length === 5 ? `${start}:00` : start}`);
  const validUntil = new Date(`${visitDateStr}T${end.length === 5 ? `${end}:00` : end}`);

  const [pass] = await executor`
    INSERT INTO public.visitor_passes (
      school_id, visitor_request_id, token_hash, token_encrypted, pass_code,
      valid_from, valid_until, max_entries, entry_count, pass_type, status
    ) VALUES (
      ${schoolId}, ${requestId}, ${tokenHash}, ${tokenEncrypted}, ${passCode},
      ${validFrom}, ${validUntil}, ${maxEntries}, 0, ${passType}, 'ACTIVE'
    )
    RETURNING *
  `;

  return { pass, qrToken: rawToken };
}

export function revealPassToken(passRow) {
  if (!passRow) return null;
  if (passRow.token_encrypted) {
    try {
      return decryptPassToken(passRow.token_encrypted);
    } catch {
      return null;
    }
  }
  return passRow.pass_code || null;
}
