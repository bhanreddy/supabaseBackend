import express from 'express';
import sql from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { messageSendLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── RBAC Helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the caller's effective role code from the DB (admin, teacher, parent).
 * Never trust client-supplied role.
 */
async function resolveCallerRole(req) {
  const rows = await sql`
    SELECT r.code FROM user_roles ur
    JOIN roles r ON ur.role_id = r.id
    WHERE ur.user_id = ${req.user.internal_id}
      AND ur.school_id = ${req.schoolId}
      AND r.school_id = ${req.schoolId}
      AND r.code IN ('admin', 'teacher', 'staff', 'parent', 'student')
  `;
  const codes = rows.map((r) => r.code);
  // Priority: admin > teacher/staff > parent/student
  if (codes.includes('admin')) return 'admin';
  if (codes.includes('teacher') || codes.includes('staff')) return 'teacher';
  if (codes.includes('parent') || codes.includes('student')) return 'parent';
  return null;
}

/**
 * Resolve recipient's role the same way.
 */
async function resolveUserRole(userId, schoolId) {
  const rows = await sql`
    SELECT r.code FROM user_roles ur
    JOIN roles r ON ur.role_id = r.id
    WHERE ur.user_id = ${userId}
      AND ur.school_id = ${schoolId}
      AND r.school_id = ${schoolId}
      AND r.code IN ('admin', 'teacher', 'staff', 'parent', 'student')
  `;
  const codes = rows.map((r) => r.code);
  if (codes.includes('admin')) return 'admin';
  if (codes.includes('teacher') || codes.includes('staff')) return 'teacher';
  if (codes.includes('parent') || codes.includes('student')) return 'parent';
  return null;
}

/**
 * Map two role codes to the canonical pair_type.
 */
function determinePairType(roleA, roleB) {
  const pair = [roleA, roleB].sort().join('_');
  const map = {
    'admin_parent': 'parent_admin',
    'admin_teacher': 'admin_teacher',
    'parent_teacher': 'teacher_parent',
  };
  return map[pair] || null;
}

/**
 * For teacher↔parent pair: verify the student_id genuinely belongs to the
 * parent/student account being messaged. Teachers may message ANY student in
 * their school (school-wide reach — product decision), so there is no
 * class-teacher restriction; we only ensure the student_id is not spoofed to
 * point at a different account than the recipient.
 */
async function assertTeacherParentLink(teacherUserId, parentUserId, studentId, schoolId) {
  if (!studentId) {
    return { status: 400, error: 'student_id is required for teacher↔parent conversations' };
  }

  // Verify the student_id maps to the recipient (parent/student) account.
  const [parentLink] = await sql`
    SELECT 1 FROM students s
    JOIN users u ON u.person_id = s.person_id AND u.school_id = ${schoolId}
    WHERE s.id = ${studentId}
      AND s.school_id = ${schoolId}
      AND u.id = ${parentUserId}
    LIMIT 1
  `;
  if (!parentLink) {
    return { status: 403, error: 'This student is not linked to this account' };
  }

  return null; // valid
}

/**
 * Full RBAC validation: can the caller message this recipient?
 */
async function assertCanMessage(req, recipientUserId, studentId) {
  const callerRole = await resolveCallerRole(req);
  if (!callerRole) return { status: 403, error: 'Your role does not support messaging' };

  // Verify recipient exists in same school
  const [recipient] = await sql`
    SELECT id FROM users
    WHERE id = ${recipientUserId}
      AND school_id = ${req.schoolId}
      AND account_status = 'active'
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!recipient) return { status: 404, error: 'Recipient not found' };

  const recipientRole = await resolveUserRole(recipientUserId, req.schoolId);
  if (!recipientRole) return { status: 403, error: 'Recipient role does not support messaging' };

  const pairType = determinePairType(callerRole, recipientRole);
  if (!pairType) return { status: 403, error: 'Messaging between these roles is not allowed' };

  // For teacher↔parent: enforce class-teacher constraint
  if (pairType === 'teacher_parent') {
    const teacherUserId = callerRole === 'teacher' ? req.user.internal_id : recipientUserId;
    const parentUserId = callerRole === 'parent' ? req.user.internal_id : recipientUserId;
    const err = await assertTeacherParentLink(teacherUserId, parentUserId, studentId, req.schoolId);
    if (err) return err;
  }

  return { callerRole, recipientRole, pairType };
}

// ─── Notification helper (fire-and-forget, copied from complaintsRoutes.js) ──

function queueMessageNotification(schoolId, recipientUserIds, conversationId, senderLabel, preview) {
  (async () => {
    try {
      const ids = Array.isArray(recipientUserIds) ? recipientUserIds : [recipientUserIds];
      if (ids.length === 0) return;

      const { sendNotificationToUsers } = await import('../services/notificationService.js');

      // Send only to members who have NOT muted this conversation.
      const rows = await sql`
        SELECT user_id FROM message_participants
        WHERE conversation_id = ${conversationId}
          AND school_id = ${schoolId}
          AND user_id = ANY(${ids})
          AND muted = false
      `;
      const targets = rows.map((r) => r.user_id);
      if (targets.length === 0) return;

      // Deep-link each recipient to THEIR OWN portal's messenger, so tapping the
      // notification opens a screen their role can actually access.
      const roleRows = await sql`
        SELECT ur.user_id, array_agg(r.code) AS codes
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id AND r.school_id = ${schoolId}
        WHERE ur.user_id = ANY(${targets}) AND ur.school_id = ${schoolId}
        GROUP BY ur.user_id
      `;
      const routeFor = (codes = []) => {
        if (codes.includes('admin') || codes.includes('principal')) return '/admin/messages';
        if (codes.includes('teacher') || codes.includes('staff')) return '/staff/messages';
        return '/Screen/messages'; // parent / student portal
      };

      const byRoute = {};
      for (const uid of targets) {
        const codes = roleRows.find((r) => r.user_id === uid)?.codes || [];
        const route = routeFor(codes);
        (byRoute[route] ||= []).push(uid);
      }

      for (const [route, ids2] of Object.entries(byRoute)) {
        await sendNotificationToUsers(
          ids2,
          'MESSAGE_RECEIVED',
          { message: `${senderLabel}: ${preview}` },
          { deepLink: route }
        );
      }
    } catch {
      // notification failure must not block message send
    }
  })();
}

// ─── Helper: get sender display name ──────────────────────────────────────────

async function getSenderDisplayName(userId, schoolId) {
  const [row] = await sql`
    SELECT p.display_name FROM users u
    JOIN persons p ON u.person_id = p.id
    WHERE u.id = ${userId} AND u.school_id = ${schoolId}
    LIMIT 1
  `;
  return row?.display_name || 'Someone';
}

// ─── Sort UUIDs for deduplication ─────────────────────────────────────────────

function sortUUIDs(a, b) {
  return a < b ? [a, b] : [b, a];
}

// ─── Per-school Nexsyrus Support identity ───────────────────────────────────

async function findSupportUser(schoolId) {
  const [row] = await sql`
    SELECT u.id AS user_id, p.display_name, p.photo_url
    FROM users u
    JOIN persons p ON p.id = u.person_id AND p.school_id = ${schoolId}
    WHERE u.school_id = ${schoolId}
      AND u.is_support_bot = true
      AND u.account_status = 'active'
      AND u.deleted_at IS NULL
    LIMIT 1
  `;
  return row || null;
}

async function getOrCreateSupportUser(schoolId) {
  const existing = await findSupportUser(schoolId);
  if (existing) return existing;

  try {
    return await sql.begin(async (tx) => {
      const [gender] = await tx`SELECT id FROM genders ORDER BY id LIMIT 1`;
      if (!gender) throw new Error('No gender row exists for support system user');

      const [person] = await tx`
        INSERT INTO persons (first_name, last_name, display_name, gender_id, school_id)
        VALUES ('Nexsyrus', 'Support', 'Nexsyrus Support', ${gender.id}, ${schoolId})
        RETURNING id, display_name, photo_url
      `;
      const [user] = await tx`
        INSERT INTO users (person_id, school_id, account_status, is_support_bot)
        VALUES (${person.id}, ${schoolId}, 'active', true)
        RETURNING id
      `;
      return { user_id: user.id, display_name: person.display_name, photo_url: person.photo_url };
    });
  } catch (error) {
    // A concurrent first request may win the unique partial-index race. The
    // losing transaction is rolled back (including its person row), then reads
    // the canonical support user.
    const raced = await findSupportUser(schoolId);
    if (raced) return raced;
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/support-contact', requireAuth, asyncHandler(async (req, res) => {
  const support = await getOrCreateSupportUser(req.schoolId);
  return sendSuccess(res, req.schoolId, {
    user_id: support.user_id,
    display_name: 'Nexsyrus Support',
    photo_url: support.photo_url || null,
    role: 'support',
  });
}));

/**
 * GET /eligible-recipients
 * Users the caller may start a thread with, per RBAC rules.
 */
router.get('/eligible-recipients', requireAuth, asyncHandler(async (req, res) => {
  const callerRole = await resolveCallerRole(req);
  if (!callerRole) return res.status(403).json({ error: 'Your role does not support messaging' });

  let recipients = [];

  if (callerRole === 'admin') {
    // Admin can message any teacher/staff and any parent
    recipients = await sql`
      SELECT DISTINCT u.id as user_id, p.display_name, p.photo_url, r.code as role
      FROM users u
      JOIN persons p ON u.person_id = p.id
      JOIN user_roles ur ON ur.user_id = u.id AND ur.school_id = ${req.schoolId}
      JOIN roles r ON ur.role_id = r.id AND r.school_id = ${req.schoolId}
      WHERE u.school_id = ${req.schoolId}
        AND u.account_status = 'active'
        AND u.deleted_at IS NULL
        AND u.id != ${req.user.internal_id}
        AND r.code IN ('teacher', 'staff', 'parent', 'student')
      ORDER BY p.display_name
    `;
  } else if (callerRole === 'teacher') {
    // Teacher can message admins + ANY student in the school (school-wide reach).
    const admins = await sql`
      SELECT DISTINCT u.id as user_id, p.display_name, p.photo_url, 'admin' as role, NULL::uuid as student_id, NULL as student_name
      FROM users u
      JOIN persons p ON u.person_id = p.id
      JOIN user_roles ur ON ur.user_id = u.id AND ur.school_id = ${req.schoolId}
      JOIN roles r ON ur.role_id = r.id AND r.school_id = ${req.schoolId}
      WHERE u.school_id = ${req.schoolId}
        AND u.account_status = 'active'
        AND u.deleted_at IS NULL
        AND r.code = 'admin'
        AND u.id != ${req.user.internal_id}
    `;

    const students = await sql`
      SELECT DISTINCT u.id as user_id, p.display_name, p.photo_url, 'student' as role,
             s.id as student_id, p.display_name as student_name
      FROM students s
      JOIN persons p ON s.person_id = p.id
      JOIN users u ON u.person_id = s.person_id AND u.school_id = ${req.schoolId}
        AND u.account_status = 'active' AND u.deleted_at IS NULL
      WHERE s.school_id = ${req.schoolId}
      ORDER BY p.display_name
    `;

    recipients = [...admins, ...students];
  } else if (callerRole === 'parent') {
    // Parent can message admins + their children's class teachers
    const admins = await sql`
      SELECT DISTINCT u.id as user_id, p.display_name, p.photo_url, 'admin' as role, NULL::uuid as student_id, NULL as student_name
      FROM users u
      JOIN persons p ON u.person_id = p.id
      JOIN user_roles ur ON ur.user_id = u.id AND ur.school_id = ${req.schoolId}
      JOIN roles r ON ur.role_id = r.id AND r.school_id = ${req.schoolId}
      WHERE u.school_id = ${req.schoolId}
        AND u.account_status = 'active'
        AND u.deleted_at IS NULL
        AND r.code = 'admin'
    `;

    // Teachers who actually teach the child: the class teacher PLUS every teacher
    // assigned to the child's section in the timetable (subject teachers).
    const teachers = await sql`
      SELECT DISTINCT teacher_u.id as user_id, tp.display_name, tp.photo_url, 'teacher' as role,
             s.id as student_id, sp.display_name as student_name
      FROM users parent_u
      JOIN persons sp ON parent_u.person_id = sp.id
      JOIN students s ON s.person_id = sp.id AND s.school_id = ${req.schoolId}
      JOIN student_enrollments se ON se.student_id = s.id AND se.school_id = ${req.schoolId}
        AND se.status = 'active' AND se.deleted_at IS NULL
      JOIN class_sections cs ON se.class_section_id = cs.id AND cs.school_id = ${req.schoolId}
      JOIN staff st ON st.school_id = ${req.schoolId} AND (
        st.id = cs.class_teacher_id
        OR st.id IN (
          SELECT ts.teacher_id FROM timetable_slots ts
          WHERE ts.class_section_id = cs.id
            AND ts.deleted_at IS NULL
            AND ts.teacher_id IS NOT NULL
        )
      )
      JOIN users teacher_u ON teacher_u.person_id = st.person_id AND teacher_u.school_id = ${req.schoolId}
        AND teacher_u.account_status = 'active' AND teacher_u.deleted_at IS NULL
      JOIN persons tp ON st.person_id = tp.id
      WHERE parent_u.id = ${req.user.internal_id}
      ORDER BY tp.display_name
    `;

    recipients = [...admins, ...teachers];
  }

  return sendSuccess(res, req.schoolId, recipients);
}));

/**
 * GET /conversations
 * Caller's conversation threads with unread count and preview.
 */
router.get('/conversations', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.internal_id;
  const { limit = 30, before } = req.query;
  const lim = Math.min(Math.max(parseInt(limit) || 30, 1), 100);

  // Group-aware, participant-based list. For 1:1 threads the "other" participant
  // is resolved via LATERAL; for groups it is NULL and the UI uses group_name.
  const conversations = await sql`
    SELECT
      mc.id, mc.pair_type, mc.subject, mc.student_id,
      mc.is_group, mc.group_name, mc.group_mode,
      mc.last_message_at, mc.last_message_preview, mc.created_at,
      mp.last_read_at, mp.muted, mp.is_group_admin,
      other_p.display_name as other_user_name,
      other_p.photo_url as other_user_photo,
      other_u.id as other_user_id,
      CASE WHEN mc.is_group THEN
        (SELECT COUNT(*)::int FROM message_participants gmp WHERE gmp.conversation_id = mc.id)
      ELSE NULL END as member_count,
      COALESCE(
        (SELECT COUNT(*) FROM messages m
         WHERE m.conversation_id = mc.id
           AND m.school_id = ${req.schoolId}
           AND m.sender_user_id != ${userId}
           AND m.deleted_at IS NULL
           AND (mp.last_read_at IS NULL OR m.created_at > mp.last_read_at)
        ), 0
      )::int as unread_count,
      sp.display_name as student_name
    FROM message_conversations mc
    JOIN message_participants mp ON mp.conversation_id = mc.id AND mp.user_id = ${userId}
      AND mp.school_id = ${req.schoolId}
    LEFT JOIN LATERAL (
      SELECT omp.user_id
      FROM message_participants omp
      WHERE omp.conversation_id = mc.id AND omp.user_id != ${userId}
      LIMIT 1
    ) other ON mc.is_group = false
    LEFT JOIN users other_u ON other_u.id = other.user_id
    LEFT JOIN persons other_p ON other_u.person_id = other_p.id
    LEFT JOIN students st ON mc.student_id = st.id
    LEFT JOIN persons sp ON st.person_id = sp.id
    WHERE mc.school_id = ${req.schoolId}
      AND mc.deleted_at IS NULL
      ${before ? sql`AND mc.last_message_at < ${before}` : sql``}
    ORDER BY mc.last_message_at DESC NULLS LAST, mc.created_at DESC
    LIMIT ${lim}
  `;

  return sendSuccess(res, req.schoolId, conversations);
}));

/**
 * POST /conversations
 * Find-or-create a conversation thread.
 */
router.post('/conversations', requireAuth, asyncHandler(async (req, res) => {
  const { recipient_user_id, student_id, subject } = req.body;

  if (!recipient_user_id) {
    return res.status(400).json({ error: 'recipient_user_id is required' });
  }
  if (recipient_user_id === req.user.internal_id) {
    return res.status(400).json({ error: 'Cannot message yourself' });
  }

  const support = await findSupportUser(req.schoolId);
  const isSupportRecipient = Boolean(support && support.user_id === recipient_user_id);
  let pairType;
  if (isSupportRecipient) {
    pairType = 'support';
  } else {
    const rbac = await assertCanMessage(req, recipient_user_id, student_id);
    if (rbac.status) return res.status(rbac.status).json({ error: rbac.error });
    pairType = rbac.pairType;
  }
  const [low, high] = sortUUIDs(req.user.internal_id, recipient_user_id);
  const studentIdVal = pairType === 'teacher_parent' ? student_id : null;

  // Try to find existing conversation first
  const coalesceId = '00000000-0000-0000-0000-000000000000';
  const [existing] = await sql`
    SELECT id FROM message_conversations
    WHERE school_id = ${req.schoolId}
      AND participant_low_user_id = ${low}
      AND participant_high_user_id = ${high}
      AND COALESCE(student_id, ${coalesceId}::uuid) = COALESCE(${studentIdVal}::uuid, ${coalesceId}::uuid)
      AND deleted_at IS NULL
    LIMIT 1
  `;

  if (existing) {
    // Return existing conversation with details
    const [conv] = await sql`
      SELECT mc.*, other_p.display_name as other_user_name, other_p.photo_url as other_user_photo, other_u.id as other_user_id
      FROM message_conversations mc
      JOIN message_participants other_mp ON other_mp.conversation_id = mc.id AND other_mp.user_id != ${req.user.internal_id}
      JOIN users other_u ON other_u.id = other_mp.user_id
      JOIN persons other_p ON other_u.person_id = other_p.id
      WHERE mc.id = ${existing.id} AND mc.school_id = ${req.schoolId}
    `;
    return sendSuccess(res, req.schoolId, conv);
  }

  // Create new conversation in a transaction
  const conversation = await sql.begin(async (tx) => {
    const [conv] = await tx`
      INSERT INTO message_conversations (school_id, pair_type, participant_low_user_id, participant_high_user_id, student_id, subject)
      VALUES (${req.schoolId}, ${pairType}, ${low}, ${high}, ${studentIdVal}, ${subject || null})
      RETURNING *
    `;

    // Insert both participants
    await tx`
      INSERT INTO message_participants (conversation_id, school_id, user_id)
      VALUES
        (${conv.id}, ${req.schoolId}, ${req.user.internal_id}),
        (${conv.id}, ${req.schoolId}, ${recipient_user_id})
    `;

    return conv;
  });

  // Fetch with display name for response
  const [convWithName] = await sql`
    SELECT mc.*, other_p.display_name as other_user_name, other_u.id as other_user_id
    FROM message_conversations mc
    JOIN message_participants other_mp ON other_mp.conversation_id = mc.id AND other_mp.user_id != ${req.user.internal_id}
    JOIN users other_u ON other_u.id = other_mp.user_id
    JOIN persons other_p ON other_u.person_id = other_p.id
    WHERE mc.id = ${conversation.id} AND mc.school_id = ${req.schoolId}
  `;

  return sendSuccess(res, req.schoolId, convWithName, 201);
}));

/**
 * GET /conversations/:id/messages
 * Keyset-paginated messages. ?before=ISO for older, ?since=ISO for delta sync.
 */
router.get('/conversations/:id/messages', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { before, since, limit = 30 } = req.query;
  const lim = Math.min(Math.max(parseInt(limit) || 30, 1), 100);

  // Verify caller is a participant in this conversation + same school
  const [participant] = await sql`
    SELECT 1 FROM message_participants
    WHERE conversation_id = ${id}
      AND user_id = ${req.user.internal_id}
      AND school_id = ${req.schoolId}
    LIMIT 1
  `;
  if (!participant) return res.status(403).json({ error: 'Access denied' });

  let messages;
  if (since) {
    // Delta sync includes new, edited and deleted messages so every participant
    // receives mutations without re-downloading the whole thread.
    messages = await sql`
      SELECT m.id, m.conversation_id, m.sender_user_id,
             CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body,
             m.reply_to_message_id, m.forwarded_from_message_id,
             CASE WHEN rm.deleted_at IS NULL THEN rm.body ELSE NULL END AS reply_to_body,
             rm.sender_user_id AS reply_to_sender_user_id,
             rp.display_name AS reply_to_sender_name,
             m.created_at, m.edited_at, m.deleted_at,
             p.display_name as sender_name, p.photo_url as sender_photo
      FROM messages m
      JOIN users u ON m.sender_user_id = u.id
      JOIN persons p ON u.person_id = p.id
      LEFT JOIN messages rm ON rm.id = m.reply_to_message_id
        AND rm.conversation_id = m.conversation_id
      LEFT JOIN users ru ON ru.id = rm.sender_user_id
      LEFT JOIN persons rp ON rp.id = ru.person_id
      WHERE m.conversation_id = ${id}
        AND m.school_id = ${req.schoolId}
        AND GREATEST(
          m.created_at,
          COALESCE(m.edited_at, m.created_at),
          COALESCE(m.deleted_at, m.created_at)
        ) > ${since}
      ORDER BY GREATEST(
        m.created_at,
        COALESCE(m.edited_at, m.created_at),
        COALESCE(m.deleted_at, m.created_at)
      ) ASC, m.id ASC
      LIMIT ${lim}
    `;
  } else if (before) {
    // Keyset pagination: older messages
    messages = await sql`
      SELECT m.id, m.conversation_id, m.sender_user_id,
             CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body,
             m.reply_to_message_id, m.forwarded_from_message_id,
             CASE WHEN rm.deleted_at IS NULL THEN rm.body ELSE NULL END AS reply_to_body,
             rm.sender_user_id AS reply_to_sender_user_id,
             rp.display_name AS reply_to_sender_name,
             m.created_at, m.edited_at, m.deleted_at,
             p.display_name as sender_name, p.photo_url as sender_photo
      FROM messages m
      JOIN users u ON m.sender_user_id = u.id
      JOIN persons p ON u.person_id = p.id
      LEFT JOIN messages rm ON rm.id = m.reply_to_message_id
        AND rm.conversation_id = m.conversation_id
      LEFT JOIN users ru ON ru.id = rm.sender_user_id
      LEFT JOIN persons rp ON rp.id = ru.person_id
      WHERE m.conversation_id = ${id}
        AND m.school_id = ${req.schoolId}
        AND m.created_at < ${before}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${lim}
    `;
  } else {
    // Latest messages (initial load)
    messages = await sql`
      SELECT m.id, m.conversation_id, m.sender_user_id,
             CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body,
             m.reply_to_message_id, m.forwarded_from_message_id,
             CASE WHEN rm.deleted_at IS NULL THEN rm.body ELSE NULL END AS reply_to_body,
             rm.sender_user_id AS reply_to_sender_user_id,
             rp.display_name AS reply_to_sender_name,
             m.created_at, m.edited_at, m.deleted_at,
             p.display_name as sender_name, p.photo_url as sender_photo
      FROM messages m
      JOIN users u ON m.sender_user_id = u.id
      JOIN persons p ON u.person_id = p.id
      LEFT JOIN messages rm ON rm.id = m.reply_to_message_id
        AND rm.conversation_id = m.conversation_id
      LEFT JOIN users ru ON ru.id = rm.sender_user_id
      LEFT JOIN persons rp ON rp.id = ru.person_id
      WHERE m.conversation_id = ${id}
        AND m.school_id = ${req.schoolId}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${lim}
    `;
  }

  return sendSuccess(res, req.schoolId, messages);
}));

/**
 * POST /conversations/:id/messages
 * Send a message. Rate-limited.
 */
router.post('/conversations/:id/messages', requireAuth, messageSendLimiter, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const requestedBody = typeof req.body.body === 'string' ? req.body.body : '';
  const replyToMessageId =
    typeof req.body.reply_to_message_id === 'string' && req.body.reply_to_message_id.trim()
      ? req.body.reply_to_message_id.trim()
      : null;
  const forwardedFromMessageId =
    typeof req.body.forwarded_from_message_id === 'string' && req.body.forwarded_from_message_id.trim()
      ? req.body.forwarded_from_message_id.trim()
      : null;
  // Optional client-generated id → idempotent sends (retries / offline queue /
  // double-taps all collapse to one server message).
  const clientMsgId =
    typeof req.body.client_msg_id === 'string' && req.body.client_msg_id.trim()
      ? req.body.client_msg_id.trim().slice(0, 100)
      : null;

  if (replyToMessageId && forwardedFromMessageId) {
    return res.status(400).json({ error: 'A message cannot be both a reply and a forward' });
  }
  if (
    (replyToMessageId && !UUID_PATTERN.test(replyToMessageId))
    || (forwardedFromMessageId && !UUID_PATTERN.test(forwardedFromMessageId))
  ) {
    return res.status(400).json({ error: 'Invalid referenced message id' });
  }
  if (!forwardedFromMessageId && requestedBody.trim().length === 0) {
    return res.status(400).json({ error: 'Message body is required' });
  }
  if (requestedBody.length > 4000) {
    return res.status(400).json({ error: 'Message body cannot exceed 4000 characters' });
  }

  // Load the conversation (group flags) and all participants.
  const [conv] = await sql`
    SELECT is_group, group_mode, group_name FROM message_conversations
    WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const participants = await sql`
    SELECT user_id, is_group_admin FROM message_participants
    WHERE conversation_id = ${id}
      AND school_id = ${req.schoolId}
  `;
  const me = participants.find((p) => p.user_id === req.user.internal_id);
  if (!me) return res.status(403).json({ error: 'Access denied' });

  // Broadcast groups: only group admins (creator) may post; members are read-only.
  if (conv.is_group && conv.group_mode === 'broadcast' && !me.is_group_admin) {
    return res.status(403).json({ error: 'Only group admins can post in a broadcast group' });
  }

  let referencedMessage = null;
  let messageBody = requestedBody.trim();

  if (replyToMessageId) {
    [referencedMessage] = await sql`
      SELECT m.id, m.body, m.sender_user_id, p.display_name AS sender_name
      FROM messages m
      JOIN users u ON u.id = m.sender_user_id
      JOIN persons p ON p.id = u.person_id
      WHERE m.id = ${replyToMessageId}
        AND m.conversation_id = ${id}
        AND m.school_id = ${req.schoolId}
        AND m.deleted_at IS NULL
      LIMIT 1
    `;
    if (!referencedMessage) {
      return res.status(400).json({ error: 'The message being replied to is unavailable' });
    }
  }

  if (forwardedFromMessageId) {
    [referencedMessage] = await sql`
      SELECT m.id, m.body, m.sender_user_id
      FROM messages m
      JOIN message_participants mp
        ON mp.conversation_id = m.conversation_id
        AND mp.user_id = ${req.user.internal_id}
        AND mp.school_id = ${req.schoolId}
      WHERE m.id = ${forwardedFromMessageId}
        AND m.school_id = ${req.schoolId}
        AND m.deleted_at IS NULL
      LIMIT 1
    `;
    if (!referencedMessage) {
      return res.status(400).json({ error: 'The message being forwarded is unavailable' });
    }
    messageBody = referencedMessage.body;
  }

  const otherUserIds = participants
    .filter((p) => p.user_id !== req.user.internal_id)
    .map((p) => p.user_id);

  // Insert message idempotently (trigger auto-updates conversation preview).
  // On a client_msg_id conflict the row already exists → DO NOTHING, then re-read.
  const inserted = await sql`
    INSERT INTO messages (
      conversation_id, school_id, sender_user_id, body, client_msg_id,
      reply_to_message_id, forwarded_from_message_id
    )
    VALUES (
      ${id}, ${req.schoolId}, ${req.user.internal_id}, ${messageBody}, ${clientMsgId},
      ${replyToMessageId}, ${forwardedFromMessageId}
    )
    ON CONFLICT (conversation_id, sender_user_id, client_msg_id) WHERE client_msg_id IS NOT NULL
    DO NOTHING
    RETURNING *
  `;
  const isNew = inserted.length > 0;
  let message = inserted[0];
  if (!message && clientMsgId) {
    [message] = await sql`
      SELECT * FROM messages
      WHERE conversation_id = ${id} AND sender_user_id = ${req.user.internal_id}
        AND client_msg_id = ${clientMsgId}
      LIMIT 1
    `;
  }

  // Get sender name for notification + response
  const senderName = await getSenderDisplayName(req.user.internal_id, req.schoolId);

  // Only notify on a genuinely NEW message (never re-notify on an idempotent retry).
  if (isNew && otherUserIds.length > 0) {
    const preview = `${forwardedFromMessageId ? 'Forwarded: ' : ''}${messageBody}`.slice(0, 80);
    const label = conv.is_group ? `${conv.group_name} · ${senderName}` : senderName;
    queueMessageNotification(req.schoolId, otherUserIds, id, label, preview);
  }

  return sendSuccess(res, req.schoolId, {
    ...message,
    sender_name: senderName,
    ...(replyToMessageId && referencedMessage
      ? {
          reply_to_body: referencedMessage.body,
          reply_to_sender_user_id: referencedMessage.sender_user_id,
          reply_to_sender_name: referencedMessage.sender_name,
        }
      : {}),
  }, 201);
}));

