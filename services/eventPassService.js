import crypto from 'node:crypto';
import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';
import logger from '../utils/logger.js';

export function generateSecureEventPassToken() {
  const randomBytes = crypto.randomBytes(32).toString('hex');
  return `evpass_${randomBytes}`;
}

export function hashEventPassToken(token) {
  return crypto.createHash('sha256').update(String(token).trim()).digest('hex');
}

export function generateShortEventPassCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return `EV-${code.slice(0, 3)}-${code.slice(3)}`;
}

export const EventPassService = {
  /**
   * Generate an event pass for an attendee
   */
  async generatePassForRegistration({
    schoolId,
    eventId,
    registrationId,
    attendeeType = 'STUDENT',
    studentId = null,
    userId = null,
    guestName = null,
    guestPhone = null,
    validFrom,
    validUntil,
    maxEntries = 2, // Entry + Re-entry default
  }, tx = sql) {
    const rawToken = generateSecureEventPassToken();
    const tokenHash = hashEventPassToken(rawToken);
    const passCode = generateShortEventPassCode();

    const [pass] = await tx`
      INSERT INTO event_passes (
        school_id, event_id, registration_id, attendee_type, student_id, user_id,
        guest_name, guest_phone, pass_code, token_hash, valid_from, valid_until,
        max_entries, status
      ) VALUES (
        ${schoolId}, ${eventId}, ${registrationId || null}, ${attendeeType},
        ${studentId || null}, ${userId || null}, ${guestName || null},
        ${guestPhone || null}, ${passCode}, ${tokenHash}, ${validFrom},
        ${validUntil}, ${maxEntries}, 'ACTIVE'
      )
      RETURNING *
    `;

    return {
      pass,
      rawToken,
      token: rawToken,
    };
  },

  /**
   * Validate an event pass token (scanned by Gatekeeper or Event Coordinator)
   */
  async validateEventPass({ schoolId, token, gateId = null }) {
    if (!token || typeof token !== 'string') {
      return { isValid: false, reason: 'INVALID', message: 'Invalid or missing QR token' };
    }

    const cleanToken = String(token).trim();
    const tokenHash = hashEventPassToken(cleanToken);

    const [pass] = await sql`
      SELECT 
        p.*,
        e.title as event_title,
        e.start_date as event_start_date,
        e.end_date as event_end_date,
        e.location as event_location,
        e.status as event_status,
        e.configuration as event_config,
        stud_p.display_name as student_name,
        stud.admission_no as student_admission_no,
        cls.name as class_name,
        sec.name as section_name,
        u_p.display_name as staff_name,
        c.status as consent_status,
        pay.status as payment_status
      FROM event_passes p
      JOIN events e ON e.id = p.event_id
      LEFT JOIN students stud ON stud.id = p.student_id AND stud.school_id = p.school_id
      LEFT JOIN persons stud_p ON stud_p.id = stud.person_id
      LEFT JOIN student_enrollments se ON se.student_id = stud.id AND se.school_id = p.school_id AND se.status = 'active' AND se.deleted_at IS NULL
      LEFT JOIN class_sections cs ON cs.id = se.class_section_id
      LEFT JOIN classes cls ON cls.id = cs.class_id
      LEFT JOIN sections sec ON sec.id = cs.section_id
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN persons u_p ON u_p.id = u.person_id
      LEFT JOIN event_consents c ON c.event_id = p.event_id AND c.student_id = p.student_id
      LEFT JOIN event_payments pay ON pay.event_id = p.event_id AND pay.student_id = p.student_id
      WHERE (p.token_hash = ${tokenHash} OR p.pass_code = ${cleanToken})
      LIMIT 1
    `;

    if (!pass) {
      return { isValid: false, reason: 'NOT_FOUND', message: 'Pass not found or QR code is invalid' };
    }

    // 1. Cross-school protection
    if (Number(pass.school_id) !== Number(schoolId)) {
      return { isValid: false, reason: 'WRONG_SCHOOL', message: 'Pass belongs to another institution' };
    }

    // 2. Event status check
    if (pass.event_status === 'CANCELLED') {
      return { isValid: false, reason: 'EVENT_CANCELLED', message: 'This event has been cancelled' };
    }

    // 3. Pass revocation
    if (pass.status === 'REVOKED') {
      return { isValid: false, reason: 'REVOKED', message: `Pass was revoked: ${pass.revocation_reason || 'Administrative action'}` };
    }

    // 4. Time window validation
    const now = new Date();
    if (new Date(pass.valid_until) < now) {
      return { isValid: false, reason: 'EXPIRED', message: 'Pass has expired' };
    }

    // 5. Entry limit validation
    if (pass.entry_count >= pass.max_entries && pass.status === 'USED') {
      return { isValid: false, reason: 'ENTRY_LIMIT_REACHED', message: 'Maximum allowed entries reached for this pass' };
    }

    // 6. Parent Consent requirement validation
    const modules = pass.event_config?.modules || {};
    if (modules.consent && pass.attendee_type === 'STUDENT') {
      if (pass.consent_status !== 'CONSENTED') {
        return {
          isValid: false,
          reason: 'CONSENT_PENDING',
          message: 'Parent consent has not been granted for this student',
          pass: this._formatPassPayload(pass),
        };
      }
    }

    // 7. Payment requirement validation
    if (modules.payments && pass.attendee_type === 'STUDENT') {
      const feeAmount = pass.event_config?.constraints?.fee_amount || 0;
      if (feeAmount > 0 && pass.payment_status !== 'PAID' && pass.payment_status !== 'WAIVED') {
        return {
          isValid: false,
          reason: 'PAYMENT_PENDING',
          message: 'Event fee payment is pending',
          pass: this._formatPassPayload(pass),
        };
      }
    }

    // Check recent scan history to alert on rapid duplicate scans
    const [recentCheckin] = await sql`
      SELECT direction, scanned_at FROM event_checkins
      WHERE pass_id = ${pass.id}
      ORDER BY scanned_at DESC LIMIT 1
    `;

    return {
      isValid: true,
      pass: this._formatPassPayload(pass),
      lastCheckin: recentCheckin || null,
      message: 'Pass is valid for entry',
    };
  },

  /**
   * Execute entry / exit check-in
   */
  async recordCheckIn({
    schoolId,
    passToken,
    eventId,
    direction = 'ENTRY',
    gateId = null,
    verifiedBy = null,
    verificationMethod = 'QR_SCAN',
    notes = null,
    clientEventId = null,
    forceOverride = false,
  }) {
    const validation = await this.validateEventPass({ schoolId, token: passToken });
    const blockingReasons = new Set(['CONSENT_PENDING', 'PAYMENT_PENDING']);
    if (!validation.isValid && !(forceOverride && blockingReasons.has(validation.reason))) {
      const err = new Error(validation.message);
      err.statusCode = 400;
      err.code = validation.reason;
      throw err;
    }

    const pass = validation.pass;
    if (eventId && pass?.event_id && String(eventId) !== String(pass.event_id)) {
      const err = new Error('Pass does not belong to this event');
      err.statusCode = 400;
      err.code = 'EVENT_MISMATCH';
      throw err;
    }

    return await sql.begin(async (tx) => {
      // Idempotency check for offline sync
      if (clientEventId) {
        const [existing] = await tx`
          SELECT id, scanned_at FROM event_checkins
          WHERE school_id = ${schoolId} AND client_event_id = ${clientEventId}
          LIMIT 1
        `;
        if (existing) {
          return { success: true, checkin: existing, message: 'Already processed (idempotent)' };
        }
      }

      // Record checkin log
      const [checkin] = await tx`
        INSERT INTO event_checkins (
          school_id, event_id, pass_id, attendee_type, attendee_id,
          direction, gate_id, verified_by, verification_method, notes, client_event_id
        ) VALUES (
          ${schoolId}, ${pass.event_id}, ${pass.id}, ${pass.attendee_type},
          ${pass.student_id || pass.user_id || pass.id},
          ${direction}, ${gateId}, ${verifiedBy}, ${verificationMethod}, ${notes}, ${clientEventId}
        )
        RETURNING *
      `;

      // Update pass entry count
      if (direction === 'ENTRY') {
        const newCount = pass.entry_count + 1;
        const newStatus = newCount >= pass.max_entries ? 'USED' : 'ACTIVE';
        await tx`
          UPDATE event_passes
          SET entry_count = ${newCount}, status = ${newStatus}, updated_at = now()
          WHERE id = ${pass.id}
        `;
      }

      // Update event_attendance table
      if (pass.student_id) {
        await tx`
          INSERT INTO event_attendance (
            school_id, event_id, participant_type, student_id, status, checkin_time, marked_by
          ) VALUES (
            ${schoolId}, ${pass.event_id}, 'STUDENT', ${pass.student_id},
            ${direction === 'ENTRY' ? 'CHECKED_IN' : 'CHECKED_OUT'},
            now(), ${verifiedBy}
          )
          ON CONFLICT (event_id, student_id) DO UPDATE SET
            status = EXCLUDED.status,
            checkin_time = CASE WHEN EXCLUDED.status = 'CHECKED_IN' THEN now() ELSE event_attendance.checkin_time END,
            checkout_time = CASE WHEN EXCLUDED.status = 'CHECKED_OUT' THEN now() ELSE event_attendance.checkout_time END,
            updated_at = now()
        `;
      }

      await EventEngineService.logAudit({
        schoolId,
        eventId: pass.event_id,
        actorUserId: verifiedBy,
        action: `PASS_${direction}`,
        entityType: 'EVENT_PASS',
        entityId: pass.id,
        details: `${direction} recorded via ${verificationMethod}`,
      }, tx);

      return {
        success: true,
        checkin,
        attendee_name: pass.attendee_name,
        direction,
        message: `${direction === 'ENTRY' ? 'Entry' : 'Exit'} approved for ${pass.attendee_name}`,
      };
    });
  },

  /**
   * Get an attendee's active pass for display in parent/student/staff apps
   */
  async getMyPass({ schoolId, eventId, studentId = null, userId = null }) {
    const [pass] = await sql`
      SELECT 
        p.*,
        e.title as event_title,
        e.start_date as event_start_date,
        e.end_date as event_end_date,
        e.start_time as event_start_time,
        e.end_time as event_end_time,
        e.location as event_location,
        stud_p.display_name as student_name,
        cls.name as class_name,
        sec.name as section_name
      FROM event_passes p
      JOIN events e ON e.id = p.event_id
      LEFT JOIN students stud ON stud.id = p.student_id
      LEFT JOIN persons stud_p ON stud_p.id = stud.person_id
      LEFT JOIN student_enrollments se ON se.student_id = stud.id AND se.school_id = ${schoolId} AND se.status = 'active' AND se.deleted_at IS NULL
      LEFT JOIN class_sections cs ON cs.id = se.class_section_id
      LEFT JOIN classes cls ON cls.id = cs.class_id
      LEFT JOIN sections sec ON sec.id = cs.section_id
      WHERE p.event_id = ${eventId}
        AND p.school_id = ${schoolId}
        AND p.status != 'REVOKED'
        ${studentId ? sql`AND p.student_id = ${studentId}` : sql`AND p.user_id = ${userId}`}
      ORDER BY p.created_at DESC
      LIMIT 1
    `;

    return pass ? this._formatPassPayload(pass) : null;
  },

  async listPasses({ schoolId, eventId }) {
    const rows = await sql`
      SELECT 
        p.*,
        stud_p.display_name as student_name,
        u_p.display_name as staff_name,
        c.status as consent_status,
        pay.status as payment_status
      FROM event_passes p
      LEFT JOIN students stud ON stud.id = p.student_id
      LEFT JOIN persons stud_p ON stud_p.id = stud.person_id
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN persons u_p ON u_p.id = u.person_id
      LEFT JOIN event_consents c ON c.event_id = p.event_id AND c.student_id = p.student_id
      LEFT JOIN event_payments pay ON pay.event_id = p.event_id AND pay.student_id = p.student_id
      WHERE p.event_id = ${eventId} AND p.school_id = ${schoolId}
      ORDER BY p.created_at DESC
    `;
    return rows.map((row) => this._formatPassPayload(row));
  },

  async bulkIssueForEvent({ schoolId, eventId, userId }) {
    const [event] = await sql`
      SELECT id, start_date, end_date FROM events WHERE id = ${eventId} AND school_id = ${schoolId}
    `;
    if (!event) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    const missing = await sql`
      SELECT r.*
      FROM event_registrations r
      WHERE r.event_id = ${eventId}
        AND r.school_id = ${schoolId}
        AND r.deleted_at IS NULL
        AND r.registration_status IN ('REGISTERED', 'CONFIRMED')
        AND NOT EXISTS (
          SELECT 1 FROM event_passes p WHERE p.registration_id = r.id AND p.status != 'REVOKED'
        )
    `;

    let issued = 0;
    for (const reg of missing) {
      await this.generatePassForRegistration({
        schoolId,
        eventId,
        registrationId: reg.id,
        attendeeType: reg.participant_type,
        studentId: reg.student_id,
        userId: userId || null,
        guestName: reg.external_name,
        guestPhone: reg.external_contact,
        validFrom: `${event.start_date}T00:00:00Z`,
        validUntil: `${event.end_date || event.start_date}T23:59:59Z`,
      });
      issued += 1;
    }

    await EventEngineService.logAudit({
      schoolId,
      eventId,
      actorUserId: userId,
      action: 'PASSES_BULK_ISSUED',
      entityType: 'EVENT_PASS',
      entityId: eventId,
      details: `Issued ${issued} passes`,
    });

    return { issued_count: issued };
  },

  async listMyPasses({ schoolId, studentId = null, userId = null }) {
    const rows = await sql`
      SELECT 
        p.*,
        e.title as event_title,
        e.start_date as event_start_date,
        e.location as event_location,
        stud_p.display_name as student_name,
        c.status as consent_status,
        pay.status as payment_status
      FROM event_passes p
      JOIN events e ON e.id = p.event_id
      LEFT JOIN students stud ON stud.id = p.student_id
      LEFT JOIN persons stud_p ON stud_p.id = stud.person_id
      LEFT JOIN event_consents c ON c.event_id = p.event_id AND c.student_id = p.student_id
      LEFT JOIN event_payments pay ON pay.event_id = p.event_id AND pay.student_id = p.student_id
      WHERE p.school_id = ${schoolId}
        AND p.status != 'REVOKED'
        ${studentId ? sql`AND p.student_id = ${studentId}` : sql`AND p.user_id = ${userId}`}
      ORDER BY e.start_date DESC
    `;
    return rows.map((row) => this._formatPassPayload(row));
  },

  _formatPassPayload(row) {
    return {
      id: row.id,
      event_id: row.event_id,
      pass_code: row.pass_code,
      attendee_type: row.attendee_type,
      student_id: row.student_id,
      user_id: row.user_id,
      attendee_name: row.student_name || row.staff_name || row.guest_name || 'Attendee',
      admission_no: row.student_admission_no || null,
      class_name: row.class_name ? `${row.class_name}${row.section_name ? ` - ${row.section_name}` : ''}` : null,
      event_title: row.event_title,
      event_date: row.event_start_date,
      location: row.event_location,
      valid_from: row.valid_from,
      valid_until: row.valid_until,
      entry_count: row.entry_count,
      max_entries: row.max_entries,
      status: row.status,
      consent_status: row.consent_status || null,
      payment_status: row.payment_status || null,
    };
  },

  async validateEventPassToken(params) {
    return await this.validateEventPass(params);
  },

  async checkInPass({ schoolId, token, passToken, eventId, gateId = null, scannedByUserId = null, scanType = 'GATE_ENTRY', verificationMethod = 'QR_SCAN', notes = null, clientEventId = null, forceOverride = false }) {
    return await this.recordCheckIn({
      schoolId,
      passToken: passToken || token,
      eventId,
      gateId,
      verifiedBy: scannedByUserId,
      direction: scanType === 'GATE_EXIT' ? 'EXIT' : 'ENTRY',
      verificationMethod,
      notes,
      clientEventId,
      forceOverride,
    });
  },
};

export default EventPassService;
