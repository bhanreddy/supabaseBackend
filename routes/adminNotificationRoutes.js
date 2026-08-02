import express from 'express';
import sql from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendNotificationToUsers } from '../services/notificationService.js';
import {
  dispatchBroadcast,
  getBroadcastStatus,
  getClassTargets,
  retryBroadcast,
} from '../services/broadcastDispatchService.js';

const router = express.Router();

/**
 * AN4 — APPROACH A (chosen):
 * isPlatformKillSwitchActive() reads notification_config without school_id.
 * notification_config is intentionally platform-global — it is a service-level
 * kill switch controlled only by NexSyrus super admins via the service_role
 * client. No school admin can set or modify this table.
 * This is acceptable and no per-school scope is needed here.
 */
let _killSwitchCache = { value: false, expiresAt: 0 };

async function isPlatformKillSwitchActive() {
  const now = Date.now();
  if (now < _killSwitchCache.expiresAt) return _killSwitchCache.value;

  try {
    const config = await sql`SELECT value FROM notification_config WHERE key = 'kill_switch'`;
    const active = config.length > 0 && config[0].value?.global === true;
    _killSwitchCache = { value: active, expiresAt: now + 30_000 };
    return active;
  } catch (error) {
    // A temporary config-table outage must not take down the notifications page.
    // Keep the last known value briefly and let the actual operation report its own result.
    console.error('[Admin Notifications] Kill-switch lookup failed; using cached value', error);
    _killSwitchCache.expiresAt = now + 5_000;
    return _killSwitchCache.value;
  }
}

// ── GET /classes/targets ───────────────────────────────────────────────────────
// Class list with type-aware recipient counts for broadcast targeting.
router.get(
  '/classes/targets',
  requireAuth,
  requirePermission('dashboard.view'),
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const channelType = req.query.type;

    if (!channelType || typeof channelType !== 'string') {
      return res.status(400).json({ error: 'Query param "type" (channel) is required' });
    }

    if (await isPlatformKillSwitchActive()) {
      return res.status(503).json({ error: 'Notifications are globally paused via Kill Switch.' });
    }

    const targets = await getClassTargets(schoolId, channelType);
    return sendSuccess(res, req.schoolId, targets);
  })
);

// ── POST /broadcast ─────────────────────────────────────────────────────────────
// Broadcasts are asynchronous; the client polls the batch status for progress.
router.post(
  '/broadcast',
  requireAuth,
  requirePermission('dashboard.view'),
  asyncHandler(async (req, res) => {
    const { type, class_ids, section_ids, idempotency_key } = req.body;
    const adminId = req.user.internal_id;
    const schoolId = req.schoolId;

    if (!type) {
      return res.status(400).json({ error: 'type (channel) is required' });
    }

    const idempotencyKey =
      typeof idempotency_key === 'string' && idempotency_key.trim()
        ? idempotency_key.trim().slice(0, 100)
        : null;

    if (await isPlatformKillSwitchActive()) {
      return res.status(503).json({ error: 'Notifications are globally paused via Kill Switch.' });
    }

    const classIds = Array.isArray(class_ids)
      ? [...new Set(class_ids.filter((id) => typeof id === 'string' && id.trim()))]
      : [];
    const sectionIds = Array.isArray(section_ids)
      ? [...new Set(section_ids.filter((id) => typeof id === 'string' && id.trim()))]
      : [];

    if (classIds.length > 100 || sectionIds.length > 100) {
      return res.status(400).json({ error: 'A maximum of 100 classes or sections is allowed' });
    }

    if (classIds.length > 0) {
      const ownedClasses = await sql`
        SELECT id FROM classes
        WHERE school_id = ${schoolId}
          AND deleted_at IS NULL
          AND id = ANY(${classIds})
      `;
      if (ownedClasses.length !== classIds.length) {
        return res.status(404).json({ error: 'One or more classes were not found for this school' });
      }
    }

    const result = await dispatchBroadcast({
      schoolId,
      adminId,
      channelType: type,
      classIds,
      sectionIds,
      idempotencyKey,
    });

    return sendSuccess(res, req.schoolId, result);
  })
);

// ── GET /broadcast/:batchId ─────────────────────────────────────────────────────
router.get(
  '/broadcast/:batchId',
  requireAuth,
  requirePermission('dashboard.view'),
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { batchId } = req.params;

    const status = await getBroadcastStatus(batchId, schoolId);
    if (!status) {
      return res.status(404).json({ error: 'Broadcast batch not found' });
    }

    return sendSuccess(res, req.schoolId, status);
  })
);

