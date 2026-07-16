-- ═══════════════════════════════════════════════════════════════════════════
-- bus_locations: enforce one live row per bus.
--
-- POST /transport/buses/:id/location upserts the current fix with
-- `ON CONFLICT (bus_id) DO UPDATE` (single realtime row; full track lives in
-- bus_trip_history). That clause requires a unique constraint on (bus_id),
-- which was never created — so every location write failed with
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" and live tracking never persisted a point.
--
-- bus_id is globally unique per bus (FK to buses.id, one school per bus), so a
-- plain UNIQUE (bus_id) is correct and matches the ON CONFLICT target exactly.
-- ═══════════════════════════════════════════════════════════════════════════

-- Collapse any accidental duplicates to the most recent fix before enforcing
-- uniqueness (no-op on an empty/clean table).
DELETE FROM bus_locations bl
USING bus_locations dup
WHERE bl.bus_id = dup.bus_id
  AND bl.recorded_at < dup.recorded_at;

DO $$ BEGIN
  ALTER TABLE bus_locations ADD CONSTRAINT bus_locations_bus_id_key UNIQUE (bus_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
