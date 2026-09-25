import sql from '../db.js';
import { assemblePayrollInput } from './teacherPayrollService.js';
import { calculateTeacherSalary, eachDateInclusive, monthBounds } from './teacherSalaryCalculation.js';

export const LEAVE_PAYROLL_TREATMENTS = Object.freeze({
  PAID_CL: 'PAID_CL',
  PAID_LEAVE: 'PAID_LEAVE',
  UNPAID: 'UNPAID',
});

export function defaultPayrollTreatment(leaveType) {
  const normalized = String(leaveType || '').toLowerCase();
  if (normalized === 'casual') return LEAVE_PAYROLL_TREATMENTS.PAID_CL;
  if (['sick', 'earned', 'maternity', 'paternity'].includes(normalized)) {
    return LEAVE_PAYROLL_TREATMENTS.PAID_LEAVE;
  }
  return LEAVE_PAYROLL_TREATMENTS.UNPAID;
}

export function effectiveLeaveType(leave) {
  const treatment = leave.payrollTreatment || leave.payroll_treatment || null;
  if (treatment === LEAVE_PAYROLL_TREATMENTS.PAID_CL) return 'casual';
  if (treatment === LEAVE_PAYROLL_TREATMENTS.PAID_LEAVE) return 'paid';
  if (treatment === LEAVE_PAYROLL_TREATMENTS.UNPAID) return 'unpaid';
  return leave.type || leave.leave_type;
}

function decimal(value) {
  const parsed = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanDays(value) {
  return Number(decimal(value).toFixed(2));
}

function isoDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

export function buildMonthlyDecisionSummary({
  year,
  month,
  requestedPayrollDays,
  clUsed,
  clEntitlement,
  entitlementReason,
}) {
  const requested = cleanDays(requestedPayrollDays);
  const used = cleanDays(clUsed);
  const entitlement = cleanDays(clEntitlement);
  const remaining = cleanDays(Math.max(0, entitlement - used));
  const paidIfCl = cleanDays(Math.min(requested, remaining));
  const unpaidIfCl = cleanDays(Math.max(0, requested - paidIfCl));

  return {
    year,
    month,
    month_key: `${year}-${String(month).padStart(2, '0')}`,
    requested_payroll_days: requested,
    cl_used_days: used,
    cl_entitlement_days: entitlement,
    cl_remaining_days: remaining,
    projected_paid_cl_days: paidIfCl,
    projected_unpaid_days: unpaidIfCl,
    unpaid_days_without_cl: requested,
    entitlement_reason: entitlementReason || null,
  };
}

function monthsCovered(startDate, endDate) {
  const [startYear, startMonth] = isoDate(startDate).split('-').map(Number);
  const [endYear, endMonth] = isoDate(endDate).split('-').map(Number);
  const months = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push({ year, month });
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function daysForRequestInMonth(leave, calculation, year, month) {
  const bounds = monthBounds(year, month);
  const leaveStart = isoDate(leave.start_date);
  const leaveEnd = isoDate(leave.end_date);
  const start = leaveStart > bounds.start ? leaveStart : bounds.start;
  const end = leaveEnd < bounds.end ? leaveEnd : bounds.end;
  const categories = new Map((calculation.days || []).map((day) => [day.date, day.category]));
  return eachDateInclusive(start, end).filter((date) => categories.get(date) === 'pending_leave').length;
}

/**
 * Adds an exact, payroll-engine-derived CL preview to pending staff requests.
 * Failures are isolated per staff/month so leave management remains usable while
 * payroll setup is incomplete; the card then explains that the preview is unavailable.
 */
export async function attachLeavePayrollContext(leaves, schoolId) {
  const pendingStaffLeaves = leaves.filter((leave) => leave.status === 'pending' && leave.staff_id);
  if (pendingStaffLeaves.length === 0) return leaves;

  const work = new Map();
  for (const leave of pendingStaffLeaves) {
    for (const period of monthsCovered(leave.start_date, leave.end_date)) {
      const key = `${leave.staff_id}:${period.year}-${period.month}`;
      if (!work.has(key)) work.set(key, { staffId: leave.staff_id, ...period });
    }
  }

  const calculations = new Map();
  // Keep database pressure bounded: each assembly performs several scoped reads.
  const queue = [...work.entries()];
  const worker = async () => {
    while (queue.length > 0) {
      const [key, job] = queue.shift();
      try {
        const assembled = await assemblePayrollInput(sql, schoolId, job.staffId, job.year, job.month);
        calculations.set(key, { calculation: calculateTeacherSalary(assembled.input) });
      } catch (error) {
        console.warn(`[leaves] payroll preview unavailable for ${key}: ${error.message}`);
        calculations.set(key, { error: 'Complete this staff member’s payroll setup to see the CL salary preview.' });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, () => worker()));

  return leaves.map((leave) => {
    if (leave.status !== 'pending' || !leave.staff_id) return leave;
    const payrollMonths = monthsCovered(leave.start_date, leave.end_date).map(({ year, month }) => {
      const entry = calculations.get(`${leave.staff_id}:${year}-${month}`);
      if (!entry || entry.error) {
        return {
          year,
          month,
          month_key: `${year}-${String(month).padStart(2, '0')}`,
          available: false,
          unavailable_reason: entry?.error || 'Payroll preview is unavailable.',
        };
      }
      const attendance = entry.calculation.attendance;
      return {
        available: true,
        ...buildMonthlyDecisionSummary({
          year,
          month,
          requestedPayrollDays: daysForRequestInMonth(leave, entry.calculation, year, month),
          clUsed: attendance.clUsed,
          clEntitlement: attendance.paidClEntitlement,
          entitlementReason: attendance.clEntitlementReason,
        }),
      };
    });
    return { ...leave, payroll_months: payrollMonths };
  });
}

export async function findLockedPayrollForLeave({ schoolId, staffId, startDate, endDate }) {
  const [locked] = await sql`
    SELECT id, payroll_month, payroll_year, workflow_status
    FROM staff_payroll
    WHERE school_id = ${schoolId}
      AND staff_id = ${staffId}
      AND workflow_status IN ('APPROVED', 'LOCKED', 'PAID')
      AND make_date(payroll_year, payroll_month, 1) <= date_trunc('month', ${endDate}::date)::date
      AND make_date(payroll_year, payroll_month, 1) >= date_trunc('month', ${startDate}::date)::date
    ORDER BY payroll_year, payroll_month
    LIMIT 1
  `;
  return locked || null;
}
