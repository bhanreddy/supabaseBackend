import sql from '../db.js';
import { sendNotificationToUsers } from './notificationService.js';

let timer = null;
let running = false;

async function resolveDeepLink(userId, schoolId) {
  const rows = await sql`
    SELECT r.code FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id AND r.school_id = ${schoolId}
    WHERE ur.user_id = ${userId} AND ur.school_id = ${schoolId}
  `;
  const codes = rows.map((r) => r.code);
  if (codes.includes('admin') || codes.includes('principal')) return '/admin/messages';
  if (codes.includes('teacher') || codes.includes('staff')) return '/staff/messages';
  return '/Screen/messages';
}

async function claimNext() {
  return sql.begin(async (tx) => {
    const [row] = await tx`
      SELECT * FROM support_message_notification_outbox
      WHERE status IN ('PENDING','FAILED') AND available_at <= now() AND attempts < 5
      ORDER BY available_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    if (!row) return null;
    const [claimed] = await tx`
      UPDATE support_message_notification_outbox
      SET status='PROCESSING', attempts=attempts+1, error=NULL
      WHERE id=${row.id}
      RETURNING *
    `;
    return claimed;
  });
}

export async function processSupportNotificationOutboxOnce() {
  const job = await claimNext();
  if (!job) return false;
  try {
    const deepLink = await resolveDeepLink(job.target_user_id, job.school_id);
    const report = await sendNotificationToUsers(
      [job.target_user_id],
      'MESSAGE_RECEIVED',
      { message: `Nexsyrus Support: ${job.preview}`, message_te: `Nexsyrus Support: ${job.preview}` },
      { deepLink },
    );
    if ((report?.successCount || 0) < 1) {
      throw new Error((report?.failureCount || 0) > 0 ? 'FCM delivery failed' : 'No active Android/iOS device token');
    }
    await sql`
      UPDATE support_message_notification_outbox
      SET status='SENT', processed_at=now(), error=NULL
      WHERE id=${job.id}
    `;
  } catch (error) {
    await sql`
      UPDATE support_message_notification_outbox
      SET status='FAILED', error=${String(error?.message || error).slice(0, 500)},
          available_at=now() + (attempts * interval '30 seconds')
      WHERE id=${job.id}
    `;
  }
  return true;
}

async function drain() {
  if (running) return;
  running = true;
  try {
    for (let i = 0; i < 20; i += 1) {
      if (!(await processSupportNotificationOutboxOnce())) break;
    }
  } catch (error) {
    console.error('[support-notification-outbox]', error?.message || error);
  } finally {
    running = false;
  }
}

export function startSupportNotificationOutboxWorker() {
  if (timer) return;
  drain();
  timer = setInterval(drain, 3000);
  timer.unref?.();
}

export function stopSupportNotificationOutboxWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
