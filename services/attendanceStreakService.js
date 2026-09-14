import sql from '../db.js';
import { formatYMD, getWeekdayName } from './workingDayResolver.js';
import { calculateAttendancePercentage } from './attendanceRiskService.js';

export const STREAK_RISK_LEVELS = {
  NONE: 'none',
  ABSENCE: 'absence',       // 1-2 days
  ATTENTION: 'attention',   // 3-4 days
  PERSISTENT: 'persistent', // 5+ days
};

/**
 * Deterministic risk level from consecutive absence count.
 */
export function classifyStreakRisk(consecutiveDays, { isIrregular = false } = {}) {
  const days = Number(consecutiveDays || 0);
  if (days >= 5) return STREAK_RISK_LEVELS.PERSISTENT;
  if (days >= 3) return STREAK_RISK_LEVELS.ATTENTION;
  if (days >= 1) return STREAK_RISK_LEVELS.ABSENCE;
  if (isIrregular) return 'irregular';
  return STREAK_RISK_LEVELS.NONE;
}

/**
 * Format a Date object to YYYY-MM-DD without UTC timezone drift.
 */
function toLocalDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Subtract N calendar days from a YYYY-MM-DD string.
 */
function subtractDays(dateStr, numDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - numDays);
  return toLocalDateStr(dt);
}

/**
 * Pure calculation of consecutive school-day absences working backwards from targetDate.
 *
 * @param {Object} params
 * @param {Array<{ attendance_date: string, status: string, morning_status?: string, afternoon_status?: string }>} params.records
 * @param {Set<string>} params.conductedDates Set of dates (YYYY-MM-DD) where attendance was taken for this class/school
 * @param {Map<string, { isWorkingDay: boolean, isHoliday: boolean, isSpecialWorkingDay?: boolean }>} params.schoolDayMap Map of date -> calendar status
 * @param {string} [params.admissionDate] Student's admission date YYYY-MM-DD
 * @param {string} [params.enrollmentStartDate] Section enrollment start date YYYY-MM-DD
 * @param {string} [params.academicYearStartDate] Current academic year start date YYYY-MM-DD
 * @param {string} params.targetDate The date being marked YYYY-MM-DD (streak strictly evaluates days before this date)
 * @param {number} [params.maxLookbackDays=60] Max calendar days to scan backward
 * @returns {{
 *   consecutive_absence_days: number,
 *   absence_streak_start_date: string|null,
 *   absence_streak_end_date: string|null,
 *   absence_streak_dates: Array<{ date: string, status: string }>,
 *   absence_risk_level: string,
 *   is_irregular: boolean,
 *   monthly_attendance_percentage: number,
 *   monthly_absent_count: number
 * }}
 */
