import sql from '../db.js';
import { formatYMD } from './workingDayResolver.js';
import {
  notifyEventPublished,
  notifyEventUpdated,
  notifyEventCancelled,
} from './calendarNotificationService.js';
import {
  canonicalizeEventType,
  canonicalizeHolidayType,
  canonicalizePriority,
  isInstructionalEventType,
} from './calendarEventTypes.js';
import logger from '../utils/logger.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Parses a reminder schedule like '7d', '3d', '1d', '1h', '30m' into milliseconds.
 */
function parseReminderScheduleOffset(schedule) {
  const s = String(schedule || '').toLowerCase().trim();
  const num = parseInt(s, 10);
  if (isNaN(num)) return null;
  if (s.endsWith('d')) return num * 24 * 60 * 60 * 1000;
  if (s.endsWith('h')) return num * 60 * 60 * 1000;
  if (s.endsWith('m')) return num * 60 * 1000;
  return null;
}

/**
 * Normalizes event date objects into standard YYYY-MM-DD strings and parses JSON strings.
 */
function normalizeEventDates(event) {
  if (!event) return event;
  if (event.start_date) event.start_date = formatYMD(event.start_date);
  if (event.end_date) event.end_date = formatYMD(event.end_date);
  if (typeof event.reminder_schedules === 'string') {
    try {
      event.reminder_schedules = JSON.parse(event.reminder_schedules);
    } catch {
      event.reminder_schedules = [];
    }
  }
  if (typeof event.recurrence_rule === 'string') {
    try {
      event.recurrence_rule = JSON.parse(event.recurrence_rule);
    } catch {
      event.recurrence_rule = null;
    }
  }
  return event;
}

