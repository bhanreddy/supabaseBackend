-- ═══════════════════════════════════════════════════════════════════════════
-- Transport live tracking v2 — Phase A: calibration capture
-- (see TRANSPORT_LIVE_TRACKING_PLAN.md)
--
-- Pure data collection; no behavior change. Driver's manual stop marks start
-- feeding three learning tables:
--   route_stop_geo        — accuracy-weighted GPS centroid per (stop, leg)
--   route_segment_time    — EWMA + EW-variance travel time per stop pair
--   route_leg_calibration — graduation gate: a leg flips is_calibrated after
--                           2 clean trips with every stop located + timed
-- trip_direction is normalized to a leg: 'afternoon' folds into 'evening'
-- (matches REVERSE_TRIP_DIRECTIONS / inferTripLeg in existing code).
-- ═══════════════════════════════════════════════════════════════════════════

-- Learned geofence per (stop, leg). Centroid is accuracy-weighted (1/acc²),
-- clamped so it stays adaptive if a stop physically moves.
CREATE TABLE IF NOT EXISTS route_stop_geo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
    stop_id UUID NOT NULL REFERENCES transport_stops(id) ON DELETE CASCADE,
    trip_direction TEXT NOT NULL CHECK (trip_direction IN ('morning', 'evening')),
    latitude DECIMAL(10,8) NOT NULL,
    longitude DECIMAL(11,8) NOT NULL,
    sample_weight NUMERIC NOT NULL DEFAULT 0,   -- accumulated 1/accuracy² weight (clamped)
    sample_count INTEGER NOT NULL DEFAULT 0,
    radius_m NUMERIC NOT NULL DEFAULT 150,      -- adaptive per-stop radius (Phase B nightly job)
    last_accuracy_m NUMERIC,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (school_id, stop_id, trip_direction)
);

CREATE INDEX IF NOT EXISTS idx_route_stop_geo_route ON route_stop_geo(school_id, route_id, trip_direction);

-- Learned travel time between consecutive stops per (route, leg).
-- ewvar_seconds (EW variance) later drives the ETA confidence range.
CREATE TABLE IF NOT EXISTS route_segment_time (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
    trip_direction TEXT NOT NULL CHECK (trip_direction IN ('morning', 'evening')),
    from_stop_id UUID NOT NULL REFERENCES transport_stops(id) ON DELETE CASCADE,
    to_stop_id UUID NOT NULL REFERENCES transport_stops(id) ON DELETE CASCADE,
    ewma_seconds NUMERIC NOT NULL,
    ewvar_seconds NUMERIC NOT NULL DEFAULT 0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    last_seconds NUMERIC,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (school_id, route_id, trip_direction, from_stop_id, to_stop_id)
);

CREATE INDEX IF NOT EXISTS idx_route_segment_time_route ON route_segment_time(school_id, route_id, trip_direction);

-- Graduation gate per (route, leg): drives the driver "Calibrating route"
-- badge now, and gates server geofence auto-mode in Phase B.
CREATE TABLE IF NOT EXISTS route_leg_calibration (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
    trip_direction TEXT NOT NULL CHECK (trip_direction IN ('morning', 'evening')),
    is_calibrated BOOLEAN NOT NULL DEFAULT false,
    stops_total INTEGER NOT NULL DEFAULT 0,
    stops_calibrated INTEGER NOT NULL DEFAULT 0,
    segments_total INTEGER NOT NULL DEFAULT 0,
    segments_learned INTEGER NOT NULL DEFAULT 0,
    clean_trip_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (school_id, route_id, trip_direction)
);

-- Per-trip-stop provenance + geofence working state (Phase B uses the
-- debounce/dwell columns; persisted here so it survives stateless instances).
ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS arrival_source TEXT
    CHECK (arrival_source IN ('manual', 'geofence', 'timeout'));
ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS geofence_hits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS first_seen_in_radius TIMESTAMPTZ;

-- Dedup for the Phase D "running late" push.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS late_notified_at TIMESTAMPTZ;
