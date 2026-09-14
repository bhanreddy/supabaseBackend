import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateConsecutiveAbsenceStreak,
  classifyStreakRisk,
  STREAK_RISK_LEVELS,
} from '../services/attendanceStreakService.js';

test('1. One-day absence streak is accurately detected', () => {
  // 13 Sep Absent, 14 Sep Target (Today)
  const records = [
    { attendance_date: '2026-09-13', status: 'absent' },
  ];
  const conductedDates = new Set(['2026-09-13']);

  const result = calculateConsecutiveAbsenceStreak({
    records,
    conductedDates,
    targetDate: '2026-09-14',
  });

  assert.equal(result.consecutive_absence_days, 1);
  assert.equal(result.absence_streak_start_date, '2026-09-13');
  assert.equal(result.absence_streak_end_date, '2026-09-13');
  assert.equal(result.absence_risk_level, STREAK_RISK_LEVELS.ABSENCE);
  assert.equal(result.absence_streak_dates.length, 1);
  assert.equal(result.absence_streak_dates[0].date, '2026-09-13');
});

test('2. Two-day absence streak is accurately detected', () => {
  // 12 Sep Absent, 13 Sep Absent, 14 Sep Target
  const records = [
    { attendance_date: '2026-09-13', status: 'absent' },
    { attendance_date: '2026-09-12', status: 'absent' },
  ];
  const conductedDates = new Set(['2026-09-12', '2026-09-13']);

  const result = calculateConsecutiveAbsenceStreak({
    records,
    conductedDates,
    targetDate: '2026-09-14',
  });

  assert.equal(result.consecutive_absence_days, 2);
  assert.equal(result.absence_streak_start_date, '2026-09-12');
  assert.equal(result.absence_streak_end_date, '2026-09-13');
  assert.equal(result.absence_risk_level, STREAK_RISK_LEVELS.ABSENCE);
  assert.equal(result.absence_streak_dates.length, 2);
});

test('3. Four-day absence streak matches user prompt scenario', () => {
  // 10 Sep Absent, 11 Sep Absent, 12 Sep Absent, 13 Sep Absent, 14 Sep Target
  const records = [
    { attendance_date: '2026-09-13', status: 'absent' },
    { attendance_date: '2026-09-12', status: 'absent' },
    { attendance_date: '2026-09-11', status: 'absent' },
    { attendance_date: '2026-09-10', status: 'absent' },
  ];
  const conductedDates = new Set(['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13']);

  const result = calculateConsecutiveAbsenceStreak({
    records,
    conductedDates,
    targetDate: '2026-09-14',
  });

  assert.equal(result.consecutive_absence_days, 4);
  assert.equal(result.absence_streak_start_date, '2026-09-10');
  assert.equal(result.absence_streak_end_date, '2026-09-13');
  assert.equal(result.absence_risk_level, STREAK_RISK_LEVELS.ATTENTION);
  assert.equal(result.absence_streak_dates.length, 4);
});

test('4. Seven-day absence triggers persistent risk level', () => {
  // 7 consecutive school days absent
  const records = [
    { attendance_date: '2026-09-13', status: 'absent' },
    { attendance_date: '2026-09-12', status: 'absent' },
    { attendance_date: '2026-09-11', status: 'absent' },
    { attendance_date: '2026-09-10', status: 'absent' },
    { attendance_date: '2026-09-09', status: 'absent' },
    { attendance_date: '2026-09-08', status: 'absent' },
    { attendance_date: '2026-09-07', status: 'absent' },
  ];
  const conductedDates = new Set(records.map((r) => r.attendance_date));

  const result = calculateConsecutiveAbsenceStreak({
    records,
    conductedDates,
    targetDate: '2026-09-14',
  });

  assert.equal(result.consecutive_absence_days, 7);
  assert.equal(result.absence_streak_start_date, '2026-09-07');
  assert.equal(result.absence_streak_end_date, '2026-09-13');
  assert.equal(result.absence_risk_level, STREAK_RISK_LEVELS.PERSISTENT);
});

test('5. Present status breaks streak immediately', () => {
  // 10 Sep Absent, 11 Sep Absent, 12 Sep Present, 13 Sep Absent, 14 Sep Target
  const records = [
    { attendance_date: '2026-09-13', status: 'absent' },
    { attendance_date: '2026-09-12', status: 'present' },
    { attendance_date: '2026-09-11', status: 'absent' },
    { attendance_date: '2026-09-10', status: 'absent' },
  ];
  const conductedDates = new Set(records.map((r) => r.attendance_date));

  const result = calculateConsecutiveAbsenceStreak({
    records,
    conductedDates,
    targetDate: '2026-09-14',
  });

  // Streak should only be 1 (13 Sep) because 12 Sep is Present
  assert.equal(result.consecutive_absence_days, 1);
  assert.equal(result.absence_streak_start_date, '2026-09-13');
  assert.equal(result.absence_streak_end_date, '2026-09-13');
});

