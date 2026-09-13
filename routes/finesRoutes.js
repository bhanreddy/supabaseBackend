import express from 'express';
import { requireAuth, requireAnyPermission } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  listFineCategories,
  createFineCategory,
  updateFineCategory,
  listFinePolicies,
  createFinePolicy,
  updateFinePolicy,
  createManualFine,
  requestFine,
  approveFineRequest,
  rejectFineRequest,
  waiveFine,
  cancelFine,
  recordFinePayment,
  submitFineDispute,
  resolveFineDispute,
  getFineDetails,
  listFines,
  getFineStats,
  getAgingReport,
  getCategorySummaryReport,
  exportFinesToXlsx,
  listFineWaivers,
  listFineDisputes,
  getStudentFinesGrouped,
  requestFineClarification,
  assertFineReadable,
  canCreatePostedFines,
  canRequestFines,
} from '../services/fineService.js';
import { scanAndApplyLateFeesForSchool } from '../services/fineLateFeeEngine.js';
import { resolveStudentParamWithAccess, isStudentPortalRequest } from '../utils/studentPortal.js';

const router = express.Router();

const FINE_VIEW_PERMS = ['fine.view', 'fees.view', 'admin.manage', 'approvals.manage', 'fine.report_view'];
const FINE_MANAGE_PERMS = ['fine.create', 'fees.manage', 'admin.manage'];
const FINE_POLICY_PERMS = ['fine.policy_manage', 'fine.create', 'fees.manage', 'admin.manage'];
const FINE_APPROVE_PERMS = ['fine.approve', 'approvals.manage', 'admin.manage'];
const FINE_WAIVE_PERMS = ['fine.waive', 'fees.manage', 'admin.manage'];
const FINE_CANCEL_PERMS = ['fine.cancel', 'fine.create', 'fees.manage', 'admin.manage'];
const FINE_COLLECT_PERMS = ['fine.collect', 'fees.collect', 'admin.manage'];
const FINE_DISPUTE_PERMS = ['fine.dispute_review', 'fees.manage', 'admin.manage'];
const FINE_EXPORT_PERMS = ['fine.export', 'fine.report_view', 'fees.view', 'admin.manage'];

function scopedListQuery(req) {
  const query = { ...req.query };
  const canViewAll = (req.user?.roles || []).some((r) => ['admin', 'principal', 'accountant', 'accounts', 'management'].includes(r))
    || (req.user?.permissions || []).some((p) => FINE_VIEW_PERMS.includes(p));
  if (!canViewAll) {
    query.requested_by = req.user.internal_id;
  }
  return query;
}

function handleServiceError(err, res) {
  if (err.status) {
    return sendError(res, err.status, err.message, err.details || null);
  }
  throw err;
}

// ============== 1. CATEGORIES ==============

router.get('/categories', requireAuth, asyncHandler(async (req, res) => {
  const activeOnly = req.query.active === 'true';
  const categories = await listFineCategories(req.schoolId, { activeOnly });
  return sendSuccess(res, req.schoolId, categories);
}));

router.post('/categories', requireAuth, requireAnyPermission(FINE_POLICY_PERMS), asyncHandler(async (req, res) => {
  const category = await createFineCategory(req.schoolId, req.body, req.user);
  return sendSuccess(res, req.schoolId, category);
}));

async function patchCategory(req, res) {
  const updated = await updateFineCategory(req.schoolId, req.params.id, req.body);
  return sendSuccess(res, req.schoolId, updated);
}
router.patch('/categories/:id', requireAuth, requireAnyPermission(FINE_POLICY_PERMS), asyncHandler(patchCategory));
router.put('/categories/:id', requireAuth, requireAnyPermission(FINE_POLICY_PERMS), asyncHandler(patchCategory));

// ============== 2. POLICIES ==============

