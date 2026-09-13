import sql from '../db.js';
import logger from '../utils/logger.js';
import { scanAndFlagSlaBreaches } from './admissionTaskService.js';
import { sendAdmissionNotification } from './admissionNotificationHelper.js';
import { claimIdempotency, getStaffUserIdsByRoles } from './admissionHelpers.js';

export const ADMISSION_SLA_JOB_NAME = 'admission-sla-scan';

async function sendOnce({ schoolId, key, action, entityId, payload }) {
  const claimed = await claimIdempotency(schoolId, key, action, entityId);
  if (!claimed) return false;
  await sendAdmissionNotification(payload);
  return true;
}

/**
 * Hourly admission SLA: flag breaches, remind applicants, escalate overdue tasks.
 * Never auto-approves or auto-converts.
 */
export async function runAdmissionSlaScan() {
  const schools = await sql`SELECT id FROM schools WHERE is_active = true ORDER BY id`;
  const summary = { schools: 0, breachedApps: 0, reminders: 0, escalations: 0 };

  for (const school of schools) {
    const schoolId = school.id;
    try {
      const [settings] = await sql`
        SELECT max_applicant_reminders, reminder_interval_hours
        FROM admission_settings WHERE school_id = ${schoolId}
      `;
      const maxReminders = Number(settings?.max_applicant_reminders || 3);
      const intervalHours = Number(settings?.reminder_interval_hours || 24);

      const breaches = await scanAndFlagSlaBreaches(schoolId);
      summary.breachedApps += Number(breaches.breachedAppsCount || 0);
      summary.schools += 1;

      const managers = await getStaffUserIdsByRoles(schoolId, ['admin', 'principal']);

      for (const app of breaches.breachedApps || []) {
        for (const userId of managers) {
          await sendOnce({
            schoolId,
            key: `sla-breach:${app.id}:${app.sla_due_at}`,
            action: 'SLA_BREACH',
            entityId: app.id,
            payload: {
              schoolId,
              applicationId: app.id,
              recipientUserId: userId,
              type: 'ADMISSION_SLA_BREACH',
              params: { application_no: app.application_no },
              subject: `SLA breached: ${app.application_no}`,
              message: `Application ${app.application_no} is overdue for action.`,
            },
          });
        }
      }

      for (const task of breaches.breachedTasks || []) {
        await sql`
          UPDATE admission_tasks
          SET status = CASE WHEN status = 'PENDING' THEN 'ESCALATED' ELSE status END,
              escalated_at = COALESCE(escalated_at, now()),
              updated_at = now()
          WHERE id = ${task.id} AND school_id = ${schoolId} AND status IN ('PENDING', 'IN_PROGRESS')
        `;
        summary.escalations += 1;
      }

      const reminderCandidates = await sql`
        SELECT id, application_no, applicant_user_id, status, reminder_count, last_reminder_at
        FROM admission_applications
        WHERE school_id = ${schoolId}
          AND deleted_at IS NULL
          AND applicant_user_id IS NOT NULL
          AND status IN (
            'APPLICATION_STARTED', 'APPLICATION_INCOMPLETE', 'DOCUMENT_COLLECTION',
            'VERIFICATION_REQUIRED', 'FEE_PENDING', 'CONDITIONALLY_APPROVED'
          )
          AND reminder_count < ${maxReminders}
          AND (last_reminder_at IS NULL OR last_reminder_at < now() - make_interval(hours => ${intervalHours}))
        LIMIT 200
      `;

      for (const app of reminderCandidates) {
        const sent = await sendOnce({
          schoolId,
          key: `applicant-reminder:${app.id}:${app.reminder_count + 1}`,
          action: 'APPLICANT_REMINDER',
          entityId: app.id,
          payload: {
            schoolId,
            applicationId: app.id,
            recipientUserId: app.applicant_user_id,
            type: 'ADMISSION_REMINDER',
            params: { application_no: app.application_no, status: app.status },
            subject: `Reminder: Admission application ${app.application_no}`,
            message: `Your admission application ${app.application_no} still needs action. Current status: ${app.status}. Please log in to complete the next step.`,
          },
        });
        if (sent) {
          await sql`
            UPDATE admission_applications
            SET reminder_count = reminder_count + 1,
                last_reminder_at = now(),
                last_reminder_type = ${app.status},
                updated_at = now()
            WHERE id = ${app.id} AND school_id = ${schoolId}
          `;
          summary.reminders += 1;
        }
      }

      const upcomingInterviews = await sql`
        SELECT i.id, i.scheduled_date, i.start_time, i.title, i.location,
               a.id as application_id, a.application_no, a.applicant_user_id
        FROM admission_interviews i
        JOIN admission_applications a ON a.id = i.application_id AND a.school_id = i.school_id
        WHERE i.school_id = ${schoolId}
          AND i.status = 'SCHEDULED'
          AND i.scheduled_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 1
          AND a.applicant_user_id IS NOT NULL
          AND a.deleted_at IS NULL
        LIMIT 200
      `;
      for (const iv of upcomingInterviews) {
        await sendOnce({
          schoolId,
          key: `interview-reminder:${iv.id}:${iv.scheduled_date}`,
          action: 'INTERVIEW_REMINDER',
          entityId: iv.application_id,
          payload: {
            schoolId,
            applicationId: iv.application_id,
            recipientUserId: iv.applicant_user_id,
            type: 'ADMISSION_INTERVIEW_SCHEDULED',
            params: { date: iv.scheduled_date, time: iv.start_time },
            subject: `Reminder: ${iv.title || 'Admission interaction'} tomorrow`,
            message: `Your admission interaction is scheduled on ${iv.scheduled_date} at ${iv.start_time} (${iv.location || 'School'}).`,
          },
        });
      }
    } catch (err) {
      logger.error({ err: err.message, schoolId }, 'Admission SLA scan failed for school');
    }
  }

  logger.info(summary, 'Admission SLA scan completed');
  return summary;
}