export function calculateConsecutiveAbsenceStreak({
  records = [],
  conductedDates = new Set(),
  schoolDayMap = new Map(),
  admissionDate = null,
  enrollmentStartDate = null,
  academicYearStartDate = null,
  targetDate,
  maxLookbackDays = 60,
}) {
  if (!targetDate) {
    throw new Error('targetDate is required for calculateConsecutiveAbsenceStreak');
  }

  const normTarget = formatYMD(targetDate);
  const normAdmission = admissionDate ? formatYMD(admissionDate) : null;
  const normEnrollmentStart = enrollmentStartDate ? formatYMD(enrollmentStartDate) : null;
  const normYearStart = academicYearStartDate ? formatYMD(academicYearStartDate) : null;

  // Build record map: date -> record
  const recordByDate = new Map();
  for (const r of records) {
    const d = formatYMD(r.attendance_date);
    if (d) recordByDate.set(d, r);
  }

  // Monthly stats calculation (within 30 days lookback or current calendar month up to targetDate)
  const targetMonthPrefix = normTarget.slice(0, 7); // YYYY-MM
  let monthPresent = 0;
  let monthLate = 0;
  let monthHalfDay = 0;
  let monthAbsent = 0;

  // Fallback 30-day stats if current month has very few/no records
  let windowPresent = 0;
  let windowLate = 0;
  let windowHalfDay = 0;
  let windowAbsent = 0;

  const thirtyDaysPrior = subtractDays(normTarget, 30);

  for (const [d, rec] of recordByDate.entries()) {
    if (d > normTarget) continue;
    const status = String(rec.status || '').toLowerCase();

    // In current calendar month
    if (d.startsWith(targetMonthPrefix)) {
      if (status === 'present') monthPresent++;
      else if (status === 'late') monthLate++;
      else if (status === 'half_day') monthHalfDay++;
      else if (status === 'absent') monthAbsent++;
    }

    // In 30-day window
    if (d >= thirtyDaysPrior && d < normTarget) {
      if (status === 'present') windowPresent++;
      else if (status === 'late') windowLate++;
      else if (status === 'half_day') windowHalfDay++;
      else if (status === 'absent') windowAbsent++;
    }
  }

  const monthTotal = monthPresent + monthLate + monthHalfDay + monthAbsent;
  const windowTotal = windowPresent + windowLate + windowHalfDay + windowAbsent;

  let monthlyAttendancePercentage = 100.0;
  if (monthTotal >= 3) {
    monthlyAttendancePercentage = calculateAttendancePercentage({
      present: monthPresent,
      late: monthLate,
      half_day: monthHalfDay,
      total: monthTotal,
    });
  } else if (windowTotal > 0) {
    monthlyAttendancePercentage = calculateAttendancePercentage({
      present: windowPresent,
      late: windowLate,
      half_day: windowHalfDay,
      total: windowTotal,
    });
  }

  const monthlyAbsentCount = monthTotal >= 3 ? monthAbsent : windowAbsent;
  const isIrregular = monthlyAbsentCount >= 5;

  // ─── Consecutive School-Day Absence Backward Scan ─────────────────────────
  let consecutiveAbsenceDays = 0;
  let streakStartDate = null;
  let streakEndDate = null;
  const streakDates = [];

  // Earliest valid date boundary (latest start boundary wins)
  const effectiveStartDate = [normAdmission, normEnrollmentStart, normYearStart]
    .filter(Boolean)
    .sort()
    .pop() || null;

  for (let offset = 1; offset <= maxLookbackDays; offset++) {
    const dateStr = subtractDays(normTarget, offset);

    // Boundary check: do not scan past admission date or section transfer date or year start
    if (effectiveStartDate && dateStr < effectiveStartDate) {
      break;
    }

    const dayMeta = schoolDayMap.get(dateStr);
    const dayOfWeek = getWeekdayName(dateStr);
    const isSpecialWorkingDay = dayMeta?.isSpecialWorkingDay === true;
    const isHoliday = (dayMeta?.isHoliday === true) && !isSpecialWorkingDay;
    const isWeekend = (dayOfWeek === 'sunday' || dayOfWeek === 'saturday' || dayMeta?.isWorkingDay === false) && !isSpecialWorkingDay;

    // Check if attendance was explicitly conducted for the class on this day
    const wasAttendanceConducted = conductedDates.has(dateStr);

    // If it's a Weekend or published Holiday where no attendance was taken:
    // It is a valid non-school day -> skip without breaking streak and without counting as absence
    if ((isWeekend || isHoliday) && !wasAttendanceConducted) {
      continue;
    }

    // If it's a regular school day, but no attendance was conducted for this class:
    // Missing session rule: Never manufacture absence from missing data.
    // An unconducted day cannot be counted as absence, and stops the continuous absence streak.
    if (!wasAttendanceConducted) {
      break;
    }

    // Attendance was conducted for the class on this date.
    // Check this student's record:
    const rec = recordByDate.get(dateStr);
    if (!rec || !rec.status) {
      // Student has no record on a conducted school day -> cannot assume absent -> break
      break;
    }

    const status = String(rec.status).toLowerCase();

    if (status === 'absent') {
      consecutiveAbsenceDays++;
      if (!streakEndDate) streakEndDate = dateStr;
      streakStartDate = dateStr;
      streakDates.push({ date: dateStr, status: 'absent' });
    } else if (status === 'present' || status === 'late' || status === 'half_day') {
      // Student attended (or attended partially). Streak ends immediately!
      break;
    } else {
      // Unknown or other status -> stop streak safely
      break;
    }
  }

  const riskLevel = classifyStreakRisk(consecutiveAbsenceDays, { isIrregular });

  return {
    consecutive_absence_days: consecutiveAbsenceDays,
    absence_streak_start_date: streakStartDate,
    absence_streak_end_date: streakEndDate,
    absence_streak_dates: streakDates,
    absence_risk_level: riskLevel,
    is_irregular: isIrregular,
    monthly_attendance_percentage: monthlyAttendancePercentage,
    monthly_absent_count: monthlyAbsentCount,
  };
}

/**
 * Enriches a student roster for a class section with consecutive absence intelligence.
 * Performs a single optimized batch query for all students in the class.
 *
 * @param {Function} dbClient postgres sql client
 * @param {Object} params
 * @param {number} params.schoolId
 * @param {string} params.classSectionId
 * @param {string} params.targetDate YYYY-MM-DD
 * @param {Array<Object>} params.students Array of student objects with student_id, enrollment_id
 * @param {number} [params.lookbackDays=60]
 * @returns {Promise<Array<Object>>} Enriched students
 */