// ── POST /broadcast/:batchId/retry ──────────────────────────────────────────────
router.post(
  '/broadcast/:batchId/retry',
  requireAuth,
  requirePermission('dashboard.view'),
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const adminId = req.user.internal_id;
    const { batchId } = req.params;

    if (await isPlatformKillSwitchActive()) {
      return res.status(503).json({ error: 'Notifications are globally paused via Kill Switch.' });
    }

    try {
      const result = await retryBroadcast(batchId, schoolId, adminId);
      return sendSuccess(res, req.schoolId, result);
    } catch (err) {
      const message = err?.message || 'Retry failed';
      if (message.includes('not found')) return res.status(404).json({ error: message });
      if (message.includes('still processing')) return res.status(409).json({ error: message });
      if (message.includes('No pending') || message.includes('No failed')) {
        return res.status(400).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  })
);

// ── POST /fees/send-all ────────────────────────────────────────────────────────
// Triggers a batch fee reminder for students of the authenticated school only.
// AN1: All queries scoped to req.schoolId.
// AN7: notification_batches INSERT includes school_id.
// AN8: requireAuth + requirePermission guard.
router.post(
  '/fees/send-all',
  requireAuth,
  requirePermission('fees.manage'),
  asyncHandler(async (req, res) => {
    const { month, filters, dryRun } = req.body;
    const adminId  = req.user.internal_id;
    const schoolId = req.schoolId;

    if (!month) {
      return res.status(400).json({ error: 'Month is required (e.g., "September")' });
    }

    // Guard: Platform Kill Switch (AN4 — global, not per-school)
    if (await isPlatformKillSwitchActive()) {
      return res.status(503).json({ error: 'Notifications are globally paused via Kill Switch.' });
    }

    // Guard: Rate Limit (1 batch per day per school)
    const recentBatches = await sql`
      SELECT id FROM notification_batches
      WHERE type       = 'FEES'
        AND school_id  = ${schoolId}
        AND created_at > now() - interval '24 hours'
        AND status    != 'aborted'
    `;

    if (recentBatches.length > 0 && !dryRun) {
      return res.status(429).json({
        error: 'Rate limit exceeded. Only 1 bulk fee reminder allowed per 24 hours.',
      });
    }

    // Guard: Idempotency — don't send same month twice in 30 days
    const duplicateBatch = await sql`
      SELECT id FROM notification_batches
      WHERE type              = 'FEES'
        AND school_id         = ${schoolId}
        AND filters->>'month' = ${month}
        AND created_at        > now() - interval '30 days'
        AND status IN ('completed', 'processing')
    `;

    if (duplicateBatch.length > 0 && !dryRun) {
      return res.status(409).json({
        error: `Fee reminders for ${month} were already sent recently.`,
      });
    }

    // AN1: Resolve target students scoped to this school
    let query = sql`
      SELECT
        s.id   AS student_id,
        s.admission_no,
        p.display_name,
        u_parent.id AS parent_user_id,
        d.fcm_token
      FROM students s
      JOIN persons p             ON s.person_id          = p.id
      JOIN student_enrollments se ON s.id               = se.student_id
        AND se.status = 'active'
        AND se.school_id = ${schoolId}
      JOIN class_sections cs     ON se.class_section_id = cs.id
        AND cs.school_id = ${schoolId}
      LEFT JOIN student_parents sp  ON s.id             = sp.student_id
      LEFT JOIN parents par         ON sp.parent_id     = par.id
      LEFT JOIN users u_parent      ON par.person_id    = u_parent.person_id
        AND u_parent.school_id = ${schoolId}
      LEFT JOIN user_devices d      ON u_parent.id      = d.user_id
      WHERE s.school_id   = ${schoolId}
        AND s.deleted_at  IS NULL
        AND d.fcm_token IS NOT NULL
    `;

    if (filters && filters.class_id) {
      query = sql`${query} AND cs.class_id = ${filters.class_id}`;
    }

    const targets      = await query;
    const uniqueTargets = new Map();

    targets.forEach((row) => {
      if (!uniqueTargets.has(row.student_id)) {
        uniqueTargets.set(row.student_id, {
          student_id:    row.student_id,
          name:          row.display_name,
          admission_no:  row.admission_no,
          tokens:         new Set(),
          parent_user_ids: new Set(),
        });
      }
      if (row.fcm_token)      uniqueTargets.get(row.student_id).tokens.add(row.fcm_token);
      if (row.parent_user_id) uniqueTargets.get(row.student_id).parent_user_ids.add(row.parent_user_id);
    });

    const totalStudents = uniqueTargets.size;

    if (dryRun) {
      return sendSuccess(res, req.schoolId, {
        message:        'Dry run successful',
        total_students: totalStudents,
        sample_message: `Fee Reminder: ₹[Amount] due for ${month}.`,
      });
    }

    // AN7: Insert notification_batches with school_id
    const [batch] = await sql`
      INSERT INTO notification_batches
        (school_id, admin_id, type, filters, status, total_targets)
      VALUES
        (${schoolId}, ${adminId}, 'FEES', ${JSON.stringify({ month, ...filters })}, 'processing', ${totalStudents})
      RETURNING id
    `;

    // Fire-and-forget background processing
    processBatch(batch.id, uniqueTargets, month, adminId, schoolId).catch(async () => {
      await sql`
        UPDATE notification_batches
        SET status = 'failed', failure_count = failure_count + 1
        WHERE id        = ${batch.id}
          AND school_id = ${schoolId}
      `;
    });

    return sendSuccess(res, req.schoolId, {
      message:       'Batch processing started',
      batch_id:      batch.id,
      total_targets: totalStudents,
    });
  })
);

