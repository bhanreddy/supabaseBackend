
import express from 'express';
import { sendSuccess } from '../utils/apiResponse.js';
import sql from '../db.js';
import { withRetry } from '../utils/retry.js';
import { verifyAccessTokenIdentity } from '../middleware/auth.js';

const router = express.Router();


router.post('/register', async (req, res, next) => {
    try {
        // identifyUser middleware populates req.user
        const { fcm_token, platform, language_code } = req.body;
        const user_id = req.user?.id;
        const school_id = req.schoolId;

        if (!user_id || !school_id) return res.status(401).json({ error: 'Unauthorized' });
        if (!fcm_token) return res.status(400).json({ error: 'Token required' });

        // Validate language_code (only 'en' and 'te' supported)
        const validLang = ['en', 'te'].includes(language_code) ? language_code : 'en';

        await withRetry(async () => {
            // Remove token from any other user to prevent cross-account notifications
            await sql`DELETE FROM user_devices WHERE fcm_token = ${fcm_token} AND user_id != ${user_id}`;

            await sql`
                INSERT INTO user_devices (user_id, school_id, fcm_token, platform, language_code, last_used_at, is_active, updated_at)
                VALUES (${user_id}, ${school_id}, ${fcm_token}, ${platform || 'unknown'}, ${validLang}, now(), true, now())
                ON CONFLICT (school_id, user_id, fcm_token) 
                DO UPDATE SET school_id = EXCLUDED.school_id, last_used_at = now(), platform = EXCLUDED.platform, language_code = EXCLUDED.language_code, is_active = true, updated_at = now()
            `;
        }, { retries: 2, delayMs: 1000 });


        return sendSuccess(res, req.schoolId, { success: true, message: 'Token registered' });
    } catch (error) {
        next(error);
    }
});