function extractClock(datetime) {
  if (!datetime) return null;
  const d = new Date(datetime);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Present a calendar event in both canonical and legacy frontend field names.
 */
export function presentCalendarEvent(event) {
  if (!event) return event;
  const e = normalizeEventDates({ ...event });
  e.all_day = Boolean(e.is_all_day);
  e.is_holiday = e.event_type === 'HOLIDAY' || e.event_type === 'VACATION' || Boolean(e.holiday_type);
  e.is_working_day = e.event_type === 'SPECIAL_WORKING_DAY' || e.event_type === 'WORKING_DAY';
  e.affects_attendance = e.attendance_enabled === false;
  e.affects_timetable = e.timetable_enabled === false;
  e.timetable_day_override = e.copy_timetable_from_day;
  e.source_id = e.source_entity_id;
  e.start_time = e.start_time || extractClock(e.start_datetime);
  e.end_time = e.end_time || extractClock(e.end_datetime);
  return e;
}

function eachDateInclusive(start, end, onDate) {
  const cur = new Date(`${formatYMD(start)}T00:00:00Z`);
  const last = new Date(`${formatYMD(end)}T00:00:00Z`);
  while (cur <= last) {
    onDate(formatYMD(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

/**
 * Calculate scheduled reminder timestamps based on event start datetime.
 */
function computeReminderTimestamps(startDatetime, reminderSchedules = []) {
  const startTimeMs = new Date(startDatetime).getTime();
  const times = [];

  let list = reminderSchedules;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) list = [];

  for (const sched of list) {
    const offsetMs = parseReminderScheduleOffset(sched);
    if (offsetMs != null) {
      const remindMs = startTimeMs - offsetMs;
      // Only schedule if in future or within recent 5 minutes
      if (remindMs > Date.now() - 5 * 60 * 1000) {
        times.push(new Date(remindMs).toISOString());
      }
    }
  }

  return [...new Set(times)];
}

/**
 * Check if the school has calendar approval enabled.
 */
async function isApprovalRequired(schoolId) {
  const [row] = await sql`
    SELECT value FROM school_settings
    WHERE school_id = ${Number(schoolId)} AND key = 'calendar_approval_required'
  `;
  return row?.value === 'true';
}

/**
 * Expand occurrences of a recurring master event within a query date range [winStart, winEnd].
 * Pure function adhering to RRULE standard concepts (frequency, interval, days_of_week, by_set_pos, until, count, exceptions).
 */
export function expandRecurrenceOccurrences(masterEvent, windowStart, windowEnd) {
  let rule = masterEvent.recurrence_rule;
  if (typeof rule === 'string') {
    try {
      rule = JSON.parse(rule);
    } catch {
      rule = null;
    }
  }
  if (!rule || !rule.frequency) {
    return [masterEvent];
  }

  const occurrences = [];
  const freq = String(rule.frequency).toUpperCase();
  const interval = Math.max(1, parseInt(rule.interval || '1', 10));
  const until = rule.until ? formatYMD(rule.until) : null;
  const maxCount = rule.count ? parseInt(rule.count, 10) : 500;
  const exceptions = new Set(Array.isArray(rule.exceptions) ? rule.exceptions.map(formatYMD) : []);
  const daysOfWeek = Array.isArray(rule.days_of_week)
    ? rule.days_of_week.map((d) => String(d).toLowerCase().trim())
    : [];

  const masterStartStr = formatYMD(masterEvent.start_date);
  const masterEndStr = formatYMD(masterEvent.end_date || masterEvent.start_date);

  const masterStartObj = new Date(masterStartStr + 'T00:00:00Z');
  const masterEndObj = new Date(masterEndStr + 'T00:00:00Z');
  const durationDays = Math.max(0, Math.round((masterEndObj - masterStartObj) / (24 * 60 * 60 * 1000)));

  const winStart = formatYMD(windowStart);
  const winEnd = formatYMD(windowEnd);

  let cur = new Date(masterStartStr + 'T00:00:00Z');
  let count = 0;
  const maxIterations = 1000;
  let iteration = 0;

  while (iteration++ < maxIterations && count < maxCount) {
    const curYMD = formatYMD(cur);
    if (until && curYMD > until) break;
    if (curYMD > winEnd) break;

    const dayName = WEEKDAYS[cur.getUTCDay()];
    let matchesRule = false;

    if (freq === 'DAILY') {
      matchesRule = true;
    } else if (freq === 'WEEKLY') {
      if (daysOfWeek.length > 0) {
        matchesRule = daysOfWeek.includes(dayName);
      } else {
        matchesRule = true;
      }
    } else if (freq === 'MONTHLY') {
      if (Array.isArray(rule.by_month_day) && rule.by_month_day.length > 0) {
        matchesRule = rule.by_month_day.includes(cur.getUTCDate());
      } else if (rule.by_set_pos != null && daysOfWeek.length > 0) {
        const pos = parseInt(rule.by_set_pos, 10);
        if (daysOfWeek.includes(dayName)) {
          const weekNum = Math.ceil(cur.getUTCDate() / 7);
          matchesRule = weekNum === pos;
        }
      } else {
        matchesRule = cur.getUTCDate() === masterStartObj.getUTCDate();
      }
    } else if (freq === 'YEARLY') {
      matchesRule = cur.getUTCMonth() === masterStartObj.getUTCMonth() &&
                    cur.getUTCDate() === masterStartObj.getUTCDate();
    }

    if (matchesRule) {
      count++;
      if (curYMD >= winStart && curYMD <= winEnd && !exceptions.has(curYMD)) {
        const curEndObj = new Date(cur.getTime() + durationDays * 24 * 60 * 60 * 1000);
        const curEndYMD = formatYMD(curEndObj);

        const startTimePart = masterEvent.start_datetime ? new Date(masterEvent.start_datetime).toISOString().split('T')[1] : '00:00:00.000Z';
        const endTimePart = masterEvent.end_datetime ? new Date(masterEvent.end_datetime).toISOString().split('T')[1] : '23:59:59.000Z';

        occurrences.push({
          ...masterEvent,
          id: curYMD === masterStartStr ? masterEvent.id : `${masterEvent.id}_${curYMD}`,
          master_event_id: masterEvent.id,
          is_recurring_instance: true,
          start_date: curYMD,
          end_date: curEndYMD,
          start_datetime: `${curYMD}T${startTimePart}`,
          end_datetime: `${curEndYMD}T${endTimePart}`,
        });
      }
    }

    // Increment current date
    if (freq === 'DAILY') {
      cur.setUTCDate(cur.getUTCDate() + interval);
    } else if (freq === 'WEEKLY') {
      if (daysOfWeek.length > 0) {
        cur.setUTCDate(cur.getUTCDate() + 1);
        if (interval > 1 && cur.getUTCDay() === 0) {
          cur.setUTCDate(cur.getUTCDate() + 7 * (interval - 1));
        }
      } else {
        cur.setUTCDate(cur.getUTCDate() + 7 * interval);
      }
    } else if (freq === 'MONTHLY') {
      if (rule.by_set_pos != null && daysOfWeek.length > 0) {
        cur.setUTCDate(cur.getUTCDate() + 1);
      } else {
        cur.setUTCMonth(cur.getUTCMonth() + interval);
      }
    } else if (freq === 'YEARLY') {
      cur.setUTCFullYear(cur.getUTCFullYear() + interval);
    } else {
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }

  return occurrences;
}

export const CalendarService = {
  /**
   * Check for scheduling conflicts with existing published events.
   */
  async checkConflicts({ schoolId, eventData, targets = [], excludeEventId = null, dbClient = sql }) {
    const numericSchoolId = Number(schoolId);
    const startDate = formatYMD(eventData.start_date || eventData.start_datetime);
    const endDate = formatYMD(eventData.end_date || eventData.end_datetime || startDate);
    const startDatetime = new Date(eventData.start_datetime || `${startDate}T${eventData.start_time || '00:00:00'}Z`);
    const endDatetime = new Date(eventData.end_datetime || `${endDate}T${eventData.end_time || '23:59:59'}Z`);

    const conflicts = [];

    // 1. Check for Holiday conflict (scheduling instructional event on holiday)
    const holidays = await dbClient`
      SELECT id, title, start_date, end_date, event_type, holiday_type, attendance_enabled
      FROM calendar_events
      WHERE school_id = ${numericSchoolId}
        AND (event_type = 'HOLIDAY' OR holiday_type IS NOT NULL)
        AND status = 'PUBLISHED'
        AND deleted_at IS NULL
        AND start_date <= ${endDate}
        AND end_date >= ${startDate}
        ${excludeEventId ? dbClient`AND id != ${excludeEventId}` : dbClient``}
    `;

    for (const h of holidays) {
      if (
        isInstructionalEventType(eventData.event_type) &&
        h.attendance_enabled !== true
      ) {
        conflicts.push({
          type: 'HOLIDAY_OVERLAP',
          severity: 'HIGH',
          conflictingEventId: h.id,
          conflictingEventTitle: h.title,
          message: `Date range overlaps with published holiday "${h.title}" (${h.start_date} to ${h.end_date}).`,
        });
      }
    }

    // 2. Location double-booking check
    if (eventData.location && eventData.location.trim()) {
      const locClashes = await dbClient`
        SELECT id, title, start_datetime, end_datetime, location
        FROM calendar_events
        WHERE school_id = ${numericSchoolId}
          AND location = ${eventData.location.trim()}
          AND status IN ('PUBLISHED', 'SCHEDULED')
          AND deleted_at IS NULL
          AND start_datetime < ${endDatetime.toISOString()}
          AND end_datetime > ${startDatetime.toISOString()}
          ${excludeEventId ? dbClient`AND id != ${excludeEventId}` : dbClient``}
      `;
      for (const c of locClashes) {
        conflicts.push({
          type: 'LOCATION_DOUBLE_BOOKING',
          severity: 'HIGH',
          conflictingEventId: c.id,
          conflictingEventTitle: c.title,
          message: `Location "${eventData.location}" is already booked by "${c.title}" during this time.`,
        });
      }
    }

    // 3. Target class/section overlap check (e.g. multiple exams or conflicting events for same class)
    const targetClassIds = targets.filter((t) => t.target_type === 'CLASS').map((t) => t.target_id);
    const targetSectionIds = targets.filter((t) => t.target_type === 'SECTION').map((t) => t.target_id);

    if (targetClassIds.length > 0 || targetSectionIds.length > 0) {
      const classClashes = await dbClient`
        SELECT DISTINCT e.id, e.title, e.event_type, e.start_datetime, e.end_datetime, t.target_type, t.target_id
        FROM calendar_events e
        JOIN calendar_event_targets t ON t.event_id = e.id
        WHERE e.school_id = ${numericSchoolId}
          AND e.status IN ('PUBLISHED', 'SCHEDULED')
          AND e.deleted_at IS NULL
          AND e.start_datetime < ${endDatetime.toISOString()}
          AND e.end_datetime > ${startDatetime.toISOString()}
          ${excludeEventId ? dbClient`AND e.id != ${excludeEventId}` : dbClient``}
          AND (
            (t.target_type = 'CLASS' AND t.target_id = ANY(${targetClassIds}))
            OR (t.target_type = 'SECTION' AND t.target_id = ANY(${targetSectionIds}))
          )
      `;

      for (const c of classClashes) {
        conflicts.push({
          type: 'AUDIENCE_CONFLICT',
          severity: c.event_type === 'EXAM' || eventData.event_type === 'EXAM' ? 'HIGH' : 'MEDIUM',
          conflictingEventId: c.id,
          conflictingEventTitle: c.title,
          message: `Target audience already has "${c.title}" scheduled at the same time.`,
        });
      }
    }

    return {
      hasConflict: conflicts.length > 0,
      conflicts,
    };
  },

  /**
   * Create a new calendar event with audience targeting.
   */
  async createEvent({ schoolId, userId, data, targets = [] }) {
    const numericSchoolId = Number(schoolId);
    const startDate = formatYMD(data.start_date || data.start_datetime);
    const endDate = formatYMD(data.end_date || data.end_datetime || startDate);

    const startDatetime = data.start_datetime
      ? new Date(data.start_datetime).toISOString()
      : `${startDate}T${data.start_time || '00:00:00'}Z`;

    const endDatetime = data.end_datetime
      ? new Date(data.end_datetime).toISOString()
      : `${endDate}T${data.end_time || '23:59:59'}Z`;

    const isAllDay = Boolean(data.is_all_day ?? data.all_day ?? false);
    const copyTimetableFromDay = data.copy_timetable_from_day || data.timetable_day_override || null;
    const attendanceEnabled = data.attendance_enabled !== undefined
      ? data.attendance_enabled
      : (data.affects_attendance !== undefined ? !data.affects_attendance : null);
    const timetableEnabled = data.timetable_enabled !== undefined
      ? data.timetable_enabled
      : (data.affects_timetable !== undefined ? !data.affects_timetable : null);
    const holidayType = canonicalizeHolidayType(
      data.holiday_type || (data.is_holiday ? 'SCHOOL_HOLIDAY' : null)
    );
    const eventType = data.is_holiday
      ? 'HOLIDAY'
      : canonicalizeEventType(data.event_type || 'SCHOOL_EVENT');
    const priority = canonicalizePriority(data.priority);
    if (data.school_id && Number(data.school_id) !== numericSchoolId) {
      logger.warn({ attemptedSchoolId: data.school_id, numericSchoolId }, 'calendar_ignored_foreign_school_id');
    }

    const requiresApproval = await isApprovalRequired(numericSchoolId);
    const initialStatus = data.status || (requiresApproval ? 'PENDING_APPROVAL' : 'PUBLISHED');
    const publishedAt = initialStatus === 'PUBLISHED' ? new Date().toISOString() : null;

    // Resolve targets from data if empty
    let resolvedTargets = targets;
    if ((!resolvedTargets || resolvedTargets.length === 0) && data.target_type) {
      const ids = Array.isArray(data.target_ids) && data.target_ids.length > 0
        ? data.target_ids
        : ['ALL'];
      resolvedTargets = ids.map((id) => ({
        target_type: data.target_type,
        target_id: String(id),
      }));
    }

    return sql.begin(async (tx) => {
      const [event] = await tx`
        INSERT INTO calendar_events (
          school_id, academic_year_id, academic_term_id, title, title_te,
          description, description_te, event_type, start_datetime, end_datetime,
          start_date, end_date, is_all_day, location, status, priority,
          attendance_enabled, timetable_enabled, copy_timetable_from_day, holiday_type,
          source_module, source_entity_id, recurrence_rule, recurrence_parent_id,
          reminder_schedules, attachments, created_by, published_at
        ) VALUES (
          ${numericSchoolId}, ${data.academic_year_id || null}, ${data.academic_term_id || null},
          ${data.title}, ${data.title_te || null}, ${data.description || null}, ${data.description_te || null},
          ${eventType}, ${startDatetime}, ${endDatetime},
          ${startDate}, ${endDate}, ${isAllDay}, ${data.location || null},
          ${initialStatus}, ${priority},
          ${attendanceEnabled}, ${timetableEnabled},
          ${copyTimetableFromDay}, ${holidayType},
          ${data.source_module || 'MANUAL'}, ${data.source_entity_id || null},
          ${data.recurrence_rule ? JSON.stringify(data.recurrence_rule) : null},
          ${data.recurrence_parent_id || null},
          ${JSON.stringify(data.reminder_schedules || ['1d', '1h'])},
          ${JSON.stringify(data.attachments || [])}, ${userId || null}, ${publishedAt}
        )
        RETURNING *
      `;

      // Insert audience targets (defaults to ENTIRE_SCHOOL if empty)
      const finalTargets = resolvedTargets && resolvedTargets.length > 0 ? resolvedTargets : [{ target_type: 'ENTIRE_SCHOOL', target_id: 'ALL' }];
      for (const t of finalTargets) {
        await tx`
          INSERT INTO calendar_event_targets (school_id, event_id, target_type, target_id)
          VALUES (${numericSchoolId}, ${event.id}, ${t.target_type}, ${String(t.target_id)})
          ON CONFLICT (event_id, target_type, target_id) DO NOTHING
        `;
      }

      // Record audit history
      await tx`
        INSERT INTO calendar_event_history (school_id, event_id, changed_by, change_type, new_value, change_summary)
        VALUES (${numericSchoolId}, ${event.id}, ${userId || null}, 'CREATED', ${JSON.stringify(event)}, 'Event created')
      `;

      // Schedule reminders if published (use defaults when caller omitted schedules)
      if (initialStatus === 'PUBLISHED') {
        const remindTimes = computeReminderTimestamps(startDatetime, data.reminder_schedules || ['1d', '1h']);
        for (const rTime of remindTimes) {
          await tx`
            INSERT INTO calendar_event_reminders (school_id, event_id, remind_at)
            VALUES (${numericSchoolId}, ${event.id}, ${rTime})
            ON CONFLICT (event_id, remind_at) DO NOTHING
          `;
        }
      }

      // Trigger push notifications asynchronously
      if (initialStatus === 'PUBLISHED' && data.notify !== false && data.skip_notifications !== true) {
        notifyEventPublished(numericSchoolId, event).catch((err) => {
          logger.error({ err, eventId: event.id }, 'calendar_event_publish_failed');
        });
      }

      return presentCalendarEvent(event);
    });
  },

  /**
   * Update an existing event.
   */
  async updateEvent({ schoolId, userId, eventId, data, targets }) {
    const numericSchoolId = Number(schoolId);

    return sql.begin(async (tx) => {
      const [oldEvent] = await tx`
        SELECT * FROM calendar_events
        WHERE id = ${eventId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      `;

      if (!oldEvent) {
        throw new Error('Event not found');
      }

      const startDate = data.start_date ? formatYMD(data.start_date) : oldEvent.start_date;
      const endDate = data.end_date ? formatYMD(data.end_date) : (data.start_date ? formatYMD(data.start_date) : oldEvent.end_date);

      const startDatetime = data.start_datetime
        ? new Date(data.start_datetime).toISOString()
        : (data.start_date || data.start_time ? `${startDate}T${data.start_time || '00:00:00'}Z` : oldEvent.start_datetime);

      const endDatetime = data.end_datetime
        ? new Date(data.end_datetime).toISOString()
        : (data.end_date || data.end_time || data.start_date ? `${endDate}T${data.end_time || '23:59:59'}Z` : oldEvent.end_datetime);

      const isAllDay = data.is_all_day !== undefined ? Boolean(data.is_all_day) : (data.all_day !== undefined ? Boolean(data.all_day) : oldEvent.is_all_day);
      const copyTimetableFromDay = data.copy_timetable_from_day !== undefined
        ? data.copy_timetable_from_day
        : (data.timetable_day_override !== undefined ? data.timetable_day_override : oldEvent.copy_timetable_from_day);
      const attendanceEnabled = data.attendance_enabled !== undefined
        ? data.attendance_enabled
        : (data.affects_attendance !== undefined ? !data.affects_attendance : oldEvent.attendance_enabled);
      const timetableEnabled = data.timetable_enabled !== undefined
        ? data.timetable_enabled
        : (data.affects_timetable !== undefined ? !data.affects_timetable : oldEvent.timetable_enabled);
      const holidayType = data.holiday_type !== undefined
        ? canonicalizeHolidayType(data.holiday_type)
        : (data.is_holiday !== undefined ? (data.is_holiday ? (oldEvent.holiday_type || 'SCHOOL_HOLIDAY') : null) : oldEvent.holiday_type);
      const eventType = data.event_type !== undefined
        ? canonicalizeEventType(data.event_type)
        : (data.is_holiday ? 'HOLIDAY' : oldEvent.event_type);
      const priority = data.priority !== undefined
        ? canonicalizePriority(data.priority)
        : oldEvent.priority;

      const [updated] = await tx`
        UPDATE calendar_events
        SET
          academic_year_id = COALESCE(${data.academic_year_id ?? null}, academic_year_id),
          academic_term_id = COALESCE(${data.academic_term_id ?? null}, academic_term_id),
          title = COALESCE(${data.title ?? null}, title),
          title_te = COALESCE(${data.title_te ?? null}, title_te),
          description = COALESCE(${data.description ?? null}, description),
          description_te = COALESCE(${data.description_te ?? null}, description_te),
          event_type = ${eventType},
          start_datetime = ${startDatetime},
          end_datetime = ${endDatetime},
          start_date = ${startDate},
          end_date = ${endDate},
          is_all_day = ${isAllDay},
          location = COALESCE(${data.location ?? null}, location),
          priority = ${priority},
          attendance_enabled = ${attendanceEnabled},
          timetable_enabled = ${timetableEnabled},
          copy_timetable_from_day = ${copyTimetableFromDay},
          holiday_type = ${holidayType},
          status = COALESCE(${data.status ?? null}, status),
          recurrence_rule = COALESCE(${data.recurrence_rule ? JSON.stringify(data.recurrence_rule) : null}, recurrence_rule),
          attachments = COALESCE(${data.attachments ? JSON.stringify(data.attachments) : null}, attachments),
          reminder_schedules = COALESCE(${data.reminder_schedules ? JSON.stringify(data.reminder_schedules) : null}, reminder_schedules),
          updated_at = now()
        WHERE id = ${eventId} AND school_id = ${numericSchoolId}
        RETURNING *
      `;

      // Update targets if provided
      let resolvedTargets = targets;
      if (!resolvedTargets && data.target_type) {
        const ids = Array.isArray(data.target_ids) && data.target_ids.length > 0 ? data.target_ids : ['ALL'];
        resolvedTargets = ids.map((id) => ({ target_type: data.target_type, target_id: String(id) }));
      }

      if (Array.isArray(resolvedTargets)) {
        await tx`
          DELETE FROM calendar_event_targets
          WHERE school_id = ${numericSchoolId} AND event_id = ${eventId}
        `;
        const finalTargets = resolvedTargets.length > 0 ? resolvedTargets : [{ target_type: 'ENTIRE_SCHOOL', target_id: 'ALL' }];
        for (const t of finalTargets) {
          await tx`
            INSERT INTO calendar_event_targets (school_id, event_id, target_type, target_id)
            VALUES (${numericSchoolId}, ${eventId}, ${t.target_type}, ${String(t.target_id)})
            ON CONFLICT (event_id, target_type, target_id) DO NOTHING
          `;
        }
      }

      // Record audit history
      await tx`
        INSERT INTO calendar_event_history (school_id, event_id, changed_by, change_type, old_value, new_value, change_summary)
        VALUES (${numericSchoolId}, ${eventId}, ${userId || null}, 'UPDATED', ${JSON.stringify(oldEvent)}, ${JSON.stringify(updated)}, 'Event updated')
      `;

      // Reschedule reminders if schedule changed
      if (data.start_datetime || data.reminder_schedules) {
        await tx`
          DELETE FROM calendar_event_reminders
          WHERE event_id = ${eventId} AND status = 'PENDING'
        `;
        const schedules = data.reminder_schedules || oldEvent.reminder_schedules || ['1d', '1h'];
        const remindTimes = computeReminderTimestamps(startDatetime, schedules);
        for (const rTime of remindTimes) {
          await tx`
            INSERT INTO calendar_event_reminders (school_id, event_id, remind_at)
            VALUES (${numericSchoolId}, ${eventId}, ${rTime})
            ON CONFLICT (event_id, remind_at) DO NOTHING
          `;
        }
      }

      // Notify users of update if already published
      if (oldEvent.status === 'PUBLISHED' && data.notify !== false && data.skip_notifications !== true) {
        notifyEventUpdated(numericSchoolId, updated, oldEvent).catch((err) => {
          logger.error({ err, eventId }, 'calendar_notification_failed');
        });
      }

      return presentCalendarEvent(updated);
    });
  },

  /**
   * Handle recurring event edits:
   * - THIS_EVENT: Add occurrence_date to master's recurrence_rule.exceptions, create standalone override event.
   * - THIS_AND_FUTURE: Terminate master's recurrence_rule.until before occurrence_date, create new series from occurrence_date.
   * - ENTIRE_SERIES: Update master event directly.
   */
  async updateRecurringEvent({ schoolId, userId, eventId, scope = 'THIS_EVENT', occurrenceDate, data, targets }) {
    const numericSchoolId = Number(schoolId);
    const occDateStr = formatYMD(occurrenceDate);

    const [rawMaster] = await sql`
      SELECT * FROM calendar_events
      WHERE id = ${eventId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
    `;
    const master = normalizeEventDates(rawMaster);

    if (!master) throw new Error('Recurring event not found');

    if (scope === 'ENTIRE_SERIES') {
      return this.updateEvent({ schoolId: numericSchoolId, userId, eventId, data, targets });
    }

    if (scope === 'THIS_EVENT') {
      return sql.begin(async (tx) => {
        // Add occDateStr to exceptions on master
        const currentRule = master.recurrence_rule || {};
        const exceptions = Array.isArray(currentRule.exceptions) ? [...currentRule.exceptions] : [];
        if (!exceptions.includes(occDateStr)) {
          exceptions.push(occDateStr);
        }
        const updatedRule = { ...currentRule, exceptions };

        await tx`
          UPDATE calendar_events
          SET recurrence_rule = ${JSON.stringify(updatedRule)}, updated_at = now()
          WHERE id = ${master.id} AND school_id = ${numericSchoolId}
        `;

        // Create standalone override event
        const overrideData = {
          ...master,
          ...data,
          start_date: occDateStr,
          end_date: occDateStr,
          recurrence_rule: null,
          recurrence_parent_id: master.id,
        };
        delete overrideData.id;

        return this.createEvent({
          schoolId: numericSchoolId,
          userId,
          data: overrideData,
          targets: targets || [],
        });
      });
    }

    if (scope === 'THIS_AND_FUTURE') {
      return sql.begin(async (tx) => {
        // Compute day before occurrenceDate
        const occObj = new Date(occDateStr + 'T00:00:00Z');
        const dayBeforeObj = new Date(occObj.getTime() - 24 * 60 * 60 * 1000);
        const dayBeforeStr = formatYMD(dayBeforeObj);

        // Terminate master rule until dayBefore
        const currentRule = master.recurrence_rule || {};
        const updatedRule = { ...currentRule, until: dayBeforeStr };

        await tx`
          UPDATE calendar_events
          SET recurrence_rule = ${JSON.stringify(updatedRule)}, updated_at = now()
          WHERE id = ${master.id} AND school_id = ${numericSchoolId}
        `;

        // Create new recurring series starting from occDateStr
        const newSeriesData = {
          ...master,
          ...data,
          start_date: occDateStr,
          end_date: occDateStr,
          recurrence_rule: {
            ...currentRule,
            ...(data.recurrence_rule || {}),
          },
          recurrence_parent_id: null,
        };
        delete newSeriesData.id;

        return this.createEvent({
          schoolId: numericSchoolId,
          userId,
          data: newSeriesData,
          targets: targets || [],
        });
      });
    }

    throw new Error(`Unsupported recurrence edit scope: ${scope}`);
  },

  /**
   * Cancel an event.
   */
  async cancelEvent({ schoolId, userId, eventId, reason }) {
    const numericSchoolId = Number(schoolId);

    return sql.begin(async (tx) => {
      const [oldEvent] = await tx`
        SELECT * FROM calendar_events
        WHERE id = ${eventId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      `;

      if (!oldEvent) {
        throw new Error('Event not found');
      }

      const [cancelled] = await tx`
        UPDATE calendar_events
        SET
          status = 'CANCELLED',
          cancelled_at = now(),
          cancellation_reason = ${reason || null},
          updated_at = now()
        WHERE id = ${eventId} AND school_id = ${numericSchoolId}
        RETURNING *
      `;

      // Cancel pending reminders
      await tx`
        UPDATE calendar_event_reminders
        SET status = 'CANCELLED', updated_at = now()
        WHERE event_id = ${eventId} AND status = 'PENDING'
      `;

      // Record history
      await tx`
        INSERT INTO calendar_event_history (school_id, event_id, changed_by, change_type, old_value, new_value, change_summary)
        VALUES (${numericSchoolId}, ${eventId}, ${userId || null}, 'CANCELLED', ${JSON.stringify(oldEvent)}, ${JSON.stringify(cancelled)}, ${reason ? `Cancelled: ${reason}` : 'Event cancelled'})
      `;

      if (oldEvent.status === 'PUBLISHED') {
        notifyEventCancelled(numericSchoolId, cancelled, reason).catch(() => {});
      }

      return presentCalendarEvent(cancelled);
    });
  },

  /**
   * Publish a draft or scheduled event.
   */
  async publishEvent({ schoolId, userId, eventId }) {
    const numericSchoolId = Number(schoolId);

    return sql.begin(async (tx) => {
      const [oldEvent] = await tx`
        SELECT * FROM calendar_events
        WHERE id = ${eventId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      `;
      if (!oldEvent) throw new Error('Event not found');

      const [published] = await tx`
        UPDATE calendar_events
        SET
          status = 'PUBLISHED',
          published_at = now(),
          approved_by = ${userId || null},
          updated_at = now()
        WHERE id = ${eventId} AND school_id = ${numericSchoolId}
        RETURNING *
      `;

      // Schedule reminders
      const schedules = published.reminder_schedules || ['1d', '1h'];
      const remindTimes = computeReminderTimestamps(published.start_datetime, schedules);
      for (const rTime of remindTimes) {
        await tx`
          INSERT INTO calendar_event_reminders (school_id, event_id, remind_at)
          VALUES (${numericSchoolId}, ${eventId}, ${rTime})
          ON CONFLICT (event_id, remind_at) DO NOTHING
        `;
      }

      await tx`
        INSERT INTO calendar_event_history (school_id, event_id, changed_by, change_type, new_value, change_summary)
        VALUES (${numericSchoolId}, ${eventId}, ${userId || null}, 'PUBLISHED', ${JSON.stringify(published)}, 'Event published')
      `;

      notifyEventPublished(numericSchoolId, published).catch((err) => {
        logger.error({ err, eventId }, 'calendar_event_publish_failed');
      });

      return presentCalendarEvent(published);
    });
  },

  /**
   * Soft-delete an event.
   */
  async deleteEvent({ schoolId, userId, eventId }) {
    const numericSchoolId = Number(schoolId);

    const [existing] = await sql`
      SELECT id, status FROM calendar_events
      WHERE id = ${eventId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
    `;
    if (!existing) throw new Error('Event not found');

    if (existing.status === 'PUBLISHED') {
      return this.cancelEvent({
        schoolId: numericSchoolId,
        userId,
        eventId,
        reason: 'Cancelled instead of deleting a published academic record',
      });
    }

    return sql.begin(async (tx) => {
      const [event] = await tx`
        UPDATE calendar_events
        SET deleted_at = now(), updated_at = now()
        WHERE id = ${eventId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
        RETURNING id
      `;

      if (!event) throw new Error('Event not found');

      await tx`
        UPDATE calendar_event_reminders
        SET status = 'CANCELLED', updated_at = now()
        WHERE event_id = ${eventId} AND status = 'PENDING'
      `;

      await tx`
        INSERT INTO calendar_event_history (school_id, event_id, changed_by, change_type, change_summary)
        VALUES (${numericSchoolId}, ${eventId}, ${userId || null}, 'DELETED', 'Event deleted')
      `;

      return { success: true };
    });
  },

  /**
   * Fetch single event details including targets and history.
   */
  async getEventById({ schoolId, eventId }) {
    const numericSchoolId = Number(schoolId);

    const [event] = await sql`
      SELECT 
        e.*,
        creator.display_name as created_by_name,
        approver.display_name as approved_by_name,
        ay.code as academic_year_code,
        t.name as term_name
      FROM calendar_events e
      LEFT JOIN users u ON e.created_by = u.id
      LEFT JOIN persons creator ON u.person_id = creator.id
      LEFT JOIN users ua ON e.approved_by = ua.id
      LEFT JOIN persons approver ON ua.person_id = approver.id
      LEFT JOIN academic_years ay ON e.academic_year_id = ay.id
      LEFT JOIN academic_terms t ON e.academic_term_id = t.id
      WHERE e.id = ${eventId}
        AND e.school_id = ${numericSchoolId}
        AND e.deleted_at IS NULL
    `;

    if (!event) return null;

    const targets = await sql`
      SELECT id, target_type, target_id
      FROM calendar_event_targets
      WHERE school_id = ${numericSchoolId} AND event_id = ${eventId}
    `;

    const history = await sql`
      SELECT h.*, p.display_name as changed_by_name
      FROM calendar_event_history h
      LEFT JOIN users u ON h.changed_by = u.id
      LEFT JOIN persons p ON u.person_id = p.id
      WHERE h.school_id = ${numericSchoolId} AND h.event_id = ${eventId}
      ORDER BY h.created_at DESC
      LIMIT 20
    `;

    return presentCalendarEvent({
      ...event,
      targets,
      history,
    });
  },

  /**
   * Fetch events within a date range for a specific user, strictly enforcing audience targeting and tenant isolation.
   * Expands recurring events within the requested range server-side.
   */
  async getEventsForUser({ schoolId, user, startDate, endDate, filters = {} }) {
    const numericSchoolId = Number(schoolId);
    const start = formatYMD(startDate);
    const end = formatYMD(endDate || startDate);
    const search = String(filters.search || filters.q || '').trim().toLowerCase();
    const requestedStudentId = filters.student_id || filters.studentId || null;

    const roles = user?.roles || [];
    const isAdmin = roles.includes('admin') || roles.includes('principal');
    const isStaff = roles.some((r) => ['teacher', 'staff'].includes(r));
    const isAccounts = roles.includes('accounts');
    const isDriver = roles.includes('driver');
    const isGatekeeper = roles.includes('gatekeeper');
    const isStudent = roles.includes('student');
    const isParent = roles.includes('parent');

    // Resolve student enrolled classes & sections if student or parent
    let enrolledClassIds = [];
    let enrolledSectionIds = [];
    let studentIds = [];

    if (isStudent && user?.person_id) {
      const enrollments = await sql`
        SELECT se.student_id, se.class_section_id, cs.class_id
        FROM student_enrollments se
        JOIN students s ON se.student_id = s.id
        JOIN class_sections cs ON se.class_section_id = cs.id
        WHERE se.school_id = ${numericSchoolId}
          AND s.person_id = ${user.person_id}
          AND se.status = 'active'
          AND se.deleted_at IS NULL
      `;
      enrolledClassIds = enrollments.map((e) => e.class_id);
      enrolledSectionIds = enrollments.map((e) => e.class_section_id);
      studentIds = enrollments.map((e) => e.student_id);
    } else if (isParent && user?.person_id) {
      const parentEnrollments = await sql`
        SELECT se.student_id, se.class_section_id, cs.class_id
        FROM parents p
        JOIN student_parents sp ON sp.parent_id = p.id
        JOIN student_enrollments se ON se.student_id = sp.student_id
        JOIN class_sections cs ON se.class_section_id = cs.id
        WHERE p.school_id = ${numericSchoolId}
          AND p.person_id = ${user.person_id}
          AND se.status = 'active'
          AND se.deleted_at IS NULL
      `;
      enrolledClassIds = parentEnrollments.map((e) => e.class_id);
      enrolledSectionIds = parentEnrollments.map((e) => e.class_section_id);
      studentIds = parentEnrollments.map((e) => e.student_id);
      if (requestedStudentId) {
        const allowed = new Set(studentIds.map(String));
        if (!allowed.has(String(requestedStudentId))) {
          enrolledClassIds = [];
          enrolledSectionIds = [];
          studentIds = [];
        } else {
          const scoped = parentEnrollments.filter((e) => String(e.student_id) === String(requestedStudentId));
          enrolledClassIds = scoped.map((e) => e.class_id);
          enrolledSectionIds = scoped.map((e) => e.class_section_id);
          studentIds = scoped.map((e) => e.student_id);
        }
      }
    }

    // Resolve teacher assigned classes if staff
    let staffAssignedClassIds = [];
    let staffAssignedSectionIds = [];
    if (isStaff && user?.person_id) {
      const staffAssignments = await sql`
        SELECT cs.class_id, cs.id as section_id
        FROM staff s
        JOIN class_sections cs ON cs.class_teacher_id = s.id
        WHERE s.school_id = ${numericSchoolId}
          AND s.person_id = ${user.person_id}
          AND cs.deleted_at IS NULL
        UNION
        SELECT cs.class_id, cs.id as section_id
        FROM staff s
        JOIN timetable_slots ts ON ts.teacher_id = s.id
        JOIN class_sections cs ON ts.class_section_id = cs.id
        WHERE s.school_id = ${numericSchoolId}
          AND s.person_id = ${user.person_id}
          AND ts.deleted_at IS NULL
      `;
      staffAssignedClassIds = staffAssignments.map((a) => a.class_id);
      staffAssignedSectionIds = staffAssignments.map((a) => a.section_id);
    }

    // Query events: include both range-matching non-recurring events and active recurring master events
    const rawEvents = await sql`
      SELECT DISTINCT 
        e.id, e.title, e.title_te, e.description, e.description_te,
        e.event_type, e.start_datetime, e.end_datetime, e.start_date, e.end_date,
        e.is_all_day, e.location, e.status, e.priority, e.attendance_enabled,
        e.timetable_enabled, e.copy_timetable_from_day, e.holiday_type,
        e.source_module, e.source_entity_id, e.recurrence_rule, e.recurrence_parent_id,
        e.created_by, e.published_at, e.created_at
      FROM calendar_events e
      LEFT JOIN calendar_event_targets t ON t.event_id = e.id
      WHERE e.school_id = ${numericSchoolId}
        AND e.deleted_at IS NULL
        AND (
          -- Direct match within window
          (e.start_date <= ${end} AND e.end_date >= ${start})
          -- OR recurring master event that started on/before window end and extends past window start
          OR (
            e.recurrence_rule IS NOT NULL
            AND e.start_date <= ${end}
            AND (e.recurrence_rule->>'until' IS NULL OR (e.recurrence_rule->>'until')::date >= ${start}::date)
          )
        )
        ${
          isAdmin
            ? (filters.status ? sql`AND e.status = ${filters.status}` : sql``)
            : sql`AND e.status = 'PUBLISHED'`
        }
        ${filters.event_type ? sql`AND e.event_type = ${canonicalizeEventType(filters.event_type)}` : sql``}
        ${filters.priority ? sql`AND e.priority = ${canonicalizePriority(filters.priority)}` : sql``}
        ${filters.source_module ? sql`AND e.source_module = ${filters.source_module}` : sql``}
        ${search ? sql`AND (
          lower(e.title) LIKE ${'%' + search + '%'}
          OR lower(COALESCE(e.description, '')) LIKE ${'%' + search + '%'}
          OR lower(COALESCE(e.location, '')) LIKE ${'%' + search + '%'}
        )` : sql``}
        ${
          isAdmin
            ? sql``
            : sql`AND (
                -- Entire school targeting
                t.target_type = 'ENTIRE_SCHOOL'
                -- Role-level targeting
                OR (t.target_type = 'ROLE' AND t.target_id = ANY(${roles}))
                -- Direct user targeting
                OR (t.target_type = 'USER' AND t.target_id = ${user?.id || ''})
                -- Student direct targeting
                OR (t.target_type = 'STUDENT' AND t.target_id = ANY(${studentIds}))
                -- Class targeting
                OR (t.target_type = 'CLASS' AND (
                  t.target_id = ANY(${enrolledClassIds})
                  OR t.target_id = ANY(${staffAssignedClassIds})
                ))
                -- Section targeting
                OR (t.target_type = 'SECTION' AND (
                  t.target_id = ANY(${enrolledSectionIds})
                  OR t.target_id = ANY(${staffAssignedSectionIds})
                ))
                OR (t.target_type = 'PARENT' AND ${isParent})
                OR (t.target_type = 'STAFF' AND ${isStaff})
                OR (t.target_type = 'ACCOUNTS' AND ${isAccounts})
                OR (t.target_type = 'DRIVER' AND ${isDriver})
                OR (t.target_type = 'GATEKEEPER' AND ${isGatekeeper})
                -- Operational role specific allowances
                ${isDriver ? sql`OR e.event_type IN ('HOLIDAY', 'VACATION', 'SPECIAL_WORKING_DAY', 'TRIP', 'TRANSPORT_EVENT')` : sql``}
                ${isGatekeeper ? sql`OR e.event_type IN ('HOLIDAY', 'VACATION', 'PTM', 'SCHOOL_EVENT', 'SPORTS', 'CELEBRATION', 'SPECIAL_WORKING_DAY')` : sql``}
                ${isAccounts ? sql`OR e.event_type IN ('FEE_DUE', 'FEE_LATE_DATE', 'HOLIDAY', 'VACATION', 'DOCUMENT_DEADLINE')` : sql``}
              )`
        }
    `;

    // Separate into master recurring events and standard/standalone events
    const masterRecurringEvents = [];
    const nonRecurringOrChildEvents = [];

    for (const rawEv of rawEvents) {
      const ev = normalizeEventDates(rawEv);
      if (ev.recurrence_rule && ev.recurrence_rule.frequency && !ev.recurrence_parent_id) {
        masterRecurringEvents.push(ev);
      } else {
        nonRecurringOrChildEvents.push(ev);
      }
    }

    // Expand recurrence occurrences within window
    const expandedOccurrences = [];
    for (const master of masterRecurringEvents) {
      const occurrences = expandRecurrenceOccurrences(master, start, end);
      expandedOccurrences.push(...occurrences);
    }

    const combinedEvents = [...nonRecurringOrChildEvents, ...expandedOccurrences];

    // Filter combined events strictly to the requested start and end range and sort
    const finalEvents = combinedEvents.filter((e) => {
      const eStart = formatYMD(e.start_date);
      const eEnd = formatYMD(e.end_date || e.start_date);
      return eStart <= end && eEnd >= start;
    });

    finalEvents.sort((a, b) => {
      const diff = new Date(a.start_datetime).getTime() - new Date(b.start_datetime).getTime();
      if (diff !== 0) return diff;
      return (b.priority || 'NORMAL').localeCompare(a.priority || 'NORMAL');
    });

    return finalEvents.map(presentCalendarEvent);
  },

  /**
   * Optimized query for dashboard upcoming events.
   */
  async getUpcomingEvents({ schoolId, user, limit = 5, studentId = null }) {
    const today = formatYMD(new Date());
    const thirtyDaysLater = formatYMD(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));

    const events = await this.getEventsForUser({
      schoolId,
      user,
      startDate: today,
      endDate: thirtyDaysLater,
      filters: { status: 'PUBLISHED', student_id: studentId },
    });

    return events.slice(0, limit);
  },

  /**
   * Synchronize an event from a source module (EXAM, FEES, HOMEWORK, etc.).
   * Supports both:
   * - syncSourceEvent(schoolId, sourceModule, sourceEntityId, eventData, targets)
   * - syncSourceEvent({ schoolId, sourceModule, sourceEntityId, eventData, targets })
   * When eventData is null/undefined, automatically removes the linked calendar event.
   */
  async syncSourceEvent(arg1, arg2, arg3, arg4, arg5) {
    let schoolId, sourceModule, sourceEntityId, eventData, targets;

    if (typeof arg1 === 'object' && arg1 !== null) {
      ({ schoolId, sourceModule, sourceEntityId, eventData, targets = [] } = arg1);
    } else {
      schoolId = arg1;
      sourceModule = arg2;
      sourceEntityId = arg3;
      eventData = arg4;
      targets = arg5 || [];
    }

    const numericSchoolId = Number(schoolId);
    const entityIdStr = String(sourceEntityId);

    // If eventData is null or empty, cancel/delete the existing event
    if (!eventData) {
      const [existing] = await sql`
        SELECT id FROM calendar_events
        WHERE school_id = ${numericSchoolId}
          AND source_module = ${sourceModule}
          AND source_entity_id = ${entityIdStr}
          AND deleted_at IS NULL
      `;
      if (existing) {
        return this.deleteEvent({
          schoolId: numericSchoolId,
          eventId: existing.id,
        });
      }
      return null;
    }

    // Map target_type and target_ids if present in eventData
    if ((!targets || targets.length === 0) && eventData.target_type) {
      const ids = Array.isArray(eventData.target_ids) && eventData.target_ids.length > 0
        ? eventData.target_ids
        : ['ALL'];
      targets = ids.map((id) => ({
        target_type: eventData.target_type,
        target_id: String(id),
      }));
    }

    const isExamModule = sourceModule === 'EXAM';
    const normalizedData = {
      ...eventData,
      source_module: sourceModule,
      source_entity_id: entityIdStr,
      is_all_day: Boolean(eventData.is_all_day ?? eventData.all_day ?? true),
      copy_timetable_from_day: eventData.copy_timetable_from_day || eventData.timetable_day_override || null,
      attendance_enabled: eventData.attendance_enabled !== undefined
        ? eventData.attendance_enabled
        : (eventData.affects_attendance !== undefined ? !eventData.affects_attendance : null),
      timetable_enabled: eventData.timetable_enabled !== undefined
        ? eventData.timetable_enabled
        : (eventData.affects_timetable !== undefined ? !eventData.affects_timetable : null),
      notify: eventData?.notify !== undefined ? eventData.notify : !isExamModule,
      skip_notifications: eventData?.skip_notifications !== undefined ? eventData.skip_notifications : isExamModule,
    };

    const [existing] = await sql`
      SELECT id, status FROM calendar_events
      WHERE school_id = ${numericSchoolId}
        AND source_module = ${sourceModule}
        AND source_entity_id = ${entityIdStr}
        AND deleted_at IS NULL
    `;

    if (existing) {
      return this.updateEvent({
        schoolId: numericSchoolId,
        eventId: existing.id,
        data: normalizedData,
        targets,
      });
    } else {
      return this.createEvent({
        schoolId: numericSchoolId,
        data: {
          ...normalizedData,
          status: normalizedData.status || 'PUBLISHED',
        },
        targets,
      });
    }
  },

  /**
   * Calculate academic calendar analytics.
   */
  async getCalendarAnalytics({ schoolId, academicYearId = null }) {
    const numericSchoolId = Number(schoolId);

    // Resolve academic year start and end dates
    let year = null;
    if (academicYearId) {
      [year] = await sql`
        SELECT id, code, start_date, end_date FROM academic_years
        WHERE id = ${academicYearId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      `;
    } else {
      [year] = await sql`
        SELECT id, code, start_date, end_date FROM academic_years
        WHERE school_id = ${numericSchoolId} AND deleted_at IS NULL
        ORDER BY start_date DESC LIMIT 1
      `;
    }

    if (!year) {
      return {
        totalDays: 0,
        workingDays: 0,
        holidays: 0,
        examDays: 0,
        specialWorkingDays: 0,
        completedWorkingDays: 0,
        remainingInstructionalDays: 0,
        terms: [],
      };
    }

    const startDate = formatYMD(year.start_date);
    const endDate = formatYMD(year.end_date);
    const today = formatYMD(new Date());

    // Fetch calendar events in this academic year
    const events = await sql`
      SELECT id, event_type, holiday_type, attendance_enabled, start_date, end_date
      FROM calendar_events
      WHERE school_id = ${numericSchoolId}
        AND status = 'PUBLISHED'
        AND deleted_at IS NULL
        AND start_date <= ${endDate}
        AND end_date >= ${startDate}
    `;

    // Fetch terms
    const terms = await sql`
      SELECT id, name, start_date, end_date, sequence, status
      FROM academic_terms
      WHERE school_id = ${numericSchoolId}
        AND academic_year_id = ${year.id}
        AND deleted_at IS NULL
      ORDER BY sequence ASC
    `;

    // Count holidays and special working days
    const holidayDates = new Set();
    const specialWorkingDates = new Set();
    const examDates = new Set();

    events.forEach((e) => {
      const rangeStart = formatYMD(e.start_date);
      const rangeEnd = formatYMD(e.end_date || e.start_date);
      if (e.event_type === 'HOLIDAY' || e.event_type === 'VACATION' || e.holiday_type) {
        if (e.attendance_enabled !== true) {
          eachDateInclusive(rangeStart, rangeEnd, (ymd) => holidayDates.add(ymd));
        }
      } else if (e.event_type === 'SPECIAL_WORKING_DAY') {
        eachDateInclusive(rangeStart, rangeEnd, (ymd) => specialWorkingDates.add(ymd));
      } else if (e.event_type === 'EXAM' || e.event_type === 'TEST') {
        eachDateInclusive(rangeStart, rangeEnd, (ymd) => examDates.add(ymd));
      }
    });

    // Compute working day totals
    let totalDays = 0;
    let workingDays = 0;
    let completedWorkingDays = 0;

    const cur = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');

    while (cur <= end) {
      totalDays++;
      const ymd = formatYMD(cur);
      const isSunday = cur.getUTCDay() === 0;
      const isHoliday = holidayDates.has(ymd);
      const isSpecial = specialWorkingDates.has(ymd);

      const isWork = isSpecial || (!isSunday && !isHoliday);
      if (isWork) {
        workingDays++;
        if (ymd <= today) {
          completedWorkingDays++;
        }
      }

      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    const remainingInstructionalDays = Math.max(0, workingDays - completedWorkingDays);

    return {
      academicYear: year,
      totalDays,
      workingDays,
      completedWorkingDays,
      remainingInstructionalDays,
      holidays: holidayDates.size,
      specialWorkingDays: specialWorkingDates.size,
      examDays: examDates.size,
      terms: terms.map((t) => ({
        ...t,
        isCurrent: today >= formatYMD(t.start_date) && today <= formatYMD(t.end_date),
      })),
    };
  },

  /**
   * Bulk import calendar rows from Excel/CSV.
   */
  async bulkImportEvents({ schoolId, userId, rows = [] }) {
    const numericSchoolId = Number(schoolId);
    const validRows = [];
    const invalidRows = [];
    const warnings = [];

    // Fetch existing classes for lookup
    const classes = await sql`
      SELECT id, name FROM classes WHERE school_id = ${numericSchoolId} AND deleted_at IS NULL
    `;
    const classMap = new Map(classes.map((c) => [c.name.toLowerCase().trim(), c.id]));

    rows.forEach((row, index) => {
      const rowNum = index + 1;
      if (row.school_id && Number(row.school_id) !== numericSchoolId) {
        invalidRows.push({ rowNumber: rowNum, error: 'school_id cannot target another tenant', data: { ...row, school_id: undefined } });
        return;
      }
      const title = String(row.title || row.Title || '').trim();
      const rawDate = row.start_date || row['Start Date'] || row.date || row.Date;
      const startDate = formatYMD(rawDate);

      if (!title) {
        invalidRows.push({ rowNumber: rowNum, error: 'Title is required', data: row });
        return;
      }
      if (!startDate) {
        invalidRows.push({ rowNumber: rowNum, error: 'Valid Start Date is required (YYYY-MM-DD)', data: row });
        return;
      }

      const eventType = canonicalizeEventType(row.event_type || row['Event Type'] || 'SCHOOL_EVENT');
      const location = String(row.location || row.Location || '').trim();
      const description = String(row.description || row.Description || '').trim();
      const isAllDay = Boolean(row.is_all_day ?? row['All Day'] ?? true);
      const startTime = row.start_time || row['Start Time'] || null;
      const endTime = row.end_time || row['End Time'] || null;
      const audience = String(row.audience || row.Audience || 'ENTIRE_SCHOOL').toUpperCase().trim();

      const targets = [];
      if (audience === 'CLASS' || row.class || row.Class) {
        const className = String(row.class || row.Class || '').toLowerCase().trim();
        const classId = classMap.get(className);
        if (classId) {
          targets.push({ target_type: 'CLASS', target_id: classId });
        } else {
          warnings.push(`Row ${rowNum}: Class "${className}" not found. Defaulted to entire school.`);
          targets.push({ target_type: 'ENTIRE_SCHOOL', target_id: 'ALL' });
        }
      } else {
        targets.push({ target_type: 'ENTIRE_SCHOOL', target_id: 'ALL' });
      }

      validRows.push({
        title,
        event_type: eventType,
        start_date: startDate,
        end_date: formatYMD(row.end_date || row['End Date']) || startDate,
        is_all_day: isAllDay,
        start_time: startTime,
        end_time: endTime,
        location,
        description,
        targets,
      });
    });

    if (validRows.length > 0) {
      await sql.begin(async (tx) => {
        for (const item of validRows) {
          await this.createEvent({
            schoolId: numericSchoolId,
            userId,
            data: item,
            targets: item.targets,
          });
        }
      });
    }

    return {
      importedCount: validRows.length,
      failedCount: invalidRows.length,
      invalidRows,
      warnings,
    };
  },

  /**
   * Generate RFC 5545 iCalendar (ICS) string for a single event.
   */
  generateIcsForEvent(event) {
    const formatDateToIcs = (dateStr, timeStr) => {
      const d = String(dateStr).replace(/-/g, '');
      if (!timeStr) return `${d}`;
      const t = String(timeStr).replace(/:/g, '').slice(0, 4) + '00';
      return `${d}T${t}Z`;
    };

    const start = formatDateToIcs(event.start_date, event.start_time);
    const end = formatDateToIcs(event.end_date || event.start_date, event.end_time);

    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//SchoolIMS//Academic Calendar Engine//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${event.id}@schoolims.com`,
      `DTSTAMP:${formatDateToIcs(formatYMD(new Date()), '00:00:00')}`,
      event.is_all_day ? `DTSTART;VALUE=DATE:${String(event.start_date).replace(/-/g, '')}` : `DTSTART:${start}`,
      event.is_all_day ? `DTEND;VALUE=DATE:${String(event.end_date || event.start_date).replace(/-/g, '')}` : `DTEND:${end}`,
      `SUMMARY:${(event.title || '').replace(/,/g, '\\,')}`,
      `DESCRIPTION:${(event.description || '').replace(/\n/g, '\\n').replace(/,/g, '\\,')}`,
      event.location ? `LOCATION:${event.location.replace(/,/g, '\\,')}` : '',
      `STATUS:${event.status === 'CANCELLED' ? 'CANCELLED' : 'CONFIRMED'}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean).join('\r\n');
  },

  /**
   * Generate RFC 5545 iCalendar feed for multiple events.
   */
  generateIcsFeed(events = []) {
    const formatDateToIcs = (dateStr, timeStr) => {
      const d = String(dateStr).replace(/-/g, '');
      if (!timeStr) return `${d}`;
      const t = String(timeStr).replace(/:/g, '').slice(0, 4) + '00';
      return `${d}T${t}Z`;
    };

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//SchoolIMS//Academic Calendar Engine//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:SchoolIMS Academic Calendar',
    ];

    events.forEach((event) => {
      const start = formatDateToIcs(event.start_date, event.start_time);
      const end = formatDateToIcs(event.end_date || event.start_date, event.end_time);

      lines.push(
        'BEGIN:VEVENT',
        `UID:${event.id}@schoolims.com`,
        `DTSTAMP:${formatDateToIcs(formatYMD(new Date()), '00:00:00')}`,
        event.is_all_day ? `DTSTART;VALUE=DATE:${String(event.start_date).replace(/-/g, '')}` : `DTSTART:${start}`,
        event.is_all_day ? `DTEND;VALUE=DATE:${String(event.end_date || event.start_date).replace(/-/g, '')}` : `DTEND:${end}`,
        `SUMMARY:${(event.title || '').replace(/,/g, '\\,')}`,
        `DESCRIPTION:${(event.description || '').replace(/\n/g, '\\n').replace(/,/g, '\\,')}`,
        event.location ? `LOCATION:${event.location.replace(/,/g, '\\,')}` : '',
        `STATUS:${event.status === 'CANCELLED' ? 'CANCELLED' : 'CONFIRMED'}`,
        'END:VEVENT'
      );
    });

    lines.push('END:VCALENDAR');
    return lines.filter(Boolean).join('\r\n');
  },

  generateCsv(events = []) {
    const header = ['Title', 'Event Type', 'Start Date', 'End Date', 'All Day', 'Location', 'Status', 'Priority', 'Description'];
    const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [header.join(',')];
    for (const event of events) {
      lines.push([
        event.title,
        event.event_type,
        formatYMD(event.start_date),
        formatYMD(event.end_date || event.start_date),
        event.is_all_day || event.all_day ? 'Yes' : 'No',
        event.location || '',
        event.status,
        event.priority,
        event.description || '',
      ].map(escape).join(','));
    }
    return lines.join('\n');
  },

  generatePrintableHtml(events = [], title = 'Academic Calendar') {
    const rows = events.map((event) => `
      <tr>
        <td>${formatYMD(event.start_date)}</td>
        <td>${formatYMD(event.end_date || event.start_date)}</td>
        <td>${event.event_type || ''}</td>
        <td>${(event.title || '').replace(/</g, '&lt;')}</td>
        <td>${(event.location || '').replace(/</g, '&lt;')}</td>
      </tr>`).join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
      <style>body{font-family:system-ui,sans-serif;padding:24px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #cbd5e1;padding:8px;text-align:left}th{background:#e2e8f0}@media print{body{padding:0}}</style>
      </head><body><h1>${title}</h1><table><thead><tr><th>Start</th><th>End</th><th>Type</th><th>Title</th><th>Location</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  },

  async rejectEvent({ schoolId, userId, eventId, reason }) {
    const numericSchoolId = Number(schoolId);
    const [updated] = await sql`
      UPDATE calendar_events
      SET status = 'REJECTED', rejected_at = now(), rejection_reason = ${reason || null}, updated_at = now()
      WHERE id = ${eventId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      RETURNING *
    `;
    if (!updated) throw new Error('Event not found');
    await sql`
      INSERT INTO calendar_event_history (school_id, event_id, changed_by, change_type, new_value, change_summary)
      VALUES (${numericSchoolId}, ${eventId}, ${userId || null}, 'REJECTED', ${JSON.stringify(updated)}, ${reason || 'Event rejected'})
    `;
    return presentCalendarEvent(updated);
  },
};

export default CalendarService;
