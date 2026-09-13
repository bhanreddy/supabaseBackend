import express from 'express';
import { requireAuth, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { EventEngineService } from '../services/eventEngineService.js';
import { EventApprovalService } from '../services/eventApprovalService.js';
import { EventRegistrationService } from '../services/eventRegistrationService.js';
import { EventConsentService } from '../services/eventConsentService.js';
import { EventPassService } from '../services/eventPassService.js';
import { EventAttendanceService } from '../services/eventAttendanceService.js';
import { EventTeamTaskService } from '../services/eventTeamTaskService.js';
import { EventTransportService } from '../services/eventTransportService.js';
import { EventBudgetExpenseService } from '../services/eventBudgetExpenseService.js';
import { EventVendorService } from '../services/eventVendorService.js';
import { EventPaymentService } from '../services/eventPaymentService.js';
import { EventCompetitionService } from '../services/eventCompetitionService.js';
import { EventCertificateService } from '../services/eventCertificateService.js';
import { EventIncidentService } from '../services/eventIncidentService.js';
import { EventFeedbackService } from '../services/eventFeedbackService.js';
import { EventReportService } from '../services/eventReportService.js';
import { EventMediaService } from '../services/eventMediaService.js';
import { EventVolunteerService } from '../services/eventVolunteerService.js';
import { EventAssistantService } from '../services/eventAssistantService.js';
import { pickField } from '../services/eventModuleUtils.js';
import sql from '../db.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// 0. PUBLIC ENDPOINTS (No token required)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public certificate verification
 */
router.get('/certificates/verify/:token', asyncHandler(async (req, res) => {
  const result = await EventCertificateService.verifyCertificate(req.params.token);
  return res.json(result);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 1. TEMPLATES & ANALYTICS (Mounted before :id parameter routes)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/templates', requireAuth, asyncHandler(async (req, res) => {
  const templates = await EventEngineService.getTemplates(req.schoolId, req.query.category);
  return sendSuccess(res, req.schoolId, templates);
}));

router.get('/templates/list', requireAuth, asyncHandler(async (req, res) => {
  const templates = await EventEngineService.getTemplates(req.schoolId, req.query.category);
  return sendSuccess(res, req.schoolId, templates);
}));

router.post('/templates/clone', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const { template_id, overrides } = req.body;
  const event = await EventEngineService.cloneFromTemplate({
    schoolId: req.schoolId,
    templateId: template_id,
    overrides: overrides || {},
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, { message: 'Event cloned from template', event }, 201);
}));

router.get('/analytics/cross-events', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const analytics = await EventReportService.getCrossEventAnalytics({ schoolId: req.schoolId });
  return sendSuccess(res, req.schoolId, analytics);
}));

router.get('/eligible', requireAuth, asyncHandler(async (req, res) => {
  const events = await EventEngineService.listEligibleEvents({ schoolId: req.schoolId });
  return sendSuccess(res, req.schoolId, events);
}));

router.get('/passes/mine', requireAuth, asyncHandler(async (req, res) => {
  const passes = await EventPassService.listMyPasses({
    schoolId: req.schoolId,
    studentId: req.query.student_id || null,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, passes);
}));

router.post('/assistant/draft', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const proposal = EventAssistantService.proposeDraft({
    schoolId: req.schoolId,
    prompt: req.body.prompt,
    userId: req.user?.internal_id || req.user?.id,
  });
  let saved = null;
  try {
    saved = await EventAssistantService.saveDraft({
      schoolId: req.schoolId,
      prompt: proposal.prompt,
      userId: req.user?.internal_id || req.user?.id,
      draft: proposal.draft,
    });
  } catch (err) {
    saved = null;
  }
  return sendSuccess(res, req.schoolId, { ...proposal, saved });
}));