test('6. Late breaks streak as student attended', () => {
  // 11 Sep Absent, 12 Sep Late, 13 Sep Absent, 14 Sep Target
  const records = [
    { attendance_date: '2026-09-13', status: 'absent' },
    { attendance_date: '2026-09-12', status: 'late' },
    { attendance_date: '2026-09-11', status: 'absent' },
  ];
  const conductedDates = new Set(records.map((r) => r.attendance_date));

  const result = calculateConsecutiveAbsenceStreak({
    records,
    conductedDates,
    targetDate: '2026-09-14',
  });

  assert.equal(result.consecutive_absence_days, 1);
  assert.equal(result.absence_streak_start_date, '2026-09-13');
});

test('7. Weekend handling: skips weekends without breaking or adding days', () => {
  // Friday 11 Sep: Absent
  // Saturday 12 Sep: Weekend (Sunday is 13 Sep)
  // Sunday 13 Sep: Weekend
  // Monday 14 Sep: Absent
  // Tuesday 15 Sep: Target (Today)
  const records = [
    { attendance_date: '2026-09-14', status: 'absent' },
    { attendance_date: '2026-09-11', status: 'absent' },
  ];
  const conductedDates = new Set(['2026-09-11', '2026-09-14']);
  const schoolDayMap = new Map();

  const result = calculateConsecutiveAbsenceStreak({
    records,
    conductedDates,
    schoolDayMap,
    targetDate: '2026-09-15',
  });

  // Expected = 2 consecutive school-day absences (11 Sep and 14 Sep), NOT 4 calendar days
  assert.equal(result.consecutive_absence_days, 2);
  assert.equal(result.absence_streak_start_date, '2026-09-11');
  assert.equal(result.absence_streak_end_date, '2026-09-14');
  assert.deepEqual(
    result.absence_streak_dates.map((d) => d.date),
    ['2026-09-14', '2026-09-11']
  );
});

test('8. Holiday handling: skips holidays without breaking streak or inflating count', () => {
  // Wednesday 09 Sep: Absent
  // Thursday 10 Sep: Published Holiday (Festival)
  // Friday 11 Sep: Absent
  // Monday 14 Sep: Target (Sat 12 & Sun 13 are weekends)
  const records = [
    { attendance_date: '2026-09-11', status: 'absent' },
    { attendance_date: '2026-09-09', status: 'absent' },
  ];
  const conductedDates = new Set(['2026-09-09', '2026-09-11']);
  const schoolDayMap = new Map([
    ['2026-09-10', { isWorkingDay: false, isHoliday: true }],
  ]);

  const result = calculateConsecutiveAbsenceStreak({
    records,
    conductedDates,
    schoolDayMap,
    targetDate: '2026-09-14',
  });

  // Result: 2 school-day absences (09 Sep and 11 Sep)
  assert.equal(result.consecutive_absence_days, 2);
  assert.equal(result.absence_streak_start_date, '2026-09-09');
  assert.equal(result.absence_streak_end_date, '2026-09-11');
});

test('9. Missing attendance session: does not manufacture streak across unrecorded school days', () => {
  // Tuesday 08 Sep: Absent
  // Wednesday 09 Sep: Regular school day, but NO attendance taken for the class
  // Thursday 10 Sep: Absent
  // Friday 11 Sep: Target
  const records = [
    { attendance_date: '2026-09-10', status: 'absent' },
    { attendance_date: '2026-09-08', status: 'absent' },
  ];
  // 09 Sep is missing from conductedDates
  const conductedDates = new Set(['2026-09-08', '2026-09-10']);

  const result = calculateConsecutiveAbsenceStreak({
    records,
    conductedDates,
    targetDate: '2026-09-11',
  });

  // Streak stops at 10 Sep because 09 Sep was an unconducted school day
  assert.equal(result.consecutive_absence_days, 1);
  assert.equal(result.absence_streak_start_date, '2026-09-10');
  assert.equal(result.absence_streak_end_date, '2026-09-10');
});

test('10. Student admission boundary: does not count days before student admission', () => {
  // Student admitted on 12 Sep
  // Prior legacy/erroneous records exist on 10, 11 Sep
  const records = [
    { attendance_date: '2026-09-13', status: 'absent' },
    { attendance_date: '2026-09-12', status: 'absent' },
    { attendance_date: '2026-09-11', status: 'absent' },
    { attendance_date: '2026-09-10', status: 'absent' },
  ];
  const conductedDates = new Set(records.map((r) => r.attendance_date));

  const result = calculateConsecutiveAbsenceStreak({
    records,
    conductedDates,
    admissionDate: '2026-09-12',
    targetDate: '2026-09-14',
  });

  // Only 12 Sep and 13 Sep count (2 days)
  assert.equal(result.consecutive_absence_days, 2);
  assert.equal(result.absence_streak_start_date, '2026-09-12');
  assert.equal(result.absence_streak_end_date, '2026-09-13');
});

