import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { singleExcelUpload, handleMulterError } from '../middleware/excelUpload.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  parseExcelBuffer,
  isLikelyExcelBuffer,
  resolveCurrentAcademicYear,
  createPreviewBatch,
  commitImportBatch,
  getImportBatch,
  listImportBatches,
  buildFailureExportBuffer,
  buildImportTemplateBuffer,
} from '../services/transportImportService.js';

const router = express.Router();

/**
 * POST /transport/import/preview
 * Upload Excel and validate rows (preview persisted in DB).
 */
router.post(
  '/import/preview',
  requirePermission('transport.manage'),
  (req, res, next) => {
    singleExcelUpload(req, res, (err) => {
      if (err) return handleMulterError(err, req, res, next);
      next();
    });
  },
  asyncHandler(async (req, res) => {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Excel file is required (field name: file)' });
    }
    if (!isLikelyExcelBuffer(req.file.buffer, req.file.originalname)) {
      return res.status(400).json({ error: 'Invalid file format. Upload a valid Excel file (.xlsx or .xls).' });
    }

    let academicYearId = req.query.academic_year_id || req.body?.academic_year_id || null;
    if (academicYearId) {
      const [ay] = await sql`
        SELECT id FROM academic_years
        WHERE id = ${academicYearId}
          AND school_id = ${req.schoolId}
          AND deleted_at IS NULL
      `;
      if (!ay) return res.status(400).json({ error: 'Invalid academic_year_id for this school' });
    } else {
      const currentAy = await resolveCurrentAcademicYear(sql, req.schoolId);
      if (!currentAy) return res.status(404).json({ error: 'No active academic year found' });
      academicYearId = currentAy.id;
    }

    const parsedRows = parseExcelBuffer(req.file.buffer);
    const uploadedBy = req.user?.internal_id ?? req.user?.id ?? null;

    const result = await createPreviewBatch(sql, {
      schoolId: req.schoolId,
      uploadedBy,
      originalFilename: req.file.originalname,
      academicYearId,
      parsedRows,
    });

    return sendSuccess(res, req.schoolId, {
      batch_id: result.batch.id,
      academic_year_id: academicYearId,
      summary: result.summary,
      rows: result.rows,
    }, 201);
  }),
);

/**
 * GET /transport/import/batches
 */
router.get('/import/batches', requirePermission('transport.view'), asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const batches = await listImportBatches(sql, { schoolId: req.schoolId, page, limit });
  return sendSuccess(res, req.schoolId, { batches, page, limit });
}));

/**
 * GET /transport/import/template
 * Download blank Excel template for bulk stop assignment.
 */
router.get('/import/template', requirePermission('transport.view'), asyncHandler(async (_req, res) => {
  const buffer = buildImportTemplateBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="transport-stop-assignment-template.xlsx"');
  return res.send(buffer);
}));

/**
 * GET /transport/import/:batchId
 */
router.get('/import/:batchId', requirePermission('transport.view'), asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const data = await getImportBatch(sql, {
    schoolId: req.schoolId,
    batchId: req.params.batchId,
    page,
    limit,
  });
  if (!data) return res.status(404).json({ error: 'Import batch not found' });
  return sendSuccess(res, req.schoolId, { ...data, page, limit });
}));

/**
 * POST /transport/import/:batchId/commit
 */
router.post('/import/:batchId/commit', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  try {
    const result = await commitImportBatch(sql, {
      schoolId: req.schoolId,
      batchId: req.params.batchId,
    });
    return sendSuccess(res, req.schoolId, result);
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    throw err;
  }
}));

/**
 * GET /transport/import/:batchId/failures/export
 */
router.get('/import/:batchId/failures/export', requirePermission('transport.view'), asyncHandler(async (req, res) => {
  const [batch] = await sql`
    SELECT id FROM transport_import_batches
    WHERE id = ${req.params.batchId} AND school_id = ${req.schoolId}
  `;
  if (!batch) return res.status(404).json({ error: 'Import batch not found' });

  const buffer = await buildFailureExportBuffer(sql, {
    schoolId: req.schoolId,
    batchId: req.params.batchId,
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="transport-import-failures-${req.params.batchId}.xlsx"`);
  return res.send(buffer);
}));

export default router;
