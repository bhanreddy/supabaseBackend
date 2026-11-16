import express from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { resolveStudentParamWithAccess } from '../utils/studentPortal.js';
import { calendarCapabilities, loadStudentAttendanceCalendar, finalizeAttendanceReport } from '../services/studentAttendanceCalendarService.js';

const router = express.Router({ mergeParams: true });
router.get('/capabilities', requireAuth, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const id = await resolveStudentParamWithAccess(req, res, req.params.id);
  if (!id) return;
  sendSuccess(res, req.schoolId, await calendarCapabilities(req.schoolId));
}));
const context = (req, studentId) => ({ schoolId: req.schoolId, studentId,
  userId: req.user?.internal_id || req.user?.id, roles: ['parent', 'student'],
  academicYearId: req.query.academic_year_id, from: req.query.from_date, to: req.query.to_date });
router.get('/calendar', requireAuth, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const id = await resolveStudentParamWithAccess(req, res, req.params.id);
  if (!id) return;
  sendSuccess(res, req.schoolId, await loadStudentAttendanceCalendar({ ...context(req, id), month: req.query.month || (await calendarCapabilities(req.schoolId)).school_today.slice(0, 7) }));
}));
router.get('/report', requireAuth, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const id = await resolveStudentParamWithAccess(req, res, req.params.id);
  if (!id) return;
  sendSuccess(res, req.schoolId, await loadStudentAttendanceCalendar({ ...context(req, id), report: true }));
}));
router.post('/finalize', requireAuth, requirePermission('attendance.edit'), asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const id = await resolveStudentParamWithAccess(req, res, req.params.id);
  if (!id) return;
  sendSuccess(res, req.schoolId, await finalizeAttendanceReport({ ...context(req, id),
    academicYearId: req.body.academic_year_id, from: req.body.from_date, to: req.body.to_date },
  req.user?.internal_id || req.user?.id, req.body.reason, req.body.snapshot_hash));
}));
export default router;
