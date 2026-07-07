import sql from '../db.js';
import { sendNotificationToUsersWithReport } from './notificationService.js';

const DISPATCH_CHUNK_SIZE = 50;

const BROADCAST_TRIGGER_TYPES = new Set([
  'FEE_REMINDER',
  'DIARY_UPDATED',
  'RESULT_RELEASED',
  'NOTICE_ADMIN_STUDENT',
  'ATTENDANCE_ABSENT',
  'ATTENDANCE_PRESENT',
  'TIMETABLE_UPDATED',
]);

function assertBroadcastType(channelType) {
  if (!BROADCAST_TRIGGER_TYPES.has(channelType)) {
    throw new Error(`Unsupported broadcast channel type: ${channelType}`);
  }
}

function normalizeClassIds(classIds) {
  if (!Array.isArray(classIds)) return [];
  return [...new Set(classIds.filter(Boolean))];
}

/**
 * Optional section filter — reserved for a future section-level release (unused in v1).
 */
function normalizeSectionIds(sectionIds) {
  if (!Array.isArray(sectionIds)) return [];
  return [...new Set(sectionIds.filter(Boolean))];
}

function buildClassFilterClause(classIds, sectionIds) {
  const classes = normalizeClassIds(classIds);
  const sections = normalizeSectionIds(sectionIds);

  if (sections.length > 0) {
    return sql`AND cs.section_id = ANY(${sections})`;
  }
  if (classes.length > 0) {
    return sql`AND cs.class_id = ANY(${classes})`;
  }
  return sql``;
}

function buildPayload(channelType, extra = {}) {
  const today = new Date().toISOString().split('T')[0];

  if (channelType === 'ATTENDANCE_ABSENT') return { date: today };
  if (channelType === 'ATTENDANCE_PRESENT') {
    return { message: 'Your child has arrived at school and is marked present.' };
  }
  if (channelType === 'DIARY_UPDATED') {
    return { message: "Please check today's diary to ensure your child is completing their work properly." };
  }
  if (channelType === 'RESULT_RELEASED') {
    return { message: 'New exam results for your child are now available in the portal.' };
  }
  if (channelType === 'NOTICE_ADMIN_STUDENT') {
    return { message: 'A new important notice has been issued by the administration.' };
  }
  if (channelType === 'TIMETABLE_UPDATED') {
    return { message: 'The class timetable has been updated. Please check the latest schedule.' };
  }
  if (channelType === 'FEE_REMINDER') return extra;
  return { message: `System notification check for ${channelType}.`, date: today };
}

/**
 * Class list with type-aware recipient counts (distinct active student + parent users).
 */
export async function getClassTargets(schoolId, channelType) {
  assertBroadcastType(channelType);

  const classes = await sql`
    SELECT c.id, c.name, c.code
    FROM classes c
    WHERE c.school_id = ${schoolId}
      AND c.deleted_at IS NULL
    ORDER BY c.name ASC
  `;

  const targets = [];
  for (const cls of classes) {
    const recipients = await resolveRecipients(schoolId, {
      classIds: [cls.id],
      sectionIds: [],
      channelType,
    });
    targets.push({
      class_id: cls.id,
      class_name: cls.name,
      class_code: cls.code,
      recipient_count: recipients.length,
    });
  }

  const allRecipients = await resolveRecipients(schoolId, {
    classIds: [],
    sectionIds: [],
    channelType,
  });

  return {
    classes: targets,
    all_school_recipient_count: allRecipients.length,
  };
}

/**
 * Resolve broadcast recipients for a channel, optionally scoped to classes (v1) or sections (future).
 */
