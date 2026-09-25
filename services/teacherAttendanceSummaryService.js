/**
 * Manual monthly attendance totals for teacher payroll.
 * Preview uses the same calculator as save and does not write.
 * A holiday-count change recalculates every mutable payroll in the school month.
 */
import sql from '../db.js';
import { calculateTeacherSalary } from './teacherSalaryCalculation.js';
import {
  classifyRecalculation,
  holidaySaveDecision,
  payloadRejection,
  projectPayrollInput,
  systemComparisonInput,
  versionConflict,
} from './payrollAttendancePolicy.js';
import { PayrollWorkflowError, authorizePayrollAction } from './teacherPayrollWorkflow.js';
import {
  PayrollError as PayrollDataError,
  assemblePayrollInput,
  prepareTeacherPayroll,
  presentPayroll,
  saveCalculation,
  writeAudit,
} from './teacherPayrollService.js';

function actorOrReject(actorId) {
  if (!actorId) throw new PayrollDataError(401, 'A signed-in user is required for payroll actions.', 'UNAUTHORIZED');
  return actorId;
}

function assertCanList(user) {
  if (user?.roles?.includes('admin')) return;
  const permissions = user?.permissions || [];
  const allowed = ['payroll.prepare', 'payroll.audit', 'payroll.approve', 'payroll.pay', 'payroll.process', 'payslip.view'];
  if (permissions.some((permission) => allowed.includes(permission))) return;
  throw new PayrollWorkflowError('You do not have permission for this payroll action.', 'FORBIDDEN');
}

function proposalFromBody(body = {}) {
  return {
    mode: body.mode || body.input_mode || 'SYSTEM_DAILY',
    clDays: body.cl_days ?? body.clDays ?? '0',
    nonClDays: body.non_cl_days ?? body.nonClDays ?? '0',
    lateCount: body.late_count ?? body.lateCount ?? 0,
    verified: body.verified === true,
    reason: body.reason == null ? '' : String(body.reason),
    providerName: body.provider_name ?? body.providerName ?? null,
    reference: body.supporting_reference ?? body.reference ?? null,
    holidayCount: body.holiday_count ?? body.holidayCount,
    holidaySource: body.holiday_source || body.holidaySource || 'MANUAL',
    origin: body.origin === 'THIRD_PARTY' ? 'THIRD_PARTY' : 'MANUAL',
  };
}

function calculationView(result) {
  return {
    blocked: result.blocked,
    validation: result.validation,
    perDaySalary: result.perDaySalary,
    netSalary: result.netSalary,
    totalDeductions: result.totalDeductions,
    grossContract: result.grossContract,
    grossEarnings: result.grossEarnings,
    attendanceBonus: result.attendanceBonus,
    calendarDays: result.month?.calendarDays ?? null,
    attendance: result.attendance,
    lineItems: (result.lineItems || []).map((line) => ({
      code: line.code,
      name: line.name,
      kind: line.kind,
      quantity: line.quantity,
      rate: line.rate,
      amount: line.amount,
      explanation: line.explanation,
    })),
  };
}

function systemAside(attendance) {
  return {
    clUsed: attendance?.clUsed ?? '0',
    nonClUnpaidDays: attendance?.nonClUnpaidDays ?? '0',
    otherPaidLeave: attendance?.otherPaidLeave ?? '0',
    fullDayAbsences: attendance?.fullDayAbsences ?? '0',
    halfDayAbsences: attendance?.halfDayAbsences ?? '0',
    unpaidLeave: attendance?.unpaidLeave ?? '0',
    excessClDays: attendance?.excessClDays ?? '0',
    totalLates: attendance?.totalLates ?? 0,
    officialHolidays: attendance?.calendarHolidays ?? attendance?.officialHolidays ?? 0,
  };
}