router.post('/unregister', async (req, res, next) => {
    try {
        const { fcm_token } = req.body;
        const user_id = req.user?.id;

        if (!user_id) return res.status(401).json({ error: 'Unauthorized' });
        if (!fcm_token) return res.status(400).json({ error: 'fcm_token is required' });

        await withRetry(async () => {
            await sql`
                DELETE FROM user_devices WHERE user_id = ${user_id} AND fcm_token = ${fcm_token}
            `;
        }, { retries: 2, delayMs: 1000 });


        return sendSuccess(res, req.schoolId, { success: true, message: 'Token unregistered' });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /inbox — A recipient's durable notification history. The account and
 * school are always derived from the authenticated request; no user id is
 * accepted from the client.
 */
router.get('/inbox', async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const schoolId = req.schoolId;
        if (!userId || !schoolId) return res.status(401).json({ error: 'Unauthorized' });

        const requested = Number.parseInt(String(req.query.limit || '50'), 10);
        const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : 50;

        const notifications = await sql`
            SELECT
                n.id,
                n.title,
                n.body,
                n.action_url AS "actionUrl",
                n.created_at AS "createdAt",
                n.read_at AS "readAt",
                e.event_type AS type
            FROM notifications n
            LEFT JOIN notification_events e ON e.id = n.event_id
            WHERE n.user_id = ${userId}
              AND n.school_id = ${schoolId}
              AND n.deleted_at IS NULL
            ORDER BY n.created_at DESC
            LIMIT ${limit}
        `;

        return sendSuccess(res, schoolId, { notifications });
    } catch (error) {
        next(error);
    }
});

/** Mark a notification as read only when it belongs to the signed-in user. */
router.post('/:notificationId/read', async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const schoolId = req.schoolId;
        const notificationId = req.params.notificationId;
        if (!userId || !schoolId) return res.status(401).json({ error: 'Unauthorized' });

        const rows = await sql`
            UPDATE notifications
            SET read_at = COALESCE(read_at, NOW()), status = 'READ'
            WHERE id = ${notificationId}
              AND user_id = ${userId}
              AND school_id = ${schoolId}
              AND deleted_at IS NULL
            RETURNING id, read_at AS "readAt"
        `;

        if (!rows[0]) return res.status(404).json({ error: 'Notification not found' });
        return sendSuccess(res, schoolId, { notification: rows[0] });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /register-multi  — Phase 3a multi-account FCM fan-out.
 *
 * Body: { fcmToken, accounts: [{ accessToken }], platform?, language_code? }
 *   - NO user_id is accepted anywhere in `accounts`. Identity {userId, schoolId}
 *     is derived SERVER-SIDE from each accessToken via verifyAccessTokenIdentity.
 *   - Each entry is validated independently; an invalid/expired token skips ONLY
 *     that entry (the batch never fails as a whole) and records a reason.
 *   - Same fcm_token is intentionally registered under MULTIPLE user_ids (one row
 *     per (school_id, user_id, fcm_token) — the unique key). We DELIBERATELY do
 *     NOT run the single /register route's "DELETE ... WHERE user_id != x" cross-
 *     account purge: that purge is the opposite of fan-out and would evict siblings.
 *   - A validated entry whose schoolId differs from the rest of the batch is
 *     rejected (that entry only) and flagged loudly — should never happen on a
 *     single-tenant build, but is not allowed to pass silently.
 *
 * Response: { results: [{ success, userId?, reason? }] } in the same order as the
 * request `accounts` array (delivered inside the standard sendSuccess envelope).
 *
 * NOTE: Unregistration-on-removal is OUT OF SCOPE here (Phase 3b).
 */
router.post('/register-multi', async (req, res, next) => {
    try {
        const { fcmToken, accounts, platform, language_code } = req.body;

        if (!fcmToken || typeof fcmToken !== 'string') {
            return res.status(400).json({ error: 'fcmToken is required' });
        }
        if (!Array.isArray(accounts)) {
            return res.status(400).json({ error: 'accounts must be an array' });
        }

        const validLang = ['en', 'te'].includes(language_code) ? language_code : 'en';
        const plat = platform || 'unknown';

        const results = [];
        let batchSchoolId = null; // first validated school becomes the batch baseline

        for (const entry of accounts) {
            // INVARIANT: only `accessToken` is read. Any client-supplied user_id is
            // ignored — identity is derived solely from the verified token.
            const accessToken = entry && typeof entry === 'object' ? entry.accessToken : null;

            const identity = await verifyAccessTokenIdentity(accessToken);
            if (!identity.ok) {
                results.push({ success: false, reason: identity.reason });
                continue;
            }

            const { userId, schoolId } = identity;

            // Same-school cross-check (single-tenant build): flag mismatches loudly.
            if (batchSchoolId === null) {
                batchSchoolId = schoolId;
            } else if (String(schoolId) !== String(batchSchoolId)) {
                console.error(
                    `[register-multi] SCHOOL MISMATCH: user ${userId} resolved to school ${schoolId} ` +
                    `but batch baseline is ${batchSchoolId} — rejecting this entry.`
                );
                results.push({ success: false, userId, reason: 'school_mismatch' });
                continue;
            }

            try {
                await withRetry(async () => {
                    // Idempotent upsert against UNIQUE(school_id, user_id, fcm_token).
                    // No cross-account DELETE here — fan-out keeps every account's row.
                    await sql`
                        INSERT INTO user_devices (user_id, school_id, fcm_token, platform, language_code, last_used_at, is_active, updated_at)
                        VALUES (${userId}, ${schoolId}, ${fcmToken}, ${plat}, ${validLang}, now(), true, now())
                        ON CONFLICT (school_id, user_id, fcm_token)
                        DO UPDATE SET last_used_at = now(), platform = EXCLUDED.platform, language_code = EXCLUDED.language_code, is_active = true, updated_at = now()
                    `;
                }, { retries: 2, delayMs: 1000 });

                results.push({ success: true, userId });
            } catch (writeErr) {
                console.error(`[register-multi] DB write failed for user ${userId}:`, writeErr?.message || writeErr);
                results.push({ success: false, userId, reason: 'db_write_failed' });
            }
        }

        return sendSuccess(res, batchSchoolId, { results });
    } catch (error) {
        next(error);
    }
});

// Phase 4a-continued (CASE B): The original product concept included a separate
// "chat unread count" badge alongside notifications (e.g. "9 chats" / "12
// notifications"). As of this phase, no chat/messaging feature exists in the
// codebase to back a chat count — schema.sql has no chat/conversation table,
// routes/ has no /chat or /message API, and the client has no parent–teacher
// messaging screen. This endpoint reflects notifications only. Revisit when/if
// a chat feature is built (add a chatCount query here and extend the response).
//
// Phase 4b UI contract (no UI exists yet): render the notification badge only
// when count > 0 — standard zero-state badge behavior, not a workaround.
/**
 * POST /unread-counts  — Phase 4a per-account unread badges.
 *
 * Body: { accounts: [{ accessToken }] }
 *   - NO user_id anywhere. Identity {userId, schoolId} is derived SERVER-SIDE from
 *     each accessToken via verifyAccessTokenIdentity, identical to register-multi.
 *   - Read-only: for each validated entry, COUNT unread notifications scoped to
 *     that user_id + school_id. "Unread" = read_at IS NULL (the nullable-timestamp
 *     read marker on the notifications table) AND deleted_at IS NULL (this system
 *     is soft-delete by design; soft-deleted rows must not be counted).
 *   - Invalid/expired token → that entry gets {success:false, reason}; the batch
 *     continues (per-entry independent, same as register-multi).
 *
 * Response: { results: [{ success, userId?, count?, reason? }] } in the same order
 * as the request `accounts` array (inside the standard sendSuccess envelope).
 */
router.post('/unread-counts', async (req, res, next) => {
    try {
        const { accounts } = req.body;

        if (!Array.isArray(accounts)) {
            return res.status(400).json({ error: 'accounts must be an array' });
        }

        const results = [];
        let batchSchoolId = null; // first validated school → sendSuccess envelope

        for (const entry of accounts) {
            // INVARIANT: only `accessToken` is read; any client-supplied user_id is ignored.
            const accessToken = entry && typeof entry === 'object' ? entry.accessToken : null;

            const identity = await verifyAccessTokenIdentity(accessToken);
            if (!identity.ok) {
                results.push({ success: false, reason: identity.reason });
                continue;
            }

            const { userId, schoolId } = identity;

            // Same-school cross-check (single-tenant build): reject — never fail the
            // whole batch — any entry whose school differs from the batch baseline.
            // Mirrors /register-multi's logic exactly.
            if (batchSchoolId === null) {
                batchSchoolId = schoolId;
            } else if (String(schoolId) !== String(batchSchoolId)) {
                console.error(
                    `[unread-counts] SCHOOL MISMATCH: user ${userId} resolved to school ${schoolId} ` +
                    `but batch baseline is ${batchSchoolId} — rejecting this entry.`
                );
                results.push({ success: false, userId, reason: 'school_mismatch' });
                continue;
            }

            try {
                const rows = await sql`
                    SELECT COUNT(*)::int AS count
                    FROM notifications
                    WHERE user_id = ${userId}
                      AND school_id = ${schoolId}
                      AND read_at IS NULL
                      AND deleted_at IS NULL
                `;
                const count = rows[0]?.count ?? 0;
                results.push({ success: true, userId, count });
            } catch (queryErr) {
                console.error(`[unread-counts] query failed for user ${userId}:`, queryErr?.message || queryErr);
                results.push({ success: false, userId, reason: 'query_failed' });
            }
        }

        return sendSuccess(res, batchSchoolId, { results });
    } catch (error) {
        next(error);
    }
});

export default router;
