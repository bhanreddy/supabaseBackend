import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { PayrollWorkflowError } from '../services/teacherPayrollWorkflow.js';
import {
  PayrollError,
  addPayrollAdjustment,
  approvePayrollAdjustment,
  approveTeacherPayroll,
  createReversalPayroll,
  createSupplementaryPayroll,
  getTeacherPayroll,
  getTeacherPayrollEvidence,
  listPayrollPolicies,
  lockTeacherPayroll,
  payTeacherPayroll,
  prepareTeacherPayroll,
  saveClassification,
  saveClOverride,
  savePayrollPolicy,
  saveSalaryRevision,
  validateTeacherPayroll,
} from '../services/teacherPayrollService.js';

const router = express.Router();

function actorId(req) {
  return req.user?.internal_id || req.user?.id || null;
}

function fail(res, err) {
  if (err instanceof PayrollWorkflowError) {
    return res.status(403).json({ error: err.message, code: err.code });
  }
  if (err instanceof PayrollError) {
    const body = { error: err.message, code: err.code };
    if (err.details) body.details = err.details;
    return res.status(err.status).json(body);
  }
  throw err;
}

router.get('/policies', asyncHandler(async (req, res) => {
  try {
    const policies = await listPayrollPolicies(req.schoolId, req.user);
    return sendSuccess(res, req.schoolId, policies);
  } catch (err) {
    return fail(res, err);
  }
}));

router.post('/policies', asyncHandler(async (req, res) => {
  try {
    const policy = await savePayrollPolicy({
      schoolId: req.schoolId,
      actorId: actorId(req),
      user: req.user,
      effectiveFrom: req.body.effective_from,
      effectiveTo: req.body.effective_to,
      config: req.body.config,
    });
    return sendSuccess(res, req.schoolId, policy, 201);
  } catch (err) {
    return fail(res, err);
  }
}));

router.post('/classifications', asyncHandler(async (req, res) => {
  try {
    const row = await saveClassification({
      schoolId: req.schoolId,
      staffId: req.body.staff_id,
      actorId: actorId(req),
      user: req.user,
      classification: req.body.classification,
      effectiveFrom: req.body.effective_from,
      effectiveTo: req.body.effective_to,
    });
    return sendSuccess(res, req.schoolId, row, 201);
  } catch (err) {
    return fail(res, err);
  }
}));

router.post('/salary-revisions', asyncHandler(async (req, res) => {
  try {
    const row = await saveSalaryRevision({
      schoolId: req.schoolId,
      staffId: req.body.staff_id,
      actorId: actorId(req),
      user: req.user,
      monthlySalary: req.body.monthly_salary,
      effectiveFrom: req.body.effective_from,
      effectiveTo: req.body.effective_to,
      reason: req.body.reason,
    });
    return sendSuccess(res, req.schoolId, row, 201);
  } catch (err) {
    return fail(res, err);
  }
}));

router.post('/cl-overrides', asyncHandler(async (req, res) => {
  try {
    const row = await saveClOverride({
      schoolId: req.schoolId,
      staffId: req.body.staff_id,
      actorId: actorId(req),
      user: req.user,
      year: Number(req.body.year),
      month: Number(req.body.month),
      eligible: req.body.eligible,
      reason: req.body.reason,
    });
    return sendSuccess(res, req.schoolId, row, 201);
  } catch (err) {
    return fail(res, err);
  }
}));

router.post('/prepare', asyncHandler(async (req, res) => {
  try {
    const payroll = await prepareTeacherPayroll({
      schoolId: req.schoolId,
      staffId: req.body.staff_id,
      year: Number(req.body.year),
      month: Number(req.body.month),
      actorId: actorId(req),
      user: req.user,
    });
    return sendSuccess(res, req.schoolId, payroll);
  } catch (err) {
    return fail(res, err);
  }
}));

router.post('/:payrollId/validate', asyncHandler(async (req, res) => {
  try {
    const payroll = await validateTeacherPayroll({
      schoolId: req.schoolId, payrollId: req.params.payrollId, actorId: actorId(req), user: req.user,
    });
    return sendSuccess(res, req.schoolId, payroll);
  } catch (err) {
    return fail(res, err);
  }
}));