/**
 * Background processor for fee-reminder batches.
 * AN7: All notification_batches reads/writes scoped to schoolId.
 */
async function processBatch(batchId, targetMap, month, adminId, schoolId) {
  const CHUNK_SIZE = 50;
  const targets    = Array.from(targetMap.values());
  let sentCount    = 0;
  let failureCount = 0;

  // Pre-fetch all balances in one bulk query (scoped to school)
  const allStudentIds = targets.map((t) => t.student_id);
  const balanceRows = await sql`
    SELECT sf.student_id,
           COALESCE(SUM(sf.amount_due - sf.discount - sf.amount_paid), 0) AS balance
    FROM student_fees sf
    JOIN students s ON sf.student_id = s.id
      AND s.school_id = ${schoolId}
    WHERE sf.student_id = ANY(${allStudentIds})
      AND sf.school_id  = ${schoolId}
      AND sf.status IN ('pending', 'partial', 'overdue')
    GROUP BY sf.student_id
    HAVING SUM(sf.amount_due - sf.discount - sf.amount_paid) > 0
  `;
  const balanceMap = new Map(balanceRows.map((b) => [b.student_id, parseFloat(b.balance)]));

  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    // Check if aborted (scoped to school)
    const [statusCheck] = await sql`
      SELECT status FROM notification_batches
      WHERE id        = ${batchId}
        AND school_id = ${schoolId}
    `;
    if (statusCheck?.status === 'aborted') return;

    const chunk    = targets.slice(i, i + CHUNK_SIZE);
    const promises = chunk.map(async (student) => {
      try {
        const amountDue = balanceMap.get(student.student_id) || 0;
        if (amountDue <= 0) return;

        const userIds = Array.from(student.parent_user_ids);
        if (userIds.length > 0) {
          const response = await sendNotificationToUsers(
            userIds,
            'FEE_REMINDER',
            { message: `Fee Reminder: ₹${amountDue.toFixed(2)} due for ${month}.` },
            { senderId: adminId, batchId, role: 'student' }
          );
          if (response?.successCount > 0) sentCount    += response.successCount;
          if (response?.failureCount > 0) failureCount += response.failureCount;
        }
      } catch {
        failureCount++;
      }
    });

    await Promise.all(promises);

    await sql`
      UPDATE notification_batches
      SET sent_count = ${sentCount}, failure_count = ${failureCount}
      WHERE id        = ${batchId}
        AND school_id = ${schoolId}
    `;
  }

  await sql`
    UPDATE notification_batches
    SET status = 'completed', updated_at = now()
    WHERE id        = ${batchId}
      AND school_id = ${schoolId}
  `;
}