function mapListRow(row) {
  return {
    id: row.id,
    staff_id: row.staff_id,
    base_salary: Number(row.base_salary || 0),
    bonus: Number(row.bonus || 0),
    salary_adjustment: Number(row.salary_adjustment || 0),
    deductions: Number(row.deductions || 0),
    net_salary: Number(row.net_salary || 0),
    status: row.status,
    payment_date: row.payment_date,
    payroll_month: row.payroll_month,
    payroll_year: row.payroll_year,
    payment_method: row.payment_method || null,
    payment_reference: row.payment_reference || null,
    remarks: row.remarks || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    calculation_engine: row.calculation_engine,
    workflow_status: row.workflow_status,
    requires_review: row.requires_review,
    review_reason: row.review_reason,
    staff: {
      staff_code: row.staff_code,
      designation: row.designation_name ? { name: row.designation_name } : undefined,
      person: {
        first_name: row.first_name,
        last_name: row.last_name,
        photo_url: row.photo_url,
        display_name: row.display_name,
      },
    },
    attendance_summary: row.summary_version == null ? null : {
      input_mode: row.input_mode,
      cl_days: row.cl_days == null ? null : String(row.cl_days),
      non_cl_days: row.non_cl_days == null ? null : String(row.non_cl_days),
      late_count: row.late_count,
      provider_name: row.provider_name,
      supporting_reference: row.supporting_reference,
      reason: row.summary_reason,
      verified: row.verified,
      version: row.summary_version,
    },
    holiday_override: row.holiday_version == null ? null : {
      holiday_count: row.holiday_count,
      source: row.holiday_source,
      provider_name: row.holiday_provider,
      supporting_reference: row.holiday_reference,
      reason: row.holiday_reason,
      version: row.holiday_version,
    },
    attendance: row.calculation_result?.attendance || null,
  };
}

async function listRows(db, schoolId, year, month) {
  return db`
    SELECT sp.id, sp.staff_id, sp.base_salary, sp.bonus, sp.salary_adjustment, sp.deductions,
           sp.net_salary, sp.status, sp.payment_date, sp.payroll_month, sp.payroll_year,
           sp.payment_method, sp.payment_reference, sp.remarks, sp.created_at, sp.updated_at, sp.calculation_engine,
           sp.workflow_status, sp.requires_review, sp.review_reason,
           st.staff_code,
           p.display_name, p.first_name, p.last_name, p.photo_url,
           sd.name AS designation_name,
           sn.result AS calculation_result,
           tas.input_mode, tas.cl_days, tas.non_cl_days, tas.late_count,
           tas.provider_name, tas.supporting_reference, tas.reason AS summary_reason,
           tas.verified, tas.version AS summary_version,
           h.holiday_count, h.source AS holiday_source, h.version AS holiday_version,
           h.provider_name AS holiday_provider, h.supporting_reference AS holiday_reference,
           h.reason AS holiday_reason
    FROM staff_payroll sp
    JOIN staff st ON st.id = sp.staff_id AND st.school_id = sp.school_id
    JOIN persons p ON p.id = st.person_id
    LEFT JOIN staff_designations sd ON sd.id = st.designation_id
    LEFT JOIN teacher_payroll_snapshots sn ON sn.staff_payroll_id = sp.id
    LEFT JOIN teacher_payroll_attendance_summaries tas ON tas.staff_payroll_id = sp.id AND tas.school_id = sp.school_id
    LEFT JOIN school_payroll_period_overrides h
      ON h.school_id = sp.school_id AND h.payroll_year = sp.payroll_year AND h.payroll_month = sp.payroll_month
    WHERE sp.school_id = ${schoolId}
      AND sp.payroll_month = ${month}
      AND sp.payroll_year = ${year}
      AND sp.run_kind = 'ORIGINAL'
    ORDER BY p.display_name NULLS LAST, st.staff_code
  `;
}

function assertPeriod(month, year) {
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) {
    throw new PayrollDataError(400, 'A payroll month from 1 to 12 and a year are required.', 'INVALID_PERIOD');
  }
}

