import sql from '../db.js';
import logger from '../utils/logger.js';
import { emitSchoolEvent as publishAutomationEvent, AUTOMATION_EVENTS } from './automationEventService.js';
import { sendNotificationToUsers } from './notificationService.js';

export const TICKET_CATEGORIES = {
  FEES: 'fees',
  TRANSPORT: 'transport',
  ACADEMICS: 'academics',
  FACILITIES: 'facilities',
  OTHER: 'other',
};

export const TICKET_STATUSES = {
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  WAITING_ON_PARENT: 'waiting_for_parent',
  WAITING_FOR_PARENT: 'waiting_for_parent',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
};

export const TICKET_PRIORITIES = {
  LOW: 'low',
  NORMAL: 'medium',
  MEDIUM: 'medium',
  HIGH: 'high',
  URGENT: 'urgent',
};

/**
 * Sanitize and validate uploaded attachment references.
 */
export function sanitizeAttachments(attachments = []) {
  // No authenticated upload/storage ownership verifier exists for help-desk
  // files yet. Never persist client-asserted URLs, MIME types, or sizes.
  return [];
}

/**
 * Resolve staff user IDs based on category with fallback to school administration.
 */
export async function resolveCategoryStaffUserIds(schoolId, category, studentId = null, db = sql) {
  let permissionCode = 'school.manage';
  if (category === 'fees') permissionCode = 'fees.manage';
  else if (category === 'transport') permissionCode = 'transport.manage';
  else if (category === 'academics') permissionCode = 'academics.manage';

  const rows = await db`
    SELECT DISTINCT u.id AS user_id
    FROM users u
    JOIN user_roles ur ON ur.user_id = u.id AND ur.school_id = ${schoolId}
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE u.school_id = ${schoolId}
      AND u.account_status = 'active'
      AND u.deleted_at IS NULL
      AND (p.code = ${permissionCode} OR p.code = 'support.manage')
  `;

  const userIds = rows.map(r => r.user_id);

  // If studentId provided and category is academics, also add class teacher
  if (studentId && category === 'academics') {
    const [classTeacher] = await db`
      SELECT u.id AS user_id
      FROM students s
      JOIN student_enrollments se ON se.student_id = s.id AND se.status = 'active'
      JOIN class_sections cs ON cs.id = se.class_section_id
      JOIN staff st ON st.id = cs.class_teacher_id AND st.school_id = ${schoolId}
      JOIN users u ON u.person_id = st.person_id AND u.school_id = ${schoolId}
      WHERE s.id = ${studentId} AND s.school_id = ${schoolId}
        AND u.account_status = 'active'
      LIMIT 1
    `;
    if (classTeacher?.user_id && !userIds.includes(classTeacher.user_id)) {
      userIds.push(classTeacher.user_id);
    }
  }

  // Fallback: If no specialized staff match, route to users with school.manage or admin role
  if (userIds.length === 0) {
    const fallbackRows = await db`
      SELECT DISTINCT u.id AS user_id
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id AND ur.school_id = ${schoolId}
      JOIN roles r ON r.id = ur.role_id
      WHERE u.school_id = ${schoolId}
        AND u.account_status = 'active'
        AND u.deleted_at IS NULL
        AND (r.code = 'admin' OR r.code = 'principal')
    `;
    return fallbackRows.map(r => r.user_id);
  }

  return userIds;
}

/**
 * Resolve or ensure parents.id for a user in a school.
 */
async function resolveParentRecordId(schoolId, parentUserId, db = sql) {
  // Check if a parent record already exists for this user's person
  const [existing] = await db`
    SELECT p.id
    FROM parents p
    JOIN users u ON u.person_id = p.person_id
    WHERE u.id = ${parentUserId} AND p.school_id = ${schoolId} AND p.deleted_at IS NULL
    LIMIT 1
  `;
  if (existing?.id) return existing.id;

  // Retrieve person_id for user to link or create parent profile
  const [user] = await db`
    SELECT person_id FROM users WHERE id = ${parentUserId} AND school_id = ${schoolId}
  `;
  if (!user?.person_id) {
    throw new Error('User does not have an associated person profile');
  }

  const [created] = await db`
    INSERT INTO parents (school_id, person_id)
    VALUES (${schoolId}, ${user.person_id})
    ON CONFLICT (school_id, person_id) WHERE deleted_at IS NULL DO UPDATE SET updated_at = now()
    RETURNING id
  `;
  return created.id;
}

/**
 * Create a new support ticket atomically.
 */
