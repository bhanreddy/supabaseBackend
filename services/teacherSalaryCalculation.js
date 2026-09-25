/**
 * Teacher salary calculation, version teacher-salary-v1.
 * Pure function: the same input always reproduces the same payslip.
 * Monetary math uses utils/money.js (rational decimals, never binary floats).
 */
import {
  ZERO, ONE, rat, fromDecimal, add, sub, mul, div, isZero, isNegative, isPositive,
  minRat, maxRat, roundHalfUp, toDecimal, formatInr, amountInWords,
} from '../utils/money.js';

export const CALCULATION_VERSION = 'teacher-salary-v1';

export const DEFAULT_PAYROLL_POLICY = {
  localPermittedLates: 3,
  nonLocalPermittedLates: 5,
  deductionPerExcessLateDays: '0.5',
  lateDeductionMode: 'PER_EXCESS',
  monthlyClEntitlementDays: '1',
  holidayThresholdForDisablingCl: 8,
  unusedClBonusDays: '1',
  salaryBasis: 'CALENDAR_DAYS',
  currency: 'INR',
  roundingMode: 'HALF_UP',
  roundingScale: 2,
  weeklyOffWeekdays: [0],
  countWeeklyOffAsHoliday: false,
  includeOptionalHolidays: false,
  clRequiresFullMonth: true,
  probationClEligible: false,
  clEligibleEmploymentTypes: ['FULL_TIME', 'PERMANENT'],
  paidLeaveTypes: ['casual', 'sick', 'earned', 'maternity', 'paternity'],
  excessClTreatment: 'unpaid',
  payslipPublishAt: 'LOCKED',
  requireAdjustmentApproval: true,
};

const OFFICIAL_HOLIDAY_TYPES = new Set([
  'PUBLIC_HOLIDAY', 'SCHOOL_HOLIDAY', 'LOCAL_HOLIDAY', 'VACATION', 'EMERGENCY_HOLIDAY',
]);

export function calendarDaysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthBounds(year, month) {
  const days = calendarDaysInMonth(year, month);
  const mm = String(month).padStart(2, '0');
  return {
    start: `${year}-${mm}-01`,
    end: `${year}-${mm}-${String(days).padStart(2, '0')}`,
    days,
  };
}

export function addDays(iso, count) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + count));
  return date.toISOString().slice(0, 10);
}

export function eachDateInclusive(start, end) {
  const dates = [];
  let cursor = start;
  let guard = 0;
  while (cursor <= end) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
    if (guard > 400) throw new Error('Date range is too long');
  }
  return dates;
}

