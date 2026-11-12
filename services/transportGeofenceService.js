/** GPS matching completes a stop checkpoint and alerts the following stop.
 * Multiple fresh, consistent fixes prevent transient GPS spikes from marking
 * stops. Actual departure is tracked independently after the bus pulls away.
 */
import sql from '../db.js';
import { recordArrivalCalibration } from './transportCalibrationService.js';
import { enqueueTransitionNotifications } from './transportTripService.js';
import { enqueueStopNotification } from './transportOutboxService.js';

export const GEOFENCE = {
  /** Consecutive in-radius fixes required before arriving (debounce a GPS spike). */
  DEBOUNCE_HITS: 2,
  /** Fast sampling must still provide independent evidence over time. */
  MIN_ARRIVAL_SPAN_MS: 4000,
  /** Dwell time in-radius that also satisfies arrival when speed is unknown (ms). */
  DWELL_MS: 8000,
  /** At/below this speed the bus is treated as stopped/boarding (km/h). */
  SLOW_SPEED_KMH: 10,
  /** Auto-complete once the bus is this multiple of the radius away (hysteresis). */
  EXIT_RADIUS_FACTOR: 1.6,
};

/** Haversine distance in meters. */
export const distanceMeters = (lat1, lon1, lat2, lon2) => {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/** Pure: has the bus left an arrived stop far enough to auto-complete it? */
export const hasLeftRadius = (distM, radiusM, factor = GEOFENCE.EXIT_RADIUS_FACTOR) =>
  distM >= radiusM * factor;

/**
 * Pure: given the (already-incremented) hit count and dwell/speed, should the
 * next pending stop auto-arrive? Requires being inside the radius.
 */
export const shouldAutoArrive = ({ hits, firstSeenMs, nowMs, speedKmh, distM, radiusM }) => {
  if (distM > radiusM) return false;
  if (hits < GEOFENCE.DEBOUNCE_HITS) return false;
  if (firstSeenMs == null || !Number.isFinite(firstSeenMs) || !Number.isFinite(nowMs) || nowMs - firstSeenMs < GEOFENCE.MIN_ARRIVAL_SPAN_MS) return false;
  const slow = speedKmh != null && Number.isFinite(Number(speedKmh)) && Number(speedKmh) >= 0 && Number(speedKmh) < GEOFENCE.SLOW_SPEED_KMH;
  const dwelled = firstSeenMs != null && nowMs - firstSeenMs >= GEOFENCE.DWELL_MS;
  return speedKmh != null ? slow : dwelled;
};

/** Complete a reached checkpoint on GPS confirmation; record departure separately.
 * Runs inside the serialized ingest transaction, using qualified raw fixes.
 */
export async function evaluateGeofence(schoolId, busId, fix, db = sql, trip) {
  const legacy = fix.legacy_accuracy_unknown === true;
  if (!trip || fix.is_mocked || !['active', 'in_progress'].includes(trip.status)) return;
  if (!legacy && (typeof fix.accuracy !== 'number' || fix.accuracy < 0 || fix.accuracy > 50)) return;
  const [stop] = await db`SELECT * FROM trip_stop_status WHERE school_id=${schoolId} AND trip_id=${trip.id}
    AND (status IN ('pending','arrived') OR (status='completed' AND departure_time IS NULL))
    ORDER BY stop_order LIMIT 1 FOR UPDATE`;
  if (!stop || stop.snapshot_latitude == null || stop.snapshot_longitude == null) return;
  // Surveyed/admin-locked coordinates can be used on the very first trip.
  // Inferred stop coordinates still require route calibration.
  if (!trip.auto_stops_enabled && !['surveyed', 'override'].includes(stop.coordinate_source)) return;
  const distM = distanceMeters(fix.latitude, fix.longitude, Number(stop.snapshot_latitude), Number(stop.snapshot_longitude));
  const radiusM = Number(stop.snapshot_radius_m), nowMs = Date.parse(fix.recorded_at);
  if (!Number.isFinite(radiusM) || radiusM <= 0 || !Number.isFinite(nowMs)) return;
  if (stop.status === 'arrived' && hasLeftRadius(distM - (legacy ? 30 : fix.accuracy), radiusM)) {
    const [departed] = await db`UPDATE trip_stop_status SET status='completed',departure_time=${fix.recorded_at}::timestamptz
      WHERE id=${stop.id} AND school_id=${schoolId} AND status='arrived' RETURNING *`;
    if (departed) await enqueueTransitionNotifications(trip, departed, db);
    return;
  }
  if (stop.status === 'completed') {
    // A reached checkpoint is already visible as completed to older apps.
    // Departure is evidence of leaving the stop, never a side effect of arrival.
    if (!hasLeftRadius(distM - (legacy ? 30 : fix.accuracy), radiusM)) return;
    const [departed] = await db`UPDATE trip_stop_status SET departure_time=${fix.recorded_at}::timestamptz
      WHERE id=${stop.id} AND school_id=${schoolId} AND departure_time IS NULL RETURNING *`;
    if (departed) await enqueueTransitionNotifications(trip, departed, db);
    return;
  }
  // Old apps omit accuracy. Require a tighter match, three fixes, and a full
  // eight-second stop instead of assigning them a fabricated sensor accuracy.
  const inside = legacy ? distM <= Math.min(30, radiusM) : distM + fix.accuracy <= radiusM;
  const continuous = stop.geofence_last_at && nowMs - new Date(stop.geofence_last_at).getTime() <= 45000;
  const hits = inside ? (continuous ? stop.geofence_hits : 0) + 1 : 0;
  const first = inside ? (continuous && stop.first_seen_in_radius ? stop.first_seen_in_radius : fix.recorded_at) : null;
  await db`UPDATE trip_stop_status SET geofence_hits=${hits},first_seen_in_radius=${first},geofence_last_at=${fix.recorded_at}
    WHERE id=${stop.id} AND school_id=${schoolId}`;
  const confirmed = inside && shouldAutoArrive({ hits, firstSeenMs: first ? new Date(first).getTime() : null,
    nowMs, speedKmh: fix.speed, distM, radiusM })
    && (!legacy || hits >= 3 && nowMs - new Date(first).getTime() >= GEOFENCE.DWELL_MS);
  if (!confirmed) return;
  const [reached] = await db`UPDATE trip_stop_status SET status='completed',
    arrival_time=COALESCE(arrival_time,${fix.recorded_at}::timestamptz),arrival_source=COALESCE(arrival_source,'geofence')
    WHERE id=${stop.id} AND school_id=${schoolId} AND status=${stop.status} RETURNING *`;
  if (!reached) return;
  await enqueueStopNotification(trip, reached.stop_id, 'BUS_STOP_REACHED', { stopName: reached.snapshot_name || 'stop' }, db);
  await enqueueTransitionNotifications(trip, reached, db, { notifyDeparture: false });
  await recordArrivalCalibration({ schoolId, tripId: trip.id, routeId: trip.route_id,
    tripDirection: trip.trip_direction, stopId: stop.stop_id, stopOrder: stop.stop_order,
    arrivalTime: reached.arrival_time, source: 'geofence' }, db);
}