// ── POST /test-trigger ─────────────────────────────────────────────────────────
// Test notification broadcaster — scoped to the requesting admin's school only.
// AN2: All recipient queries scoped to req.schoolId.
// AN7: notification_batches INSERT includes school_id.
// AN8: requireAuth + requirePermission guard.
router.post(
  '/test-trigger',
  requireAuth,
  requirePermission('dashboard.view'),
  asyncHandler(async (req, res) => {
    const { type }  = req.body;
    const adminId   = req.user.internal_id;
    const schoolId  = req.schoolId;

    if (!type) {
      return res.status(400).json({ error: 'notification type is required' });
    }

    if (await isPlatformKillSwitchActive()) {
      return res.status(503).json({ error: 'Notifications are globally paused via Kill Switch.' });
    }

    let recipients = [];

    // AN2: Every recipient query now scoped to schoolId
    if (type === 'ATTENDANCE_ABSENT' || type === 'ATTENDANCE_PRESENT') {
      // Match the morning session, not the derived full-day status. The day-level
      // `status` only becomes 'present' once BOTH sessions are marked, so keying
      // off it hides morning-only marks (they compute to 'half_day'). See the
      // matching logic in broadcastDispatchService.resolveRecipients().
      const attendanceMatch =
        type === 'ATTENDANCE_PRESENT'
          ? sql`AND (
              da.morning_status IN ('present', 'late')
              OR (da.morning_status IS NULL AND da.status IN ('present', 'late', 'half_day'))
            )`
          : sql`AND (
              da.morning_status = 'absent'
              OR (da.morning_status IS NULL AND da.status = 'absent')
            )`;
      recipients = await sql`
        SELECT DISTINCT u.id
        FROM users u
        JOIN students s  ON u.person_id = s.person_id
          AND s.school_id  = ${schoolId}
        JOIN student_enrollments se ON s.id = se.student_id
          AND se.school_id = ${schoolId}
        JOIN daily_attendance da ON da.student_enrollment_id = se.id
        WHERE se.status          = 'active'
          AND u.account_status   = 'active'
          AND u.school_id        = ${schoolId}
          AND da.attendance_date = CURRENT_DATE
          AND da.deleted_at IS NULL
          ${attendanceMatch}
        UNION
        SELECT DISTINCT u.id
        FROM users u
        JOIN parents p   ON u.person_id = p.person_id
        JOIN student_parents sp ON p.id = sp.parent_id
        JOIN students s  ON sp.student_id = s.id
          AND s.school_id  = ${schoolId}
        JOIN student_enrollments se ON s.id = se.student_id
          AND se.school_id = ${schoolId}
        JOIN daily_attendance da ON da.student_enrollment_id = se.id
        WHERE se.status          = 'active'
          AND u.account_status   = 'active'
          AND u.school_id        = ${schoolId}
          AND da.attendance_date = CURRENT_DATE
          AND da.deleted_at IS NULL
          ${attendanceMatch}
      `;
    } else if (type === 'FEE_REMINDER') {
      recipients = await sql`
        WITH pending_students AS (
          SELECT sf.student_id,
                 SUM(sf.amount_due - sf.discount - sf.amount_paid) AS balance
          FROM student_fees sf
          JOIN students s ON sf.student_id = s.id
            AND s.school_id = ${schoolId}
          WHERE sf.school_id = ${schoolId}
            AND sf.status IN ('pending', 'overdue', 'partial')
          GROUP BY sf.student_id
          HAVING SUM(sf.amount_due - sf.discount - sf.amount_paid) > 0
        )
        SELECT DISTINCT u.id, ps.balance
        FROM users u
        JOIN students s ON u.person_id = s.person_id
          AND s.school_id   = ${schoolId}
        JOIN pending_students ps ON s.id = ps.student_id
        WHERE u.account_status = 'active'
          AND u.school_id      = ${schoolId}
        UNION
        SELECT DISTINCT u.id, ps.balance
        FROM users u
        JOIN parents p ON u.person_id = p.person_id
        JOIN student_parents sp ON p.id = sp.parent_id
        JOIN students s ON sp.student_id = s.id
          AND s.school_id   = ${schoolId}
        JOIN pending_students ps ON sp.student_id = ps.student_id
        WHERE u.account_status = 'active'
          AND u.school_id      = ${schoolId}
      `;
    } else {
      // Generic broadcast — scoped to this school's active students + parents
      recipients = await sql`
        SELECT DISTINCT u.id
        FROM users u
        JOIN students s ON u.person_id = s.person_id
          AND s.school_id  = ${schoolId}
        JOIN student_enrollments se ON s.id = se.student_id
          AND se.school_id = ${schoolId}
        WHERE se.status        = 'active'
          AND u.account_status = 'active'
          AND u.school_id      = ${schoolId}
        UNION
        SELECT DISTINCT u.id
        FROM users u
        JOIN parents p ON u.person_id = p.person_id
        JOIN student_parents sp ON p.id = sp.parent_id
        JOIN students s ON sp.student_id = s.id
          AND s.school_id  = ${schoolId}
        JOIN student_enrollments se ON s.id = se.student_id
          AND se.school_id = ${schoolId}
        WHERE se.status        = 'active'
          AND u.account_status = 'active'
          AND u.school_id      = ${schoolId}
      `;
    }

    const totalUsers = recipients.length;

    if (totalUsers === 0) {
      return sendSuccess(res, req.schoolId, {
        message:       'No students found matching this criteria (e.g., no absentees today).',
        batch_id:      null,
        total_targets: 0,
      });
    }

    // AN7: batch record with school_id
    const [batch] = await sql`
      INSERT INTO notification_batches
        (school_id, admin_id, type, filters, status, total_targets)
      VALUES
        (${schoolId}, ${adminId}, 'TEST_TRIGGER', ${JSON.stringify({ type })}, 'processing', ${totalUsers})
      RETURNING id
    `;

    // Process async
    (async () => {
      try {
        let sentCount    = 0;
        let failureCount = 0;

        if (type === 'FEE_REMINDER') {
          const CHUNK_SIZE = 50;
          for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
            const chunk = recipients.slice(i, i + CHUNK_SIZE);
            await Promise.all(
              chunk.map(async (r) => {
                const amt  = parseFloat(r.balance || 0).toLocaleString('en-IN', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                });
                const msg = `Gentle reminder: Your child has pending fees of ₹${amt} due for this active term.`;
                const response = await sendNotificationToUsers(
                  [r.id],
                  type,
                  { message: msg },
                  { senderId: adminId, batchId: batch.id, role: 'test' }
                );
                if (response?.successCount) sentCount    += response.successCount;
                if (response?.failureCount) failureCount += response.failureCount;
              })
            );
          }
        } else {
          const userIds = recipients.map((r) => r.id);
          let payload   = {};
          const today   = new Date().toISOString().split('T')[0];

          if      (type === 'ATTENDANCE_ABSENT')    payload = { date: today };
          else if (type === 'ATTENDANCE_PRESENT')   payload = { message: 'Your child has arrived at school and is marked present.' };
          else if (type === 'DIARY_UPDATED')        payload = { message: "Please check today's diary to ensure your child is completing their work properly." };
          else if (type === 'RESULT_RELEASED')      payload = { message: "New exam results for your child are now available in the portal." };
          else if (type === 'NOTICE_ADMIN_STUDENT') payload = { message: "A new important notice has been issued by the administration." };
          else if (type === 'TIMETABLE_UPDATED')    payload = { message: "The class timetable has been updated. Please check the latest schedule." };
          else                                      payload = { message: `System notification check for ${type}.`, date: today };

          const response = await sendNotificationToUsers(
            userIds,
            type,
            payload,
            { senderId: adminId, batchId: batch.id, role: 'test' }
          );
          sentCount    = response?.successCount || 0;
          failureCount = response?.failureCount || 0;
        }

        await sql`
          UPDATE notification_batches
          SET status        = 'completed',
              sent_count    = ${sentCount},
              failure_count = ${failureCount},
              updated_at    = now()
          WHERE id        = ${batch.id}
            AND school_id = ${schoolId}
        `;
      } catch {
        await sql`
          UPDATE notification_batches
          SET status = 'failed'
          WHERE id        = ${batch.id}
            AND school_id = ${schoolId}
        `;
      }
    })();

    return sendSuccess(res, req.schoolId, { message: 'School-scoped test broadcast started', batch_id: batch.id, total_targets: totalUsers });
  })
);

