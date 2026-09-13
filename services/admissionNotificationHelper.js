import sql from '../db.js';
import { sendNotificationToUsers } from './notificationService.js';
import logger from '../utils/logger.js';
import { renderTemplate, claimIdempotency } from './admissionHelpers.js';

/**
 * Dispatch an admission notification to applicant or staff and record into communication log.
 */
export async function sendAdmissionNotification({
  schoolId,
  applicationId,
  recipientUserId = null,
  recipientPhone = null,
  recipientEmail = null,
  type,
  params = {},
  subject,
  message,
}) {
  try {
    const eventKey = `${type}:${applicationId || 'none'}:${recipientUserId || 'none'}:${subject || ''}`;
    let claimed = true;
    try {
      claimed = await claimIdempotency(schoolId, `notify:${eventKey}`, type, applicationId);
    } catch {
      claimed = true;
    }
    if (!claimed) return;

    let finalSubject = subject || 'Admission Notification';
    let finalMessage = message;
    try {
      const [tpl] = await sql`
        SELECT subject_template, body_template FROM admission_notification_templates
        WHERE school_id = ${schoolId} AND event_type = ${type} AND is_active = true
        LIMIT 1
      `;
      if (tpl) {
        finalSubject = renderTemplate(tpl.subject_template, params) || finalSubject;
        finalMessage = renderTemplate(tpl.body_template, params) || finalMessage;
      }
    } catch {
      // templates table is optional until hardening migration is applied
    }

    if (applicationId) {
      await sql`
        INSERT INTO admission_communications (
          school_id, application_id, sender_type, message_type,
          subject, message, channels
        )
        VALUES (
          ${schoolId}, ${applicationId}, 'SYSTEM', ${type},
          ${finalSubject}, ${finalMessage || ''},
          ARRAY['IN_APP', 'PUSH']
        )
      `;
    }

    if (recipientUserId) {
      await sendNotificationToUsers([recipientUserId], type, params, { schoolId });
    }
  } catch (err) {
    logger.warn({ err: err.message, type, applicationId }, 'Failed to dispatch admission notification');
  }
}
