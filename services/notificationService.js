// services/notificationService.js

import { randomUUID } from 'crypto';
import admin from '../config/firebase.js';
import sql from '../db.js';
import { NotificationEventConfig } from './notificationEventConfig.js';
import { NotificationTemplateService } from './notificationTemplateService.js';

// Constants
const BATCH_SIZE = 500;

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

  // 3️⃣ Fetch Tokens with language preference
  let userTokens = await fetchTokens(userIds);
  if (!userTokens || userTokens.length === 0) return { successCount: 0, failureCount: 0 };

  // 4️⃣ Group tokens by language and render per-language templates
  let totalSuccess = 0;
  let totalFailure = 0;

  // Group by language_code (default 'en')
  const langGroups = {};
  for (const device of userTokens) {
    const lang = device.language_code || 'en';
    if (!langGroups[lang]) langGroups[lang] = [];
    langGroups[lang].push(device.fcm_token);
  }

  const batchPromises = [];

  for (const [lang, tokens] of Object.entries(langGroups)) {
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
        deepLink: langRender.deepLink,
        soundFile,
        channelId: `${channelId}_custom`,
        type,
        customSound: true
      }));
    }
  }

  // Count total tokens from langGroups
  const totalTokenCount = Object.values(langGroups)
    .reduce((sum, tokens) => sum + tokens.length, 0);

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

  return { successCount: totalSuccess, failureCount: totalFailure };
}

/**
 * Active transport student IDs assigned to a stop on a route (current academic year).
 */
export async function getTransportStudentIdsAtStop(schoolId, routeId, stopId) {
  if (!stopId) return [];
  try {
    const rows = await sql`
      SELECT st.student_id
      FROM student_transport st
      WHERE st.stop_id = ${stopId}
        AND st.route_id = ${routeId}
        AND st.school_id = ${schoolId}
        AND st.is_active = true
        AND st.academic_year_id = (
          SELECT id FROM academic_years
          WHERE school_id = ${schoolId}
            AND CURRENT_DATE BETWEEN start_date AND end_date
            AND deleted_at IS NULL
          LIMIT 1
        )
    `;
    return rows.map((r) => r.student_id);
  } catch (err) {
    console.error('[Transport Notify] student lookup error:', err);
    return [];
  }
}

/**
 * Notify parents of transport-assigned students for a stop-sequence event.
 * Resolves student → parent → user_devices (school-scoped). Logs and skips missing tokens.
 */
export async function sendTransportNotification(studentIds, eventKey, templateVars, schoolId) {
  if (!studentIds?.length) return;
  if (!NotificationEventConfig[eventKey]) {
    console.error(`[Transport Notify] Unknown event key: ${eventKey}`);
    return;
  }

  try {
    const parentLinks = await sql`
      SELECT DISTINCT sp.student_id, u.id AS user_id
      FROM unnest(${sql.array(studentIds)}::uuid[]) AS sid(student_id)
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
        console.log(`[Transport Notify] No parent user for student ${studentId}, skipping`);
      }
    }

    const allUserIds = [...new Set(parentLinks.map((r) => r.user_id))];
    if (allUserIds.length === 0) return;

    const devices = await sql`
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
        console.log(`[Transport Notify] No token for student ${studentId}, skipping`);
      }
    }

    const notifyUserIds = allUserIds.filter((uid) => usersWithTokens.has(uid));
    if (notifyUserIds.length === 0) return;

    await sendNotificationToUsers(notifyUserIds, eventKey, templateVars, { role: 'parent' });
  } catch (err) {
    console.error('[Transport Notify] dispatch error:', err);
  }
}

/**
 * Convenience: resolve students at a stop and notify their parents.
 */
