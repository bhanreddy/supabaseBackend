-- ============================================================
-- Driver Bus Stop Attendance Table & Security
-- ============================================================

CREATE TABLE IF NOT EXISTS bus_stop_attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  stop_id UUID NOT NULL REFERENCES transport_stops(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'absent'
    CHECK (status IN ('present', 'absent')),
  marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Prevent duplicate attendance for the same student on the same trip/stop/date
  UNIQUE (school_id, trip_id, stop_id, student_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS idx_bus_stop_att_school ON bus_stop_attendance(school_id);
CREATE INDEX IF NOT EXISTS idx_bus_stop_att_trip ON bus_stop_attendance(trip_id);
CREATE INDEX IF NOT EXISTS idx_bus_stop_att_stop ON bus_stop_attendance(stop_id);
CREATE INDEX IF NOT EXISTS idx_bus_stop_att_student ON bus_stop_attendance(student_id);
CREATE INDEX IF NOT EXISTS idx_bus_stop_att_date ON bus_stop_attendance(attendance_date);

-- Enable RLS
ALTER TABLE bus_stop_attendance ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE bus_stop_attendance TO authenticated;
GRANT ALL ON TABLE bus_stop_attendance TO service_role;

DROP POLICY IF EXISTS "Authenticated users can read bus attendance" ON bus_stop_attendance;
CREATE POLICY "Authenticated users can read bus attendance" ON bus_stop_attendance FOR SELECT
  TO authenticated USING (bus_stop_attendance.school_id = auth_school_id());

DROP POLICY IF EXISTS "Drivers/Admins can manage bus attendance" ON bus_stop_attendance;
CREATE POLICY "Drivers/Admins can manage bus attendance" ON bus_stop_attendance FOR ALL
  TO authenticated USING (
    bus_stop_attendance.school_id = auth_school_id() AND
    EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = auth.uid() AND r.code IN ('admin', 'driver')
    )
  );

-- Trigger for auto updated_at
DROP TRIGGER IF EXISTS trg_bus_stop_attendance_updated ON bus_stop_attendance;
CREATE OR REPLACE TRIGGER trg_bus_stop_attendance_updated
BEFORE UPDATE ON bus_stop_attendance
FOR EACH ROW EXECUTE FUNCTION update_timestamp();
