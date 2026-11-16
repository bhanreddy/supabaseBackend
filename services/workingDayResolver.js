import sql from '../db.js';
import { resolveDayRules, policyForDate, eventApplies } from './attendanceCalendarModel.js';
import { calendarTimezone } from './calendarTime.js';
import { attendanceCalendarSchema } from './attendanceCalendarSchema.js';

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
export async function resolveSchoolDay(schoolId, rawDate, dbClient = sql, context = {}) {
  const date = formatYMD(rawDate);
  if (!date) {
    throw new Error('resolveSchoolDay requires a valid date');
  }
  const numericSchoolId = Number(schoolId);
  const dayOfWeek = getWeekdayName(date);

  // 1. Fetch any published calendar events active on this date for the school
  let events = await dbClient`
    SELECT 
      id, title, title_te, event_type, holiday_type, attendance_enabled,
      timetable_enabled, copy_timetable_from_day, priority, status,
      start_date, end_date, start_datetime, end_datetime, recurrence_rule, recurrence_parent_id,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('target_type', t.target_type, 'target_id', t.target_id))
        FROM calendar_event_targets t WHERE t.event_id = calendar_events.id AND t.school_id = calendar_events.school_id), '[]'::jsonb) AS targets
    FROM calendar_events
    WHERE school_id = ${numericSchoolId}
      AND ${date} >= start_date
      AND (${date} <= end_date OR recurrence_rule IS NOT NULL)
      AND status IN ('PUBLISHED', 'COMPLETED')
      AND deleted_at IS NULL
    ORDER BY priority DESC, created_at DESC
  `;

  const [rollout] = await dbClient`SELECT value FROM school_settings
    WHERE school_id = ${numericSchoolId} AND key = 'attendance_calendar_v2_enabled'`;
  if (rollout?.value === 'true' && (await attendanceCalendarSchema(dbClient)).ready) {
    const policies = await dbClient`SELECT * FROM attendance_calendar_policies WHERE school_id = ${numericSchoolId} AND effective_from <= ${date}`;
    let scoped = { class_section_id: context.classSectionId, class_id: context.classId };
    if (context.classSectionId && !context.classId) {
      const [section] = await dbClient`SELECT class_id FROM class_sections WHERE id = ${context.classSectionId} AND school_id = ${numericSchoolId}`;
      scoped.class_id = section?.class_id;
    }
    // With no class context, only school-wide operational overrides apply.
    // A holiday for a particular student/role must not close the entire school.
    const applicable = events.filter(e => !e.targets?.length || e.targets.some(t => t.target_type === 'ENTIRE_SCHOOL')
      || ((context.classSectionId || context.classId) && eventApplies(e, scoped, null, null, [])));
    const ids = applicable.map(e => e.id);
    const overrides = ids.length ? await dbClient`SELECT id, override_event_ids FROM calendar_events
      WHERE school_id = ${numericSchoolId} AND id = ANY(${ids})` : [];
    const overrideMap = new Map(overrides.map(e => [e.id, e.override_event_ids]));
    const { expandRecurrenceOccurrences } = await import('./calendarService.js');
    const timezone = await calendarTimezone(dbClient, numericSchoolId);
    const expanded = applicable.flatMap(e => {
      const normalized = { ...e, school_timezone: timezone, start_date: formatYMD(e.start_date), end_date: formatYMD(e.end_date), override_event_ids: overrideMap.get(e.id) || [] };
      return e.recurrence_rule?.frequency && !e.recurrence_parent_id ? expandRecurrenceOccurrences(normalized, date, date) : [normalized];
    }).filter(e => e.start_date <= date && e.end_date >= date);
    const rules = resolveDayRules(date, expanded, policyForDate(policies, date));
    const [school] = await dbClient`SELECT timetable_mode FROM schools WHERE id = ${numericSchoolId}`;
    const special = rules.day_type === 'SPECIAL_WORKING_DAY';
    const holiday = ['EMERGENCY_CLOSURE', 'FIXED_HOLIDAY', 'LOCAL_HOLIDAY'].includes(rules.day_type);
    const override = special ? rules.source_event?.copy_timetable_from_day?.toLowerCase() || (dayOfWeek === 'sunday' ? 'monday' : dayOfWeek) : null;
    return { date, dayOfWeek, enhanced: true, isWorkingDay: rules.is_attendance_expected, isHoliday: holiday,
      isSpecialWorkingDay: special, holidayType: rules.holiday_type || null, holidayId: holiday ? rules.source_event?.id : null,
      holidayTitle: rules.holiday_name || null, holidayName: rules.holiday_name || null,
      specialWorkingDayId: special ? rules.source_event?.id : null, specialWorkingDayTitle: special ? rules.source_event?.title : null,
      specialWorkingDayName: special ? rules.source_event?.title : null,
      timetableOverride: override, timetableDay: override || (school?.timetable_mode === 'per_day' ? dayOfWeek : 'monday'),
      timetableEnabled: rules.is_attendance_expected && rules.source_event?.timetable_enabled !== false,
      attendanceAllowed: rules.is_attendance_expected, conflict: rules.conflict,
      reason: rules.holiday_name || rules.source_event?.title || (rules.is_attendance_expected ? 'Regular School Day' : 'Weekly holiday') };
  }
  events = events.filter(e => e.status !== 'COMPLETED' && (!e.end_date || formatYMD(e.end_date) >= date));

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
