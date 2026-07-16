-- Transport live-tracking hardening. Forward-only; mirror the definitions in
-- schema.sql.  These indexes support the hot GPS/geofence/live tracker paths.

CREATE INDEX IF NOT EXISTS idx_bus_locations_school_bus_recorded
  ON bus_locations (school_id, bus_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_trip_stop_status_trip_school_order_status
  ON trip_stop_status (trip_id, school_id, stop_order, status);

CREATE INDEX IF NOT EXISTS idx_trips_school_bus_live
  ON trips (school_id, bus_id, created_at DESC)
  WHERE status IN ('active', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_route_stop_geo_school_route_leg_stop
  ON route_stop_geo (school_id, route_id, trip_direction, stop_id);

CREATE INDEX IF NOT EXISTS idx_route_segment_time_school_route_leg_endpoints
  ON route_segment_time (school_id, route_id, trip_direction, from_stop_id, to_stop_id);

-- Defend against concurrent starts even on installations created before the
-- status='in_progress' convention existed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trips_one_live_trip_per_bus
  ON trips (school_id, bus_id)
  WHERE status IN ('active', 'in_progress');