export async function notifyTransportParentsAtStop(schoolId, routeId, stopId, eventKey, stopName) {
  const studentIds = await getTransportStudentIdsAtStop(schoolId, routeId, stopId);
  await sendTransportNotification(studentIds, eventKey, { stopName }, schoolId);
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

async function sendBatch(tokens, { title, body, deepLink, soundFile, channelId, type, customSound = true }) {
  if (tokens.length === 0) return { success: 0, failure: 0, tokenResults: [] };

  // soundBase = filename without extension (required by Android's raw res lookup).
  // FCM will automatically add .wav/.mp3 when playing; the raw resource must be
  // named exactly <soundBase>.wav in android/app/src/main/res/raw/.
  const soundBase = soundFile && soundFile !== 'default' ? soundFile.replace(/\.[^/.]+$/, "") : 'default';

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
            body
          },
          sound: soundFile || 'default',   // iOS expects the full filename (with .wav)
          badge: 1,
          'mutable-content': 1             // Allow Notification Service Extension
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
      messageId: String(randomUUID())
    }
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
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

    // Simple Retry Logic for transient errors (1 attempt)
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

    return {
      success: 0,
      failure: tokens.length,
      tokenResults: buildTokenResults(tokens, null, 'dispatch_error'),
    };
  }
}

/**
 * Retry helper for transient errors (recursion or loop could be added for MAX_RETRIES)
 * Currently implementing 1-hop retry for simplicity and safety.
 */
async function retrySend(tokens, originalMessage) {
  if (tokens.length === 0) return { success: 0, failure: 0, tokenResults: [] };

  // Wait 1000ms before retry
  await new Promise((r) => setTimeout(r, 1000));

  const retryMsg = { ...originalMessage, tokens };
  try {
    const response = await admin.messaging().sendEachForMulticast(retryMsg);
    return {
      success: response.successCount,
      failure: response.failureCount,
      tokenResults: buildTokenResults(tokens, response.responses),
    };
  } catch (err) {

    return {
      success: 0,
      failure: tokens.length,
      tokenResults: buildTokenResults(tokens, null, 'dispatch_error'),
    };
  }
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
        `;
    return devices;
  } catch (err) {

    return [];
  }
}

async function fetchTokensWithUserId(userIds) {
  try {
    const devices = await sql`
      SELECT
        ud.user_id,
        ud.fcm_token,
        COALESCE(ud.language_code, 'en') AS language_code
      FROM user_devices ud
      WHERE ud.user_id = ANY(${userIds})
        AND ud.is_active = TRUE
    `;
    return devices;
  } catch (err) {
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

  let renderResult;
  try {
    renderResult = NotificationTemplateService.render(type, params);
  } catch (err) {
    console.error('Template render error:', err);
    await logNotificationSummary({ type, errorMessage: err.message });
    return {
      successCount: 0,
      failureCount: 0,
      noTokenCount: 0,
      tokenResults: [],
      recipientRows: userIds.map((userId) => ({
        user_id: userId,
        fcm_token: null,
        status: 'skipped',
        error_code: 'template_error',
      })),
    };
  }

  const soundFile = NotificationEventConfig[type].sound;
  const channelId = renderResult.android.channelId;

  if (await isKillSwitchActive(type)) {
    return {
      successCount: 0,
      failureCount: 0,
      noTokenCount: 0,
      tokenResults: [],
      recipientRows: userIds.map((userId) => ({
        user_id: userId,
        fcm_token: null,
        status: 'skipped',
        error_code: 'kill_switch',
      })),
    };
  }

  const userDevices = await fetchTokensWithUserId(userIds);
  const usersWithTokens = new Set(userDevices.map((d) => d.user_id));
  const noTokenUserIds = userIds.filter((id) => !usersWithTokens.has(id));

  const recipientRows = noTokenUserIds.map((userId) => ({
    user_id: userId,
    fcm_token: null,
    status: 'no_token',
    error_code: null,
  }));

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
      failureCount: 0,
      noTokenCount: noTokenUserIds.length,
      tokenResults: [],
      recipientRows,
    };
  }

  const langGroups = {};
  for (const device of userDevices) {
    const lang = device.language_code || 'en';
    if (!langGroups[lang]) langGroups[lang] = [];
    langGroups[lang].push(device);
  }

  let totalSuccess = 0;
  let totalFailure = 0;
  const allTokenResults = [];
  const batchPromises = [];

  for (const [lang, devices] of Object.entries(langGroups)) {
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
    failureCount: totalFailure,
    noTokenCount: noTokenUserIds.length,
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