router.post('/:payrollId/approve', asyncHandler(async (req, res) => {
  try {
    const payroll = await approveTeacherPayroll({
      schoolId: req.schoolId, payrollId: req.params.payrollId, actorId: actorId(req), user: req.user,
    });
    return sendSuccess(res, req.schoolId, payroll);
  } catch (err) {
    return fail(res, err);
  }
}));

router.post('/:payrollId/lock', asyncHandler(async (req, res) => {
  try {
    const payroll = await lockTeacherPayroll({
      schoolId: req.schoolId, payrollId: req.params.payrollId, actorId: actorId(req), user: req.user,
    });
    return sendSuccess(res, req.schoolId, payroll);
  } catch (err) {
    return fail(res, err);
  }
}));

router.post('/:payrollId/pay', asyncHandler(async (req, res) => {
  try {
    const payroll = await payTeacherPayroll({
      schoolId: req.schoolId,
      payrollId: req.params.payrollId,
      actorId: actorId(req),
      user: req.user,
      paymentDate: req.body.payment_date,
      paymentReference: req.body.payment_reference,
      paymentMethod: req.body.payment_method,
    });
    return sendSuccess(res, req.schoolId, payroll);
  } catch (err) {
    return fail(res, err);
  }
}));

router.post('/:payrollId/adjustments', asyncHandler(async (req, res) => {
  try {
    const result = await addPayrollAdjustment({
      schoolId: req.schoolId,
      payrollId: req.params.payrollId,
      actorId: actorId(req),
      user: req.user,
      kind: req.body.kind,
      name: req.body.name,
      amount: req.body.amount,
      reason: req.body.reason,
      reference: req.body.reference,
    });
    return sendSuccess(res, req.schoolId, result, 201);
  } catch (err) {
    return fail(res, err);
  }
}));

router.post('/:payrollId/adjustments/:adjustmentId/approve', asyncHandler(async (req, res) => {
  try {
    const payroll = await approvePayrollAdjustment({
      schoolId: req.schoolId,
      payrollId: req.params.payrollId,
      adjustmentId: req.params.adjustmentId,
      actorId: actorId(req),
      user: req.user,
    });
    return sendSuccess(res, req.schoolId, payroll);
  } catch (err) {
    return fail(res, err);
  }
}));

router.post('/:payrollId/supplementary', asyncHandler(async (req, res) => {
  try {
    const payroll = await createSupplementaryPayroll({
      schoolId: req.schoolId, payrollId: req.params.payrollId, actorId: actorId(req), user: req.user,
    });
    return sendSuccess(res, req.schoolId, payroll, 201);
  } catch (err) {
    return fail(res, err);
  }
}));

router.post('/:payrollId/reversal', asyncHandler(async (req, res) => {
  try {
    const payroll = await createReversalPayroll({
      schoolId: req.schoolId,
      payrollId: req.params.payrollId,
      actorId: actorId(req),
      user: req.user,
      reason: req.body.reason,
    });
    return sendSuccess(res, req.schoolId, payroll, 201);
  } catch (err) {
    return fail(res, err);
  }
}));

router.get('/:payrollId/evidence', asyncHandler(async (req, res) => {
  try {
    const evidence = await getTeacherPayrollEvidence({
      schoolId: req.schoolId, payrollId: req.params.payrollId, user: req.user,
    });
    return sendSuccess(res, req.schoolId, evidence);
  } catch (err) {
    return fail(res, err);
  }
}));

router.get('/:payrollId', asyncHandler(async (req, res) => {
  try {
    const payroll = await getTeacherPayroll({
      schoolId: req.schoolId,
      payrollId: req.params.payrollId,
      user: req.user,
      personId: req.user?.person_id,
    });
    return sendSuccess(res, req.schoolId, payroll);
  } catch (err) {
    return fail(res, err);
  }
}));

export default router;