export async function enrichStudentsWithStreaks(dbClient, {
  schoolId,
  classSectionId,
  targetDate,
  students = [],
  lookbackDays = 60,
}) {
  if (!students || students.length === 0) return [];
  const normDate = formatYMD(targetDate);
  const enrollmentIds = students.map((s) => s.enrollment_id).filter(Boolean);
  if (enrollmentIds.length === 0) return students;

  const minDateStr = subtractDays(normDate, lookbackDays);

  // 1. Single query: Fetch all past attendance records for these enrollments
  const attendanceRows = await dbClient`
    SELECT
      da.student_enrollment_id,
      da.attendance_date::text AS attendance_date,
      da.status,
      da.morning_status,
      da.afternoon_status
    FROM daily_attendance da
    WHERE da.school_id = ${schoolId}
      AND da.student_enrollment_id = ANY(${enrollmentIds}::uuid[])
      AND da.attendance_date <= ${normDate}::date
      AND da.attendance_date >= ${minDateStr}::date
      AND da.deleted_at IS NULL
    ORDER BY da.attendance_date DESC
  `;

  // 2. Fetch calendar events in this period (holidays, special working days)
  const calendarEvents = await dbClient`
    SELECT
      id, title, event_type, holiday_type, attendance_enabled,
      start_date::text AS start_date,
      end_date::text AS end_date
    FROM calendar_events
    WHERE school_id = ${schoolId}
      AND status = 'PUBLISHED'
      AND deleted_at IS NULL
      AND start_date <= ${normDate}::date
      AND end_date >= ${minDateStr}::date
  `;

  // 3. Fetch active academic year start date
  const [academicYear] = await dbClient`
    SELECT start_date::text AS start_date
    FROM academic_years
    WHERE school_id = ${schoolId}
      AND ${normDate}::date BETWEEN start_date AND end_date
      AND deleted_at IS NULL
    LIMIT 1
  `;
  const academicYearStartDate = academicYear?.start_date || null;

  // Build conducted dates set (dates where ANY student in this class had an attendance record)
  const conductedDates = new Set();
  const recordsByEnrollment = new Map();

  for (const row of attendanceRows) {
    conductedDates.add(row.attendance_date);
    if (!recordsByEnrollment.has(row.student_enrollment_id)) {
      recordsByEnrollment.set(row.student_enrollment_id, []);
    }
    recordsByEnrollment.get(row.student_enrollment_id).push(row);
  }

  // Build school day map from calendar events
  const schoolDayMap = new Map();
  for (const ev of calendarEvents) {
    const sDate = ev.start_date;
    const eDate = ev.end_date;
    const isSpecialWorking = ev.event_type === 'SPECIAL_WORKING_DAY';
    const isHoliday = ev.event_type === 'HOLIDAY' || ev.event_type === 'VACATION' || Boolean(ev.holiday_type);

    let cur = sDate;
    while (cur <= eDate && cur <= normDate) {
      const existing = schoolDayMap.get(cur) || {};
      schoolDayMap.set(cur, {
        isSpecialWorkingDay: isSpecialWorking || existing.isSpecialWorkingDay || false,
        isHoliday: isHoliday || existing.isHoliday || false,
      });
      cur = subtractDays(cur, -1); // next day
    }
  }

  // Enrich each student with streak intelligence
  return students.map((student) => {
    const enrollId = student.enrollment_id;
    const records = recordsByEnrollment.get(enrollId) || [];
    const admissionDate = student.admission_date || null;
    const enrollmentStartDate = student.start_date || null;

    const streakInfo = calculateConsecutiveAbsenceStreak({
      records,
      conductedDates,
      schoolDayMap,
      admissionDate,
      enrollmentStartDate,
      academicYearStartDate,
      targetDate: normDate,
      maxLookbackDays: lookbackDays,
    });

    return {
      ...student,
      consecutive_absence_days: streakInfo.consecutive_absence_days,
      absence_streak_start_date: streakInfo.absence_streak_start_date,
      absence_streak_end_date: streakInfo.absence_streak_end_date,
      absence_streak_dates: streakInfo.absence_streak_dates,
      absence_risk_level: streakInfo.absence_risk_level,
      is_irregular: streakInfo.is_irregular,
      monthly_attendance_percentage: streakInfo.monthly_attendance_percentage,
      monthly_absent_count: streakInfo.monthly_absent_count,
    };
  });
}
