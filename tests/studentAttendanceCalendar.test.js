import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ATTENDANCE_POLICY, buildAttendanceReport, dateRange, validDate, schoolToday, validatePolicy, resolveDayRules } from '../services/attendanceCalendarModel.js';
import { audiencesOverlap } from '../services/attendanceCalendarPublication.js';
import { nextCalendarAlertTime, materiallyChangedCalendarEvent } from '../services/attendanceCalendarAlerts.js';
import { schoolEventTimestamp, schoolEventClock } from '../services/calendarTime.js';

const enrollment = { id: 'enrollment-a', class_id: 'class-a', class_section_id: 'section-a', start_date: '2026-06-01', end_date: '2027-04-30', class_name: 'Class 5', section_name: 'A' };
const record = (date, status) => ({ attendance_date: date, status, student_enrollment_id: enrollment.id, marked_at: `${date}T09:00:00Z`, teacher_name: 'Private Teacher Name', remarks: 'Private note' });
const event = (type, extra = {}) => ({ id: 'event-1', title: type, event_type: type, start_date: '2026-11-16', end_date: '2026-11-16', targets: [{ target_type: 'ENTIRE_SCHOOL', target_id: 'ALL' }], ...extra });
const report = extra => buildAttendanceReport({ start: '2026-11-16', end: '2026-11-20', today: '2026-11-20', enrollments: [enrollment], studentId: 'student-a', userId: 'parent-a', ...extra });

