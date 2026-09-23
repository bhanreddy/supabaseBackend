import { createHash } from 'node:crypto';
import sql from '../db.js';
import logger from '../utils/logger.js';

/** Must be called using the transaction that owns the corresponding transition. */
export async function enqueueTransportUsers({
  schoolId,
  tripId = null,
  stopId = null,
  key,
  type,
  userIds,
  vars = {},
  expiresSeconds = 86400
}, db = sql) {
  for (const userId of new Set(userIds)) {
    await db`INSERT INTO transport_outbox(school_id,event_key,trip_id,stop_id,event_type,payload,expires_at)
      SELECT ${schoolId},${`${key}:${userId}`},${tripId},${stopId},${type},
        ${db.json({
      user_id: userId,
      vars
    })},now()+${expiresSeconds}*interval '1 second'
      FROM users WHERE id=${userId} AND school_id=${schoolId} AND deleted_at IS NULL AND account_status='active'
      ON CONFLICT(school_id,event_key) DO NOTHING`;
  }
}
export async function enqueueStopNotification(trip, stopId, type, vars = {}, db = sql, {
  studentIds = null,
  keySuffix = ''
} = {}) {
  const parents = await db`SELECT DISTINCT u.id, st.student_id, person.display_name AS student_name, ss.snapshot_name AS stop_name, ba.status AS attendance_status FROM transport_trip_roster st
    JOIN trip_stop_status ss ON ss.school_id=st.school_id AND ss.trip_id=st.trip_id AND ss.stop_id=st.stop_id
    JOIN students student ON student.school_id=st.school_id AND student.id=st.student_id AND student.deleted_at IS NULL
    JOIN persons person ON person.id=student.person_id
    LEFT JOIN bus_stop_attendance ba ON ba.school_id=st.school_id AND ba.trip_id=st.trip_id AND ba.stop_id=st.stop_id AND ba.student_id=st.student_id
    JOIN student_parents sp ON sp.student_id=st.student_id AND sp.school_id=st.school_id AND sp.deleted_at IS NULL
    JOIN parents p ON p.id=sp.parent_id AND p.school_id=st.school_id AND p.deleted_at IS NULL
    JOIN users u ON u.person_id=p.person_id AND u.school_id=st.school_id AND u.deleted_at IS NULL
    WHERE st.school_id=${trip.school_id} AND st.trip_id=${trip.id}
      AND (sp.valid_from IS NULL OR sp.valid_from<=${trip.trip_date}::date) AND (sp.valid_to IS NULL OR sp.valid_to>=${trip.trip_date}::date)
      ${stopId ? db`AND st.stop_id=${stopId}` : db``}
      ${studentIds ? db`AND st.student_id=ANY(${db.array(studentIds)}::uuid[])` : db``}`;
  for (const parent of parents) {
    const personalized = ['TRANSPORT_BUS_DEPARTED', 'STUDENT_BUS_PRESENT', 'STUDENT_BUS_ABSENT'].includes(type);
    const attendance = parent.attendance_status;
    const boarding = attendance === 'present' ? 'was marked present by the driver' : attendance === 'absent' ? 'was marked absent by the driver' : 'has no confirmed boarding record';
    const boardingTe = attendance === 'present' ? 'హాజరుగా నమోదు చేయబడ్డారు' : attendance === 'absent' ? 'గైర్హాజరుగా నమోదు చేయబడ్డారు' : 'బస్సు హాజరు నిర్ధారణ కాలేదు';
    await enqueueTransportUsers({
      schoolId: trip.school_id,
      tripId: trip.id,
      stopId,
      key: `${trip.id}:${stopId || 'route'}:${type}:${keySuffix}:${personalized ? parent.student_id : ''}`,
      type,
      userIds: [parent.id],
      vars: {
        ...vars,
        stopName: parent.stop_name || vars.stopName,
        studentName: parent.student_name || 'Your child',
        ...(type === 'TRANSPORT_BUS_DEPARTED' ? {
          boardingStatus: boarding,
          boardingStatus_te: boardingTe
        } : {})
      },
      expiresSeconds: ['TRANSPORT_BUS_APPROACHING', 'TRANSPORT_BUS_RUNNING_LATE'].includes(type) ? 600 : 86400
    }, db);
  }
}

