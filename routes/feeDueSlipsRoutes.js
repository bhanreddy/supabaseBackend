import express from 'express';
import sql from '../db.js';
import { requireAuth, requireAnyPermission } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getStudentsWithDueFees,
  resolveFeeDueAcademicYear,
} from '../services/feeDueCalculationService.js';
import {
  getSampleStudentData,
  resolveStudentDocumentData,
  getSchoolBranding,
} from '../services/documentDataResolver.js';
import {
  listTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  duplicateTemplate,
  setDefaultTemplate,
  archiveTemplate,
  getDefaultTemplateDefinition,
  DEFAULT_PAGE_SETTINGS,
} from '../services/documentTemplateService.js';
import {
  buildDocumentHtml,
  buildZipArchive,
  buildDueStudentsWorkbook,
  buildDueStudentsCsv,
  buildDocxHtml,
} from '../services/documentGenerationService.js';

const router = express.Router();

const accountsFeeGuard = [
  requireAuth,
  requireAnyPermission(['fees.view', 'fees.manage', 'fees.collect']),
];

function actorId(req) {
  return req.staffPortalAccess?.admin_user_id || req.user?.internal_id || req.user?.id;
}

async function recordAudit(req, action, entityId = null, details = {}) {
  try {
    await sql`
      INSERT INTO audit_logs (
        school_id, user_id, action, entity, entity_id, details, ip_address, user_agent
      ) VALUES (
        ${req.schoolId},
        ${actorId(req)},
        ${action},
        'fee_due_slips',
        ${entityId},
        ${sql.json({
          ...details,
          actor_role: (req.user?.roles || []).join(','),
          timestamp: new Date().toISOString(),
        })},
        ${req.ip || null},
        ${req.headers['user-agent'] || null}
      )
    `;
  } catch (err) {
    console.warn('[feeDueSlips] Audit logging failed (non-fatal):', err.message);
  }
}

// ─── 1. TEMPLATES CRUD ────────────────────────────────────────────────────────

/**
 * GET /api/v1/fee-due-slips/templates
 */
router.get('/templates', accountsFeeGuard, asyncHandler(async (req, res) => {
  const templates = await listTemplates(req.schoolId, {
    documentType: req.query.document_type || 'fee_due_slip',
    includeArchived: req.query.include_archived === 'true',
  });
  return sendSuccess(res, req.schoolId, { templates });
}));

/**
 * POST /api/v1/fee-due-slips/templates
 */
router.post('/templates', accountsFeeGuard, asyncHandler(async (req, res) => {
  const created = await createTemplate(req.schoolId, req.body, actorId(req));
  await recordAudit(req, 'TEMPLATE_CREATED', created.id, { name: created.name });
  return sendSuccess(res, req.schoolId, { template: created }, 201);
}));

/**
 * GET /api/v1/fee-due-slips/templates/:id
 */
router.get('/templates/:id', accountsFeeGuard, asyncHandler(async (req, res) => {
  const template = await getTemplateById(req.schoolId, req.params.id);
  if (!template) {
    return sendError(res, 404, 'Template not found.');
  }
  return sendSuccess(res, req.schoolId, { template });
}));

/**
 * PUT /api/v1/fee-due-slips/templates/:id
 */
router.put('/templates/:id', accountsFeeGuard, asyncHandler(async (req, res) => {
  const updated = await updateTemplate(req.schoolId, req.params.id, req.body, actorId(req));
  await recordAudit(req, 'TEMPLATE_UPDATED', updated.id, { name: updated.name });
  return sendSuccess(res, req.schoolId, { template: updated });
}));

/**
 * DELETE /api/v1/fee-due-slips/templates/:id
 */
router.delete('/templates/:id', accountsFeeGuard, asyncHandler(async (req, res) => {
  const archived = await archiveTemplate(req.schoolId, req.params.id);
  await recordAudit(req, 'TEMPLATE_ARCHIVED', req.params.id, { name: archived.name });
  return sendSuccess(res, req.schoolId, { message: 'Template archived successfully.' });
}));

/**
 * POST /api/v1/fee-due-slips/templates/:id/duplicate
 */
router.post('/templates/:id/duplicate', accountsFeeGuard, asyncHandler(async (req, res) => {
  const duplicated = await duplicateTemplate(req.schoolId, req.params.id, actorId(req));
  await recordAudit(req, 'TEMPLATE_DUPLICATED', duplicated.id, { source_id: req.params.id, name: duplicated.name });
  return sendSuccess(res, req.schoolId, { template: duplicated }, 201);
}));

