import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { getStudentTimeline } from '../services/anecdote/anecdoteService.js';
import {
  evaluateStudentIntelligence,
  getStudentInsights,
  getStudentSignals,
  reviewInsight,
  attachSupportingSignals,
} from '../services/intelligence/insightEngine.js';
import { getStudentBaseline } from '../services/intelligence/studentBaselineService.js';
import {
  getSchoolIntelligenceOverview,
  getClassIntelligence,
  getTeacherStudentsIntelligence,
} from '../services/intelligence/schoolIntelligenceService.js';
import { getActiveRules } from '../services/intelligence/ruleEngine.js';
import {
  AnecdoteAccessError,
  assertStudentAccessible,
  isFamilyRole,
  isPrivilegedStaff,
  isStaffRecorderRole,
  resolveLinkedStudentId,
} from '../services/anecdote/anecdoteAccessService.js';

const router = express.Router();

async function requireStudentAccess(req, res, studentId) {
  try {
    await assertStudentAccessible({
      schoolId: req.schoolId,
      studentId,
      user: req.user,
    });
    return true;
  } catch (err) {
    if (err instanceof AnecdoteAccessError) {
      res.status(err.status).json({ error: err.message });
      return false;
    }
    throw err;
  }
}

/**
 * GET /api/v1/intelligence/students/:id/timeline
 * Chronological student intelligence timeline
 */
router.get('/students/:id/timeline', requireAuth, asyncHandler(async (req, res) => {
  if (!(await requireStudentAccess(req, res, req.params.id))) return;
  const { page = 1, limit = 20, filter } = req.query;
  const result = await getStudentTimeline({
    schoolId: req.schoolId,
    studentId: req.params.id,
    page,
    limit,
    filterCategory: filter || 'ALL',
    userRoles: req.user?.roles || [],
  });

  return sendSuccess(res, req.schoolId, result);
}));

/**
 * GET /api/v1/intelligence/students/:id/insights
 * Active insights with transparent "Why?" explanations and recommendations
 */
router.get('/students/:id/insights', requireAuth, asyncHandler(async (req, res) => {
  if (!(await requireStudentAccess(req, res, req.params.id))) return;
  const insights = await getStudentInsights({
    schoolId: req.schoolId,
    studentId: req.params.id,
    userRoles: req.user?.roles || [],
  });
  const withSignals = await attachSupportingSignals(insights);

  return sendSuccess(res, req.schoolId, { insights: withSignals });
}));

/**
 * GET /api/v1/intelligence/students/:id/signals
 */
router.get('/students/:id/signals', requireAuth, asyncHandler(async (req, res) => {
  if (!(await requireStudentAccess(req, res, req.params.id))) return;
  if (isFamilyRole(req.user?.roles || [])) {
    return res.status(403).json({ error: 'Internal signals are not visible on the family portal' });
  }
  const signals = await getStudentSignals({
    schoolId: req.schoolId,
    studentId: req.params.id,
    limit: req.query.limit,
  });
  return sendSuccess(res, req.schoolId, { signals });
}));

/**
 * GET /api/v1/intelligence/students/:id/baseline
 * Student personal baseline data
 */
router.get('/students/:id/baseline', requireAuth, asyncHandler(async (req, res) => {
  if (!(await requireStudentAccess(req, res, req.params.id))) return;
  const baseline = await getStudentBaseline({
    schoolId: req.schoolId,
    studentId: req.params.id,
    windowDays: parseInt(req.query.window_days, 10) || 60,
  });

  return sendSuccess(res, req.schoolId, baseline);
}));

/**
 * POST /api/v1/intelligence/evaluate/:studentId
 * Trigger recalculation of signals, patterns, and insights for a student
 */
router.post('/evaluate/:studentId', requireAuth, asyncHandler(async (req, res) => {
  if (!isStaffRecorderRole(req.user?.roles || [])) {
    return res.status(403).json({ error: 'Only authorized staff can evaluate intelligence' });
  }
  if (!(await requireStudentAccess(req, res, req.params.studentId))) return;
  const evaluation = await evaluateStudentIntelligence({
    schoolId: req.schoolId,
    studentId: req.params.studentId,
  });

  return sendSuccess(res, req.schoolId, evaluation);
}));

/**
 * GET /api/v1/intelligence/school
 * Principal & School Admin Cockpit
 */
router.get('/school', requireAuth, asyncHandler(async (req, res) => {
  if (!isPrivilegedStaff(req.user?.roles || [])) {
    return res.status(403).json({ error: 'School intelligence is limited to school administrators' });
  }
  const data = await getSchoolIntelligenceOverview({ schoolId: req.schoolId });
  return sendSuccess(res, req.schoolId, data);
}));

/**
 * GET /api/v1/intelligence/classes/:id
 * Class Intelligence Drilldown
 */
router.get('/classes/:id', requireAuth, asyncHandler(async (req, res) => {
  if (!isStaffRecorderRole(req.user?.roles || []) && !isPrivilegedStaff(req.user?.roles || [])) {
    return res.status(403).json({ error: 'Class intelligence is limited to authorized staff' });
  }
  const data = await getClassIntelligence({
    schoolId: req.schoolId,
    classSectionId: req.params.id,
  });

  return sendSuccess(res, req.schoolId, data);
}));

/**
 * GET /api/v1/intelligence/teacher/my-students
 * Teacher Intelligence Dashboard (My Students summary)
 */
router.get('/teacher/my-students', requireAuth, asyncHandler(async (req, res) => {
  const data = await getTeacherStudentsIntelligence({
    schoolId: req.schoolId,
    staffId: req.staffPortalAccess?.target_staff_id || null,
    userId: req.user?.internal_id,
    personId: req.user?.person_id,
    classSectionId: req.query.class_section_id || null,
  });

  return sendSuccess(res, req.schoolId, data);
}));

/**
 * GET /api/v1/intelligence/me/progress
 * Family-safe progress: approved observations and parent-visible strengths only.
 */
router.get('/me/progress', requireAuth, asyncHandler(async (req, res) => {
  const studentId = await resolveLinkedStudentId({
    schoolId: req.schoolId,
    personId: req.user?.person_id,
  });
  if (!studentId) {
    return res.status(404).json({ error: 'No linked student profile was found' });
  }

  const [timeline, insights] = await Promise.all([
    getStudentTimeline({
      schoolId: req.schoolId,
      studentId,
      page: 1,
      limit: 20,
      userRoles: req.user?.roles || ['parent'],
    }),
    getStudentInsights({
      schoolId: req.schoolId,
      studentId,
      userRoles: req.user?.roles || ['parent'],
    }),
  ]);

  return sendSuccess(res, req.schoolId, {
    student_id: studentId,
    timeline,
    insights,
  });
}));

/**
 * PATCH /api/v1/intelligence/insights/:id
 */
router.patch('/insights/:id', requireAuth, asyncHandler(async (req, res) => {
  if (!isStaffRecorderRole(req.user?.roles || [])) {
    return res.status(403).json({ error: 'Only authorized staff can review insights' });
  }
  const status = req.body?.status;
  const updated = await reviewInsight({
    schoolId: req.schoolId,
    insightId: req.params.id,
    userId: req.user.internal_id,
    status,
    dismissedReason: req.body?.dismissed_reason || null,
  });
  return sendSuccess(res, req.schoolId, updated);
}));

/**
 * GET /api/v1/intelligence/rules
 * List configured intelligence rules
 */
router.get('/rules', requireAuth, asyncHandler(async (req, res) => {
  const rules = await getActiveRules({ schoolId: req.schoolId });
  return sendSuccess(res, req.schoolId, { rules });
}));

export default router;
