/**
 * Transport calibration service — live tracking v2, Phase A.
 * (see TRANSPORT_LIVE_TRACKING_PLAN.md)
 *
 * While a route-leg is uncalibrated, every MANUAL stop mark from the driver
 * app feeds two learning tables:
 *   - route_stop_geo      accuracy-weighted GPS centroid of each stop
 *   - route_segment_time  EWMA travel time between consecutive stops
 * After each finished trip, finalizeTripCalibration() refreshes the
 * route_leg_calibration gate; a leg graduates (is_calibrated = true) after
 * CLEAN_TRIPS_TO_CALIBRATE clean trips once every stop is located and every
 * segment timed. Phase B uses that flag to switch on server-side geofencing.
 *
 * Invariants:
 *   - Geo samples come only from MANUAL marks (driver physically at the stop);
 *     device-geofence marks would bias the centroid ~150m early.
 *   - Mocked or low-accuracy (>50m) fixes never enter calibration.
 *   - All writes are single-statement upserts → safe to fire-and-forget from
 *     the request path and idempotent-ish under the one-driver-per-route
 *     concurrency this feature actually sees.
 */
import sql from '../db.js';
import logger from '../utils/logger.js';

export const CALIBRATION = {
  /** Reject GPS samples with worse accuracy than this (meters). */
  MAX_ACCURACY_M: 50,
  /** Weight fallback when the device reports no accuracy (meters). */
  DEFAULT_ACCURACY_M: 30,
  /** Accuracy floor so one hyper-precise fix can't dominate forever (meters). */
  MIN_ACCURACY_M: 5,
  /**
   * Clamp on accumulated centroid weight (≈ 20 samples at 10m accuracy).
   * Keeps the centroid adaptive if a stop physically moves.
   */
  MAX_WEIGHT: 0.2,
  /** EWMA smoothing factor for segment times. */
  EWMA_ALPHA: 0.3,
  /** Segment-time sanity bounds (seconds). */
  MIN_SEGMENT_SECONDS: 5,
  MAX_SEGMENT_SECONDS: 3 * 3600,
  /** Clean trips required before a leg graduates to auto (geofence) mode. */
  CLEAN_TRIPS_TO_CALIBRATE: 4,
};

/** Fold trip_direction into a learning leg: afternoon and evening share one. */
export const normalizeLeg = (tripDirection) =>
  tripDirection === 'evening' || tripDirection === 'afternoon' ? 'evening' : 'morning';

/** Inverse-variance weight for a GPS fix: precise fixes count for more. */
export const sampleWeight = (accuracyM) => {
  const acc = Math.max(
    Number(accuracyM) || CALIBRATION.DEFAULT_ACCURACY_M,
    CALIBRATION.MIN_ACCURACY_M,
  );
  return 1 / (acc * acc);
};

/**
 * Weighted running centroid (pure; mirrors the SQL upsert below — keep in sync).
 * prev = { latitude, longitude, weight }, sample = { latitude, longitude, weight }.
 */
export const weightedCentroid = (prev, sample) => {
  const total = prev.weight + sample.weight;
  return {
    latitude: (prev.latitude * prev.weight + sample.latitude * sample.weight) / total,
    longitude: (prev.longitude * prev.weight + sample.longitude * sample.weight) / total,
    weight: Math.min(total, CALIBRATION.MAX_WEIGHT),
  };
};

/**
 * EWMA + exponentially-weighted variance update (West's method; pure — mirrors
 * the SQL upsert below). prev = { ewma, ewvar } or null for the first sample.
 */
export const ewmaUpdate = (prev, x, alpha = CALIBRATION.EWMA_ALPHA) => {
  if (!prev) return { ewma: x, ewvar: 0 };
  const diff = x - prev.ewma;
  return {
    ewma: prev.ewma + alpha * diff,
    ewvar: (1 - alpha) * (prev.ewvar + alpha * diff * diff),
  };
};

/** True when a fix is usable for geo calibration. */
export const isUsableFix = ({ latitude, longitude, accuracy, isMocked }) =>
  latitude != null &&
  longitude != null &&
  !isMocked &&
  (accuracy == null || Number(accuracy) <= CALIBRATION.MAX_ACCURACY_M);

