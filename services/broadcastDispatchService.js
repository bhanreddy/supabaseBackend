import sql from '../db.js';
import { sendNotificationToUsersWithReport } from './notificationService.js';

const DISPATCH_CHUNK_SIZE = 50;
// Fee reminders render a different amount for every recipient, so each recipient
// needs an individual FCM send. Never launch a whole 50-recipient database/FCM
// fan-out at once: it can exhaust the 10-connection database pool and progress
// remains at zero until the slowest promise settles.
const FEE_REMINDER_CHUNK_SIZE = 5;
const TARGET_COUNT_CONCURRENCY = 4;
const DB_WRITE_RETRIES = 3;

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
    const error = new Error(`Unsupported broadcast channel type: ${channelType}`);
    error.status = 400;
    throw error;
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

export function normalizeFeePaidRange(range = {}) {
  const min = range.min == null || range.min === '' ? 0 : Number(range.min);
  const max = range.max == null || range.max === '' ? 100 : Number(range.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 100 || min > max) {
    const error = new Error('Fee paid range must be between 0 and 100, with minimum not greater than maximum');
    error.status = 400;
    throw error;
  }
  return { min, max };
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

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function isTransientDatabaseError(error) {
  return ['40001', '40P01', '53300', '57P01', '08000', '08003', '08006', 'ETIMEDOUT', 'ECONNRESET']
    .includes(error?.code);
}

async function withDatabaseRetry(operation, label) {
  let lastError;
  for (let attempt = 1; attempt <= DB_WRITE_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientDatabaseError(error) || attempt === DB_WRITE_RETRIES) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 150));
    }
  }
  console.error(`[Broadcast Dispatch] ${label} failed`, lastError);
  throw lastError;
}

/**
 * Class list with type-aware recipient counts (distinct active student + parent users).
 */
export async function getClassTargets(schoolId, channelType, feePaidRange = {}) {
  assertBroadcastType(channelType);

  const classes = await sql`
    SELECT c.id, c.name, c.code
    FROM classes c
    WHERE c.school_id = ${schoolId}
      AND c.deleted_at IS NULL
    ORDER BY c.name ASC
  `;

  const targets = await mapWithConcurrency(classes, TARGET_COUNT_CONCURRENCY, async (cls) => {
    const recipients = await resolveRecipients(schoolId, {
      classIds: [cls.id],
      sectionIds: [],
      channelType,
      feePaidRange,
    });
    return {
      class_id: cls.id,
      class_name: cls.name,
      class_code: cls.code,
      recipient_count: recipients.length,
    };
  });

  const allRecipients = await resolveRecipients(schoolId, {
    classIds: [],
    sectionIds: [],
    channelType,
    feePaidRange,
  });

  return {
    classes: targets,
    all_school_recipient_count: allRecipients.length,
  };
}

/**
 * Resolve broadcast recipients for a channel, optionally scoped to classes (v1) or sections (future).
 */
