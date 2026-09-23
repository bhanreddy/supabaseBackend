import { enqueueStopNotification } from './transportOutboxService.js';
import { projectDelayAtStop, isRunningLate } from './transportProactiveNotificationService.js';
import { distanceMeters } from './transportGeofenceService.js';
/** Called inside the serialized trip/GPS transaction. Outbox keys are the dedupe authority. */
export async function evaluateTripSignals(trip, fix, db) {
  if (fix.is_mocked || fix.accuracy == null || fix.accuracy > 50) return;
  const stops = await db`SELECT stop_id,snapshot_name AS name,snapshot_latitude AS latitude,snapshot_longitude AS longitude,status,stop_order
    FROM trip_stop_status WHERE trip_id=${trip.id} AND school_id=${trip.school_id} ORDER BY stop_order`;
  const next = stops.find(s => s.status === 'pending');
  if (!next) return;
  if (next.latitude != null && next.longitude != null && distanceMeters(fix.latitude, fix.longitude, Number(next.latitude), Number(next.longitude)) <= 800) {
    await enqueueStopNotification(trip, next.stop_id, 'TRANSPORT_BUS_APPROACHING', {
      stopName: next.name
    }, db);
  }
  if (!trip.auto_stops_enabled) return;
  const rows = await db`SELECT from_stop_id,to_stop_id,ewma_seconds FROM route_segment_time
    WHERE school_id=${trip.school_id} AND route_id=${trip.route_id} AND trip_direction=${trip.trip_direction}`;
  const segments = Object.fromEntries(rows.map(r => [`${r.from_stop_id}->${r.to_stop_id}`, r]));
  const projected = projectDelayAtStop({
    startedAt: trip.started_at,
    now: fix.recorded_at,
    fix,
    stops,
    segments,
    targetStopId: next.stop_id
  });
  if (projected && isRunningLate(projected.delayMinutes)) await enqueueStopNotification(trip, next.stop_id, 'TRANSPORT_BUS_RUNNING_LATE', {
    delayMinutes: String(Math.round(projected.delayMinutes))
  }, db);
}
