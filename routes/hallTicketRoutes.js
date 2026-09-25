import express from 'express';
import { requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import {
  HallTicketBatchError,
  completeHallTicketBatchForRequest,
  failHallTicketBatchForRequest,
  getHallTicketDownloadForRequest,
  prepareHallTicketBatchForRequest,
} from '../services/hallTicketBatchService.js';

const router = express.Router();

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function actorId(req) {
  return req.staffPortalAccess?.admin_user_id || req.user?.internal_id || req.user?.id || null;
}

function requestArgs(req) {
  return {
    schoolId: req.schoolId,
    examId: req.params.examId,
    classId: req.query.class_id ?? req.body?.class_id,
    sectionId: req.query.section_id ?? req.body?.section_id,
    min_clearance_percent:
      req.query.min_clearance_percent ?? req.body?.min_clearance_percent,
    max_clearance_percent:
      req.query.max_clearance_percent ?? req.body?.max_clearance_percent,
    exclude_previously_downloaded:
      req.query.exclude_previously_downloaded ?? req.body?.exclude_previously_downloaded,
    tickets_per_page: req.body?.tickets_per_page,
    show_roll_numbers: req.body?.show_roll_numbers,
    student_ids: req.body?.student_ids,
    userId: actorId(req),
  };
}

function handleHallTicketError(res, error) {
  if (error instanceof HallTicketBatchError) {
    return res.status(error.status).json({ error: error.message });
  }
  const relationMissing = error?.code === '42P01';
  console.error('[hall-tickets] operation failed', error?.code || '', error?.message || error);
  if (relationMissing) {
    return res.status(503).json({
      error: 'Hall-ticket download tracking is not installed. Apply the hall-ticket migration and retry.',
      code: 'HALL_TICKET_TRACKING_NOT_CONFIGURED',
    });
  }
  return res.status(500).json({ error: 'The hall-ticket operation could not be completed.' });
}

/** Read-only eligibility preview. Existing results routes are deliberately not used or modified. */
router.get('/exams/:examId/preview', requirePermission('exams.view'), async (req, res) => {
  try {
    const data = await getHallTicketDownloadForRequest(requestArgs(req));
    return sendSuccess(res, req.schoolId, data);
  } catch (error) {
    return handleHallTicketError(res, error);
  }
});

/** Recomputes the roster and reserves it for 15 minutes before client-side PDF generation. */
router.post('/exams/:examId/batches', requirePermission('exams.view'), async (req, res) => {
  try {
    const data = await prepareHallTicketBatchForRequest(requestArgs(req));
    return sendSuccess(res, req.schoolId, data, 201);
  } catch (error) {
    return handleHallTicketError(res, error);
  }
});

router.post(
  '/exams/:examId/batches/:batchId/complete',
  requirePermission('exams.view'),
  async (req, res) => {
    try {
      const data = await completeHallTicketBatchForRequest({
        schoolId: req.schoolId,
        examId: req.params.examId,
        batchId: req.params.batchId,
      });
      return sendSuccess(res, req.schoolId, data);
    } catch (error) {
      return handleHallTicketError(res, error);
    }
  },
);

router.post(
  '/exams/:examId/batches/:batchId/fail',
  requirePermission('exams.view'),
  async (req, res) => {
    try {
      const data = await failHallTicketBatchForRequest({
        schoolId: req.schoolId,
        examId: req.params.examId,
        batchId: req.params.batchId,
      });
      return sendSuccess(res, req.schoolId, data);
    } catch (error) {
      return handleHallTicketError(res, error);
    }
  },
);

export default router;
