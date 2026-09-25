import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTeacherSalary,
  reproduceTeacherSalary,
  resultsMatch,
} from '../services/teacherSalaryCalculation.js';
import {
  classifyRecalculation,
  holidaySaveDecision,
  payloadRejection,
  projectPayrollInput,
  publicPayslipAttendance,
  versionConflict,
} from '../services/payrollAttendancePolicy.js';

function baseInput(extra = {}) {
  return {
    year: 2026,
    month: 7,
    holidayCalendarPublished: true,
    holidays: [],
    attendance: [{ date: '2026-07-01', status: 'absent', approved: true }],
    leaves: [],
    policy: {},
    teacher: {
      classification: 'LOCAL',
      employmentType: 'FULL_TIME',
      joiningDate: '2020-01-01',
      relievingDate: null,
      salarySegments: [{
        id: 'base',
        effectiveFrom: '2020-01-01',
        effectiveTo: null,
        monthlySalary: '31000.00',
      }],
    },
    ...extra,
  };
}

function manual(summary = {}, extra = {}) {
  return calculateTeacherSalary(baseInput({
    attendanceSummary: {
      mode: 'MANUAL_SUMMARY',
      clDays: '0',
      nonClDays: '0',
      lateCount: 0,
      verified: true,
      reason: 'Third-party monthly report',
      providerName: 'Biomax',
      reference: 'RPT-12',
      updatedBy: 'user-should-not-appear',
      ...summary,
    },
    ...extra,
  }));
}

test('manual totals replace daily absences instead of adding to them', () => {
  const replaced = manual();
  const system = calculateTeacherSalary(baseInput());
  assert.equal(replaced.blocked, false, replaced.validation.map((item) => item.message).join('; '));
  assert.equal(replaced.attendance.source, 'MANUAL_SUMMARY');
  assert.equal(replaced.attendance.fullDayAbsences, '0');
  assert.equal(replaced.attendance.attendanceBonusDays, '1');
  assert.equal(replaced.netSalary, '32000.00');
  assert.equal(system.attendance.fullDayAbsences, '1');
  assert.notEqual(system.netSalary, replaced.netSalary);
  assert.equal(resultsMatch(replaced, reproduceTeacherSalary(baseInput({
    attendanceSummary: {
      mode: 'MANUAL_SUMMARY',
      clDays: '0',
      nonClDays: '0',
      lateCount: 0,
      verified: true,
      reason: 'Third-party monthly report',
    },
  }))), true);
});

test('CL and Non-CL accept full and half days and reject other increments', () => {
  const half = manual({ clDays: '0.5', nonClDays: '1' });
  assert.equal(half.blocked, false, half.validation.map((item) => item.message).join('; '));
  assert.equal(half.attendance.clUsed, '0.5');
  assert.equal(half.attendance.paidClDays, '0.5');
  assert.equal(half.attendance.excessClDays, '0');
  assert.equal(half.attendance.nonClUnpaidDays, '1');
  assert.equal(half.attendance.attendanceBonusDays, '0');
  assert.equal(half.netSalary, '30000.00');

  const excess = manual({ clDays: '1.5', nonClDays: '0.5' });
  assert.equal(excess.attendance.paidClDays, '1');
  assert.equal(excess.attendance.excessClDays, '0.5');
  assert.equal(excess.attendance.nonClUnpaidDays, '0.5');
  assert.equal(excess.netSalary, '30000.00');

  const rejected = manual({ clDays: '0.25' });
  assert.equal(rejected.blocked, true);
  assert.ok(rejected.validation.some((item) => item.code === 'MANUAL_SUMMARY_INCREMENT'));
  assert.equal(payloadRejection(rejected.validation).length > 0, true);
});

test('local late counts at 3 and 4 use three permitted lates', () => {
  const atLimit = manual({ lateCount: 3 });
  assert.equal(atLimit.blocked, false, atLimit.validation.map((item) => item.message).join('; '));
  assert.equal(atLimit.attendance.permittedLates, 3);
  assert.equal(atLimit.attendance.excessLates, 0);
  assert.equal(atLimit.attendance.lateDeductionDays, '0');
  assert.equal(atLimit.attendance.attendanceBonusDays, '1');
  assert.equal(atLimit.netSalary, '32000.00');

  const oneOver = manual({ lateCount: 4 });
  assert.equal(oneOver.attendance.excessLates, 1);
  assert.equal(oneOver.attendance.lateDeductionDays, '0.5');
  assert.equal(oneOver.attendance.attendanceBonusDays, '1');
  assert.equal(oneOver.netSalary, '31500.00');
  assert.match(oneOver.lineItems.find((line) => line.code === 'LATE_DEDUCTION').explanation, /4 recorded lates - 3 permitted/);
});

