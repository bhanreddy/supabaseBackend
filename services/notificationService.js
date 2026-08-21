// services/notificationService.js

import { randomUUID } from 'crypto';
import admin from '../config/firebase.js';
import sql from '../db.js';
import { NotificationEventConfig } from './notificationEventConfig.js';
import { NotificationTemplateService } from './notificationTemplateService.js';
import { filterEnabledNotificationRecipients } from './schoolNotificationSettingsService.js';
import logger from '../utils/logger.js';

// Constants
const BATCH_SIZE = 500;
const FCM_TIMEOUT_MS = 12_000;
const FCM_MAX_RETRIES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withFcmTimeout = (promise) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('FCM dispatch timeout')), FCM_TIMEOUT_MS)),
]);

// Cache for Kill Switch (Fix 5)
let killSwitchCache = null;
let lastKillSwitchCheck = 0;
const CACHE_TTL = 60000; // 60 seconds

/**
 * Send notification by resolving tokens internally from user IDs
 * Includes batching (500 limit) and retry logic.
 * @param {number[]} userIds
 * @param {string} type
 * @param {object} params
 */
export async function sendNotificationToUsers(userIds = [], type, params = {}, context = {}) {
  if (!userIds || userIds.length === 0) return { successCount: 0, failureCount: 0 };

  const notificationAccess = await filterEnabledNotificationRecipients(userIds, type);
  userIds = notificationAccess.enabledUserIds;
  if (userIds.length === 0) {
    return {
      successCount: 0,
      failureCount: 0,
      disabledCount: notificationAccess.disabledUserIds.length,
    };
  }

  // 1️⃣ Validate Event Mapping & Render
  let renderResult;
  try {
    renderResult = NotificationTemplateService.render(type, params);
  } catch (err) {
    console.error('Template render error:', err);
    await logNotificationSummary({ type, errorMessage: err.message }); // Log template failure
    return { successCount: 0, failureCount: 0 };
  }

  const soundFile = NotificationEventConfig[type].sound;
  const channelId = renderResult.android.channelId;

  // 2️⃣ Kill Switch Check
  if (await isKillSwitchActive(type)) {
    return { successCount: 0, failureCount: 0 };
  }

  // Create a durable per-recipient inbox record before attempting delivery.
  // This lets a user catch up in the app even when an OS banner was missed,
  // dismissed, or the device was offline at send time. A failure here must not
  // block the existing FCM delivery path.
  const deepLink = context?.deepLink || renderResult.deepLink;
  const inboxIdsByUser = await createInboxEntries(userIds, type, params, deepLink, context);

  // 3️⃣ Fetch Tokens with language preference
  // Keep the recipient identity with each token. The same physical device can
  // be registered for several vaulted accounts, so a notification tap must be
  // able to switch to the account it was actually sent to.
  let userTokens = await fetchTokensWithUserId(userIds);
  if (!userTokens || userTokens.length === 0) {
    return {
      successCount: 0,
      failureCount: 0,
      disabledCount: notificationAccess.disabledUserIds.length,
    };
  }

  // 4️⃣ Group tokens by language and render per-language templates
  let totalSuccess = 0;
  let totalFailure = 0;

  // Group by language_code (default 'en')
  const langGroups = {};
  for (const device of userTokens) {
    const lang = device.language_code || 'en';
    const key = `${lang}:${device.user_id}`;
    if (!langGroups[key]) {
      langGroups[key] = { lang, userId: device.user_id, tokens: [] };
    }
    langGroups[key].tokens.push(device.fcm_token);
  }

  const batchPromises = [];

  for (const { lang, userId, tokens } of Object.values(langGroups)) {
    // Render templates in this language
    let langRender;
    try {
      langRender = NotificationTemplateService.render(type, params, lang);
    } catch (err) {

      langRender = renderResult; // Fall back to English
    }

    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const tokenChunk = tokens.slice(i, i + BATCH_SIZE);
      batchPromises.push(sendBatch(tokenChunk, {
        title: langRender.title,
        body: langRender.body,
        // Allow the caller to override the config deep link per send (e.g. route a
        // message notification to the recipient's own portal messenger).
        deepLink: context?.deepLink || langRender.deepLink,
        soundFile,
        channelId: `${channelId}_custom`,
        type,
        recipientUserId: userId,
        notificationId: inboxIdsByUser.get(String(userId)) || '',
        customSound: true
      }));
    }
  }

  // Count total tokens from langGroups
  const totalTokenCount = Object.values(langGroups)
    .reduce((sum, group) => sum + group.tokens.length, 0);

  const results = await Promise.all(batchPromises);
  results.forEach((res) => {
    totalSuccess += res.success;
    totalFailure += res.failure;
  });

  // 5️⃣ Log Final Summary
  await logNotificationSummary({
    type,
    tokensTargeted: totalTokenCount,
    tokensSent: totalSuccess,
    tokensFailed: totalFailure,
    channelId: renderResult.android?.channelId,
    senderId: context.senderId || null,
    batchId: context.batchId || null,
    role: context.role || null
  });

  return {
    successCount: totalSuccess,
    failureCount: totalFailure,
    disabledCount: notificationAccess.disabledUserIds.length,
  };
}