export async function listTeacherPayrollPeriod({ schoolId, year, month, user }) {
  assertCanList(user);
  assertPeriod(month, year);
  const rows = await listRows(sql, schoolId, year, month);
  return { month, year, payrolls: rows.map(mapListRow) };
}

export async function prepareTeacherPayrollPeriod({ schoolId, year, month, actorId, user }) {
  authorizePayrollAction(user, 'prepare');
  actorOrReject(actorId);
  assertPeriod(month, year);
  const staff = await sql`
    SELECT id FROM staff
    WHERE school_id = ${schoolId} AND deleted_at IS NULL AND status_id = 1
    ORDER BY staff_code
  `;
  const results = [];
  for (const member of staff) {
    const [existing] = await sql`
      SELECT id, workflow_status, calculation_engine
      FROM staff_payroll
      WHERE school_id = ${schoolId} AND staff_id = ${member.id}
        AND payroll_month = ${month} AND payroll_year = ${year}
        AND run_kind = 'ORIGINAL' AND run_sequence = 0
    `;
    if (existing && existing.calculation_engine !== 'teacher-salary-v1') {
      results.push({ id: existing.id, action: 'skipped', reason: 'Legacy payroll row was left unchanged.' });
      continue;
    }
    if (existing && !['DRAFT', 'VALIDATED'].includes(existing.workflow_status)) {
      results.push({
        id: existing.id,
        action: 'skipped',
        reason: `Payroll is ${existing.workflow_status} and was left unchanged.`,
      });
      continue;
    }
    try {
      const payroll = await prepareTeacherPayroll({
        schoolId, staffId: member.id, year, month, actorId, user,
      });
      results.push({ id: payroll.id, action: 'recalculated', blocked: payroll.blocked });
    } catch (err) {
      results.push({
        staffId: member.id,
        action: 'blocked',
        reason: err.message,
      });
    }
  }
  const listed = await listTeacherPayrollPeriod({ schoolId, year, month, user });
  return { ...listed, results };
}

function acceptsAttendanceAdjust(payroll) {
  return payroll.calculation_engine === 'teacher-salary-v1' || payroll.calculation_engine === 'legacy';
}

async function loadMutablePayroll(db, schoolId, payrollId) {
  const [payroll] = await db`
    SELECT * FROM staff_payroll
    WHERE id = ${payrollId} AND school_id = ${schoolId}
    FOR UPDATE
  `;
  if (!payroll) throw new PayrollDataError(404, 'Payroll record was not found.', 'PAYROLL_NOT_FOUND');
  if (!acceptsAttendanceAdjust(payroll)) {
    throw new PayrollDataError(409, 'This payroll row cannot take attendance totals.', 'LEGACY_PAYROLL');
  }
  const [snapshot] = await db`
    SELECT frozen FROM teacher_payroll_snapshots WHERE staff_payroll_id = ${payrollId}
  `;
  if (snapshot?.frozen || !['DRAFT', 'VALIDATED'].includes(payroll.workflow_status)) {
    throw new PayrollDataError(
      409,
      'Approved, locked, and paid payrolls cannot be changed. Create a reversal or supplementary payroll.',
      'PAYROLL_IMMUTABLE',
    );
  }
  return payroll;
}

function summarySnapshot(row) {
  if (!row) return null;
  return {
    inputMode: row.input_mode,
    clDays: String(row.cl_days),
    nonClDays: String(row.non_cl_days),
    lateCount: row.late_count,
    providerName: row.provider_name,
    reference: row.supporting_reference,
    reason: row.reason,
    verified: row.verified,
    version: row.version,
    origin: row.origin,
  };
}

function holidaySnapshot(row) {
  if (!row) return null;
  return {
    holidayCount: row.holiday_count,
    source: row.source,
    providerName: row.provider_name,
    reference: row.supporting_reference,
    reason: row.reason,
    version: row.version,
  };
}

