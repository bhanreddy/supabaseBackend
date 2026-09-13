import sql from '../db.js';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Format a Date object or string into YYYY-MM-DD
 */
export function formatYMD(dateInput) {
  if (!dateInput) return null;
  if (typeof dateInput === 'string') {
    return dateInput.trim().slice(0, 10);
  }
  if (dateInput instanceof Date) {
    if (Number.isNaN(dateInput.getTime())) return null;
    return dateInput.toISOString().slice(0, 10);
  }
  return String(dateInput).slice(0, 10);
}

/**
 * Determine the weekday name ('monday', etc.) for a YYYY-MM-DD date.
 */
export function getWeekdayName(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  return WEEKDAYS[dateObj.getDay()];
}

/**
 * Resolves whether a specific school date is a working day, a holiday, or a special working day.
 * Single source of truth for Attendance, Timetable, and Scheduling modules.
 *
 * @param {number|string} schoolId
 * @param {string|Date} rawDate
 * @returns {Promise<{
 *   date: string,
 *   dayOfWeek: string,
 *   isWorkingDay: boolean,
 *   isHoliday: boolean,
 *   isSpecialWorkingDay: boolean,
 *   holidayType: string|null,
 *   holidayId: string|null,
 *   holidayTitle: string|null,
 *   specialWorkingDayId: string|null,
 *   specialWorkingDayTitle: string|null,
 *   timetableOverride: string|null,
 *   timetableDay: string,
 *   attendanceAllowed: boolean,
 *   reason: string|null
 * }>}
 */
export async function resolveSchoolDay(schoolId, rawDate, dbClient = sql) {
  const date = formatYMD(rawDate);
  if (!date) {
    throw new Error('resolveSchoolDay requires a valid date');
  }
  const numericSchoolId = Number(schoolId);
  const dayOfWeek = getWeekdayName(date);

  // 1. Fetch any published calendar events active on this date for the school
  const events = await dbClient`
    SELECT 
      id, title, title_te, event_type, holiday_type, attendance_enabled,
      timetable_enabled, copy_timetable_from_day, priority, status
    FROM calendar_events
    WHERE school_id = ${numericSchoolId}
      AND ${date} >= start_date
      AND ${date} <= end_date
      AND status = 'PUBLISHED'
      AND deleted_at IS NULL
    ORDER BY priority DESC, created_at DESC
  `;

  // Look for Special Working Day overrides first (takes precedence over normal holidays/Sundays)
  const specialWorkingEvent = events.find((e) => e.event_type === 'SPECIAL_WORKING_DAY');
  if (specialWorkingEvent) {
    const timetableOverride = specialWorkingEvent.copy_timetable_from_day
      ? specialWorkingEvent.copy_timetable_from_day.toLowerCase()
      : (dayOfWeek === 'sunday' ? 'monday' : dayOfWeek);

    return {
      date,
      dayOfWeek,
      isWorkingDay: true,
      isHoliday: false,
      isSpecialWorkingDay: true,
      holidayType: null,
      holidayId: null,
      holidayTitle: null,
      holidayName: null,
      specialWorkingDayId: specialWorkingEvent.id,
      specialWorkingDayTitle: specialWorkingEvent.title,
      specialWorkingDayName: specialWorkingEvent.title,
      timetableOverride,
      timetableDay: timetableOverride,
      timetableEnabled: specialWorkingEvent.timetable_enabled !== false,
      attendanceAllowed: specialWorkingEvent.attendance_enabled !== false,
      reason: specialWorkingEvent.title || 'Special Working Day',
    };
  }

  // Look for Holiday / Vacation overrides
  const holidayEvent = events.find(
    (e) => e.event_type === 'HOLIDAY' || e.event_type === 'VACATION' || Boolean(e.holiday_type)
  );

  if (holidayEvent) {
    const isAttendanceOverridden = holidayEvent.attendance_enabled === true;
    return {
      date,
      dayOfWeek,
      isWorkingDay: isAttendanceOverridden,
      isHoliday: true,
      isSpecialWorkingDay: false,
      holidayType: holidayEvent.holiday_type || holidayEvent.event_type,
      holidayId: holidayEvent.id,
      holidayTitle: holidayEvent.title,
      holidayName: holidayEvent.title,
      specialWorkingDayId: null,
      specialWorkingDayTitle: null,
      specialWorkingDayName: null,
      timetableOverride: null,
      timetableDay: dayOfWeek,
      timetableEnabled: holidayEvent.timetable_enabled === true,
      attendanceAllowed: isAttendanceOverridden,
      reason: holidayEvent.title || 'School Holiday',
    };
  }

  const [school] = await dbClient`
    SELECT timetable_mode FROM schools WHERE id = ${numericSchoolId}
  `;
  const timetableMode = school?.timetable_mode === 'per_day' ? 'per_day' : 'uniform';

  // Sunday standard behavior
  if (dayOfWeek === 'sunday') {
    return {
      date,
      dayOfWeek,
      isWorkingDay: false,
      isHoliday: false,
      isSpecialWorkingDay: false,
      holidayType: null,
      holidayId: null,
      holidayTitle: null,
      specialWorkingDayId: null,
      specialWorkingDayTitle: null,
      timetableOverride: null,
      timetableDay: 'sunday',
      timetableEnabled: false,
      attendanceAllowed: false,
      reason: 'Sunday (Weekly Off)',
    };
  }

  // Standard weekday (Mon - Sat)
  const defaultTimetableDay = timetableMode === 'per_day' ? dayOfWeek : 'monday';

  return {
    date,
    dayOfWeek,
    isWorkingDay: true,
    isHoliday: false,
    isSpecialWorkingDay: false,
    holidayType: null,
    holidayId: null,
    holidayTitle: null,
    specialWorkingDayId: null,
    specialWorkingDayTitle: null,
    timetableOverride: null,
    timetableDay: defaultTimetableDay,
    timetableEnabled: true,
    attendanceAllowed: true,
    reason: 'Regular School Day',
  };
}
