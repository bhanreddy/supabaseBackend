import express from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getSyllabusStructure,
  upsertChapter,
  createTopic,
  getAcademicCoordinatorOverview,
  getTeacherSyllabusSummary,
  getSubjectProgress,
  canAccessTeacherSyllabus,
} from '../services/syllabusService.js';

const router = express.Router();

// Sanitise any client tenant input
router.use((req, _res, next) => {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    delete req.body.school_id;
    delete req.body.schoolId;
  }
  if (req.query && typeof req.query === 'object') {
    delete req.query.school_id;
    delete req.query.schoolId;
  }
  next();
});

/**
 * GET /syllabus/structure
 * Retrieve curriculum hierarchy (chapters & topics) for a class and subject.
 */
router.get('/structure', requireAuth, requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const { class_id, subject_id, academic_year_id } = req.query;
  if (!class_id || !subject_id) {
    return res.status(400).json({ error: 'class_id and subject_id are required' });
  }

  const structure = await getSyllabusStructure(req.schoolId, {
    classId: class_id,
    subjectId: subject_id,
    academicYearId: academic_year_id || null,
  });
  return sendSuccess(res, req.schoolId, structure);
}));

/**
 * POST /syllabus/chapters
 * Create or update a syllabus chapter.
 */
router.post('/chapters', requireAuth, requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const {
    class_id,
    subject_id,
    academic_year_id,
    term,
    chapter_number,
    title,
    estimated_periods,
    target_completion_date,
    status,
  } = req.body || {};

  const chapter = await upsertChapter({
    schoolId: req.schoolId,
    classId: class_id,
    subjectId: subject_id,
    academicYearId: academic_year_id || null,
    term,
    chapterNumber: chapter_number,
    title,
    estimatedPeriods: estimated_periods,
    targetCompletionDate: target_completion_date,
    status,
  });

  return sendSuccess(res, req.schoolId, chapter, 201);
}));

/**
 * POST /syllabus/topics
 * Add a topic to a chapter.
 */
router.post('/topics', requireAuth, requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { chapter_id, topic_number, title, target_date, status } = req.body || {};

  const topic = await createTopic({
    chapterId: chapter_id,
    schoolId: req.schoolId,
    topicNumber: topic_number,
    title,
    targetDate: target_date,
    status,
  });

  return sendSuccess(res, req.schoolId, topic, 201);
}));

/**
 * GET /syllabus/overview
 * Academic coordinator comparative progress overview across classes and subjects.
 */
router.get('/overview', requireAuth, requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const overview = await getAcademicCoordinatorOverview(req.schoolId, {
    academicYearId: req.query.academic_year_id || null,
  });
  return sendSuccess(res, req.schoolId, overview);
}));

/**
 * GET /syllabus/teacher-summary
 * Compact summary for teacher diary view (current chapter, progress %, next topic).
 */
router.get('/teacher-summary', requireAuth, asyncHandler(async (req, res) => {
  const { class_id, subject_id, academic_year_id } = req.query;
  if (!class_id || !subject_id) {
    return res.status(400).json({ error: 'class_id and subject_id are required' });
  }

  const hasBroadAccess = req.user?.permissions?.includes('academics.view') ||
    req.user?.roles?.some((role) => ['admin', 'principal', 'management', 'superadmin'].includes(String(role).toLowerCase()));
  if (!hasBroadAccess && !await canAccessTeacherSyllabus(req.schoolId, req.user.internal_id, class_id, subject_id)) {
    return res.status(403).json({ error: 'You are not assigned to this class and subject' });
  }
  const summary = await getTeacherSyllabusSummary(req.schoolId, {
    classId: class_id,
    subjectId: subject_id,
    academicYearId: academic_year_id || null,
  });
  return sendSuccess(res, req.schoolId, summary);
}));

/**
 * GET /syllabus/progress
 * Progress calculation and delay forecast for a single subject.
 */
router.get('/progress', requireAuth, requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const { class_id, subject_id, academic_year_id } = req.query;
  if (!class_id || !subject_id) {
    return res.status(400).json({ error: 'class_id and subject_id are required' });
  }

  const progress = await getSubjectProgress(req.schoolId, {
    classId: class_id,
    subjectId: subject_id,
    academicYearId: academic_year_id || null,
  });
  return sendSuccess(res, req.schoolId, progress);
}));

export default router;
