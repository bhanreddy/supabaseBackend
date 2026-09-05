import { formatInTimeZone } from 'date-fns-tz';

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

export function isAttendanceDateToday(rawDate, timezone = 'Asia/Kolkata', now = new Date()) {
  const attendanceDate = String(rawDate || '').slice(0, 10);
  if (!YYYY_MM_DD.test(attendanceDate)) return false;

  try {
    return attendanceDate === formatInTimeZone(now, timezone || 'Asia/Kolkata', 'yyyy-MM-dd');
  } catch {
    return attendanceDate === formatInTimeZone(now, 'Asia/Kolkata', 'yyyy-MM-dd');
  }
}

export async function shouldSendAttendanceNotification({ schoolId, attendanceDate, db, now = new Date() }) {
  const [setting] = await db`
    SELECT timezone.name AS timezone
    FROM school_settings setting
    JOIN pg_timezone_names timezone ON timezone.name = setting.value
    WHERE setting.school_id = ${schoolId}
      AND setting.key = 'school_timezone'
    LIMIT 1
  `;

  return isAttendanceDateToday(attendanceDate, setting?.timezone || 'Asia/Kolkata', now);
}
