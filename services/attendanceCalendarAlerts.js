import { createHash } from 'node:crypto';
import { schoolToday, policyForDate, isHolidayEvent, dateKey } from './attendanceCalendarModel.js';
import { attendanceCalendarSchema } from './attendanceCalendarSchema.js';

export function nextCalendarAlertTime(now, timezone, start, end) {
  if (!start || !end) return now;
  const quiet = date => {
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
    return start < end ? clock >= start && clock < end : clock >= start || clock < end;
  };
  const due = new Date(now);
  for (let i = 0; i < 1500 && quiet(due); i++) due.setUTCMinutes(due.getUTCMinutes() + 1, 0, 0);
  return due;
}
export function materiallyChangedCalendarEvent(event, old) {
  if (!old) return true;
  return ['title', 'title_te', 'start_date', 'end_date', 'start_datetime', 'end_datetime', 'location', 'description', 'description_te', 'holiday_type', 'attendance_enabled']
    .some(key => JSON.stringify(event[key]) !== JSON.stringify(old[key]));
}
/** true means enhanced delivery owns this event (including configured opt-outs). */
export async function enqueueAttendanceCalendarAlert(db, schoolId, event, kind, oldEvent = null) {
  const [flag] = await db`SELECT value FROM school_settings WHERE school_id = ${schoolId} AND key = 'attendance_calendar_v2_enabled'`;
  if (flag?.value !== 'true' || (!isHolidayEvent(event) && !['EXAM', 'TEST'].includes(event.event_type))) return false;
  if (!(await attendanceCalendarSchema(db)).ready) return false;
  if (kind === 'UPDATED' && !materiallyChangedCalendarEvent(event, oldEvent)) return true;
  event = { ...event, start_date: dateKey(event.start_date), end_date: dateKey(event.end_date) };
  const policies = await db`SELECT * FROM attendance_calendar_policies WHERE school_id = ${schoolId}`;
  const [setting] = await db`SELECT value FROM school_settings WHERE school_id = ${schoolId} AND key = 'school_timezone'`;
  const timezone = setting?.value || 'Asia/Kolkata';
  const policy = policyForDate(policies, schoolToday(timezone));
  if (isHolidayEvent(event) ? !policy.notify_holidays : !policy.notify_exams) return true;
  const version = event.updated_at || event.published_at || event.created_at;
  const fingerprint = createHash('sha256').update(JSON.stringify({ id: event.id, kind, version, title: event.title,
    title_te: event.title_te, start_date: event.start_date, end_date: event.end_date,
    start: event.start_datetime, end: event.end_datetime, location: event.location,
    description: event.description, description_te: event.description_te, holiday_type: event.holiday_type,
    attendance_enabled: event.attendance_enabled })).digest('hex');
  const due = nextCalendarAlertTime(new Date(), timezone, policy.quiet_start?.slice(0, 5), policy.quiet_end?.slice(0, 5));
  await db`INSERT INTO attendance_calendar_alerts(school_id, event_id, kind, payload, idempotency_key, due_at)
    VALUES (${schoolId}, ${event.id}, ${kind}, ${db.json({ event, oldEvent })}, ${fingerprint}, ${due})
    ON CONFLICT (school_id, idempotency_key) DO NOTHING`;
  return true;
}

