-- Additive transport v2. Apply before backend/mobile rollout. Do not backfill
-- historical GPS with guessed trip identities. Existing trips remain manual
-- until their immutable geometry is snapshotted by the compatibility path.
ALTER TABLE transport_routes ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS route_revision integer NOT NULL DEFAULT 1;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS tracking_session_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE trips ADD COLUMN IF NOT EXISTS tracking_device_id text;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS last_automation_at timestamptz;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS calibration_finalized_at timestamptz;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS auto_stops_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS close_reason text;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS start_request_id text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_transport_start_request ON trips(school_id,driver_id,start_request_id)
  WHERE start_request_id IS NOT NULL;
ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS snapshot_name text;
ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS snapshot_latitude double precision;
ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS snapshot_longitude double precision;
ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS snapshot_radius_m double precision NOT NULL DEFAULT 100;
ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS coordinate_source text NOT NULL DEFAULT 'unavailable';
ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS geofence_last_at timestamptz;
ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS calibration_captured_at timestamptz;
ALTER TABLE bus_trip_history ADD COLUMN IF NOT EXISTS trip_id uuid REFERENCES trips(id);
ALTER TABLE bus_trip_history ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE bus_trip_history ADD COLUMN IF NOT EXISTS fix_id text;
ALTER TABLE bus_trip_history ADD COLUMN IF NOT EXISTS accuracy double precision;
ALTER TABLE bus_trip_history ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE bus_locations ADD COLUMN IF NOT EXISTS trip_id uuid REFERENCES trips(id);
ALTER TABLE bus_locations ADD COLUMN IF NOT EXISTS accuracy double precision;
ALTER TABLE bus_locations ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS uq_transport_fix_identity
  ON bus_trip_history(school_id, trip_id, fix_id) WHERE fix_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transport_history_trip ON bus_trip_history(school_id, trip_id, recorded_at);

CREATE TABLE IF NOT EXISTS transport_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id integer NOT NULL REFERENCES schools(id),
  event_key text NOT NULL,
  trip_id uuid REFERENCES trips(id),
  stop_id uuid,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','inbox_only','failed','expired')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 day',
  lease_id uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE(school_id,event_key)
);
CREATE INDEX IF NOT EXISTS idx_transport_outbox_pending ON transport_outbox(available_at)
  WHERE status IN ('pending','processing');
CREATE TABLE IF NOT EXISTS transport_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer NOT NULL REFERENCES schools(id),
  trip_id uuid REFERENCES trips(id), actor_id uuid, event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transport_trip_roster (
  school_id integer NOT NULL REFERENCES schools(id), trip_id uuid NOT NULL REFERENCES trips(id),
  stop_id uuid NOT NULL REFERENCES transport_stops(id), student_id uuid NOT NULL REFERENCES students(id),
  PRIMARY KEY(school_id,trip_id,student_id)
);
ALTER TABLE transport_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_trip_roster ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON transport_outbox, transport_audit_events, transport_trip_roster FROM PUBLIC, anon, authenticated;
GRANT ALL ON transport_outbox, transport_audit_events, transport_trip_roster TO service_role;

