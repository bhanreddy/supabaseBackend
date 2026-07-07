-- ============================================================
-- Per-school STUDENT feature flags
-- Only stores OVERRIDES. Absent (school, role, feature_key) row
-- => registry default_enabled. Never seed a row per school×feature.
-- ============================================================

CREATE TABLE IF NOT EXISTS school_feature_flags (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   INTEGER     NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL DEFAULT 'student',   -- future-proofing; only 'student' implemented
  feature_key TEXT        NOT NULL,
  enabled     BOOLEAN     NOT NULL,
  -- Auth user id (sub) of the founder/super-admin who set the override.
  -- No FK: actors live across founders / super_admins tables. Full trail in activity_logs.
  updated_by  UUID        NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, role, feature_key)
);

-- Fast lookups for resolveFeatures(schoolId) and requireFeature().
CREATE INDEX IF NOT EXISTS idx_school_feature_flags_lookup
  ON school_feature_flags (school_id, role);

-- Defense-in-depth: standard tenant isolation (server code also scopes by WHERE school_id).
ALTER TABLE school_feature_flags ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_tenant_rls_policy') THEN
    PERFORM create_tenant_rls_policy('school_feature_flags');
  END IF;
END $$;
