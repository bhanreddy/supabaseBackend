/**
 * Loads teacher, attendance, leave, holiday, and salary records and stores an
 * immutable calculation snapshot on staff_payroll. Draft rows can be
 * recalculated. Approved, locked, and paid rows cannot.
 */
import { createHash } from 'node:crypto';
import sql from '../db.js';
import { canonicalJsonStringify } from '../utils/canonicalPayload.js';
import { ZERO, fromDecimal, add, sub, toDecimal } from '../utils/money.js';
import {
  CALCULATION_VERSION,
  DEFAULT_PAYROLL_POLICY,
  applicableHolidayDates,
  calculateTeacherSalary,
  monthBounds,
  normalizePolicy,
  addDays,
} from './teacherSalaryCalculation.js';
import { publicPayslipAttendance } from './payrollAttendancePolicy.js';
import {
  assertCanRecalculate,
  assertTransition,
  authorizePayrollAction,
  canReadPayroll,
  isPublished,
  PayrollWorkflowError,
} from './teacherPayrollWorkflow.js';

export class PayrollError extends Error {
  constructor(status, message, code, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function hashInput(input) {
  return createHash('sha256').update(canonicalJsonStringify(input)).digest('hex');
}

function actorOrReject(actorId) {
  if (!actorId) throw new PayrollError(401, 'A signed-in user is required for payroll actions.', 'UNAUTHORIZED');
  return actorId;
}

export async function writeAudit(db, { schoolId, payrollId, staffId, actorId, action, detail }) {
  await db`
    INSERT INTO teacher_payroll_audit_logs (
      school_id, staff_payroll_id, staff_id, actor_id, action, detail
    ) VALUES (
      ${schoolId}, ${payrollId}, ${staffId}, ${actorId}, ${action}, ${db.json(detail || {})}
    )
  `;
}

async function loadStaff(db, schoolId, staffId) {
  const [staff] = await db`
    SELECT s.id, s.school_id, s.staff_code, s.person_id, s.joining_date, s.relieving_date,
           s.employment_type, s.probation_end_date, s.department_name, s.salary,
           s.weekly_off_weekdays, s.bank_account_last4, s.payment_reference_masked, s.campus_id,
           p.display_name, p.first_name, p.last_name,
           sd.name AS designation_name,
           cap.campus_name
    FROM staff s
    JOIN persons p ON p.id = s.person_id
    LEFT JOIN staff_designations sd ON sd.id = s.designation_id
    LEFT JOIN campus_attendance_policies cap ON cap.id = s.campus_id
    WHERE s.id = ${staffId} AND s.school_id = ${schoolId} AND s.deleted_at IS NULL
  `;
  if (!staff) throw new PayrollError(404, 'Teacher was not found in this school.', 'STAFF_NOT_FOUND');
  return staff;
}

function maskBank(last4) {
  if (!last4) return null;
  return `••••••••${String(last4).slice(-4)}`;
}

function displayName(staff) {
  return staff.display_name || [staff.first_name, staff.last_name].filter(Boolean).join(' ') || staff.staff_code;
}

export async function assemblePayrollInput(db, schoolId, staffId, year, month, payrollId = null) {
  const bounds = monthBounds(year, month);
  const staff = await loadStaff(db, schoolId, staffId);
  const joiningDate = isoDate(staff.joining_date);
  const relievingDate = isoDate(staff.relieving_date);
  const employmentStart = joiningDate && joiningDate > bounds.start ? joiningDate : bounds.start;
  const employmentEnd = relievingDate && relievingDate < bounds.end ? relievingDate : bounds.end;

  const policies = await db`
    SELECT id, effective_from, effective_to, config
    FROM school_payroll_policies
    WHERE school_id = ${schoolId}
      AND effective_from <= ${bounds.end}
      AND (effective_to IS NULL OR effective_to >= ${bounds.start})
    ORDER BY effective_from
  `;
  const policy = policies.length === 1
    ? normalizePolicy(policies[0].config || {})
    : normalizePolicy(DEFAULT_PAYROLL_POLICY);
  if (Array.isArray(staff.weekly_off_weekdays) && staff.weekly_off_weekdays.length > 0) {
    policy.weeklyOffWeekdays = staff.weekly_off_weekdays.map(Number);
  }

  const classifications = await db`
    SELECT classification, effective_from, effective_to
    FROM staff_locality_classifications
    WHERE school_id = ${schoolId} AND staff_id = ${staffId}
      AND effective_from <= ${bounds.end}
      AND (effective_to IS NULL OR effective_to >= ${bounds.start})
    ORDER BY effective_from
  `;
  let classification = null;
  let classificationChangedInMonth = classifications.length > 1;
  if (classifications.length === 1) {
    const row = classifications[0];
    const covers = isoDate(row.effective_from) <= employmentStart
      && (!row.effective_to || isoDate(row.effective_to) >= employmentEnd);
    if (covers) classification = row.classification;
    else classificationChangedInMonth = true;
  }

  const revisions = await db`
    SELECT id, monthly_salary, effective_from, effective_to
    FROM staff_salary_revisions
    WHERE school_id = ${schoolId} AND staff_id = ${staffId}
      AND effective_from <= ${bounds.end}
      AND (effective_to IS NULL OR effective_to >= ${bounds.start})
    ORDER BY effective_from
  `;

  const [calendar] = await db`
    SELECT
      (
        SELECT count(*)::int FROM calendar_events e
        WHERE e.school_id = ${schoolId} AND e.deleted_at IS NULL AND e.status = 'PUBLISHED'
          AND e.start_date <= ${bounds.end} AND e.end_date >= ${bounds.start}
      ) AS in_month,
      (
        SELECT count(*)::int FROM calendar_events e
        WHERE e.school_id = ${schoolId} AND e.deleted_at IS NULL AND e.status = 'PUBLISHED'
          AND EXISTS (
            SELECT 1 FROM academic_years ay
            WHERE ay.school_id = e.school_id
              AND ay.start_date <= ${bounds.end}
              AND ay.end_date >= ${bounds.start}
              AND e.start_date <= ay.end_date
              AND e.end_date >= ay.start_date
          )
      ) AS in_year
  `;

  const events = await db`
    SELECT e.id, e.title, e.status, e.event_type, e.holiday_type, e.start_date, e.end_date
    FROM calendar_events e
    WHERE e.school_id = ${schoolId} AND e.deleted_at IS NULL
      AND e.start_date <= ${bounds.end} AND e.end_date >= ${bounds.start}
  `;
  const eventIds = events.map((event) => event.id);
  const targets = eventIds.length === 0 ? [] : await db`
    SELECT event_id, target_type, target_id
    FROM calendar_event_targets
    WHERE school_id = ${schoolId} AND event_id IN ${db(eventIds)}
  `;
  const targetsByEvent = new Map();
  for (const target of targets) {
    const list = targetsByEvent.get(target.event_id) || [];
    list.push({ type: target.target_type, id: target.target_id });
    targetsByEvent.set(target.event_id, list);
  }
  const holidays = applicableHolidayDates(events.map((event) => ({
    id: event.id,
    title: event.title,
    status: event.status,
    eventType: event.event_type,
    holidayType: event.holiday_type,
    startDate: isoDate(event.start_date),
    endDate: isoDate(event.end_date),
    targets: targetsByEvent.get(event.id) || [],
  })), bounds.start, bounds.end, policy);

  const attendance = await db`
    SELECT attendance_date, status, is_on_duty, late_converted_to_half_day, deleted_at
    FROM staff_attendance
    WHERE school_id = ${schoolId} AND staff_id = ${staffId}
      AND attendance_date BETWEEN ${bounds.start} AND ${bounds.end}
      AND deleted_at IS NULL
  `;

  const [user] = await db`
    SELECT id FROM users
    WHERE person_id = ${staff.person_id} AND school_id = ${schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  const leaves = user ? await db`
    SELECT id, leave_type, start_date, end_date, status, payroll_treatment
    FROM leave_applications
    WHERE school_id = ${schoolId} AND applicant_id = ${user.id}
      AND end_date >= ${bounds.start} AND start_date <= ${bounds.end}
  ` : [];

  const [override] = await db`
    SELECT eligible, reason, created_by
    FROM staff_payroll_cl_overrides
    WHERE school_id = ${schoolId} AND staff_id = ${staffId}
      AND payroll_month = ${month} AND payroll_year = ${year}
  `;

  const adjustments = payrollId ? await db`
    SELECT id, kind, component_name, amount, reason, supporting_reference, created_by, approved_by
    FROM teacher_payroll_adjustments
    WHERE school_id = ${schoolId} AND staff_payroll_id = ${payrollId}
    ORDER BY created_at
  ` : [];

  const [attendanceSummaryRow] = payrollId ? await db`
    SELECT input_mode, cl_days, non_cl_days, late_count, provider_name, supporting_reference,
           reason, verified, version, updated_by
    FROM teacher_payroll_attendance_summaries
    WHERE school_id = ${schoolId} AND staff_payroll_id = ${payrollId}
  ` : [];

  const [holidayOverrideRow] = await db`
    SELECT holiday_count, source, provider_name, supporting_reference, reason, version
    FROM school_payroll_period_overrides
    WHERE school_id = ${schoolId} AND payroll_year = ${year} AND payroll_month = ${month}
  `;

  const input = {
    year,
    month,
    policy,
    policiesOverlapping: policies.length,
    holidayCalendarPublished: Number(calendar?.in_month || 0) + Number(calendar?.in_year || 0) > 0,
    holidays,
    attendance: attendance.map((row) => ({
      date: isoDate(row.attendance_date),
      status: row.status,
      approved: true,
      onDuty: Boolean(row.is_on_duty),
      convertedFromLate: Boolean(row.late_converted_to_half_day),
    })),
    leaves: leaves.map((leave) => ({
      id: leave.id,
      type: leave.leave_type,
      payrollTreatment: leave.payroll_treatment,
      status: leave.status,
      startDate: isoDate(leave.start_date),
      endDate: isoDate(leave.end_date),
    })),
    adjustments: adjustments.map((adjustment) => ({
      id: adjustment.id,
      kind: adjustment.kind,
      name: adjustment.component_name,
      amount: String(adjustment.amount),
      reason: adjustment.reason,
      reference: adjustment.supporting_reference,
      createdBy: adjustment.created_by,
      approvedBy: adjustment.approved_by,
    })),
    attendanceSummary: attendanceSummaryRow?.input_mode === 'MANUAL_SUMMARY' ? {
      mode: 'MANUAL_SUMMARY',
      clDays: String(attendanceSummaryRow.cl_days),
      nonClDays: String(attendanceSummaryRow.non_cl_days),
      lateCount: Number(attendanceSummaryRow.late_count),
      verified: Boolean(attendanceSummaryRow.verified),
      reason: attendanceSummaryRow.reason,
      providerName: attendanceSummaryRow.provider_name,
      reference: attendanceSummaryRow.supporting_reference,
      version: attendanceSummaryRow.version,
      updatedBy: attendanceSummaryRow.updated_by,
    } : { mode: 'SYSTEM_DAILY' },
    holidayOverride: holidayOverrideRow ? {
      count: Number(holidayOverrideRow.holiday_count),
      source: holidayOverrideRow.source,
      providerName: holidayOverrideRow.provider_name,
      reference: holidayOverrideRow.supporting_reference,
      reason: holidayOverrideRow.reason,
      version: holidayOverrideRow.version,
    } : null,
    teacher: {
      classification,
      classificationChangedInMonth,
      employmentType: staff.employment_type,
      joiningDate,
      relievingDate,
      probationEndDate: isoDate(staff.probation_end_date),
      clOverride: override ? { eligible: override.eligible, reason: override.reason } : null,
      salarySegments: revisions.map((revision) => ({
        id: revision.id,
        effectiveFrom: isoDate(revision.effective_from),
        effectiveTo: isoDate(revision.effective_to),
        monthlySalary: String(revision.monthly_salary),
      })),
    },
  };

  const identity = {
    name: displayName(staff),
    staffCode: staff.staff_code,
    campus: staff.campus_name || null,
    department: staff.department_name || null,
    designation: staff.designation_name || null,
    classification,
    employmentType: staff.employment_type,
    bankMasked: maskBank(staff.bank_account_last4),
    paymentReferenceMasked: staff.payment_reference_masked || null,
  };
  return { input, identity, staff, policy };
}

export function presentPayroll(payroll, snapshot) {
  return present(payroll, snapshot);
}

function present(payroll, snapshot) {
  const result = snapshot?.result || {};
  return {
    id: payroll.id,
    staffId: payroll.staff_id,
    payrollMonth: payroll.payroll_month,
    payrollYear: payroll.payroll_year,
    workflowStatus: payroll.workflow_status,
    status: payroll.status,
    runKind: payroll.run_kind,
    runSequence: payroll.run_sequence,
    requiresReview: payroll.requires_review,
    reviewReason: payroll.review_reason,
    paymentDate: payroll.payment_date,
    paymentReference: payroll.payment_reference,
    calculationVersion: payroll.calculation_version,
    publishAt: snapshot?.publish_at || null,
    identity: result.identity || null,
    month: result.month || null,
    employment: result.employment || null,
    perDaySalary: result.perDaySalary || null,
    attendance: result.attendance || null,
    lineItems: result.lineItems || [],
    grossContract: result.grossContract || null,
    grossEarnings: result.grossEarnings || null,
    totalDeductions: result.totalDeductions || null,
    netSalary: result.netSalary || String(payroll.net_salary),
    amountInWords: result.amountInWords || null,
    validation: result.validation || [],
    blocked: Boolean(result.blocked),
  };
}

export async function saveCalculation(db, payroll, input, identity, actorId) {
  const result = calculateTeacherSalary(input);
  result.identity = identity;
  const inputHash = hashInput(input);
  const sumLines = (lines) => lines.reduce((sum, line) => add(sum, fromDecimal(line.amount)), ZERO);
  const bonus = toDecimal(sumLines(result.lineItems.filter((line) => line.kind === 'earning' && line.code !== 'GROSS_CONTRACT')), 2);
  const deductionTotal = toDecimal(sumLines(result.lineItems.filter((line) => line.kind === 'deduction')), 2);
  const firstBlock = result.validation.find((item) => item.severity === 'block');

  const [finalPayroll] = await db`
    UPDATE staff_payroll
    SET base_salary = ${result.grossContract},
        bonus = ${bonus},
        deductions = ${deductionTotal},
        salary_adjustment = 0,
        net_salary = ${result.netSalary},
        workflow_status = 'DRAFT',
        status = 'pending',
        calculation_engine = ${CALCULATION_VERSION},
        calculation_version = ${CALCULATION_VERSION},
        requires_review = ${result.blocked},
        review_reason = ${firstBlock?.message || null},
        prepared_by = ${actorId},
        prepared_at = now(),
        validated_by = NULL,
        validated_at = NULL,
        updated_at = now()
    WHERE id = ${payroll.id} AND school_id = ${payroll.school_id}
    RETURNING *
  `;

  await db`
    INSERT INTO teacher_payroll_snapshots (
      school_id, staff_payroll_id, calculation_version, publish_at, input, input_hash, result, created_by
    ) VALUES (
      ${payroll.school_id}, ${payroll.id}, ${CALCULATION_VERSION}, ${input.policy.payslipPublishAt},
      ${db.json(input)}, ${inputHash}, ${db.json(result)}, ${actorId}
    )
    ON CONFLICT (staff_payroll_id) DO UPDATE
    SET calculation_version = EXCLUDED.calculation_version,
        publish_at = EXCLUDED.publish_at,
        input = EXCLUDED.input,
        input_hash = EXCLUDED.input_hash,
        result = EXCLUDED.result,
        created_by = EXCLUDED.created_by,
        created_at = now()
    WHERE teacher_payroll_snapshots.frozen = false
  `;
  return { payroll: finalPayroll, result, inputHash };
}

export async function prepareTeacherPayroll({ schoolId, staffId, year, month, actorId, user }) {
  authorizePayrollAction(user, 'prepare');
  actorOrReject(actorId);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) {
    throw new PayrollError(400, 'A payroll month from 1 to 12 and a year are required.', 'INVALID_PERIOD');
  }
  return sql.begin(async (tx) => {
    const [existing] = await tx`
      SELECT * FROM staff_payroll
      WHERE school_id = ${schoolId} AND staff_id = ${staffId}
        AND payroll_month = ${month} AND payroll_year = ${year}
        AND run_kind = 'ORIGINAL' AND run_sequence = 0
    `;
    if (existing) assertCanRecalculate(existing.workflow_status);
    let payroll = existing;
    if (!payroll) {
      const [created] = await tx`
        INSERT INTO staff_payroll (
          school_id, staff_id, base_salary, net_salary, payroll_month, payroll_year, status,
          workflow_status, calculation_engine, calculation_version, run_kind, run_sequence
        ) VALUES (
          ${schoolId}, ${staffId}, 0, 0, ${month}, ${year}, 'pending',
          'DRAFT', ${CALCULATION_VERSION}, ${CALCULATION_VERSION}, 'ORIGINAL', 0
        )
        RETURNING *
      `;
      payroll = created;
    }
    const assembled = await assemblePayrollInput(tx, schoolId, staffId, year, month, payroll.id);
    const saved = await saveCalculation(tx, payroll, assembled.input, assembled.identity, actorId);
    await writeAudit(tx, {
      schoolId, payrollId: payroll.id, staffId, actorId, action: 'PREPARE',
      detail: { inputHash: saved.inputHash, blocked: saved.result.blocked },
    });
    const [snapshot] = await tx`SELECT * FROM teacher_payroll_snapshots WHERE staff_payroll_id = ${payroll.id}`;
    return present(saved.payroll, snapshot);
  });
}

async function loadOwned(db, schoolId, payrollId) {
  const [payroll] = await db`
    SELECT * FROM staff_payroll WHERE id = ${payrollId} AND school_id = ${schoolId}
  `;
  if (!payroll) throw new PayrollError(404, 'Payroll record was not found.', 'PAYROLL_NOT_FOUND');
  const [snapshot] = await db`
    SELECT * FROM teacher_payroll_snapshots WHERE staff_payroll_id = ${payrollId}
  `;
  return { payroll, snapshot };
}

async function assertFresh(db, payroll, snapshot) {
  if (!snapshot) throw new PayrollError(409, 'Calculate this payroll before continuing.', 'SNAPSHOT_MISSING');
  const assembled = await assemblePayrollInput(db, payroll.school_id, payroll.staff_id, payroll.payroll_year, payroll.payroll_month, payroll.id);
  const hash = hashInput(assembled.input);
  if (hash !== snapshot.input_hash) {
    await db`
      UPDATE staff_payroll
      SET requires_review = true, workflow_status = 'DRAFT',
          review_reason = 'Attendance, leave, holiday, or salary data changed after this draft. Recalculate before approval.',
          validated_by = NULL, validated_at = NULL
      WHERE id = ${payroll.id} AND workflow_status IN ('DRAFT', 'VALIDATED')
    `;
    throw new PayrollError(409, 'Source records changed after calculation. Recalculate this draft before approval.', 'STALE_PAYROLL');
  }
  return assembled;
}

export async function validateTeacherPayroll({ schoolId, payrollId, actorId, user }) {
  authorizePayrollAction(user, 'validate');
  actorOrReject(actorId);
  return sql.begin(async (tx) => {
    const { payroll, snapshot } = await loadOwned(tx, schoolId, payrollId);
    assertTransition(payroll.workflow_status, 'VALIDATED');
    await assertFresh(tx, payroll, snapshot);
    if (snapshot.result?.blocked && payroll.run_kind !== 'REVERSAL') {
      throw new PayrollError(422, 'Resolve the payroll validation errors before marking it validated.', 'VALIDATION_FAILED', snapshot.result.validation);
    }
    const [updated] = await tx`
      UPDATE staff_payroll
      SET workflow_status = 'VALIDATED', requires_review = false, review_reason = NULL,
          validated_by = ${actorId}, validated_at = now()
      WHERE id = ${payrollId}
      RETURNING *
    `;
    await writeAudit(tx, { schoolId, payrollId, staffId: payroll.staff_id, actorId, action: 'VALIDATE', detail: {} });
    return present(updated, snapshot);
  });
}

export async function approveTeacherPayroll({ schoolId, payrollId, actorId, user }) {
  authorizePayrollAction(user, 'approve');
  actorOrReject(actorId);
  return sql.begin(async (tx) => {
    const { payroll, snapshot } = await loadOwned(tx, schoolId, payrollId);
    assertTransition(payroll.workflow_status, 'APPROVED');
    if (payroll.run_kind !== 'REVERSAL') await assertFresh(tx, payroll, snapshot);
    if (snapshot?.result?.blocked) {
      throw new PayrollError(422, 'This payroll still has blocking validation errors.', 'VALIDATION_FAILED', snapshot.result.validation);
    }
    const [updated] = await tx`
      UPDATE staff_payroll
      SET workflow_status = 'APPROVED', approved_by = ${actorId}, approved_at = now()
      WHERE id = ${payrollId}
      RETURNING *
    `;
    await tx`
      UPDATE teacher_payroll_snapshots SET frozen = true WHERE staff_payroll_id = ${payrollId}
    `;
    await writeAudit(tx, { schoolId, payrollId, staffId: payroll.staff_id, actorId, action: 'APPROVE', detail: {} });
    const [frozen] = await tx`SELECT * FROM teacher_payroll_snapshots WHERE staff_payroll_id = ${payrollId}`;
    return present(updated, frozen);
  });
}

export async function lockTeacherPayroll({ schoolId, payrollId, actorId, user }) {
  authorizePayrollAction(user, 'lock');
  actorOrReject(actorId);
  return sql.begin(async (tx) => {
    const { payroll, snapshot } = await loadOwned(tx, schoolId, payrollId);
    assertTransition(payroll.workflow_status, 'LOCKED');
    const [updated] = await tx`
      UPDATE staff_payroll
      SET workflow_status = 'LOCKED', locked_by = ${actorId}, locked_at = now()
      WHERE id = ${payrollId}
      RETURNING *
    `;
    await writeAudit(tx, { schoolId, payrollId, staffId: payroll.staff_id, actorId, action: 'LOCK', detail: {} });
    return present(updated, snapshot);
  });
}

export async function payTeacherPayroll({ schoolId, payrollId, actorId, user, paymentDate, paymentReference, paymentMethod }) {
  authorizePayrollAction(user, 'pay');
  actorOrReject(actorId);
  if (!paymentDate || !paymentReference) {
    throw new PayrollError(400, 'Payment date and a transaction reference are required.', 'PAYMENT_REFERENCE_REQUIRED');
  }
  return sql.begin(async (tx) => {
    const { payroll, snapshot } = await loadOwned(tx, schoolId, payrollId);
    assertTransition(payroll.workflow_status, 'PAID');
    const [updated] = await tx`
      UPDATE staff_payroll
      SET workflow_status = 'PAID', status = 'paid', payment_date = ${paymentDate},
          payment_reference = ${paymentReference}, payment_method = ${paymentMethod || null},
          paid_by = ${actorId}
      WHERE id = ${payrollId}
      RETURNING *
    `;
    await writeAudit(tx, {
      schoolId, payrollId, staffId: payroll.staff_id, actorId, action: 'PAY',
      detail: { paymentDate, paymentReference },
    });
    return present(updated, snapshot);
  });
}

export async function forcePayTeacherPayroll({ schoolId, payrollId, actorId, user }) {
  if (!user?.roles?.includes('admin')) {
    throw new PayrollWorkflowError('Only an administrator can force pay a payslip.', 'FORBIDDEN');
  }
  actorOrReject(actorId);
  return sql.begin(async (tx) => {
    const { payroll, snapshot } = await loadOwned(tx, schoolId, payrollId);
    if (payroll.workflow_status === 'PAID' || payroll.status === 'paid') {
      throw new PayrollError(409, 'This payslip is already paid.', 'ALREADY_PAID');
    }
    const paymentDate = new Date().toISOString().slice(0, 10);
    const [updated] = await tx`
      UPDATE staff_payroll
      SET workflow_status = 'PAID',
          status = 'paid',
          payment_date = ${paymentDate},
          payment_reference = ${`FORCE-${paymentDate}`},
          paid_by = ${actorId}
      WHERE id = ${payrollId}
      RETURNING *
    `;
    await writeAudit(tx, {
      schoolId,
      payrollId,
      staffId: payroll.staff_id,
      actorId,
      action: 'FORCE_PAY',
      detail: {
        paymentDate,
        reviewReason: payroll.review_reason || null,
        previousStatus: payroll.workflow_status,
      },
    });
    return present(updated, snapshot);
  });
}

export async function addPayrollAdjustment({ schoolId, payrollId, actorId, user, kind, name, amount, reason, reference }) {
  authorizePayrollAction(user, 'adjust');
  actorOrReject(actorId);
  if (!['EARNING', 'DEDUCTION'].includes(kind) || !name || !reason || !amount) {
    throw new PayrollError(400, 'Adjustment type, name, amount, and reason are required.', 'ADJUSTMENT_INCOMPLETE');
  }
  return sql.begin(async (tx) => {
    const { payroll } = await loadOwned(tx, schoolId, payrollId);
    assertCanRecalculate(payroll.workflow_status);
    const [adjustment] = await tx`
      INSERT INTO teacher_payroll_adjustments (
        school_id, staff_payroll_id, kind, component_name, amount, reason, supporting_reference, created_by
      ) VALUES (
        ${schoolId}, ${payrollId}, ${kind}, ${name}, ${amount}, ${reason}, ${reference || null}, ${actorId}
      )
      RETURNING *
    `;
    await writeAudit(tx, {
      schoolId, payrollId, staffId: payroll.staff_id, actorId, action: 'ADJUSTMENT_CREATED',
      detail: { adjustmentId: adjustment.id, kind, amount, reason },
    });
    const assembled = await assemblePayrollInput(tx, schoolId, payroll.staff_id, payroll.payroll_year, payroll.payroll_month, payroll.id);
    const saved = await saveCalculation(tx, payroll, assembled.input, assembled.identity, actorId);
    const [snapshot] = await tx`SELECT * FROM teacher_payroll_snapshots WHERE staff_payroll_id = ${payroll.id}`;
    return { adjustment, payroll: present(saved.payroll, snapshot) };
  });
}

export async function approvePayrollAdjustment({ schoolId, payrollId, adjustmentId, actorId, user }) {
  authorizePayrollAction(user, 'approveAdjustment');
  actorOrReject(actorId);
  return sql.begin(async (tx) => {
    const { payroll } = await loadOwned(tx, schoolId, payrollId);
    assertCanRecalculate(payroll.workflow_status);
    const [adjustment] = await tx`
      UPDATE teacher_payroll_adjustments
      SET approved_by = ${actorId}, approved_at = now()
      WHERE id = ${adjustmentId} AND staff_payroll_id = ${payrollId} AND school_id = ${schoolId}
        AND approved_by IS NULL
      RETURNING *
    `;
    if (!adjustment) throw new PayrollError(404, 'Unapproved adjustment was not found.', 'ADJUSTMENT_NOT_FOUND');
    await writeAudit(tx, {
      schoolId, payrollId, staffId: payroll.staff_id, actorId, action: 'ADJUSTMENT_APPROVED',
      detail: { adjustmentId },
    });
    const assembled = await assemblePayrollInput(tx, schoolId, payroll.staff_id, payroll.payroll_year, payroll.payroll_month, payroll.id);
    const saved = await saveCalculation(tx, payroll, assembled.input, assembled.identity, actorId);
    const [snapshot] = await tx`SELECT * FROM teacher_payroll_snapshots WHERE staff_payroll_id = ${payroll.id}`;
    return present(saved.payroll, snapshot);
  });
}

async function nextSequence(tx, payroll, runKind) {
  const [row] = await tx`
    SELECT COALESCE(MAX(run_sequence), 0)::int AS max_sequence
    FROM staff_payroll
    WHERE school_id = ${payroll.school_id} AND staff_id = ${payroll.staff_id}
      AND payroll_month = ${payroll.payroll_month} AND payroll_year = ${payroll.payroll_year}
      AND run_kind = ${runKind}
  `;
  return Number(row.max_sequence) + 1;
}

export async function createSupplementaryPayroll({ schoolId, payrollId, actorId, user }) {
  authorizePayrollAction(user, 'prepare');
  actorOrReject(actorId);
  return sql.begin(async (tx) => {
    const { payroll } = await loadOwned(tx, schoolId, payrollId);
    if (!['LOCKED', 'PAID'].includes(payroll.workflow_status)) {
      throw new PayrollError(409, 'A supplementary payroll can only be opened from a locked or paid payroll.', 'NOT_LOCKED');
    }
    const sequence = await nextSequence(tx, payroll, 'SUPPLEMENTARY');
    const [created] = await tx`
      INSERT INTO staff_payroll (
        school_id, staff_id, base_salary, net_salary, payroll_month, payroll_year, status,
        workflow_status, calculation_engine, calculation_version, run_kind, run_sequence, reversal_of_id
      ) VALUES (
        ${schoolId}, ${payroll.staff_id}, 0, 0, ${payroll.payroll_month}, ${payroll.payroll_year}, 'pending',
        'DRAFT', ${CALCULATION_VERSION}, ${CALCULATION_VERSION}, 'SUPPLEMENTARY', ${sequence}, ${payroll.id}
      )
      RETURNING *
    `;
    const assembled = await assemblePayrollInput(tx, schoolId, payroll.staff_id, payroll.payroll_year, payroll.payroll_month, created.id);
    const saved = await saveCalculation(tx, created, assembled.input, assembled.identity, actorId);
    await writeAudit(tx, {
      schoolId, payrollId: created.id, staffId: payroll.staff_id, actorId, action: 'SUPPLEMENTARY',
      detail: { sourcePayrollId: payroll.id },
    });
    const [snapshot] = await tx`SELECT * FROM teacher_payroll_snapshots WHERE staff_payroll_id = ${created.id}`;
    return present(saved.payroll, snapshot);
  });
}

export async function createReversalPayroll({ schoolId, payrollId, actorId, user, reason }) {
  authorizePayrollAction(user, 'prepare');
  actorOrReject(actorId);
  if (!reason) throw new PayrollError(400, 'A reversal reason is required.', 'REVERSAL_REASON_REQUIRED');
  return sql.begin(async (tx) => {
    const { payroll, snapshot } = await loadOwned(tx, schoolId, payrollId);
    if (!['LOCKED', 'PAID'].includes(payroll.workflow_status) || !snapshot) {
      throw new PayrollError(409, 'Only a locked calculated payroll can be reversed.', 'NOT_LOCKED');
    }
    const sequence = await nextSequence(tx, payroll, 'REVERSAL');
    const originalNet = snapshot.result.netSalary;
    const reversedNet = toDecimal(sub(ZERO, fromDecimal(originalNet)), 2);
    const reversalResult = {
      ...snapshot.result,
      blocked: false,
      requiresReview: false,
      validation: [],
      reversalOf: payroll.id,
      lineItems: [{
        code: 'PAYROLL_REVERSAL',
        name: 'Payroll reversal',
        kind: 'deduction',
        quantity: '1',
        rate: originalNet,
        amount: originalNet.startsWith('-') ? originalNet.slice(1) : originalNet,
        amountUnrounded: originalNet,
        source: 'reversal',
        explanation: `Reversal of payroll ${payroll.id}. ${reason}`,
      }],
      grossEarnings: '0.00',
      totalDeductions: originalNet.startsWith('-') ? originalNet.slice(1) : originalNet,
      netSalary: reversedNet,
      amountInWords: `Minus ${snapshot.result.amountInWords || originalNet}`,
    };
    const [created] = await tx`
      INSERT INTO staff_payroll (
        school_id, staff_id, base_salary, bonus, deductions, net_salary, payroll_month, payroll_year,
        status, workflow_status, calculation_engine, calculation_version, run_kind, run_sequence,
        reversal_of_id, requires_review, prepared_by, prepared_at
      ) VALUES (
        ${schoolId}, ${payroll.staff_id}, 0, 0, ${originalNet.startsWith('-') ? originalNet.slice(1) : originalNet}, ${reversedNet},
        ${payroll.payroll_month}, ${payroll.payroll_year}, 'pending', 'DRAFT', ${CALCULATION_VERSION},
        ${CALCULATION_VERSION}, 'REVERSAL', ${sequence}, ${payroll.id}, false, ${actorId}, now()
      )
      RETURNING *
    `;
    await tx`
      INSERT INTO teacher_payroll_snapshots (
        school_id, staff_payroll_id, calculation_version, publish_at, input, input_hash, result, created_by
      ) VALUES (
        ${schoolId}, ${created.id}, ${CALCULATION_VERSION}, ${snapshot.publish_at},
        ${tx.json({ reversalOf: payroll.id, reason, sourceHash: snapshot.input_hash })},
        ${snapshot.input_hash}, ${tx.json(reversalResult)}, ${actorId}
      )
    `;
    await writeAudit(tx, {
      schoolId, payrollId: created.id, staffId: payroll.staff_id, actorId, action: 'REVERSAL',
      detail: { sourcePayrollId: payroll.id, reason },
    });
    const [createdSnapshot] = await tx`SELECT * FROM teacher_payroll_snapshots WHERE staff_payroll_id = ${created.id}`;
    return present(created, createdSnapshot);
  });
}

export async function getTeacherPayroll({ schoolId, payrollId, user, personId }) {
  const { payroll, snapshot } = await loadOwned(sql, schoolId, payrollId);
  const [staff] = await sql`SELECT person_id FROM staff WHERE id = ${payroll.staff_id} AND school_id = ${schoolId}`;
  const isSelf = Boolean(personId && staff?.person_id === personId);
  if (isSelf) {
    const publishAt = snapshot?.publish_at || 'LOCKED';
    if (!isPublished(payroll.workflow_status, publishAt)) {
      throw new PayrollError(403, 'This payslip is not published yet.', 'PAYSLIP_UNPUBLISHED');
    }
  } else if (!canReadPayroll(user)) {
    throw new PayrollWorkflowError('You do not have permission for this payroll action.', 'FORBIDDEN');
  }
  const body = present(payroll, snapshot);
  if (isSelf) body.attendance = publicPayslipAttendance(body.attendance);
  return body;
}

export async function getTeacherPayrollEvidence({ schoolId, payrollId, user }) {
  authorizePayrollAction(user, 'read');
  const { payroll, snapshot } = await loadOwned(sql, schoolId, payrollId);
  const audits = await sql`
    SELECT id, actor_id, action, detail, created_at
    FROM teacher_payroll_audit_logs
    WHERE school_id = ${schoolId} AND staff_payroll_id = ${payrollId}
    ORDER BY created_at
  `;
  return {
    payrollId: payroll.id,
    workflowStatus: payroll.workflow_status,
    calculationVersion: snapshot?.calculation_version || null,
    inputHash: snapshot?.input_hash || null,
    frozen: snapshot?.frozen || false,
    input: snapshot?.input || null,
    result: snapshot?.result || null,
    preparedBy: payroll.prepared_by,
    validatedBy: payroll.validated_by,
    approvedBy: payroll.approved_by,
    lockedBy: payroll.locked_by,
    paidBy: payroll.paid_by,
    audit: audits,
  };
}

export async function savePayrollPolicy({ schoolId, actorId, user, effectiveFrom, effectiveTo, config }) {
  authorizePayrollAction(user, 'prepare');
  actorOrReject(actorId);
  if (!effectiveFrom) throw new PayrollError(400, 'Policy effective_from is required.', 'POLICY_DATE_REQUIRED');
  const normalized = normalizePolicy(config || {});
  const previousEnd = addDays(effectiveFrom, -1);
  await sql`
    UPDATE school_payroll_policies
    SET effective_to = ${previousEnd}
    WHERE school_id = ${schoolId}
      AND effective_to IS NULL
      AND effective_from < ${effectiveFrom}
  `;
  const overlaps = await sql`
    SELECT id FROM school_payroll_policies
    WHERE school_id = ${schoolId}
      AND effective_from <= COALESCE(${effectiveTo}, DATE '9999-12-31')
      AND COALESCE(effective_to, DATE '9999-12-31') >= ${effectiveFrom}
  `;
  if (overlaps.length > 0) {
    throw new PayrollError(409, 'The policy dates overlap an existing salary policy. Close the previous policy first.', 'POLICY_OVERLAP');
  }
  const [policy] = await sql`
    INSERT INTO school_payroll_policies (school_id, effective_from, effective_to, config, created_by)
    VALUES (${schoolId}, ${effectiveFrom}, ${effectiveTo || null}, ${sql.json(normalized)}, ${actorId})
    RETURNING *
  `;
  await writeAudit(sql, { schoolId, payrollId: null, staffId: null, actorId, action: 'POLICY_SAVED', detail: { policyId: policy.id, effectiveFrom } });
  return policy;
}

export async function listPayrollPolicies(schoolId, user) {
  if (!canReadPayroll(user) && !user?.roles?.includes('admin') && !user?.permissions?.includes('payroll.prepare')) {
    throw new PayrollWorkflowError('You do not have permission for this payroll action.', 'FORBIDDEN');
  }
  return sql`
    SELECT id, effective_from, effective_to, config, created_by, created_at
    FROM school_payroll_policies
    WHERE school_id = ${schoolId}
    ORDER BY effective_from
  `;
}

const LOCALITY_VALUES = ['LOCAL', 'NON_LOCAL'];

/**
 * Staff forms send locality_classification as LOCAL, NON_LOCAL, null, or omit it.
 * Any other value is rejected before a staff row is written.
 */
export function readLocalityClassificationField(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'locality_classification')) {
    return { present: false, value: null };
  }
  const value = body.locality_classification;
  if (value === null || LOCALITY_VALUES.includes(value)) {
    return { present: true, value };
  }
  return { present: true, invalid: true, value };
}

/** First day of the payroll month that contains a school-local YYYY-MM-DD date. */
export function payrollMonthStart(isoDate) {
  const iso = String(isoDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return `${iso.slice(0, 7)}-01`;
}

export async function readEffectiveLocalityClassification(db, schoolId, staffId) {
  const [row] = await db`
    SELECT classification
    FROM staff_locality_classifications
    WHERE school_id = ${schoolId}
      AND staff_id = ${staffId}
      AND effective_from <= CURRENT_DATE
      AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
    ORDER BY effective_from DESC
    LIMIT 1
  `;
  return row?.classification ?? null;
}

async function listLocalityClassifications(db, schoolId, staffId) {
  return db`
    SELECT id, classification, effective_from, effective_to
    FROM staff_locality_classifications
    WHERE school_id = ${schoolId} AND staff_id = ${staffId}
    ORDER BY effective_from
  `;
}

async function closeOpenClassificationsBefore(db, schoolId, staffId, effectiveFrom) {
  await db`
    UPDATE staff_locality_classifications
    SET effective_to = ${addDays(effectiveFrom, -1)}
    WHERE school_id = ${schoolId} AND staff_id = ${staffId}
      AND effective_to IS NULL AND effective_from < ${effectiveFrom}
  `;
}

async function closeClassificationRow(db, { id, schoolId, staffId, effectiveTo }) {
  await db`
    UPDATE staff_locality_classifications
    SET effective_to = ${effectiveTo}
    WHERE id = ${id}
      AND school_id = ${schoolId}
      AND staff_id = ${staffId}
      AND effective_to IS NULL
  `;
}

async function deleteProspectiveClassification(db, { id, schoolId, staffId, effectiveFrom }) {
  await db`
    DELETE FROM staff_locality_classifications
    WHERE id = ${id}
      AND school_id = ${schoolId}
      AND staff_id = ${staffId}
      AND effective_from >= ${effectiveFrom}
  `;
}

async function updateClassificationStartingOn(db, { id, schoolId, staffId, classification, effectiveFrom }) {
  const [row] = await db`
    UPDATE staff_locality_classifications
    SET classification = ${classification}, effective_to = NULL
    WHERE id = ${id}
      AND school_id = ${schoolId}
      AND staff_id = ${staffId}
      AND effective_from = ${effectiveFrom}
    RETURNING *
  `;
  return row;
}

async function classificationOverlaps(db, schoolId, staffId, effectiveFrom, effectiveTo) {
  return db`
    SELECT id FROM staff_locality_classifications
    WHERE school_id = ${schoolId} AND staff_id = ${staffId}
      AND effective_from <= COALESCE(${effectiveTo}, DATE '9999-12-31')
      AND COALESCE(effective_to, DATE '9999-12-31') >= ${effectiveFrom}
  `;
}

export async function insertStaffLocalityClassification(db, {
  schoolId, staffId, classification, effectiveFrom, effectiveTo = null, actorId,
}) {
  const [row] = await db`
    INSERT INTO staff_locality_classifications (
      school_id, staff_id, classification, effective_from, effective_to, created_by
    ) VALUES (
      ${schoolId}, ${staffId}, ${classification}, ${effectiveFrom}, ${effectiveTo || null}, ${actorId}
    )
    RETURNING *
  `;
  return row;
}

/**
 * Temporal locality change used by Edit Staff. Does not require payroll.prepare
 * and does not rewrite payroll snapshots. Callers run this inside the staff
 * transaction so the staff row and classification commit together.
 *
 * effectiveFrom is the first day of the current payroll month. A row that
 * already starts on that date is updated in place. Clearing null closes an
 * earlier open row; a row that starts on or after effectiveFrom is removed
 * because closing it before it starts would violate the date check, and it
 * has not covered a prior payroll month.
 */
export async function applyStaffLocalityClassification(db, {
  schoolId, staffId, actorId, classification, effectiveFrom,
}) {
  if (![...LOCALITY_VALUES, null].includes(classification) || !effectiveFrom) {
    throw new PayrollError(400, 'Classification must be LOCAL, NON_LOCAL, or null and include an effective date.', 'INVALID_CLASSIFICATION');
  }

  const current = await readEffectiveLocalityClassification(db, schoolId, staffId);
  if ((current || null) === classification) {
    return { changed: false, classification: current };
  }

  const rows = await listLocalityClassifications(db, schoolId, staffId);
  if (classification == null) {
    for (const row of rows) {
      const from = isoDate(row.effective_from);
      const to = isoDate(row.effective_to);
      if (to && to < effectiveFrom) continue;
      if (from < effectiveFrom) {
        await closeClassificationRow(db, {
          id: row.id,
          schoolId,
          staffId,
          effectiveTo: addDays(effectiveFrom, -1),
        });
      } else {
        await deleteProspectiveClassification(db, { id: row.id, schoolId, staffId, effectiveFrom });
      }
    }
    await writeAudit(db, {
      schoolId,
      payrollId: null,
      staffId,
      actorId,
      action: 'CLASSIFICATION_CLEARED',
      detail: { previous: current, effectiveFrom, source: 'staff' },
    });
    return { changed: true, classification: null };
  }

  let kept = null;
  for (const row of rows) {
    const from = isoDate(row.effective_from);
    const to = isoDate(row.effective_to);
    if (to && to < effectiveFrom) continue;
    if (from < effectiveFrom) {
      await closeClassificationRow(db, {
        id: row.id,
        schoolId,
        staffId,
        effectiveTo: addDays(effectiveFrom, -1),
      });
    } else if (from === effectiveFrom && !kept) {
      kept = row;
    } else {
      await deleteProspectiveClassification(db, { id: row.id, schoolId, staffId, effectiveFrom });
    }
  }

  const saved = kept
    ? await updateClassificationStartingOn(db, {
      id: kept.id, schoolId, staffId, classification, effectiveFrom,
    })
    : await insertAfterOverlapCheck(db, { schoolId, staffId, classification, effectiveFrom, actorId });

  await writeAudit(db, {
    schoolId,
    payrollId: null,
    staffId,
    actorId,
    action: 'CLASSIFICATION_SAVED',
    detail: { classification, previous: current, effectiveFrom, source: 'staff' },
  });
  return { changed: true, classification, row: saved };
}

async function insertAfterOverlapCheck(db, { schoolId, staffId, classification, effectiveFrom, actorId }) {
  const overlaps = await classificationOverlaps(db, schoolId, staffId, effectiveFrom, null);
  if (overlaps.length > 0) {
    throw new PayrollError(409, 'This classification overlaps an existing effective period.', 'CLASSIFICATION_OVERLAP');
  }
  return insertStaffLocalityClassification(db, {
    schoolId, staffId, classification, effectiveFrom, effectiveTo: null, actorId,
  });
}

export async function saveClassification({ schoolId, staffId, actorId, user, classification, effectiveFrom, effectiveTo }) {
  authorizePayrollAction(user, 'prepare');
  actorOrReject(actorId);
  if (!LOCALITY_VALUES.includes(classification) || !effectiveFrom) {
    throw new PayrollError(400, 'Classification must be LOCAL or NON_LOCAL and include an effective date.', 'INVALID_CLASSIFICATION');
  }
  await loadStaff(sql, schoolId, staffId);
  await closeOpenClassificationsBefore(sql, schoolId, staffId, effectiveFrom);
  const overlaps = await classificationOverlaps(sql, schoolId, staffId, effectiveFrom, effectiveTo || null);
  if (overlaps.length > 0) {
    throw new PayrollError(409, 'This classification overlaps an existing effective period.', 'CLASSIFICATION_OVERLAP');
  }
  const row = await insertStaffLocalityClassification(sql, {
    schoolId, staffId, classification, effectiveFrom, effectiveTo: effectiveTo || null, actorId,
  });
  await writeAudit(sql, { schoolId, payrollId: null, staffId, actorId, action: 'CLASSIFICATION_SAVED', detail: { classification, effectiveFrom } });
  return row;
}

export async function saveSalaryRevision({ schoolId, staffId, actorId, user, monthlySalary, effectiveFrom, effectiveTo, reason }) {
  authorizePayrollAction(user, 'prepare');
  actorOrReject(actorId);
  if (!monthlySalary || !effectiveFrom || !reason) {
    throw new PayrollError(400, 'Salary, effective date, and reason are required.', 'SALARY_REVISION_INCOMPLETE');
  }
  await loadStaff(sql, schoolId, staffId);
  await sql`
    UPDATE staff_salary_revisions
    SET effective_to = ${addDays(effectiveFrom, -1)}
    WHERE school_id = ${schoolId} AND staff_id = ${staffId}
      AND effective_to IS NULL AND effective_from < ${effectiveFrom}
  `;
  const overlaps = await sql`
    SELECT id FROM staff_salary_revisions
    WHERE school_id = ${schoolId} AND staff_id = ${staffId}
      AND effective_from <= COALESCE(${effectiveTo}, DATE '9999-12-31')
      AND COALESCE(effective_to, DATE '9999-12-31') >= ${effectiveFrom}
  `;
  if (overlaps.length > 0) {
    throw new PayrollError(409, 'This salary revision overlaps an existing salary period. Close the previous revision first.', 'SALARY_OVERLAP');
  }
  const [row] = await sql`
    INSERT INTO staff_salary_revisions (
      school_id, staff_id, monthly_salary, effective_from, effective_to, reason, created_by
    ) VALUES (
      ${schoolId}, ${staffId}, ${monthlySalary}, ${effectiveFrom}, ${effectiveTo || null}, ${reason}, ${actorId}
    )
    RETURNING *
  `;
  await sql`
    UPDATE staff SET salary = ${monthlySalary}, updated_at = now()
    WHERE id = ${staffId} AND school_id = ${schoolId}
      AND NOT EXISTS (
        SELECT 1 FROM staff_salary_revisions newer
        WHERE newer.staff_id = ${staffId} AND newer.effective_from > ${effectiveFrom}
      )
  `;
  await writeAudit(sql, { schoolId, payrollId: null, staffId, actorId, action: 'SALARY_REVISION_SAVED', detail: { monthlySalary, effectiveFrom, reason } });
  return row;
}

export async function saveClOverride({ schoolId, staffId, actorId, user, year, month, eligible, reason }) {
  authorizePayrollAction(user, 'prepare');
  actorOrReject(actorId);
  if (typeof eligible !== 'boolean' || !reason) {
    throw new PayrollError(400, 'A casual-leave override needs an eligible flag and a reason.', 'CL_OVERRIDE_INCOMPLETE');
  }
  await loadStaff(sql, schoolId, staffId);
  const [row] = await sql`
    INSERT INTO staff_payroll_cl_overrides (
      school_id, staff_id, payroll_month, payroll_year, eligible, reason, created_by
    ) VALUES (
      ${schoolId}, ${staffId}, ${month}, ${year}, ${eligible}, ${reason}, ${actorId}
    )
    ON CONFLICT (school_id, staff_id, payroll_month, payroll_year) DO UPDATE
    SET eligible = EXCLUDED.eligible, reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = now()
    RETURNING *
  `;
  await writeAudit(sql, { schoolId, payrollId: null, staffId, actorId, action: 'CL_OVERRIDE_SAVED', detail: { year, month, eligible, reason } });
  return row;
}
