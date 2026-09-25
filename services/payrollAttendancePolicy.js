/**
 * Shared rules for manual payroll attendance totals.
 * The calculator, save endpoint, and payslip projection all use these helpers
 * so preview and the stored snapshot follow one definition.
 */
import { fromDecimal, isNegative, mul, rat } from '../utils/money.js';

const PAYSLIP_ATTENDANCE_KEYS = [
  'source',
  'sourceLabel',
  'calendarDays',
  'employmentEligibleDays',
  'scheduledWorkingDays',
  'paidClEntitlement',
  'clEntitlementReason',
  'clUsed',
  'paidClDays',
  'excessClDays',
  'nonClUnpaidDays',
  'unpaidLeave',
  'otherPaidLeave',
  'fullDayAbsences',
  'halfDayAbsences',
  'totalLates',
  'permittedLates',
  'excessLates',
  'lateDeductionDays',
  'officialHolidays',
  'payrollHolidayCount',
  'attendanceBonusDays',
  'daysPresent',
  'weeklyOffs',
  'onDutyDays',
];

export const PAYLOAD_REJECTION_CODES = new Set([
  'MANUAL_SUMMARY_MISSING',
  'MANUAL_SUMMARY_INVALID',
  'MANUAL_SUMMARY_NEGATIVE',
  'MANUAL_SUMMARY_INCREMENT',
  'MANUAL_SUMMARY_WHOLE',
  'MANUAL_SUMMARY_UNVERIFIED',
  'MANUAL_SUMMARY_REASON',
  'HOLIDAY_COUNT_WHOLE',
  'HOLIDAYS_EXCEED_MONTH',
  'LEAVE_EXCEEDS_SCHEDULED',
  'LATES_EXCEED_WORKED',
]);

function block(code, message) {
  return { severity: 'block', code, message };
}

export function attendanceSourceLabel(mode) {
  return mode === 'MANUAL_SUMMARY' ? 'Manual / Third-Party Summary' : 'SchoolIMS Attendance';
}

export function parseHalfDay(raw, label) {
  if (raw == null || String(raw).trim() === '') {
    return { ok: false, issue: block('MANUAL_SUMMARY_MISSING', `${label} is required.`) };
  }
  let value;
  try {
    value = fromDecimal(raw);
  } catch {
    return { ok: false, issue: block('MANUAL_SUMMARY_INVALID', `${label} must be a number.`) };
  }
  if (isNegative(value)) {
    return { ok: false, issue: block('MANUAL_SUMMARY_NEGATIVE', `${label} cannot be negative.`) };
  }
  if (mul(value, rat(2n, 1n)).d !== 1n) {
    return { ok: false, issue: block('MANUAL_SUMMARY_INCREMENT', `${label} must be in 0.5 day increments.`) };
  }
  return { ok: true, value };
}

export function parseWholeCount(raw, label, code = 'MANUAL_SUMMARY_WHOLE') {
  if (raw == null || String(raw).trim() === '') {
    return { ok: false, issue: block('MANUAL_SUMMARY_MISSING', `${label} is required.`) };
  }
  let value;
  try {
    value = fromDecimal(raw);
  } catch {
    return { ok: false, issue: block('MANUAL_SUMMARY_INVALID', `${label} must be a number.`) };
  }
  if (isNegative(value)) {
    return { ok: false, issue: block('MANUAL_SUMMARY_NEGATIVE', `${label} cannot be negative.`) };
  }
  if (value.d !== 1n) {
    return { ok: false, issue: block(code, `${label} must be a whole number.`) };
  }
  return { ok: true, value, count: Number(value.n) };
}

