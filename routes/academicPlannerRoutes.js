import express from 'express';
import multer from 'multer';
import { requireAuth, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import CurriculumService from '../services/curriculumService.js';
import AcademicSchedulingService from '../services/academicSchedulingService.js';
import AcademicPlanService from '../services/academicPlanService.js';
import AcademicProgressService from '../services/academicProgressService.js';
import AcademicAnalyticsService from '../services/academicAnalyticsService.js';
import AcademicRiskService from '../services/academicRiskService.js';
import AcademicRecoveryService from '../services/academicRecoveryService.js';
import AcademicImportService from '../services/academicImportService.js';
import AcademicAIService from '../services/academicAIService.js';
import sql from '../db.js';
import { isStudentPortalRequest, resolveStudentId } from '../utils/studentPortal.js';

const PLANNER_VIEW = ['academic_planner.view', 'academics.view', 'academics.manage'];
const PLANNER_CURRICULUM = ['academic_planner.curriculum', 'academics.manage', 'academics.create', 'academics.edit'];
const PLANNER_PLAN = ['academic_planner.plan', 'academics.manage', 'academics.create', 'academics.edit'];
const PLANNER_APPROVE = ['academic_planner.approve', 'academics.manage', 'academics.approve'];
const PLANNER_PROGRESS = ['academic_planner.progress', 'academics.manage'];
const PLANNER_RISK = ['academic_planner.risk', 'academics.manage'];
const PLANNER_RECOVERY = ['academic_planner.recovery', 'academics.manage'];

async function isPlannerEnabled(schoolId) {
  try {
    const [setting] = await sql`
      SELECT enabled FROM academic_planner_settings WHERE school_id = ${schoolId}
    `;
    if (setting) return setting.enabled !== false;
    const [flag] = await sql`
      SELECT value FROM school_settings
      WHERE school_id = ${schoolId} AND key = 'academic_planner_enabled'
      LIMIT 1
    `;
    if (!flag) return true;
    return !['false', '0', 'off'].includes(String(flag.value).toLowerCase());
  } catch {
    return true;
  }
}

function isAdminRole(req) {
  const roles = req.user?.roles || [];
  return roles.includes('admin') || roles.includes('principal');
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const router = express.Router();

// Sanitise client tenant input: ensure school_id always comes from req.schoolId / req.user.schoolId
router.use((req, _res, next) => {
  if (req.user?.schoolId) {
    req.schoolId = req.user.schoolId;
  }
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

router.use(asyncHandler(async (req, res, next) => {
  const enabled = await isPlannerEnabled(req.schoolId);
  if (!enabled && !String(req.path || '').startsWith('/settings')) {
    return sendError(res, 403, 'Academic Planner is not enabled for this school');
  }
  next();
}));

// ══════════════════════════════════════════════════════════════════════════════
// 1. CURRICULUM MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/academics/curricula
 * List curricula with filters
 */
router.get('/curricula', requireAuth, requireAnyPermission(PLANNER_VIEW), asyncHandler(async (req, res) => {
  const { class_id, subject_id, academic_year_id, status } = req.query;
  const list = await CurriculumService.listCurricula({
    schoolId: req.schoolId,
    classId: class_id,
    subjectId: subject_id,
    academicYearId: academic_year_id,
    status
  });
  return sendSuccess(res, req.schoolId, list);
}));

/**
 * GET /api/v1/academics/curricula/:id
 * Retrieve curriculum with full nested structure (Units -> Chapters -> Topics)
 */
router.get('/curricula/:id', requireAuth, requireAnyPermission(PLANNER_VIEW), asyncHandler(async (req, res) => {
  const curriculum = await CurriculumService.getCurriculumById({
    schoolId: req.schoolId,
    curriculumId: req.params.id
  });
  if (!curriculum) return sendError(res, 404, 'Curriculum not found');
  return sendSuccess(res, req.schoolId, curriculum);
}));

/**
 * POST /api/v1/academics/curricula
 * Create curriculum header
 */
router.post('/curricula', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  const { academic_year_id, class_id, subject_id, name, description, status } = req.body;
  if (!academic_year_id || !class_id || !subject_id || !name) {
    return sendError(res, 400, 'academic_year_id, class_id, subject_id, and name are required');
  }

  const created = await CurriculumService.createCurriculum({
    schoolId: req.schoolId,
    academicYearId: academic_year_id,
    classId: class_id,
    subjectId: subject_id,
    name,
    description,
    createdBy: req.user.internal_id || req.user.id,
    status: status || 'ACTIVE'
  });

  return sendSuccess(res, req.schoolId, created, 201);
}));

/**
 * PUT /api/v1/academics/curricula/:id
 * Update curriculum header
 */
router.put('/curricula/:id', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  const updated = await CurriculumService.updateCurriculum({
    schoolId: req.schoolId,
    curriculumId: req.params.id,
    data: req.body
  });
  return sendSuccess(res, req.schoolId, updated);
}));