async function recalculateMutable(tx, {
  schoolId, year, month, actorId, onlyPayrollId, upgradePayrollId, actionFor, detailFor,
}) {
  const rows = await tx`
    SELECT sp.*, sn.frozen
    FROM staff_payroll sp
    LEFT JOIN teacher_payroll_snapshots sn ON sn.staff_payroll_id = sp.id
    WHERE sp.school_id = ${schoolId}
      AND sp.payroll_month = ${month}
      AND sp.payroll_year = ${year}
      ${onlyPayrollId ? tx`AND sp.id = ${onlyPayrollId}` : tx``}
    FOR UPDATE OF sp
  `;
  const recalculated = [];
  const blocked = [];
  const skipped = [];
  for (const row of rows) {
    const upgrading = upgradePayrollId != null && row.id === upgradePayrollId;
    if (row.calculation_engine !== 'teacher-salary-v1' && !upgrading) {
      skipped.push({ id: row.id, reason: 'Legacy payroll row was left unchanged.' });
      continue;
    }
    const decision = classifyRecalculation(row.workflow_status, row.frozen);
    if (decision.action === 'skip') {
      skipped.push({ id: row.id, workflowStatus: row.workflow_status, reason: decision.reason });
      continue;
    }
    const assembled = await assemblePayrollInput(tx, schoolId, row.staff_id, year, month, row.id);
    const saved = await saveCalculation(tx, row, assembled.input, assembled.identity, actorId);
    await writeAudit(tx, {
      schoolId,
      payrollId: row.id,
      staffId: row.staff_id,
      actorId,
      action: actionFor(row),
      detail: detailFor(row, saved),
    });
    const entry = {
      id: row.id,
      staffId: row.staff_id,
      blocked: saved.result.blocked,
      validation: saved.result.validation.filter((item) => item.severity === 'block').map((item) => item.message),
    };
    recalculated.push(entry);
    if (saved.result.blocked) blocked.push(entry);
  }
  return { recalculated, blocked, skipped };
}

function buildPreview(assembled, proposal) {
  const proposedInput = projectPayrollInput(assembled.input, proposal);
  const proposed = calculateTeacherSalary(proposedInput);
  const system = calculateTeacherSalary(systemComparisonInput(assembled.input));
  return { proposedInput, proposed, system };
}

export async function previewAttendanceSummary({ schoolId, payrollId, user, body }) {
  authorizePayrollAction(user, 'prepare');
  const [payroll] = await sql`
    SELECT * FROM staff_payroll WHERE id = ${payrollId} AND school_id = ${schoolId}
  `;
  if (!payroll) throw new PayrollDataError(404, 'Payroll record was not found.', 'PAYROLL_NOT_FOUND');
  if (!acceptsAttendanceAdjust(payroll)) {
    throw new PayrollDataError(409, 'This payroll row cannot take attendance totals.', 'LEGACY_PAYROLL');
  }
  if (!['DRAFT', 'VALIDATED'].includes(payroll.workflow_status)) {
    throw new PayrollDataError(
      409,
      'Approved, locked, and paid payrolls cannot be changed. Create a reversal or supplementary payroll.',
      'PAYROLL_IMMUTABLE',
    );
  }
  const assembled = await assemblePayrollInput(sql, schoolId, payroll.staff_id, payroll.payroll_year, payroll.payroll_month, payroll.id);
  const proposal = proposalFromBody(body);
  if (proposal.mode === 'SYSTEM_DAILY' && !(proposal.reason || '').trim()) {
    proposal.reason = 'SchoolIMS attendance';
  }
  const { proposed, system } = buildPreview(assembled, proposal);
  const [summary] = await sql`
    SELECT version FROM teacher_payroll_attendance_summaries
    WHERE school_id = ${schoolId} AND staff_payroll_id = ${payrollId}
  `;
  const [holiday] = await sql`
    SELECT version, holiday_count FROM school_payroll_period_overrides
    WHERE school_id = ${schoolId}
      AND payroll_year = ${payroll.payroll_year}
      AND payroll_month = ${payroll.payroll_month}
  `;
  return {
    replacesSystemAttendance: proposal.mode === 'MANUAL_SUMMARY',
    summaryVersion: summary?.version ?? null,
    holidayVersion: holiday?.version ?? null,
    payrollHolidayCount: proposed.attendance?.payrollHolidayCount ?? null,
    calendarHolidayCount: system.attendance?.officialHolidays ?? null,
    calculation: calculationView(proposed),
    system: systemAside(system.attendance),
  };
}