/**
 * Fold one manual arrival into the learning tables. Fire-and-forget from the
 * mark endpoints — never throws into the request path.
 *
 * @param {object} p
 * @param {number} p.schoolId
 * @param {string} p.tripId
 * @param {string} p.routeId
 * @param {string} p.tripDirection  raw trips.trip_direction (normalized here)
 * @param {string} p.stopId
 * @param {number} p.stopOrder      exec order within the trip (1-based)
 * @param {Date}   p.arrivalTime
 * @param {string} p.source         'manual' | 'geofence'
 * @param {number} [p.latitude] [p.longitude] [p.accuracy] [p.isMocked]
 */
export async function recordArrivalCalibration(p, db = sql) {
  try {
    const leg = normalizeLeg(p.tripDirection);

    // 1. Geo centroid — manual marks only (see invariants above).
    if (p.source === 'manual' && isUsableFix(p)) {
      const w = sampleWeight(p.accuracy);
      await db`
        INSERT INTO route_stop_geo
          (school_id, route_id, stop_id, trip_direction,
           latitude, longitude, sample_weight, sample_count, last_accuracy_m)
        VALUES
          (${p.schoolId}, ${p.routeId}, ${p.stopId}, ${leg},
           ${p.latitude}, ${p.longitude}, ${Math.min(w, CALIBRATION.MAX_WEIGHT)}, 1, ${p.accuracy ?? null})
        ON CONFLICT (school_id, stop_id, trip_direction) DO UPDATE SET
          latitude = (route_stop_geo.latitude * route_stop_geo.sample_weight
                      + ${p.latitude}::numeric * ${w}::numeric)
                     / (route_stop_geo.sample_weight + ${w}::numeric),
          longitude = (route_stop_geo.longitude * route_stop_geo.sample_weight
                       + ${p.longitude}::numeric * ${w}::numeric)
                      / (route_stop_geo.sample_weight + ${w}::numeric),
          sample_weight = LEAST(route_stop_geo.sample_weight + ${w}, ${CALIBRATION.MAX_WEIGHT}),
          sample_count = route_stop_geo.sample_count + 1,
          last_accuracy_m = ${p.accuracy ?? null},
          route_id = ${p.routeId},
          updated_at = now()
        WHERE route_stop_geo.locked = false
      `;
    }

    // 2. Segment time from the previous stop's departure (manual and
    //    device-geofence marks both count — EWMA absorbs the small skew).
    if (p.stopOrder > 1) {
      const [prev] = await db`
        SELECT stop_id, status, departure_time
        FROM trip_stop_status
        WHERE trip_id = ${p.tripId}
          AND school_id = ${p.schoolId}
          AND stop_order = ${p.stopOrder - 1}
      `;
      // A skipped previous stop would make this segment span two hops — reject.
      if (prev?.status === 'completed' && prev.departure_time) {
        const seconds =
          (new Date(p.arrivalTime).getTime() - new Date(prev.departure_time).getTime()) / 1000;
        if (seconds >= CALIBRATION.MIN_SEGMENT_SECONDS && seconds <= CALIBRATION.MAX_SEGMENT_SECONDS) {
          const a = CALIBRATION.EWMA_ALPHA;
          await db`
            INSERT INTO route_segment_time
              (school_id, route_id, trip_direction, from_stop_id, to_stop_id,
               ewma_seconds, ewvar_seconds, sample_count, last_seconds)
            VALUES
              (${p.schoolId}, ${p.routeId}, ${leg}, ${prev.stop_id}, ${p.stopId},
               ${seconds}, 0, 1, ${seconds})
            ON CONFLICT (school_id, route_id, trip_direction, from_stop_id, to_stop_id) DO UPDATE SET
              ewma_seconds = route_segment_time.ewma_seconds
                             + ${a} * (${seconds} - route_segment_time.ewma_seconds),
              ewvar_seconds = (1 - ${a}) * (route_segment_time.ewvar_seconds
                              + ${a} * power(${seconds} - route_segment_time.ewma_seconds, 2)),
              sample_count = route_segment_time.sample_count + 1,
              last_seconds = ${seconds},
              updated_at = now()
            WHERE route_segment_time.sample_count < 3
               OR (${seconds} <= route_segment_time.ewma_seconds * 4
                   AND ${seconds} >= route_segment_time.ewma_seconds / 4)
          `;
        }
      }
    }
  } catch (err) {
    logger.error({ err, event: 'transport_calibration_capture_failed', schoolId: p?.schoolId, tripId: p?.tripId, stopId: p?.stopId }, 'Transport calibration capture failed');
  }
}

/**
 * Refresh the route_leg_calibration gate after a trip ends/completes.
 * A "clean" trip = every stop reached (completed, none skipped). The leg
 * graduates once clean trips ≥ threshold AND every active stop has a learned
 * coordinate AND every consecutive segment has at least one timing sample.
 * Fire-and-forget; never throws into the request path.
 */