/**
 * Active transport student IDs assigned to a stop on a route (current academic year).
 */
export async function getTransportStudentIdsAtStop(schoolId, routeId, stopId, db = sql) {
  if (!stopId) return [];
  try {
    const rows = await db`
      SELECT st.student_id
      FROM student_transport st
      WHERE st.stop_id = ${stopId}
        AND st.route_id = ${routeId}
        AND st.school_id = ${schoolId}
        AND st.is_active = true
        AND st.academic_year_id = (
          SELECT id FROM academic_years
          WHERE school_id = ${schoolId}
            AND (now() AT TIME ZONE 'Asia/Kolkata')::date BETWEEN start_date AND end_date
            AND deleted_at IS NULL
          LIMIT 1
        )
    `;
    return rows.map((r) => r.student_id);
  } catch (err) {
    logger.error({ err, event: 'transport_notification_student_lookup_failed', schoolId, routeId, stopId }, 'Transport notification recipient lookup failed');
    return [];
  }
}

/**
 * Notify parents of transport-assigned students for a stop-sequence event.
 * Resolves student → parent → user_devices (school-scoped). Logs and skips missing tokens.
 */
export async function sendTransportNotification(studentIds, eventKey, templateVars, schoolId, db = sql) {
  if (!studentIds?.length) return;
  if (!NotificationEventConfig[eventKey]) {
    logger.error({ event: 'transport_notification_unknown_event', eventKey, schoolId }, 'Unknown transport notification event');
    return;
  }

  try {
    const parentLinks = await db`
      SELECT DISTINCT sp.student_id, u.id AS user_id
      FROM unnest(${db.array(studentIds)}::uuid[]) AS sid(student_id)
      JOIN student_parents sp
        ON sp.student_id = sid.student_id
        AND sp.school_id = ${schoolId}
        AND sp.deleted_at IS NULL
      JOIN parents par ON par.id = sp.parent_id AND par.school_id = ${schoolId}
      JOIN users u
        ON u.person_id = par.person_id
        AND u.school_id = ${schoolId}
        AND u.account_status = 'active'
    `;

    const usersByStudent = new Map();
    for (const row of parentLinks) {
      if (!usersByStudent.has(row.student_id)) usersByStudent.set(row.student_id, new Set());
      usersByStudent.get(row.student_id).add(row.user_id);
    }

    for (const studentId of studentIds) {
      if (!usersByStudent.has(studentId) || usersByStudent.get(studentId).size === 0) {
        logger.info({ event: 'transport_notification_no_parent', schoolId, eventKey }, 'Transport notification skipped without a parent recipient');
      }
    }

    const allUserIds = [...new Set(parentLinks.map((r) => r.user_id))];
    if (allUserIds.length === 0) return;

    const devices = await db`
      SELECT user_id
      FROM user_devices
      WHERE user_id = ANY(${allUserIds})
        AND school_id = ${schoolId}
        AND is_active = TRUE
    `;
    const usersWithTokens = new Set(devices.map((d) => d.user_id));

    for (const studentId of studentIds) {
      const userIds = usersByStudent.get(studentId);
      if (!userIds || userIds.size === 0) continue;
      const hasToken = [...userIds].some((uid) => usersWithTokens.has(uid));
      if (!hasToken) {
        logger.info({ event: 'transport_notification_no_token', schoolId, eventKey }, 'Transport notification skipped without an active token');
      }
    }

    const notifyUserIds = allUserIds.filter((uid) => usersWithTokens.has(uid));
    if (notifyUserIds.length === 0) return;

    await sendNotificationToUsers(notifyUserIds, eventKey, templateVars, { role: 'parent' });
  } catch (err) {
    logger.error({ err, event: 'transport_notification_dispatch_failed', schoolId, eventKey }, 'Transport notification dispatch failed');
  }
}