async function writeSummary(tx, { schoolId, payroll, actorId, proposal, expectedVersion }) {
  const [current] = await tx`
    SELECT * FROM teacher_payroll_attendance_summaries
    WHERE school_id = ${schoolId} AND staff_payroll_id = ${payroll.id}
    FOR UPDATE
  `;
  if (versionConflict(current?.version ?? null, expectedVersion)) {
    throw new PayrollDataError(409, 'Attendance totals were updated by someone else. Reload this payslip and try again.', 'STALE_VERSION');
  }
  const mode = proposal.mode === 'MANUAL_SUMMARY' ? 'MANUAL_SUMMARY' : 'SYSTEM_DAILY';
  const values = {
    clDays: mode === 'MANUAL_SUMMARY' ? proposal.clDays : '0',
    nonClDays: mode === 'MANUAL_SUMMARY' ? proposal.nonClDays : '0',
    lateCount: mode === 'MANUAL_SUMMARY' ? Number(proposal.lateCount) : 0,
    verified: mode === 'MANUAL_SUMMARY' ? true : false,
    reason: proposal.reason,
  };
  let saved;
  if (!current) {
    [saved] = await tx`
      INSERT INTO teacher_payroll_attendance_summaries (
        school_id, staff_payroll_id, staff_id, input_mode, origin, cl_days, non_cl_days, late_count,
        provider_name, supporting_reference, reason, verified, version, created_by, updated_by
      ) VALUES (
        ${schoolId}, ${payroll.id}, ${payroll.staff_id}, ${mode}, ${proposal.origin},
        ${values.clDays}, ${values.nonClDays}, ${values.lateCount},
        ${proposal.providerName}, ${proposal.reference}, ${values.reason}, ${values.verified},
        1, ${actorId}, ${actorId}
      )
      RETURNING *
    `;
  } else {
    [saved] = await tx`
      UPDATE teacher_payroll_attendance_summaries
      SET input_mode = ${mode},
          origin = ${proposal.origin},
          cl_days = ${values.clDays},
          non_cl_days = ${values.nonClDays},
          late_count = ${values.lateCount},
          provider_name = ${proposal.providerName},
          supporting_reference = ${proposal.reference},
          reason = ${values.reason},
          verified = ${values.verified},
          version = version + 1,
          updated_by = ${actorId},
          updated_at = now()
      WHERE id = ${current.id} AND version = ${current.version}
      RETURNING *
    `;
    if (!saved) {
      throw new PayrollDataError(409, 'Attendance totals were updated by someone else. Reload this payslip and try again.', 'STALE_VERSION');
    }
  }
  return { before: summarySnapshot(current), after: summarySnapshot(saved) };
}

