import express from 'express';
import { requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getUdiseReadinessOverview,
  getUdiseStudentList,
  generateUdiseCsv,
} from '../services/udiseReadinessService.js';

const router = express.Router();

/**
 * Global tenant sanitization
 */
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
 * GET /api/v1/udise/readiness
 * Returns overall readiness metrics and class-wise breakdown.
 */
router.get('/readiness', requirePermission('udise.view'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const overview = await getUdiseReadinessOverview(schoolId);
  return sendSuccess(res, schoolId, overview);
}));

/**
 * GET /api/v1/udise/students
 * Filterable student list with specific validation errors.
 */
router.get('/students', requirePermission('udise.view'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { class_id, section_id, status, missing_field, limit = 50, page = 1 } = req.query;

  const result = await getUdiseStudentList(schoolId, {
    classId: class_id,
    sectionId: section_id,
    status,
    missingField: missing_field,
    limit,
    page,
  });

  return sendSuccess(res, schoolId, result);
}));

/**
 * GET /api/v1/udise/export
 * Downloads sanitized CSV of students with validation status.
 * Requires students.manage permission. Masks Aadhaar for non-superadmins/admins.
 */
router.get('/export', requirePermission('udise.export'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { class_id } = req.query;

  const isAdmin = req.user?.roles?.includes('admin') || req.user?.roles?.includes('superadmin');
  const csvContent = await generateUdiseCsv(schoolId, {
    classId: class_id,
    maskAadhaar: !isAdmin,
  });

  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `udise_readiness_${schoolId}_${dateStr}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(csvContent);
}));

export default router;
