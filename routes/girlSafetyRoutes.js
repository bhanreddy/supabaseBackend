import express from 'express';
import sql from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { translateFields } from '../services/geminiTranslator.js';

const router = express.Router();

/**
 * GS4 — Generate a ticket number scoped to this school.
 * Format: GS-{schoolId}-{YYYYMM}-{0001}
 * Sequences are unique per school — no cross-tenant ticket collision.
 */
const generateTicketNumber = async (schoolId) => {
  const today      = new Date();
  const datePrefix = `GS-${schoolId}-${today.getFullYear()}${(today.getMonth() + 1).toString().padStart(2, '0')}`;

  // GS4: Count is scoped to this school's records only
  const rows = await sql`
    SELECT ticket_no
    FROM public.girl_safety_complaints
    WHERE ticket_no  LIKE ${datePrefix + '%'}
      AND school_id  = ${schoolId}
    ORDER BY ticket_no DESC
    LIMIT 1
  `;

  let nextSeq = 1;
  if (rows.length > 0) {
    const parts   = rows[0].ticket_no.split('-');
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastSeq)) nextSeq = lastSeq + 1;
  }

  return `${datePrefix}-${nextSeq.toString().padStart(4, '0')}`;
};

/**
 * GS3 — Platform super-admin check.
 * NexSyrus super admins exist outside the tenant model (no school_id).
 * We check the super_admins table using the service_role client to safely
 * determine if the caller has platform-level access without leaking data.
 */
async function checkIsSuperAdmin(userId) {
  try {
    const { supabaseAdmin } = await import('../db.js');
    const { data, error } = await supabaseAdmin
      .from('super_admins')
      .select('id')
      .eq('id', userId)
      .eq('is_active', true)
      .maybeSingle();
    if (error) return false;
    return !!data;
  } catch {
    return false;
  }
}

// ── GET /girl-safety ───────────────────────────────────────────────────────────
// List complaints — students see own complaints; admins see assigned ones.
// GS2: Added school_id defense-in-depth to admin branch.
// GS7: requireAuth guard.
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { status, page = 1, limit = 20 } = req.query;
    const offset   = (page - 1) * limit;
    const schoolId = req.schoolId;

    const isStudent = req.user?.roles.includes('student');

    let complaints;
    if (isStudent) {
      // Find the student's UUID (scoped to this school)
      const [studentProfile] = await sql`
        SELECT s.id
        FROM students s
        JOIN persons p ON s.person_id = p.id
        JOIN users u   ON p.id        = u.person_id
        WHERE u.id         = ${req.user.internal_id}
          AND s.school_id  = ${schoolId}
      `;

      if (!studentProfile) {
        return res.status(403).json({ error: 'Student profile not found' });
      }

      complaints = await sql`
        SELECT
          c.id, c.ticket_no, c.category, c.status,
          c.created_at, c.resolved_at, c.is_anonymous
        FROM public.girl_safety_complaints c
        WHERE c.student_id = ${studentProfile.id}
          AND c.school_id  = ${schoolId}
          ${status ? sql`AND c.status = ${status}` : sql``}
        ORDER BY c.created_at DESC
        LIMIT  ${limit}
        OFFSET ${offset}
      `;
    } else {
      const isAdmin = req.user?.roles.includes('admin');
      if (!isAdmin) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // GS2: Defense-in-depth — also filter by school_id
      complaints = await sql`
        SELECT
          c.id, c.ticket_no, c.category, c.status,
          c.created_at, c.resolved_at, c.is_anonymous,
          CASE
            WHEN c.is_anonymous = true THEN 'Anonymous Student'
            ELSE sp.display_name
          END AS student_name
        FROM public.girl_safety_complaints c
        LEFT JOIN students s  ON c.student_id  = s.id
        LEFT JOIN persons sp  ON s.person_id   = sp.id
        WHERE c.assigned_to = ${req.user.internal_id}
          AND c.school_id   = ${schoolId}
          ${status ? sql`AND c.status = ${status}` : sql``}
        ORDER BY c.created_at DESC
        LIMIT  ${limit}
        OFFSET ${offset}
      `;
    }

    return sendSuccess(res, req.schoolId, complaints);
  })
);