router.get('/policies', requireAuth, asyncHandler(async (req, res) => {
  const { category_id, active_only, auto_apply, active } = req.query;
  const policies = await listFinePolicies(req.schoolId, {
    categoryId: category_id,
    activeOnly: active_only === 'true' || active === 'true',
    autoApplyOnly: auto_apply === 'true',
  });
  return sendSuccess(res, req.schoolId, policies);
}));

router.post('/policies', requireAuth, requireAnyPermission(FINE_POLICY_PERMS), asyncHandler(async (req, res) => {
  const policy = await createFinePolicy(req.schoolId, req.body, req.user);
  return sendSuccess(res, req.schoolId, policy);
}));

async function patchPolicy(req, res) {
  const updated = await updateFinePolicy(req.schoolId, req.params.id, req.body);
  return sendSuccess(res, req.schoolId, updated);
}
router.patch('/policies/:id', requireAuth, requireAnyPermission(FINE_POLICY_PERMS), asyncHandler(patchPolicy));
router.put('/policies/:id', requireAuth, requireAnyPermission(FINE_POLICY_PERMS), asyncHandler(patchPolicy));

// ============== 3. DASHBOARD STATS & REPORTS ==============

router.get('/stats', requireAuth, requireAnyPermission(FINE_VIEW_PERMS), asyncHandler(async (req, res) => {
  const stats = await getFineStats(req.schoolId, req.query.academic_year_id);
  return sendSuccess(res, req.schoolId, stats);
}));

router.get('/reports/aging', requireAuth, requireAnyPermission(FINE_VIEW_PERMS), asyncHandler(async (req, res) => {
  const aging = await getAgingReport(req.schoolId);
  return sendSuccess(res, req.schoolId, aging);
}));

router.get('/reports/categories', requireAuth, requireAnyPermission(FINE_VIEW_PERMS), asyncHandler(async (req, res) => {
  const summary = await getCategorySummaryReport(req.schoolId);
  return sendSuccess(res, req.schoolId, summary);
}));