export async function createSupportTicket({
  schoolId,
  parentUserId,
  studentId = null,
  category = TICKET_CATEGORIES.OTHER,
  subject,
  initialMessage,
  attachments = [],
  priority = 'medium',
  db = sql,
}) {
  if (!schoolId || !parentUserId || !subject || !initialMessage) {
    throw new Error('schoolId, parentUserId, subject, and initialMessage are required');
  }

  const safeCategory = Object.values(TICKET_CATEGORIES).includes(category)
    ? category
    : TICKET_CATEGORIES.OTHER;

  const normalizedPriority = priority === 'normal' ? 'medium' : priority;
  const safePriority = ['low', 'medium', 'high', 'urgent'].includes(normalizedPriority)
    ? normalizedPriority
    : 'medium';

  // 1. Resolve parent_id from parentUserId
  const parentId = await resolveParentRecordId(schoolId, parentUserId, db);

  // 2. Anti-forgery: Validate student relationship if provided
  if (studentId) {
    const [linked] = await db`
      SELECT 1
      FROM student_parents sp
      WHERE sp.school_id = ${schoolId}
        AND sp.parent_id = ${parentId}
        AND sp.student_id = ${studentId}
        AND sp.deleted_at IS NULL
    `;
    if (!linked) {
      // Also allow if user is a student themselves
      const [ownStudent] = await db`
        SELECT 1
        FROM students s
        JOIN users u ON u.person_id = s.person_id
        WHERE u.id = ${parentUserId} AND s.id = ${studentId} AND s.school_id = ${schoolId}
      `;
      if (!ownStudent) {
        const error = new Error('Unauthorized: Student is not linked to your parent account');
        error.status = 403;
        throw error;
      }
    }
  }

  const safeAttachments = sanitizeAttachments(attachments);

  const result = await db.begin(async tx => {
    // Generate atomic ticket number
    const [numRow] = await tx`SELECT public.get_next_ticket_number(${schoolId}) AS ticket_number`;
    const ticketNumber = numRow?.ticket_number;

    // Create ticket in database
    const [ticket] = await tx`
      INSERT INTO support_tickets (
        school_id, ticket_number, created_by, parent_id, student_id,
        category, subject, description, status, priority
      ) VALUES (
        ${schoolId}, ${ticketNumber}, ${parentUserId}, ${parentId}, ${studentId},
        ${safeCategory}, ${subject.trim()}, ${initialMessage.trim()},
        'open', ${safePriority}
      )
      RETURNING *
    `;

    // Create initial message
    const [msg] = await tx`
      INSERT INTO support_ticket_messages (
        school_id, ticket_id, sender_id, sender_role, message,
        is_internal, attachments
      ) VALUES (
        ${schoolId}, ${ticket.id}, ${parentUserId}, 'parent', ${initialMessage.trim()},
        false, ${tx.json(safeAttachments)}
      )
      RETURNING *
    `;

    return {
      ticket: {
        ...ticket,
        parent_user_id: ticket.created_by,
      },
      message: {
        ...msg,
        sender_user_id: msg.sender_id,
        is_internal_note: msg.is_internal,
      },
    };
  });

  // Emit event & notifications asynchronously
  publishAutomationEvent(AUTOMATION_EVENTS.SUPPORT_TICKET_CREATED, {
    schoolId,
    ticketId: result.ticket.id,
    ticketNumber: result.ticket.ticket_number,
    category: safeCategory,
    subject,
  });

  // Notify relevant staff
  const staffRecipients = await resolveCategoryStaffUserIds(schoolId, safeCategory, studentId, db);
  if (staffRecipients.length > 0) {
    await sendNotificationToUsers(
      staffRecipients,
      'SUPPORT_TICKET_CREATED',
      {
        ticketNumber: result.ticket.ticket_number,
        category: safeCategory.toUpperCase(),
        subject: subject.slice(0, 50),
      },
      {
        schoolId,
        deepLink: '/admin/helpdesk',
      }
    ).catch(e => logger.warn({ err: e.message }, 'Failed to notify staff of ticket creation'));
  }

  return result;
}

/**
 * Add message to a support ticket thread.
 */