test('non-local late counts at 5 and 6 use five permitted lates', () => {
  const atLimit = manual({ lateCount: 5 }, { teacher: { ...baseInput().teacher, classification: 'NON_LOCAL' } });
  assert.equal(atLimit.attendance.permittedLates, 5);
  assert.equal(atLimit.attendance.excessLates, 0);
  assert.equal(atLimit.attendance.lateDeductionDays, '0');
  assert.equal(atLimit.netSalary, '32000.00');

  const oneOver = manual({ lateCount: 6 }, { teacher: { ...baseInput().teacher, classification: 'NON_LOCAL' } });
  assert.equal(oneOver.attendance.excessLates, 1);
  assert.equal(oneOver.attendance.lateDeductionDays, '0.5');
  assert.equal(oneOver.netSalary, '31500.00');
});

test('each excess late deducts half a day for manual totals', () => {
  const local = manual({ lateCount: 7 });
  assert.equal(local.attendance.permittedLates, 3);
  assert.equal(local.attendance.excessLates, 4);
  assert.equal(local.attendance.lateDeductionDays, '2');

  const nonLocal = manual({ lateCount: 8 }, { teacher: { ...baseInput().teacher, classification: 'NON_LOCAL' } });
  assert.equal(nonLocal.attendance.permittedLates, 5);
  assert.equal(nonLocal.attendance.excessLates, 3);
  assert.equal(nonLocal.attendance.lateDeductionDays, '1.5');
});

test('holiday counts at 7, 8, and 9 change CL and the bonus without inventing dates', () => {
  for (const [count, entitlement, bonus, net] of [[7, '1', '1', '32000.00'], [8, '0', '0', '31000.00'], [9, '0', '0', '31000.00']]) {
    const result = manual({}, { holidayOverride: { count, source: 'MANUAL' } });
    assert.equal(result.blocked, false, result.validation.map((item) => item.message).join('; '));
    assert.equal(result.attendance.payrollHolidayCount, count);
    assert.equal(result.attendance.paidClEntitlement, entitlement);
    assert.equal(result.attendance.attendanceBonusDays, bonus);
    assert.equal(result.netSalary, net);
    assert.equal(result.days.some((day) => day.category === 'official_holiday'), false);
  }

  const system = calculateTeacherSalary(baseInput({
    holidays: [{ date: '2026-07-02', name: 'Local holiday' }],
    holidayOverride: { count: 8, source: 'MANUAL' },
    attendance: [],
  }));
  assert.equal(system.attendance.officialHolidays, 8);
  assert.equal(system.attendance.calendarHolidays, 1);
  assert.equal(system.attendance.paidClEntitlement, '0');
  assert.equal(system.days.find((day) => day.date === '2026-07-02').category, 'official_holiday');
  assert.notEqual(system.days.find((day) => day.date === '2026-07-01').category, 'official_holiday');
});

test('unused CL bonus requires verification and zero leave', () => {
  const verified = manual();
  assert.equal(verified.attendance.attendanceBonusDays, '1');
  assert.ok(verified.lineItems.some((line) => line.code === 'ATTENDANCE_BONUS'));

  const unverified = manual({ verified: false });
  assert.equal(unverified.blocked, true);
  assert.equal(unverified.attendance.attendanceBonusDays, '0');
  assert.ok(unverified.validation.some((item) => item.code === 'MANUAL_SUMMARY_UNVERIFIED'));

  const missingReason = manual({ reason: '  ' });
  assert.ok(missingReason.validation.some((item) => item.code === 'MANUAL_SUMMARY_REASON'));
});

test('negative, fractional, and out-of-range totals are rejected', () => {
  assert.ok(manual({ clDays: '-1' }).validation.some((item) => item.code === 'MANUAL_SUMMARY_NEGATIVE'));
  assert.ok(manual({ lateCount: 3.5 }).validation.some((item) => item.code === 'MANUAL_SUMMARY_WHOLE'));
  assert.ok(manual({}, { holidayOverride: { count: 7.5 } }).validation.some((item) => item.code === 'HOLIDAY_COUNT_WHOLE'));
  assert.ok(manual({}, { holidayOverride: { count: 32 } }).validation.some((item) => item.code === 'HOLIDAYS_EXCEED_MONTH'));
  assert.ok(manual({ clDays: '40' }).validation.some((item) => item.code === 'LEAVE_EXCEEDS_SCHEDULED'));
  assert.ok(manual({ lateCount: 40 }).validation.some((item) => item.code === 'LATES_EXCEED_WORKED'));
  const missing = manual({}, { teacher: { ...baseInput().teacher, classification: null } });
  assert.equal(missing.blocked, true);
  assert.ok(missing.validation.some((item) => item.code === 'MISSING_CLASSIFICATION'));
});