// ── POST /diary/send-all ───────────────────────────────────────────────────────
// Triggers diary notifications for a class section belonging to this school.
// AN5: Ownership check on class_section_id before sending.
// AN7: notification_batches INSERT includes school_id.
// AN8: requireAuth + requirePermission guard.
router.post(
  '/diary/send-all',
  requireAuth,
  requirePermission('diary.manage'),
  asyncHandler(async (req, res) => {
    const { class_section_id, date, dryRun } = req.body;
    const adminId  = req.user.internal_id;
    const schoolId = req.schoolId;

    if (!class_section_id || !date) {
      return res.status(400).json({ error: 'class_section_id and date are required' });
    }

    if (await isPlatformKillSwitchActive()) {
      return res.status(503).json({ error: 'Notifications are globally paused via Kill Switch.' });
    }

    // AN5: Verify class_section belongs to this school
    const [ownedSection] = await sql`
      SELECT id FROM class_sections
      WHERE id        = ${class_section_id}
        AND school_id = ${schoolId}
    `;
    if (!ownedSection) {
      return res.status(404).json({ error: 'Class section not found' });
    }

    // Resolve recipients scoped to this school
    const recipients = await sql`
      SELECT DISTINCT u.id
      FROM users u
      JOIN students s ON u.person_id = s.person_id
        AND s.school_id  = ${schoolId}
      JOIN student_enrollments se ON s.id = se.student_id
        AND se.school_id = ${schoolId}
      WHERE se.class_section_id = ${class_section_id} AND school_id = ${req.schoolId}
        AND se.status           = 'active'
        AND u.account_status    = 'active'
        AND u.school_id         = ${schoolId}
      UNION
      SELECT DISTINCT u.id
      FROM users u
      JOIN parents p ON u.person_id = p.person_id
      JOIN student_parents sp ON p.id = sp.parent_id
      JOIN students s ON sp.student_id = s.id
        AND s.school_id  = ${schoolId}
      JOIN student_enrollments se ON s.id = se.student_id
        AND se.school_id = ${schoolId}
      WHERE se.class_section_id = ${class_section_id} AND school_id = ${req.schoolId}
        AND se.status           = 'active'
        AND u.account_status    = 'active'
        AND u.school_id         = ${schoolId}
    `;

    const totalUsers = recipients.length;

    if (dryRun) {
      return sendSuccess(res, req.schoolId, {
        message:      'Dry run successful',
        total_users:  totalUsers,
        sample_message: `New diary entry posted for ${date}.`,
      });
    }

    if (totalUsers === 0) {
      return res.status(400).json({ error: 'No reachable users found for this class section.' });
    }

    // AN7: batch with school_id
    const [batch] = await sql`
      INSERT INTO notification_batches
        (school_id, admin_id, type, filters, status, total_targets)
      VALUES
        (${schoolId}, ${adminId}, 'DIARY', ${JSON.stringify({ class_section_id, date })}, 'processing', ${totalUsers})
      RETURNING id
    `;

    (async () => {
      try {
        const userIds  = recipients.map((r) => r.id);
        const response = await sendNotificationToUsers(
          userIds,
          'DIARY_UPDATED',
          { message: `New diary entry posted for ${date}.` },
          { senderId: adminId, batchId: batch.id, role: 'student' }
        );
        const sentCount    = response?.successCount || 0;
        const failureCount = response?.failureCount || 0;

        await sql`
          UPDATE notification_batches
          SET status        = 'completed',
              sent_count    = ${sentCount},
              failure_count = ${failureCount},
              updated_at    = now()
          WHERE id        = ${batch.id}
            AND school_id = ${schoolId}
        `;
      } catch {
        await sql`
          UPDATE notification_batches
          SET status = 'failed'
          WHERE id        = ${batch.id}
            AND school_id = ${schoolId}
        `;
      }
    })();

    return sendSuccess(res, req.schoolId, { message: 'Diary batch processing started', batch_id: batch.id, total_targets: totalUsers });
  })
);