/**
 * Convenience: resolve students at a stop and notify their parents.
 */
export async function notifyTransportParentsAtStop(
  schoolId,
  routeId,
  stopId,
  eventKey,
  stopName,
  db = sql,
) {
  const studentIds = await getTransportStudentIdsAtStop(schoolId, routeId, stopId, db);
  await sendTransportNotification(studentIds, eventKey, { stopName }, schoolId, db);
}

/**
 * Process a single batch of up to 500 tokens
 */
function buildTokenResults(tokens, responses, fallbackErrorCode = null) {
  return tokens.map((token, index) => {
    const res = responses?.[index];
    return {
      token,
      success: res?.success ?? false,
      errorCode: res?.success ? null : (res?.error?.code ?? fallbackErrorCode),
    };
  });
}

async function sendBatch(tokens, {
  title,
  body,
  deepLink,
  soundFile,
  channelId,
  type,
  recipientUserId = null,
  notificationId = '',
  customSound = true,
}) {
  if (tokens.length === 0) return { success: 0, failure: 0, tokenResults: [] };

  // soundBase = filename without extension (required by Android's raw res lookup).
  // FCM will automatically add .wav/.mp3 when playing; the raw resource must be
  // named exactly <soundBase>.wav in android/app/src/main/res/raw/.
  const soundBase = soundFile && soundFile !== 'default' ? soundFile.replace(/\.[^/.]+$/, "") : 'default';
  const presentation = notificationPresentation(type);

  const message = {
    tokens,

    // TOP-LEVEL notification block — REQUIRED for background/killed delivery.
    // Without this, Android's FCM SDK has nothing to render in the system tray
    // when JS is not running, and the user sees an empty/silent notification.
    notification: {
      title,
      body
    },

    android: {
      priority: 'high',        // Delivered even in Doze mode
      ttl: 86400 * 1000,       // TTL is in MILLISECONDS for admin SDK, not seconds
      notification: {
        title,                 // Override for Android-specific customization
        body,
        color: presentation.color,
        channelId: channelId,  // Must match a channel created on the device
        sound: soundBase,      // Raw resource name WITHOUT extension (e.g. "voice_alert")
        defaultSound: false,
        priority: 'high',
        visibility: 'public',
        notificationPriority: 'PRIORITY_MAX',
        notificationCount: 1
      }
    },

    apns: {
      headers: {
        'apns-priority': '10',      // 10 = immediate delivery (required for alert)
        'apns-push-type': 'alert'   // Required on iOS 13+ when showing an alert
      },
      payload: {
        aps: {
          alert: {
            title,
            body,
            subtitle: presentation.subtitle
          },
          sound: soundFile || 'default',   // iOS expects the full filename (with .wav)
          badge: 1,
          'mutable-content': 1,            // Allow Notification Service Extension
          category: presentation.category  // Enables the matching native action button
          // NOTE: Do NOT set 'content-available: 1' together with alert.
          // That combo makes iOS treat the message as silent/background-only
          // and the banner may not appear reliably in killed state.
        }
      }
    },

    data: {
      type: String(type),
      deepLink: String(deepLink || ''),
      title: String(title || ''),   // Kept for foreground onMessage fallback
      body: String(body || ''),
      channelId: String(channelId),
      sound: String(soundBase),
      // FCM data values must be strings. This is the server-authoritative
      // account identity that the client uses to select a vaulted session on
      // notification tap; it is never trusted for API authorization.
      recipientUserId: String(recipientUserId || ''),
      notificationId: String(notificationId || ''),
      messageId: String(randomUUID())
    }
  };

  try {
    const response = await withFcmTimeout(admin.messaging().sendEachForMulticast(message));
    const invalidTokens = [];
    const retryTokens = [];

    // Analyze responses
    response.responses.forEach((res, index) => {
      if (!res.success) {
        const code = res.error?.code;
        if (code === 'messaging/invalid-registration-token' ||
          code === 'messaging/registration-token-not-registered') {
          invalidTokens.push(tokens[index]);
        } else if (code === 'messaging/server-unavailable' || code === 'messaging/internal-error') {
          // Transient errors eligible for retry
          retryTokens.push(tokens[index]);
        }
      }
    });

    // Auto-clean invalid tokens
    if (invalidTokens.length > 0) {
      await removeInvalidTokens(invalidTokens);
    }

    let retrySuccess = 0;
    let retryFailure = 0;
    const tokenResults = buildTokenResults(tokens, response.responses);

    // Bounded exponential retry. This stays off transport ingest paths and
    // stale/invalid tokens are removed after every attempt.
    if (retryTokens.length > 0) {
      const retryRes = await retrySend(retryTokens, message);
      retrySuccess = retryRes.success;
      retryFailure = retryRes.failure;

      const retryResultByToken = new Map(
        (retryRes.tokenResults || []).map((entry) => [entry.token, entry])
      );
      for (let i = 0; i < tokenResults.length; i++) {
        const updated = retryResultByToken.get(tokenResults[i].token);
        if (updated) tokenResults[i] = updated;
      }
    }

    return {
      success: response.successCount + retrySuccess,
      failure: response.failureCount - retryTokens.length + retryFailure,
      tokenResults,
    };

  } catch (error) {
    logger.error({ err: error, event: 'transport_fcm_dispatch_failed', type, tokenCount: tokens.length }, 'FCM batch dispatch failed');

    return {
      success: 0,
      failure: tokens.length,
      tokenResults: buildTokenResults(tokens, null, 'dispatch_error'),
    };
  }
}

