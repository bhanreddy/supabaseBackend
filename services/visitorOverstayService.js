import sql from '../db.js';
import { sendNotificationToUsers } from './notificationService.js';

const THROTTLE_MINUTES = 30;
let timer = null;

export async function processOverstayAlerts() {
  const overstays = await sql`
    SELECT
      vc.id AS checkin_id,
      vc.school_id,
      vc.expected_checkout_at,
      vprof.full_name AS visitor_name,
      vr.host_user_id,
      oa.last_notified_at
    FROM public.visitor_checkins vc
    JOIN public.visitor_profiles vprof ON vprof.id = vc.visitor_profile_id
    JOIN public.visitor_requests vr ON vr.id = vc.visitor_request_id
    JOIN public.school_visitor_settings svs ON svs.school_id = vc.school_id
    LEFT JOIN public.visitor_overstay_alerts oa ON oa.checkin_id = vc.id
    WHERE vc.checked_out_at IS NULL
      AND svs.enable_overstay_alerts = true
      AND NOW() > vc.expected_checkout_at + make_interval(mins => COALESCE(svs.overstay_threshold_minutes, 30))
      AND (oa.last_notified_at IS NULL OR oa.last_notified_at < NOW() - (${THROTTLE_MINUTES} || ' minutes')::interval)
  `;

  for (const row of overstays) {
    const recipients = new Set();
    if (row.host_user_id) recipients.add(row.host_user_id);
    const admins = await sql`
      SELECT u.id FROM public.users u
      JOIN public.user_roles ur ON ur.user_id = u.id AND ur.school_id = ${row.school_id}
      JOIN public.roles r ON r.id = ur.role_id AND r.code IN ('admin', 'principal')
      WHERE u.school_id = ${row.school_id} AND u.account_status = 'active' AND u.deleted_at IS NULL
    `;
    admins.forEach((a) => recipients.add(a.id));

    if (recipients.size > 0) {
      try {
        await sendNotificationToUsers(
          [...recipients],
          'VISITOR_OVERSTAYED',
          {
            title: 'Visitor overstay alert',
            body: `${row.visitor_name} has exceeded the expected checkout time.`,
            visitorName: row.visitor_name,
            message: `${row.visitor_name} has exceeded the expected checkout time.`,
          },
          { schoolId: row.school_id }
        );
      } catch (err) {
        console.error('[OverstayEngine] notify failed:', err.message);
      }
    }

    await sql`
      INSERT INTO public.visitor_overstay_alerts (school_id, checkin_id, last_notified_at, notify_count)
      VALUES (${row.school_id}, ${row.checkin_id}, NOW(), 1)
      ON CONFLICT (checkin_id)
      DO UPDATE SET last_notified_at = NOW(), notify_count = public.visitor_overstay_alerts.notify_count + 1
    `;
  }

  return overstays.length;
}

export function startVisitorOverstayWorker() {
  if (timer) return;
  timer = setInterval(() => {
    processOverstayAlerts().catch((err) => {
      console.error('[OverstayEngine]', err.message);
    });
  }, 5 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopVisitorOverstayWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