async function writeHoliday(tx, { schoolId, year, month, actorId, proposal, expectedVersion, currentHolidayCount }) {
  const [current] = await tx`
    SELECT * FROM school_payroll_period_overrides
    WHERE school_id = ${schoolId} AND payroll_year = ${year} AND payroll_month = ${month}
    FOR UPDATE
  `;
  const nextCount = proposal.holidayCount == null || proposal.holidayCount === ''
    ? (current ? Number(current.holiday_count) : currentHolidayCount)
    : Number(proposal.holidayCount);
  const decision = holidaySaveDecision({
    currentCount: current ? Number(current.holiday_count) : currentHolidayCount,
    nextCount,
    confirmed: proposal.confirmed,
  });
  if (decision.error) {
    throw new PayrollDataError(409, decision.error.message, decision.error.code);
  }
  if (versionConflict(current?.version ?? null, expectedVersion)) {
    throw new PayrollDataError(409, 'The shared holiday count was updated by someone else. Reload this payroll month and try again.', 'STALE_VERSION');
  }
  if (!decision.changed && !current) {
    return { before: null, after: null, changed: false };
  }
  if (!decision.changed && current) {
    return { before: holidaySnapshot(current), after: holidaySnapshot(current), changed: false };
  }
  let saved;
  if (!current) {
    [saved] = await tx`
      INSERT INTO school_payroll_period_overrides (
        school_id, payroll_year, payroll_month, holiday_count, source, provider_name,
        supporting_reference, reason, version, created_by, updated_by
      ) VALUES (
        ${schoolId}, ${year}, ${month}, ${nextCount}, ${proposal.holidaySource},
        ${proposal.providerName}, ${proposal.reference}, ${proposal.reason},
        1, ${actorId}, ${actorId}
      )
      RETURNING *
    `;
  } else {
    [saved] = await tx`
      UPDATE school_payroll_period_overrides
      SET holiday_count = ${nextCount},
          source = ${proposal.holidaySource},
          provider_name = ${proposal.providerName},
          supporting_reference = ${proposal.reference},
          reason = ${proposal.reason},
          version = version + 1,
          updated_by = ${actorId},
          updated_at = now()
      WHERE id = ${current.id} AND version = ${current.version}
      RETURNING *
    `;
    if (!saved) {
      throw new PayrollDataError(409, 'The shared holiday count was updated by someone else. Reload this payroll month and try again.', 'STALE_VERSION');
    }
  }
  return { before: holidaySnapshot(current), after: holidaySnapshot(saved), changed: true };
}

export async function saveAttendanceSummary({ schoolId, payrollId, actorId, user, body }) {
  authorizePayrollAction(user, 'prepare');
  actorOrReject(actorId);
  const proposal = proposalFromBody(body);
  proposal.confirmed = body.confirm_holiday_override === true || body.confirmHolidayOverride === true;
  if (!(proposal.reason || '').trim()) {
    throw new PayrollDataError(422, 'A reason is required.', 'MANUAL_SUMMARY_REASON');
  }
  return sql.begin(async (tx) => {
    const payroll = await loadMutablePayroll(tx, schoolId, payrollId);
    const assembled = await assemblePayrollInput(
      tx, schoolId, payroll.staff_id, payroll.payroll_year, payroll.payroll_month, payroll.id,
    );
    const preview = buildPreview(assembled, proposal);
    const rejected = payloadRejection(preview.proposed.validation);
    if (rejected.length) {
      throw new PayrollDataError(422, rejected[0].message, rejected[0].code, rejected);
    }
    const summaryChange = await writeSummary(tx, {
      schoolId,
      payroll,
      actorId,
      proposal,
      expectedVersion: body.expected_version ?? body.expectedVersion ?? null,
    });
    const holidayChange = await writeHoliday(tx, {
      schoolId,
      year: payroll.payroll_year,
      month: payroll.payroll_month,
      actorId,
      proposal,
      expectedVersion: body.expected_holiday_version ?? body.expectedHolidayVersion ?? null,
      currentHolidayCount: preview.system.attendance.officialHolidays,
    });
    const outcome = await recalculateMutable(tx, {
      schoolId,
      year: payroll.payroll_year,
      month: payroll.payroll_month,
      actorId,
      onlyPayrollId: null,
      upgradePayrollId: payroll.id,
      actionFor: (row) => (row.id === payroll.id ? 'ATTENDANCE_SUMMARY_SAVED' : 'ATTENDANCE_PERIOD_RECALCULATED'),
      detailFor: () => ({
        before: { summary: summaryChange.before, holiday: holidayChange.before },
        after: { summary: summaryChange.after, holiday: holidayChange.after },
      }),
    });
    const [savedPayroll] = await tx`SELECT * FROM staff_payroll WHERE id = ${payroll.id}`;
    const [snapshot] = await tx`SELECT * FROM teacher_payroll_snapshots WHERE staff_payroll_id = ${payroll.id}`;
    return {
      payroll: presentPayroll(savedPayroll, snapshot),
      ...outcome,
      summaryVersion: summaryChange.after?.version ?? null,
      holidayVersion: holidayChange.after?.version ?? holidayChange.before?.version ?? null,
    };
  });
}