/**
 * Native notification surfaces are system-owned, so use semantic accents and
 * a small category label instead of a fragile custom layout. Category values
 * match the Expo action categories registered by the mobile app.
 */
function notificationPresentation(type = '') {
  if (type.startsWith('TRANSPORT_') || type.startsWith('BUS_') || type.startsWith('STUDENT_BUS_')) {
    return { color: '#0082C8', subtitle: 'SchoolIMS · Transport', category: 'schoolims_track_transport' };
  }
  if (type.startsWith('FEE_') || type === 'ARREARS_REMINDER') {
    return { color: '#F26522', subtitle: 'SchoolIMS · Fees', category: 'schoolims_view_fees' };
  }
  if (
    type.startsWith('LEAVE_') ||
    type.startsWith('EXPENSE_') ||
    type === 'COMPLAINT_CREATED' ||
    type === 'COMPLAINT_RESPONSE' ||
    type === 'ACCESS_RESPONSE'
  ) {
    return { color: '#D97706', subtitle: 'SchoolIMS · Action needed', category: 'schoolims_review' };
  }
  if (type.startsWith('ATTENDANCE_')) {
    return { color: '#3535A8', subtitle: 'SchoolIMS · Attendance', category: 'schoolims_open' };
  }
  if (type === 'RESULT_RELEASED') {
    return { color: '#7C3AED', subtitle: 'SchoolIMS · Results', category: 'schoolims_open' };
  }
  if (type === 'DIARY_UPDATED' || type === 'LMS_CONTENT' || type === 'TIMETABLE_UPDATED') {
    return { color: '#3535A8', subtitle: 'SchoolIMS · Academics', category: 'schoolims_open' };
  }
  if (type === 'NOTICE_ADMIN_STUDENT') {
    return { color: '#0082C8', subtitle: 'SchoolIMS · Notice', category: 'schoolims_open' };
  }
  if (type === 'PAYROLL_SUCCESS') {
    return { color: '#10B981', subtitle: 'SchoolIMS · Payroll', category: 'schoolims_open' };
  }
  if (type === 'MESSAGE_RECEIVED') {
    return { color: '#3535A8', subtitle: 'SchoolIMS · Messages', category: 'schoolims_open' };
  }
  return { color: '#3535A8', subtitle: 'SchoolIMS', category: 'schoolims_open' };
}

/**
 * Store one inbox row for every intended recipient. Notification events are
 * immutable delivery records; the companion `notifications` row tracks each
 * user's read state and supplies the in-app history screen.
 */
