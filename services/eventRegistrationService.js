import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';
import { EventPassService } from './eventPassService.js';
import { isModuleEnabled, pickField } from './eventModuleUtils.js';

export const EventRegistrationService = {
  /**
   * Register a participant (student, staff, parent, or external guest)
   */
  async registerParticipant({ schoolId, eventId, data, userId }) {
    const {
      participant_type = 'STUDENT',
      parent_id = null,
      external_name = null,
      external_contact = null,
      external_organization = null,
      selected_activities = [],
      notes = null,
    } = data;
    const student_id = pickField(data, 'student_id', 'studentId') || null;

    const [event] = await sql`
      SELECT id, status, configuration, start_date, end_date, registration_deadline
      FROM events
      WHERE id = ${eventId} AND school_id = ${schoolId} AND deleted_at IS NULL
    `;
    if (!event) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    if (['CANCELLED', 'CLOSED', 'DRAFT', 'AWAITING_APPROVAL'].includes(event.status)) {
      const err = new Error('Registration is not open for this event');
      err.statusCode = 400;
      throw err;
    }

    if (event.registration_deadline && new Date(event.registration_deadline) < new Date()) {
      const err = new Error('Registration deadline has passed');
      err.statusCode = 400;
      throw err;
    }

    const constraints = event.configuration?.constraints || {};
    const maxActivities = constraints.max_activities_per_student || 3;
    const capacityLimit = constraints.capacity_limit || null;

    if (Array.isArray(selected_activities) && selected_activities.length > maxActivities) {
      const err = new Error(`Cannot select more than ${maxActivities} activities`);
      err.statusCode = 400;
      throw err;
    }

    // Check if already registered
    if (student_id) {
      const [existing] = await sql`
        SELECT id, registration_status FROM event_registrations
        WHERE event_id = ${eventId} AND student_id = ${student_id} AND deleted_at IS NULL
      `;
      if (existing) {
        if (existing.registration_status !== 'CANCELLED') {
          const err = new Error('Student is already registered for this event');
          err.statusCode = 409;
          throw err;
        }
      }
    }

    return await sql.begin(async (tx) => {
      // Check current active count against capacity limit
      let registration_status = 'REGISTERED';
      let waitlist_position = null;

      if (capacityLimit) {
        const [activeCount] = await tx`
          SELECT count(*)::int as count FROM event_registrations
          WHERE event_id = ${eventId} AND school_id = ${schoolId} AND registration_status = 'REGISTERED' AND deleted_at IS NULL
        `;
        if (activeCount.count >= capacityLimit) {
          registration_status = 'WAITLISTED';
          const [waitlistCount] = await tx`
            SELECT count(*)::int as count FROM event_registrations
            WHERE event_id = ${eventId} AND school_id = ${schoolId} AND registration_status = 'WAITLISTED' AND deleted_at IS NULL
          `;
          waitlist_position = waitlistCount.count + 1;
        }
      }

      const [reg] = await tx`
        INSERT INTO event_registrations (
          school_id, event_id, participant_type, student_id, user_id, parent_id,
          external_name, external_contact, external_organization, selected_activities,
          registration_status, waitlist_position, notes
        ) VALUES (
          ${schoolId}, ${eventId}, ${participant_type}, ${student_id}, ${userId || null},
          ${parent_id || null}, ${external_name}, ${external_contact},
          ${external_organization}, ${sql.json(selected_activities)},
          ${registration_status}, ${waitlist_position}, ${notes}
        )
        RETURNING *
      `;

      // Auto-generate Event Pass if configured
      if (isModuleEnabled(event.configuration, 'qr_passes') && registration_status === 'REGISTERED') {
        await EventPassService.generatePassForRegistration({
          schoolId,
          eventId,
          registrationId: reg.id,
          attendeeType: participant_type,
          studentId: student_id,
          userId: userId || null,
          guestName: external_name,
          guestPhone: external_contact,
          validFrom: `${event.start_date}T00:00:00Z`,
          validUntil: `${event.end_date || event.start_date}T23:59:59Z`,
        }, tx);
      }

      await EventEngineService.logAudit({
        schoolId,
        eventId,
        actorUserId: userId,
        action: 'PARTICIPANT_REGISTERED',
        entityType: 'EVENT_REGISTRATION',
        entityId: reg.id,
        newState: { participant_type, student_id, registration_status },
        details: `Participant registered (${registration_status})`,
      }, tx);

      await EventEngineService.calculateReadinessScore(schoolId, eventId, tx);

      return reg;
    });
  },

  /**
   * List all registrations with participant details and class/section info
   */
  async listRegistrations({ schoolId, eventId, filters = {} }) {
    const { status, participant_type, search, class_id, section_id } = filters;

    return await sql`
      SELECT 
        r.*,
        p.display_name as student_name,
        s.admission_no as student_admission_no,
        cls.name as class_name,
        sec.name as section_name,
        parent_p.display_name as parent_name,
        parent_p.id as parent_person_id,
        pass.pass_code,
        pass.status as pass_status,
        c.status as consent_status,
        pay.status as payment_status
      FROM event_registrations r
      LEFT JOIN students s ON r.student_id = s.id
      LEFT JOIN persons p ON s.person_id = p.id
      LEFT JOIN student_enrollments se ON se.student_id = s.id AND se.school_id = ${schoolId} AND se.status = 'active' AND se.deleted_at IS NULL
      LEFT JOIN class_sections cs ON cs.id = se.class_section_id
      LEFT JOIN classes cls ON cls.id = cs.class_id
      LEFT JOIN sections sec ON sec.id = cs.section_id
      LEFT JOIN parents par ON r.parent_id = par.id
      LEFT JOIN persons parent_p ON par.person_id = parent_p.id
      LEFT JOIN event_passes pass ON pass.registration_id = r.id
      LEFT JOIN event_consents c ON c.event_id = r.event_id AND c.student_id = r.student_id
      LEFT JOIN event_payments pay ON pay.event_id = r.event_id AND (pay.student_id = r.student_id OR pay.registration_id = r.id)
      WHERE r.event_id = ${eventId} AND r.school_id = ${schoolId} AND r.deleted_at IS NULL
        ${status ? sql`AND r.registration_status = ${status}` : sql``}
        ${participant_type ? sql`AND r.participant_type = ${participant_type}` : sql``}
        ${class_id ? sql`AND cls.id::text = ${class_id}` : sql``}
        ${section_id ? sql`AND sec.id::text = ${section_id}` : sql``}
        ${search ? sql`AND (p.display_name ILIKE ${'%' + search + '%'} OR s.admission_no ILIKE ${'%' + search + '%'} OR r.external_name ILIKE ${'%' + search + '%'})` : sql``}
      ORDER BY r.registered_at DESC
    `;
  },

  /**
   * Cancel a registration and promote from waitlist if applicable
   */
  async cancelRegistration({ schoolId, eventId, registrationId, userId }) {
    return await sql.begin(async (tx) => {
      const [reg] = await tx`
        SELECT * FROM event_registrations
        WHERE id = ${registrationId} AND event_id = ${eventId} AND school_id = ${schoolId} AND deleted_at IS NULL
      `;
      if (!reg) {
        const err = new Error('Registration not found');
        err.statusCode = 404;
        throw err;
      }

      await tx`
        UPDATE event_registrations
        SET registration_status = 'CANCELLED', cancelled_at = now(), updated_at = now()
        WHERE id = ${registrationId}
      `;

      // Revoke pass if issued
      await tx`
        UPDATE event_passes
        SET status = 'REVOKED', revoked_at = now(), revocation_reason = 'Registration cancelled'
        WHERE registration_id = ${registrationId}
      `;

      // Check if someone from waitlist can be promoted
      const [nextWaitlisted] = await tx`
        SELECT id FROM event_registrations
        WHERE event_id = ${eventId} AND school_id = ${schoolId} AND registration_status = 'WAITLISTED' AND deleted_at IS NULL
        ORDER BY waitlist_position ASC NULLS LAST, registered_at ASC
        LIMIT 1
      `;
      if (nextWaitlisted) {
        await tx`
          UPDATE event_registrations
          SET registration_status = 'REGISTERED', waitlist_position = null, updated_at = now()
          WHERE id = ${nextWaitlisted.id}
        `;
      }

      await EventEngineService.logAudit({
        schoolId,
        eventId,
        actorUserId: userId,
        action: 'REGISTRATION_CANCELLED',
        entityType: 'EVENT_REGISTRATION',
        entityId: registrationId,
        details: 'Registration cancelled',
      }, tx);

      await EventEngineService.calculateReadinessScore(schoolId, eventId, tx);

      return { success: true, message: 'Registration cancelled successfully' };
    });
  },

  async promoteWaitlisted({ schoolId, eventId, studentId = null, registrationId = null, userId }) {
    const [reg] = await sql`
      SELECT * FROM event_registrations
      WHERE event_id = ${eventId} AND school_id = ${schoolId} AND deleted_at IS NULL
        AND registration_status = 'WAITLISTED'
        ${registrationId ? sql`AND id = ${registrationId}` : sql``}
        ${studentId ? sql`AND student_id = ${studentId}` : sql``}
      ORDER BY waitlist_position ASC NULLS LAST, registered_at ASC
      LIMIT 1
    `;
    if (!reg) {
      const err = new Error('Waitlisted registration not found');
      err.statusCode = 404;
      throw err;
    }

    const [updated] = await sql`
      UPDATE event_registrations
      SET registration_status = 'REGISTERED', waitlist_position = null, updated_at = now()
      WHERE id = ${reg.id}
      RETURNING *
    `;

    const [event] = await sql`SELECT configuration, start_date, end_date FROM events WHERE id = ${eventId}`;
    if (isModuleEnabled(event?.configuration, 'qr_passes')) {
      await EventPassService.generatePassForRegistration({
        schoolId,
        eventId,
        registrationId: updated.id,
        attendeeType: updated.participant_type,
        studentId: updated.student_id,
        userId: userId || null,
        guestName: updated.external_name,
        guestPhone: updated.external_contact,
        validFrom: `${event.start_date}T00:00:00Z`,
        validUntil: `${event.end_date || event.start_date}T23:59:59Z`,
      });
    }

    await EventEngineService.logAudit({
      schoolId,
      eventId,
      actorUserId: userId,
      action: 'WAITLIST_PROMOTED',
      entityType: 'EVENT_REGISTRATION',
      entityId: updated.id,
    });

    return updated;
  },
};

export default EventRegistrationService;
