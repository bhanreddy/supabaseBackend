import { attendanceError, dateKey, dateRange, isHolidayEvent, isEmergencyEvent, calendarJson } from './attendanceCalendarModel.js';
import { attendanceCalendarSchema } from './attendanceCalendarSchema.js';

export function audiencesOverlap(a, b, sections = []) {
  if (!a.length || !b.length || [...a, ...b].some(t => ['ENTIRE_SCHOOL', 'ROLE', 'USER', 'STUDENT'].includes(t.target_type))) return true;
  return a.some(x => b.some(y => {
    if (x.target_type === y.target_type) return String(x.target_id) === String(y.target_id);
    const section = x.target_type === 'SECTION' ? x : y;
    const schoolClass = x.target_type === 'CLASS' ? x : y;
    return sections.some(s => String(s.id) === String(section.target_id) && String(s.class_id) === String(schoolClass.target_id));
  }));
}

/** Called inside the write transaction, after targets have been persisted. */
export async function assertAttendanceCalendarPublication(db, schoolId, event, expand) {
  if (!['PUBLISHED', 'COMPLETED'].includes(event.status)) return;
  const [rollout] = await db`SELECT value FROM school_settings WHERE school_id = ${schoolId} AND key = 'attendance_calendar_v2_enabled'`;
  if (rollout?.value !== 'true' || (!isHolidayEvent(event) && event.event_type !== 'SPECIAL_WORKING_DAY')) return;
  if (!(await attendanceCalendarSchema(db)).ready) return;
  event = { ...event, recurrence_rule: calendarJson(event.recurrence_rule, null) };
  if (event.recurrence_rule?.frequency && !event.recurrence_rule.until) throw attendanceError('Set an end date for recurring holidays and special working days so conflicts can be checked before publication.');
  // Serialize operational calendar publication within a school, including target changes.
  await db`SELECT pg_advisory_xact_lock(61116, ${Number(schoolId)})`;
  const start = dateKey(event.start_date);
  const end = dateKey(event.recurrence_rule?.until || event.end_date);
  dateRange(start, end);
  const candidates = await db`SELECT e.*, COALESCE((SELECT jsonb_agg(jsonb_build_object('target_type', t.target_type, 'target_id', t.target_id))
    FROM calendar_event_targets t WHERE t.event_id = e.id AND t.school_id = e.school_id), '[]'::jsonb) AS targets
    FROM calendar_events e WHERE e.school_id = ${schoolId} AND e.deleted_at IS NULL AND e.status IN ('PUBLISHED','COMPLETED')
      AND e.id <> ${event.id} AND e.start_date <= ${end} AND (e.end_date >= ${start} OR e.recurrence_rule IS NOT NULL)
      AND (e.event_type IN ('HOLIDAY','VACATION','SPECIAL_WORKING_DAY') OR e.holiday_type IS NOT NULL)`;
  const targets = await db`SELECT target_type, target_id FROM calendar_event_targets WHERE school_id = ${schoolId} AND event_id = ${event.id}`;
  const sections = await db`SELECT id, class_id FROM class_sections WHERE school_id = ${schoolId} AND deleted_at IS NULL`;
  const occurrences = e => {
    const normalized = { ...e, recurrence_rule: calendarJson(e.recurrence_rule, null), start_date: dateKey(e.start_date), end_date: dateKey(e.end_date) };
    return normalized.recurrence_rule?.frequency && !normalized.recurrence_parent_id ? expand(normalized, start, end) : [normalized];
  };
  const own = occurrences(event);
  for (const other of candidates) {
    if (!audiencesOverlap(targets, other.targets, sections)) continue;
    if (!own.some(x => occurrences(other).some(y => x.start_date <= y.end_date && x.end_date >= y.start_date))) continue;
    const special = event.event_type === 'SPECIAL_WORKING_DAY' ? event : other.event_type === 'SPECIAL_WORKING_DAY' ? other : null;
    const holiday = isHolidayEvent(event) ? event : isHolidayEvent(other) ? other : null;
    if (!special || !holiday) continue;
    const explicit = (special.override_event_ids || []).map(String).includes(String(holiday.id)) && String(special.override_reason || '').trim();
    if (isEmergencyEvent(holiday) || !explicit) throw attendanceError(`Resolve the working-day conflict with “${other.title}” before publishing. A holiday override must explicitly identify the holiday and include a reason; emergency closures must be cancelled first.`, 409);
  }
  if (event.override_event_ids?.length && (!String(event.override_reason || '').trim() || event.event_type !== 'SPECIAL_WORKING_DAY')) throw attendanceError('Holiday overrides require a special working day and an audit reason.');
  if (event.override_event_ids?.some(id => !candidates.some(candidate => String(candidate.id) === String(id) && isHolidayEvent(candidate))))
    throw attendanceError('Choose published holidays from this school and the selected date range for an override.');
}