export async function resolveRecipients(schoolId, { classIds = [], sectionIds = [], channelType }) {
  assertBroadcastType(channelType);
  const classFilter = buildClassFilterClause(classIds, sectionIds);

  if (channelType === 'ATTENDANCE_ABSENT' || channelType === 'ATTENDANCE_PRESENT') {
    const targetStatus = channelType === 'ATTENDANCE_ABSENT' ? 'absent' : 'present';
    return sql`
      SELECT DISTINCT u.id
      FROM users u
      JOIN students s ON u.person_id = s.person_id
        AND s.school_id = ${schoolId}
      JOIN student_enrollments se ON s.id = se.student_id
        AND se.school_id = ${schoolId}
      JOIN class_sections cs ON se.class_section_id = cs.id
        AND cs.school_id = ${schoolId}
      JOIN daily_attendance da ON da.student_enrollment_id = se.id
      WHERE se.status = 'active'
        AND u.account_status = 'active'
        AND u.school_id = ${schoolId}
        AND da.attendance_date = CURRENT_DATE
        AND da.status = ${targetStatus}
        ${classFilter}
      UNION
      SELECT DISTINCT u.id
      FROM users u
      JOIN parents p ON u.person_id = p.person_id
      JOIN student_parents sp ON p.id = sp.parent_id
      JOIN students s ON sp.student_id = s.id
        AND s.school_id = ${schoolId}
      JOIN student_enrollments se ON s.id = se.student_id
        AND se.school_id = ${schoolId}
      JOIN class_sections cs ON se.class_section_id = cs.id
        AND cs.school_id = ${schoolId}
      JOIN daily_attendance da ON da.student_enrollment_id = se.id
      WHERE se.status = 'active'
        AND u.account_status = 'active'
        AND u.school_id = ${schoolId}
        AND da.attendance_date = CURRENT_DATE
        AND da.status = ${targetStatus}
        ${classFilter}
    `;
  }

  if (channelType === 'FEE_REMINDER') {
    return sql`
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
        AND s.school_id = ${schoolId}
      JOIN pending_students ps ON s.id = ps.student_id
      JOIN student_enrollments se ON s.id = se.student_id
        AND se.school_id = ${schoolId}
      JOIN class_sections cs ON se.class_section_id = cs.id
        AND cs.school_id = ${schoolId}
      WHERE u.account_status = 'active'
        AND u.school_id = ${schoolId}
        AND se.status = 'active'
        ${classFilter}
      UNION
      SELECT DISTINCT u.id, ps.balance
      FROM users u
      JOIN parents p ON u.person_id = p.person_id
      JOIN student_parents sp ON p.id = sp.parent_id
      JOIN students s ON sp.student_id = s.id
        AND s.school_id = ${schoolId}
      JOIN pending_students ps ON sp.student_id = ps.student_id
      JOIN student_enrollments se ON s.id = se.student_id
        AND se.school_id = ${schoolId}
      JOIN class_sections cs ON se.class_section_id = cs.id
        AND cs.school_id = ${schoolId}
      WHERE u.account_status = 'active'
        AND u.school_id = ${schoolId}
        AND se.status = 'active'
        ${classFilter}
    `;
  }

  return sql`
    SELECT DISTINCT u.id
    FROM users u
    JOIN students s ON u.person_id = s.person_id
      AND s.school_id = ${schoolId}
    JOIN student_enrollments se ON s.id = se.student_id
      AND se.school_id = ${schoolId}
    JOIN class_sections cs ON se.class_section_id = cs.id
      AND cs.school_id = ${schoolId}
    WHERE se.status = 'active'
      AND u.account_status = 'active'
      AND u.school_id = ${schoolId}
      ${classFilter}
    UNION
    SELECT DISTINCT u.id
    FROM users u
    JOIN parents p ON u.person_id = p.person_id
    JOIN student_parents sp ON p.id = sp.parent_id
    JOIN students s ON sp.student_id = s.id
      AND s.school_id = ${schoolId}
    JOIN student_enrollments se ON s.id = se.student_id
      AND se.school_id = ${schoolId}
    JOIN class_sections cs ON se.class_section_id = cs.id
      AND cs.school_id = ${schoolId}
    WHERE se.status = 'active'
      AND u.account_status = 'active'
      AND u.school_id = ${schoolId}
      ${classFilter}
  `;
}