export async function addTicketMessage({
  schoolId,
  ticketId,
  senderUserId,
  message,
  isInternalNote = false,
  attachments = [],
  isStaff = false,
  db = sql,
}) {
  if (!schoolId || !ticketId || !senderUserId || !message) {
    throw new Error('Missing required message parameters');
  }

  const [ticket] = await db`
    SELECT * FROM support_tickets
    WHERE id = ${ticketId} AND school_id = ${schoolId}
  `;

  if (!ticket) {
    const error = new Error('Support ticket not found');
    error.status = 404;
    throw error;
  }

  // Reject replying to a closed ticket
  if (ticket.status === 'closed') {
    const error = new Error('This ticket has been closed. Please open a new support ticket.');
    error.status = 400;
    throw error;
  }

  // Non-staff must own the ticket and cannot post internal notes
  if (!isStaff) {
    if (ticket.created_by !== senderUserId) {
      const error = new Error('Unauthorized to post to this support ticket');
      error.status = 403;
      throw error;
    }
    isInternalNote = false;
  }

  const safeAttachments = sanitizeAttachments(attachments);
  const senderRole = isStaff ? 'staff' : 'parent';

  const [newMessage] = await db`
    INSERT INTO support_ticket_messages (
      school_id, ticket_id, sender_id, sender_role, message,
      is_internal, attachments
    ) VALUES (
      ${schoolId}, ${ticketId}, ${senderUserId}, ${senderRole}, ${message.trim()},
      ${Boolean(isInternalNote)}, ${db.json(safeAttachments)}
    )
    RETURNING *
  `;

  // Update ticket lifecycle status:
  // If parent replies: reopen/progress ticket ('in_progress') and clear resolved_at
  // If staff replies publicly, the ticket waits for the parent's response.
  if (!isInternalNote) {
    const nextStatus = isStaff ? 'waiting_for_parent' : 'in_progress';
    await db`
      UPDATE support_tickets
      SET
        status = ${nextStatus},
        resolved_at = ${nextStatus === 'in_progress' ? null : db`resolved_at`},
        resolved_by = ${nextStatus === 'in_progress' ? null : db`resolved_by`},
        updated_at = NOW()
      WHERE id = ${ticketId} AND school_id = ${schoolId}
    `;

    // Dispatch notifications
    if (isStaff) {
      // Staff responded: notify parent
      await sendNotificationToUsers(
        [ticket.created_by],
        'SUPPORT_TICKET_REPLIED',
        {
          ticketNumber: ticket.ticket_number,
          category: ticket.category.toUpperCase(),
          messageSnippet: message.slice(0, 60),
        },
        {
          schoolId,
          deepLink: '/Screen/helpdesk',
        }
      ).catch(e => logger.warn({ err: e.message }, 'Failed to notify parent of ticket reply'));
    } else {
      // Parent responded: notify staff
      const staffRecipients = await resolveCategoryStaffUserIds(schoolId, ticket.category, ticket.student_id, db);
      if (staffRecipients.length > 0) {
        await sendNotificationToUsers(
          staffRecipients,
          'SUPPORT_TICKET_REPLIED',
          {
            ticketNumber: ticket.ticket_number,
            category: ticket.category.toUpperCase(),
            messageSnippet: message.slice(0, 60),
          },
          {
            schoolId,
            deepLink: '/admin/helpdesk',
          }
        ).catch(e => logger.warn({ err: e.message }, 'Failed to notify staff of parent reply'));
      }
    }

    publishAutomationEvent(AUTOMATION_EVENTS.SUPPORT_TICKET_REPLIED, {
      schoolId,
      ticketId,
      ticketNumber: ticket.ticket_number,
      senderUserId,
    });
  }

  return {
    ...newMessage,
    sender_user_id: newMessage.sender_id,
    is_internal_note: newMessage.is_internal,
  };
}

/**
 * Update ticket status, assignment, or priority (Staff only).
 */