/**
 * POST /api/v1/fee-due-slips/templates/:id/default
 */
router.post('/templates/:id/default', accountsFeeGuard, asyncHandler(async (req, res) => {
  const updated = await setDefaultTemplate(req.schoolId, req.params.id);
  await recordAudit(req, 'TEMPLATE_SET_DEFAULT', updated.id, { name: updated.name });
  return sendSuccess(res, req.schoolId, { template: updated });
}));

// ─── 2. STUDENTS FILTER & RESULT TABLE ────────────────────────────────────────

/**
 * GET /api/v1/fee-due-slips/students
 * Server-side filtering, pagination, and authoritative due calculation.
 */
router.get('/students', accountsFeeGuard, asyncHandler(async (req, res) => {
  const data = await getStudentsWithDueFees(req.schoolId, {
    academic_year_id: req.query.academic_year_id,
    class_id: req.query.class_id,
    section_id: req.query.section_id,
    fee_status: req.query.fee_status || 'Pending',
    min_due: req.query.min_due,
    max_due: req.query.max_due,
    fee_type_id: req.query.fee_type_id,
    due_date_before: req.query.due_date_before,
    overdue_days_min: req.query.overdue_days_min,
    village_id: req.query.village_id,
    search: req.query.search,
    page: req.query.page,
    limit: req.query.limit,
    sort_by: req.query.sort_by,
    sort_dir: req.query.sort_dir,
  });

  return sendSuccess(res, req.schoolId, data);
}));

// ─── 3. PREVIEW RENDERER ──────────────────────────────────────────────────────

/**
 * POST /api/v1/fee-due-slips/preview
 * Renders document HTML using sample data OR real student data.
 */
router.post('/preview', accountsFeeGuard, asyncHandler(async (req, res) => {
  const { template_id, template_definition, page_settings, student_id, use_sample_data = true } = req.body;

  let template;
  if (template_id) {
    template = await getTemplateById(req.schoolId, template_id);
  }
  if (!template) {
    template = {
      name: req.body.template_name || 'Standard Fee Due Slip',
      template_definition: template_definition || getDefaultTemplateDefinition(),
      page_settings: page_settings || DEFAULT_PAGE_SETTINGS,
    };
  } else if (template_definition || page_settings) {
    template = {
      ...template,
      template_definition: template_definition || template.template_definition,
      page_settings: page_settings || template.page_settings,
    };
  }

  const branding = await getSchoolBranding(req.schoolId);

  let studentData;
  if (use_sample_data || !student_id) {
    studentData = getSampleStudentData(branding);
  } else {
    studentData = await resolveStudentDocumentData(req.schoolId, student_id, {
      academicYearId: req.body.academic_year_id,
    });
  }

  const html = buildDocumentHtml({
    template,
    studentsData: [studentData],
    pageSettings: template.page_settings,
  });

  return sendSuccess(res, req.schoolId, {
    html,
    resolved_data: studentData,
  });
}));

// ─── 4. BATCH GENERATION & JOBS ───────────────────────────────────────────────

/**
 * POST /api/v1/fee-due-slips/generate
 * Initiates single or bulk generation.
 */
