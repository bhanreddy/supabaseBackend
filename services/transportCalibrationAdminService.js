/**
 * Phase F calibration review/reset/admin override service.
 * Every query requires a JWT-derived schoolId and accepts an injectable db for
 * rollback-transaction tests. HTTP permission enforcement stays in the route.
 */
import sql from '../db.js';

export const CALIBRATION_LEGS = Object.freeze(['morning', 'evening']);

export function parseCalibrationLeg(value) {
  if (value === 'morning') return 'morning';
  if (value === 'evening' || value === 'afternoon') return 'evening';
  return null;
}

export async function getRouteCalibrationReview(schoolId, routeId, db = sql) {
  const [route] = await db`
    SELECT id, name, direction
    FROM transport_routes
    WHERE id = ${routeId} AND school_id = ${schoolId} AND deleted_at IS NULL
  `;
  if (!route) return null;

  const [stops, geos, statuses, segments] = await Promise.all([
    db`
      SELECT ts.id AS stop_id, ts.name, ts.stop_order
      FROM transport_stops ts
      WHERE ts.route_id = ${routeId}
        AND ts.school_id = ${schoolId}
        AND ts.deleted_at IS NULL
      ORDER BY ts.stop_order ASC
    `,
    db`
      SELECT stop_id, trip_direction, latitude, longitude, radius_m,
             sample_count, last_accuracy_m, locked, updated_at
      FROM route_stop_geo
      WHERE school_id = ${schoolId} AND route_id = ${routeId}
    `,
    db`
      SELECT trip_direction, is_calibrated, stops_total, stops_calibrated,
             segments_total, segments_learned, clean_trip_count, updated_at
      FROM route_leg_calibration
      WHERE school_id = ${schoolId} AND route_id = ${routeId}
    `,
    db`
      SELECT seg.trip_direction, seg.from_stop_id, from_stop.name AS from_stop_name,
             seg.to_stop_id, to_stop.name AS to_stop_name,
             seg.ewma_seconds, seg.ewvar_seconds, seg.sample_count,
             seg.last_seconds, seg.updated_at
      FROM route_segment_time seg
      JOIN transport_stops from_stop
        ON from_stop.id = seg.from_stop_id AND from_stop.school_id = ${schoolId}
      JOIN transport_stops to_stop
        ON to_stop.id = seg.to_stop_id AND to_stop.school_id = ${schoolId}
      WHERE seg.school_id = ${schoolId} AND seg.route_id = ${routeId}
      ORDER BY seg.trip_direction ASC, from_stop.stop_order ASC
    `,
  ]);

  const statusByLeg = new Map(statuses.map((row) => [row.trip_direction, row]));
  return {
    route,
    legs: CALIBRATION_LEGS.map((leg) => {
      const status = statusByLeg.get(leg);
      return {
        trip_direction: leg,
        is_calibrated: status?.is_calibrated ?? false,
        stops_total: status?.stops_total ?? stops.length,
        stops_calibrated: status?.stops_calibrated ?? 0,
        segments_total: status?.segments_total ?? Math.max(stops.length - 1, 0),
        segments_learned: status?.segments_learned ?? 0,
        clean_trip_count: status?.clean_trip_count ?? 0,
        updated_at: status?.updated_at ?? null,
        stops: stops.map((row) => {
          const geo = geos.find((item) => item.stop_id === row.stop_id && item.trip_direction === leg);
          return {
            stop_id: row.stop_id,
            name: row.name,
            stop_order: row.stop_order,
            latitude: geo?.latitude ?? null,
            longitude: geo?.longitude ?? null,
            radius_m: geo?.radius_m ?? null,
            sample_count: geo?.sample_count ?? 0,
            last_accuracy_m: geo?.last_accuracy_m ?? null,
            locked: geo?.locked ?? false,
            updated_at: geo?.updated_at ?? null,
          };
        }),
        segments: segments.filter((row) => row.trip_direction === leg),
      };
    }),
  };
}

export async function resetRouteCalibration(schoolId, routeId, leg, db = sql) {
  const [route] = await db`
    SELECT id FROM transport_routes
    WHERE id = ${routeId} AND school_id = ${schoolId} AND deleted_at IS NULL
  `;
  if (!route) return null;

  const deletedGeo = await db`
    DELETE FROM route_stop_geo
    WHERE school_id = ${schoolId} AND route_id = ${routeId} AND trip_direction = ${leg}
    RETURNING id
  `;
  const deletedSegments = await db`
    DELETE FROM route_segment_time
    WHERE school_id = ${schoolId} AND route_id = ${routeId} AND trip_direction = ${leg}
    RETURNING id
  `;
  const deletedCalibration = await db`
    DELETE FROM route_leg_calibration
    WHERE school_id = ${schoolId} AND route_id = ${routeId} AND trip_direction = ${leg}
    RETURNING id
  `;

  return {
    trip_direction: leg,
    deleted_geo: deletedGeo.length,
    deleted_segments: deletedSegments.length,
    deleted_calibration: deletedCalibration.length,
  };
}

export async function updateStopGeoOverride(
  schoolId,
  stopId,
  leg,
  { latitude, longitude, locked },
  db = sql,
) {
  const [row] = await db`
    UPDATE route_stop_geo g
    SET latitude = COALESCE(${latitude ?? null}, g.latitude),
        longitude = COALESCE(${longitude ?? null}, g.longitude),
        locked = COALESCE(${locked ?? null}, g.locked),
        last_accuracy_m = CASE
          WHEN ${latitude ?? null}::double precision IS NOT NULL
            OR ${longitude ?? null}::double precision IS NOT NULL
          THEN NULL ELSE g.last_accuracy_m
        END,
        updated_at = now()
    FROM transport_stops stop
    WHERE g.stop_id = ${stopId}
      AND g.trip_direction = ${leg}
      AND g.school_id = ${schoolId}
      AND stop.id = g.stop_id
      AND stop.school_id = ${schoolId}
      AND stop.deleted_at IS NULL
    RETURNING g.stop_id, g.route_id, g.trip_direction, g.latitude, g.longitude,
              g.radius_m, g.sample_count, g.last_accuracy_m, g.locked, g.updated_at
  `;
  return row || null;
}