async function persistRecipientRows(schoolId, batchId, recipientRows) {
  if (!recipientRows.length) return;

  for (const row of recipientRows) {
    await sql`
      INSERT INTO notification_dispatch_recipients
        (school_id, batch_id, user_id, fcm_token, status, error_code)
      VALUES
        (${schoolId}, ${batchId}, ${row.user_id}, ${row.fcm_token}, ${row.status}, ${row.error_code})
    `;
  }
}

async function finalizeBatch(batchId, schoolId, summary, status = 'completed') {
  await sql`
    UPDATE notification_batches
    SET status = ${status},
        sent_count = ${summary.sentCount},
        failure_count = ${summary.failureCount},
        no_token_count = ${summary.noTokenCount},
        tokens_targeted = ${summary.tokensTargeted},
        updated_at = now()
    WHERE id = ${batchId}
      AND school_id = ${schoolId}
  `;
}

async function updateBatchProgress(batchId, schoolId, summary, status = 'processing') {
  await sql`
    UPDATE notification_batches
    SET status = ${status},
        sent_count = ${summary.sentCount},
        failure_count = ${summary.failureCount},
        no_token_count = ${summary.noTokenCount},
        tokens_targeted = ${summary.tokensTargeted},
        updated_at = now()
    WHERE id = ${batchId}
      AND school_id = ${schoolId}
  `;
}

