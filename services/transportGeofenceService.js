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
import {
  notifyBoardingStopDeparted,
  notifyParentsAtNextStop,
} from './transportProactiveNotificationService.js';
import logger from '../utils/logger.js';

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
  return slow || dwelled;
};

/**
 * Evaluate one GPS fix against the active trip's geofences and apply at most
 * one status transition. Fire-and-forget from the location ingest path.
 *
 * @param {number} schoolId
 * @param {string} busId
 * @param {{latitude:number, longitude:number, speed?:number}} fix
 */
export async function evaluateGeofence(schoolId, busId, fix, db = sql) {
  try {
    if (fix?.latitude == null || fix?.longitude == null) return;

    const [trip] = await db`
      SELECT id, route_id, trip_direction FROM trips
      WHERE bus_id = ${busId} AND school_id = ${schoolId}
        AND status IN ('active', 'in_progress')
      ORDER BY created_at DESC LIMIT 1
    `;
    if (!trip) return;
    const leg = normalizeLeg(trip.trip_direction);

    const [cal] = await db`
      SELECT is_calibrated FROM route_leg_calibration
      WHERE school_id = ${schoolId} AND route_id = ${trip.route_id} AND trip_direction = ${leg}
    `;
    if (!cal?.is_calibrated) return; // manual mode until the leg graduates

    // ── 1. Auto-complete the stop we're at, once the bus pulls away ──
    const [arrived] = await db`
      SELECT tss.id, tss.stop_id, g.latitude, g.longitude, g.radius_m
      FROM trip_stop_status tss
      JOIN route_stop_geo g
        ON g.stop_id = tss.stop_id AND g.school_id = ${schoolId} AND g.trip_direction = ${leg}
      WHERE tss.trip_id = ${trip.id} AND tss.school_id = ${schoolId} AND tss.status = 'arrived'
      ORDER BY tss.stop_order ASC LIMIT 1
    `;
    if (arrived) {
      const d = distanceMeters(fix.latitude, fix.longitude, Number(arrived.latitude), Number(arrived.longitude));
      if (hasLeftRadius(d, Number(arrived.radius_m))) {
        const [claimed] = await db`
          UPDATE trip_stop_status SET status = 'completed', departure_time = now()
          WHERE id = ${arrived.id} AND school_id = ${schoolId} AND status = 'arrived'
          RETURNING stop_id
        `;
        if (claimed) {
          setImmediate(() => Promise.allSettled([
            notifyBoardingStopDeparted(schoolId, trip.id, claimed.stop_id, db),
            notifyParentsAtNextStop(schoolId, trip.id, claimed.stop_id, db),
          ]));
        }
      }
      return; // one transition per fix; don't also arrive the next stop
    }

    // ── 2. Auto-arrive the next expected pending stop ──
    const [next] = await db`
      SELECT tss.id, tss.stop_id, tss.stop_order, tss.geofence_hits, tss.first_seen_in_radius,
             g.latitude, g.longitude, g.radius_m
      FROM trip_stop_status tss
      JOIN route_stop_geo g
        ON g.stop_id = tss.stop_id AND g.school_id = ${schoolId} AND g.trip_direction = ${leg}
      WHERE tss.trip_id = ${trip.id} AND tss.school_id = ${schoolId} AND tss.status = 'pending'
      ORDER BY tss.stop_order ASC LIMIT 1
    `;
    if (!next) return;

    // Sequential guard: never arrive a stop while an earlier one is unresolved.
    const [earlier] = await db`
      SELECT 1 FROM trip_stop_status
      WHERE trip_id = ${trip.id} AND school_id = ${schoolId}
        AND stop_order < ${next.stop_order} AND status NOT IN ('completed', 'skipped')
      LIMIT 1
    `;
    if (earlier) return;

    const distM = distanceMeters(fix.latitude, fix.longitude, Number(next.latitude), Number(next.longitude));
    const radiusM = Number(next.radius_m);

    if (distM <= radiusM) {
      // The counter is part of the claim, not an in-memory read/modify/write:
      // two app instances may receive the same retry at the same time.
      const [hitState] = await db`
        UPDATE trip_stop_status
        SET geofence_hits = geofence_hits + 1,
            first_seen_in_radius = COALESCE(first_seen_in_radius, now())
        WHERE id = ${next.id}
          AND school_id = ${schoolId}
          AND status = 'pending'
        RETURNING geofence_hits, first_seen_in_radius
      `;
      if (!hitState) return;
      const firstSeenMs = hitState.first_seen_in_radius
        ? new Date(hitState.first_seen_in_radius).getTime()
        : Date.now();
      if (shouldAutoArrive({ hits: hitState.geofence_hits, firstSeenMs, nowMs: Date.now(), speedKmh: fix.speed, distM, radiusM })) {
        const [claimed] = await db`
          UPDATE trip_stop_status
          SET status = 'arrived', arrival_time = now(), arrival_source = 'geofence'
          WHERE id = ${next.id} AND school_id = ${schoolId} AND status = 'pending'
          RETURNING arrival_time
        `;
        if (claimed) {
          logger.info({ event: 'transport_geofence_auto_arrival', schoolId, busId, tripId: trip.id, stopId: next.stop_id }, 'Transport geofence auto-arrival');
          setImmediate(() => notifyParentsAtNextStop(
            schoolId,
            trip.id,
            next.stop_id,
            db,
          ));
          // Keep learning segment times in auto mode (geo excluded by source).
          recordArrivalCalibration({
            schoolId,
            tripId: trip.id,
            routeId: trip.route_id,
            tripDirection: trip.trip_direction,
            stopId: next.stop_id,
            stopOrder: next.stop_order,
            arrivalTime: claimed.arrival_time,
            source: 'geofence',
          }, db);
        }
      }
    } else if (next.geofence_hits > 0 || next.first_seen_in_radius) {
      // Left the radius without arriving (drove past) — reset the debounce.
      await db`
        UPDATE trip_stop_status SET geofence_hits = 0, first_seen_in_radius = NULL
        WHERE id = ${next.id} AND school_id = ${schoolId}
      `;
    }
  } catch (err) {
    logger.error({ err, event: 'transport_geofence_failed', schoolId, busId }, 'Transport geofence evaluation failed');
  }
}