export function resolveHolidayCount(calendarCount, calendarDays, override) {
  if (override == null || override.count == null || override.count === '') {
    return { count: calendarCount, source: 'CALENDAR', applied: false, issues: [] };
  }
  const parsed = parseWholeCount(override.count, 'Holiday count', 'HOLIDAY_COUNT_WHOLE');
  if (!parsed.ok) {
    return { count: calendarCount, source: 'CALENDAR', applied: false, issues: [parsed.issue] };
  }
  if (parsed.count > calendarDays) {
    return {
      count: calendarCount,
      source: 'CALENDAR',
      applied: false,
      issues: [block(
        'HOLIDAYS_EXCEED_MONTH',
        `Holiday count ${parsed.count} is more than ${calendarDays} calendar days in the payroll month.`,
      )],
    };
  }
  return {
    count: parsed.count,
    source: override.source || 'MANUAL',
    applied: true,
    issues: [],
  };
}

export function versionConflict(currentVersion, expectedVersion) {
  if (currentVersion == null) {
    if (expectedVersion == null || expectedVersion === '' || Number(expectedVersion) === 0) return null;
    return 'STALE_VERSION';
  }
  if (String(currentVersion) !== String(expectedVersion)) return 'STALE_VERSION';
  return null;
}

export function holidaySaveDecision({ currentCount, nextCount, confirmed }) {
  if (Number(currentCount) === Number(nextCount)) return { changed: false };
  if (!confirmed) {
    return {
      changed: true,
      error: {
        code: 'HOLIDAY_CONFIRMATION_REQUIRED',
        message: 'Holiday count is shared by every payroll in this school month. Confirm the change before it recalculates draft and validated payrolls.',
      },
    };
  }
  return { changed: true };
}

export function classifyRecalculation(workflowStatus, frozen = false) {
  if (frozen) {
    return { action: 'skip', reason: 'The payroll snapshot is frozen and was left unchanged.' };
  }
  if (workflowStatus === 'DRAFT' || workflowStatus === 'VALIDATED') {
    return { action: 'recalculate', demote: workflowStatus === 'VALIDATED' };
  }
  if (workflowStatus === 'APPROVED' || workflowStatus === 'LOCKED' || workflowStatus === 'PAID') {
    return { action: 'skip', reason: `Payroll is ${workflowStatus} and was left unchanged.` };
  }
  return { action: 'skip', reason: `Payroll status ${workflowStatus || 'unknown'} cannot be recalculated.` };
}

export function projectPayrollInput(baseInput, proposal = {}) {
  const input = structuredClone(baseInput);
  if (proposal.mode === 'MANUAL_SUMMARY') {
    input.attendanceSummary = {
      mode: 'MANUAL_SUMMARY',
      clDays: proposal.clDays,
      nonClDays: proposal.nonClDays,
      lateCount: proposal.lateCount,
      verified: Boolean(proposal.verified),
      reason: proposal.reason,
      providerName: proposal.providerName || null,
      reference: proposal.reference || null,
    };
  } else {
    input.attendanceSummary = { mode: 'SYSTEM_DAILY' };
  }
  if (proposal.holidayCount !== undefined && proposal.holidayCount !== null && proposal.holidayCount !== '') {
    input.holidayOverride = { count: proposal.holidayCount, source: proposal.holidaySource || 'MANUAL' };
  }
  return input;
}

export function systemComparisonInput(baseInput) {
  const input = structuredClone(baseInput);
  delete input.attendanceSummary;
  input.holidayOverride = null;
  return input;
}

export function publicPayslipAttendance(attendance) {
  if (!attendance || typeof attendance !== 'object') return null;
  const projected = {};
  for (const key of PAYSLIP_ATTENDANCE_KEYS) {
    if (attendance[key] !== undefined) projected[key] = attendance[key];
  }
  if (!projected.source) projected.source = 'SYSTEM_DAILY';
  if (!projected.sourceLabel) projected.sourceLabel = attendanceSourceLabel(projected.source);
  if (projected.payrollHolidayCount == null && projected.officialHolidays != null) {
    projected.payrollHolidayCount = projected.officialHolidays;
  }
  return projected;
}

export function payloadRejection(validation = []) {
  return (validation || []).filter((item) => item.severity === 'block' && PAYLOAD_REJECTION_CODES.has(item.code));
}