export async function finalizeTripCalibration(schoolId, tripId, db = sql) {
  try {
    const [trip] = await db`
      SELECT id, route_id, trip_direction FROM trips
      WHERE id = ${tripId} AND school_id = ${schoolId}
    `;
    if (!trip) return;
    const leg = normalizeLeg(trip.trip_direction);

    const [[stopAgg], [tripAgg], [geoAgg], [segAgg]] = await Promise.all([
      db`
        SELECT COUNT(*)::int AS total FROM transport_stops
        WHERE route_id = ${trip.route_id} AND school_id = ${schoolId} AND deleted_at IS NULL
      `,
      db`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
        FROM trip_stop_status
        WHERE trip_id = ${tripId} AND school_id = ${schoolId}
      `,
      db`
        SELECT COUNT(*)::int AS n FROM route_stop_geo g
        JOIN transport_stops ts ON ts.id = g.stop_id AND ts.deleted_at IS NULL
        WHERE g.route_id = ${trip.route_id} AND g.school_id = ${schoolId} AND g.trip_direction = ${leg}
      `,
      db`
        SELECT COUNT(*)::int AS n FROM route_segment_time
        WHERE route_id = ${trip.route_id} AND school_id = ${schoolId} AND trip_direction = ${leg}
      `,
    ]);

    const stopsTotal = stopAgg.total;
    const segmentsTotal = Math.max(stopsTotal - 1, 0);
    const isClean = tripAgg.total > 0 && tripAgg.completed === tripAgg.total;
    const cleanIncrement = isClean ? 1 : 0;

    const [calibration] = await db`
      INSERT INTO route_leg_calibration
        (school_id, route_id, trip_direction, is_calibrated,
         stops_total, stops_calibrated, segments_total, segments_learned, clean_trip_count)
      VALUES
        (${schoolId}, ${trip.route_id}, ${leg},
         ${cleanIncrement >= CALIBRATION.CLEAN_TRIPS_TO_CALIBRATE
           && stopsTotal > 0 && geoAgg.n >= stopsTotal && segAgg.n >= segmentsTotal},
         ${stopsTotal}, ${geoAgg.n}, ${segmentsTotal}, ${segAgg.n}, ${cleanIncrement})
      ON CONFLICT (school_id, route_id, trip_direction) DO UPDATE SET
        stops_total = ${stopsTotal},
        stops_calibrated = ${geoAgg.n},
        segments_total = ${segmentsTotal},
        segments_learned = ${segAgg.n},
        clean_trip_count = route_leg_calibration.clean_trip_count + ${cleanIncrement},
        is_calibrated = (route_leg_calibration.clean_trip_count + ${cleanIncrement})
                          >= ${CALIBRATION.CLEAN_TRIPS_TO_CALIBRATE}
                        AND ${stopsTotal} > 0
                        AND ${geoAgg.n} >= ${stopsTotal}
        AND ${segAgg.n} >= ${segmentsTotal},
        updated_at = now()
      RETURNING trip_direction, is_calibrated, stops_total, stops_calibrated,
                segments_total, segments_learned, clean_trip_count, updated_at
    `;
    if (calibration?.is_calibrated) {
      logger.info({ event: 'transport_calibration_graduated', schoolId, routeId: trip.route_id, leg, tripId }, 'Transport leg calibrated');
    }
    return calibration || null;
  } catch (err) {
    logger.error({ err, event: 'transport_calibration_finalize_failed', schoolId, tripId }, 'Transport calibration finalization failed');
    return null;
  }
}

/** Calibration status for the driver badge. Always returns a row shape. */
export async function getLegCalibrationStatus(schoolId, routeId, tripDirection, db = sql) {
  const leg = normalizeLeg(tripDirection);
  const [row] = await db`
    SELECT trip_direction, is_calibrated, stops_total, stops_calibrated,
           segments_total, segments_learned, clean_trip_count, updated_at
    FROM route_leg_calibration
    WHERE school_id = ${schoolId} AND route_id = ${routeId} AND trip_direction = ${leg}
  `;
  return {
    ...(row || {
      trip_direction: leg,
      is_calibrated: false,
      stops_total: 0,
      stops_calibrated: 0,
      segments_total: 0,
      segments_learned: 0,
      clean_trip_count: 0,
    }),
    required_clean_trip_count: CALIBRATION.CLEAN_TRIPS_TO_CALIBRATE,
  };
}