// ── POST /girl-safety ──────────────────────────────────────────────────────────
// Create a new safety complaint (female students only).
// GS1: Admin assignment query scoped to school_id.
// GS5: INSERT includes school_id.
// GS7: requireAuth guard.
router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { category, description, incident_date, attachments, is_anonymous } = req.body;
    const schoolId = req.schoolId;

    if (!category || !description) {
      return res.status(400).json({ error: 'Category and description are required' });
    }

    // Validate the user is a female student at this school
    const [userProfile] = await sql`
      SELECT
        u.id, s.id AS student_id, g.name AS gender, p.display_name
      FROM users u
      JOIN persons p     ON u.person_id  = p.id
      LEFT JOIN genders g  ON p.gender_id  = g.id
      LEFT JOIN students s ON p.id         = s.person_id
        AND s.school_id = ${schoolId}
      WHERE u.id         = ${req.user.internal_id}
        AND u.school_id  = ${schoolId}
    `;

    if (!userProfile?.student_id) {
      return res.status(403).json({ error: 'Only students can access this feature' });
    }

    if (userProfile.gender !== 'Female') {
      return res.status(403).json({ error: 'Access restricted' });
    }

    // GS1: Admin assignment — scoped to this school
    // Priority 1: Lady admin (female admin) at this school
    const activeLadyAdmins = await sql`
      SELECT u.id
      FROM users u
      JOIN persons p    ON u.person_id = p.id
      JOIN genders g    ON p.gender_id = g.id
      JOIN user_roles ur ON ur.user_id = u.id
        AND ur.school_id = ${schoolId}
      JOIN roles r       ON ur.role_id = r.id
        AND r.school_id  = ${schoolId}
      WHERE r.code            = 'admin'
        AND g.name            = 'Female'
        AND u.account_status  = 'active'
        AND u.school_id       = ${schoolId}
        AND u.deleted_at      IS NULL
      LIMIT 1
    `;

    let assignedAdminId = null;
    if (activeLadyAdmins.length > 0) {
      assignedAdminId = activeLadyAdmins[0].id;
    } else {
      // Fallback Priority 2: Any active admin at this school
      const anyAdmins = await sql`
        SELECT u.id
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
          AND ur.school_id = ${schoolId}
        JOIN roles r       ON ur.role_id = r.id
          AND r.school_id  = ${schoolId}
        WHERE r.code           = 'admin'
          AND u.account_status = 'active'
          AND u.school_id      = ${schoolId}
          AND u.deleted_at     IS NULL
        LIMIT 1
      `;
      if (anyAdmins.length > 0) assignedAdminId = anyAdmins[0].id;
    }

    // GS4: School-scoped ticket number
    const ticketNo = await generateTicketNumber(schoolId);

    // Telugu Translation (optional background)
    let description_te = null;
    try {
      const te       = await translateFields({ description });
      description_te = te.description || null;
    } catch {
      // non-fatal
    }

    const _attachments = attachments ? JSON.stringify(attachments) : '[]';

    // GS5: INSERT includes school_id
    const [complaint] = await sql`
      INSERT INTO public.girl_safety_complaints
        (school_id, ticket_no, student_id, category, description, description_te,
         incident_date, attachments, is_anonymous, assigned_to)
      VALUES
        (${schoolId}, ${ticketNo}, ${userProfile.student_id}, ${category},
         ${description}, ${description_te},
         ${incident_date ? new Date(incident_date) : null},
         ${_attachments}::jsonb, ${!!is_anonymous}, ${assignedAdminId})
      RETURNING *
    `;

    // Notify assigned admin
    if (assignedAdminId) {
      (async () => {
        try {
          const { sendNotificationToUsers } = await import('../services/notificationService.js');
          await sendNotificationToUsers(
            [assignedAdminId],
            'GIRL_SAFETY_RECEIVED',
            { message: 'You have a new safety message' }
          );
        } catch {
          // non-fatal
        }
      })();
    }

    return sendSuccess(res, req.schoolId, {
      message: 'Complaint submitted confidentially',
      complaint: {
        id:          complaint.id,
        ticket_no:   complaint.ticket_no,
        category:    complaint.category,
        status:      complaint.status,
        created_at:  complaint.created_at,
        is_anonymous: complaint.is_anonymous,
      },
    }, 201);
  })
);