export async function updateTicketStatus({
  schoolId,
  ticketId,
  status,
  assignedStaffId,
  priority,
  actorUserId,
  db = sql,
}) {
  const normalizedStatus = status === 'waiting_on_parent' ? 'waiting_for_parent' : status;
  const validStatuses = ['open', 'in_progress', 'waiting_for_parent', 'resolved', 'closed'];

  if (!validStatuses.includes(normalizedStatus)) {
    throw new Error(`Invalid ticket status: ${status}`);
  }
  if (priority != null && !Object.values(TICKET_PRIORITIES).includes(priority)) {
    const error = new Error('Invalid ticket priority'); error.status = 400; throw error;
  }
  const [current] = await db`SELECT status FROM support_tickets WHERE id=${ticketId} AND school_id=${schoolId}`;
  if (!current) return null;
  const transitions = {
    open: ['in_progress', 'resolved', 'closed'],
    in_progress: ['waiting_for_parent', 'resolved', 'closed'],
    waiting_for_parent: ['in_progress', 'resolved', 'closed'],
    resolved: ['in_progress', 'closed'],
    closed: [],
  };
  if (current.status !== normalizedStatus && !transitions[current.status]?.includes(normalizedStatus)) {
    const error = new Error(`Cannot transition ticket from ${current.status} to ${normalizedStatus}`);
    error.status = 409;
    throw error;
  }
  if (assignedStaffId) {
    const [assignee] = await db`SELECT id FROM users WHERE id=${assignedStaffId} AND school_id=${schoolId}
      AND account_status='active' AND deleted_at IS NULL`;
    if (!assignee) { const error = new Error('Assigned user is not active in this school'); error.status = 400; throw error; }
  }

  const isResolved = normalizedStatus === 'resolved' || normalizedStatus === 'closed';

  const [updated] = await db`
    UPDATE support_tickets
    SET
      status = ${normalizedStatus},
      priority = COALESCE(${priority ?? null}, priority),
      assigned_to = CASE
        WHEN ${assignedStaffId !== undefined} THEN ${assignedStaffId}
        ELSE assigned_to
      END,
      resolved_at = ${isResolved ? db`NOW()` : db`NULL`},
      resolved_by = ${isResolved ? actorUserId : db`NULL`},
      closed_at = ${normalizedStatus === 'closed' ? db`NOW()` : db`closed_at`},
      updated_at = NOW()
    WHERE id = ${ticketId} AND school_id = ${schoolId} AND status=${current.status}
    RETURNING *
  `;

  if (!updated) return null;

  if (isResolved) {
    publishAutomationEvent(AUTOMATION_EVENTS.SUPPORT_TICKET_RESOLVED, {
      schoolId,
      ticketId,
      ticketNumber: updated.ticket_number,
      status: normalizedStatus,
    });

    await sendNotificationToUsers(
      [updated.created_by],
      'SUPPORT_TICKET_RESOLVED',
      {
        ticketNumber: updated.ticket_number,
        category: updated.category.toUpperCase(),
      },
      {
        schoolId,
        deepLink: '/Screen/helpdesk',
      }
    ).catch(e => logger.warn({ err: e.message }, 'Failed to notify parent of ticket resolution'));
  }

  return {
    ...updated,
    parent_user_id: updated.created_by,
  };
}

/**
 * Get ticket details with thread messages.
 * Parents NEVER see rows where is_internal = true.
 */
export async function getTicketDetails(schoolId, ticketId, { isStaff = false } = {}, db = sql) {
  const [ticket] = await db`
    SELECT
      st.id,
      st.school_id,
      st.ticket_number,
      st.created_by AS parent_user_id,
      st.parent_id,
      st.student_id,
      st.category,
      st.subject,
      st.description,
      st.priority,
      st.status,
      st.assigned_to AS assigned_staff_id,
      st.resolved_at,
      st.closed_at,
      st.created_at,
      st.updated_at,
      p_par.display_name AS parent_name,
      p_stu.display_name AS student_name,
      s.admission_no,
      c.name AS class_name,
      sec.name AS section_name,
      p_stf.display_name AS assigned_staff_name
    FROM support_tickets st
    JOIN users u_par ON u_par.id = st.created_by AND u_par.school_id=${schoolId}
    JOIN persons p_par ON p_par.id = u_par.person_id AND p_par.school_id=${schoolId}
    LEFT JOIN students s ON s.id = st.student_id AND s.school_id=${schoolId}
    LEFT JOIN persons p_stu ON p_stu.id = s.person_id AND p_stu.school_id=${schoolId}
    LEFT JOIN student_enrollments se ON se.student_id = s.id AND se.school_id=${schoolId} AND se.status = 'active'
    LEFT JOIN class_sections cs ON cs.id = se.class_section_id AND cs.school_id=${schoolId}
    LEFT JOIN classes c ON c.id = cs.class_id AND c.school_id=${schoolId}
    LEFT JOIN sections sec ON sec.id = cs.section_id AND sec.school_id=${schoolId}
    LEFT JOIN users u_stf ON u_stf.id = st.assigned_to AND u_stf.school_id=${schoolId}
    LEFT JOIN persons p_stf ON p_stf.id = u_stf.person_id AND p_stf.school_id=${schoolId}
    WHERE st.id = ${ticketId} AND st.school_id = ${schoolId}
  `;

  if (!ticket) return null;

  const messages = await db`
    SELECT
      m.id,
      m.ticket_id,
      m.sender_id AS sender_user_id,
      m.sender_role,
      m.message,
      m.is_internal AS is_internal_note,
      m.attachments,
      m.created_at,
      p.display_name AS sender_name,
      p.photo_url AS sender_photo,
      (m.sender_role IN ('staff', 'admin')) AS is_sender_staff
    FROM support_ticket_messages m
    JOIN users u ON u.id = m.sender_id AND u.school_id=${schoolId}
    JOIN persons p ON p.id = u.person_id AND p.school_id=${schoolId}
    WHERE m.ticket_id = ${ticketId}
      AND m.school_id = ${schoolId}
      ${isStaff ? db`` : db`AND m.is_internal = false`}
    ORDER BY m.created_at ASC
  `;

  return { ...ticket, messages };
}