test('QA-01/02/03/17: weighted outcomes and missing submissions stay distinct', () => {
  const result = report({ records: [record('2026-11-16', 'present'), record('2026-11-17', 'absent'), record('2026-11-18', 'half_day'), record('2026-11-19', 'late')] });
  assert.equal(result.summary.attendance_percentage, 62.5);
  assert.equal(result.summary.not_marked, 1); assert.equal(result.summary.absent, 1);
  assert.equal(result.summary.marked_days, 4); assert.equal(result.days[4].attendance_display_status, 'NOT_MARKED');
  assert.equal(result.days[0].attendance.teacher_name, undefined); assert.equal(result.days[0].attendance.remarks, undefined);
});
test('QA-04: a refreshed submission updates every aggregate', () => {
  const first = report({}); const next = report({ records: [record('2026-11-16', 'present')] });
  assert.equal(first.summary.not_marked - next.summary.not_marked, 1); assert.equal(next.months[0].present, next.summary.present);
});
test('QA-05: configured weekly holidays never become pending', () => {
  const result = report({ start: '2026-11-15', end: '2026-11-16' });
  assert.equal(result.days[0].day_type, 'WEEKLY_HOLIDAY'); assert.equal(result.summary.not_marked, 1); assert.equal(result.summary.holidays, 1);
});
test('QA-06: class-only and section-only holidays do not close other classes', () => {
  for (const target of [{ target_type: 'CLASS', target_id: 'class-b' }, { target_type: 'SECTION', target_id: 'section-b' }]) {
    assert.equal(report({ events: [event('HOLIDAY', { targets: [target] })] }).days[0].is_attendance_expected, true);
  }
  assert.equal(report({ events: [event('HOLIDAY', { targets: [{ target_type: 'CLASS', target_id: 'class-a' }] })] }).days[0].is_attendance_expected, false);
});
test('QA-07/22: special working days require an explicit holiday override', () => {
  const holiday = event('HOLIDAY'); const special = event('SPECIAL_WORKING_DAY', { id: 'special', override_event_ids: ['event-1'] });
  assert.equal(resolveDayRules('2026-11-16', [holiday, special]).day_type, 'SPECIAL_WORKING_DAY');
  const unresolved = resolveDayRules('2026-11-16', [holiday, { ...special, override_event_ids: [] }]);
  assert.equal(unresolved.is_attendance_expected, false); assert.equal(unresolved.conflict, true);
  const emergency = resolveDayRules('2026-11-16', [{ ...holiday, holiday_type: 'EMERGENCY_HOLIDAY' }, special]);
  assert.equal(emergency.day_type, 'EMERGENCY_CLOSURE'); assert.equal(emergency.is_attendance_expected, false);
});
test('QA-08/09: future instructional dates have no attendance or pending entries', () => {
  const result = report({ today: '2026-11-16', records: [record('2026-11-17', 'absent')], events: [event('EXAM', { start_date: '2026-11-17', end_date: '2026-11-17' })] });
  assert.equal(result.days[1].attendance, null); assert.equal(result.days[1].attendance_display_status, 'UPCOMING');
  assert.equal(result.days[1].events[0].event_type, 'EXAM'); assert.equal(result.summary.not_marked, 1); assert.equal(result.summary.remaining_working_days, 4);
});
test('QA-10/11: events coexist with attendance without changing the result', () => {
  const result = report({ records: [record('2026-11-16', 'present')], events: [event('EXAM'), event('SCHOOL_EVENT', { id: 'event-2' })] });
  assert.equal(result.days[0].attendance.status, 'present'); assert.equal(result.days[0].events.length, 2); assert.equal(result.summary.present, 1);
});
test('QA-12/13: month-spanning holidays and clipped month totals reconcile', () => {
  const result = report({ start: '2026-10-30', end: '2026-11-03', events: [event('HOLIDAY', { start_date: '2026-10-31', end_date: '2026-11-02' })] });
  assert.equal(result.months.length, 2); assert.equal(result.summary.holidays, 3);
  for (const key of ['scheduled_working_days', 'marked_days', 'not_marked', 'holidays']) assert.equal(result.months.reduce((n, m) => n + m[key], 0), result.summary[key]);
});
test('QA-14/19: invalid dates and reversed ranges fail, leap years and six-week months work', () => {
  assert.equal(validDate('2026-02-29'), false); assert.equal(validDate('2032-02-29'), true);
  assert.throws(() => dateRange('2026-11-20', '2026-11-01')); assert.throws(() => dateRange('2026-01-01', '2027-12-01'));
  assert.equal(dateRange('2032-02-01', '2032-02-29').length, 29);
  assert.equal(dateRange('2026-08-01', '2026-08-31').length, 31);
});
test('QA-15/16: no-data percentage is null and a pending period is provisional', () => {
  const result = report({}); assert.equal(result.summary.attendance_percentage, null); assert.equal(result.summary.report_status, 'PROVISIONAL');
});
test('QA-21: finalization requires explicit coverage and reopens when a mark is removed', () => {
  const finalized = { status: 'FINALIZED', from_date: '2026-11-16', to_date: '2026-11-20' };
  const records = dateRange('2026-11-16', '2026-11-20').map(d => record(d, 'present'));
  assert.equal(report({ records }).summary.report_status, 'PROVISIONAL');
  assert.equal(report({ records, finalizations: [finalized] }).summary.report_status, 'FINALIZED');
  assert.equal(report({ records: records.slice(1), finalizations: [finalized] }).summary.report_status, 'PROVISIONAL');
});
test('historical class transfers and partial enrollment use the membership on each date', () => {
  const result = report({ enrollments: [{ ...enrollment, end_date: '2026-11-17' }, { ...enrollment, id: 'enrollment-b', class_id: 'class-b', start_date: '2026-11-18', end_date: '2026-11-19' }],
    events: [event('HOLIDAY', { start_date: '2026-11-16', end_date: '2026-11-20', targets: [{ target_type: 'CLASS', target_id: 'class-a' }] })] });
  assert.equal(result.days[0].is_attendance_expected, false); assert.equal(result.days[2].is_attendance_expected, true);
  assert.equal(result.days[4].day_type, 'OUTSIDE_ENROLLMENT'); assert.equal(result.summary.scheduled_working_days, 2);
});
test('effective-dated weekly schedules and half-day weights preserve history', () => {
  const result = report({ policies: [{ ...DEFAULT_ATTENDANCE_POLICY, id: 'new', effective_from: '2026-11-18', half_day_weight: 0.25, working_weekdays: [0, 1, 2, 3, 4] }],
    records: [record('2026-11-16', 'half_day'), record('2026-11-18', 'half_day')] });
  assert.equal(result.summary.attendance_percentage, 37.5); assert.equal(result.days[4].day_type, 'WEEKLY_HOLIDAY');
});
test('school-local midnight and daylight-saving boundaries do not use device/server dates', () => {
  assert.equal(schoolToday('Asia/Kolkata', new Date('2026-11-15T19:00:00Z')), '2026-11-16');
  assert.equal(schoolToday('America/New_York', new Date('2026-11-01T03:30:00Z')), '2026-10-31');
});
test('event times are stored in UTC and shown in the configured school timezone', () => {
  assert.equal(schoolEventTimestamp('2026-11-18', '09:00', 'Asia/Kolkata'), '2026-11-18T03:30:00.000Z');
  assert.equal(schoolEventClock('2026-11-18T03:30:00Z', 'Asia/Kolkata'), '09:00');
  assert.equal(schoolEventTimestamp('2026-11-18', '00:00', 'Asia/Kolkata'), '2026-11-17T18:30:00.000Z');
});
test('submission cutoffs affect staff overdue tracking without converting a pending day', () => {
  const result = report({ schoolClock: '17:30', policies: [{ ...DEFAULT_ATTENDANCE_POLICY, effective_from: '2026-11-01', submission_cutoff: '17:00' }] });
  assert.equal(result.days.at(-1).submission_overdue, true); assert.equal(result.days.at(-1).attendance_display_status, 'NOT_MARKED');
  assert.equal(result.summary.absent, 0);
});
test('retrospective holidays retain evidence but exclude old marks and block finalization', () => {
  const result = report({ records: [record('2026-11-16', 'present')], events: [event('HOLIDAY')] });
  assert.equal(result.days[0].has_record_conflict, true); assert.equal(result.summary.marked_days, 0); assert.equal(result.summary.conflicts, 1);
});
test('policy validation rejects invalid weekdays, weights and cutoffs', () => {
  const policy = { ...DEFAULT_ATTENDANCE_POLICY, effective_from: '2026-11-16' };
  assert.throws(() => validatePolicy({ ...policy, working_weekdays: [1, 1] }));
  assert.throws(() => validatePolicy({ ...policy, half_day_weight: 1.1 }));
  assert.throws(() => validatePolicy({ ...policy, submission_cutoff: '25:00' }));
  assert.throws(() => validatePolicy({ ...policy, quiet_start: '21:00', quiet_end: null }));
  assert.equal(validatePolicy(policy).half_day_weight, 0.5);
});
test('publication conflicts distinguish unrelated classes and class/section overlaps', () => {
  assert.equal(audiencesOverlap([{ target_type: 'CLASS', target_id: 'a' }], [{ target_type: 'CLASS', target_id: 'b' }]), false);
  assert.equal(audiencesOverlap([{ target_type: 'CLASS', target_id: 'a' }], [{ target_type: 'SECTION', target_id: 's' }], [{ id: 's', class_id: 'a' }]), true);
});
test('calendar alerts honor overnight quiet hours and ignore immaterial edits', () => {
  const now = new Date('2026-11-16T17:30:00Z');
  assert.equal(nextCalendarAlertTime(now, 'Asia/Kolkata', '21:00', '07:00').toISOString(), '2026-11-17T01:30:00.000Z');
  assert.equal(nextCalendarAlertTime(now, 'Asia/Kolkata', null, null), now);
  assert.equal(materiallyChangedCalendarEvent({ title: 'Exam', updated_at: 2 }, { title: 'Exam', updated_at: 1 }), false);
  assert.equal(materiallyChangedCalendarEvent({ title: 'Exam', end_date: '2026-11-18' }, { title: 'Exam', end_date: '2026-11-17' }), true);
});