/**
 * POST /api/v1/academics/curricula/:id/version
 * Create new version (v+1) non-destructively
 */
router.post('/curricula/:id/version', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  const newVersion = await CurriculumService.createNewVersion({
    schoolId: req.schoolId,
    curriculumId: req.params.id,
    createdBy: req.user.internal_id || req.user.id
  });
  return sendSuccess(res, req.schoolId, newVersion, 201);
}));

/**
 * POST /api/v1/academics/curricula/:id/copy
 * Copy curriculum to target academic year
 */
router.post('/curricula/:id/copy', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  const { target_academic_year_id } = req.body;
  if (!target_academic_year_id) {
    return sendError(res, 400, 'target_academic_year_id is required');
  }

  const copied = await CurriculumService.copyCurriculumToYear({
    schoolId: req.schoolId,
    sourceCurriculumId: req.params.id,
    targetAcademicYearId: target_academic_year_id,
    createdBy: req.user.internal_id || req.user.id
  });

  return sendSuccess(res, req.schoolId, copied, 201);
}));

// ── Units, Chapters & Topics Endpoints ────────────────────────────────────────

router.post('/curricula/:id/units', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  const { term_id, title, description, sequence, estimated_periods } = req.body;
  const unit = await CurriculumService.createUnit({
    schoolId: req.schoolId,
    curriculumId: req.params.id,
    termId: term_id,
    title,
    description,
    sequence,
    estimatedPeriods: estimated_periods
  });
  return sendSuccess(res, req.schoolId, unit, 201);
}));

router.put('/curricula/units/:unitId', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  const updated = await CurriculumService.updateUnit({
    schoolId: req.schoolId,
    unitId: req.params.unitId,
    data: req.body
  });
  return sendSuccess(res, req.schoolId, updated);
}));

router.delete('/curricula/units/:unitId', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  await CurriculumService.deleteUnit({
    schoolId: req.schoolId,
    unitId: req.params.unitId
  });
  return sendSuccess(res, req.schoolId, { success: true });
}));

router.put('/curricula/:id/units/reorder', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  const { unit_ids } = req.body;
  await CurriculumService.reorderUnits({
    schoolId: req.schoolId,
    curriculumId: req.params.id,
    unitIds: unit_ids
  });
  return sendSuccess(res, req.schoolId, { success: true });
}));

router.post('/curricula/:id/chapters', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  const { unit_id, title, description, sequence, estimated_periods, weight } = req.body;
  const chapter = await CurriculumService.createChapter({
    schoolId: req.schoolId,
    curriculumId: req.params.id,
    unitId: unit_id,
    title,
    description,
    sequence,
    estimatedPeriods: estimated_periods,
    weight
  });
  return sendSuccess(res, req.schoolId, chapter, 201);
}));

router.put('/curricula/chapters/:chapterId', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  const updated = await CurriculumService.updateChapter({
    schoolId: req.schoolId,
    chapterId: req.params.chapterId,
    data: req.body
  });
  return sendSuccess(res, req.schoolId, updated);
}));

router.delete('/curricula/chapters/:chapterId', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  await CurriculumService.deleteChapter({
    schoolId: req.schoolId,
    chapterId: req.params.chapterId
  });
  return sendSuccess(res, req.schoolId, { success: true });
}));

router.put('/curricula/:id/chapters/reorder', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  const { chapter_ids } = req.body;
  await CurriculumService.reorderChapters({
    schoolId: req.schoolId,
    curriculumId: req.params.id,
    chapterIds: chapter_ids
  });
  return sendSuccess(res, req.schoolId, { success: true });
}));

