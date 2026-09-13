import sql from '../db.js';
import { sendNotificationToUsers } from './notificationService.js';
import logger from '../utils/logger.js';

/**
 * Resolve target user IDs for a calendar event based on its audience targets.
 */
export async function resolveTargetUserIds(schoolId, eventId, tx = sql) {
  const numericSchoolId = Number(schoolId);
  const targets = await tx`
    SELECT target_type, target_id
    FROM calendar_event_targets
    WHERE school_id = ${numericSchoolId} AND event_id = ${eventId}
  `;

  if (!targets || targets.length === 0) {
    // Default to all school users if no targets specified
    const users = await tx`
      SELECT id FROM users
      WHERE school_id = ${numericSchoolId} AND deleted_at IS NULL
    `;
    return users.map((u) => u.id);
  }

  const userIdsSet = new Set();

  for (const t of targets) {
    if (t.target_type === 'ENTIRE_SCHOOL') {
      const allUsers = await tx`
        SELECT id FROM users
        WHERE school_id = ${numericSchoolId} AND deleted_at IS NULL
      `;
      allUsers.forEach((u) => userIdsSet.add(u.id));
      break; // Entire school covers all
    } else if (t.target_type === 'ROLE') {
      const roleUsers = await tx`
        SELECT u.id
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN roles r ON r.id = ur.role_id
        WHERE u.school_id = ${numericSchoolId}
          AND r.code = ${t.target_id}
          AND u.deleted_at IS NULL
      `;
      roleUsers.forEach((u) => userIdsSet.add(u.id));
    } else if (t.target_type === 'CLASS') {
      // Find students in this class and their parents
      const classUsers = await tx`
        SELECT DISTINCT u.id
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN students s ON se.student_id = s.id
        JOIN users u ON (u.person_id = s.person_id)
        WHERE se.school_id = ${numericSchoolId}
          AND cs.class_id::text = ${String(t.target_id)}
          AND se.status = 'active'
          AND se.deleted_at IS NULL
          AND u.deleted_at IS NULL
      `;
      classUsers.forEach((u) => userIdsSet.add(u.id));

      // Also include parents of these students
      const parentUsers = await tx`
        SELECT DISTINCT u.id
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN student_parents sp ON sp.student_id = se.student_id
        JOIN parents p ON sp.parent_id = p.id
        JOIN users u ON u.person_id = p.person_id
        WHERE se.school_id = ${numericSchoolId}
          AND cs.class_id::text = ${String(t.target_id)}
          AND se.status = 'active'
          AND se.deleted_at IS NULL
          AND u.deleted_at IS NULL
      `;
      parentUsers.forEach((u) => userIdsSet.add(u.id));
    } else if (t.target_type === 'SECTION') {
      // Find students in this section and their parents
      const sectionUsers = await tx`
        SELECT DISTINCT u.id
        FROM student_enrollments se
        JOIN students s ON se.student_id = s.id
        JOIN users u ON (u.person_id = s.person_id)
        WHERE se.school_id = ${numericSchoolId}
          AND se.class_section_id::text = ${String(t.target_id)}
          AND se.status = 'active'
          AND se.deleted_at IS NULL
          AND u.deleted_at IS NULL
      `;
      sectionUsers.forEach((u) => userIdsSet.add(u.id));

      const parentUsers = await tx`
        SELECT DISTINCT u.id
        FROM student_enrollments se
        JOIN student_parents sp ON sp.student_id = se.student_id
        JOIN parents p ON sp.parent_id = p.id
        JOIN users u ON u.person_id = p.person_id
        WHERE se.school_id = ${numericSchoolId}
          AND se.class_section_id::text = ${String(t.target_id)}
          AND se.status = 'active'
          AND se.deleted_at IS NULL
          AND u.deleted_at IS NULL
      `;
      parentUsers.forEach((u) => userIdsSet.add(u.id));
    } else if (t.target_type === 'USER') {
      userIdsSet.add(t.target_id);
    } else if (t.target_type === 'STUDENT') {
      const studentAndParents = await tx`
        SELECT DISTINCT u.id
        FROM students s
        LEFT JOIN users u ON u.person_id = s.person_id
        WHERE s.id::text = ${String(t.target_id)} AND s.school_id = ${numericSchoolId}
        UNION
        SELECT DISTINCT u.id
        FROM student_parents sp
        JOIN parents p ON sp.parent_id = p.id
        JOIN users u ON u.person_id = p.person_id
        WHERE sp.student_id::text = ${String(t.target_id)} AND p.school_id = ${numericSchoolId}
      `;
      studentAndParents.forEach((u) => {
        if (u.id) userIdsSet.add(u.id);
      });
    }
  }

  return [...userIdsSet];
}

/**
 * Format a human-readable date and time range.
 */