/**
 * PATCH /conversations/:id/messages/:messageId
 * Edit one of the caller's own, non-deleted messages.
 */
router.patch('/conversations/:id/messages/:messageId', requireAuth, asyncHandler(async (req, res) => {
  const { id, messageId } = req.params;
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';

  if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(messageId)) {
    return res.status(400).json({ error: 'Invalid conversation or message id' });
  }
  if (!body) return res.status(400).json({ error: 'Message body is required' });
  if (body.length > 4000) {
    return res.status(400).json({ error: 'Message body cannot exceed 4000 characters' });
  }

  const [message] = await sql`
    UPDATE messages m
    SET body = ${body}, edited_at = now()
    WHERE m.id = ${messageId}
      AND m.conversation_id = ${id}
      AND m.school_id = ${req.schoolId}
      AND m.sender_user_id = ${req.user.internal_id}
      AND m.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM message_participants mp
        WHERE mp.conversation_id = ${id}
          AND mp.user_id = ${req.user.internal_id}
          AND mp.school_id = ${req.schoolId}
      )
    RETURNING m.*
  `;
  if (!message) {
    return res.status(404).json({ error: 'Message not found or cannot be edited' });
  }

  await sql`
    UPDATE message_conversations mc
    SET last_message_preview = LEFT(${body}, 100), updated_at = now()
    WHERE mc.id = ${id}
      AND mc.school_id = ${req.schoolId}
      AND NOT EXISTS (
        SELECT 1 FROM messages newer
        WHERE newer.conversation_id = ${id}
          AND (newer.created_at, newer.id) > (${message.created_at}, ${message.id})
      )
  `;

  const senderName = await getSenderDisplayName(req.user.internal_id, req.schoolId);
  return sendSuccess(res, req.schoolId, { ...message, sender_name: senderName });
}));

