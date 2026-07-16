/** Nightly Phase E maintenance. Every mutating query is explicitly tenant-scoped. */
import sql from '../db.js';

export const RADIUS = Object.freeze({ SCALE: 0.4, MIN_METERS: 60, MAX_METERS: 200 });

/** Pure radius law: 40% of nearest-stop spacing, clamped to 60–200m. */
export function adaptiveStopRadiusMeters(nearestNeighborMeters) {
  if (nearestNeighborMeters == null) return RADIUS.MAX_METERS;
  const distance = Number(nearestNeighborMeters);
  if (!Number.isFinite(distance) || distance < 0) return RADIUS.MAX_METERS;
  return Math.min(RADIUS.MAX_METERS, Math.max(RADIUS.MIN_METERS, RADIUS.SCALE * distance));
}

export async function refreshAdaptiveStopRadii(schoolId, db = sql) {
  const rows = await db`
    WITH nearest AS (
      SELECT g.id,
             MIN(6371000 * ACOS(LEAST(1, GREATEST(-1,
               SIN(RADIANS(g.latitude::double precision)) * SIN(RADIANS(other.latitude::double precision)) +
               COS(RADIANS(g.latitude::double precision)) * COS(RADIANS(other.latitude::double precision)) *
               COS(RADIANS(other.longitude::double precision - g.longitude::double precision))
             )))) AS nearest_m
      FROM route_stop_geo g
      JOIN route_leg_calibration cal
        ON cal.school_id = ${schoolId}
       AND cal.route_id = g.route_id
       AND cal.trip_direction = g.trip_direction
       AND cal.is_calibrated = true
      JOIN route_stop_geo other
        ON other.school_id = ${schoolId}
       AND other.route_id = g.route_id
       AND other.trip_direction = g.trip_direction
       AND other.id <> g.id
      WHERE g.school_id = ${schoolId}
      GROUP BY g.id
    )
    UPDATE route_stop_geo g
    SET radius_m = LEAST(${RADIUS.MAX_METERS}, GREATEST(${RADIUS.MIN_METERS}, ${RADIUS.SCALE} * nearest.nearest_m)),
        updated_at = now()
    FROM nearest
    WHERE g.id = nearest.id AND g.school_id = ${schoolId} AND g.locked = false
    RETURNING g.id
  `;
  return rows.length;
}

export async function refreshLegCalibrationFlags(schoolId, db = sql) {
  const rows = await db`
    WITH coverage AS (
      SELECT cal.id,
             (SELECT COUNT(*)::int FROM transport_stops s
              WHERE s.school_id = ${schoolId} AND s.route_id = cal.route_id AND s.deleted_at IS NULL) AS stops_total,
             (SELECT COUNT(*)::int FROM route_stop_geo g
              WHERE g.school_id = ${schoolId} AND g.route_id = cal.route_id
                AND g.trip_direction = cal.trip_direction) AS stops_calibrated,
             GREATEST((SELECT COUNT(*)::int FROM transport_stops s
                       WHERE s.school_id = ${schoolId} AND s.route_id = cal.route_id
                         AND s.deleted_at IS NULL) - 1, 0) AS segments_total,
             (SELECT COUNT(*)::int FROM route_segment_time seg
              WHERE seg.school_id = ${schoolId} AND seg.route_id = cal.route_id
                AND seg.trip_direction = cal.trip_direction) AS segments_learned
      FROM route_leg_calibration cal
      WHERE cal.school_id = ${schoolId}
    )
    UPDATE route_leg_calibration cal
    SET stops_total = coverage.stops_total,
        stops_calibrated = coverage.stops_calibrated,
        segments_total = coverage.segments_total,
        segments_learned = coverage.segments_learned,
        -- A stop add/remove changes the execution graph.  Disarm the leg and
        -- require two fresh clean runs; stale segment timing must not silently
        -- keep auto-geofencing enabled.
        clean_trip_count = CASE
          WHEN cal.stops_total <> coverage.stops_total
            OR cal.segments_total <> coverage.segments_total
          THEN 0 ELSE cal.clean_trip_count END,
        is_calibrated = NOT (
            cal.stops_total <> coverage.stops_total
            OR cal.segments_total <> coverage.segments_total
          )
          AND cal.clean_trip_count >= 2
          AND coverage.stops_total > 0
          AND coverage.stops_calibrated >= coverage.stops_total
          AND coverage.segments_learned >= coverage.segments_total,
        updated_at = now()
    FROM coverage
    WHERE cal.id = coverage.id AND cal.school_id = ${schoolId}
    RETURNING cal.id
  `;
  return rows.length;
}

/** Close prior-local-day trips so a dead phone cannot leave a route live forever. */
export async function closeOvernightTrips(schoolId, db = sql) {
  const staleTrips = await db`
    SELECT id
    FROM trips
    WHERE school_id = ${schoolId}
      AND status IN ('active', 'in_progress')
      AND started_at < (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
    FOR UPDATE
  `;
  if (!staleTrips.length) return 0;
  const ids = staleTrips.map((row) => row.id);
  await db`
    UPDATE trip_stop_status
    SET status = CASE WHEN status = 'arrived' THEN 'completed' ELSE 'skipped' END,
        departure_time = COALESCE(departure_time, now())
    WHERE school_id = ${schoolId}
      AND trip_id = ANY(${db.array(ids)}::uuid[])
      AND status IN ('pending', 'arrived')
  `;
  await db`
    UPDATE trips
    SET status = 'completed', ended_at = COALESCE(ended_at, now())
    WHERE school_id = ${schoolId}
      AND id = ANY(${db.array(ids)}::uuid[])
      AND status IN ('active', 'in_progress')
  `;
  return ids.length;
}

export async function pruneBusTripHistory(schoolId, retentionDays, db = sql) {
  const days = Math.min(90, Math.max(30, Number(retentionDays) || 60));
  const rows = await db`
    DELETE FROM bus_trip_history
    WHERE school_id = ${schoolId}
      AND recorded_at < now() - (${days} * INTERVAL '1 day')
    RETURNING id
  `;
  return rows.length;
}

export async function runTransportMaintenanceForSchool(schoolId, retentionDays, db = sql) {
  const closedOvernightTrips = await closeOvernightTrips(schoolId, db);
  const calibrationRows = await refreshLegCalibrationFlags(schoolId, db);
  const radiusRows = await refreshAdaptiveStopRadii(schoolId, db);
  const prunedRows = await pruneBusTripHistory(schoolId, retentionDays, db);
  return { schoolId, closedOvernightTrips, calibrationRows, radiusRows, prunedRows };
}
