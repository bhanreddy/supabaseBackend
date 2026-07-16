-- Phase E: retry-safe store-and-forward GPS history.
-- Existing production data was checked before this migration: there were no
-- duplicate (bus_id, recorded_at) groups, so no destructive cleanup is needed.

ALTER TABLE bus_trip_history
  ADD COLUMN IF NOT EXISTS heading DOUBLE PRECISION;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bus_trip_history_bus_recorded_at
  ON bus_trip_history (bus_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_bus_trip_history_school_recorded_at
  ON bus_trip_history (school_id, recorded_at);

