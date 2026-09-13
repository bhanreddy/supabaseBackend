import { formatInTimeZone } from 'date-fns-tz';

export const DEFAULT_SCHOOL_TIMEZONE = 'Asia/Kolkata';

/**
 * Checks if a given calendar year is a leap year.
 * @param {number} year
 * @returns {boolean}
 */
export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

/**
 * Derives initials for fallback avatar rendering (e.g. 'Aarav Reddy' -> 'AR').
 * @param {string} [name]
 * @returns {string}
 */
export function getInitials(name) {
  if (!name || typeof name !== 'string') return '🎂';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '🎂';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Generates ISO string bounds for start and end of a given school-local calendar day.
 * @param {string} timezone
 * @param {Date} [now]
 * @returns {{
 *   timezone: string,
 *   localDate: string,
 *   year: number,
 *   month: number,
 *   day: number,
 *   isNonLeapYearFeb28: boolean,
 *   validFrom: string,
 *   validUntil: string
 * }}
 */
export function getSchoolDateContext(timezone = DEFAULT_SCHOOL_TIMEZONE, now = new Date()) {
  const safeTimezone = timezone || DEFAULT_SCHOOL_TIMEZONE;
  const localDate = formatInTimeZone(now, safeTimezone, 'yyyy-MM-dd');
  const [yearStr, monthStr, dayStr] = localDate.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  const isNonLeapYearFeb28 = !isLeapYear(year) && month === 2 && day === 28;

  // Local day window: 00:00:00 to 23:59:59.999 in school timezone
  const validFrom = `${localDate}T00:00:00${formatInTimeZone(now, safeTimezone, 'xxx')}`;
  const validUntil = `${localDate}T23:59:59.999${formatInTimeZone(now, safeTimezone, 'xxx')}`;

  return {
    timezone: safeTimezone,
    localDate,
    year,
    month,
    day,
    isNonLeapYearFeb28,
    validFrom,
    validUntil,
  };
}

/**
 * Evaluates whether a birthdate matches the target date context.
 * Standard rule: matching month + day regardless of year.
 * Leap-year rule: if born on Feb 29, in non-leap years celebrated on Feb 28.
 *
 * @param {string|Date} dobInput
 * @param {{ month: number, day: number, isNonLeapYearFeb28: boolean }} targetContext
 * @returns {boolean}
 */
export function isBirthdayMatching(dobInput, targetContext) {
  if (!dobInput) return false;
  let dobYear, dobMonth, dobDay;

  if (typeof dobInput === 'string') {
    const datePart = dobInput.trim().split(/[T ]/)[0];
    const parts = datePart.split('-');
    if (parts.length < 3) return false;
    dobYear = Number(parts[0]);
    dobMonth = Number(parts[1]);
    dobDay = Number(parts[2]);
  } else if (dobInput instanceof Date && !isNaN(dobInput.getTime())) {
    dobYear = dobInput.getUTCFullYear();
    dobMonth = dobInput.getUTCMonth() + 1;
    dobDay = dobInput.getUTCDate();
  } else {
    return false;
  }

  if (dobMonth === targetContext.month && dobDay === targetContext.day) {
    return true;
  }

  // Feb 29 on non-leap years celebrated on Feb 28
  if (targetContext.isNonLeapYearFeb28 && dobMonth === 2 && dobDay === 29) {
    return true;
  }

  return false;
}
