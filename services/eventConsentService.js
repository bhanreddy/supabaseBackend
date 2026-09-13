import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';
import { sendNotificationToUsers } from './notificationService.js';
import logger from '../utils/logger.js';
import { pickField } from './eventModuleUtils.js';

export const EventConsentService = {
  /**
   * Submit or update parent consent for a student
   */
  async submitParentConsent({
    schoolId,
    eventId,
    studentId: studentIdInput,
    parentId = null,
    status, // 'CONSENTED' | 'DECLINED'
    acknowledgements = {},
    remarks = null,
    ipAddress = null,
    userAgent = null,
    userId = null,
  }) {
    const studentId = pickField({ studentId: studentIdInput, student_id: studentIdInput }, 'studentId', 'student_id');
    if (!studentId) {
      const err = new Error('student_id is required');
      err.statusCode = 400;
      throw err;
    }
    if (!['CONSENTED', 'DECLINED'].includes(status)) {
      const err = new Error('Status must be CONSENTED or DECLINED');
      err.statusCode = 400;
      throw err;
    }

    const [event] = await sql`
      SELECT id, title, start_date FROM events
      WHERE id = ${eventId} AND school_id = ${schoolId} AND deleted_at IS NULL
    `;
    if (!event) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    let resolvedParentId = parentId;
    if (!resolvedParentId && studentId) {
      const [sp] = await sql`
        SELECT parent_id FROM student_parents WHERE student_id = ${studentId} LIMIT 1
      `;
      resolvedParentId = sp?.parent_id || null;
    }

    if (!resolvedParentId) {
      const err = new Error('No parent is linked to this student; consent cannot be recorded');
      err.statusCode = 400;
      throw err;
    }

    return await sql.begin(async (tx) => {
      const [consent] = await tx`
        INSERT INTO event_consents (
          school_id, event_id, student_id, parent_id, status,
          medical_declaration_ack, emergency_treatment_auth,
          transportation_consent, photography_media_consent,
          rules_instructions_ack, parent_remarks, ip_address, user_agent,
          responded_at
        ) VALUES (
          ${schoolId}, ${eventId}, ${studentId}, ${resolvedParentId}, ${status},
          ${Boolean(acknowledgements.medical_declaration_ack)},
          ${Boolean(acknowledgements.emergency_treatment_auth)},
          ${Boolean(acknowledgements.transportation_consent)},
          ${Boolean(acknowledgements.photography_media_consent)},
          ${Boolean(acknowledgements.rules_instructions_ack)},
          ${remarks}, ${ipAddress}, ${userAgent}, now()
        )
        ON CONFLICT (event_id, student_id) DO UPDATE SET
          status = EXCLUDED.status,
          consent_version = event_consents.consent_version + 1,
          medical_declaration_ack = EXCLUDED.medical_declaration_ack,
          emergency_treatment_auth = EXCLUDED.emergency_treatment_auth,
          transportation_consent = EXCLUDED.transportation_consent,
          photography_media_consent = EXCLUDED.photography_media_consent,
          rules_instructions_ack = EXCLUDED.rules_instructions_ack,
          parent_remarks = EXCLUDED.parent_remarks,
          ip_address = EXCLUDED.ip_address,
          user_agent = EXCLUDED.user_agent,
          responded_at = now(),
          updated_at = now()
        RETURNING *
      `;

      await EventEngineService.logAudit({
        schoolId,
        eventId,
        actorUserId: userId,
        action: `PARENT_CONSENT_${status}`,
        entityType: 'EVENT_CONSENT',
        entityId: consent.id,
        newState: { status, studentId, parentId },
        details: `Parent submitted consent: ${status}`,
      }, tx);

      await EventEngineService.calculateReadinessScore(schoolId, eventId, tx);

      return consent;
    });
  },

  /**
   * Get consent summary (total eligible, consented, declined, pending)
   */
  async getConsentSummary({ schoolId, eventId }) {
    const stats = await sql`
      SELECT 
        count(*)::int as total_registered,
        count(*) FILTER (WHERE c.status = 'CONSENTED')::int as consented_count,
        count(*) FILTER (WHERE c.status = 'DECLINED')::int as declined_count,
        count(*) FILTER (WHERE c.status IS NULL OR c.status = 'PENDING')::int as pending_count
      FROM event_registrations r
      LEFT JOIN event_consents c ON c.event_id = r.event_id AND c.student_id = r.student_id
      WHERE r.event_id = ${eventId} 
        AND r.school_id = ${schoolId} 
        AND r.participant_type = 'STUDENT'
        AND r.registration_status != 'CANCELLED'
        AND r.deleted_at IS NULL
    `;

    const summary = stats[0] || { total_registered: 0, consented_count: 0, declined_count: 0, pending_count: 0 };
    const consentPercentage = summary.total_registered > 0
      ? Number(((summary.consented_count / summary.total_registered) * 100).toFixed(1))
      : 0;

    return {
      ...summary,
      consent_percentage: consentPercentage,
    };
  },

  /**
   * List detailed student consent roster
   */
  async listConsentRoster({ schoolId, eventId, filter = null }) {
    return await sql`
      SELECT 
        r.id as registration_id,
        r.student_id,
        p.display_name as student_name,
        s.admission_no,
        cls.name as class_name,
        sec.name as section_name,
        parent_p.display_name as parent_name,
        parent_contact.contact_value as parent_phone,
        COALESCE(c.status, 'PENDING') as consent_status,
        c.responded_at,
        c.medical_declaration_ack,
        c.emergency_treatment_auth,
        c.transportation_consent,
        c.photography_media_consent,
        c.parent_remarks
      FROM event_registrations r
      JOIN students s ON r.student_id = s.id
      JOIN persons p ON s.person_id = p.id
      LEFT JOIN student_enrollments se ON se.student_id = s.id AND se.school_id = ${schoolId} AND se.status = 'active' AND se.deleted_at IS NULL
      LEFT JOIN class_sections cs ON cs.id = se.class_section_id
      LEFT JOIN classes cls ON cls.id = cs.class_id
      LEFT JOIN sections sec ON sec.id = cs.section_id
      LEFT JOIN student_parents sp ON sp.student_id = s.id
      LEFT JOIN parents par ON sp.parent_id = par.id
      LEFT JOIN persons parent_p ON par.person_id = parent_p.id
      LEFT JOIN person_contacts parent_contact ON parent_contact.person_id = parent_p.id AND parent_contact.contact_type = 'phone'
      LEFT JOIN event_consents c ON c.event_id = r.event_id AND c.student_id = r.student_id
      WHERE r.event_id = ${eventId} 
        AND r.school_id = ${schoolId}
        AND r.participant_type = 'STUDENT'
        AND r.registration_status != 'CANCELLED'
        AND r.deleted_at IS NULL
        ${filter ? sql`AND COALESCE(c.status, 'PENDING') = ${filter}` : sql``}
      ORDER BY cls.name, sec.name, p.display_name
    `;
  },

  /**
   * Send push/in-app reminders to all pending parents
   */
  async sendConsentReminders({ schoolId, eventId, userId }) {
    const [event] = await sql`
      SELECT id, title, start_date FROM events
      WHERE id = ${eventId} AND school_id = ${schoolId} AND deleted_at IS NULL
    `;
    if (!event) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    // Find parent user IDs for all pending students
    const pendingParents = await sql`
      SELECT DISTINCT parent_user.id as user_id
      FROM event_registrations r
      JOIN student_parents sp ON sp.student_id = r.student_id
      JOIN parents par ON sp.parent_id = par.id
      JOIN users parent_user ON parent_user.person_id = par.person_id
      LEFT JOIN event_consents c ON c.event_id = r.event_id AND c.student_id = r.student_id
      WHERE r.event_id = ${eventId}
        AND r.school_id = ${schoolId}
        AND r.registration_status != 'CANCELLED'
        AND (c.status IS NULL OR c.status = 'PENDING')
        AND parent_user.deleted_at IS NULL
    `;

    const userIds = pendingParents.map((p) => p.user_id).filter(Boolean);
    if (userIds.length > 0) {
      try {
        await sendNotificationToUsers(userIds, 'EVENT_CONSENT_PENDING', {
          title: `Action Required: Event Consent for ${event.title}`,
          message: `Please review and provide digital consent for the upcoming event on ${event.start_date}.`,
          eventId: event.id,
        }, { schoolId });
      } catch (err) {
        logger.warn({ err: err.message, eventId }, 'Failed to send consent reminder notifications');
      }
    }

    await EventEngineService.logAudit({
      schoolId,
      eventId,
      actorUserId: userId,
      action: 'CONSENT_REMINDERS_SENT',
      entityType: 'EVENT_CONSENT',
      entityId: eventId,
      details: `Dispatched consent reminders to ${userIds.length} parents`,
    });

    return { sent_count: userIds.length };
  }
};

export default EventConsentService;