/** Lease + SKIP LOCKED permits multiple hosts and recovers crashed workers. */
export async function drainTransportOutbox(db = sql, send, limit = 30) {
  if (!send) {
    const module = await import('./notificationService.js');
    send = module.sendNotificationToUsersWithReport;
  }
  const rows = await db`WITH candidates AS (
    SELECT id FROM transport_outbox WHERE status IN ('pending','processing') AND available_at<=now()
    ORDER BY available_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
  ) UPDATE transport_outbox o SET status='processing',lease_id=gen_random_uuid(),
      available_at=now()+interval '5 minutes',attempts=attempts+1
    FROM candidates c WHERE c.id=o.id RETURNING o.*`;
  await Promise.all(rows.map(async row => {
    let status = 'sent';
    let errorCode = null;
    const deliveredTokenHashes = new Set(row.payload.delivered_token_hashes || []);
    try {
      let expired = new Date(row.expires_at).getTime() <= Date.now();
      if (!expired && ['TRANSPORT_BUS_APPROACHING', 'TRANSPORT_BUS_RUNNING_LATE'].includes(row.event_type)) {
        const [current] = await db`SELECT 1 FROM trips t JOIN trip_stop_status s ON s.trip_id=t.id AND s.school_id=t.school_id
          WHERE t.id=${row.trip_id} AND t.school_id=${row.school_id} AND t.status IN ('active','in_progress')
          AND s.stop_id=${row.stop_id} AND s.status='pending'`;
        expired = !current;
      }
      if (!expired && row.trip_id && !['TRANSPORT_SOS_ALERT', 'TRANSPORT_OVERSPEED_ALERT'].includes(row.event_type)) {
        const [authorized] = await db`SELECT 1 FROM trips t JOIN student_transport st ON st.school_id=t.school_id AND st.route_id=t.route_id AND st.is_active=true
          JOIN academic_years ay ON ay.id=st.academic_year_id AND ay.school_id=st.school_id
          JOIN student_parents sp ON sp.student_id=st.student_id AND sp.school_id=st.school_id AND sp.deleted_at IS NULL
          JOIN parents p ON p.id=sp.parent_id AND p.school_id=st.school_id AND p.deleted_at IS NULL
          JOIN users u ON u.person_id=p.person_id AND u.school_id=st.school_id AND u.deleted_at IS NULL AND u.account_status='active'
          WHERE t.id=${row.trip_id} AND t.school_id=${row.school_id} AND u.id=${row.payload.user_id}
          AND (now() AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ay.start_date AND ay.end_date
          AND (sp.valid_from IS NULL OR sp.valid_from<=CURRENT_DATE) AND (sp.valid_to IS NULL OR sp.valid_to>=CURRENT_DATE)
          ${row.stop_id ? db`AND st.stop_id=${row.stop_id}` : db``} LIMIT 1`;
        expired = !authorized;
      }
      if (expired) status = 'expired';else {
        const result = await send([row.payload.user_id], row.event_type, row.payload.vars, {
          schoolId: row.school_id,
          idempotencyKey: `transport:${row.id}`,
          requireInbox: true,
          deliveredTokenHashes: [...deliveredTokenHashes]
        });
        for (const outcome of result.tokenResults || []) if (outcome.success && outcome.token) deliveredTokenHashes.add(createHash('sha256').update(outcome.token).digest('hex'));
        if (result.disabledCount > 0) status = 'expired';else if (result.failureCount > 0) throw new Error('PROVIDER_REJECTED');else if (!result.successCount && deliveredTokenHashes.size === 0) status = 'inbox_only';
      }
    } catch {
      status = row.attempts >= 8 ? 'failed' : 'pending';
      errorCode = 'DELIVERY_UNCONFIRMED';
      logger.warn({
        event: 'transport_delivery_retry',
        schoolId: row.school_id,
        eventId: row.id,
        attempts: row.attempts
      });
    }
    const retrySeconds = Math.min(1800, 5 * 2 ** row.attempts) + Math.floor(Math.random() * 5);
    await db`UPDATE transport_outbox SET status=${status},last_error=${errorCode},
      payload=${db.json({
      ...row.payload,
      delivered_token_hashes: [...deliveredTokenHashes]
    })},
      available_at=now()+${retrySeconds}*interval '1 second',
      delivered_at=CASE WHEN ${status} IN ('sent','inbox_only') THEN now() ELSE delivered_at END
      WHERE id=${row.id} AND school_id=${row.school_id} AND lease_id=${row.lease_id}`;
  }));
  return rows.length;
}
let wakeRunning = false;
/** Optimization only. pg-boss also drains durable rows after process restart. */
export function wakeTransportOutbox() {
  if (wakeRunning) return;
  wakeRunning = true;
  setImmediate(() => drainTransportOutbox().catch(() => {
    logger.warn({
      event: 'transport_outbox_unavailable'
    });
  }).finally(() => {
    wakeRunning = false;
  }));
}