test('unpaid manual totals reduce pay before locality is set', () => {
  const missing = manual(
    { clDays: '1.5', nonClDays: '2', lateCount: 4 },
    { teacher: { ...baseInput().teacher, classification: null } },
  );
  assert.equal(missing.blocked, true);
  assert.ok(missing.validation.some((item) => item.code === 'MISSING_CLASSIFICATION'));
  assert.equal(missing.attendance.excessClDays, '0.5');
  assert.equal(missing.attendance.nonClUnpaidDays, '2');
  assert.equal(missing.totalDeductions, '2500.00');
  assert.equal(missing.netSalary, '28500.00');
  assert.equal(missing.lineItems.some((line) => line.code === 'LATE_DEDUCTION'), false);
});

test('multiple salary rates block a rate-dependent manual deduction', () => {
  const segments = [
    { id: 'early', effectiveFrom: '2020-01-01', effectiveTo: '2026-07-15', monthlySalary: '31000.00' },
    { id: 'later', effectiveFrom: '2026-07-16', effectiveTo: null, monthlySalary: '62000.00' },
  ];
  const blocked = manual({ nonClDays: '1' }, {
    teacher: { ...baseInput().teacher, salarySegments: segments },
  });
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.validation.some((item) => item.code === 'MANUAL_SUMMARY_MULTI_RATE'));
  assert.equal(blocked.lineItems.some((line) => line.code === 'UNPAID_DEDUCTION'), false);
  assert.equal(blocked.totalDeductions, '0.00');

  const noDeduction = manual({ clDays: '0', nonClDays: '0', lateCount: 0 }, {
    teacher: { ...baseInput().teacher, salarySegments: segments },
  });
  assert.equal(noDeduction.validation.some((item) => item.code === 'MANUAL_SUMMARY_MULTI_RATE'), false);
  assert.ok(noDeduction.lineItems.some((line) => line.code === 'ATTENDANCE_BONUS'));
});

test('preview input matches the saved calculation and can revert to daily attendance', () => {
  const proposal = {
    mode: 'MANUAL_SUMMARY',
    clDays: '1',
    nonClDays: '0',
    lateCount: 4,
    verified: true,
    reason: 'Imported monthly summary',
    holidayCount: 7,
  };
  const input = baseInput();
  const preview = calculateTeacherSalary(projectPayrollInput(input, proposal));
  const saved = calculateTeacherSalary(projectPayrollInput(structuredClone(input), proposal));
  assert.equal(resultsMatch(preview, saved), true);
  assert.equal(preview.attendance.clUsed, '1');
  assert.equal(preview.attendance.excessLates, 1);
  assert.equal(preview.attendance.payrollHolidayCount, 7);

  const reverted = calculateTeacherSalary(projectPayrollInput(input, { mode: 'SYSTEM_DAILY' }));
  assert.equal(reverted.attendance.source, 'SYSTEM_DAILY');
  assert.equal(reverted.attendance.fullDayAbsences, '1');
});

test('version conflicts, holiday confirmation, and immutable rows are explicit', () => {
  assert.equal(versionConflict(null, null), null);
  assert.equal(versionConflict(1, 1), null);
  assert.equal(versionConflict(1, 2), 'STALE_VERSION');
  assert.equal(versionConflict(2, null), 'STALE_VERSION');

  assert.equal(holidaySaveDecision({ currentCount: 4, nextCount: 4, confirmed: false }).changed, false);
  const needsConfirm = holidaySaveDecision({ currentCount: 4, nextCount: 8, confirmed: false });
  assert.equal(needsConfirm.error.code, 'HOLIDAY_CONFIRMATION_REQUIRED');
  assert.equal(holidaySaveDecision({ currentCount: 4, nextCount: 8, confirmed: true }).changed, true);

  for (const status of ['APPROVED', 'LOCKED', 'PAID']) {
    assert.equal(classifyRecalculation(status, false).action, 'skip');
  }
  assert.equal(classifyRecalculation('VALIDATED', false).action, 'recalculate');
  assert.equal(classifyRecalculation('DRAFT', true).action, 'skip');
});

test('employee payslips omit audit identifiers', () => {
  const result = manual();
  const attendance = publicPayslipAttendance({
    ...result.attendance,
    updatedBy: 'user-123',
    version: 4,
    id: 'summary-id',
    providerName: 'Biomax',
    reason: 'internal reason',
  });
  const encoded = JSON.stringify(attendance);
  assert.equal(attendance.sourceLabel, 'Manual / Third-Party Summary');
  assert.equal(attendance.clUsed, '0');
  assert.equal(attendance.payrollHolidayCount, result.attendance.payrollHolidayCount);
  assert.equal(encoded.includes('user-123'), false);
  assert.equal(encoded.includes('summary-id'), false);
  assert.equal(encoded.includes('Biomax'), false);
  assert.equal(encoded.includes('internal reason'), false);
  assert.equal(encoded.includes('version'), false);
});