/**
 * DELETE /conversations/:id/messages/:messageId
 * Soft-delete one of the caller's own messages for every participant.
 */
router.delete('/conversations/:id/messages/:messageId', requireAuth, asyncHandler(async (req, res) => {
  const { id, messageId } = req.params;
  if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(messageId)) {
    return res.status(400).json({ error: 'Invalid conversation or message id' });
  }

  const [message] = await sql`
    UPDATE messages m
    SET deleted_at = now()
    WHERE m.id = ${messageId}
      AND m.conversation_id = ${id}
      AND m.school_id = ${req.schoolId}
      AND m.sender_user_id = ${req.user.internal_id}
      AND m.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM message_participants mp
        WHERE mp.conversation_id = ${id}
          AND mp.user_id = ${req.user.internal_id}
          AND mp.school_id = ${req.schoolId}
      )
    RETURNING m.*
  `;
  if (!message) {
    return res.status(404).json({ error: 'Message not found or cannot be deleted' });
  }

  await sql`
    UPDATE message_conversations mc
    SET last_message_preview = 'Message deleted', updated_at = now()
    WHERE mc.id = ${id}
      AND mc.school_id = ${req.schoolId}
      AND NOT EXISTS (
        SELECT 1 FROM messages newer
        WHERE newer.conversation_id = ${id}
          AND (newer.created_at, newer.id) > (${message.created_at}, ${message.id})
      )
  `;

  const senderName = await getSenderDisplayName(req.user.internal_id, req.schoolId);
  return sendSuccess(res, req.schoolId, {
    ...message,
    body: '',
    sender_name: senderName,
  });
}));