router.post('/curricula/chapters/:chapterId/topics', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  const { title, description, sequence, estimated_periods, weight, is_optional } = req.body;
  const topic = await CurriculumService.createTopic({
    schoolId: req.schoolId,
    chapterId: req.params.chapterId,
    title,
    description,
    sequence,
    estimatedPeriods: estimated_periods,
    weight,
    isOptional: is_optional
  });
  return sendSuccess(res, req.schoolId, topic, 201);
}));

router.put('/curricula/topics/:topicId', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  const updated = await CurriculumService.updateTopic({
    schoolId: req.schoolId,
    topicId: req.params.topicId,
    data: req.body
  });
  return sendSuccess(res, req.schoolId, updated);
}));

router.delete('/curricula/topics/:topicId', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  await CurriculumService.deleteTopic({
    schoolId: req.schoolId,
    topicId: req.params.topicId
  });
  return sendSuccess(res, req.schoolId, { success: true });
}));

router.put('/curricula/chapters/:chapterId/topics/reorder', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  const { topic_ids } = req.body;
  await CurriculumService.reorderTopics({
    schoolId: req.schoolId,
    chapterId: req.params.chapterId,
    topicIds: topic_ids
  });
  return sendSuccess(res, req.schoolId, { success: true });
}));

// ══════════════════════════════════════════════════════════════════════════════
// 2. EXCEL TEMPLATE & IMPORT WORKFLOW
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/academics/template
 * Download curriculum Excel template (.xlsx)
 */
router.get('/template', requireAuth, (req, res) => {
  const buffer = AcademicImportService.generateExcelTemplate();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="SchoolIMS_Curriculum_Template.xlsx"');
  return res.send(buffer);
});

/**
 * POST /api/v1/academics/import/preview
 * Upload Excel file for parsing, validation, and staging preview
 */
router.post('/import/preview', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file || !req.file.buffer) {
    return sendError(res, 400, 'No Excel file uploaded');
  }

  const { academic_year_id } = req.body;
  const result = await AcademicImportService.parseAndValidate({
    schoolId: req.schoolId,
    fileBuffer: req.file.buffer,
    academicYearId: academic_year_id
  });

  return sendSuccess(res, req.schoolId, result);
}));

/**
 * POST /api/v1/academics/import/commit
 * Commit validated rows into the database
 */
router.post('/import/commit', requireAuth, requireAnyPermission(PLANNER_CURRICULUM), asyncHandler(async (req, res) => {
  const { academic_year_id, rows } = req.body;
  if (!academic_year_id || !Array.isArray(rows) || rows.length === 0) {
    return sendError(res, 400, 'academic_year_id and rows array are required');
  }

  const result = await AcademicImportService.commitImport({
    schoolId: req.schoolId,
    academicYearId: academic_year_id,
    rows,
    createdBy: req.user.internal_id || req.user.id
  });

  return sendSuccess(res, req.schoolId, result, 201);
}));

// ══════════════════════════════════════════════════════════════════════════════
// 3. AI EXTRACTION & COPILOT
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/v1/academics/ai/extract
 * Extract curriculum structure from OCR text or syllabus document
 */
router.post('/ai/extract', requireAuth, asyncHandler(async (req, res) => {
  const { raw_text, subject_name, class_name } = req.body;
  if (!raw_text) return sendError(res, 400, 'raw_text is required');

  const result = await AcademicAIService.extractCurriculumStructure({
    rawText: raw_text,
    subjectName: subject_name,
    className: class_name
  });

  return sendSuccess(res, req.schoolId, result);
}));

/**
 * POST /api/v1/academics/ai/lesson-plan
 * Suggest lesson plan breakdown for a topic
 */
router.post('/ai/lesson-plan', requireAuth, asyncHandler(async (req, res) => {
  const { topic_title, chapter_title, class_name, subject_name, total_periods } = req.body;
  const result = await AcademicAIService.suggestLessonPlan({
    topicTitle: topic_title,
    chapterTitle: chapter_title,
    className: class_name,
    subjectName: subject_name,
    totalPeriods: total_periods || 5
  });

  return sendSuccess(res, req.schoolId, result);
}));

// ══════════════════════════════════════════════════════════════════════════════
// 4. ACADEMIC PLANS & SCHEDULING
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/academics/plans
 * List academic plans
 */
