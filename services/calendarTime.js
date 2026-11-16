import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { attendanceError, validDate } from './attendanceCalendarModel.js';
export function schoolEventTimestamp(date, clock, timezone) {
  if (!validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(clock)) throw attendanceError('Choose a valid event date and time.');
  return fromZonedTime(`${date}T${clock}`, timezone).toISOString();
}
export const schoolEventClock = (value, timezone) => value ? formatInTimeZone(new Date(value), timezone, 'HH:mm') : null;
export async function calendarTimezone(db, schoolId) {
  const [setting] = await db`SELECT value FROM school_settings WHERE school_id = ${schoolId} AND key = 'school_timezone'`;
  const timezone = setting?.value || 'Asia/Kolkata';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); return timezone; } catch { return 'Asia/Kolkata'; }
}
