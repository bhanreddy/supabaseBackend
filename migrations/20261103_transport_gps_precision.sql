-- Serialized per-trip GPS filter state survives restarts and multiple API workers.
-- Raw history remains unchanged. No guessed coordinates or historical backfill.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS gps_filter_state jsonb;
COMMENT ON COLUMN trips.gps_filter_state IS 'Server-owned GPS quality state v1; updated only under the trip row lock';

-- Keep quality qualification separate from raw capture and upload acceptance.
ALTER TABLE bus_trip_history ADD COLUMN IF NOT EXISTS gps_quality text NOT NULL DEFAULT 'unassessed';
COMMENT ON COLUMN bus_trip_history.gps_quality IS 'Server quality outcome; only accepted observations can feed automatic safety decisions';