// Legacy calendar support
router.get('/calendar', requireAuth, asyncHandler(async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) {
    return res.status(400).json({ error: 'year and month are required' });
  }

  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(year, month, 0).toISOString().split('T')[0];

  const events = await sql`
    SELECT 
      id, title, title_te, category, event_type, start_date, end_date, start_time, end_time,
      is_all_day, location, status, readiness_score
    FROM events
    WHERE school_id = ${req.schoolId}
      AND start_date <= ${endDate} 
      AND (end_date >= ${startDate} OR end_date IS NULL OR COALESCE(end_date, start_date) >= ${startDate})
      AND deleted_at IS NULL
    ORDER BY start_date, start_time
  `;

  return sendSuccess(res, req.schoolId, events);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 2. PASS VALIDATION & GATEKEEPER CHECK-IN
// ─────────────────────────────────────────────────────────────────────────────

router.post('/passes/validate', requireAuth, asyncHandler(async (req, res) => {
  const { token, gate_id, gateId } = req.body;
  const validation = await EventPassService.validateEventPass({
    schoolId: req.schoolId,
    token,
    gateId: gate_id || gateId,
  });
  return sendSuccess(res, req.schoolId, validation);
}));

router.post('/passes/checkin', requireAuth, asyncHandler(async (req, res) => {
  const passToken = pickField(req.body, 'pass_token', 'token', 'passToken');
  const result = await EventPassService.recordCheckIn({
    schoolId: req.schoolId,
    passToken,
    eventId: pickField(req.body, 'event_id', 'eventId'),
    direction: req.body.direction || (req.body.scanType === 'GATE_EXIT' ? 'EXIT' : 'ENTRY'),
    gateId: pickField(req.body, 'gate_id', 'gateId') || null,
    verifiedBy: req.user?.internal_id || req.user?.id,
    verificationMethod: pickField(req.body, 'verification_method', 'verificationMethod') || 'QR_SCAN',
    notes: req.body.notes,
    clientEventId: pickField(req.body, 'client_event_id', 'clientEventId'),
    forceOverride: req.body.force_override === true || req.body.verificationMethod === 'MANUAL_OVERRIDE',
  });
  return sendSuccess(res, req.schoolId, result);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 3. CORE EVENT CRUD & LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List events with operational filters & pagination
 */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const result = await EventEngineService.listEvents({
    schoolId: req.schoolId,
    filters: req.query,
    pagination: { page: req.query.page, limit: req.query.limit },
  });
  return sendSuccess(res, req.schoolId, result);
}));

/**
 * Create a new event
 */
router.post('/', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const event = await EventEngineService.createEvent({
    schoolId: req.schoolId,
    data: req.body,
    userId: req.user?.internal_id || req.user?.id,
    targets: req.body.targets || [],
  });
  return sendSuccess(res, req.schoolId, event, 201);
}));

/**
 * Get full event details
 */
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const event = await EventEngineService.getEventDetails({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, event);
}));

/**
 * Update event info & module configuration
 */
router.put('/:id', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const updated = await EventEngineService.updateEvent({
    schoolId: req.schoolId,
    eventId: req.params.id,
    data: req.body,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, { message: 'Event updated', event: updated });
}));

/**
 * Publish event & notify audience
 */
router.post('/:id/publish', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const published = await EventEngineService.publishEvent({
    schoolId: req.schoolId,
    eventId: req.params.id,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, { message: 'Event published', event: published });
}));

/**
 * Delete event
 */
router.delete('/:id', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const result = await EventEngineService.deleteEvent({
    schoolId: req.schoolId,
    eventId: req.params.id,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, result);
}));

/**
 * Get transparent readiness score breakdown
 */
router.get('/:id/dashboard', requireAuth, asyncHandler(async (req, res) => {
  const dashboard = await EventEngineService.getOperationalDashboard({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, dashboard);
}));

router.get('/:id/readiness', requireAuth, asyncHandler(async (req, res) => {
  const score = await EventEngineService.calculateReadinessScore(req.schoolId, req.params.id);
  return sendSuccess(res, req.schoolId, { readiness_score: score });
}));

router.get('/:id/audit-logs', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const logs = await EventEngineService.getAuditLogs({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, logs);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 4. APPROVALS WORKFLOW
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:id/approvals/submit', requireAuth, asyncHandler(async (req, res) => {
  const event = await EventApprovalService.submitForApproval({
    schoolId: req.schoolId,
    eventId: req.params.id,
    userId: req.user?.internal_id || req.user?.id,
    comments: req.body.comments || req.body.remarks,
  });
  return sendSuccess(res, req.schoolId, { message: 'Event submitted for approval', event });
}));

