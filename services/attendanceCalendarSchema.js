import { attendanceError } from './attendanceCalendarModel.js';

// Code and database releases can arrive separately. Never parse SQL mentioning
// a new column until catalog inspection confirms that the column is installed.
export async function attendanceCalendarSchema(db) {
  const [schema] = await db`SELECT
    (SELECT count(*) = 2 FROM pg_attribute WHERE attrelid = to_regclass('public.calendar_events')
      AND attname IN ('override_event_ids','override_reason') AND NOT attisdropped) AS overrides,
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.daily_attendance')
      AND attname = 'correction_reason' AND NOT attisdropped) AS correction_reason,
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.attendance_calendar_policies')
      AND attname = 'revision' AND NOT attisdropped) AS policies,
    to_regclass('public.attendance_report_finalizations') IS NOT NULL AS reports,
    to_regclass('public.attendance_calendar_alerts') IS NOT NULL AS alerts`;
  return { ...schema, ready: !!(schema.overrides && schema.correction_reason && schema.policies && schema.reports && schema.alerts) };
}
export async function requireAttendanceCalendarSchema(db) {
  const schema = await attendanceCalendarSchema(db);
  if (!schema.ready) throw Object.assign(attendanceError('Install the student attendance calendar database migration before enabling this feature.',409),
    { code: 'ATTENDANCE_CALENDAR_MIGRATION_REQUIRED' });
  return schema;
}
