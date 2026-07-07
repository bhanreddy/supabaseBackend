-- ============================================================================
-- Portal Switcher — Phase 0 foundation
-- One login identity with multiple switchable access contexts (profiles/portals).
-- Idempotent and safe to re-run.
-- ============================================================================

BEGIN;

-- Portal types the UI routes against
DO $$ BEGIN
  CREATE TYPE portal_type_enum AS ENUM (
    'student', 'staff', 'admin', 'accounts', 'driver', 'library', 'transport'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Switchable profile under one login identity
CREATE TABLE IF NOT EXISTS user_access_contexts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  school_id       INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  context_key     TEXT NOT NULL,
  portal_type     portal_type_enum NOT NULL,
  role_codes      TEXT[] NOT NULL DEFAULT '{}',
  student_id      UUID REFERENCES students(id),
  staff_id        UUID REFERENCES staff(id),
  parent_id       UUID REFERENCES parents(id),
  display_name    TEXT NOT NULL,
  subtitle        TEXT,
  photo_url       TEXT,
  sort_order      INT NOT NULL DEFAULT 0,
  source          TEXT NOT NULL DEFAULT 'direct_role',
  is_switchable   BOOLEAN NOT NULL DEFAULT true,
  valid_from      TIMESTAMPTZ,
  valid_to        TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CONSTRAINT uq_user_context_key UNIQUE (user_id, context_key)
);

CREATE INDEX IF NOT EXISTS idx_uac_user_active
  ON user_access_contexts(user_id)
  WHERE deleted_at IS NULL AND revoked_at IS NULL AND is_switchable = true;

CREATE INDEX IF NOT EXISTS idx_uac_school_id ON user_access_contexts(school_id);

DROP TRIGGER IF EXISTS trg_uac_updated ON user_access_contexts;
CREATE TRIGGER trg_uac_updated
  BEFORE UPDATE ON user_access_contexts
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Per-device active context (server source of truth for switches in Phase 2)
CREATE TABLE IF NOT EXISTS user_active_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id           TEXT NOT NULL,
  active_context_id   UUID REFERENCES user_access_contexts(id) ON DELETE SET NULL,
  session_fingerprint TEXT,
  last_switched_at    TIMESTAMPTZ,
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address          TEXT,
  user_agent          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_device_session UNIQUE (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_uas_user_id ON user_active_sessions(user_id);

-- Immutable audit trail for context switches
CREATE TABLE IF NOT EXISTS context_switch_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id),
  device_id         TEXT,
  from_context_id   UUID REFERENCES user_access_contexts(id),
  to_context_id     UUID NOT NULL REFERENCES user_access_contexts(id),
  switch_reason     TEXT NOT NULL DEFAULT 'user_initiated',
  ip_address        TEXT,
  user_agent        TEXT,
  request_id        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  school_id         INTEGER REFERENCES schools(id)
);

CREATE INDEX IF NOT EXISTS idx_csl_user_date ON context_switch_logs(user_id, created_at DESC);

-- Parent role for guardian logins (distinct from legacy child `student` login)
INSERT INTO roles (school_id, code, name, is_system)
SELECT s.id, 'parent', 'Parent / Guardian', true
FROM schools s
WHERE NOT EXISTS (
  SELECT 1 FROM roles r WHERE r.school_id = s.id AND r.code = 'parent' AND r.deleted_at IS NULL
);

-- Parent portal permissions (same read-only surface as student role today)
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT r.school_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.school_id = r.school_id
WHERE r.code = 'parent'
  AND r.deleted_at IS NULL
  AND p.code IN (
    'academics.view', 'attendance.view', 'exams.view', 'results.view',
    'diary.view', 'timetable.view', 'notices.view', 'events.view', 'lms.view',
    'fees.view', 'complaints.view', 'complaints.create'
  )
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = r.school_id
  );

COMMIT;