router.post('/:id/submit-approval', requireAuth, asyncHandler(async (req, res) => {
  const event = await EventApprovalService.submitForApproval({
    schoolId: req.schoolId,
    eventId: req.params.id,
    userId: req.user?.internal_id || req.user?.id,
    comments: req.body.comments || req.body.remarks,
  });
  return sendSuccess(res, req.schoolId, { message: 'Event submitted for approval', event });
}));

router.post('/:id/approvals/decide', requireAuth, requireAnyPermission(['admin.manage', 'approvals.manage']), asyncHandler(async (req, res) => {
  const { decision, comments, remarks, stage } = req.body;
  const event = await EventApprovalService.decideApproval({
    schoolId: req.schoolId,
    eventId: req.params.id,
    userId: req.user?.internal_id || req.user?.id,
    decision,
    comments: comments || remarks,
    stage,
  });
  return sendSuccess(res, req.schoolId, { message: `Event approval decision recorded: ${decision}`, event });
}));

router.get('/:id/approvals/history', requireAuth, asyncHandler(async (req, res) => {
  const history = await EventApprovalService.getApprovalHistory({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, history);
}));

router.get('/:id/approvals', requireAuth, asyncHandler(async (req, res) => {
  const history = await EventApprovalService.getApprovalHistory({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, history);
}));

router.post('/:id/approval-decision', requireAuth, requireAnyPermission(['admin.manage', 'approvals.manage']), asyncHandler(async (req, res) => {
  const event = await EventApprovalService.decideApproval({
    schoolId: req.schoolId,
    eventId: req.params.id,
    userId: req.user?.internal_id || req.user?.id,
    decision: req.body.decision,
    comments: req.body.comments || req.body.remarks,
    stage: req.body.stage,
  });
  return sendSuccess(res, req.schoolId, { message: `Event approval decision recorded: ${req.body.decision}`, event });
}));

// ─────────────────────────────────────────────────────────────────────────────
// 5. REGISTRATIONS & PARTICIPANTS
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:id/register', requireAuth, asyncHandler(async (req, res) => {
  const registration = await EventRegistrationService.registerParticipant({
    schoolId: req.schoolId,
    eventId: req.params.id,
    data: {
      ...req.body,
      student_id: pickField(req.body, 'student_id', 'studentId'),
      participant_type: pickField(req.body, 'participant_type', 'participantType') || 'STUDENT',
    },
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, { message: 'Registration submitted', registration }, 201);
}));

router.post('/:id/registrations', requireAuth, asyncHandler(async (req, res) => {
  const registration = await EventRegistrationService.registerParticipant({
    schoolId: req.schoolId,
    eventId: req.params.id,
    data: {
      ...req.body,
      student_id: pickField(req.body, 'student_id', 'studentId'),
      participant_type: pickField(req.body, 'participant_type', 'participantType') || 'STUDENT',
    },
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, registration, 201);
}));

router.post('/:id/registrations/promote', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const updated = await EventRegistrationService.promoteWaitlisted({
    schoolId: req.schoolId,
    eventId: req.params.id,
    studentId: pickField(req.body, 'student_id', 'studentId'),
    registrationId: pickField(req.body, 'registration_id', 'registrationId'),
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, updated);
}));

router.get('/:id/registrations', requireAuth, asyncHandler(async (req, res) => {
  const list = await EventRegistrationService.listRegistrations({
    schoolId: req.schoolId,
    eventId: req.params.id,
    filters: req.query,
  });
  return sendSuccess(res, req.schoolId, list);
}));

