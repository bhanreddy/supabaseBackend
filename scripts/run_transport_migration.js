import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL);

async function run() {

  try {
    await sql.unsafe(`
      -- 1. BUSES: Add driver_id FK
      ALTER TABLE buses ADD COLUMN IF NOT EXISTS driver_id UUID REFERENCES staff(id);

      -- 2. ROUTES: Add direction + bus_id  
      ALTER TABLE transport_routes ADD COLUMN IF NOT EXISTS direction VARCHAR(20) DEFAULT 'morning';
      ALTER TABLE transport_routes ADD COLUMN IF NOT EXISTS bus_id UUID REFERENCES buses(id);

      -- 3. STUDENT_TRANSPORT: Add bus_id
      ALTER TABLE student_transport ADD COLUMN IF NOT EXISTS bus_id UUID REFERENCES buses(id);

      -- 4. TRIPS TABLE
      CREATE TABLE IF NOT EXISTS trips (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          bus_id UUID NOT NULL REFERENCES buses(id),
          route_id UUID NOT NULL REFERENCES transport_routes(id),
          driver_id UUID NOT NULL REFERENCES staff(id),
          status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
          started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          ended_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- 5. TRIP STOP STATUS TABLE
      CREATE TABLE IF NOT EXISTS trip_stop_status (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
          stop_id UUID NOT NULL REFERENCES transport_stops(id),
          stop_order INTEGER NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'arrived', 'completed', 'skipped')),
          arrival_time TIMESTAMPTZ,
          departure_time TIMESTAMPTZ,
          UNIQUE (trip_id, stop_id)
      );

      -- 6. INDEXES
      CREATE INDEX IF NOT EXISTS idx_buses_driver ON buses(driver_id);
      CREATE INDEX IF NOT EXISTS idx_routes_bus ON transport_routes(bus_id);
      CREATE INDEX IF NOT EXISTS idx_student_transport_bus ON student_transport(bus_id);
      CREATE INDEX IF NOT EXISTS idx_trips_driver ON trips(driver_id);
      CREATE INDEX IF NOT EXISTS idx_trips_route ON trips(route_id);
      CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
      CREATE INDEX IF NOT EXISTS idx_trip_stop_trip ON trip_stop_status(trip_id);
      CREATE INDEX IF NOT EXISTS idx_trip_stop_status ON trip_stop_status(status);
    `);

    // Partial unique index (separate because IF NOT EXISTS not supported for partial)
    await sql.unsafe(`
      CREATE UNIQUE INDEX idx_trips_active_bus ON trips(bus_id) WHERE status = 'active'
    `).catch((e) => {
      if (e.message.includes('already exists')) {} else
      throw e;
    });

    // 7. RLS
    await sql.unsafe(`
      ALTER TABLE trips ENABLE ROW LEVEL SECURITY;
      ALTER TABLE trip_stop_status ENABLE ROW LEVEL SECURITY;

      GRANT ALL ON TABLE trips TO authenticated;
      GRANT ALL ON TABLE trips TO service_role;
      GRANT ALL ON TABLE trip_stop_status TO authenticated;
      GRANT ALL ON TABLE trip_stop_status TO service_role;

      DROP POLICY IF EXISTS "Admins can manage trips" ON trips;
      CREATE POLICY "Admins can manage trips" ON trips FOR ALL USING (
        EXISTS (
          SELECT 1 FROM user_roles ur
          JOIN roles r ON ur.role_id = r.id
          WHERE ur.user_id = auth.uid() AND r.code IN ('admin', 'driver')
        )
      );

      DROP POLICY IF EXISTS "Drivers can view own trips" ON trips;
      CREATE POLICY "Drivers can view own trips" ON trips FOR SELECT USING (
        driver_id IN (
          SELECT s.id FROM staff s
          JOIN users u ON s.person_id = u.person_id
          WHERE u.id = auth.uid()
        )
      );

      DROP POLICY IF EXISTS "Authenticated can view trip stops" ON trip_stop_status;
      CREATE POLICY "Authenticated can view trip stops" ON trip_stop_status FOR SELECT
        TO authenticated USING (true);
    `);

  } catch (e) {

  }

  await sql.end();
  process.exit(0);
}

run();