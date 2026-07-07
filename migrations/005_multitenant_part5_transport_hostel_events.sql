-- ============================================================
-- MULTI-TENANT MIGRATION — PART 5: TRANSPORT, HOSTEL, EVENTS, LMS, PAYROLL
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════
-- TABLE: transport_routes
-- ════════════════════════════════════════════
ALTER TABLE transport_routes ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE transport_routes SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE transport_routes ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE transport_routes ADD CONSTRAINT fk_transport_routes_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_transport_routes_school_id ON transport_routes(school_id);

-- ════════════════════════════════════════════
-- TABLE: transport_stops
-- ════════════════════════════════════════════
ALTER TABLE transport_stops ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE transport_stops SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE transport_stops ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE transport_stops ADD CONSTRAINT fk_transport_stops_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_transport_stops_school_id ON transport_stops(school_id);

-- ════════════════════════════════════════════
-- TABLE: buses
-- Unique: bus_no UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE buses ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE buses SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE buses ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE buses ADD CONSTRAINT fk_buses_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_buses_school_id ON buses(school_id);
ALTER TABLE buses DROP CONSTRAINT IF EXISTS buses_bus_no_key;
ALTER TABLE buses ADD CONSTRAINT unique_buses_bus_no_per_school UNIQUE (school_id, bus_no);

-- ════════════════════════════════════════════
-- TABLE: bus_locations
-- ════════════════════════════════════════════
ALTER TABLE bus_locations ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE bus_locations SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE bus_locations ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE bus_locations ADD CONSTRAINT fk_bus_locations_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_bus_locations_school_id ON bus_locations(school_id);

-- ════════════════════════════════════════════
-- TABLE: trips
-- ════════════════════════════════════════════
ALTER TABLE trips ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE trips SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE trips ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE trips ADD CONSTRAINT fk_trips_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_trips_school_id ON trips(school_id);

-- ════════════════════════════════════════════
-- TABLE: trip_stops
-- ════════════════════════════════════════════
ALTER TABLE trip_stops ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE trip_stops SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE trip_stops ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE trip_stops ADD CONSTRAINT fk_trip_stops_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_trip_stops_school_id ON trip_stops(school_id);

-- ════════════════════════════════════════════
-- TABLE: trip_stop_status
-- ════════════════════════════════════════════
ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE trip_stop_status SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE trip_stop_status ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE trip_stop_status ADD CONSTRAINT fk_trip_stop_status_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_trip_stop_status_school_id ON trip_stop_status(school_id);

-- ════════════════════════════════════════════
-- TABLE: bus_trip_history
-- ════════════════════════════════════════════
ALTER TABLE bus_trip_history ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE bus_trip_history SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE bus_trip_history ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE bus_trip_history ADD CONSTRAINT fk_bus_trip_history_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_bus_trip_history_school_id ON bus_trip_history(school_id);

-- ════════════════════════════════════════════
-- TABLE: driver_devices
-- ════════════════════════════════════════════
ALTER TABLE driver_devices ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE driver_devices SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE driver_devices ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE driver_devices ADD CONSTRAINT fk_driver_devices_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_driver_devices_school_id ON driver_devices(school_id);

-- ════════════════════════════════════════════
-- TABLE: driver_heartbeat
-- ════════════════════════════════════════════
ALTER TABLE driver_heartbeat ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE driver_heartbeat SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE driver_heartbeat ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE driver_heartbeat ADD CONSTRAINT fk_driver_heartbeat_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_driver_heartbeat_school_id ON driver_heartbeat(school_id);

-- ════════════════════════════════════════════
-- TABLE: hostel_rooms
-- Unique: room_no UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE hostel_rooms ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE hostel_rooms SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE hostel_rooms ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE hostel_rooms ADD CONSTRAINT fk_hostel_rooms_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_hostel_rooms_school_id ON hostel_rooms(school_id);
ALTER TABLE hostel_rooms DROP CONSTRAINT IF EXISTS hostel_rooms_room_no_key;
ALTER TABLE hostel_rooms ADD CONSTRAINT unique_hostel_rooms_room_no_per_school UNIQUE (school_id, room_no);