/**
 * POST /conversations/:id/read
 * Mark conversation as read for the caller.
 */
router.post('/conversations/:id/read', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Only move the seen high-water FORWARD (a stale client must never rewind it).
  const result = await sql`
    UPDATE message_participants
    SET last_read_at = GREATEST(COALESCE(last_read_at, to_timestamp(0)), now())
    WHERE conversation_id = ${id}
      AND user_id = ${req.user.internal_id}
      AND school_id = ${req.schoolId}
    RETURNING conversation_id
  `;

  if (result.length === 0) {
    return res.status(403).json({ error: 'Access denied' });
  }

  return sendSuccess(res, req.schoolId, { read: true });
}));

/**
 * POST /conversations/:id/typing
 * Debounced "I'm typing" ping. Upserts a short-lived row (auto-expires on read).
 */
router.post('/conversations/:id/typing', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [me] = await sql`
    SELECT 1 FROM message_participants
    WHERE conversation_id = ${id} AND user_id = ${req.user.internal_id} AND school_id = ${req.schoolId}
    LIMIT 1
  `;
  if (!me) return res.status(403).json({ error: 'Access denied' });

  await sql`
    INSERT INTO message_typing (conversation_id, school_id, user_id, updated_at)
    VALUES (${id}, ${req.schoolId}, ${req.user.internal_id}, now())
    ON CONFLICT (conversation_id, user_id) DO UPDATE SET updated_at = now()
  `;
  return sendSuccess(res, req.schoolId, { ok: true });
}));