// ── POST /results/send-all ─────────────────────────────────────────────────────
// Triggers exam result notifications scoped to this school's class.
// AN6: Ownership check on class_id before sending.
// AN7: notification_batches INSERT includes school_id.
// AN8: requireAuth + requirePermission guard.
router.post(
  '/results/send-all',
  requireAuth,
  requirePermission('results.publish'),
  asyncHandler(async (req, res) => {
    const { exam_id, class_id, dryRun } = req.body;
    const adminId  = req.user.internal_id;
    const schoolId = req.schoolId;

    if (!exam_id || !class_id) {
      return res.status(400).json({ error: 'exam_id and class_id are required' });
    }

    if (await isPlatformKillSwitchActive()) {
      return res.status(503).json({ error: 'Notifications are globally paused via Kill Switch.' });
    }

    // AN6: Verify class belongs to this school
    const [ownedClass] = await sql`
      SELECT id FROM classes
      WHERE id        = ${class_id}
        AND school_id = ${schoolId}
    `;
    if (!ownedClass) {
      return res.status(404).json({ error: 'Class not found' });
    }

    // Verify exam belongs to this school
    const [exam] = await sql`
      SELECT name FROM exams
      WHERE id        = ${exam_id}
        AND school_id = ${schoolId}
    `;
    if (!exam) return res.status(404).json({ error: 'Exam not found' });

    const recipients = await sql`
      SELECT DISTINCT u.id
      FROM users u
      JOIN students s ON u.person_id = s.person_id
        AND s.school_id  = ${schoolId}
      JOIN student_enrollments se ON s.id = se.student_id
        AND se.school_id = ${schoolId}
      JOIN class_sections cs ON se.class_section_id = cs.id
        AND cs.school_id = ${schoolId}
      WHERE cs.class_id      = ${class_id}
        AND se.status        = 'active'
        AND u.account_status = 'active'
        AND u.school_id      = ${schoolId}
      UNION
      SELECT DISTINCT u.id
      FROM users u
      JOIN parents p ON u.person_id = p.person_id
      JOIN student_parents sp ON p.id = sp.parent_id
      JOIN students s ON sp.student_id = s.id
        AND s.school_id  = ${schoolId}
      JOIN student_enrollments se ON s.id = se.student_id
        AND se.school_id = ${schoolId}
      JOIN class_sections cs ON se.class_section_id = cs.id
        AND cs.school_id = ${schoolId}
      WHERE cs.class_id      = ${class_id}
        AND se.status        = 'active'
        AND u.account_status = 'active'
        AND u.school_id      = ${schoolId}
    `;

    const totalUsers = recipients.length;

    if (dryRun) {
      return sendSuccess(res, req.schoolId, {
        message:        'Dry run successful',
        total_users:    totalUsers,
        sample_message: `Results for ${exam.name} have been published.`,
      });
    }

    if (totalUsers === 0) {
      return res.status(400).json({ error: 'No reachable users found for this class.' });
    }

    // AN7: batch with school_id
    const [batch] = await sql`
      INSERT INTO notification_batches
        (school_id, admin_id, type, filters, status, total_targets)
      VALUES
        (${schoolId}, ${adminId}, 'RESULTS', ${JSON.stringify({ exam_id, class_id })}, 'processing', ${totalUsers})
      RETURNING id
    `;

    (async () => {
      try {
        const userIds  = recipients.map((r) => r.id);
        const response = await sendNotificationToUsers(
          userIds,
          'RESULT_RELEASED',
          { message: `Results for ${exam.name} have been published.` },
          { senderId: adminId, batchId: batch.id, role: 'student' }
        );
        const sentCount    = response?.successCount || 0;
        const failureCount = response?.failureCount || 0;

        await sql`
          UPDATE notification_batches
          SET status        = 'completed',
              sent_count    = ${sentCount},
              failure_count = ${failureCount},
              updated_at    = now()
          WHERE id        = ${batch.id}
            AND school_id = ${schoolId}
        `;
      } catch {
        await sql`
          UPDATE notification_batches
          SET status = 'failed'
          WHERE id        = ${batch.id}
            AND school_id = ${schoolId}
        `;
      }
    })();

    return sendSuccess(res, req.schoolId, { message: 'Results batch processing started', batch_id: batch.id, total_targets: totalUsers });
  })
);