-- Count changes cannot identify a route graph. Revision changes immediately
-- disarm future trips; existing trips retain their snapshotted stops/geometry.
CREATE OR REPLACE FUNCTION transport_disarm_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    UPDATE route_leg_calibration SET is_calibrated=false, clean_trip_count=0, updated_at=now()
      WHERE school_id=NEW.school_id AND route_id=NEW.id;
    DELETE FROM route_segment_time WHERE school_id=NEW.school_id AND route_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION transport_route_direction_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.direction IS DISTINCT FROM OLD.direction THEN NEW.revision := OLD.revision + 1; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION transport_stop_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.stop_order, NEW.latitude, NEW.longitude, NEW.deleted_at, NEW.route_id)
    IS NOT DISTINCT FROM (OLD.stop_order, OLD.latitude, OLD.longitude, OLD.deleted_at, OLD.route_id) THEN
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE','UPDATE') THEN
    UPDATE transport_routes SET revision=revision+1 WHERE id=OLD.route_id AND school_id=OLD.school_id;
    IF TG_OP='DELETE' OR NEW.latitude IS DISTINCT FROM OLD.latitude OR NEW.longitude IS DISTINCT FROM OLD.longitude
       OR NEW.route_id IS DISTINCT FROM OLD.route_id THEN
      DELETE FROM route_stop_geo WHERE stop_id=OLD.id AND school_id=OLD.school_id AND locked=false;
    END IF;
  END IF;
  IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND NEW.route_id IS DISTINCT FROM OLD.route_id) THEN
    UPDATE transport_routes SET revision=revision+1 WHERE id=NEW.route_id AND school_id=NEW.school_id;
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
DROP TRIGGER IF EXISTS transport_revision_disarm ON transport_routes;
CREATE TRIGGER transport_revision_disarm AFTER UPDATE OF revision ON transport_routes
  FOR EACH ROW EXECUTE FUNCTION transport_disarm_revision();
DROP TRIGGER IF EXISTS transport_direction_revision ON transport_routes;
CREATE TRIGGER transport_direction_revision BEFORE UPDATE OF direction ON transport_routes
  FOR EACH ROW EXECUTE FUNCTION transport_route_direction_revision();
DROP TRIGGER IF EXISTS transport_stop_revision ON transport_stops;
CREATE TRIGGER transport_stop_revision AFTER INSERT OR UPDATE OR DELETE ON transport_stops
  FOR EACH ROW EXECUTE FUNCTION transport_stop_revision();

-- Existing trips retain their original stop order. Older live rows deliberately
-- remain unbound until a fresh fix from a claimed session is received.
UPDATE trip_stop_status ss SET snapshot_name=s.name,
  snapshot_latitude=CASE WHEN g.locked THEN g.latitude WHEN s.latitude IS NOT NULL AND s.longitude IS NOT NULL THEN s.latitude ELSE g.latitude END,
  snapshot_longitude=CASE WHEN g.locked THEN g.longitude WHEN s.latitude IS NOT NULL AND s.longitude IS NOT NULL THEN s.longitude ELSE g.longitude END,
  snapshot_radius_m=COALESCE(g.radius_m,100),
  coordinate_source=CASE WHEN g.locked THEN 'override' WHEN s.latitude IS NOT NULL AND s.longitude IS NOT NULL THEN 'surveyed' WHEN g.latitude IS NOT NULL THEN 'learned' ELSE 'unavailable' END
FROM trips t JOIN transport_stops s ON s.school_id=t.school_id
LEFT JOIN route_stop_geo g ON g.school_id=s.school_id AND g.stop_id=s.id AND g.route_id=s.route_id
  AND g.trip_direction=CASE WHEN t.trip_direction IN ('evening','afternoon') THEN 'evening' ELSE 'morning' END
WHERE ss.trip_id=t.id AND ss.school_id=t.school_id AND ss.stop_id=s.id AND ss.snapshot_name IS NULL;
INSERT INTO transport_trip_roster(school_id,trip_id,stop_id,student_id)
SELECT st.school_id,t.id,st.stop_id,st.student_id FROM trips t
JOIN student_transport st ON st.school_id=t.school_id AND st.route_id=t.route_id AND st.is_active=true
JOIN academic_years ay ON ay.school_id=st.school_id AND ay.id=st.academic_year_id
JOIN trip_stop_status ss ON ss.school_id=t.school_id AND ss.trip_id=t.id AND ss.stop_id=st.stop_id
WHERE t.status IN ('active','in_progress') AND t.trip_date BETWEEN ay.start_date AND ay.end_date
ON CONFLICT DO NOTHING;

-- Refuse conflicting existing live trips instead of choosing a winner silently.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transport_live_driver ON trips(school_id,driver_id) WHERE status IN ('active','in_progress');
CREATE UNIQUE INDEX IF NOT EXISTS uq_transport_live_bus ON trips(school_id,bus_id) WHERE status IN ('active','in_progress');