/**
 * GET /conversations/:id/live
 * ONE poll powers delivery/seen ticks + typing + online/last-seen. Side effects:
 * marks the caller "delivered up to now" and refreshes their presence heartbeat.
 */
router.get('/conversations/:id/live', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.internal_id;

  const [me] = await sql`
    SELECT 1 FROM message_participants
    WHERE conversation_id = ${id} AND user_id = ${userId} AND school_id = ${req.schoolId}
    LIMIT 1
  `;
  if (!me) return res.status(403).json({ error: 'Access denied' });

  // Side effects: caller has received messages (delivered) + is active (presence).
  await sql`
    UPDATE message_participants
    SET last_delivered_at = GREATEST(COALESCE(last_delivered_at, to_timestamp(0)), now())
    WHERE conversation_id = ${id} AND user_id = ${userId} AND school_id = ${req.schoolId}
  `;
  await sql`UPDATE users SET last_active_at = now() WHERE id = ${userId} AND school_id = ${req.schoolId}`;

  // Receipts: MIN high-water across OTHER participants (NULL → epoch so groups only
  // read "delivered/seen" once EVERY other member crosses the mark).
  const [receipts] = await sql`
    SELECT
      MIN(COALESCE(last_delivered_at, to_timestamp(0))) AS last_delivered_at,
      MIN(COALESCE(last_read_at, to_timestamp(0)))      AS last_seen_at,
      COUNT(*)::int AS other_count
    FROM message_participants
    WHERE conversation_id = ${id} AND school_id = ${req.schoolId} AND user_id != ${userId}
  `;

  // Typing (active in the last 6s, excluding me).
  const typing = await sql`
    SELECT mt.user_id, p.display_name
    FROM message_typing mt
    JOIN users u ON u.id = mt.user_id
    JOIN persons p ON u.person_id = p.id
    WHERE mt.conversation_id = ${id} AND mt.school_id = ${req.schoolId}
      AND mt.user_id != ${userId}
      AND mt.updated_at > now() - interval '6 seconds'
  `;

  // Presence: for a 1:1, the other participant's online / last-seen.
  const presenceRows = await sql`
    SELECT u.id AS user_id, u.last_active_at,
           (u.last_active_at > now() - interval '35 seconds') AS online
    FROM message_participants mp
    JOIN users u ON u.id = mp.user_id
    WHERE mp.conversation_id = ${id} AND mp.school_id = ${req.schoolId} AND mp.user_id != ${userId}
  `;
  const presence = presenceRows.length === 1 ? presenceRows[0] : null;

  return sendSuccess(res, req.schoolId, {
    receipts: {
      last_delivered_at: receipts?.last_delivered_at || null,
      last_seen_at: receipts?.last_seen_at || null,
      other_count: receipts?.other_count || 0,
    },
    typing: typing.map((t) => ({ user_id: t.user_id, display_name: t.display_name })),
    presence,
  });
}));