router.post('/generate', accountsFeeGuard, asyncHandler(async (req, res) => {
  const {
    template_id,
    student_ids,
    academic_year_id,
    filters = {},
    layout_mode, // 1, 2, 4
    output_format = 'pdf', // 'pdf', 'zip', 'print', 'docx', 'xlsx', 'csv'
  } = req.body;

  if (!Array.isArray(student_ids) || student_ids.length === 0) {
    return sendError(res, 400, 'Please select at least one student to generate slips.');
  }

  let template;
  if (template_id) {
    template = await getTemplateById(req.schoolId, template_id);
  }
  if (!template) {
    const defaultTemplates = await listTemplates(req.schoolId);
    template = defaultTemplates[0] || {
      id: null,
      name: 'Standard Fee Due Slip',
      template_definition: getDefaultTemplateDefinition(),
      page_settings: DEFAULT_PAGE_SETTINGS,
    };
  }

  const pageSettings = {
    ...template.page_settings,
    ...(layout_mode ? { slips_per_page: Number(layout_mode) } : {}),
  };

  // Fetch all selected students with authoritative due calculation
  const queryResult = await getStudentsWithDueFees(req.schoolId, {
    student_ids,
    academic_year_id,
    limit: 'all',
  });

  const students = queryResult.students;
  if (students.length === 0) {
    return sendError(res, 400, 'No matching student records found for the selected IDs.');
  }

  // Allocate document numbers and resolve full template variables
  const resolvedStudentsData = [];
  for (const s of students) {
    const [docRow] = await sql`
      SELECT public.get_next_document_no(${req.schoolId}, 'fee_due_slip') AS doc_no
    `;
    const docNo = docRow?.doc_no || 'FDS-' + new Date().getFullYear() + '-' + s.admission_no;

    const resolved = await resolveStudentDocumentData(req.schoolId, s.student_id, {
      academicYearId: academic_year_id,
      documentNumber: docNo,
    });
    resolvedStudentsData.push(resolved);
  }

  const totalDueAmount = students.reduce((acc, s) => acc + Number(s.due_amount || 0), 0);

  // Record generation job
  const [job] = await sql`
    INSERT INTO document_generation_jobs (
      school_id, template_id, document_type, filters, student_count,
      total_due_amount, status, progress, output_format, created_by,
      completed_at, metadata
    ) VALUES (
      ${req.schoolId},
      ${template.id || null},
      'fee_due_slip',
      ${sql.json(filters)},
      ${students.length},
      ${totalDueAmount},
      'completed',
      100,
      ${output_format},
      ${actorId(req)},
      NOW(),
      ${sql.json({
        template_name: template.name,
        layout_mode: pageSettings.slips_per_page,
        student_ids,
      })}
    )
    RETURNING *
  `;

  // Audit log
  await recordAudit(req, 'FEE_DUE_SLIPS_GENERATED', job.id, {
    template_id: template.id,
    template_name: template.name,
    student_count: students.length,
    total_due_amount: totalDueAmount,
    output_format,
    filters,
  });

  // Build rendered HTML
  const html = buildDocumentHtml({
    template,
    studentsData: resolvedStudentsData,
    pageSettings,
  });

  return sendSuccess(res, req.schoolId, {
    job_id: job.id,
    status: 'completed',
    progress: 100,
    student_count: students.length,
    total_due_amount: totalDueAmount,
    html,
    students: resolvedStudentsData,
    document_numbers: resolvedStudentsData.map((d) => d.document_number),
  });
}));

/**
 * GET /api/v1/fee-due-slips/jobs/:id
 */
router.get('/jobs/:id', accountsFeeGuard, asyncHandler(async (req, res) => {
  const [job] = await sql`
    SELECT * FROM document_generation_jobs
    WHERE id = ${req.params.id} AND school_id = ${req.schoolId}
    LIMIT 1
  `;
  if (!job) {
    return sendError(res, 404, 'Generation job not found.');
  }
  return sendSuccess(res, req.schoolId, { job });
}));

/**
 * POST /api/v1/fee-due-slips/jobs/:id/cancel
 */
router.post('/jobs/:id/cancel', accountsFeeGuard, asyncHandler(async (req, res) => {
  const [updated] = await sql`
    UPDATE document_generation_jobs
    SET status = 'cancelled', completed_at = NOW()
    WHERE id = ${req.params.id} AND school_id = ${req.schoolId} AND status IN ('pending', 'processing')
    RETURNING *
  `;
  if (!updated) {
    return sendError(res, 400, 'Job cannot be cancelled or already finished.');
  }
  return sendSuccess(res, req.schoolId, { job: updated });
}));

// ─── 5. GENERATION HISTORY & AUDIT TRAIL ──────────────────────────────────────

/**
 * GET /api/v1/fee-due-slips/history
 */
router.get('/history', accountsFeeGuard, asyncHandler(async (req, res) => {
  const safeLimit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || 30), 10)));
  const jobs = await sql`
    SELECT
      j.id,
      j.school_id,
      j.template_id,
      j.document_type,
      j.filters,
      j.student_count,
      j.total_due_amount,
      j.status,
      j.progress,
      j.output_format,
      j.created_at,
      j.completed_at,
      j.metadata,
      t.name AS template_name,
      p.display_name AS created_by_name
    FROM document_generation_jobs j
    LEFT JOIN document_templates t ON t.id = j.template_id
    LEFT JOIN users u ON u.id = j.created_by
    LEFT JOIN persons p ON p.id = u.person_id
    WHERE j.school_id = ${req.schoolId}
    ORDER BY j.created_at DESC
    LIMIT ${safeLimit}
  `;

  return sendSuccess(res, req.schoolId, { history: jobs });
}));

// ─── 6. EXPORTS (EXCEL, CSV, DOCX, ZIP) ───────────────────────────────────────

/**
 * GET /api/v1/fee-due-slips/export/xlsx
 */