function formatEventDate(event) {
  const datePart = event.start_date;
  if (event.is_all_day) return datePart;
  const start = event.start_datetime ? new Date(event.start_datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const end = event.end_datetime ? new Date(event.end_datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return start && end ? `${datePart} (${start} - ${end})` : `${datePart} ${start}`.trim();
}

/**
 * Send notification when an event is published.
 */
export async function notifyEventPublished(schoolId, event) {
  try {
    const userIds = await resolveTargetUserIds(schoolId, event.id);
    if (!userIds || userIds.length === 0) return;

    const isHoliday = event.event_type === 'HOLIDAY' || event.event_type === 'VACATION' || Boolean(event.holiday_type);

    if (isHoliday) {
      const message = `${event.title} on ${event.start_date}${event.end_date && event.end_date !== event.start_date ? ` to ${event.end_date}` : ''}.${event.description ? ` ${event.description}` : ''}`;
      await sendNotificationToUsers(userIds, 'HOLIDAY_ANNOUNCED', {
        message,
      }, {
        schoolId,
        deepLink: `/Screen/calendar?eventId=${event.id}`,
      });
    } else {
      const formattedTime = formatEventDate(event);
      const message = `${formattedTime}${event.location ? ` @ ${event.location}` : ''}.${event.description ? ` ${event.description}` : ''}`;
      await sendNotificationToUsers(userIds, 'CALENDAR_EVENT_PUBLISHED', {
        title: event.title,
        message,
      }, {
        schoolId,
        deepLink: `/Screen/calendar?eventId=${event.id}`,
      });
    }
  } catch (err) {
    logger.error({ err, eventId: event.id, schoolId }, 'calendar_notification_publish_failed');
  }
}

/**
 * Send notification when an event is updated/rescheduled with detailed diffs.
 */
export async function notifyEventUpdated(schoolId, event, oldEvent) {
  try {
    const userIds = await resolveTargetUserIds(schoolId, event.id);
    if (!userIds || userIds.length === 0) return;

    // Detect what changed
    const changes = [];
    if (oldEvent.start_date !== event.start_date || oldEvent.start_datetime !== event.start_datetime) {
      const oldTime = formatEventDate(oldEvent);
      const newTime = formatEventDate(event);
      changes.push(`Schedule moved from ${oldTime} to ${newTime}`);
    }
    if (oldEvent.location !== event.location && (oldEvent.location || event.location)) {
      changes.push(`Location changed to ${event.location || 'unspecified'}`);
    }
    if (oldEvent.title !== event.title) {
      changes.push(`Title updated from "${oldEvent.title}" to "${event.title}"`);
    }

    if (changes.length === 0) {
      changes.push(`Details updated for ${event.title}`);
    }

    const diffMessage = `${changes.join('. ')}.`;

    await sendNotificationToUsers(userIds, 'CALENDAR_EVENT_UPDATED', {
      title: event.title,
      message: diffMessage,
    }, {
      schoolId,
      deepLink: `/Screen/calendar?eventId=${event.id}`,
    });
  } catch (err) {
    logger.error({ err, eventId: event.id, schoolId }, 'calendar_notification_update_failed');
  }
}

/**
 * Send notification when an event is cancelled.
 */
export async function notifyEventCancelled(schoolId, event, reason) {
  try {
    const userIds = await resolveTargetUserIds(schoolId, event.id);
    if (!userIds || userIds.length === 0) return;

    const message = `The event scheduled for ${event.start_date} has been cancelled.${reason ? ` Reason: ${reason}` : ''}`;

    await sendNotificationToUsers(userIds, 'CALENDAR_EVENT_CANCELLED', {
      title: event.title,
      message,
    }, {
      schoolId,
      deepLink: `/Screen/calendar?eventId=${event.id}`,
    });
  } catch (err) {
    logger.error({ err, eventId: event.id, schoolId }, 'calendar_notification_cancel_failed');
  }
}

/**
 * Process pending event reminders whose remind_at <= now().
 */
export async function processPendingReminders() {
  try {
    const pending = await sql`
      SELECT 
        r.id as reminder_id, r.school_id, r.event_id, r.remind_at,
        e.title, e.description, e.start_date, e.start_datetime, e.end_datetime,
        e.is_all_day, e.location, e.status
      FROM calendar_event_reminders r
      JOIN calendar_events e ON r.event_id = e.id
      WHERE r.status = 'PENDING'
        AND r.remind_at <= now()
        AND e.status = 'PUBLISHED'
        AND e.deleted_at IS NULL
      LIMIT 100
    `;

    for (const item of pending) {
      try {
        const userIds = await resolveTargetUserIds(item.school_id, item.event_id);
        if (userIds && userIds.length > 0) {
          const formattedTime = formatEventDate(item);
          const message = `Upcoming: ${formattedTime}${item.location ? ` at ${item.location}` : ''}.`;
          await sendNotificationToUsers(userIds, 'CALENDAR_EVENT_REMINDER', {
            title: item.title,
            message,
          }, {
            schoolId: item.school_id,
            deepLink: `/Screen/calendar?eventId=${event.id}`,
          });
        }

        await sql`
          UPDATE calendar_event_reminders
          SET status = 'SENT', sent_at = now(), updated_at = now()
          WHERE id = ${item.reminder_id}
        `;
      } catch (err) {
        logger.error({ err, reminderId: item.reminder_id }, 'calendar_reminder_dispatch_failed');
        await sql`
          UPDATE calendar_event_reminders
          SET 
            attempts = attempts + 1,
            failure_reason = ${err.message || 'Dispatch error'},
            status = CASE WHEN attempts + 1 >= 3 THEN 'FAILED' ELSE 'PENDING' END,
            updated_at = now()
          WHERE id = ${item.reminder_id}
        `;
      }
    }
  } catch (err) {
    logger.error({ err }, 'process_pending_reminders_failed');
  }
}

let reminderTimer = null;

/**
 * Starts background worker for processing scheduled calendar event reminders.
 */
export function startCalendarReminderWorker() {
  if (reminderTimer) return;

  // Initial check shortly after startup
  setTimeout(() => {
    processPendingReminders().catch((err) => {
      logger.error({ err }, 'calendar_initial_reminders_failed');
    });
  }, 5000);

  reminderTimer = setInterval(() => {
    processPendingReminders().catch((err) => {
      logger.error({ err }, 'calendar_interval_reminders_failed');
    });
  }, 60 * 1000);

  if (typeof reminderTimer.unref === 'function') {
    reminderTimer.unref();
  }
}

/**
 * Stops the calendar reminder worker.
 */
export function stopCalendarReminderWorker() {
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }
}

