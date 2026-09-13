import express from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  createSupportTicket,
  addTicketMessage,
  updateTicketStatus,
  getTicketDetails,
  listSupportTickets,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
} from '../services/supportTicketService.js';

const router = express.Router();

function requireParentAccount(req, res, next) {
  const roles = (req.user?.roles || []).map((role) => String(role).toLowerCase());
  if (!roles.some((role) => ['parent', 'guardian'].includes(role))) {
    return res.status(403).json({ error: 'A parent or guardian account is required' });
  }
  return next();
}

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
 * POST /api/v1/support/tickets
 * Parents open a support ticket.
 */
router.post('/tickets', requireAuth, requireParentAccount, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const parentUserId = req.user.internal_id;
  const { category, subject, initial_message, student_id, attachments, priority } = req.body || {};

  if (!subject || !initial_message) {
    return res.status(400).json({ error: 'subject and initial_message are required' });
  }
  if (Array.isArray(attachments) && attachments.length) {
    return res.status(400).json({ error: 'Attachments require the authenticated upload flow, which is not enabled for support tickets' });
  }

  const result = await createSupportTicket({
    schoolId,
    parentUserId,
    studentId: student_id || null,
    category: category || TICKET_CATEGORIES.OTHER,
    subject,
    initialMessage: initial_message,
    attachments: attachments || [],
    priority: priority || TICKET_PRIORITIES.NORMAL,
  });

  return sendSuccess(res, schoolId, result, 201);
}));

/**
 * GET /api/v1/support/tickets/my
 * Parents list their own tickets.
 */
router.get('/tickets/my', requireAuth, requireParentAccount, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const parentUserId = req.user.internal_id;
  const { status, limit = 50, page = 1 } = req.query;

  const result = await listSupportTickets(schoolId, {
    parentUserId,
    status,
    limit,
    page,
  });

  return sendSuccess(res, schoolId, result);
}));

/**
 * GET /api/v1/support/tickets
 * Staff list all school support tickets.
 */
router.get('/tickets', requirePermission('support.view'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { category, status, priority, search, limit = 50, page = 1 } = req.query;

  const result = await listSupportTickets(schoolId, {
    category,
    status,
    priority,
    search,
    limit,
    page,
  });

  return sendSuccess(res, schoolId, result);
}));

/**
 * GET /api/v1/support/tickets/:id
 * View ticket details + threaded messages.
 */
router.get('/tickets/:id', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const ticketId = req.params.id;
  const isStaff = Boolean(
    req.user.permissions?.includes('support.view') ||
    req.user.permissions?.includes('support.manage') ||
    req.user.roles?.includes('admin')
  );

  const ticket = await getTicketDetails(schoolId, ticketId, { isStaff });
  if (!ticket) {
    return res.status(404).json({ error: 'Support ticket not found' });
  }

  // Non-staff parents can ONLY view their own tickets
  if (!isStaff && ticket.parent_user_id !== req.user.internal_id) {
    return res.status(403).json({ error: 'Unauthorized to view this ticket' });
  }

  return sendSuccess(res, schoolId, ticket);
}));

/**
 * POST /api/v1/support/tickets/:id/messages
 * Post reply or internal staff note.
 */
router.post('/tickets/:id/messages', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const ticketId = req.params.id;
  const senderUserId = req.user.internal_id;
  const { message, is_internal_note, attachments } = req.body || {};

  if (!message || String(message).trim() === '') {
    return res.status(400).json({ error: 'message content is required' });
  }
  if (Array.isArray(attachments) && attachments.length) {
    return res.status(400).json({ error: 'Attachments require the authenticated upload flow, which is not enabled for support tickets' });
  }

  const isStaff = Boolean(
    req.user.permissions?.includes('support.manage') ||
    req.user.permissions?.includes('support.view') ||
    req.user.roles?.includes('admin')
  );

  try {
    const newMsg = await addTicketMessage({
      schoolId,
      ticketId,
      senderUserId,
      message,
      isInternalNote: isStaff ? Boolean(is_internal_note) : false,
      attachments: attachments || [],
      isStaff,
    });

    return sendSuccess(res, schoolId, newMsg, 201);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    throw err;
  }
}));

/**
 * PATCH /api/v1/support/tickets/:id/status
 * Staff update ticket status, assign staff, or change priority.
 */
router.patch('/tickets/:id/status', requirePermission('support.manage'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const ticketId = req.params.id;
  const { status, assigned_staff_id, priority } = req.body || {};

  if (!status) {
    return res.status(400).json({ error: 'status is required' });
  }

  const updated = await updateTicketStatus({
    schoolId,
    ticketId,
    status,
    assignedStaffId: assigned_staff_id,
    priority,
    actorUserId: req.user.internal_id,
  });

  if (!updated) {
    return res.status(404).json({ error: 'Support ticket not found' });
  }

  return sendSuccess(res, schoolId, updated);
}));

export default router;
