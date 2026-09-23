/**
 * Transport geofence service — live tracking v2, Phase B.
 * (see TRANSPORT_LIVE_TRACKING_PLAN.md)
 *
 * Once a route-leg is calibrated (Phase A), the server auto-drives the stop
 * sequence from the driver's live GPS on each location ingest — so parents see
 * the bus arrive/depart even with the driver's screen off. Manual marking stays
 * available and wins (the same atomic status guards apply).
 *
 * Trigger = sequence + proximity + debounce + dwell (not bare proximity):
 *   arrive   → next expected stop, inside learned radius, for ≥ DEBOUNCE_HITS
 *              consecutive fixes AND (slow speed OR dwelled) — kills false
 *              arrivals from merely driving past a nearby stop.
 *   complete → an arrived stop, once the bus leaves radius × EXIT_RADIUS_FACTOR
 *              (hysteresis). The bus pulling away is the depart signal, and it
 *              feeds the next stop's learned segment time.
 * One transition per fix keeps ordering strict. Uncalibrated legs are ignored
 * (manual mode). Never throws into the request path.
 */
import sql from '../db.js';
import { normalizeLeg, recordArrivalCalibration } from './transportCalibrationService.js';
import { enqueueTransitionNotifications } from './transportTripService.js';

export const GEOFENCE = {
  /** Consecutive in-radius fixes required before arriving (debounce a GPS spike). */
  DEBOUNCE_HITS: 2,
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
  const slow = speedKmh != null && Number(speedKmh) < GEOFENCE.SLOW_SPEED_KMH;
  const dwelled = firstSeenMs != null && nowMs - firstSeenMs >= GEOFENCE.DWELL_MS;
  return speedKmh != null ? slow : dwelled;
};

/**
 * Evaluate one GPS fix against the active trip's geofences and apply at most
 * one status transition. Fire-and-forget from the location ingest path.
 *
 * @param {number} schoolId
 * @param {string} busId
 * @param {{latitude:number, longitude:number, speed?:number}} fix
 */
export async function evaluateGeofence(schoolId, busId, fix, db = sql, trip) {
  if (!trip?.auto_stops_enabled || fix.is_mocked || typeof fix.accuracy !== 'number' || fix.accuracy<0 || fix.accuracy>50) return;
  const [stop] = await db`SELECT * FROM trip_stop_status WHERE school_id=${schoolId} AND trip_id=${trip.id}
    AND status IN ('pending','arrived') ORDER BY stop_order LIMIT 1 FOR UPDATE`;
  if (!stop || stop.snapshot_latitude == null || stop.snapshot_longitude == null) return;
  const distM=distanceMeters(fix.latitude,fix.longitude,Number(stop.snapshot_latitude),Number(stop.snapshot_longitude));
  const radiusM=Number(stop.snapshot_radius_m), nowMs=Date.parse(fix.recorded_at);
  let target=null;
  if (stop.status==='arrived') {
    if (hasLeftRadius(distM-fix.accuracy,radiusM)) target='completed';
  } else {
    const continuous=stop.geofence_last_at && nowMs-new Date(stop.geofence_last_at).getTime()<=45000;
    const inside=distM+fix.accuracy<=radiusM;
    const hits=inside ? (continuous ? stop.geofence_hits : 0)+1 : 0;
    const first=inside ? (continuous && stop.first_seen_in_radius ? stop.first_seen_in_radius : fix.recorded_at) : null;
    await db`UPDATE trip_stop_status SET geofence_hits=${hits},first_seen_in_radius=${first},geofence_last_at=${fix.recorded_at}
      WHERE id=${stop.id} AND school_id=${schoolId}`;
    if (inside && shouldAutoArrive({hits,firstSeenMs:new Date(first).getTime(),nowMs,speedKmh:fix.speed,distM,radiusM})) target='arrived';
  }
  if (!target) return;
  const [updated]=await db`UPDATE trip_stop_status SET status=${target},
    arrival_time=CASE WHEN ${target}='arrived' THEN ${fix.recorded_at}::timestamptz ELSE arrival_time END,
    arrival_source=CASE WHEN ${target}='arrived' THEN 'geofence' ELSE arrival_source END,
    departure_time=CASE WHEN ${target}='completed' THEN ${fix.recorded_at}::timestamptz ELSE departure_time END
    WHERE id=${stop.id} AND school_id=${schoolId} AND status=${stop.status} RETURNING *`;
  if (!updated) return;
  await enqueueTransitionNotifications(trip,updated,db);
  if (target==='arrived') await recordArrivalCalibration({schoolId,tripId:trip.id,routeId:trip.route_id,
    tripDirection:trip.trip_direction,stopId:stop.stop_id,stopOrder:stop.stop_order,arrivalTime:fix.recorded_at,source:'geofence'},db);
}
