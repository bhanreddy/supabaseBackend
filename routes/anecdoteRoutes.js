import express from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import {
  createAnecdote,
  getAnecdotes,
  getAnecdoteById,
  updateAnecdote,
  archiveAnecdote,
  addEvidence,
  createFollowUp,
  completeFollowUp,
} from '../services/anecdote/anecdoteService.js';
import { getTaxonomy, inferAnecdoteTaxonomy } from '../services/anecdote/anecdoteTaxonomyService.js';
import { getAnecdoteAuditHistory } from '../services/anecdote/anecdoteAuditService.js';
import { uploadAnecdoteEvidence } from '../services/anecdote/anecdoteEvidenceStorage.js';
import {
  AnecdoteAccessError,
  assertStudentAccessible,
  isStaffRecorderRole,
} from '../services/anecdote/anecdoteAccessService.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

/**
 * GET /api/v1/anecdotes/taxonomy
 * Retrieve observation categories and subcategories
 */
router.get('/taxonomy', requireAuth, asyncHandler(async (req, res) => {
  const categories = await getTaxonomy({ schoolId: req.schoolId });
  return sendSuccess(res, req.schoolId, { categories });
}));

/**
 * POST /api/v1/anecdotes/infer
 * Pre-inference helper for teacher quick capture UI
 */
router.post('/infer', requireAuth, asyncHandler(async (req, res) => {
  const { text } = req.body || {};
  const inference = inferAnecdoteTaxonomy(text);
  return sendSuccess(res, req.schoolId, inference);
}));

/**
 * GET /api/v1/anecdotes
 * List anecdotes with filters and RBAC visibility enforcement
 */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const {
    student_id,
    class_section_id,
    category_id,
    observation_type,
    sentiment,
    severity,
    status,
    visibility,
    search,
    page = 1,
    limit = 20,
  } = req.query;

  const result = await getAnecdotes({
    schoolId: req.schoolId,
    studentId: student_id,
    classSectionId: class_section_id,
    categoryId: category_id,
    observationType: observation_type,
    sentiment,
    severity,
    status,
    visibility,
    search,
    page,
    limit,
    userRoles: req.user?.roles || [],
    userId: req.user?.internal_id,
  });

  return sendSuccess(res, req.schoolId, result);
}));

/**
 * POST /api/v1/anecdotes
 * Create a new observation
 */
router.post('/', requireAuth, asyncHandler(async (req, res) => {
  if (!isStaffRecorderRole(req.user?.roles || [])) {
    return res.status(403).json({ error: 'Only authorized staff can create observations' });
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

  const anecdote = await createAnecdote({
    schoolId: req.schoolId,
    userId: req.user.internal_id,
    payload: req.body,
    ipAddress: req.ip,
  });

  return sendSuccess(res, req.schoolId, anecdote, 201);
}));

/**
 * GET /api/v1/anecdotes/:id
 * Retrieve details of a specific observation
 */
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const anecdote = await getAnecdoteById({
    schoolId: req.schoolId,
    id: req.params.id,
    userRoles: req.user?.roles || [],
  });

  if (!anecdote) {
    return res.status(404).json({ error: 'Observation not found or not visible' });
  }

  try {
    await assertStudentAccessible({
      schoolId: req.schoolId,
      studentId: anecdote.student_id,
      user: req.user,
    });
  } catch (err) {
    if (err instanceof AnecdoteAccessError) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }

  return sendSuccess(res, req.schoolId, anecdote);
}));

/**
 * PATCH /api/v1/anecdotes/:id
 * Update an observation
 */
router.patch('/:id', requireAuth, asyncHandler(async (req, res) => {
  const updated = await updateAnecdote({
    schoolId: req.schoolId,
    id: req.params.id,
    userId: req.user.internal_id,
    updates: req.body,
    ipAddress: req.ip,
  });

  return sendSuccess(res, req.schoolId, updated);
}));

/**
 * DELETE /api/v1/anecdotes/:id
 * Archive an observation
 */
router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const result = await archiveAnecdote({
    schoolId: req.schoolId,
    id: req.params.id,
    userId: req.user.internal_id,
    ipAddress: req.ip,
  });

  return sendSuccess(res, req.schoolId, result);
}));

/**
 * POST /api/v1/anecdotes/:id/evidence
 * Upload and attach evidence
 */
router.post('/:id/evidence', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
  const anecdoteId = req.params.id;
  const { evidence_type = 'photo' } = req.body || {};

  let fileUrl = req.body.file_url;
  let storagePath = null;
  let fileName = req.body.file_name || null;
  let fileSize = null;
  let mimeType = req.body.mime_type || null;

  if (req.file) {
    const uploaded = await uploadAnecdoteEvidence({
      schoolId: req.schoolId,
      anecdoteId,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      originalFileName: req.file.originalname,
    });
    fileUrl = uploaded.url;
    storagePath = uploaded.storagePath;
    fileName = uploaded.fileName;
    fileSize = uploaded.fileSize;
    mimeType = uploaded.mimeType;
  }

  if (!fileUrl && evidence_type !== 'note' && evidence_type !== 'record_reference') {
    return res.status(400).json({ error: 'File upload or file_url is required' });
  }

  const evidence = await addEvidence({
    schoolId: req.schoolId,
    anecdoteId,
    userId: req.user.internal_id,
    evidenceData: {
      evidence_type,
      file_url: fileUrl,
      storage_path: storagePath,
      file_name: fileName,
      file_size: fileSize,
      mime_type: mimeType,
      metadata: req.body.metadata ? JSON.parse(req.body.metadata) : {},
    },
  });

  return sendSuccess(res, req.schoolId, evidence, 201);
}));

/**
 * POST /api/v1/anecdotes/:id/followups
 * Schedule a follow-up action
 */
router.post('/:id/followups', requireAuth, asyncHandler(async (req, res) => {
  const followup = await createFollowUp({
    schoolId: req.schoolId,
    anecdoteId: req.params.id,
    userId: req.user.internal_id,
    followUpData: req.body,
  });

  return sendSuccess(res, req.schoolId, followup, 201);
}));

/**
 * PATCH /api/v1/anecdotes/:id/followups/:followupId
 */
router.patch('/:id/followups/:followupId', requireAuth, asyncHandler(async (req, res) => {
  const followup = await completeFollowUp({
    schoolId: req.schoolId,
    anecdoteId: req.params.id,
    followUpId: req.params.followupId,
    userId: req.user.internal_id,
    notes: req.body?.notes || null,
  });

  return sendSuccess(res, req.schoolId, followup);
}));

/**
 * GET /api/v1/anecdotes/:id/audit
 * Fetch audit history
 */
router.get('/:id/audit', requireAuth, asyncHandler(async (req, res) => {
  const history = await getAnecdoteAuditHistory({
    schoolId: req.schoolId,
    anecdoteId: req.params.id,
  });

  return sendSuccess(res, req.schoolId, { audit_logs: history });
}));

export default router;
