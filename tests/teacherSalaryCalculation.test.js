import test from 'node:test';
import assert from 'node:assert/strict';
import { fromDecimal, mul, eq, toDecimal, roundHalfUp } from '../utils/money.js';
import {
  calendarDaysInMonth,
  calculateTeacherSalary,
  reproduceTeacherSalary,
  resultsMatch,
  applicableHolidayDates,
  DEFAULT_PAYROLL_POLICY,
} from '../services/teacherSalaryCalculation.js';
import {
  assertCanRecalculate,
  assertTransition,
  authorizePayrollAction,
  canReadPayroll,
  PayrollWorkflowError,
} from '../services/teacherPayrollWorkflow.js';

function iso(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function weekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function datesInMonth(year, month) {
  const count = calendarDaysInMonth(year, month);
  return Array.from({ length: count }, (_, index) => iso(year, month, index + 1));
}

function calculateMonth({
  year,
  month,
  salary = '30000.00',
  classification = 'LOCAL',
  holidays = [],
  lates = [],
  absents = [],
  halfDays = [],
  convertedLateHalfDays = [],
  leaves = [],
  joiningDate = '2020-01-01',
  relievingDate = null,
  segments = null,
  policy = {},
  employmentType = 'FULL_TIME',
  probationEndDate = null,
  clOverride = null,
  adjustments = [],
  onDutyDates = [],
  extraAttendance = [],
  holidayCalendarPublished = true,
  classificationChangedInMonth = false,
}) {
  const salarySegments = segments || [{
    id: 'base',
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
    monthlySalary: salary,
  }];
  const attendance = [];
  for (const date of datesInMonth(year, month)) {
    if (weekday(date) === 0 || holidays.some((holiday) => holiday.date === date)) continue;
    if (date < joiningDate || (relievingDate && date > relievingDate)) continue;
    if (leaves.some((leave) => leave.status === 'approved' && date >= leave.startDate && date <= leave.endDate)) continue;
    let status = 'present';
    if (lates.includes(date)) status = 'late';
    if (absents.includes(date)) status = 'absent';
    if (halfDays.includes(date) || convertedLateHalfDays.includes(date)) status = 'half_day';
    attendance.push({
      date,
      status,
      approved: true,
      convertedFromLate: convertedLateHalfDays.includes(date),
    });
  }
  attendance.push(...extraAttendance);
  return calculateTeacherSalary({
    year,
    month,
    policy,
    holidayCalendarPublished,
    holidays,
    onDutyDates,
    adjustments,
    attendance,
    leaves,
    teacher: {
      classification,
      employmentType,
      joiningDate,
      relievingDate,
      probationEndDate,
      clOverride,
      salarySegments,
      classificationChangedInMonth,
    },
  });
}

function holiday(date, name = 'Holiday') {
  return { date, name };
}

test('calendar length is 28, 29, 30, and 31 days', () => {
  assert.equal(calendarDaysInMonth(2026, 2), 28);
  assert.equal(calendarDaysInMonth(2024, 2), 29);
  assert.equal(calendarDaysInMonth(2026, 6), 30);
  assert.equal(calendarDaysInMonth(2026, 7), 31);
});

test('full-month salary uses the calendar length and stays exact', () => {
  for (const [year, month, days] of [[2026, 2, 28], [2024, 2, 29], [2026, 6, 30], [2026, 7, 31]]) {
    const salary = `${days}000.00`;
    const holidays = datesInMonth(year, month).filter((date) => weekday(date) !== 0).slice(0, 8).map((date) => holiday(date));
    const result = calculateMonth({ year, month, salary, holidays });
    assert.equal(result.month.calendarDays, days);
    assert.equal(result.blocked, false, result.validation.map((item) => item.message).join('; '));
    assert.equal(result.grossContract, salary);
    assert.equal(result.netSalary, salary);
    assert.equal(result.attendance.attendanceBonusDays, '0');
    const perDay = fromDecimal(result.perDaySalaryUnrounded);
    assert.equal(eq(mul(perDay, fromDecimal(String(days))), fromDecimal(salary)), true);
  }
});

test('local teacher late bands are 0, 3, 4, and multiple excess lates', () => {
  const base = { year: 2026, month: 6, salary: '30000.00' };
  const none = calculateMonth(base);
  assert.equal(none.attendance.totalLates, 0);
  assert.equal(none.attendance.excessLates, 0);
  assert.equal(none.attendance.attendanceBonusDays, '1');
  assert.equal(none.netSalary, '31000.00');

  const atLimit = calculateMonth({ ...base, lates: ['2026-06-01', '2026-06-02', '2026-06-03'] });
  assert.equal(atLimit.attendance.permittedLates, 3);
  assert.equal(atLimit.attendance.excessLates, 0);
  assert.equal(atLimit.attendance.attendanceBonusDays, '1');
  assert.equal(atLimit.netSalary, '31000.00');

  const oneExcess = calculateMonth({ ...base, lates: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04'] });
  assert.equal(oneExcess.attendance.excessLates, 1);
  assert.equal(oneExcess.attendance.lateDeductionDays, '0.5');
  assert.equal(oneExcess.attendance.attendanceBonusDays, '1');
  const lateLine = oneExcess.lineItems.find((line) => line.code === 'LATE_DEDUCTION');
  assert.match(lateLine.explanation, /4 recorded lates - 3 permitted lates = 1 excess lates/);
  assert.equal(lateLine.amount, '500.00');
  assert.equal(oneExcess.netSalary, '30500.00');

  const many = calculateMonth({
    ...base,
    lates: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08', '2026-06-09'],
  });
  assert.equal(many.attendance.excessLates, 4);
  assert.equal(many.attendance.lateDeductionDays, '2');
  assert.equal(many.lineItems.find((line) => line.code === 'LATE_DEDUCTION').amount, '2000.00');
  assert.equal(many.netSalary, '29000.00');
});

test('non-local teacher late bands are 0, 5, 6, and multiple excess lates', () => {
  const base = { year: 2026, month: 6, salary: '30000.00', classification: 'NON_LOCAL' };
  const none = calculateMonth(base);
  assert.equal(none.attendance.permittedLates, 5);
  assert.equal(none.netSalary, '31000.00');

  const atLimit = calculateMonth({
    ...base,
    lates: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'],
  });
  assert.equal(atLimit.attendance.excessLates, 0);
  assert.equal(atLimit.netSalary, '31000.00');

  const oneExcess = calculateMonth({
    ...base,
    lates: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08'],
  });
  assert.equal(oneExcess.attendance.excessLates, 1);
  assert.equal(oneExcess.lineItems.find((line) => line.code === 'LATE_DEDUCTION').amount, '500.00');
  assert.equal(oneExcess.netSalary, '30500.00');

  const many = calculateMonth({
    ...base,
    lates: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08', '2026-06-09', '2026-06-10'],
  });
  assert.equal(many.attendance.excessLates, 3);
  assert.equal(many.attendance.lateDeductionDays, '1.5');
  assert.equal(many.netSalary, '29500.00');
});

test('holiday threshold disables casual leave at 8 and above', () => {
  const weekdays = datesInMonth(2026, 6).filter((date) => weekday(date) !== 0);
  const seven = calculateMonth({ year: 2026, month: 6, holidays: weekdays.slice(0, 7).map((date) => holiday(date)) });
  assert.equal(seven.attendance.officialHolidays, 7);
  assert.equal(seven.attendance.paidClEntitlement, '1');
  assert.equal(seven.attendance.attendanceBonusDays, '1');

  const eight = calculateMonth({ year: 2026, month: 6, holidays: weekdays.slice(0, 8).map((date) => holiday(date)) });
  assert.equal(eight.attendance.officialHolidays, 8);
  assert.equal(eight.attendance.paidClEntitlement, '0');
  assert.equal(eight.attendance.attendanceBonusDays, '0');
  assert.equal(eight.netSalary, '30000.00');

  const nine = calculateMonth({ year: 2026, month: 6, holidays: weekdays.slice(0, 9).map((date) => holiday(date)) });
  assert.equal(nine.attendance.officialHolidays, 9);
  assert.equal(nine.attendance.paidClEntitlement, '0');
  assert.equal(nine.attendance.attendanceBonusDays, '0');
});

test('weekly offs are not counted as holidays', () => {
  const sundays = datesInMonth(2026, 6).filter((date) => weekday(date) === 0);
  const result = calculateMonth({
    year: 2026,
    month: 6,
    holidays: sundays.map((date) => holiday(date, 'Sunday festival')),
  });
  assert.equal(result.attendance.officialHolidays, sundays.length);
  assert.equal(result.attendance.weeklyOffs, 0);
  const withoutSundayHolidays = calculateMonth({ year: 2026, month: 6 });
  assert.equal(withoutSundayHolidays.attendance.officialHolidays, 0);
  assert.equal(withoutSundayHolidays.attendance.weeklyOffs, 4);
});

test('unused casual leave pays a one-day attendance bonus and used casual leave does not', () => {
  const unused = calculateMonth({ year: 2026, month: 6 });
  assert.equal(unused.attendance.clUsed, '0');
  assert.equal(unused.attendance.attendanceBonusDays, '1');
  assert.equal(unused.lineItems.find((line) => line.code === 'ATTENDANCE_BONUS').amount, '1000.00');

  const used = calculateMonth({
    year: 2026,
    month: 6,
    leaves: [{ id: 'cl1', type: 'casual', status: 'approved', startDate: '2026-06-02', endDate: '2026-06-02' }],
  });
  assert.equal(used.attendance.clUsed, '1');
  assert.equal(used.attendance.paidClDays, '1');
  assert.equal(used.attendance.attendanceBonusDays, '0');
  assert.equal(used.totalDeductions, '0.00');
  assert.equal(used.netSalary, '30000.00');
});

test('half-day, full-day, paid, and unpaid leave deduct only the unpaid portion', () => {
  const half = calculateMonth({ year: 2026, month: 6, halfDays: ['2026-06-02'] });
  assert.equal(half.attendance.halfDayAbsences, '0.5');
  assert.equal(half.attendance.attendanceBonusDays, '0');
  assert.equal(half.netSalary, '29500.00');

  const full = calculateMonth({ year: 2026, month: 6, absents: ['2026-06-02'] });
  assert.equal(full.attendance.fullDayAbsences, '1');
  assert.equal(full.netSalary, '29000.00');

  const paid = calculateMonth({
    year: 2026,
    month: 6,
    leaves: [{ id: 'sick', type: 'sick', status: 'approved', startDate: '2026-06-02', endDate: '2026-06-02' }],
  });
  assert.equal(paid.attendance.otherPaidLeave, '1');
  assert.equal(paid.totalDeductions, '0.00');
  assert.equal(paid.netSalary, '30000.00');

  const unpaid = calculateMonth({
    year: 2026,
    month: 6,
    leaves: [{ id: 'up', type: 'unpaid', status: 'approved', startDate: '2026-06-02', endDate: '2026-06-02' }],
  });
  assert.equal(unpaid.attendance.unpaidLeave, '1');
  assert.equal(unpaid.netSalary, '29000.00');

  const ignored = calculateMonth({
    year: 2026,
    month: 6,
    absents: ['2026-06-02'],
    leaves: [
      { id: 'rej', type: 'casual', status: 'rejected', startDate: '2026-06-02', endDate: '2026-06-02' },
      { id: 'can', type: 'casual', status: 'cancelled', startDate: '2026-06-03', endDate: '2026-06-03' },
    ],
  });
  assert.equal(ignored.attendance.clUsed, '0');
  assert.equal(ignored.attendance.fullDayAbsences, '1');
  assert.equal(ignored.netSalary, '29000.00');
});

test('the admin salary treatment overrides the requested leave type', () => {
  const approvedAsCl = calculateMonth({
    year: 2026,
    month: 6,
    leaves: [{
      id: 'other-as-cl',
      type: 'other',
      payrollTreatment: 'PAID_CL',
      status: 'approved',
      startDate: '2026-06-02',
      endDate: '2026-06-02',
    }],
  });
  assert.equal(approvedAsCl.attendance.clUsed, '1');
  assert.equal(approvedAsCl.attendance.paidClDays, '1');
  assert.equal(approvedAsCl.totalDeductions, '0.00');

  const approvedWithoutCl = calculateMonth({
    year: 2026,
    month: 6,
    leaves: [{
      id: 'casual-unpaid',
      type: 'casual',
      payrollTreatment: 'UNPAID',
      status: 'approved',
      startDate: '2026-06-02',
      endDate: '2026-06-02',
    }],
  });
  assert.equal(approvedWithoutCl.attendance.clUsed, '0');
  assert.equal(approvedWithoutCl.attendance.unpaidLeave, '1');
  assert.equal(approvedWithoutCl.netSalary, '29000.00');

  const clAboveBalance = calculateMonth({
    year: 2026,
    month: 6,
    leaves: [{
      id: 'two-days-cl',
      type: 'other',
      payrollTreatment: 'PAID_CL',
      status: 'approved',
      startDate: '2026-06-02',
      endDate: '2026-06-03',
    }],
  });
  assert.equal(clAboveBalance.attendance.clUsed, '2');
  assert.equal(clAboveBalance.attendance.paidClDays, '1');
  assert.equal(clAboveBalance.attendance.excessClDays, '1');
  assert.equal(clAboveBalance.totalDeductions, '1000.00');
  assert.equal(clAboveBalance.netSalary, '29000.00');
});

test('joining and relieving are prorated and do not earn casual leave', () => {
  const joined = calculateMonth({ year: 2026, month: 6, joiningDate: '2026-06-16' });
  assert.equal(joined.employment.eligibleDays, 15);
  assert.equal(joined.grossContract, '15000.00');
  assert.equal(joined.attendance.paidClEntitlement, '0');
  assert.equal(joined.attendance.attendanceBonusDays, '0');
  assert.equal(joined.netSalary, '15000.00');
  assert.match(joined.attendance.clEntitlementReason, /full payroll month/);

  const left = calculateMonth({ year: 2026, month: 6, relievingDate: '2026-06-10' });
  assert.equal(left.employment.eligibleDays, 10);
  assert.equal(left.netSalary, '10000.00');
});

test('a recorded override can grant casual leave for a partial month', () => {
  const granted = calculateMonth({
    year: 2026,
    month: 6,
    joiningDate: '2026-06-16',
    clOverride: { eligible: true, reason: 'Principal approved a full CL credit' },
  });
  assert.equal(granted.attendance.paidClEntitlement, '1');
  assert.match(granted.attendance.clEntitlementReason, /Principal approved/);
});

test('salary revision during the month is prorated by segment', () => {
  const result = calculateMonth({
    year: 2026,
    month: 6,
    segments: [
      { id: 'old', effectiveFrom: '2020-01-01', effectiveTo: '2026-06-15', monthlySalary: '30000.00' },
      { id: 'new', effectiveFrom: '2026-06-16', effectiveTo: null, monthlySalary: '60000.00' },
    ],
  });
  assert.equal(result.blocked, false, result.validation.map((item) => item.message).join('; '));
  assert.equal(result.grossContract, '45000.00');
  assert.equal(result.attendanceBonus, '2000.00');
  assert.equal(result.netSalary, '47000.00');
  assert.match(result.lineItems[0].explanation, /30,000\.00/);
  assert.match(result.lineItems[0].explanation, /60,000\.00/);
});

test('overlapping leave and attendance is blocked and deducted once', () => {
  const result = calculateMonth({
    year: 2026,
    month: 6,
    extraAttendance: [{ date: '2026-06-02', status: 'present', approved: true }],
    leaves: [{ id: 'cl', type: 'casual', status: 'approved', startDate: '2026-06-02', endDate: '2026-06-02' }],
  });
  assert.equal(result.blocked, true);
  assert.equal(result.validation.some((item) => item.code === 'OVERLAPPING_LEAVE_AND_ATTENDANCE'), true);
  assert.equal(result.attendance.clUsed, '0');
  assert.equal(result.attendance.fullDayAbsences, '0');
  assert.equal(result.totalDeductions, '0.00');
});

test('a late converted to half-day absence is not deducted again as a late', () => {
  const result = calculateMonth({
    year: 2026,
    month: 6,
    convertedLateHalfDays: ['2026-06-02'],
  });
  assert.equal(result.attendance.totalLates, 0);
  assert.equal(result.attendance.lateDeductionDays, '0');
  assert.equal(result.attendance.halfDayAbsences, '0.5');
  assert.equal(result.lineItems.some((line) => line.code === 'LATE_DEDUCTION'), false);
  assert.equal(result.netSalary, '29500.00');
});

test('currency rounds half up only at component boundaries', () => {
  const result = calculateMonth({ year: 2026, month: 6, salary: '30.15', absents: ['2026-06-01'] });
  assert.equal(result.grossContract, '30.15');
  assert.equal(result.lineItems.find((line) => line.code === 'UNPAID_DEDUCTION').amount, '1.01');
  assert.equal(result.netSalary, '29.14');
  assert.equal(toDecimal(roundHalfUp(fromDecimal('1.005'), 2), 2), '1.01');
  assert.equal(result.amountInWords, 'Twenty Nine Rupees and Fourteen Paise Only');
});

test('manual adjustments need a reason and approval and never replace system lines', () => {
  const holidays = datesInMonth(2026, 6).filter((date) => weekday(date) !== 0).slice(0, 8).map((date) => holiday(date));
  const approved = calculateMonth({
    year: 2026,
    month: 6,
    holidays,
    adjustments: [{
      id: 'adj1',
      kind: 'EARNING',
      name: 'Exam duty incentive',
      amount: '500.00',
      reason: 'Board exam duty',
      reference: 'DUTY-12',
      createdBy: 'user-a',
      approvedBy: 'user-b',
    }],
  });
  assert.equal(approved.blocked, false, approved.validation.map((item) => item.message).join('; '));
  assert.equal(approved.grossContract, '30000.00');
  assert.equal(approved.netSalary, '30500.00');
  assert.equal(approved.lineItems.filter((line) => line.code === 'GROSS_CONTRACT').length, 1);

  const unapproved = calculateMonth({
    year: 2026,
    month: 6,
    holidays,
    adjustments: [{
      kind: 'EARNING', name: 'Incentive', amount: '500.00', reason: 'Duty', createdBy: 'user-a',
    }],
  });
  assert.equal(unapproved.netSalary, '30000.00');
  assert.equal(unapproved.validation.some((item) => item.code === 'MANUAL_ADJUSTMENT_UNAPPROVED'), true);

  const missingReason = calculateMonth({
    year: 2026,
    month: 6,
    holidays,
    adjustments: [{ kind: 'DEDUCTION', name: 'Recovery', amount: '100.00', createdBy: 'user-a', approvedBy: 'user-b' }],
  });
  assert.equal(missingReason.blocked, true);
  assert.equal(missingReason.validation.some((item) => item.code === 'MANUAL_ADJUSTMENT_INCOMPLETE'), true);
});

test('missing classification, negative net, and pending leave block approval', () => {
  const missing = calculateMonth({ year: 2026, month: 6, classification: null });
  assert.equal(missing.blocked, true);
  assert.equal(missing.validation.some((item) => item.code === 'MISSING_CLASSIFICATION'), true);
  assert.equal(missing.attendance.permittedLates, null);

  const holidays = datesInMonth(2026, 6).filter((date) => weekday(date) !== 0).slice(0, 8).map((date) => holiday(date));
  const negative = calculateMonth({
    year: 2026,
    month: 6,
    holidays,
    adjustments: [{
      kind: 'DEDUCTION', name: 'Advance recovery', amount: '40000.00', reason: 'Salary advance', createdBy: 'user-a', approvedBy: 'user-b',
    }],
  });
  assert.equal(negative.blocked, true);
  assert.equal(negative.validation.some((item) => item.code === 'NEGATIVE_NET_SALARY'), true);

  const pending = calculateMonth({
    year: 2026,
    month: 6,
    leaves: [{ id: 'p', type: 'casual', status: 'pending', startDate: '2026-06-02', endDate: '2026-06-02' }],
  });
  assert.equal(pending.blocked, true);
  assert.equal(pending.attendance.clUsed, '0');
  assert.equal(pending.validation.some((item) => item.code === 'PENDING_LEAVE'), true);
});

test('one half-day late deduction can be configured to apply only once', () => {
  const lates = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08'];
  const once = calculateMonth({
    year: 2026,
    month: 6,
    lates,
    policy: { lateDeductionMode: 'ONCE_AFTER_THRESHOLD' },
  });
  assert.equal(once.attendance.excessLates, 3);
  assert.equal(once.attendance.lateDeductionDays, '0.5');
  assert.equal(once.lineItems.find((line) => line.code === 'LATE_DEDUCTION').amount, '500.00');
});

test('a stored snapshot reproduces the payslip after the live rule changes', () => {
  const input = {
    year: 2026,
    month: 6,
    policy: { ...DEFAULT_PAYROLL_POLICY, localPermittedLates: 3 },
    holidayCalendarPublished: true,
    holidays: [],
    attendance: datesInMonth(2026, 6)
      .filter((date) => weekday(date) !== 0)
      .map((date) => ({
        date,
        status: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04'].includes(date) ? 'late' : 'present',
        approved: true,
      })),
    leaves: [],
    adjustments: [],
    teacher: {
      classification: 'LOCAL',
      employmentType: 'FULL_TIME',
      joiningDate: '2020-01-01',
      relievingDate: null,
      salarySegments: [{ effectiveFrom: '2020-01-01', effectiveTo: null, monthlySalary: '30000.00' }],
    },
  };
  const original = calculateTeacherSalary(input);
  const snapshot = structuredClone(input);
  input.policy = { ...input.policy, localPermittedLates: 0 };
  const changed = calculateTeacherSalary(input);
  const replay = reproduceTeacherSalary(snapshot);
  assert.notEqual(changed.netSalary, original.netSalary);
  assert.equal(resultsMatch(original, replay), true);
  assert.equal(replay.netSalary, '30500.00');
});

test('only published school holidays applicable to staff are counted', () => {
  const events = [
    { id: '1', title: 'Draft break', status: 'DRAFT', eventType: 'HOLIDAY', holidayType: 'SCHOOL_HOLIDAY', startDate: '2026-06-01', endDate: '2026-06-01', targets: [] },
    { id: '2', title: 'Optional', status: 'PUBLISHED', eventType: 'HOLIDAY', holidayType: 'OPTIONAL_HOLIDAY', startDate: '2026-06-02', endDate: '2026-06-02', targets: [] },
    { id: '3', title: 'Class trip', status: 'PUBLISHED', eventType: 'HOLIDAY', holidayType: 'SCHOOL_HOLIDAY', startDate: '2026-06-03', endDate: '2026-06-03', targets: [{ type: 'CLASS', id: 'class-1' }] },
    { id: '4', title: 'Foundation day', status: 'PUBLISHED', eventType: 'HOLIDAY', holidayType: 'SCHOOL_HOLIDAY', startDate: '2026-06-04', endDate: '2026-06-05', targets: [{ type: 'ROLE', id: 'teacher' }] },
  ];
  const dates = applicableHolidayDates(events, '2026-06-01', '2026-06-30', DEFAULT_PAYROLL_POLICY);
  assert.deepEqual(dates.map((item) => item.date), ['2026-06-04', '2026-06-05']);
});

test('payroll workflow allows recalculation only before approval and locks the later states', () => {
  assert.doesNotThrow(() => assertCanRecalculate('DRAFT'));
  assert.doesNotThrow(() => assertCanRecalculate('VALIDATED'));
  assert.throws(() => assertCanRecalculate('APPROVED'), PayrollWorkflowError);
  assert.throws(() => assertCanRecalculate('LOCKED'), PayrollWorkflowError);
  assert.doesNotThrow(() => assertTransition('DRAFT', 'VALIDATED'));
  assert.doesNotThrow(() => assertTransition('VALIDATED', 'APPROVED'));
  assert.doesNotThrow(() => assertTransition('APPROVED', 'LOCKED'));
  assert.doesNotThrow(() => assertTransition('LOCKED', 'PAID'));
  assert.throws(() => assertTransition('DRAFT', 'PAID'), PayrollWorkflowError);
  assert.throws(() => assertTransition('LOCKED', 'DRAFT'), PayrollWorkflowError);
});

test('payroll actions follow prepare, approve, pay, and audit permissions', () => {
  const admin = { roles: ['admin'], permissions: [] };
  const preparer = { roles: ['staff'], permissions: ['payroll.prepare'] };
  const approver = { roles: ['principal'], permissions: ['payroll.approve'] };
  const finance = { roles: ['staff'], permissions: ['payroll.pay'] };
  const auditor = { roles: ['staff'], permissions: ['payroll.audit'] };
  const teacher = { roles: ['teacher'], permissions: [] };

  assert.doesNotThrow(() => authorizePayrollAction(admin, 'prepare'));
  assert.doesNotThrow(() => authorizePayrollAction(preparer, 'prepare'));
  assert.throws(() => authorizePayrollAction(preparer, 'approve'), PayrollWorkflowError);
  assert.throws(() => authorizePayrollAction(preparer, 'pay'), PayrollWorkflowError);
  assert.doesNotThrow(() => authorizePayrollAction(approver, 'lock'));
  assert.throws(() => authorizePayrollAction(approver, 'pay'), PayrollWorkflowError);
  assert.doesNotThrow(() => authorizePayrollAction(finance, 'pay'));
  assert.throws(() => authorizePayrollAction(finance, 'prepare'), PayrollWorkflowError);
  assert.throws(() => authorizePayrollAction(teacher, 'prepare'), PayrollWorkflowError);
  assert.equal(canReadPayroll(auditor), true);
  assert.equal(canReadPayroll(teacher), false);
  assert.equal(canReadPayroll(teacher, { isSelf: true }), true);
});