-- ════════════════════════════════════════════
-- TABLE: hostel_allocations
-- Unique: (student_id, academic_year_id) UNIQUE → scope to school
-- ════════════════════════════════════════════
ALTER TABLE hostel_allocations ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE hostel_allocations SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE hostel_allocations ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE hostel_allocations ADD CONSTRAINT fk_hostel_allocations_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_hostel_allocations_school_id ON hostel_allocations(school_id);
ALTER TABLE hostel_allocations DROP CONSTRAINT IF EXISTS hostel_allocations_student_id_academic_year_id_key;
ALTER TABLE hostel_allocations ADD CONSTRAINT unique_hostel_allocations_per_school UNIQUE (school_id, student_id, academic_year_id);

-- ════════════════════════════════════════════
-- TABLE: events
-- Already has school_id (nullable). Backfill + NOT NULL.
-- ════════════════════════════════════════════
ALTER TABLE events ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE events SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE events ALTER COLUMN school_id SET NOT NULL;
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_school_id_fkey;
DO $$ BEGIN ALTER TABLE events ADD CONSTRAINT fk_events_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_events_school_id ON events(school_id);

-- ════════════════════════════════════════════
-- TABLE: notices
-- Already has school_id (nullable). Backfill + NOT NULL.
-- ════════════════════════════════════════════
ALTER TABLE notices ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE notices SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE notices ALTER COLUMN school_id SET NOT NULL;
ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_school_id_fkey;
DO $$ BEGIN ALTER TABLE notices ADD CONSTRAINT fk_notices_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_notices_school_id ON notices(school_id);

-- ════════════════════════════════════════════
-- TABLE: diary_entries
-- ════════════════════════════════════════════
ALTER TABLE diary_entries ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE diary_entries SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE diary_entries ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE diary_entries ADD CONSTRAINT fk_diary_entries_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_diary_entries_school_id ON diary_entries(school_id);

-- ════════════════════════════════════════════
-- TABLE: complaints
-- Already has school_id (nullable). Backfill + NOT NULL.
-- ════════════════════════════════════════════
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE complaints SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE complaints ALTER COLUMN school_id SET NOT NULL;
ALTER TABLE complaints DROP CONSTRAINT IF EXISTS complaints_school_id_fkey;
DO $$ BEGIN ALTER TABLE complaints ADD CONSTRAINT fk_complaints_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_complaints_school_id ON complaints(school_id);

-- ════════════════════════════════════════════
-- TABLE: leave_applications
-- ════════════════════════════════════════════
ALTER TABLE leave_applications ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE leave_applications SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE leave_applications ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE leave_applications ADD CONSTRAINT fk_leave_applications_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_leave_applications_school_id ON leave_applications(school_id);

-- ════════════════════════════════════════════
-- TABLE: staff_payroll
-- ════════════════════════════════════════════
ALTER TABLE staff_payroll ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE staff_payroll SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE staff_payroll ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE staff_payroll ADD CONSTRAINT fk_staff_payroll_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_staff_payroll_school_id ON staff_payroll(school_id);

-- ════════════════════════════════════════════
-- TABLE: discipline_records
-- ════════════════════════════════════════════
ALTER TABLE discipline_records ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE discipline_records SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE discipline_records ALTER COLUMN school_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE discipline_records ADD CONSTRAINT fk_discipline_records_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_discipline_records_school_id ON discipline_records(school_id);

-- ════════════════════════════════════════════
-- TABLE: expenses
-- Already has school_id (nullable). Backfill + NOT NULL.
-- ════════════════════════════════════════════
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS school_id INTEGER;
UPDATE expenses SET school_id = 1 WHERE school_id IS NULL;
ALTER TABLE expenses ALTER COLUMN school_id SET NOT NULL;
ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_school_id_fkey;
DO $$ BEGIN ALTER TABLE expenses ADD CONSTRAINT fk_expenses_school FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_expenses_school_id ON expenses(school_id);

COMMIT;