router.get('/plans', requireAuth, requireAnyPermission(PLANNER_VIEW), asyncHandler(async (req, res) => {
  const { academic_year_id, term_id, class_id, section_id, subject_id, teacher_id, status } = req.query;
  let teacherId = teacher_id;
  if (!isAdminRole(req)) {
    const [staffRow] = await sql`
      SELECT id FROM staff
      WHERE person_id = ${req.user.person_id}
        AND school_id = ${req.schoolId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    teacherId = staffRow?.id || teacher_id;
  }
  const plans = await AcademicPlanService.listPlans({
    schoolId: req.schoolId,
    academicYearId: academic_year_id,
    termId: term_id,
    classId: class_id,
    sectionId: section_id,
    subjectId: subject_id,
    teacherId,
    status
  });
  return sendSuccess(res, req.schoolId, plans);
}));

/**
 * GET /api/v1/academics/plans/:id
 * Retrieve academic plan by ID with scheduled items
 */
router.get('/plans/:id', requireAuth, requireAnyPermission(PLANNER_VIEW), asyncHandler(async (req, res) => {
  const plan = await AcademicPlanService.getPlanById({
    schoolId: req.schoolId,
    planId: req.params.id
  });
  if (!plan) return sendError(res, 404, 'Academic plan not found');
  return sendSuccess(res, req.schoolId, plan);
}));

/**
 * POST /api/v1/academics/plans
 * Create academic plan (optionally auto-generating scheduled items)
 */
router.post('/plans', requireAuth, requireAnyPermission(PLANNER_PLAN), asyncHandler(async (req, res) => {
  const {
    academic_year_id, term_id, class_id, section_id, subject_id,
    teacher_id, curriculum_id, planned_start_date, planned_end_date,
    target_completion_date, revision_days, auto_generate, status
  } = req.body;

  if (!academic_year_id || !class_id || !section_id || !subject_id || !curriculum_id) {
    return sendError(res, 400, 'academic_year_id, class_id, section_id, subject_id, and curriculum_id are required');
  }

  const created = await AcademicPlanService.createPlan({
    schoolId: req.schoolId,
    academicYearId: academic_year_id,
    termId: term_id,
    classId: class_id,
    sectionId: section_id,
    subjectId: subject_id,
    teacherId: teacher_id,
    curriculumId: curriculum_id,
    plannedStartDate: planned_start_date,
    plannedEndDate: planned_end_date,
    targetCompletionDate: target_completion_date,
    revisionDays: revision_days,
    createdBy: req.user.internal_id || req.user.id,
    status: status || 'ACTIVE',
    autoGenerate: auto_generate !== false
  });

  return sendSuccess(res, req.schoolId, created, 201);
}));

/**
 * POST /api/v1/academics/plans/:id/generate
 * Run scheduling engine to generate scheduled items
 */
router.post('/plans/:id/generate', requireAuth, requireAnyPermission(PLANNER_PLAN), asyncHandler(async (req, res) => {
  const schedule = await AcademicPlanService.generatePlanItems({
    schoolId: req.schoolId,
    planId: req.params.id
  });
  return sendSuccess(res, req.schoolId, schedule);
}));

/**
 * POST /api/v1/academics/plans/:id/submit
 * Submit plan for approval
 */
router.post('/plans/:id/submit', requireAuth, asyncHandler(async (req, res) => {
  const plan = await AcademicPlanService.submitPlanForApproval({
    schoolId: req.schoolId,
    planId: req.params.id,
    submittedBy: req.user.internal_id || req.user.id
  });
  return sendSuccess(res, req.schoolId, plan);
}));

/**
 * POST /api/v1/academics/plans/:id/approve
 * Review / Approve plan
 */
router.post('/plans/:id/approve', requireAuth, requireAnyPermission(PLANNER_APPROVE), asyncHandler(async (req, res) => {
  const { action, remarks } = req.body;
  const plan = await AcademicPlanService.reviewPlan({
    schoolId: req.schoolId,
    planId: req.params.id,
    reviewerId: req.user.internal_id || req.user.id,
    action: action || 'APPROVE',
    remarks
  });
  return sendSuccess(res, req.schoolId, plan);
}));

/**
 * POST /api/v1/academics/plans/:id/handover
 * Teacher handover / reassignment
 */
router.post('/plans/:id/handover', requireAuth, requireAnyPermission(['academics.manage', 'staff.manage']), asyncHandler(async (req, res) => {
  const { new_teacher_id, reason } = req.body;
  if (!new_teacher_id) return sendError(res, 400, 'new_teacher_id is required');

  const plan = await AcademicPlanService.transferPlanTeacher({
    schoolId: req.schoolId,
    planId: req.params.id,
    newTeacherId: new_teacher_id,
    reason,
    transferredBy: req.user.internal_id || req.user.id
  });

  return sendSuccess(res, req.schoolId, plan);
}));

/**
 * PUT /api/v1/academics/plans/items/:itemId
 * Update scheduled item details
 */
router.put('/plans/items/:itemId', requireAuth, asyncHandler(async (req, res) => {
  const updated = await AcademicPlanService.updatePlanItem({
    schoolId: req.schoolId,
    planItemId: req.params.itemId,
    data: req.body
  });
  return sendSuccess(res, req.schoolId, updated);
}));

// ══════════════════════════════════════════════════════════════════════════════
// 5. TEACHER DAILY EXECUTION ("ACADEMIC TODAY")
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/academics/today
 * Resolves teacher's current/next scheduled class, active topic, last completed topic, and lesson plan
 */
router.get('/today', requireAuth, requireAnyPermission(PLANNER_PROGRESS.concat(PLANNER_VIEW)), asyncHandler(async (req, res) => {
  let teacherId = isAdminRole(req) ? req.query.teacher_id : null;
  if (!teacherId) {
    // Resolve caller's staff ID from persons/staff table
    const [staffRow] = await sql`
      SELECT id FROM staff
      WHERE person_id = ${req.user.person_id}
        AND school_id = ${req.schoolId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    teacherId = staffRow?.id;
  }

  if (!teacherId) {
    return sendError(res, 404, 'Teacher profile not found for user');
  }

  const { date, time } = req.query;
  const execution = await AcademicProgressService.getTodayExecution({
    schoolId: req.schoolId,
    teacherId,
    date,
    time
  });

  return sendSuccess(res, req.schoolId, execution);
}));

/**
 * POST /api/v1/academics/plans/:id/progress
 * 1-Tap teacher progress update: COMPLETED, PARTIALLY_COMPLETED, CONTINUE_NEXT_PERIOD, SKIPPED
 */
router.post('/plans/:id/progress', requireAuth, requireAnyPermission(PLANNER_PROGRESS), asyncHandler(async (req, res) => {
  const {
    plan_item_id, status, completion_percentage,
    periods_consumed, notes, source, date
  } = req.body;

  if (!plan_item_id || !status) {
    return sendError(res, 400, 'plan_item_id and status are required');
  }

  let teacherId = isAdminRole(req) ? req.body.teacher_id : null;
  if (!teacherId && req.user.person_id) {
    const [staffRow] = await sql`
      SELECT id FROM staff
      WHERE person_id = ${req.user.person_id}
        AND school_id = ${req.schoolId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    teacherId = staffRow?.id || null;
  }

  const event = await AcademicProgressService.recordProgress({
    schoolId: req.schoolId,
    planId: req.params.id,
    planItemId: plan_item_id,
    teacherId,
    date,
    status,
    completionPercentage: completion_percentage,
    periodsConsumed: periods_consumed || 1.0,
    notes,
    source: source || 'ACADEMIC_APP'
  });

  return sendSuccess(res, req.schoolId, event, 201);
}));

/**
 * GET /api/v1/academics/today/diary-topic/:planItemId
 * Fetch topic details for linking to diary/homework entry
 */
router.get('/today/diary-topic/:planItemId', requireAuth, asyncHandler(async (req, res) => {
  const details = await AcademicProgressService.getDiaryTopicDetails({
    schoolId: req.schoolId,
    planItemId: req.params.planItemId
  });
  if (!details) return sendError(res, 404, 'Plan item not found');
  return sendSuccess(res, req.schoolId, details);
}));

// ══════════════════════════════════════════════════════════════════════════════
// 6. MANAGEMENT INTELLIGENCE & DRILLDOWN
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/academics/dashboard
 * Management Command Center high-level KPI cards
 */
router.get('/dashboard', requireAuth, requireAnyPermission(PLANNER_RISK.concat(['academics.manage'])), asyncHandler(async (req, res) => {
  const { academic_year_id } = req.query;
  const summary = await AcademicAnalyticsService.getCommandCenterSummary({
    schoolId: req.schoolId,
    academicYearId: academic_year_id
  });
  return sendSuccess(res, req.schoolId, summary);
}));

/**
 * GET /api/v1/academics/drilldown
 * School -> Class -> Section -> Subject -> Teacher multi-level drilldown
 */
router.get('/drilldown', requireAuth, asyncHandler(async (req, res) => {
  const { academic_year_id, class_id, section_id, subject_id } = req.query;
  const drilldown = await AcademicAnalyticsService.getDrilldown({
    schoolId: req.schoolId,
    academicYearId: academic_year_id,
    classId: class_id,
    sectionId: section_id,
    subjectId: subject_id
  });
  return sendSuccess(res, req.schoolId, drilldown);
}));

/**
 * GET /api/v1/academics/cross-section
 * Cross-section discrepancy detection
 */
router.get('/cross-section', requireAuth, asyncHandler(async (req, res) => {
  const { academic_year_id, class_id } = req.query;
  const analysis = await AcademicAnalyticsService.getCrossSectionAnalysis({
    schoolId: req.schoolId,
    academicYearId: academic_year_id,
    classId: class_id
  });
  return sendSuccess(res, req.schoolId, analysis);
}));

// ══════════════════════════════════════════════════════════════════════════════
// 7. RISK DETECTION & RECOVERY PLANNING
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/academics/risks
 * List active academic risks
 */
router.get('/risks', requireAuth, requireAnyPermission(PLANNER_RISK.concat(PLANNER_VIEW)), asyncHandler(async (req, res) => {
  const { academic_year_id, status } = req.query;
  const risks = await AcademicRiskService.listRisks({
    schoolId: req.schoolId,
    academicYearId: academic_year_id,
    status: status || 'ACTIVE'
  });
  return sendSuccess(res, req.schoolId, risks);
}));

/**
 * POST /api/v1/academics/risks/scan
 * Run risk detection scan across all active plans
 */
router.post('/risks/scan', requireAuth, requireAnyPermission(PLANNER_RECOVERY), asyncHandler(async (req, res) => {
  const { academic_year_id } = req.body;
  const detected = await AcademicRiskService.scanAndDetectRisks({
    schoolId: req.schoolId,
    academicYearId: academic_year_id
  });
  return sendSuccess(res, req.schoolId, { detected_count: detected.length, detected });
}));

/**
 * POST /api/v1/academics/risks/:id/resolve
 * Resolve or dismiss risk
 */
router.post('/risks/:id/resolve', requireAuth, requireAnyPermission(PLANNER_RECOVERY), asyncHandler(async (req, res) => {
  const { status } = req.body;
  const resolved = await AcademicRiskService.resolveRisk({
    schoolId: req.schoolId,
    riskId: req.params.id,
    resolvedBy: req.user.internal_id || req.user.id,
    status: status || 'RESOLVED'
  });
  return sendSuccess(res, req.schoolId, resolved);
}));

/**
 * POST /api/v1/academics/recovery-plans/generate
 * Generate recovery options for an at-risk plan
 */
router.post('/recovery-plans/generate', requireAuth, requireAnyPermission(PLANNER_RECOVERY), asyncHandler(async (req, res) => {
  const { plan_id, risk_event_id } = req.body;
  if (!plan_id) return sendError(res, 400, 'plan_id is required');

  const proposal = await AcademicRecoveryService.generateRecoveryOptions({
    schoolId: req.schoolId,
    planId: plan_id,
    riskEventId: risk_event_id,
    createdBy: req.user.internal_id || req.user.id
  });

  return sendSuccess(res, req.schoolId, proposal, 201);
}));

/**
 * POST /api/v1/academics/recovery-plans/:id/approve
 * Approve recovery option
 */
router.post('/recovery-plans/:id/approve', requireAuth, requireAnyPermission(PLANNER_RECOVERY), asyncHandler(async (req, res) => {
  const { selected_option } = req.body;
  if (!selected_option) return sendError(res, 400, 'selected_option is required');

  const approved = await AcademicRecoveryService.approveRecoveryOption({
    schoolId: req.schoolId,
    recoveryPlanId: req.params.id,
    selectedOption: selected_option,
    approvedBy: req.user.internal_id || req.user.id
  });

  return sendSuccess(res, req.schoolId, approved);
}));

/**
 * POST /api/v1/academics/holiday-impact/simulate
 * Simulate impact of unexpected school closure on academic plans
 */
router.post('/holiday-impact/simulate', requireAuth, asyncHandler(async (req, res) => {
  const { start_date, end_date } = req.body;
  if (!start_date || !end_date) {
    return sendError(res, 400, 'start_date and end_date are required');
  }

  const simulation = await AcademicRecoveryService.simulateHolidayDisruption({
    schoolId: req.schoolId,
    startDate: start_date,
    endDate: end_date
  });

  return sendSuccess(res, req.schoolId, simulation);
}));

/**
 * POST /api/v1/academics/holiday-impact/shift
 * Shift affected plans forward after unexpected holiday
 */
router.post('/holiday-impact/shift', requireAuth, requireAnyPermission(PLANNER_RECOVERY), asyncHandler(async (req, res) => {
  const { start_date, end_date, shift_days } = req.body;
  const result = await AcademicRecoveryService.shiftPlansForHoliday({
    schoolId: req.schoolId,
    startDate: start_date,
    endDate: end_date,
    shiftDays: shift_days
  });
  return sendSuccess(res, req.schoolId, result);
}));

// ══════════════════════════════════════════════════════════════════════════════
// 8. PARENT SANITIZED VIEW
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/academics/parent-summary
 * Sanitized, encouraging view for parents: Currently Learning, Recently Completed, Upcoming
 * Strictly hides delay warnings, teacher scores, and risk classifications.
 */
router.get('/parent-summary', requireAuth, requireAnyPermission(PLANNER_VIEW), asyncHandler(async (req, res) => {
  let studentId = req.query.student_id;
  const roles = req.user?.roles || [];
  const isManagement = roles.includes('admin') || roles.includes('principal') || roles.includes('staff') || roles.includes('teacher');
  if (isStudentPortalRequest(req) || !isManagement) {
    studentId = await resolveStudentId(req);
  }
  if (!studentId) return sendError(res, 400, 'student_id is required');

  // 1. Resolve student's class_section
  const [enrollment] = await sql`
    SELECT se.class_section_id, cs.class_id, cs.section_id, cs.academic_year_id,
           cl.name AS class_name, sec.name AS section_name
    FROM student_enrollments se
    JOIN class_sections cs ON se.class_section_id = cs.id
    JOIN classes cl ON cs.class_id = cl.id
    JOIN sections sec ON cs.section_id = sec.id
    WHERE se.student_id = ${studentId}
      AND se.school_id = ${req.schoolId}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
    LIMIT 1
  `;

  if (!enrollment) {
    return sendSuccess(res, req.schoolId, { subjects: [] });
  }

  // 2. Fetch active plans for this student's class and section
  const plans = await sql`
    SELECT 
      p.id AS plan_id,
      s.id AS subject_id,
      s.name AS subject_name,
      m.actual_progress
    FROM academic_plans p
    JOIN subjects s ON p.subject_id = s.id
    LEFT JOIN academic_plan_metrics m ON p.id = m.academic_plan_id
    WHERE p.school_id = ${req.schoolId}
      AND p.class_id = ${enrollment.class_id}
      AND p.section_id = ${enrollment.section_id}
      AND p.status IN ('ACTIVE', 'APPROVED', 'COMPLETED')
      AND p.deleted_at IS NULL
    ORDER BY s.name ASC
  `;

  const subjects = await Promise.all(
    plans.map(async (p) => {
      // Current topic
      const [curr] = await sql`
        SELECT tp.title AS topic_title, ch.title AS chapter_title
        FROM academic_plan_items i
        JOIN curriculum_topics tp ON i.curriculum_topic_id = tp.id
        JOIN curriculum_chapters ch ON tp.chapter_id = ch.id
        WHERE i.academic_plan_id = ${p.plan_id}
          AND i.school_id = ${req.schoolId}
          AND i.status IN ('IN_PROGRESS', 'NOT_STARTED')
          AND i.deleted_at IS NULL
        ORDER BY i.sequence ASC LIMIT 1
      `;

      // Recently completed topic
      const [prev] = await sql`
        SELECT tp.title AS topic_title, ch.title AS chapter_title
        FROM academic_plan_items i
        JOIN curriculum_topics tp ON i.curriculum_topic_id = tp.id
        JOIN curriculum_chapters ch ON tp.chapter_id = ch.id
        WHERE i.academic_plan_id = ${p.plan_id}
          AND i.school_id = ${req.schoolId}
          AND i.status = 'COMPLETED'
          AND i.deleted_at IS NULL
        ORDER BY i.completed_at DESC NULLS LAST, i.sequence DESC LIMIT 1
      `;

      // Coming up next
      const [next] = await sql`
        SELECT tp.title AS topic_title, ch.title AS chapter_title
        FROM academic_plan_items i
        JOIN curriculum_topics tp ON i.curriculum_topic_id = tp.id
        JOIN curriculum_chapters ch ON tp.chapter_id = ch.id
        WHERE i.academic_plan_id = ${p.plan_id}
          AND i.school_id = ${req.schoolId}
          AND i.status = 'NOT_STARTED'
          AND i.deleted_at IS NULL
        ORDER BY i.sequence ASC OFFSET 1 LIMIT 1
      `;

      return {
        subject_id: p.subject_id,
        subject_name: p.subject_name,
        term_progress: Math.round(Number(p.actual_progress || 0)),
        currently_learning: curr ? `${curr.chapter_title}: ${curr.topic_title}` : 'Completed',
        recently_completed: prev ? `${prev.chapter_title}: ${prev.topic_title}` : 'None yet',
        coming_next: next ? `${next.chapter_title}: ${next.topic_title}` : 'Revision'
      };
    })
  );

  return sendSuccess(res, req.schoolId, {
    class_name: enrollment.class_name,
    section_name: enrollment.section_name,
    subjects
  });
}));

router.get('/settings', requireAuth, requireAnyPermission(PLANNER_VIEW.concat(['academics.manage'])), asyncHandler(async (req, res) => {
  const [settings] = await sql`
    SELECT * FROM academic_planner_settings WHERE school_id = ${req.schoolId}
  `;
  return sendSuccess(res, req.schoolId, settings || { enabled: true, approval_mode: 'OFF' });
}));

router.put('/settings', requireAuth, requireAnyPermission(['academic_planner.recovery', 'academics.manage']), asyncHandler(async (req, res) => {
  const { enabled, approval_mode, on_track_variance, slight_delay_variance, at_risk_variance, delay_persist_days } = req.body;
  const [updated] = await sql`
    INSERT INTO academic_planner_settings (
      school_id, enabled, approval_mode, on_track_variance, slight_delay_variance, at_risk_variance, delay_persist_days
    ) VALUES (
      ${req.schoolId},
      ${enabled !== false},
      ${approval_mode || 'OFF'},
      ${on_track_variance ?? -5},
      ${slight_delay_variance ?? -15},
      ${at_risk_variance ?? -25},
      ${delay_persist_days ?? 7}
    )
    ON CONFLICT (school_id) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      approval_mode = EXCLUDED.approval_mode,
      on_track_variance = EXCLUDED.on_track_variance,
      slight_delay_variance = EXCLUDED.slight_delay_variance,
      at_risk_variance = EXCLUDED.at_risk_variance,
      delay_persist_days = EXCLUDED.delay_persist_days,
      updated_at = now()
    RETURNING *
  `;
  await sql`
    INSERT INTO school_settings (school_id, key, value)
    VALUES (${req.schoolId}, 'academic_planner_enabled', ${updated.enabled ? 'true' : 'false'})
    ON CONFLICT (school_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
  return sendSuccess(res, req.schoolId, updated);
}));

router.get('/reports/weekly', requireAuth, requireAnyPermission(['academic_planner.report', 'academic_planner.risk', 'academics.manage']), asyncHandler(async (req, res) => {
  const summary = await AcademicAnalyticsService.getWeeklySummary({
    schoolId: req.schoolId,
    academicYearId: req.query.academic_year_id
  });
  return sendSuccess(res, req.schoolId, summary);
}));

export default router;