router.get('/export', requireAuth, requireAnyPermission(FINE_EXPORT_PERMS), asyncHandler(async (req, res) => {
  const buffer = await exportFinesToXlsx(req.schoolId, scopedListQuery(req));
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="fines-and-adjustments-${stamp}.xlsx"`);
  return res.send(buffer);
}));

router.get('/waivers', requireAuth, requireAnyPermission(FINE_VIEW_PERMS), asyncHandler(async (req, res) => {
  const result = await listFineWaivers(req.schoolId, req.query);
  return sendSuccess(res, req.schoolId, result);
}));

router.get('/disputes', requireAuth, requireAnyPermission(FINE_DISPUTE_PERMS), asyncHandler(async (req, res) => {
  const result = await listFineDisputes(req.schoolId, req.query);
  return sendSuccess(res, req.schoolId, result);
}));

router.get('/student/:studentId', requireAuth, asyncHandler(async (req, res) => {
  const studentId = await resolveStudentParamWithAccess(req, res, req.params.studentId);
  if (!studentId) return;
  const grouped = await getStudentFinesGrouped(req.schoolId, studentId);
  return sendSuccess(res, req.schoolId, grouped);
}));

// ============== 4. FINE TRANSACTIONS & SEARCH ==============

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const canList = canRequestFines(req.user)
    || (req.user?.permissions || []).some((p) => FINE_VIEW_PERMS.includes(p))
    || (req.user?.roles || []).includes('admin');
  if (!canList) return sendError(res, 403, 'Forbidden');
  const result = await listFines(req.schoolId, scopedListQuery(req));
  return sendSuccess(res, req.schoolId, result);
}));

router.post('/', requireAuth, requireAnyPermission(FINE_MANAGE_PERMS), asyncHandler(async (req, res) => {
  try {
    const fine = await createManualFine(req.schoolId, req.body, req.user, req);
    return sendSuccess(res, req.schoolId, fine, 201);
  } catch (err) {
    return handleServiceError(err, res);
  }
}));

router.post('/request', requireAuth, asyncHandler(async (req, res) => {
  if (!canRequestFines(req.user)) {
    return sendError(res, 403, 'Forbidden');
  }
  if (canCreatePostedFines(req.user) === false && req.body?.post_immediately) {
    return sendError(res, 403, 'Teachers cannot post fines directly');
  }
  try {
    const fine = await requestFine(req.schoolId, req.body, req.user, req);
    return sendSuccess(res, req.schoolId, fine, 201);
  } catch (err) {
    return handleServiceError(err, res);
  }
}));

router.get('/requests', requireAuth, requireAnyPermission(FINE_APPROVE_PERMS), asyncHandler(async (req, res) => {
  const result = await listFines(req.schoolId, { ...req.query, status: 'PENDING_APPROVAL' });
  return sendSuccess(res, req.schoolId, result);
}));

router.post('/:id/approve', requireAuth, requireAnyPermission(FINE_APPROVE_PERMS), asyncHandler(async (req, res) => {
  const approved = await approveFineRequest(req.schoolId, req.params.id, req.body, req.user, req);
  return sendSuccess(res, req.schoolId, approved);
}));

router.post('/:id/reject', requireAuth, requireAnyPermission(FINE_APPROVE_PERMS), asyncHandler(async (req, res) => {
  const rejected = await rejectFineRequest(req.schoolId, req.params.id, req.body, req.user, req);
  return sendSuccess(res, req.schoolId, rejected);
}));

router.post('/:id/clarify', requireAuth, requireAnyPermission(FINE_APPROVE_PERMS), asyncHandler(async (req, res) => {
  const updated = await requestFineClarification(req.schoolId, req.params.id, req.body, req.user, req);
  return sendSuccess(res, req.schoolId, updated);
}));

router.post('/:id/waive', requireAuth, requireAnyPermission(FINE_WAIVE_PERMS), asyncHandler(async (req, res) => {
  const result = await waiveFine(req.schoolId, req.params.id, req.body, req.user, req);
  return sendSuccess(res, req.schoolId, result);
}));

router.post('/:id/cancel', requireAuth, requireAnyPermission(FINE_CANCEL_PERMS), asyncHandler(async (req, res) => {
  const cancelled = await cancelFine(req.schoolId, req.params.id, req.body, req.user, req);
  return sendSuccess(res, req.schoolId, cancelled);
}));

router.post('/:id/pay', requireAuth, requireAnyPermission(FINE_COLLECT_PERMS), asyncHandler(async (req, res) => {
  const payment = await recordFinePayment(req.schoolId, req.params.id, req.body, req.user, req);
  return sendSuccess(res, req.schoolId, payment);
}));

router.post('/:id/dispute', requireAuth, asyncHandler(async (req, res) => {
  let studentId = null;
  if (isStudentPortalRequest(req)) {
    studentId = await resolveStudentParamWithAccess(req, res, req.body.student_id || 'me');
    if (!studentId) return;
  }
  const dispute = await submitFineDispute(req.schoolId, req.params.id, studentId, req.body, req.user, req);
  return sendSuccess(res, req.schoolId, dispute);
}));

router.post('/disputes/:id/resolve', requireAuth, requireAnyPermission(FINE_DISPUTE_PERMS), asyncHandler(async (req, res) => {
  const result = await resolveFineDispute(req.schoolId, req.params.id, req.body, req.user, req);
  return sendSuccess(res, req.schoolId, result);
}));

router.post('/late-fee-scan', requireAuth, requireAnyPermission(FINE_MANAGE_PERMS), asyncHandler(async (req, res) => {
  const scanResult = await scanAndApplyLateFeesForSchool(req.schoolId, req.body);
  return sendSuccess(res, req.schoolId, scanResult);
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const fine = await getFineDetails(req.schoolId, req.params.id);
  await assertFineReadable(req, fine);
  if (isStudentPortalRequest(req)) {
    delete fine.internal_note;
  }
  return sendSuccess(res, req.schoolId, fine);
}));

export default router;