export function weekdayIndex(iso) {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

export function normalizePolicy(partial = {}) {
  const policy = {
    ...DEFAULT_PAYROLL_POLICY,
    ...partial,
    weeklyOffWeekdays: [...(partial.weeklyOffWeekdays || DEFAULT_PAYROLL_POLICY.weeklyOffWeekdays)],
    clEligibleEmploymentTypes: [...(partial.clEligibleEmploymentTypes || DEFAULT_PAYROLL_POLICY.clEligibleEmploymentTypes)],
    paidLeaveTypes: [...(partial.paidLeaveTypes || DEFAULT_PAYROLL_POLICY.paidLeaveTypes)],
  };
  if (!['PER_EXCESS', 'ONCE_AFTER_THRESHOLD'].includes(policy.lateDeductionMode)) {
    throw new Error('lateDeductionMode must be PER_EXCESS or ONCE_AFTER_THRESHOLD');
  }
  if (policy.salaryBasis !== 'CALENDAR_DAYS') {
    throw new Error('Only calendar-day salary basis is supported');
  }
  if (policy.roundingMode !== 'HALF_UP') {
    throw new Error('Only HALF_UP rounding is supported');
  }
  return policy;
}

function issue(severity, code, message) {
  return { severity, code, message };
}

function decimalDays(value) {
  const text = toDecimal(value, 2).replace(/0+$/, '').replace(/\.$/, '');
  return text === '' ? '0' : text;
}

function segmentForDate(date, segments) {
  return segments.filter((segment) => (
    date >= segment.effectiveFrom && (!segment.effectiveTo || date <= segment.effectiveTo)
  ));
}

function holidayApplies(event) {
  const targets = event.targets || [];
  if (targets.length === 0) return true;
  return targets.some((target) => {
    const type = String(target.type || '').toUpperCase();
    const id = String(target.id || '').toLowerCase();
    return type === 'ENTIRE_SCHOOL' || (type === 'ROLE' && (id === 'staff' || id === 'teacher'));
  });
}

export function applicableHolidayDates(events, monthStart, monthEnd, policyInput) {
  const policy = normalizePolicy(policyInput);
  const dates = new Map();
  for (const event of events || []) {
    if (event.status !== 'PUBLISHED') continue;
    const holidayType = event.holidayType || null;
    const eventType = String(event.eventType || '').toUpperCase();
    const isHoliday = eventType === 'HOLIDAY' || eventType === 'VACATION' || Boolean(holidayType);
    if (!isHoliday) continue;
    if (holidayType === 'OPTIONAL_HOLIDAY' && !policy.includeOptionalHolidays) continue;
    if (holidayType && holidayType !== 'OPTIONAL_HOLIDAY' && !OFFICIAL_HOLIDAY_TYPES.has(holidayType) && eventType !== 'HOLIDAY' && eventType !== 'VACATION') {
      continue;
    }
    if (!holidayApplies(event)) continue;
    const start = event.startDate > monthStart ? event.startDate : monthStart;
    const end = event.endDate < monthEnd ? event.endDate : monthEnd;
    if (start > end) continue;
    for (const date of eachDateInclusive(start, end)) {
      if (!dates.has(date)) dates.set(date, event.title || 'Official holiday');
    }
  }
  return [...dates.entries()].map(([date, name]) => ({ date, name }));
}

function leaveKind(leave, policy, issues) {
  const treatment = String(leave.payrollTreatment || '').toUpperCase();
  if (treatment === 'PAID_CL') return 'casual';
  if (treatment === 'PAID_LEAVE') return 'other_paid';
  if (treatment === 'UNPAID') return 'unpaid';
  if (treatment) {
    issues.push(issue(
      'block',
      'UNKNOWN_PAYROLL_TREATMENT',
      `Leave on ${leave.startDate} uses salary treatment "${leave.payrollTreatment}", which payroll cannot classify.`,
    ));
    return 'unpaid';
  }
  const type = String(leave.type || '').toLowerCase();
  if (type === 'casual') return 'casual';
  if (type === 'unpaid') return 'unpaid';
  const paid = policy.paidLeaveTypes.map((item) => String(item).toLowerCase());
  if (paid.includes(type)) return 'other_paid';
  issues.push(issue(
    'block',
    'UNKNOWN_LEAVE_TYPE',
    `Leave on ${leave.startDate} uses type "${leave.type}", which is not a configured paid leave. It is held for review and is not treated as paid leave.`,
  ));
  return 'unpaid';
}

function clEligibility({ policy, teacher, fullMonth, holidayCount, monthLabel }) {
  const entitlement = fromDecimal(policy.monthlyClEntitlementDays);
  if (holidayCount >= policy.holidayThresholdForDisablingCl) {
    return {
      days: ZERO,
      bonusEligible: false,
      reason: `${monthLabel} has ${holidayCount} official holidays, so casual leave and the unused-CL bonus are disabled (threshold ${policy.holidayThresholdForDisablingCl}).`,
    };
  }
  if (teacher.clOverride) {
    if (!teacher.clOverride.reason) {
      return {
        days: ZERO,
        bonusEligible: false,
        reason: 'A casual-leave override was supplied without a reason.',
        overrideInvalid: true,
      };
    }
    if (teacher.clOverride.eligible) {
      return {
        days: entitlement,
        bonusEligible: true,
        reason: `Administrator override grants casual leave for ${monthLabel}: ${teacher.clOverride.reason}`,
      };
    }
    return {
      days: ZERO,
      bonusEligible: false,
      reason: `Administrator override removes casual leave for ${monthLabel}: ${teacher.clOverride.reason}`,
    };
  }
  const employmentType = String(teacher.employmentType || '').toUpperCase();
  if (!policy.clEligibleEmploymentTypes.map((item) => item.toUpperCase()).includes(employmentType)) {
    return {
      days: ZERO,
      bonusEligible: false,
      reason: `${employmentType || 'Unspecified'} employment is not eligible for monthly casual leave.`,
    };
  }
  if (teacher.onProbation && !policy.probationClEligible) {
    return {
      days: ZERO,
      bonusEligible: false,
      reason: 'The teacher is still in probation, and school policy does not grant casual leave during probation.',
    };
  }
  if (!fullMonth && policy.clRequiresFullMonth) {
    return {
      days: ZERO,
      bonusEligible: false,
      reason: 'Casual leave and the unused-CL bonus require the teacher to be employed for the full payroll month. Record an override with a reason to grant them.',
    };
  }
  return {
    days: entitlement,
    bonusEligible: true,
    reason: `Monthly casual leave entitlement is ${decimalDays(entitlement)} day.`,
  };
}

function roundComponent(amount, scale) {
  return roundHalfUp(amount, scale);
}

export function calculateTeacherSalary(input) {
  const policy = normalizePolicy(input.policy);
  const scale = policy.roundingScale;
  const bounds = monthBounds(input.year, input.month);
  const monthLabel = bounds.start.slice(0, 7);
  const issues = [];
  const weeklyOffs = new Set(policy.weeklyOffWeekdays);
  const teacher = input.teacher || {};
  const segments = [...(teacher.salarySegments || [])].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const joiningDate = teacher.joiningDate || null;
  const relievingDate = teacher.relievingDate || null;

  if (!['LOCAL', 'NON_LOCAL'].includes(teacher.classification)) {
    issues.push(issue(
      'block',
      'MISSING_CLASSIFICATION',
      `Set a LOCAL or NON_LOCAL classification effective for ${monthLabel} before this salary can be approved.`,
    ));
  }
  if (teacher.classificationChangedInMonth) {
    issues.push(issue(
      'block',
      'CLASSIFICATION_CHANGED_MID_MONTH',
      `More than one locality classification overlaps ${monthLabel}. Keep a single classification for the payroll month.`,
    ));
  }
  if (input.holidayCalendarPublished === false) {
    issues.push(issue(
      'block',
      'HOLIDAY_CALENDAR_UNPUBLISHED',
      `No published holiday calendar covers ${monthLabel}. Publish the academic calendar before approving payroll.`,
    ));
  }
  if (input.policiesOverlapping === 0) {
    issues.push(issue(
      'block',
      'MISSING_PAYROLL_POLICY',
      `No salary policy is effective for ${monthLabel}. Save a school payroll policy before approving salaries.`,
    ));
  } else if ((input.policiesOverlapping || 1) > 1) {
    issues.push(issue(
      'block',
      'PAYROLL_POLICY_OVERLAP',
      `More than one salary policy overlaps ${monthLabel}. Set non-overlapping effective dates.`,
    ));
  }

  const employmentStart = joiningDate && joiningDate > bounds.start ? joiningDate : bounds.start;
  const employmentEnd = relievingDate && relievingDate < bounds.end ? relievingDate : bounds.end;
  const employedInMonth = employmentStart <= employmentEnd;
  const fullMonth = employedInMonth && employmentStart === bounds.start && employmentEnd === bounds.end;
  const holidayMap = new Map((input.holidays || []).map((holiday) => [holiday.date, holiday.name || 'Official holiday']));
  if (policy.countWeeklyOffAsHoliday) {
    for (const date of eachDateInclusive(bounds.start, bounds.end)) {
      if (weeklyOffs.has(weekdayIndex(date)) && !holidayMap.has(date)) {
        holidayMap.set(date, 'Weekly off counted as a holiday by school policy');
      }
    }
  }
  const holidayCount = holidayMap.size;

  const attendanceByDate = new Map();
  const duplicateAttendance = new Set();
  for (const row of input.attendance || []) {
    if (attendanceByDate.has(row.date)) {
      duplicateAttendance.add(row.date);
      issues.push(issue(
        'block',
        'CONFLICTING_ATTENDANCE',
        `Date ${row.date} has more than one attendance status. Keep a single status before approving payroll.`,
      ));
    } else {
      attendanceByDate.set(row.date, row);
    }
  }

  const leaveByDate = new Map();
  for (const leave of input.leaves || []) {
    if (!['approved', 'pending', 'rejected', 'cancelled'].includes(leave.status)) {
      issues.push(issue('block', 'UNKNOWN_LEAVE_STATUS', `Leave ${leave.id || ''} has an unknown status.`));
      continue;
    }
    if (leave.status !== 'approved' && leave.status !== 'pending') continue;
    const start = leave.startDate > bounds.start ? leave.startDate : bounds.start;
    const end = leave.endDate < bounds.end ? leave.endDate : bounds.end;
    if (start > end) continue;
    for (const date of eachDateInclusive(start, end)) {
      if (leaveByDate.has(date)) {
        issues.push(issue(
          'block',
          'OVERLAPPING_LEAVE',
          `Date ${date} is covered by more than one leave request. Resolve the overlap before approving payroll.`,
        ));
      } else {
        leaveByDate.set(date, leave);
      }
    }
  }

  const onDuty = new Set(input.onDutyDates || []);
  const probationEnd = teacher.probationEndDate || null;
  const onProbation = Boolean(probationEnd && probationEnd >= bounds.start);
  const cl = clEligibility({
    policy,
    teacher: { ...teacher, onProbation },
    fullMonth,
    holidayCount,
    monthLabel,
  });
  if (cl.overrideInvalid) {
    issues.push(issue('block', 'CL_OVERRIDE_WITHOUT_REASON', cl.reason));
  }

  const dates = eachDateInclusive(bounds.start, bounds.end);
  const dayRows = [];
  let gross = ZERO;
  const segmentTotals = new Map();

  for (const date of dates) {
    const inEmployment = employedInMonth && date >= employmentStart && date <= employmentEnd;
    const beforeJoin = Boolean(joiningDate && date < joiningDate);
    const afterExit = Boolean(relievingDate && date > relievingDate);
    const isWeeklyOff = weeklyOffs.has(weekdayIndex(date));
    const holidayName = holidayMap.get(date) || null;
    const attendance = attendanceByDate.get(date) || null;
    const leave = leaveByDate.get(date) || null;
    const matchingSegments = inEmployment ? segmentForDate(date, segments) : [];

    if (attendance && (beforeJoin || afterExit)) {
      issues.push(issue(
        'block',
        beforeJoin ? 'JOINING_CONFLICT' : 'RELIEVING_CONFLICT',
        `Attendance on ${date} falls outside the joining and relieving dates. Correct the attendance or the employment dates.`,
      ));
    }

    let category = 'not_applicable';
    let conflict = false;
    if (!inEmployment) {
      category = 'not_applicable';
    } else if (duplicateAttendance.has(date)) {
      conflict = true;
      category = 'conflict';
    } else if (attendance && leave && leave.status === 'approved') {
      conflict = true;
      category = 'conflict';
      issues.push(issue(
        'block',
        'OVERLAPPING_LEAVE_AND_ATTENDANCE',
        `Date ${date} has both approved leave and attendance status "${attendance.status}". Remove one record so the day is deducted only once.`,
      ));
    } else if (leave && leave.status === 'approved' && (holidayName || (isWeeklyOff && !policy.countWeeklyOffAsHoliday))) {
      conflict = true;
      category = 'conflict';
      issues.push(issue(
        'block',
        'LEAVE_ON_NON_WORKING_DAY',
        `Approved leave overlaps ${holidayName ? `holiday "${holidayName}"` : 'a weekly off'} on ${date}. Cancel or move the leave.`,
      ));
    } else if (holidayName) {
      category = 'official_holiday';
      if (attendance) {
        issues.push(issue(
          'warn',
          'ATTENDANCE_ON_HOLIDAY',
          `Attendance on ${date} falls on holiday "${holidayName}" and is not deducted again.`,
        ));
      }
    } else if (isWeeklyOff && !policy.countWeeklyOffAsHoliday) {
      category = 'weekly_off';
    } else if (onDuty.has(date) || attendance?.onDuty) {
      category = 'on_duty';
    } else if (leave?.status === 'pending') {
      category = 'pending_leave';
      issues.push(issue(
        'block',
        'PENDING_LEAVE',
        `Leave on ${date} is still pending. Approve, reject, or cancel it before payroll approval. Pending leave is not paid.`,
      ));
    } else if (leave?.status === 'approved') {
      const kind = leaveKind(leave, policy, issues);
      category = kind === 'casual' ? 'casual_leave' : kind === 'other_paid' ? 'other_paid_leave' : 'unpaid_leave';
    } else if (attendance?.status === 'half_day') {
      category = 'half_day_absence';
    } else if (attendance?.status === 'absent') {
      category = 'full_day_absence';
    } else if (attendance?.status === 'late') {
      category = attendance.approved === false ? 'missing_attendance' : 'late';
    } else if (attendance?.status === 'present') {
      category = 'present';
    } else if (inEmployment) {
      category = 'missing_attendance';
    }

    if (category === 'missing_attendance') {
      issues.push(issue(
        'block',
        'INCOMPLETE_ATTENDANCE',
        `No approved attendance is recorded for working day ${date}. Mark attendance before approving payroll.`,
      ));
    }
    if (attendance?.status === 'late' && attendance.approved === false) {
      issues.push(issue(
        'block',
        'UNAPPROVED_LATE',
        `Late attendance on ${date} is not approved, so it is not counted as a permitted or excess late.`,
      ));
    }

    let perDay = ZERO;
    if (inEmployment) {
      if (matchingSegments.length === 0) {
        issues.push(issue(
          'block',
          'MISSING_SALARY',
          `No salary revision covers ${date}. Add the teacher's effective salary before approving payroll.`,
        ));
      } else if (matchingSegments.length > 1) {
        issues.push(issue(
          'block',
          'OVERLAPPING_SALARY',
          `More than one salary revision covers ${date}. Set non-overlapping effective dates.`,
        ));
      } else {
        const monthly = fromDecimal(matchingSegments[0].monthlySalary);
        if (!isPositive(monthly)) {
          issues.push(issue(
            'block',
            'UNEXPECTED_ZERO_SALARY',
            `Salary effective on ${date} is ${matchingSegments[0].monthlySalary}. Confirm the salary revision before approving payroll.`,
          ));
        }
        perDay = div(monthly, rat(BigInt(bounds.days), 1n));
        const key = matchingSegments[0].id || `${matchingSegments[0].effectiveFrom}:${matchingSegments[0].monthlySalary}`;
        const current = segmentTotals.get(key) || {
          ...matchingSegments[0],
          days: 0,
          amount: ZERO,
          perDay,
        };
        current.days += 1;
        current.amount = add(current.amount, perDay);
        segmentTotals.set(key, current);
        gross = add(gross, perDay);
      }
    }

    dayRows.push({
      date,
      category,
      conflict,
      perDay,
      holidayName,
      attendance,
      leave,
      weeklyOff: isWeeklyOff,
      inEmployment,
    });
  }

  const lateDays = dayRows.filter((day) => (
    day.category === 'late'
    && day.attendance?.approved !== false
    && !(day.attendance?.status === 'half_day' && day.attendance?.convertedFromLate)
  ));
  const permittedLates = teacher.classification === 'LOCAL'
    ? policy.localPermittedLates
    : teacher.classification === 'NON_LOCAL'
      ? policy.nonLocalPermittedLates
      : null;
  const excessLateDays = permittedLates == null ? [] : lateDays.slice(permittedLates);
  const deductionFactor = fromDecimal(policy.deductionPerExcessLateDays);
  const chargedLates = policy.lateDeductionMode === 'ONCE_AFTER_THRESHOLD'
    ? excessLateDays.slice(0, excessLateDays.length > 0 ? 1 : 0)
    : excessLateDays;

  let lateAmount = ZERO;
  const lateParts = [];
  for (const day of chargedLates) {
    const portion = mul(day.perDay, deductionFactor);
    lateAmount = add(lateAmount, portion);
    lateParts.push(`${day.date}: ${decimalDays(deductionFactor)} day × ${formatInr(toDecimal(day.perDay, scale))} = ${formatInr(toDecimal(portion, 4))}`);
  }

  const casualDays = dayRows.filter((day) => day.category === 'casual_leave');
  let casualQuantity = ZERO;
  for (const day of casualDays) {
    casualQuantity = add(casualQuantity, day.leave?.halfDay ? fromDecimal('0.5') : ONE);
  }
  const paidCl = minRat(casualQuantity, cl.days);
  const excessCl = maxRat(ZERO, sub(casualQuantity, cl.days));
  let unpaidFromExcessCl = policy.excessClTreatment === 'unpaid' ? excessCl : ZERO;

  let otherPaid = ZERO;
  let unpaidLeave = ZERO;
  let fullDayAbsences = ZERO;
  let halfDayAbsences = ZERO;
  let presentDays = 0;
  let weeklyOffCount = 0;
  let onDutyDays = 0;
  let notApplicable = 0;
  let scheduled = 0;
  const missingDates = [];

  for (const day of dayRows) {
    if (day.category === 'not_applicable') notApplicable += 1;
    if (day.category === 'weekly_off') weeklyOffCount += 1;
    if (day.category === 'on_duty') onDutyDays += 1;
    if (day.category === 'present') presentDays += 1;
    if (day.inEmployment && day.category !== 'official_holiday' && day.category !== 'weekly_off' && day.category !== 'not_applicable') {
      scheduled += 1;
    }
    if (day.category === 'other_paid_leave') otherPaid = add(otherPaid, day.leave?.halfDay ? fromDecimal('0.5') : ONE);
    if (day.category === 'unpaid_leave') unpaidLeave = add(unpaidLeave, day.leave?.halfDay ? fromDecimal('0.5') : ONE);
    if (day.category === 'full_day_absence') fullDayAbsences = add(fullDayAbsences, ONE);
    if (day.category === 'half_day_absence') halfDayAbsences = add(halfDayAbsences, fromDecimal('0.5'));
    if (day.category === 'missing_attendance') missingDates.push(day.date);
  }
  unpaidLeave = add(unpaidLeave, unpaidFromExcessCl);

  const halfDayAmount = dayRows
    .filter((day) => day.category === 'half_day_absence')
    .reduce((sum, day) => add(sum, mul(day.perDay, fromDecimal('0.5'))), ZERO);
  const fullDayAmount = dayRows
    .filter((day) => day.category === 'full_day_absence')
    .reduce((sum, day) => add(sum, day.perDay), ZERO);
  const unpaidLeaveAmount = dayRows
    .filter((day) => day.category === 'unpaid_leave')
    .reduce((sum, day) => add(sum, day.leave?.halfDay ? mul(day.perDay, fromDecimal('0.5')) : day.perDay), ZERO);
  let excessClAmount = ZERO;
  if (isPositive(unpaidFromExcessCl) && casualDays.length > 0) {
    const rate = casualDays[casualDays.length - 1].perDay;
    excessClAmount = mul(rate, unpaidFromExcessCl);
  }
  const unpaidAmount = add(add(add(unpaidLeaveAmount, fullDayAmount), halfDayAmount), excessClAmount);
  const totalUnpaidDays = add(add(unpaidLeave, fullDayAbsences), halfDayAbsences);

  const unauthorizedAbsence = isPositive(fullDayAbsences) || isPositive(halfDayAbsences) || missingDates.length > 0 || dayRows.some((day) => day.category === 'pending_leave' || day.conflict);
  const anyLeave = isPositive(casualQuantity) || isPositive(otherPaid) || isPositive(unpaidLeave) || isPositive(halfDayAbsences);
  const attendanceComplete = missingDates.length === 0 && dayRows.every((day) => day.category !== 'conflict' && day.category !== 'pending_leave');
  const bonusDays = cl.bonusEligible && isZero(casualQuantity) && !anyLeave && !unauthorizedAbsence && attendanceComplete && fullMonth
    ? fromDecimal(policy.unusedClBonusDays)
    : ZERO;
  const bonusRateDay = [...dayRows].reverse().find((day) => day.inEmployment && isPositive(day.perDay));
  const bonusAmount = isPositive(bonusDays) && bonusRateDay ? mul(bonusRateDay.perDay, bonusDays) : ZERO;

  const lineItems = [];
  const segmentList = [...segmentTotals.values()];
  const grossExplanation = segmentList.length === 0
    ? `No payable salary segment was found for ${monthLabel}.`
    : segmentList.map((segment) => (
      `${segment.days} employment day${segment.days === 1 ? '' : 's'} × (${formatInr(toDecimal(fromDecimal(segment.monthlySalary), scale))} / ${bounds.days} calendar days) = ${formatInr(toDecimal(segment.amount, scale))}`
    )).join('\n');
  lineItems.push({
    code: 'GROSS_CONTRACT',
    name: 'Gross Contract Salary',
    kind: 'earning',
    quantity: String(employedInMonth ? eachDateInclusive(employmentStart, employmentEnd).length : 0),
    rate: segmentList.length === 1 ? toDecimal(segmentList[0].perDay, scale) : null,
    rateUnrounded: segmentList.length === 1 ? toDecimal(segmentList[0].perDay, 6) : null,
    amountUnrounded: toDecimal(gross, 6),
    amount: toDecimal(roundComponent(gross, scale), scale),
    source: 'salary_revision',
    explanation: `${monthLabel} has ${bounds.days} calendar days. ${grossExplanation}`,
  });

  if (isPositive(bonusDays)) {
    lineItems.push({
      code: 'ATTENDANCE_BONUS',
      name: 'Unused CL Attendance Bonus',
      kind: 'earning',
      quantity: decimalDays(bonusDays),
      rate: toDecimal(bonusRateDay.perDay, scale),
      rateUnrounded: toDecimal(bonusRateDay.perDay, 6),
      amountUnrounded: toDecimal(bonusAmount, 6),
      amount: toDecimal(roundComponent(bonusAmount, scale), scale),
      source: 'attendance_bonus',
      explanation: `Casual leave was available and unused, with no leave, absence, or missing attendance. Bonus = ${decimalDays(bonusDays)} × ${formatInr(toDecimal(bonusRateDay.perDay, scale))} (rate on ${bonusRateDay.date}).`,
    });
  }

  if (chargedLates.length > 0) {
    const totalLates = lateDays.length;
    const excess = excessLateDays.length;
    const modeText = policy.lateDeductionMode === 'ONCE_AFTER_THRESHOLD'
      ? 'School policy applies the half-day deduction once after the permitted limit, not once per extra late.'
      : `${excess} excess lates × ${decimalDays(deductionFactor)} day.`;
    lineItems.push({
      code: 'LATE_DEDUCTION',
      name: 'Late Deduction',
      kind: 'deduction',
      quantity: decimalDays(mul(deductionFactor, rat(BigInt(chargedLates.length), 1n))),
      rate: new Set(chargedLates.map((day) => toDecimal(day.perDay, scale))).size === 1
        ? toDecimal(chargedLates[0].perDay, scale)
        : null,
      rateUnrounded: chargedLates.length === 1 ? toDecimal(chargedLates[0].perDay, 6) : null,
      amountUnrounded: toDecimal(lateAmount, 6),
      amount: toDecimal(roundComponent(lateAmount, scale), scale),
      source: 'attendance',
      explanation: [
        `${totalLates} recorded lates - ${permittedLates} permitted lates = ${excess} excess lates.`,
        modeText,
        ...lateParts,
        `Late deduction = ${formatInr(toDecimal(roundComponent(lateAmount, scale), scale))}.`,
      ].join('\n'),
    });
  }

  if (isPositive(totalUnpaidDays)) {
    lineItems.push({
      code: 'UNPAID_DEDUCTION',
      name: 'Leave and Absence Deduction',
      kind: 'deduction',
      quantity: decimalDays(totalUnpaidDays),
      rate: null,
      rateUnrounded: null,
      amountUnrounded: toDecimal(unpaidAmount, 6),
      amount: toDecimal(roundComponent(unpaidAmount, scale), scale),
      source: 'attendance_and_leave',
      explanation: [
        `Unpaid leave ${decimalDays(unpaidLeave)} + full-day absence ${decimalDays(fullDayAbsences)} + half-day absence ${decimalDays(halfDayAbsences)} = ${decimalDays(totalUnpaidDays)} unpaid days.`,
        isPositive(excessCl) ? `Casual leave used ${decimalDays(casualQuantity)} against entitlement ${decimalDays(cl.days)}; excess ${decimalDays(excessCl)} is unpaid.` : null,
        `Deduction = ${formatInr(toDecimal(roundComponent(unpaidAmount, scale), scale))}.`,
      ].filter(Boolean).join('\n'),
    });
  }

  for (const adjustment of input.adjustments || []) {
    const incomplete = !adjustment.reason || !adjustment.createdBy || !adjustment.amount || !adjustment.kind;
    if (incomplete) {
      issues.push(issue(
        'block',
        'MANUAL_ADJUSTMENT_INCOMPLETE',
        'Every manual adjustment needs a type, amount, reason, and author.',
      ));
      continue;
    }
    if (policy.requireAdjustmentApproval && !adjustment.approvedBy) {
      issues.push(issue(
        'warn',
        'MANUAL_ADJUSTMENT_UNAPPROVED',
        `Adjustment "${adjustment.name || adjustment.reason}" is excluded until an approver authorises it.`,
      ));
      continue;
    }
    if (['GROSS_CONTRACT', 'ATTENDANCE_BONUS', 'LATE_DEDUCTION', 'UNPAID_DEDUCTION'].includes(adjustment.code)) {
      issues.push(issue(
        'block',
        'MANUAL_ADJUSTMENT_RESERVED_CODE',
        'Manual adjustments cannot replace a system-calculated salary component.',
      ));
      continue;
    }
    const amount = fromDecimal(adjustment.amount);
    if (!isPositive(amount)) {
      issues.push(issue('block', 'MANUAL_ADJUSTMENT_AMOUNT', 'Manual adjustment amounts must be greater than zero.'));
      continue;
    }
    const kind = adjustment.kind === 'DEDUCTION' ? 'deduction' : 'earning';
    lineItems.push({
      code: 'MANUAL_ADJUSTMENT',
      name: adjustment.name || (kind === 'earning' ? 'Manual Earning' : 'Manual Deduction'),
      kind,
      quantity: '1',
      rate: toDecimal(amount, scale),
      rateUnrounded: toDecimal(amount, 6),
      amountUnrounded: toDecimal(amount, 6),
      amount: toDecimal(roundComponent(amount, scale), scale),
      source: 'manual_adjustment',
      adjustmentId: adjustment.id || null,
      explanation: `${adjustment.reason}${adjustment.reference ? ` (ref ${adjustment.reference})` : ''}. Created by ${adjustment.createdBy}; approved by ${adjustment.approvedBy}.`,
    });
  }

  const earnings = lineItems.filter((line) => line.kind === 'earning');
  const deductions = lineItems.filter((line) => line.kind === 'deduction');
  const grossEarnings = earnings.reduce((sum, line) => add(sum, fromDecimal(line.amount)), ZERO);
  const totalDeductions = deductions.reduce((sum, line) => add(sum, fromDecimal(line.amount)), ZERO);
  const net = sub(grossEarnings, totalDeductions);
  if (isNegative(net)) {
    issues.push(issue(
      'block',
      'NEGATIVE_NET_SALARY',
      `Net salary is ${formatInr(toDecimal(net, scale))}. Reduce deductions or add an approved earning before this payroll can be approved.`,
    ));
  }

  const blocked = issues.some((item) => item.severity === 'block');
  const primaryPerDay = segmentList.length === 1 ? segmentList[0].perDay : (bonusRateDay?.perDay || ZERO);
  const employmentDays = employedInMonth ? eachDateInclusive(employmentStart, employmentEnd).length : 0;

  return {
    version: CALCULATION_VERSION,
    blocked,
    requiresReview: blocked,
    validation: issues,
    policy,
    month: { year: input.year, month: input.month, label: monthLabel, start: bounds.start, end: bounds.end, calendarDays: bounds.days },
    employment: {
      joiningDate,
      relievingDate,
      fullMonth,
      eligibleDays: employmentDays,
      classification: teacher.classification || null,
      employmentType: teacher.employmentType || null,
    },
    perDaySalaryUnrounded: toDecimal(primaryPerDay, 6),
    perDaySalary: toDecimal(roundHalfUp(primaryPerDay, scale), scale),
    attendance: {
      calendarDays: bounds.days,
      employmentEligibleDays: employmentDays,
      scheduledWorkingDays: scheduled,
      daysPresent: presentDays,
      officialHolidays: holidayCount,
      weeklyOffs: weeklyOffCount,
      totalLates: lateDays.length,
      permittedLates,
      excessLates: permittedLates == null ? null : excessLateDays.length,
      lateDeductionDays: decimalDays(mul(deductionFactor, rat(BigInt(chargedLates.length), 1n))),
      paidClEntitlement: decimalDays(cl.days),
      clEntitlementReason: cl.reason,
      clUsed: decimalDays(casualQuantity),
      paidClDays: decimalDays(paidCl),
      excessClDays: decimalDays(excessCl),
      otherPaidLeave: decimalDays(otherPaid),
      unpaidLeave: decimalDays(unpaidLeave),
      fullDayAbsences: decimalDays(fullDayAbsences),
      halfDayAbsences: decimalDays(halfDayAbsences),
      attendanceBonusDays: decimalDays(bonusDays),
      onDutyDays,
      notApplicableDays: notApplicable,
    },
    lineItems,
    grossContractUnrounded: toDecimal(gross, 6),
    grossContract: toDecimal(roundComponent(gross, scale), scale),
    attendanceBonus: toDecimal(roundComponent(bonusAmount, scale), scale),
    grossEarnings: toDecimal(grossEarnings, scale),
    totalDeductions: toDecimal(totalDeductions, scale),
    netUnrounded: toDecimal(sub(
      add(gross, bonusAmount),
      add(lateAmount, unpaidAmount),
    ), 6),
    netSalary: toDecimal(net, scale),
    amountInWords: amountInWords(toDecimal(net, scale)),
    days: dayRows.map((day) => ({
      date: day.date,
      category: day.category,
      inEmployment: day.inEmployment,
    })),
  };
}

export function reproduceTeacherSalary(snapshotInput) {
  return calculateTeacherSalary(snapshotInput);
}

export function resultsMatch(left, right) {
  return left.netSalary === right.netSalary
    && left.grossEarnings === right.grossEarnings
    && left.totalDeductions === right.totalDeductions
    && JSON.stringify(left.lineItems.map((line) => [line.code, line.amount, line.explanation]))
      === JSON.stringify(right.lineItems.map((line) => [line.code, line.amount, line.explanation]));
}