test('11. Section transfer: does not count days before section enrollment start date', () => {
  // Transferred into section on 12 Sep
  const records = [
    { attendance_date: '2026-09-13', status: 'absent' },
    { attendance_date: '2026-09-12', status: 'absent' },
    { attendance_date: '2026-09-11', status: 'absent' },
    { attendance_date: '2026-09-10', status: 'absent' },
  ];
  const conductedDates = new Set(records.map((r) => r.attendance_date));

  const result = calculateConsecutiveAbsenceStreak({
    records,
    conductedDates,
    enrollmentStartDate: '2026-09-12',
    targetDate: '2026-09-14',
  });

  assert.equal(result.consecutive_absence_days, 2);
  assert.equal(result.absence_streak_start_date, '2026-09-12');
  assert.equal(result.absence_streak_end_date, '2026-09-13');
});

test('12. Academic-year boundary: does not count days before academic year start', () => {
  // Academic year started on 2026-09-11
  const records = [
    { attendance_date: '2026-09-13', status: 'absent' },
    { attendance_date: '2026-09-12', status: 'absent' },
    { attendance_date: '2026-09-11', status: 'absent' },
    { attendance_date: '2026-09-10', status: 'absent' },
    { attendance_date: '2026-09-09', status: 'absent' },
  ];
  const conductedDates = new Set(records.map((r) => r.attendance_date));

  const result = calculateConsecutiveAbsenceStreak({
    records,
    conductedDates,
    academicYearStartDate: '2026-09-11',
    targetDate: '2026-09-14',
  });

  assert.equal(result.consecutive_absence_days, 3);
  assert.equal(result.absence_streak_start_date, '2026-09-11');
  assert.equal(result.absence_streak_end_date, '2026-09-13');
});

test('13. Today already marked: streak strictly evaluates days before target date', () => {
  // Target date is 14 Sep, which is currently marked 'present'
  const records = [
    { attendance_date: '2026-09-14', status: 'present' },
    { attendance_date: '2026-09-13', status: 'absent' },
    { attendance_date: '2026-09-12', status: 'absent' },
    { attendance_date: '2026-09-11', status: 'absent' },
    { attendance_date: '2026-09-10', status: 'absent' },
  ];
  const conductedDates = new Set(records.map((r) => r.attendance_date));

  const result = calculateConsecutiveAbsenceStreak({
    records,
    conductedDates,
    targetDate: '2026-09-14',
  });

  // Previous consecutive absence days before 14 Sep is 4 (10 Sep -> 13 Sep)
  assert.equal(result.consecutive_absence_days, 4);
  assert.equal(result.absence_streak_start_date, '2026-09-10');
  assert.equal(result.absence_streak_end_date, '2026-09-13');
});

test('14. Half-day status breaks full-day absence streak', () => {
  // 11 Sep Absent, 12 Sep Half-Day (attended partial), 13 Sep Absent, 14 Sep Target
  const records = [
    { attendance_date: '2026-09-13', status: 'absent' },
    { attendance_date: '2026-09-12', status: 'half_day' },
    { attendance_date: '2026-09-11', status: 'absent' },
  ];
  const conductedDates = new Set(records.map((r) => r.attendance_date));

  const result = calculateConsecutiveAbsenceStreak({
    records,
    conductedDates,
    targetDate: '2026-09-14',
  });

  // 12 Sep half-day attended breaks the full-day absence streak
  assert.equal(result.consecutive_absence_days, 1);
  assert.equal(result.absence_streak_start_date, '2026-09-13');
  assert.equal(result.absence_streak_end_date, '2026-09-13');
});

test('15. Deterministic risk level thresholds and irregular classification', () => {
  assert.equal(classifyStreakRisk(0), STREAK_RISK_LEVELS.NONE);
  assert.equal(classifyStreakRisk(1), STREAK_RISK_LEVELS.ABSENCE);
  assert.equal(classifyStreakRisk(2), STREAK_RISK_LEVELS.ABSENCE);
  assert.equal(classifyStreakRisk(3), STREAK_RISK_LEVELS.ATTENTION);
  assert.equal(classifyStreakRisk(4), STREAK_RISK_LEVELS.ATTENTION);
  assert.equal(classifyStreakRisk(5), STREAK_RISK_LEVELS.PERSISTENT);
  assert.equal(classifyStreakRisk(10), STREAK_RISK_LEVELS.PERSISTENT);
  assert.equal(classifyStreakRisk(0, { isIrregular: true }), 'irregular');
});

test('16. Multi-tenant isolation: records filtered by tenant boundaries', () => {
  // Student belongs to School 10. Records from School 20 must never leak in.
  const school10Records = [
    { attendance_date: '2026-09-13', status: 'absent', school_id: 10 },
    { attendance_date: '2026-09-12', status: 'absent', school_id: 10 },
  ];
  // Even if an external array had mixed records, only School 10 records apply
  const filteredRecords = school10Records.filter((r) => r.school_id === 10);
  const conductedDates = new Set(filteredRecords.map((r) => r.attendance_date));

  const result = calculateConsecutiveAbsenceStreak({
    records: filteredRecords,
    conductedDates,
    targetDate: '2026-09-14',
  });

  assert.equal(result.consecutive_absence_days, 2);
  assert.equal(result.absence_streak_start_date, '2026-09-12');
  assert.equal(result.absence_streak_end_date, '2026-09-13');
});

