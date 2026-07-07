-- Mirrors schema.sql section: TRANSPORT SERVICE — Phase 1 Schema (SchoolIMS v2)
-- Apply via scripts/publishTransportSchema.js or run in a migration runner.

BEGIN;

ALTER TABLE transport_routes DROP CONSTRAINT IF EXISTS transport_routes_direction_check;
ALTER TABLE transport_routes ADD CONSTRAINT transport_routes_direction_check
  CHECK (direction IS NULL OR direction IN ('morning', 'afternoon', 'evening', 'both'));

CREATE TABLE IF NOT EXISTS driver_route_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
    driver_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (school_id, route_id, driver_id)
);

CREATE INDEX IF NOT EXISTS idx_driver_route_assignments_driver
  ON driver_route_assignments (driver_id, school_id)
  WHERE deleted_at IS NULL AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_driver_route_assignments_route
  ON driver_route_assignments (route_id, school_id)
  WHERE deleted_at IS NULL AND is_active = TRUE;

DROP TRIGGER IF EXISTS trg_driver_route_assignments_updated ON driver_route_assignments;
CREATE TRIGGER trg_driver_route_assignments_updated
  BEFORE UPDATE ON driver_route_assignments
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

ALTER TABLE trips ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE trips ADD COLUMN IF NOT EXISTS trip_date DATE;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS trip_direction VARCHAR(20);

UPDATE trips SET trip_date = (started_at AT TIME ZONE 'UTC')::date WHERE trip_date IS NULL;

ALTER TABLE trips ALTER COLUMN started_at DROP NOT NULL;
ALTER TABLE trips ALTER COLUMN started_at DROP DEFAULT;

ALTER TABLE trips DROP CONSTRAINT IF EXISTS trips_status_check;

ALTER TABLE trips ADD CONSTRAINT trips_status_check
  CHECK (status IN ('scheduled', 'active', 'in_progress', 'completed', 'cancelled'));

DROP INDEX IF EXISTS idx_trips_active_bus;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_active_like_bus
  ON trips (bus_id)
  WHERE status IN ('active', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_trips_route_date ON trips (school_id, route_id, trip_date);
CREATE INDEX IF NOT EXISTS idx_trips_school_date_status ON trips (school_id, trip_date, status);

COMMIT;