/**
 * GET /unread-total
 * Total unread messages across all conversations for the caller.
 */
router.get('/unread-total', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.internal_id;

  const [result] = await sql`
    SELECT COALESCE(SUM(unread), 0)::int as unread_count
    FROM (
      SELECT COUNT(*) as unread
      FROM message_participants mp
      JOIN message_conversations mc ON mp.conversation_id = mc.id
      JOIN messages m ON m.conversation_id = mc.id
        AND m.school_id = ${req.schoolId}
        AND m.sender_user_id != ${userId}
        AND m.deleted_at IS NULL
        AND (mp.last_read_at IS NULL OR m.created_at > mp.last_read_at)
      WHERE mp.user_id = ${userId}
        AND mp.school_id = ${req.schoolId}
        AND mc.deleted_at IS NULL
        AND mp.muted = false
    ) sub
  `;

  return sendSuccess(res, req.schoolId, { unread_count: result.unread_count });
}));

/**
 * POST /groups
 * Admin-only: create a group conversation.
 * Body: { group_name, group_mode: 'broadcast'|'chat', member_user_ids: uuid[] }
 * Members may be any mix of teachers + students/parents in the same school.
 */
router.post('/groups', requireAuth, asyncHandler(async (req, res) => {
  const callerRole = await resolveCallerRole(req);
  if (callerRole !== 'admin') {
    return res.status(403).json({ error: 'Only admins can create groups' });
  }

  const { group_name, group_mode, member_user_ids } = req.body;
  const name = typeof group_name === 'string' ? group_name.trim() : '';
  if (!name) return res.status(400).json({ error: 'group_name is required' });
  if (name.length > 120) return res.status(400).json({ error: 'group_name too long' });
  if (!['broadcast', 'chat'].includes(group_mode)) {
    return res.status(400).json({ error: "group_mode must be 'broadcast' or 'chat'" });
  }
  if (!Array.isArray(member_user_ids) || member_user_ids.length === 0) {
    return res.status(400).json({ error: 'At least one member is required' });
  }

  // Keep only valid, active users in this school, excluding the creator (added separately).
  const uniqueIds = [...new Set(member_user_ids)].filter((uid) => uid !== req.user.internal_id);
  const validMembers = await sql`
    SELECT id FROM users
    WHERE id = ANY(${uniqueIds})
      AND school_id = ${req.schoolId}
      AND account_status = 'active'
      AND deleted_at IS NULL
  `;
  const memberIds = validMembers.map((m) => m.id);
  if (memberIds.length === 0) {
    return res.status(400).json({ error: 'No valid members found in this school' });
  }

  const group = await sql.begin(async (tx) => {
    const [conv] = await tx`
      INSERT INTO message_conversations
        (school_id, pair_type, is_group, group_name, group_mode, created_by)
      VALUES
        (${req.schoolId}, 'group', true, ${name}, ${group_mode}, ${req.user.internal_id})
      RETURNING *
    `;

    // Creator is a group admin (can post in broadcast mode); members are regular.
    await tx`
      INSERT INTO message_participants (conversation_id, school_id, user_id, is_group_admin)
      VALUES (${conv.id}, ${req.schoolId}, ${req.user.internal_id}, true)
    `;
    for (const uid of memberIds) {
      await tx`
        INSERT INTO message_participants (conversation_id, school_id, user_id, is_group_admin)
        VALUES (${conv.id}, ${req.schoolId}, ${uid}, false)
        ON CONFLICT (conversation_id, user_id) DO NOTHING
      `;
    }
    return conv;
  });

  return sendSuccess(res, req.schoolId, {
    ...group,
    member_count: memberIds.length + 1,
  }, 201);
}));

export default router;