// ── POST /notices/retrigger ────────────────────────────────────────────────────
// Retriggers a notice notification. Notice must belong to this school.
// AN3: Ownership check on notice before querying recipients.
// AN7: notification_batches INSERT includes school_id.
// AN8: requireAuth + requirePermission guard.
router.post(
  '/notices/retrigger',
  requireAuth,
  requirePermission('notices.manage'),
  asyncHandler(async (req, res) => {
    const { notice_id, dryRun } = req.body;
    const adminId  = req.user.internal_id;
    const schoolId = req.schoolId;

    if (!notice_id) return res.status(400).json({ error: 'notice_id is required' });

    if (await isPlatformKillSwitchActive()) {
      return res.status(503).json({ error: 'Notifications are globally paused via Kill Switch.' });
    }

    // AN3: Ownership check — notice must belong to this school (404 on miss)
    const [notice] = await sql`
      SELECT title, audience, target_class_id
      FROM notices
      WHERE id        = ${notice_id}
        AND school_id = ${schoolId}
    `;
    if (!notice) return res.status(404).json({ error: 'Notice not found' });

    const safeAudience      = notice.audience;
    const safeTargetClassId = notice.target_class_id;

    let recips = [];

    // AN3: Downstream recipient queries also scoped to schoolId
    if (safeAudience === 'class' && safeTargetClassId) {
      recips = await sql`
        SELECT DISTINCT u.id FROM users u
        JOIN students s ON u.person_id = s.person_id
          AND s.school_id  = ${schoolId}
        JOIN student_enrollments se ON s.id = se.student_id
          AND se.school_id = ${schoolId}
        JOIN class_sections cs ON se.class_section_id = cs.id
          AND cs.school_id = ${schoolId}
        WHERE cs.class_id      = ${safeTargetClassId}
          AND se.status        = 'active'
          AND u.account_status = 'active'
          AND u.school_id      = ${schoolId}
        UNION
        SELECT DISTINCT u.id FROM users u
        JOIN parents p ON u.person_id = p.person_id
        JOIN student_parents sp ON p.id = sp.parent_id
        JOIN students s ON sp.student_id = s.id
          AND s.school_id  = ${schoolId}
        JOIN student_enrollments se ON s.id = se.student_id
          AND se.school_id = ${schoolId}
        JOIN class_sections cs ON se.class_section_id = cs.id
          AND cs.school_id = ${schoolId}
        WHERE cs.class_id      = ${safeTargetClassId}
          AND se.status        = 'active'
          AND u.account_status = 'active'
          AND u.school_id      = ${schoolId}
      `;
    } else if (safeAudience === 'all') {
      recips = await sql`
        SELECT DISTINCT u.id FROM users u
        JOIN students s ON u.person_id = s.person_id
          AND s.school_id  = ${schoolId}
        JOIN student_enrollments se ON s.id = se.student_id
          AND se.school_id = ${schoolId}
        WHERE se.status        = 'active'
          AND u.account_status = 'active'
          AND u.school_id      = ${schoolId}
        UNION
        SELECT DISTINCT u.id FROM users u
        JOIN parents p ON u.person_id = p.person_id
        JOIN student_parents sp ON p.id = sp.parent_id
        JOIN students s ON sp.student_id = s.id
          AND s.school_id  = ${schoolId}
        JOIN student_enrollments se ON s.id = se.student_id
          AND se.school_id = ${schoolId}
        WHERE se.status        = 'active'
          AND u.account_status = 'active'
          AND u.school_id      = ${schoolId}
      `;
    }

    const totalUsers = recips.length;

    if (dryRun) {
      return sendSuccess(res, req.schoolId, { message: 'Dry run successful', total_users: totalUsers, sample_message: `Important Notice: ${notice.title}` });
    }

    if (totalUsers === 0) return res.status(400).json({ error: 'No reachable users found for this notice.' });

    // AN7: batch with school_id
    const [batch] = await sql`
      INSERT INTO notification_batches
        (school_id, admin_id, type, filters, status, total_targets)
      VALUES
        (${schoolId}, ${adminId}, 'NOTICE', ${JSON.stringify({ notice_id })}, 'processing', ${totalUsers})
      RETURNING id
    `;

    (async () => {
      try {
        const userIds  = recips.map((r) => r.id);
        const response = await sendNotificationToUsers(
          userIds,
          'NOTICE_ADMIN_STUDENT',
          { message: `Important Notice: ${notice.title}` },
          { senderId: adminId, batchId: batch.id, role: 'all' }
        );
        const sentCount    = response?.successCount || 0;
        const failureCount = response?.failureCount || 0;

        await sql`
          UPDATE notification_batches
          SET status        = 'completed',
              sent_count    = ${sentCount},
              failure_count = ${failureCount},
              updated_at    = now()
          WHERE id        = ${batch.id}
            AND school_id = ${schoolId}
        `;
      } catch {
        await sql`
          UPDATE notification_batches
          SET status = 'failed'
          WHERE id        = ${batch.id}
            AND school_id = ${schoolId}
        `;
      }
    })();

    return sendSuccess(res, req.schoolId, { message: 'Notice retrigger started', batch_id: batch.id, total_targets: totalUsers });
  })
);