async function createInboxEntries(userIds, type, params, deepLink, context = {}) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  const inboxIdsByUser = new Map();
  if (ids.length === 0) return inboxIdsByUser;

  try {
    const recipients = await sql`
      SELECT
        u.id AS user_id,
        u.school_id,
        COALESCE((
          SELECT ud.language_code
          FROM user_devices ud
          WHERE ud.user_id = u.id
            AND ud.school_id = u.school_id
            AND ud.is_active = TRUE
          ORDER BY ud.last_used_at DESC NULLS LAST
          LIMIT 1
        ), 'en') AS language_code
      FROM users u
      WHERE u.id = ANY(${ids})
        AND u.deleted_at IS NULL
    `;

    // Bound concurrent inserts so a large broadcast does not spike the DB.
    for (let offset = 0; offset < recipients.length; offset += 50) {
      const batch = recipients.slice(offset, offset + 50);
      const created = await Promise.all(batch.map(async (recipient) => {
        let rendered;
        try {
          rendered = NotificationTemplateService.render(type, params, recipient.language_code || 'en');
        } catch {
          rendered = NotificationTemplateService.render(type, params);
        }

        const [row] = await sql`
          WITH event AS (
            INSERT INTO notification_events (
              school_id, idempotency_key, event_type, actor_id, target_user_id, payload, status
            ) VALUES (
              ${recipient.school_id},
              ${randomUUID()},
              ${type},
              ${null},
              ${recipient.user_id},
              ${JSON.stringify({ type, deepLink })},
              'PROCESSED'
            )
            RETURNING id
          )
          INSERT INTO notifications (
            school_id, event_id, user_id, title, body, action_url, status
          )
          SELECT
            ${recipient.school_id}, event.id, ${recipient.user_id},
            ${rendered.title}, ${rendered.body}, ${deepLink || null}, 'DELIVERED'
          FROM event
          RETURNING id, user_id
        `;
        return row;
      }));

      created.forEach((row) => {
        if (row?.id && row?.user_id) inboxIdsByUser.set(String(row.user_id), String(row.id));
      });
    }
  } catch (err) {
    logger.warn({ err, event: 'notification_inbox_persist_failed', type }, 'Notification inbox persistence failed; continuing push delivery');
  }

  return inboxIdsByUser;
}

/**
 * Retry helper with timeout and exponential backoff. It returns per-token
 * results so invalid tokens remain eligible for the same cleanup path.
 */
async function retrySend(tokens, originalMessage) {
  if (tokens.length === 0) return { success: 0, failure: 0, tokenResults: [] };
  let pending = tokens;
  let success = 0;
  let latest = new Map(tokens.map((token) => [token, { token, success: false, errorCode: 'dispatch_error' }]));
  for (let attempt = 1; attempt <= FCM_MAX_RETRIES && pending.length; attempt += 1) {
    await sleep(250 * (2 ** (attempt - 1)));
    try {
      const response = await withFcmTimeout(admin.messaging().sendEachForMulticast({ ...originalMessage, tokens: pending }));
      const result = buildTokenResults(pending, response.responses);
      result.forEach((entry) => latest.set(entry.token, entry));
      success += response.successCount;
      const invalid = result.filter((entry) => ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(entry.errorCode)).map((entry) => entry.token);
      if (invalid.length) await removeInvalidTokens(invalid);
      pending = result.filter((entry) => ['messaging/server-unavailable', 'messaging/internal-error'].includes(entry.errorCode)).map((entry) => entry.token);
    } catch (err) {
      logger.warn({ err, event: 'transport_fcm_retry_failed', attempt, tokenCount: pending.length }, 'FCM retry attempt failed');
    }
  }
  const tokenResults = tokens.map((token) => latest.get(token));
  return { success, failure: tokenResults.filter((entry) => !entry.success).length, tokenResults };
}

// Helpers

async function isKillSwitchActive(type) {
  const now = Date.now();

  // Fix 5: Use cached kill switch status if fresh
  if (killSwitchCache && now - lastKillSwitchCheck < CACHE_TTL) {
    return checkCache(type);
  }

  try {
    const [row] = await sql`SELECT value FROM notification_config WHERE key = 'kill_switch' LIMIT 1`;
    killSwitchCache = row?.value || null;
    lastKillSwitchCheck = now;
    return checkCache(type);
  } catch (err) {
    return false; // Fail open
  }
}

function checkCache(type) {
  if (!killSwitchCache) return false;
  if (killSwitchCache.global) {

    return true;
  }
  if (killSwitchCache.types && killSwitchCache.types[type]) {

    return true;
  }
  return false;
}