// ── GET /girl-safety/:id ───────────────────────────────────────────────────────
// Get complaint details and thread.
// GS3: Super-admin check via platform super_admins table.
// GS6: school_id scoped on complaint fetch.
// GS7: requireAuth guard.
router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id }   = req.params;
    const schoolId = req.schoolId;

    // GS6: scope to school_id in the primary fetch
    const [complaint] = await sql`
      SELECT
        c.*,
        CASE
          WHEN c.is_anonymous = true THEN 'Confidential User'
          ELSE sp.display_name
        END AS student_name
      FROM public.girl_safety_complaints c
      JOIN students s  ON c.student_id = s.id
      JOIN persons sp  ON s.person_id  = sp.id
      WHERE c.id        = ${id}
        AND c.school_id = ${schoolId}
    `;

    if (!complaint) {
      return res.status(404).json({ error: 'Complaint not found' });
    }

    const internalId = req.user.internal_id;
    const isStudent  = req.user?.roles.includes('student');
    const isAdmin    = req.user?.roles.includes('admin');

    if (isStudent) {
      // Student must own this complaint
      const [studentProfile] = await sql`
        SELECT s.id
        FROM students s
        JOIN persons p ON s.person_id = p.id
        JOIN users u   ON p.id        = u.person_id
        WHERE u.id        = ${internalId}
          AND s.school_id = ${schoolId}
      `;
      if (!studentProfile || studentProfile.id !== complaint.student_id) {
        return res.status(404).json({ error: 'Complaint not found' });
      }
    } else if (isAdmin) {
      if (complaint.assigned_to !== internalId) {
        // GS3: Platform super-admin check via super_admins table
        const isSuperAdmin = await checkIsSuperAdmin(req.user.id);
        if (!isSuperAdmin) {
          return res.status(404).json({ error: 'Complaint not found' });
        }
      }
    } else {
      return res.status(403).json({ error: 'Access denied' });
    }

    // GS6: Thread fetch scoped to school_id
    const threads = await sql`
      SELECT t.id, t.sender_role, t.message, t.message_te, t.created_at
      FROM public.girl_safety_complaint_threads t
      WHERE t.complaint_id = ${id}
        AND t.school_id    = ${schoolId}
      ORDER BY t.created_at ASC
    `;

    let assigned_authority = 'Admin';
    if (isStudent && complaint.assigned_to) {
      const [assigned] = await sql`
        SELECT g.name AS gender
        FROM users u
        JOIN persons p ON u.person_id = p.id
        JOIN genders g ON p.gender_id = g.id
        WHERE u.id = ${complaint.assigned_to}
      `;
      if (assigned?.gender === 'Female') assigned_authority = 'Lady Admin';
    }

    return sendSuccess(res, req.schoolId, { ...complaint, assigned_authority, threads });
  })
);

// ── POST /girl-safety/:id/thread ───────────────────────────────────────────────
// Add a reply to a complaint thread.
// GS5: Thread INSERT includes school_id.
// GS6: Complaint fetch scoped to school_id.
// GS7: requireAuth guard.
router.post(
  '/:id/thread',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id }    = req.params;
    const { message } = req.body;
    const schoolId  = req.schoolId;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // GS6: scope complaint fetch to school_id
    const [complaint] = await sql`
      SELECT student_id, assigned_to
      FROM public.girl_safety_complaints
      WHERE id        = ${id}
        AND school_id = ${schoolId}
    `;

    if (!complaint) {
      return res.status(404).json({ error: 'Complaint not found' });
    }

    const internalId  = req.user.internal_id;
    const isStudent   = req.user?.roles.includes('student');
    const isAdmin     = req.user?.roles.includes('admin');
    const sender_role = isStudent ? 'student' : 'admin';

    if (isStudent) {
      const [studentProfile] = await sql`
        SELECT s.id
        FROM students s
        JOIN persons p ON s.person_id = p.id
        JOIN users u   ON p.id        = u.person_id
        WHERE u.id        = ${internalId}
          AND s.school_id = ${schoolId}
      `;
      if (!studentProfile || studentProfile.id !== complaint.student_id) {
        return res.status(404).json({ error: 'Complaint not found' });
      }
    } else if (isAdmin) {
      if (complaint.assigned_to !== internalId) {
        // GS3: Platform super-admin check
        const isSuperAdmin = await checkIsSuperAdmin(req.user.id);
        if (!isSuperAdmin) {
          return res.status(404).json({ error: 'Complaint not found' });
        }
      }
    } else {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Translate message (optional)
    let message_te = null;
    try {
      const te   = await translateFields({ message });
      message_te = te.message || null;
    } catch {
      // non-fatal
    }

    // GS5: Thread INSERT includes school_id
    const [thread] = await sql`
      INSERT INTO public.girl_safety_complaint_threads
        (school_id, complaint_id, sender_id, sender_role, message, message_te)
      VALUES
        (${schoolId}, ${id}, ${internalId}, ${sender_role}, ${message}, ${message_te})
      RETURNING id, sender_role, message, message_te, created_at
    `;

    // Push notification to the other party
    (async () => {
      try {
        const { sendNotificationToUsers } = await import('../services/notificationService.js');

        if (isStudent && complaint.assigned_to) {
          await sendNotificationToUsers(
            [complaint.assigned_to],
            'GIRL_SAFETY_UPDATE',
            { message: 'You have a new safety message' }
          );
        } else if (!isStudent && complaint.student_id) {
          const [studentUser] = await sql`
            SELECT u.id
            FROM users u
            JOIN persons p ON u.person_id = p.id
            JOIN students s ON p.id        = s.person_id
            WHERE s.id         = ${complaint.student_id}
              AND u.school_id  = ${schoolId}
          `;
          if (studentUser) {
            await sendNotificationToUsers(
              [studentUser.id],
              'GIRL_SAFETY_UPDATE',
              { message: 'You have a new safety message' }
            );
          }
        }
      } catch {
        // non-fatal
      }
    })();

    return sendSuccess(res, req.schoolId, thread, 201);
  })
);

export default router;