// ── POST /access-response ──────────────────────────────────────────────────────
// Sends a push notification to a user about their access request.
// This route targets a specific user_id — the user must belong to this school.
// AN8: requireAuth + requirePermission guard.
router.post(
  '/access-response',
  requireAuth,
  requirePermission('dashboard.view'),
  asyncHandler(async (req, res) => {
    const { user_id, status } = req.body;
    const adminId  = req.user.internal_id;
    const schoolId = req.schoolId;

    if (!user_id || !status) {
      return res.status(400).json({ error: 'user_id and status are required' });
    }

    if (await isPlatformKillSwitchActive()) {
      return res.status(503).json({ error: 'Notifications are globally paused via Kill Switch.' });
    }

    // Ensure the target user belongs to this school
    const [targetUser] = await sql`
      SELECT id FROM users
      WHERE id        = ${user_id}
        AND school_id = ${schoolId}
        AND deleted_at IS NULL
    `;
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const msg =
      status === 'approved'
        ? 'Your request for out-of-hours access has been GRANTED until midnight tonight.'
        : 'Your request for out-of-hours access has been DENIED.';

    try {
      const response = await sendNotificationToUsers(
        [user_id],
        'ACCESS_RESPONSE',
        { message: msg },
        { senderId: adminId, role: 'accounts' }
      );
      return sendSuccess(res, req.schoolId, {
        success:      true,
        sentCount:    response?.successCount || 0,
        failureCount: response?.failureCount || 0,
      });
    } catch {
      res.status(500).json({ error: 'Failed to send notification' });
    }
  })
);

export default router;
