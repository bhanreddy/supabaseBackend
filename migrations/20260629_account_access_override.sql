-- Standing "Always allow access" override for accounts-role users.
--
-- Per-accountant persistent flag, distinct from the existing one-time/expiring
-- temp_access_grants flow. When ON, the user bypasses the after-hours/weekend
-- gate entirely until an admin turns it OFF. Default OFF preserves existing
-- behavior. Additive-only; safe to run repeatedly.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS unrestricted_access BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS unrestricted_access_granted_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS unrestricted_access_granted_at TIMESTAMPTZ;

-- Partial index: the gate only ever reads this for the small set of users who
-- currently hold the override, so keep it cheap.
CREATE INDEX IF NOT EXISTS idx_users_unrestricted_access
  ON users (school_id)
  WHERE unrestricted_access = TRUE;