/**
 * List tickets with filters.
 */
export async function listSupportTickets(schoolId, filters = {}, db = sql) {
  const {
    parentUserId = null,
    category = null,
    status = null,
    priority = null,
    search = null,
    limit = 50,
    page = 1,
  } = filters;

  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeLimit;

  const normalizedStatus = status === 'waiting_on_parent' ? 'waiting_for_parent' : status;

  const [countRow] = await db`
    SELECT COUNT(*)::int AS total
    FROM support_tickets st
    WHERE st.school_id = ${schoolId}
      ${parentUserId ? db`AND st.created_by = ${parentUserId}` : db``}
      ${category ? db`AND st.category = ${category}` : db``}
      ${normalizedStatus ? db`AND st.status = ${normalizedStatus}` : db``}
      ${priority ? db`AND st.priority = ${priority}` : db``}
      ${search ? db`AND (st.ticket_number ILIKE ${'%' + search + '%'} OR st.subject ILIKE ${'%' + search + '%'})` : db``}
  `;

  const rows = await db`
    SELECT
      st.id,
      st.school_id,
      st.ticket_number,
      st.created_by AS parent_user_id,
      st.parent_id,
      st.student_id,
      st.category,
      st.subject,
      st.description,
      st.priority,
      st.status,
      st.assigned_to AS assigned_staff_id,
      st.resolved_at,
      st.closed_at,
      st.created_at,
      st.updated_at,
      p_par.display_name AS parent_name,
      p_stu.display_name AS student_name,
      s.admission_no,
      c.name AS class_name,
      sec.name AS section_name,
      p_stf.display_name AS assigned_staff_name,
      (
        SELECT COUNT(*)::int
        FROM support_ticket_messages m
        WHERE m.ticket_id = st.id AND m.school_id = ${schoolId}
      ) AS message_count,
      (
        SELECT m.created_at
        FROM support_ticket_messages m
        WHERE m.ticket_id = st.id AND m.school_id = ${schoolId}
        ORDER BY m.created_at DESC
        LIMIT 1
      ) AS last_message_at
    FROM support_tickets st
    JOIN users u_par ON u_par.id = st.created_by AND u_par.school_id=${schoolId}
    JOIN persons p_par ON p_par.id = u_par.person_id AND p_par.school_id=${schoolId}
    LEFT JOIN students s ON s.id = st.student_id AND s.school_id=${schoolId}
    LEFT JOIN persons p_stu ON p_stu.id = s.person_id AND p_stu.school_id=${schoolId}
    LEFT JOIN student_enrollments se ON se.student_id = s.id AND se.school_id=${schoolId} AND se.status = 'active'
    LEFT JOIN class_sections cs ON cs.id = se.class_section_id AND cs.school_id=${schoolId}
    LEFT JOIN classes c ON c.id = cs.class_id AND c.school_id=${schoolId}
    LEFT JOIN sections sec ON sec.id = cs.section_id AND sec.school_id=${schoolId}
    LEFT JOIN users u_stf ON u_stf.id = st.assigned_to AND u_stf.school_id=${schoolId}
    LEFT JOIN persons p_stf ON p_stf.id = u_stf.person_id AND p_stf.school_id=${schoolId}
    WHERE st.school_id = ${schoolId}
      ${parentUserId ? db`AND st.created_by = ${parentUserId}` : db``}
      ${category ? db`AND st.category = ${category}` : db``}
      ${normalizedStatus ? db`AND st.status = ${normalizedStatus}` : db``}
      ${priority ? db`AND st.priority = ${priority}` : db``}
      ${search ? db`AND (st.ticket_number ILIKE ${'%' + search + '%'} OR st.subject ILIKE ${'%' + search + '%'})` : db``}
    ORDER BY st.updated_at DESC
    LIMIT ${safeLimit} OFFSET ${offset}
  `;

  return {
    tickets: rows,
    pagination: {
      total: countRow?.total || 0,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil((countRow?.total || 0) / safeLimit),
    },
  };
}
