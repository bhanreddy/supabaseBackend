import express from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import sql from '../db.js';
import {
  getComplianceSummary,
  getMissingDocumentsList,
  sendDocumentReminder,
  getRequiredDocuments,
} from '../services/studentDocumentService.js';

const router = express.Router();

/**
 * GET /students/documents/compliance-summary
 * Get student admission document compliance summary (counts, % and grade breakdown)
 */
router.get(
  '/compliance-summary',
  requireAuth,
  requirePermission('students.view'),
  asyncHandler(async (req, res) => {
    const summary = await getComplianceSummary(req.schoolId);
    return sendSuccess(res, req.schoolId, summary);
  }),
);

/**
 * GET /students/documents/missing-list
 * Get list of students missing mandatory admission documents
 */
router.get(
  '/missing-list',
  requireAuth,
  requirePermission('students.view'),
  asyncHandler(async (req, res) => {
    const { class_id: classId, section_id: sectionId, search } = req.query;
    const list = await getMissingDocumentsList(req.schoolId, {
      classId: classId ? String(classId) : null,
      sectionId: sectionId ? String(sectionId) : null,
      search: search ? String(search).trim() : '',
    });
    return sendSuccess(res, req.schoolId, list);
  }),
);

/**
 * GET /students/documents/requirements
 * Get required document types for the school
 */
router.get(
  '/requirements',
  requireAuth,
  requirePermission('students.view'),
  asyncHandler(async (req, res) => {
    const reqs = await getRequiredDocuments(req.schoolId);
    return sendSuccess(res, req.schoolId, reqs);
  }),
);

/**
 * POST /students/documents/batch-remind
 * Send reminders to parents for multiple students with missing documents
 */
router.post(
  '/batch-remind',
  requireAuth,
  requirePermission('students.edit'),
  asyncHandler(async (req, res) => {
    const { student_ids: studentIds = [], custom_message: customMessage } = req.body || {};
    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return sendError(res, 400, 'student_ids array is required');
    }

    let dispatched = 0;
    const errors = [];

    await Promise.allSettled(
      studentIds.map(async (sId) => {
        try {
          await sendDocumentReminder(req.schoolId, sId, {
            actorId: req.user.internal_id,
            customMessage,
          });
          dispatched++;
        } catch (err) {
          errors.push({ studentId: sId, error: err.message });
        }
      }),
    );

    return sendSuccess(res, req.schoolId, {
      success: true,
      dispatched,
      total: studentIds.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  }),
);

/**
 * POST /students/documents/:id/remind
 * Send reminder to parent for missing documents
 */
router.post(
  '/:id/remind',
  requireAuth,
  requirePermission('students.edit'),
  asyncHandler(async (req, res) => {
    const studentId = req.params.id;
    const { custom_message: customMessage } = req.body || {};

    try {
      const result = await sendDocumentReminder(req.schoolId, studentId, {
        actorId: req.user.internal_id,
        customMessage,
      });
      return sendSuccess(res, req.schoolId, result);
    } catch (err) {
      if (err.message === 'STUDENT_NOT_FOUND') {
        return sendError(res, 404, 'Student not found');
      }
      throw err;
    }
  }),
);

/**
 * POST /students/documents/:id/submit
 * Upload / record submission of a student document
 */
router.post(
  '/:id/submit',
  requireAuth,
  requirePermission('students.edit'),
  asyncHandler(async (req, res) => {
    const studentId = req.params.id;
    const { document_type: docType, title, file_url: fileUrl, notes } = req.body || {};

    if (!docType) {
      return sendError(res, 400, 'document_type is required');
    }

    const [doc] = await sql`
      INSERT INTO student_documents (
        school_id,
        student_id,
        document_type,
        title,
        file_url,
        status,
        notes,
        created_at,
        updated_at
      )
      VALUES (
        ${req.schoolId},
        ${studentId},
        ${docType},
        ${title || null},
        ${fileUrl || null},
        'SUBMITTED',
        ${notes || null},
        now(),
        now()
      )
      RETURNING *
    `;

    return sendSuccess(res, req.schoolId, doc, 201);
  }),
);

export default router;