async function dispatchFeeReminder(schoolId, recipients, channelType, adminId, batchId) {
  const summary = {
    sentCount: 0,
    failureCount: 0,
    noTokenCount: 0,
    tokensTargeted: 0,
  };

  for (let i = 0; i < recipients.length; i += DISPATCH_CHUNK_SIZE) {
    const chunk = recipients.slice(i, i + DISPATCH_CHUNK_SIZE);
    const chunkReports = await Promise.all(
      chunk.map(async (recipient) => {
        const amt = parseFloat(recipient.balance || 0).toLocaleString('en-IN', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        const msg = `Gentle reminder: Your child has pending fees of ₹${amt} due for this active term.`;
        const report = await sendNotificationToUsersWithReport(
          [recipient.id],
          channelType,
          { message: msg },
          { senderId: adminId, batchId, role: 'broadcast' }
        );
        return report;
      })
    );

    const chunkRows = [];
    for (const report of chunkReports) {
      summary.sentCount += report.successCount;
      summary.failureCount += report.failureCount;
      summary.noTokenCount += report.noTokenCount;
      summary.tokensTargeted += report.successCount + report.failureCount;
      chunkRows.push(...report.recipientRows);
    }

    await persistRecipientRows(schoolId, batchId, chunkRows);
    await updateBatchProgress(batchId, schoolId, summary);
  }

  return { summary };
}

async function dispatchStandard(schoolId, recipients, channelType, adminId, batchId) {
  const summary = {
    sentCount: 0,
    failureCount: 0,
    noTokenCount: 0,
    tokensTargeted: 0,
  };

  for (let i = 0; i < recipients.length; i += DISPATCH_CHUNK_SIZE) {
    const chunk = recipients.slice(i, i + DISPATCH_CHUNK_SIZE);
    const userIds = chunk.map((r) => r.id);
    const report = await sendNotificationToUsersWithReport(
      userIds,
      channelType,
      buildPayload(channelType),
      { senderId: adminId, batchId, role: 'broadcast' }
    );

    summary.sentCount += report.successCount;
    summary.failureCount += report.failureCount;
    summary.noTokenCount += report.noTokenCount;
    summary.tokensTargeted += report.successCount + report.failureCount;

    await persistRecipientRows(schoolId, batchId, report.recipientRows);
    await updateBatchProgress(batchId, schoolId, summary);
  }

  return { summary };
}

async function runDispatch(batchId, schoolId, adminId, channelType, recipients) {
  try {
    let outcome;
    if (channelType === 'FEE_REMINDER') {
      outcome = await dispatchFeeReminder(schoolId, recipients, channelType, adminId, batchId);
    } else {
      outcome = await dispatchStandard(schoolId, recipients, channelType, adminId, batchId);
    }

    await finalizeBatch(batchId, schoolId, outcome.summary, 'completed');

    return {
      batch_id: batchId,
      status: 'completed',
      total_targets: recipients.length,
      sent_count: outcome.summary.sentCount,
      failure_count: outcome.summary.failureCount,
      no_token_count: outcome.summary.noTokenCount,
      tokens_targeted: outcome.summary.tokensTargeted,
      remaining_count: Math.max(
        recipients.length -
          outcome.summary.sentCount -
          outcome.summary.failureCount -
          outcome.summary.noTokenCount,
        0
      ),
    };
  } catch (err) {
    console.error('[Broadcast Dispatch] runDispatch error:', err);
    await sql`
      UPDATE notification_batches
      SET status = 'failed', updated_at = now()
      WHERE id = ${batchId}
        AND school_id = ${schoolId}
    `;
    throw err;
  }
}

/**
 * Create and run a broadcast dispatch.
 * All broadcasts run asynchronously; clients poll GET /broadcast/:batchId for progress.
 */
export async function dispatchBroadcast({
  schoolId,
  adminId,
  channelType,
  classIds = [],
  sectionIds = [],
  parentBatchId = null,
}) {
  assertBroadcastType(channelType);

  const normalizedClassIds = normalizeClassIds(classIds);
  const isClassTargeted = normalizedClassIds.length > 0 || normalizeSectionIds(sectionIds).length > 0;

  const recipients = await resolveRecipients(schoolId, {
    classIds: normalizedClassIds,
    sectionIds,
    channelType,
  });

  const filters = {
    channel_type: channelType,
    class_ids: normalizedClassIds,
    section_ids: normalizeSectionIds(sectionIds),
  };
  if (parentBatchId) filters.parent_batch_id = parentBatchId;

  const [batch] = await sql`
    INSERT INTO notification_batches (
      school_id,
      admin_id,
      type,
      channel_type,
      target_class_ids,
      parent_batch_id,
      filters,
      status,
      total_targets
    ) VALUES (
      ${schoolId},
      ${adminId},
      'BROADCAST',
      ${channelType},
      ${normalizedClassIds.length > 0 ? normalizedClassIds : null},
      ${parentBatchId},
      ${JSON.stringify(filters)},
      'processing',
      ${recipients.length}
    )
    RETURNING id
  `;

  if (recipients.length === 0) {
    const emptySummary = { sentCount: 0, failureCount: 0, noTokenCount: 0, tokensTargeted: 0 };
    await finalizeBatch(batch.id, schoolId, emptySummary, 'completed');
    return {
      batch_id: batch.id,
      status: 'completed',
      mode: 'async',
      total_targets: 0,
      sent_count: 0,
      failure_count: 0,
      no_token_count: 0,
      tokens_targeted: 0,
      remaining_count: 0,
      message: 'No recipients matched the selected criteria.',
    };
  }

  setImmediate(() => {
    runDispatch(batch.id, schoolId, adminId, channelType, recipients).catch(() => {});
  });

  return {
    batch_id: batch.id,
    status: 'processing',
    mode: 'async',
    total_targets: recipients.length,
    sent_count: 0,
    failure_count: 0,
    no_token_count: 0,
    tokens_targeted: 0,
    remaining_count: recipients.length,
    message: isClassTargeted
      ? 'Class broadcast started. Poll GET /broadcast/:batchId for progress.'
      : 'All-school broadcast started. Poll GET /broadcast/:batchId for progress.',
  };
}

export async function getBroadcastStatus(batchId, schoolId) {
  const [batch] = await sql`
    SELECT
      id,
      type,
      channel_type,
      target_class_ids,
      parent_batch_id,
      filters,
      status,
      total_targets,
      sent_count,
      failure_count,
      no_token_count,
      tokens_targeted,
      created_at,
      updated_at
    FROM notification_batches
    WHERE id = ${batchId}
      AND school_id = ${schoolId}
      AND type = 'BROADCAST'
  `;

  if (!batch) return null;

  const failureRows = await sql`
    SELECT
      ndr.user_id,
      ndr.fcm_token,
      ndr.error_code,
      u.account_status
    FROM notification_dispatch_recipients ndr
    JOIN users u ON u.id = ndr.user_id
    WHERE ndr.batch_id = ${batchId}
      AND ndr.school_id = ${schoolId}
      AND ndr.status = 'failed'
    ORDER BY ndr.created_at ASC
    LIMIT 200
  `;

  return {
    batch_id: batch.id,
    channel_type: batch.channel_type,
    target_class_ids: batch.target_class_ids,
    parent_batch_id: batch.parent_batch_id,
    status: batch.status,
    total_targets: batch.total_targets,
    sent_count: batch.sent_count,
    failure_count: batch.failure_count,
    no_token_count: batch.no_token_count,
    tokens_targeted: batch.tokens_targeted,
    remaining_count: Math.max(
      (batch.total_targets ?? 0) -
        (batch.sent_count ?? 0) -
        (batch.failure_count ?? 0) -
        (batch.no_token_count ?? 0),
      0
    ),
    created_at: batch.created_at,
    updated_at: batch.updated_at,
    failed_recipients: failureRows,
  };
}

/**
 * Retry failed recipients from a prior batch.
 * Creates a NEW batch linked via parent_batch_id; original rows are never mutated.
 */
export async function retryBroadcast(batchId, schoolId, adminId) {
  const [sourceBatch] = await sql`
    SELECT id, channel_type, filters
    FROM notification_batches
    WHERE id = ${batchId}
      AND school_id = ${schoolId}
      AND type = 'BROADCAST'
  `;

  if (!sourceBatch) {
    throw new Error('Broadcast batch not found');
  }

  if (sourceBatch.status === 'processing') {
    throw new Error('Source batch is still processing');
  }

  const failedUsers = await sql`
    SELECT DISTINCT ndr.user_id AS id
    FROM notification_dispatch_recipients ndr
    WHERE ndr.batch_id = ${batchId}
      AND ndr.school_id = ${schoolId}
      AND ndr.status = 'failed'
  `;

  if (failedUsers.length === 0) {
    throw new Error('No failed recipients to retry');
  }

  const channelType = sourceBatch.channel_type;
  const filters = sourceBatch.filters || {};
  const classIds = filters.class_ids || [];
  const sectionIds = filters.section_ids || [];

  const [retryBatch] = await sql`
    INSERT INTO notification_batches (
      school_id,
      admin_id,
      type,
      channel_type,
      target_class_ids,
      parent_batch_id,
      filters,
      status,
      total_targets
    ) VALUES (
      ${schoolId},
      ${adminId},
      'BROADCAST',
      ${channelType},
      ${classIds.length > 0 ? classIds : null},
      ${batchId},
      ${JSON.stringify({ ...filters, retry_of: batchId })},
      'processing',
      ${failedUsers.length}
    )
    RETURNING id
  `;

  let recipients = failedUsers;
  if (channelType === 'FEE_REMINDER') {
    const userIds = failedUsers.map((r) => r.id);
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
      SELECT u.id, MAX(ps.balance) AS balance
      FROM users u
      JOIN students s ON u.person_id = s.person_id
        AND s.school_id = ${schoolId}
      JOIN pending_students ps ON s.id = ps.student_id
      WHERE u.id = ANY(${userIds})
        AND u.school_id = ${schoolId}
      GROUP BY u.id
      UNION
      SELECT u.id, MAX(ps.balance) AS balance
      FROM users u
      JOIN parents p ON u.person_id = p.person_id
      JOIN student_parents sp ON p.id = sp.parent_id
      JOIN pending_students ps ON sp.student_id = ps.student_id
      WHERE u.id = ANY(${userIds})
        AND u.school_id = ${schoolId}
      GROUP BY u.id
    `;

    if (recipients.length === 0) {
      recipients = failedUsers.map((r) => ({ id: r.id, balance: 0 }));
    }
  }

  const result = await runDispatch(retryBatch.id, schoolId, adminId, channelType, recipients);
  return {
    ...result,
    parent_batch_id: batchId,
    mode: 'sync',
  };
}