router.post('/:id/registrations/:regId/cancel', requireAuth, asyncHandler(async (req, res) => {
  const result = await EventRegistrationService.cancelRegistration({
    schoolId: req.schoolId,
    eventId: req.params.id,
    registrationId: req.params.regId,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, result);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 6. DIGITAL PARENT CONSENT
// ─────────────────────────────────────────────────────────────────────────────

router.post('/:id/consent', requireAuth, asyncHandler(async (req, res) => {
  const { student_id, studentId, parent_id, status, acknowledgements, remarks } = req.body;
  const consent = await EventConsentService.submitParentConsent({
    schoolId: req.schoolId,
    eventId: req.params.id,
    studentId: student_id || studentId,
    parentId: parent_id,
    status,
    acknowledgements: acknowledgements || {},
    remarks,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'] || null,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, { message: 'Parent consent recorded', consent });
}));

router.get('/:id/consent', requireAuth, asyncHandler(async (req, res) => {
  const summary = await EventConsentService.getConsentSummary({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, summary);
}));

router.get('/:id/consent/roster', requireAuth, asyncHandler(async (req, res) => {
  const roster = await EventConsentService.listConsentRoster({
    schoolId: req.schoolId,
    eventId: req.params.id,
    filter: req.query.filter,
  });
  return sendSuccess(res, req.schoolId, roster);
}));

router.get('/:id/consent-summary', requireAuth, asyncHandler(async (req, res) => {
  const summary = await EventConsentService.getConsentSummary({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, summary);
}));

router.get('/:id/consent-roster', requireAuth, asyncHandler(async (req, res) => {
  const roster = await EventConsentService.listConsentRoster({
    schoolId: req.schoolId,
    eventId: req.params.id,
    filter: req.query.filter,
  });
  return sendSuccess(res, req.schoolId, roster);
}));

router.post('/:id/consent/remind', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const result = await EventConsentService.sendConsentReminders({
    schoolId: req.schoolId,
    eventId: req.params.id,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, { message: `Reminders sent to ${result.sent_count} parents`, ...result });
}));

// ─────────────────────────────────────────────────────────────────────────────
// 7. QR EVENT PASSES
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/passes', requireAuth, asyncHandler(async (req, res) => {
  const passes = await EventPassService.listPasses({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, passes);
}));

router.post('/:id/passes/bulk-issue', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const result = await EventPassService.bulkIssueForEvent({
    schoolId: req.schoolId,
    eventId: req.params.id,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, result);
}));

router.get('/:id/passes/my-pass', requireAuth, asyncHandler(async (req, res) => {
  const pass = await EventPassService.getMyPass({
    schoolId: req.schoolId,
    eventId: req.params.id,
    studentId: req.query.student_id || null,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, pass);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 8. MULTI-METHOD ATTENDANCE
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/attendance', requireAuth, asyncHandler(async (req, res) => {
  const dashboard = await EventAttendanceService.getAttendanceDashboard({
    schoolId: req.schoolId,
    eventId: req.params.id,
    classId: req.query.class_id,
    sectionId: req.query.section_id,
  });
  return sendSuccess(res, req.schoolId, dashboard);
}));

router.post('/:id/attendance/mark', requireAuth, asyncHandler(async (req, res) => {
  const studentId = pickField(req.body, 'student_id', 'studentId');
  const result = await EventAttendanceService.markAttendance({
    schoolId: req.schoolId,
    eventId: req.params.id,
    studentId,
    status: req.body.status,
    notes: req.body.notes,
    busId: pickField(req.body, 'bus_id', 'busId'),
    markedBy: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, result);
}));

router.post('/:id/attendance', requireAuth, asyncHandler(async (req, res) => {
  const result = await EventAttendanceService.markAttendance({
    schoolId: req.schoolId,
    eventId: req.params.id,
    studentId: pickField(req.body, 'student_id', 'studentId'),
    status: req.body.status,
    notes: req.body.notes,
    busId: pickField(req.body, 'bus_id', 'busId'),
    markedBy: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, result);
}));

router.post('/:id/attendance/bulk-mark', requireAuth, asyncHandler(async (req, res) => {
  const { records } = req.body;
  const result = await EventAttendanceService.bulkMarkAttendance({
    schoolId: req.schoolId,
    eventId: req.params.id,
    records: records || [],
    markedBy: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, result);
}));

router.get('/:id/attendance/missing', requireAuth, asyncHandler(async (req, res) => {
  const missing = await EventAttendanceService.getMissingAttendees({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, missing);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 9. TEAMS & TASKS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/teams', requireAuth, asyncHandler(async (req, res) => {
  const teams = await EventTeamTaskService.listTeams({ schoolId: req.schoolId, eventId: req.params.id });
  return sendSuccess(res, req.schoolId, teams);
}));

router.post('/:id/teams', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const team = await EventTeamTaskService.createTeam({
    schoolId: req.schoolId,
    eventId: req.params.id,
    ...req.body,
  });
  return sendSuccess(res, req.schoolId, team, 201);
}));

router.post('/:id/teams/:teamId/members', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const member = await EventTeamTaskService.addTeamMember({
    schoolId: req.schoolId,
    teamId: req.params.teamId,
    eventId: req.params.id,
    ...req.body,
  });
  return sendSuccess(res, req.schoolId, member, 201);
}));

router.delete('/:id/teams/members/:memberId', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  await EventTeamTaskService.removeTeamMember({ schoolId: req.schoolId, memberId: req.params.memberId });
  return sendSuccess(res, req.schoolId, { success: true });
}));

router.get('/:id/tasks', requireAuth, asyncHandler(async (req, res) => {
  const tasks = await EventTeamTaskService.listTasks({
    schoolId: req.schoolId,
    eventId: req.params.id,
    filters: req.query,
  });
  return sendSuccess(res, req.schoolId, tasks);
}));

router.post('/:id/tasks', requireAuth, asyncHandler(async (req, res) => {
  const task = await EventTeamTaskService.createTask({
    schoolId: req.schoolId,
    eventId: req.params.id,
    data: req.body,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, task, 201);
}));

router.patch('/:id/tasks/:taskId', requireAuth, asyncHandler(async (req, res) => {
  const updated = await EventTeamTaskService.updateTask({
    schoolId: req.schoolId,
    eventId: req.params.id,
    taskId: req.params.taskId,
    data: req.body,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, updated);
}));

router.delete('/:id/tasks/:taskId', requireAuth, asyncHandler(async (req, res) => {
  const result = await EventTeamTaskService.deleteTask({
    schoolId: req.schoolId,
    eventId: req.params.id,
    taskId: req.params.taskId,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, result);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 10. TRANSPORT & BUS MANIFESTS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/transport', requireAuth, asyncHandler(async (req, res) => {
  const assignments = await EventTransportService.listTransportAssignments({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, assignments);
}));

router.post('/:id/transport/assign-bus', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const assignment = await EventTransportService.assignBusToEvent({
    schoolId: req.schoolId,
    eventId: req.params.id,
    ...req.body,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, assignment, 201);
}));

router.get('/:id/transport/manifest/:assignmentId', requireAuth, asyncHandler(async (req, res) => {
  const manifest = await EventTransportService.getBusManifest({
    schoolId: req.schoolId,
    assignmentId: req.params.assignmentId,
  });
  return sendSuccess(res, req.schoolId, manifest);
}));

router.post('/:id/transport/manifest', requireAuth, asyncHandler(async (req, res) => {
  const manifest = await EventTransportService.addStudentToBusManifest({
    schoolId: req.schoolId,
    eventId: req.params.id,
    ...req.body,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, manifest, 201);
}));

router.patch('/:id/transport/manifest/:manifestId', requireAuth, asyncHandler(async (req, res) => {
  const updated = await EventTransportService.updateBoardingStatus({
    schoolId: req.schoolId,
    manifestId: req.params.manifestId,
    boardingStatus: pickField(req.body, 'boarding_status', 'boardingStatus'),
    markedBy: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, updated);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 11. BUDGET & EXPENSES
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/budget', requireAuth, asyncHandler(async (req, res) => {
  const budget = await EventBudgetExpenseService.getBudgetSummary({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, budget);
}));

router.post('/:id/budget', requireAuth, requireAnyPermission(['events.manage', 'admin.manage', 'accounts.manage']), asyncHandler(async (req, res) => {
  const summary = await EventBudgetExpenseService.setBudget({
    schoolId: req.schoolId,
    eventId: req.params.id,
    categoryBudgets: req.body.category_budgets || (req.body.category ? [{
      category: req.body.category,
      description: req.body.itemName || req.body.item_name,
      proposed_amount: req.body.estimatedCost || req.body.estimated_cost || 0,
      approved_amount: req.body.approvedCost || req.body.approved_cost || req.body.estimatedCost || 0,
    }] : []),
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, summary);
}));

router.get('/:id/expenses', requireAuth, asyncHandler(async (req, res) => {
  const expenses = await EventBudgetExpenseService.listExpenses({
    schoolId: req.schoolId,
    eventId: req.params.id,
    status: req.query.status,
  });
  return sendSuccess(res, req.schoolId, expenses);
}));

router.post('/:id/expenses', requireAuth, asyncHandler(async (req, res) => {
  const expense = await EventBudgetExpenseService.recordExpense({
    schoolId: req.schoolId,
    eventId: req.params.id,
    data: req.body,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, expense, 201);
}));

router.post('/:id/expenses/:expenseId/decide', requireAuth, requireAnyPermission(['admin.manage', 'accounts.manage']), asyncHandler(async (req, res) => {
  const updated = await EventBudgetExpenseService.decideExpenseApproval({
    schoolId: req.schoolId,
    expenseId: req.params.expenseId,
    decision: req.body.decision,
    approverUserId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, updated);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 12. VENDORS & QUOTATIONS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/vendors', requireAuth, asyncHandler(async (req, res) => {
  const vendors = await EventVendorService.listVendors({
    schoolId: req.schoolId,
    eventId: req.params.id,
    serviceType: req.query.service_type,
  });
  return sendSuccess(res, req.schoolId, vendors);
}));

router.post('/:id/vendors', requireAuth, asyncHandler(async (req, res) => {
  const vendor = await EventVendorService.addVendorQuotation({
    schoolId: req.schoolId,
    eventId: req.params.id,
    data: req.body,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, vendor, 201);
}));

router.get('/:id/vendors/compare', requireAuth, asyncHandler(async (req, res) => {
  const comparisons = await EventVendorService.compareQuotations({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, comparisons);
}));

router.post('/:id/vendors/:vendorId/approve', requireAuth, requireAnyPermission(['admin.manage', 'events.manage']), asyncHandler(async (req, res) => {
  const approved = await EventVendorService.approveVendor({
    schoolId: req.schoolId,
    eventId: req.params.id,
    vendorId: req.params.vendorId,
    finalContractAmount: req.body.final_contract_amount,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, approved);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 13. PAYMENTS & COLLECTIONS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/payments', requireAuth, asyncHandler(async (req, res) => {
  const payments = await EventPaymentService.listPayments({
    schoolId: req.schoolId,
    eventId: req.params.id,
    status: req.query.status,
  });
  return sendSuccess(res, req.schoolId, payments);
}));

router.post('/:id/payments', requireAuth, asyncHandler(async (req, res) => {
  const payment = await EventPaymentService.recordPayment({
    schoolId: req.schoolId,
    eventId: req.params.id,
    ...req.body,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, payment, 201);
}));

router.post('/:id/payments/waive', requireAuth, requireAnyPermission(['admin.manage', 'accounts.manage']), asyncHandler(async (req, res) => {
  const waived = await EventPaymentService.waivePayment({
    schoolId: req.schoolId,
    eventId: req.params.id,
    studentId: req.body.student_id,
    registrationId: req.body.registration_id,
    reason: req.body.reason,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, waived);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 14. COMPETITIONS & HOUSE POINTS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/competitions', requireAuth, asyncHandler(async (req, res) => {
  const comps = await EventCompetitionService.listCompetitions({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, comps);
}));

router.post('/:id/competitions', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const comp = await EventCompetitionService.createCompetition({
    schoolId: req.schoolId,
    eventId: req.params.id,
    data: req.body,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, comp, 201);
}));

router.post('/:id/competitions/:compId/scores', requireAuth, asyncHandler(async (req, res) => {
  const score = await EventCompetitionService.recordScore({
    schoolId: req.schoolId,
    competitionId: req.params.compId,
    judgeUserId: req.user?.internal_id || req.user?.id,
    ...req.body,
  });
  return sendSuccess(res, req.schoolId, score, 201);
}));

router.post('/:id/competitions/:compId/finalize', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const results = await EventCompetitionService.finalizeResults({
    schoolId: req.schoolId,
    competitionId: req.params.compId,
    rankings: req.body.rankings || [],
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, results);
}));

router.get('/:id/house-leaderboard', requireAuth, asyncHandler(async (req, res) => {
  const leaderboard = await EventCompetitionService.getHouseLeaderboard({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, leaderboard);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 15. DIGITAL CERTIFICATES
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/certificates', requireAuth, asyncHandler(async (req, res) => {
  const certs = await EventCertificateService.listCertificates({
    schoolId: req.schoolId,
    eventId: req.params.id,
    studentId: req.query.student_id,
  });
  return sendSuccess(res, req.schoolId, certs);
}));

router.post('/:id/certificates/generate-bulk', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const result = await EventCertificateService.bulkGenerateParticipationCertificates({
    schoolId: req.schoolId,
    eventId: req.params.id,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, result);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 16. SAFETY & INCIDENT REPORTING
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/incidents', requireAuth, asyncHandler(async (req, res) => {
  const incidents = await EventIncidentService.listIncidents({
    schoolId: req.schoolId,
    eventId: req.params.id,
    isResolved: req.query.is_resolved !== undefined ? req.query.is_resolved === 'true' : null,
  });
  return sendSuccess(res, req.schoolId, incidents);
}));

router.post('/:id/incidents', requireAuth, asyncHandler(async (req, res) => {
  const incident = await EventIncidentService.reportIncident({
    schoolId: req.schoolId,
    eventId: req.params.id,
    ...req.body,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, incident, 201);
}));

router.patch('/:id/incidents/:incId/resolve', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const resolved = await EventIncidentService.resolveIncident({
    schoolId: req.schoolId,
    incidentId: req.params.incId,
    resolutionNotes: req.body.resolution_notes,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, resolved);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 17. FEEDBACK & SURVEYS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/feedback/form', requireAuth, asyncHandler(async (req, res) => {
  const form = await EventFeedbackService.getOrCreateForm({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, form);
}));

router.post('/:id/feedback', requireAuth, asyncHandler(async (req, res) => {
  let formId = pickField(req.body, 'form_id', 'formId');
  if (!formId) {
    const form = await EventFeedbackService.getOrCreateForm({
      schoolId: req.schoolId,
      eventId: req.params.id,
    });
    formId = form.id;
  }
  const response = await EventFeedbackService.submitFeedback({
    schoolId: req.schoolId,
    eventId: req.params.id,
    formId,
    userId: req.user?.internal_id || req.user?.id,
    responderRole: pickField(req.body, 'responder_role', 'responderRole') || 'PARENT',
    answers: req.body.answers || req.body.responses || { comments: req.body.comments },
    ratingScore: pickField(req.body, 'rating_score', 'overallRating', 'overall_rating'),
    overallRating: req.body.overallRating,
  });
  return sendSuccess(res, req.schoolId, response, 201);
}));

router.get('/:id/feedback/analytics', requireAuth, asyncHandler(async (req, res) => {
  const summary = await EventFeedbackService.getFeedbackSummary({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, summary);
}));

router.get('/:id/feedback', requireAuth, asyncHandler(async (req, res) => {
  const summary = await EventFeedbackService.getFeedbackSummary({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, summary);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 18. EVENT CLOSURE & EXECUTIVE FINAL REPORT
// ─────────────────────────────────────────────────────────────────────────────

router.get('/:id/closure-checklist', requireAuth, asyncHandler(async (req, res) => {
  const checklist = await EventReportService.getClosureChecklist({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, checklist);
}));

router.patch('/:id/closure-checklist/:itemKey', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const updated = await EventReportService.updateClosureItem({
    schoolId: req.schoolId,
    eventId: req.params.id,
    itemKey: req.params.itemKey,
    isCompleted: req.body.is_completed,
    notes: req.body.notes,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, updated);
}));

router.post('/:id/close', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const closed = await EventReportService.closeEvent({
    schoolId: req.schoolId,
    eventId: req.params.id,
    userId: req.user?.internal_id || req.user?.id,
    bypassIncomplete: req.body.bypass_incomplete === true,
  });
  return sendSuccess(res, req.schoolId, { message: 'Event successfully closed', event: closed });
}));

router.get('/:id/report', requireAuth, asyncHandler(async (req, res) => {
  const report = await EventReportService.getFinalReport({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, report);
}));

router.post('/:id/report', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const report = await EventReportService.compileFinalReport({
    schoolId: req.schoolId,
    eventId: req.params.id,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, report);
}));

router.post('/:id/payments/:paymentId/refund', requireAuth, requireAnyPermission(['admin.manage', 'accounts.manage']), asyncHandler(async (req, res) => {
  const refunded = await EventPaymentService.refundPayment({
    schoolId: req.schoolId,
    paymentId: req.params.paymentId,
    reason: req.body.reason,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, refunded);
}));

router.post('/:id/certificates/issue', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const cert = await EventCertificateService.issueCertificate({
    schoolId: req.schoolId,
    eventId: req.params.id,
    recipientType: pickField(req.body, 'recipientType', 'recipient_type') || 'STUDENT',
    studentId: pickField(req.body, 'studentId', 'student_id'),
    recipientName: pickField(req.body, 'recipientName', 'recipient_name'),
    certificateType: pickField(req.body, 'templateCode', 'certificate_type') || 'PARTICIPATION',
    competitionTitle: pickField(req.body, 'certificateTitle', 'competition_title'),
  });
  return sendSuccess(res, req.schoolId, cert, 201);
}));

router.patch('/:id/tasks/:taskId/status', requireAuth, asyncHandler(async (req, res) => {
  const updated = await EventTeamTaskService.updateTask({
    schoolId: req.schoolId,
    eventId: req.params.id,
    taskId: req.params.taskId,
    data: { status: req.body.status },
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, updated);
}));

router.get('/:id/gallery', requireAuth, asyncHandler(async (req, res) => {
  const media = await EventMediaService.listMedia({
    schoolId: req.schoolId,
    eventId: req.params.id,
    album: req.query.album,
  });
  return sendSuccess(res, req.schoolId, media);
}));

router.post('/:id/gallery', requireAuth, asyncHandler(async (req, res) => {
  const media = await EventMediaService.addMedia({
    schoolId: req.schoolId,
    eventId: req.params.id,
    data: req.body,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, media, 201);
}));

router.get('/:id/documents', requireAuth, asyncHandler(async (req, res) => {
  const docs = await EventMediaService.listDocuments({
    schoolId: req.schoolId,
    eventId: req.params.id,
  });
  return sendSuccess(res, req.schoolId, docs);
}));

router.post('/:id/documents', requireAuth, asyncHandler(async (req, res) => {
  const doc = await EventMediaService.addDocument({
    schoolId: req.schoolId,
    eventId: req.params.id,
    data: req.body,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, doc, 201);
}));

router.get('/:id/volunteers', requireAuth, asyncHandler(async (req, res) => {
  const rows = await EventVolunteerService.list({
    schoolId: req.schoolId,
    eventId: req.params.id,
    status: req.query.status,
  });
  return sendSuccess(res, req.schoolId, rows);
}));

router.post('/:id/volunteers', requireAuth, asyncHandler(async (req, res) => {
  const row = await EventVolunteerService.apply({
    schoolId: req.schoolId,
    eventId: req.params.id,
    data: req.body,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, row, 201);
}));

router.post('/:id/volunteers/:volunteerId/decide', requireAuth, requireAnyPermission(['events.manage', 'admin.manage']), asyncHandler(async (req, res) => {
  const row = await EventVolunteerService.decide({
    schoolId: req.schoolId,
    volunteerId: req.params.volunteerId,
    status: req.body.status,
    shiftNotes: req.body.shift_notes || req.body.shiftNotes,
    userId: req.user?.internal_id || req.user?.id,
  });
  return sendSuccess(res, req.schoolId, row);
}));

export default router;