export async function resolveRecipients(
  schoolId,
  { classIds = [], sectionIds = [], channelType, feePaidRange = {} }
) {
  assertBroadcastType(channelType);
  const classFilter = buildClassFilterClause(classIds, sectionIds);

  if (channelType === 'ATTENDANCE_ABSENT' || channelType === 'ATTENDANCE_PRESENT') {
    // Attendance is marked in two sessions (morning + afternoon). The day-level
    // `daily_attendance.status` is a DERIVED value that only becomes 'present'
    // once BOTH sessions are attended — a morning-only mark computes to
    // 'half_day'. So keying these notifications off `status` makes them show 0
    // recipients until the afternoon is also marked. Arrival/absence are morning
    // signals, so match the morning session directly (falling back to the legacy
    // day-level status for older single-write rows that have no session columns).
    const attendanceMatch =
      channelType === 'ATTENDANCE_PRESENT'
        ? sql`AND (
            da.morning_status IN ('present', 'late')
            OR (da.morning_status IS NULL AND da.status IN ('present', 'late', 'half_day'))
          )`
        : sql`AND (
            da.morning_status = 'absent'
            OR (da.morning_status IS NULL AND da.status = 'absent')
          )`;
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
        AND da.deleted_at IS NULL
        ${attendanceMatch}
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
        AND da.deleted_at IS NULL
        ${attendanceMatch}
        ${classFilter}
    `;
  }

  if (channelType === 'FEE_REMINDER') {
    const paidRange = normalizeFeePaidRange(feePaidRange);
    return sql`
      WITH fee_totals AS (
        SELECT
          sf.student_id,
          SUM(GREATEST(sf.amount_due - sf.discount, 0)) AS net_due,
          SUM(GREATEST(sf.amount_paid, 0)) AS paid_amount,
          SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)) AS balance
        FROM student_fees sf
        JOIN students s ON sf.student_id = s.id
          AND s.school_id = ${schoolId}
        WHERE sf.school_id = ${schoolId}
          AND sf.deleted_at IS NULL
        GROUP BY sf.student_id
      ),
      pending_students AS (
        SELECT
          student_id,
          balance,
          CASE
            WHEN net_due <= 0 THEN 0
            ELSE LEAST(100, (paid_amount / net_due) * 100)
          END AS paid_percentage
        FROM fee_totals
        WHERE balance > 0
      )
      SELECT recipient.id, SUM(recipient.balance) AS balance, MIN(recipient.paid_percentage) AS paid_percentage
      FROM (
        SELECT DISTINCT u.id, s.id AS student_id, ps.balance, ps.paid_percentage
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
          AND ps.paid_percentage BETWEEN ${paidRange.min} AND ${paidRange.max}
          ${classFilter}
        UNION ALL
        SELECT DISTINCT u.id, s.id AS student_id, ps.balance, ps.paid_percentage
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
          AND ps.paid_percentage BETWEEN ${paidRange.min} AND ${paidRange.max}
          ${classFilter}
      ) recipient
      GROUP BY recipient.id
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

  for (let i = 0; i < recipientRows.length; i += 100) {
    const rows = recipientRows.slice(i, i + 100).map((row) => ({
      school_id: schoolId,
      batch_id: batchId,
      user_id: row.user_id,
      fcm_token: row.fcm_token,
      status: row.status,
      error_code: row.error_code,
    }));
    await withDatabaseRetry(
      () => sql`INSERT INTO notification_dispatch_recipients ${sql(
        rows,
        'school_id', 'batch_id', 'user_id', 'fcm_token', 'status', 'error_code'
      )}`,
      'recipient audit insert'
    );
  }
}

async function finalizeBatch(batchId, schoolId, summary, status = 'completed') {
  await withDatabaseRetry(() => sql`
    UPDATE notification_batches
    SET status = ${status},
        sent_count = ${summary.sentCount},
        failure_count = ${summary.failureCount},
        no_token_count = ${summary.noTokenCount},
        tokens_targeted = ${summary.tokensTargeted},
        updated_at = now()
    WHERE id = ${batchId}
      AND school_id = ${schoolId}
  `, 'batch finalization');
}

async function updateBatchProgress(batchId, schoolId, summary, status = 'processing') {
  await withDatabaseRetry(() => sql`
    UPDATE notification_batches
    SET status = ${status},
        sent_count = ${summary.sentCount},
        failure_count = ${summary.failureCount},
        no_token_count = ${summary.noTokenCount},
        tokens_targeted = ${summary.tokensTargeted},
        updated_at = now()
    WHERE id = ${batchId}
      AND school_id = ${schoolId}
  `, 'batch progress update');
}