router.get('/export/xlsx', accountsFeeGuard, asyncHandler(async (req, res) => {
  const studentIds = req.query.student_ids ? String(req.query.student_ids).split(',') : null;
  const result = await getStudentsWithDueFees(req.schoolId, {
    academic_year_id: req.query.academic_year_id,
    class_id: req.query.class_id,
    section_id: req.query.section_id,
    fee_status: req.query.fee_status || 'Pending',
    min_due: req.query.min_due,
    max_due: req.query.max_due,
    student_ids: studentIds,
    limit: 'all',
  });

  const branding = await getSchoolBranding(req.schoolId);
  const buffer = buildDueStudentsWorkbook({
    schoolName: branding.name,
    academicYear: result.academic_year?.code || 'Current',
    students: result.students,
    filters: req.query,
  });

  await recordAudit(req, 'EXPORT_EXCEL', null, { student_count: result.students.length });

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Fee-Due-List-${stamp}.xlsx"`);
  return res.send(buffer);
}));

/**
 * GET /api/v1/fee-due-slips/export/csv
 */
router.get('/export/csv', accountsFeeGuard, asyncHandler(async (req, res) => {
  const studentIds = req.query.student_ids ? String(req.query.student_ids).split(',') : null;
  const result = await getStudentsWithDueFees(req.schoolId, {
    academic_year_id: req.query.academic_year_id,
    class_id: req.query.class_id,
    section_id: req.query.section_id,
    fee_status: req.query.fee_status || 'Pending',
    min_due: req.query.min_due,
    max_due: req.query.max_due,
    student_ids: studentIds,
    limit: 'all',
  });

  const csv = buildDueStudentsCsv(result.students);
  await recordAudit(req, 'EXPORT_CSV', null, { student_count: result.students.length });

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Fee-Due-List-${stamp}.csv"`);
  return res.send(csv);
}));

/**
 * POST /api/v1/fee-due-slips/export/docx
 */
router.post('/export/docx', accountsFeeGuard, asyncHandler(async (req, res) => {
  const { template_id, student_ids, academic_year_id } = req.body;
  const template = template_id
    ? await getTemplateById(req.schoolId, template_id)
    : { name: 'Standard Fee Due Slip', template_definition: getDefaultTemplateDefinition(), page_settings: DEFAULT_PAGE_SETTINGS };

  const queryResult = await getStudentsWithDueFees(req.schoolId, {
    student_ids,
    academic_year_id,
    limit: 'all',
  });

  const resolvedStudentsData = [];
  for (const s of queryResult.students) {
    const resolved = await resolveStudentDocumentData(req.schoolId, s.student_id, { academicYearId: academic_year_id });
    resolvedStudentsData.push(resolved);
  }

  const docxHtml = buildDocxHtml({
    template,
    studentsData: resolvedStudentsData,
    pageSettings: template.page_settings,
  });

  await recordAudit(req, 'EXPORT_DOCX', null, { student_count: resolvedStudentsData.length });

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/msword');
  res.setHeader('Content-Disposition', `attachment; filename="Fee-Due-Slips-${stamp}.doc"`);
  return res.send(docxHtml);
}));

/**
 * POST /api/v1/fee-due-slips/export/zip
 * Generates and streams a ZIP file of individual slips organized by Class & Section.
 */
router.post('/export/zip', accountsFeeGuard, asyncHandler(async (req, res) => {
  const { template_id, student_ids, academic_year_id } = req.body;
  if (!Array.isArray(student_ids) || student_ids.length === 0) {
    return sendError(res, 400, 'Please select students to export.');
  }

  const template = template_id
    ? await getTemplateById(req.schoolId, template_id)
    : { name: 'Standard Fee Due Slip', template_definition: getDefaultTemplateDefinition(), page_settings: DEFAULT_PAGE_SETTINGS };

  const queryResult = await getStudentsWithDueFees(req.schoolId, {
    student_ids,
    academic_year_id,
    limit: 'all',
  });

  const resolvedStudentsData = [];
  for (const s of queryResult.students) {
    const resolved = await resolveStudentDocumentData(req.schoolId, s.student_id, { academicYearId: academic_year_id });
    resolvedStudentsData.push(resolved);
  }

  await recordAudit(req, 'EXPORT_ZIP', null, { student_count: resolvedStudentsData.length });

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="Fee-Due-Slips-${stamp}.zip"`);

  const archive = await buildZipArchive({
    template,
    studentsData: resolvedStudentsData,
    pageSettings: template.page_settings,
  });

  archive.pipe(res);
}));

export default router;
