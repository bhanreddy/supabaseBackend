import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import {
  createIntervention,
  recordInterventionOutcome,
  getInterventions,
  updateInterventionStatus,
} from '../services/intelligence/interventionService.js';
import {
  AnecdoteAccessError,
  assertStudentAccessible,
  isStaffRecorderRole,
} from '../services/anecdote/anecdoteAccessService.js';

const router = express.Router();

/**
 * GET /api/v1/interventions
 * List student interventions
 */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { student_id, class_section_id, status, page = 1, limit = 20 } = req.query;
  const result = await getInterventions({
    schoolId: req.schoolId,
    studentId: student_id,
    classSectionId: class_section_id,
    status,
    page,
    limit,
  });

  return sendSuccess(res, req.schoolId, result);
}));

/**
 * POST /api/v1/interventions
 * Create an intervention
 */
router.post('/', requireAuth, asyncHandler(async (req, res) => {
  if (!isStaffRecorderRole(req.user?.roles || [])) {
    return res.status(403).json({ error: 'Only authorized staff can create interventions' });
  }
  try {
    await assertStudentAccessible({
      schoolId: req.schoolId,
      studentId: req.body?.student_id,
      user: req.user,
    });
  } catch (err) {
    if (err instanceof AnecdoteAccessError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }

  const intervention = await createIntervention({
    schoolId: req.schoolId,
    userId: req.user.internal_id,
    payload: req.body,
  });

  return sendSuccess(res, req.schoolId, intervention, 201);
}));

/**
 * PATCH /api/v1/interventions/:id
 */
router.patch('/:id', requireAuth, asyncHandler(async (req, res) => {
  if (!isStaffRecorderRole(req.user?.roles || [])) {
    return res.status(403).json({ error: 'Only authorized staff can update interventions' });
  }
  const updated = await updateInterventionStatus({
    schoolId: req.schoolId,
    interventionId: req.params.id,
    userId: req.user.internal_id,
    status: req.body?.status,
  });
  return sendSuccess(res, req.schoolId, updated);
}));

/**
 * POST /api/v1/interventions/:id/outcome
 * Record before vs after outcome
 */
router.post('/:id/outcome', requireAuth, asyncHandler(async (req, res) => {
  const { outcome_status, outcome_notes, after_metric } = req.body || {};
  if (!outcome_status) {
    return res.status(400).json({ error: 'outcome_status is required' });
  }

  const result = await recordInterventionOutcome({
    schoolId: req.schoolId,
    interventionId: req.params.id,
    userId: req.user.internal_id,
    outcomeStatus: outcome_status,
    outcomeNotes: outcome_notes || '',
    afterMetric: after_metric || {},
  });

  return sendSuccess(res, req.schoolId, result);
}));

export default router;