export async function dispatchFeeReminder(
  schoolId,
  recipients,
  channelType,
  adminId,
  batchId,
  {
    sendNotification = sendNotificationToUsersWithReport,
    persistRows = persistRecipientRows,
    writeProgress = updateBatchProgress,
    chunkSize = FEE_REMINDER_CHUNK_SIZE,
  } = {}
) {
  const summary = {
    sentCount: 0,
    failureCount: 0,
    noTokenCount: 0,
    tokensTargeted: 0,
  };

  for (let i = 0; i < recipients.length; i += chunkSize) {
    const chunk = recipients.slice(i, i + chunkSize);
    const chunkReports = await Promise.allSettled(
      chunk.map(async (recipient) => {
        const amt = parseFloat(recipient.balance || 0).toLocaleString('en-IN', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        const msg = `Gentle reminder: Your child has pending fees of ₹${amt} due for this active term.`;
        const report = await sendNotification(
          [recipient.id],
          channelType,
          { message: msg },
          { senderId: adminId, batchId, role: 'broadcast' }
        );
        return report;
      })
    );

    const chunkRows = [];
    for (let index = 0; index < chunkReports.length; index += 1) {
      const outcome = chunkReports[index];
      if (outcome.status === 'rejected') {
        summary.failureCount += 1;
        chunkRows.push({
          user_id: chunk[index].id,
          fcm_token: null,
          status: 'failed',
          error_code: 'recipient_dispatch_error',
        });
        continue;
      }
      const report = outcome.value;
      summary.sentCount += report.successCount;
      summary.failureCount += report.failureCount;
      summary.noTokenCount += report.noTokenCount;
      summary.tokensTargeted += report.successCount + report.failureCount;
      chunkRows.push(...report.recipientRows);
    }

    await persistRows(schoolId, batchId, chunkRows);
    await writeProgress(batchId, schoolId, summary);
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
    await withDatabaseRetry(() => sql`
      UPDATE notification_batches
      SET status = 'failed', updated_at = now()
      WHERE id = ${batchId}
        AND school_id = ${schoolId}
    `, 'failed batch finalization');
    throw err;
  }
}

/**
 * Look up a recent broadcast created with the same client idempotency key.
 * Returns a dispatchBroadcast-shaped response (so the caller can return it
 * verbatim) or null when there is no recent match.
 */
async function findBroadcastByIdempotencyKey(schoolId, idempotencyKey) {
  const [existing] = await sql`
    SELECT id, status, total_targets, sent_count, failure_count,
           no_token_count, tokens_targeted
    FROM notification_batches
    WHERE school_id = ${schoolId}
      AND type = 'BROADCAST'
      AND filters->>'idempotency_key' = ${idempotencyKey}
      AND created_at > now() - interval '10 minutes'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!existing) return null;

  const total = existing.total_targets ?? 0;
  const sent = existing.sent_count ?? 0;
  const failed = existing.failure_count ?? 0;
  const noToken = existing.no_token_count ?? 0;
  return {
    batch_id: existing.id,
    status: existing.status,
    mode: 'async',
    total_targets: total,
    sent_count: sent,
    failure_count: failed,
    no_token_count: noToken,
    tokens_targeted: existing.tokens_targeted ?? 0,
    remaining_count: Math.max(total - sent - failed - noToken, 0),
    deduped: true,
    message: 'Duplicate send ignored — returning the existing broadcast.',
  };
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
  idempotencyKey = null,
  feePaidRange = {},
}) {
  assertBroadcastType(channelType);

  const normalizedClassIds = normalizeClassIds(classIds);
  const isClassTargeted = normalizedClassIds.length > 0 || normalizeSectionIds(sectionIds).length > 0;

  // Idempotency: a double-tapped "Send", a React re-invocation, or the API
  // client transparently retrying a 502/503/429 all reuse the same client key.
  // Return the already-created batch instead of firing a second broadcast.
  if (idempotencyKey) {
    const existing = await findBroadcastByIdempotencyKey(schoolId, idempotencyKey);
    if (existing) return existing;
  }

  const recipients = await resolveRecipients(schoolId, {
    classIds: normalizedClassIds,
    sectionIds,
    channelType,
    feePaidRange,
  });

  const filters = {
    channel_type: channelType,
    class_ids: normalizedClassIds,
    section_ids: normalizeSectionIds(sectionIds),
  };
  if (channelType === 'FEE_REMINDER') {
    const paidRange = normalizeFeePaidRange(feePaidRange);
    filters.fee_paid_min_percent = paidRange.min;
    filters.fee_paid_max_percent = paidRange.max;
  }
  if (parentBatchId) filters.parent_batch_id = parentBatchId;
  if (idempotencyKey) filters.idempotency_key = idempotencyKey;

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
  // A process crash can otherwise leave an in-memory dispatch marked as
  // processing forever. Progress updates refresh updated_at after each chunk.
  await sql`
    UPDATE notification_batches
    SET status = 'failed', updated_at = now()
    WHERE id = ${batchId}
      AND school_id = ${schoolId}
      AND type = 'BROADCAST'
      AND status = 'processing'
      AND updated_at < now() - interval '3 minutes'
  `;

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
 * Resend everyone from a prior batch who was NOT confirmed delivered.
 *
 * Crucially this is not "resend the rows we marked failed". A process crash,
 * redeploy, or OOM kill in the middle of an in-process dispatch leaves the
 * un-attempted recipients with NO audit row at all — they are neither 'sent'
 * nor 'failed'. Retrying only status='failed' rows would silently abandon them
 * forever. Instead we re-resolve the batch's CURRENT audience from its stored
 * filters and subtract only the users we can prove received it (status='sent').
 * The remainder — failed, no-token, and never-attempted — is resent. That makes
 * a broadcast fully recoverable after any mid-flight failure.
 *
 * Creates a NEW batch linked via parent_batch_id; original rows are never mutated.
 */
export async function retryBroadcast(batchId, schoolId, adminId) {
  const [sourceBatch] = await sql`
    SELECT id, channel_type, filters, status
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

  const channelType = sourceBatch.channel_type;
  assertBroadcastType(channelType);
  // Drop the source's idempotency key so the retry batch can't be mistaken for
  // the original in a dedupe lookup — a resend is a deliberate, distinct action.
  const { idempotency_key: _ignoredKey, ...filters } = sourceBatch.filters || {};
  const classIds = filters.class_ids || [];
  const sectionIds = filters.section_ids || [];
  const feePaidRange = {
    min: filters.fee_paid_min_percent,
    max: filters.fee_paid_max_percent,
  };

  // Users we can prove already got it — never resend to these.
  const sentRows = await sql`
    SELECT DISTINCT user_id
    FROM notification_dispatch_recipients
    WHERE batch_id = ${batchId}
      AND school_id = ${schoolId}
      AND status = 'sent'
      AND user_id IS NOT NULL
  `;
  const alreadySent = new Set(sentRows.map((r) => r.user_id));

  // Re-resolve the batch's current audience (carries per-recipient balance for
  // FEE_REMINDER) so un-attempted recipients lost to a crash are recovered too.
  const currentTargets = await resolveRecipients(schoolId, {
    classIds,
    sectionIds,
    channelType,
    feePaidRange,
  });
  const recipients = currentTargets.filter((r) => !alreadySent.has(r.id));

  if (recipients.length === 0) {
    throw new Error('No pending recipients to resend — everyone has already been notified.');
  }

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
      ${recipients.length}
    )
    RETURNING id
  `;

  setImmediate(() => {
    runDispatch(retryBatch.id, schoolId, adminId, channelType, recipients).catch(() => {});
  });

  return {
    batch_id: retryBatch.id,
    status: 'processing',
    total_targets: recipients.length,
    sent_count: 0,
    failure_count: 0,
    no_token_count: 0,
    tokens_targeted: 0,
    remaining_count: recipients.length,
    parent_batch_id: batchId,
    mode: 'async',
    message: 'Retry broadcast started. Poll GET /broadcast/:batchId for progress.',
  };
}
