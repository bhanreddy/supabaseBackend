-- Complete hostel module: scoped allocation authority plus parent permission requests.

ALTER TABLE hostel_blocks
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE hostel_rooms
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS hostel_permission_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  request_type VARCHAR(40) NOT NULL,
  reason TEXT NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hostel_permission_request_type_check CHECK (
    request_type IN ('outing', 'overnight_leave', 'late_return', 'visitor', 'other')
  ),
  CONSTRAINT hostel_permission_request_status_check CHECK (
    status IN ('pending', 'approved')
  ),
  CONSTRAINT hostel_permission_request_dates_check CHECK (ends_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS idx_hostel_permission_requests_school_status
  ON hostel_permission_requests (school_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_hostel_permission_requests_student
  ON hostel_permission_requests (school_id, student_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uq_hostel_active_bed'
  ) AND NOT EXISTS (
    SELECT 1
    FROM hostel_allocations
    WHERE is_active = TRUE AND bed_no IS NOT NULL
    GROUP BY school_id, room_id, academic_year_id, bed_no
    HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX uq_hostel_active_bed
      ON hostel_allocations (school_id, room_id, academic_year_id, bed_no)
      WHERE is_active = TRUE AND bed_no IS NOT NULL;
  END IF;
END $$;

INSERT INTO permissions (school_id, code, name)
SELECT s.id, v.code, v.name
FROM schools s
CROSS JOIN (VALUES
  ('hostel.view', 'View Hostel'),
  ('hostel.manage', 'Manage Hostel Setup, Fees and Requests'),
  ('hostel.allocate', 'Assign and Vacate Hostel Students')
) AS v(code, name)
WHERE NOT EXISTS (
  SELECT 1 FROM permissions p WHERE p.school_id = s.id AND p.code = v.code
);

UPDATE permissions
SET deleted_at = NULL,
    name = CASE code
      WHEN 'hostel.manage' THEN 'Manage Hostel Setup, Fees and Requests'
      WHEN 'hostel.allocate' THEN 'Assign and Vacate Hostel Students'
      ELSE 'View Hostel'
    END
WHERE code IN ('hostel.view', 'hostel.manage', 'hostel.allocate');

-- Admin/principal retain complete authority.
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT r.school_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.school_id = r.school_id
WHERE r.code IN ('admin', 'principal')
  AND p.code IN ('hostel.view', 'hostel.manage', 'hostel.allocate')
ON CONFLICT (role_id, permission_id)
DO UPDATE SET school_id = EXCLUDED.school_id, deleted_at = NULL;

-- Keep the same authority split for schools created after this migration. This
-- trigger runs alphabetically after trg_school_seed_defaults has created roles.
CREATE OR REPLACE FUNCTION trg_seed_hostel_rbac_on_school_create()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO permissions (school_id, code, name)
  VALUES
    (NEW.id, 'hostel.view', 'View Hostel'),
    (NEW.id, 'hostel.manage', 'Manage Hostel Setup, Fees and Requests'),
    (NEW.id, 'hostel.allocate', 'Assign and Vacate Hostel Students')
  ON CONFLICT (school_id, code)
  DO UPDATE SET name = EXCLUDED.name, deleted_at = NULL;

  INSERT INTO role_permissions (school_id, role_id, permission_id)
  SELECT r.school_id, r.id, p.id
  FROM roles r
  JOIN permissions p ON p.school_id = r.school_id
  WHERE r.school_id = NEW.id
    AND (
      (r.code IN ('admin', 'principal') AND p.code IN ('hostel.view', 'hostel.manage', 'hostel.allocate'))
      OR (r.code = 'accounts' AND p.code IN ('hostel.view', 'hostel.allocate'))
    )
  ON CONFLICT (role_id, permission_id)
  DO UPDATE SET school_id = EXCLUDED.school_id, deleted_at = NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_trg_school_hostel_rbac ON schools;
CREATE TRIGGER zz_trg_school_hostel_rbac
AFTER INSERT ON schools
FOR EACH ROW EXECUTE FUNCTION trg_seed_hostel_rbac_on_school_create();

-- Accounts can see hostel setup and manage student membership, but cannot edit
-- blocks, rooms, fees, or parent requests.
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT r.school_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.school_id = r.school_id
WHERE r.code = 'accounts'
  AND p.code IN ('hostel.view', 'hostel.allocate')
ON CONFLICT (role_id, permission_id)
DO UPDATE SET school_id = EXCLUDED.school_id, deleted_at = NULL;

-- Enforce the requested separation of duties even if an older school manually
-- granted broad hostel management to Accounts.
DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.code = 'accounts'
  AND p.code = 'hostel.manage';

ALTER TABLE hostel_permission_requests ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE hostel_permission_requests TO authenticated;
GRANT ALL ON TABLE hostel_permission_requests TO service_role;

DROP POLICY IF EXISTS hostel_permission_requests_school_scope ON hostel_permission_requests;
CREATE POLICY hostel_permission_requests_school_scope
  ON hostel_permission_requests
  FOR ALL TO authenticated
  USING (school_id = auth_school_id())
  WITH CHECK (school_id = auth_school_id());
