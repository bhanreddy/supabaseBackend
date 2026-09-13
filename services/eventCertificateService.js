import crypto from 'node:crypto';
import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';

export const EventCertificateService = {
  /**
   * Issue an individual certificate
   */
  async issueCertificate({
    schoolId,
    eventId,
    recipientType = 'STUDENT',
    studentId = null,
    userId = null,
    recipientName,
    certificateType = 'PARTICIPATION',
    competitionTitle = null,
    positionTitle = null,
    signatoryTitle = 'Principal',
    templateConfig = { theme: 'gold', border: 'classic' },
  }, tx = sql) {
    const year = new Date().getFullYear();
    const randomSerialSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const serialNo = `EV-${year}-${randomSerialSuffix}`;
    const verificationToken = crypto.randomBytes(32).toString('hex');

    const [cert] = await tx`
      INSERT INTO event_certificates (
        school_id, event_id, recipient_type, student_id, user_id,
        recipient_name, certificate_type, competition_title, position_title,
        serial_no, verification_token, signatory_title, template_config
      ) VALUES (
        ${schoolId}, ${eventId}, ${recipientType}, ${studentId}, ${userId},
        ${recipientName}, ${certificateType}, ${competitionTitle}, ${positionTitle},
        ${serialNo}, ${verificationToken}, ${signatoryTitle}, ${sql.json(templateConfig)}
      )
      RETURNING *
    `;

    return cert;
  },

  /**
   * Bulk generate participation certificates for all attended participants
   */
  async bulkGenerateParticipationCertificates({ schoolId, eventId, userId }) {
    const [event] = await sql`
      SELECT id, title, start_date FROM events
      WHERE id = ${eventId} AND school_id = ${schoolId}
    `;
    if (!event) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    // Find all attended students who don't have a certificate yet
    const eligibleStudents = await sql`
      SELECT 
        a.student_id,
        p.display_name as student_name
      FROM event_attendance a
      JOIN students s ON a.student_id = s.id
      JOIN persons p ON s.person_id = p.id
      WHERE a.event_id = ${eventId}
        AND a.school_id = ${schoolId}
        AND a.status IN ('PRESENT', 'CHECKED_IN', 'ON_BUS', 'ARRIVED')
        AND NOT EXISTS (
          SELECT 1 FROM event_certificates c
          WHERE c.event_id = ${eventId} AND c.student_id = a.student_id
        )
    `;

    const generated = [];
    await sql.begin(async (tx) => {
      for (const stud of eligibleStudents) {
        const cert = await this.issueCertificate({
          schoolId,
          eventId,
          recipientType: 'STUDENT',
          studentId: stud.student_id,
          recipientName: stud.student_name,
          certificateType: 'PARTICIPATION',
          competitionTitle: event.title,
          positionTitle: 'Participant',
        }, tx);
        generated.push(cert);
      }

      await EventEngineService.logAudit({
        schoolId,
        eventId,
        actorUserId: userId,
        action: 'BULK_CERTIFICATES_GENERATED',
        entityType: 'EVENT_CERTIFICATE',
        entityId: eventId,
        details: `Generated ${generated.length} participation certificates`,
      }, tx);
    });

    return { generated_count: generated.length, certificates: generated };
  },

  /**
   * List certificates for an event or student
   */
  async listCertificates({ schoolId, eventId = null, studentId = null }) {
    return await sql`
      SELECT 
        c.*,
        e.title as event_title,
        e.start_date as event_date,
        s.admission_no as student_admission_no,
        cls.name as class_name,
        sec.name as section_name,
        sch.name as school_name
      FROM event_certificates c
      JOIN events e ON c.event_id = e.id
      JOIN schools sch ON c.school_id = sch.id
      LEFT JOIN students s ON c.student_id = s.id
      LEFT JOIN student_enrollments se ON se.student_id = s.id AND se.school_id = ${schoolId} AND se.status = 'active' AND se.deleted_at IS NULL
      LEFT JOIN class_sections cs ON cs.id = se.class_section_id
      LEFT JOIN classes cls ON cls.id = cs.class_id
      LEFT JOIN sections sec ON sec.id = cs.section_id
      WHERE c.school_id = ${schoolId}
        ${eventId ? sql`AND c.event_id = ${eventId}` : sql``}
        ${studentId ? sql`AND c.student_id = ${studentId}` : sql``}
      ORDER BY c.issued_at DESC
    `;
  },

  /**
   * Public verification by token or serial_no
   */
  async verifyCertificate(tokenOrSerial) {
    if (!tokenOrSerial || typeof tokenOrSerial !== 'string') {
      return { isValid: false, message: 'Missing certificate token or serial' };
    }

    const clean = String(tokenOrSerial).trim();

    const [cert] = await sql`
      SELECT 
        c.*,
        e.title as event_title,
        e.start_date as event_date,
        e.location as event_location,
        sch.name as school_name,
        s.admission_no as student_admission_no
      FROM event_certificates c
      JOIN events e ON c.event_id = e.id
      JOIN schools sch ON c.school_id = sch.id
      LEFT JOIN students s ON c.student_id = s.id
      WHERE c.verification_token = ${clean} OR c.serial_no = ${clean}
      LIMIT 1
    `;

    if (!cert) {
      return { isValid: false, message: 'Certificate record not found or invalid' };
    }

    return {
      isValid: cert.status === 'VALID',
      status: cert.status,
      certificate: {
        id: cert.id,
        serial_no: cert.serial_no,
        recipient_name: cert.recipient_name,
        certificate_type: cert.certificate_type,
        competition_title: cert.competition_title,
        position_title: cert.position_title,
        event_title: cert.event_title,
        event_date: cert.event_date,
        school_name: cert.school_name,
        issued_at: cert.issued_at,
        signatory_title: cert.signatory_title,
        status: cert.status,
        revocation_reason: cert.revocation_reason,
      },
    };
  }
};

export default EventCertificateService;
