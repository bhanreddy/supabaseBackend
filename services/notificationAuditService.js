import sql from '../db.js';
import logger from '../utils/logger.js';

function normalizeUserIds(userIds) {
  return [...new Set((userIds || []).filter(Boolean).map(String))];
}

/**
 * Resolve the notification tenant from server-owned user records.
 * A single summary must never combine recipients from different schools.
 */
export async function resolveNotificationSchoolId(
  recipientUserIds,
  expectedSchoolId = null,
  db = sql,
) {
  const userIds = normalizeUserIds(recipientUserIds);
  if (userIds.length === 0) {
    throw new Error('Cannot resolve notification school without recipients');
  }

  const rows = await db`
    SELECT DISTINCT school_id
    FROM users
    WHERE id = ANY(${userIds})
      AND deleted_at IS NULL
  `;

  if (rows.length === 0) {
    throw new Error('Cannot resolve notification school from recipients');
  }
  if (rows.length !== 1) {
    throw new Error('Notification recipients belong to multiple schools');
  }

  const schoolId = rows[0].school_id;
  if (schoolId == null) {
    throw new Error('Notification recipient has no school');
  }
  if (expectedSchoolId != null && String(expectedSchoolId) !== String(schoolId)) {
    throw new Error('Notification school does not match recipient school');
  }

  return schoolId;
}

/**
 * Persist a delivery summary without allowing audit failures to break an
 * otherwise successful push send.
 */
export async function logNotificationSummary({
  recipientUserIds = [],
  schoolId: expectedSchoolId = null,
  type,
  tokensTargeted = 0,
  tokensSent = 0,
  tokensFailed = 0,
  channelId = null,
  senderId = null,
  batchId = null,
  role = null,
  errorMessage = null,
  providerResponse = null,
}, db = sql) {
  try {
    const schoolId = await resolveNotificationSchoolId(
      recipientUserIds,
      expectedSchoolId,
      db,
    );
    const status = tokensFailed === 0 ? 'success' : tokensSent === 0 ? 'failed' : 'partial';

    await db`
      INSERT INTO notification_logs (
        school_id, user_id, batch_id, notification_type, role, channel_id,
        push_provider, tokens_targeted, tokens_sent, tokens_failed,
        error_message, provider_response, status
      ) VALUES (
        ${schoolId}, ${senderId}, ${batchId}, ${type}, ${role}, ${channelId},
        'fcm', ${tokensTargeted}, ${tokensSent}, ${tokensFailed},
        ${errorMessage}, ${providerResponse ? JSON.stringify(providerResponse) : null}, ${status}
      )
    `;
    return true;
  } catch (err) {
    logger.error({
      err,
      event: 'notification_summary_persist_failed',
      type,
      expectedSchoolId,
      batchId,
      recipientCount: normalizeUserIds(recipientUserIds).length,
    }, 'Notification delivery summary persistence failed');
    return false;
  }
}