async function fetchTokens(userIds) {
  try {
    const devices = await sql`
            SELECT ud.fcm_token, COALESCE(ud.language_code, 'en') AS language_code
            FROM user_devices ud
            WHERE ud.user_id = ANY(${userIds})
            AND ud.is_active = TRUE
            -- Skip long-unused tokens (dead devices / stale dev logins). Active users
            -- refresh last_used_at on every app launch via /register upsert.
            AND (ud.last_used_at IS NULL OR ud.last_used_at > now() - interval '60 days')
        `;
    return devices;
  } catch (err) {

    return [];
  }
}

async function fetchTokensWithUserId(userIds, { throwOnError = false } = {}) {
  try {
    const devices = await sql`
      SELECT
        ud.user_id,
        ud.fcm_token,
        COALESCE(ud.language_code, 'en') AS language_code
      FROM user_devices ud
      WHERE ud.user_id = ANY(${userIds})
        AND ud.is_active = TRUE
        AND (ud.last_used_at IS NULL OR ud.last_used_at > now() - interval '60 days')
    `;
    return devices;
  } catch (err) {
    if (throwOnError) throw err;
    return [];
  }
}

/**
 * Tracked send — same FCM path as sendNotificationToUsers but preserves user_id
 * on token fetch and returns per-token outcomes for dispatch audit / retry.
 * Does not modify sendNotificationToUsers behavior.
 */