/** Uses the existing reminder worker's transaction-locking and notification transport. */
export async function processAttendanceCalendarAlerts({ db, notify, resolveTargets }) {
  if (!(await attendanceCalendarSchema(db)).ready) return 0;
  return db.begin(async tx => {
    const rows = await tx`SELECT * FROM attendance_calendar_alerts WHERE status = 'PENDING' AND due_at <= now()
      ORDER BY due_at, id LIMIT 50 FOR UPDATE SKIP LOCKED`;
    for (const row of rows) {
      try {
        await tx.savepoint(async tx => {
        const [flag] = await tx`SELECT value FROM school_settings WHERE school_id = ${row.school_id} AND key = 'attendance_calendar_v2_enabled'`;
        if (flag?.value !== 'true') { await tx`UPDATE attendance_calendar_alerts SET status = 'SKIPPED' WHERE id = ${row.id}`; return; }
        const { event, oldEvent } = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        const [current] = await tx`SELECT * FROM calendar_events WHERE id = ${row.event_id} AND school_id = ${row.school_id}`;
        const staleDetails = current && row.kind !== 'CANCELLED' && materiallyChangedCalendarEvent({ ...current,
          start_date: dateKey(current.start_date), end_date: dateKey(current.end_date) }, event);
        if (!current || current.deleted_at || staleDetails || (row.kind === 'CANCELLED' ? current.status !== 'CANCELLED' : current.status !== 'PUBLISHED')) {
          await tx`UPDATE attendance_calendar_alerts SET status = 'SKIPPED' WHERE id = ${row.id}`;
          return;
        }
        const policies = await tx`SELECT * FROM attendance_calendar_policies WHERE school_id = ${row.school_id}`;
        const [zone] = await tx`SELECT value FROM school_settings WHERE school_id = ${row.school_id} AND key = 'school_timezone'`;
        const timezone = zone?.value || 'Asia/Kolkata';
        const policy = policyForDate(policies, schoolToday(timezone));
        if (isHolidayEvent(event) ? !policy.notify_holidays : !policy.notify_exams) {
          await tx`UPDATE attendance_calendar_alerts SET status = 'SKIPPED' WHERE id = ${row.id}`;
          return;
        }
        const due = nextCalendarAlertTime(new Date(), timezone, policy.quiet_start?.slice(0, 5), policy.quiet_end?.slice(0, 5));
        if (due > new Date()) { await tx`UPDATE attendance_calendar_alerts SET due_at = ${due} WHERE id = ${row.id}`; return; }
        const type = row.kind === 'CANCELLED' ? 'CALENDAR_EVENT_CANCELLED' : row.kind === 'UPDATED' ? 'CALENDAR_EVENT_UPDATED' : isHolidayEvent(event) ? 'HOLIDAY_ANNOUNCED' : 'CALENDAR_EVENT_PUBLISHED';
        const targetIds = await resolveTargets(row.school_id, row.event_id, tx);
        const preferenceTypes = event.source_module === 'EXAM' ? [type, 'EXAM_TIMETABLE_PUBLISHED'] : [type];
        const optedOut = targetIds.length ? await tx`SELECT user_id FROM notification_preferences WHERE school_id = ${row.school_id}
          AND user_id = ANY(${targetIds}) AND event_type = ANY(${preferenceTypes}) AND channel = 'PUSH' AND is_enabled = false AND deleted_at IS NULL` : [];
        const blocked = new Set(optedOut.map(r => String(r.user_id)));
        const users = targetIds.filter(id => !blocked.has(String(id)));
        const message = row.kind === 'CANCELLED' ? `${event.title} on ${event.start_date} has been cancelled.${event.cancellation_reason ? ` ${event.cancellation_reason}` : ''}`
          : row.kind === 'UPDATED' ? `${event.title}: schedule or details changed. ${oldEvent?.start_date || ''} → ${event.start_date}${event.location ? ` · ${event.location}` : ''}.`
            : `${event.title}: ${event.start_date}${event.end_date !== event.start_date ? ` — ${event.end_date}` : ''}${event.location ? ` · ${event.location}` : ''}.`;
        if (users.length) await notify(users, type, { title: event.title, message }, { schoolId: row.school_id,
          deepLink: `/Screen/calendar?eventId=${event.id}`, idempotencyKey: `calendar:${row.idempotency_key}` });
        await tx`UPDATE attendance_calendar_alerts SET status = 'SENT', sent_at = now() WHERE id = ${row.id}`;
        });
      } catch (error) {
        await tx`UPDATE attendance_calendar_alerts SET attempts = attempts + 1, status = CASE WHEN attempts >= 2 THEN 'FAILED' ELSE 'PENDING' END,
          due_at = now() + interval '5 minutes', failure_reason = ${String(error.message).slice(0, 500)} WHERE id = ${row.id}`;
      }
    }
    return rows.length;
  });
}