export async function revertAttendanceSummary({ schoolId, payrollId, actorId, user, body }) {
  authorizePayrollAction(user, 'prepare');
  actorOrReject(actorId);
  const reason = String(body.reason || '').trim();
  if (!reason) throw new PayrollDataError(422, 'A reason is required to return to SchoolIMS attendance.', 'MANUAL_SUMMARY_REASON');
  return sql.begin(async (tx) => {
    const payroll = await loadMutablePayroll(tx, schoolId, payrollId);
    const [current] = await tx`
      SELECT * FROM teacher_payroll_attendance_summaries
      WHERE school_id = ${schoolId} AND staff_payroll_id = ${payroll.id}
      FOR UPDATE
    `;
    if (versionConflict(current?.version ?? null, body.expected_version ?? body.expectedVersion ?? null)) {
      throw new PayrollDataError(409, 'Attendance totals were updated by someone else. Reload this payslip and try again.', 'STALE_VERSION');
    }
    let saved = current;
    if (!current) {
      [saved] = await tx`
        INSERT INTO teacher_payroll_attendance_summaries (
          school_id, staff_payroll_id, staff_id, input_mode, cl_days, non_cl_days, late_count,
          reason, verified, version, created_by, updated_by
        ) VALUES (
          ${schoolId}, ${payroll.id}, ${payroll.staff_id}, 'SYSTEM_DAILY', 0, 0, 0,
          ${reason}, false, 1, ${actorId}, ${actorId}
        )
        RETURNING *
      `;
    } else {
      [saved] = await tx`
        UPDATE teacher_payroll_attendance_summaries
        SET input_mode = 'SYSTEM_DAILY',
            verified = false,
            reason = ${reason},
            version = version + 1,
            updated_by = ${actorId},
            updated_at = now()
        WHERE id = ${current.id} AND version = ${current.version}
        RETURNING *
      `;
      if (!saved) {
        throw new PayrollDataError(409, 'Attendance totals were updated by someone else. Reload this payslip and try again.', 'STALE_VERSION');
      }
    }
    const before = summarySnapshot(current);
    const after = summarySnapshot(saved);
    const outcome = await recalculateMutable(tx, {
      schoolId,
      year: payroll.payroll_year,
      month: payroll.payroll_month,
      actorId,
      onlyPayrollId: payroll.id,
      upgradePayrollId: payroll.id,
      actionFor: () => 'ATTENDANCE_SUMMARY_REVERTED',
      detailFor: () => ({ before: { summary: before }, after: { summary: after } }),
    });
    const [savedPayroll] = await tx`SELECT * FROM staff_payroll WHERE id = ${payroll.id}`;
    const [snapshot] = await tx`SELECT * FROM teacher_payroll_snapshots WHERE staff_payroll_id = ${payroll.id}`;
    return {
      payroll: presentPayroll(savedPayroll, snapshot),
      ...outcome,
      summaryVersion: after?.version ?? null,
    };
  });
}

export { PayrollWorkflowError };