export async function sendNotificationToUsersWithReport(userIds = [], type, params = {}, context = {}) {
  if (!userIds || userIds.length === 0) {
    return {
      successCount: 0,
      failureCount: 0,
      noTokenCount: 0,
      tokenResults: [],
      recipientRows: [],
    };
  }

  const notificationAccess = await filterEnabledNotificationRecipients(userIds, type);
  userIds = notificationAccess.enabledUserIds;
  const disabledRecipientRows = notificationAccess.disabledUserIds.map((userId) => ({
    user_id: userId,
    fcm_token: null,
    status: 'skipped',
    error_code: 'notification_disabled',
  }));

  if (userIds.length === 0) {
    return {
      successCount: 0,
      failureCount: notificationAccess.disabledUserIds.length,
      noTokenCount: 0,
      disabledCount: notificationAccess.disabledUserIds.length,
      tokenResults: [],
      recipientRows: disabledRecipientRows,
    };
  }

  let renderResult;
  try {
    renderResult = NotificationTemplateService.render(type, params);
  } catch (err) {
    console.error('Template render error:', err);
    await logNotificationSummary({ type, errorMessage: err.message });
    return {
      successCount: 0,
      failureCount: userIds.length + notificationAccess.disabledUserIds.length,
      noTokenCount: 0,
      tokenResults: [],
      recipientRows: [
        ...disabledRecipientRows,
        ...userIds.map((userId) => ({
          user_id: userId,
          fcm_token: null,
          status: 'failed',
          error_code: 'template_error',
        })),
      ],
    };
  }

  const soundFile = NotificationEventConfig[type].sound;
  const channelId = renderResult.android.channelId;

  if (await isKillSwitchActive(type)) {
    return {
      successCount: 0,
      failureCount: userIds.length + notificationAccess.disabledUserIds.length,
      noTokenCount: 0,
      tokenResults: [],
      recipientRows: [
        ...disabledRecipientRows,
        ...userIds.map((userId) => ({
          user_id: userId,
          fcm_token: null,
          status: 'failed',
          error_code: 'kill_switch',
        })),
      ],
    };
  }

  const inboxIdsByUser = await createInboxEntries(
    userIds,
    type,
    params,
    context?.deepLink || renderResult.deepLink,
    context
  );

  // Tracked broadcasts must not misreport a database outage as "no app installed".
  const userDevices = await fetchTokensWithUserId(userIds, { throwOnError: true });
  const usersWithTokens = new Set(userDevices.map((d) => d.user_id));
  const noTokenUserIds = userIds.filter((id) => !usersWithTokens.has(id));

  const recipientRows = [
    ...disabledRecipientRows,
    ...noTokenUserIds.map((userId) => ({
      user_id: userId,
      fcm_token: null,
      status: 'no_token',
      error_code: null,
    })),
  ];

  if (userDevices.length === 0) {
    await logNotificationSummary({
      type,
      tokensTargeted: 0,
      tokensSent: 0,
      tokensFailed: 0,
      channelId: renderResult.android?.channelId,
      senderId: context.senderId || null,
      batchId: context.batchId || null,
      role: context.role || null,
    });
    return {
      successCount: 0,
      failureCount: notificationAccess.disabledUserIds.length,
      noTokenCount: noTokenUserIds.length,
      disabledCount: notificationAccess.disabledUserIds.length,
      tokenResults: [],
      recipientRows,
    };
  }

  const langGroups = {};
  for (const device of userDevices) {
    const lang = device.language_code || 'en';
    const key = `${lang}:${device.user_id}`;
    if (!langGroups[key]) {
      langGroups[key] = { lang, userId: device.user_id, devices: [] };
    }
    langGroups[key].devices.push(device);
  }

  let totalSuccess = 0;
  let totalFailure = 0;
  const allTokenResults = [];
  const batchPromises = [];

  for (const { lang, userId, devices } of Object.values(langGroups)) {
    let langRender;
    try {
      langRender = NotificationTemplateService.render(type, params, lang);
    } catch (err) {
      langRender = renderResult;
    }

    const tokens = devices.map((d) => d.fcm_token);
    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
      const deviceChunk = devices.slice(i, i + BATCH_SIZE);
      const tokenChunk = deviceChunk.map((d) => d.fcm_token);
      batchPromises.push(
        sendBatch(tokenChunk, {
          title: langRender.title,
          body: langRender.body,
          deepLink: langRender.deepLink,
          soundFile,
          channelId: `${channelId}_custom`,
          type,
          recipientUserId: userId,
          notificationId: inboxIdsByUser.get(String(userId)) || '',
          customSound: true,
        }).then((batchRes) => ({ deviceChunk, batchRes }))
      );
    }
  }

  const batchOutcomes = await Promise.all(batchPromises);
  for (const { deviceChunk, batchRes } of batchOutcomes) {
    totalSuccess += batchRes.success;
    totalFailure += batchRes.failure;

    const resultByToken = new Map(
      (batchRes.tokenResults || []).map((entry) => [entry.token, entry])
    );

    for (const device of deviceChunk) {
      const tokenOutcome = resultByToken.get(device.fcm_token);
      const success = tokenOutcome?.success ?? false;
      allTokenResults.push({
        user_id: device.user_id,
        token: device.fcm_token,
        success,
        errorCode: tokenOutcome?.errorCode ?? null,
      });
      recipientRows.push({
        user_id: device.user_id,
        fcm_token: device.fcm_token,
        status: success ? 'sent' : 'failed',
        error_code: success ? null : (tokenOutcome?.errorCode ?? 'unknown'),
      });
    }
  }

  const totalTokenCount = userDevices.length;

  await logNotificationSummary({
    type,
    tokensTargeted: totalTokenCount,
    tokensSent: totalSuccess,
    tokensFailed: totalFailure,
    channelId: renderResult.android?.channelId,
    senderId: context.senderId || null,
    batchId: context.batchId || null,
    role: context.role || null,
  });

  return {
    successCount: totalSuccess,
    failureCount: totalFailure + notificationAccess.disabledUserIds.length,
    noTokenCount: noTokenUserIds.length,
    disabledCount: notificationAccess.disabledUserIds.length,
    tokenResults: allTokenResults,
    recipientRows,
  };
}

async function removeInvalidTokens(tokens) {
  try {
    await sql`
            UPDATE user_devices
            SET is_active = FALSE, updated_at = NOW()
            WHERE fcm_token = ANY(${tokens})
        `;
  } catch (err) {

  }
}

async function logNotificationSummary({
  type,
  tokensTargeted = 0,
  tokensSent = 0,
  tokensFailed = 0,
  channelId = null,
  senderId = null,
  batchId = null,
  role = null,
  errorMessage = null,
  providerResponse = null
}) {
  try {
    const status = tokensFailed === 0 ? 'success' : tokensSent === 0 ? 'failed' : 'partial';
    await sql`
            INSERT INTO notification_logs (
                user_id, batch_id, notification_type, role, channel_id,
                push_provider, tokens_targeted, tokens_sent, tokens_failed,
                error_message, provider_response, status
            ) VALUES (
                ${senderId}, ${batchId}, ${type}, ${role}, ${channelId},
                'fcm', ${tokensTargeted}, ${tokensSent}, ${tokensFailed},
                ${errorMessage}, ${providerResponse ? JSON.stringify(providerResponse) : null}, ${status}
            )
        `;
  } catch (err) {

  }
}
