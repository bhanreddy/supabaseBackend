-- Default to standard competition ranking: tied students share the rank and
-- the following rank skips the occupied positions (1, 1, 1, 4).
INSERT INTO school_settings (school_id, key, value, updated_at)
SELECT id, 'result_ranking_method', 'competition', NOW()
FROM schools
ON CONFLICT (school_id, key) DO NOTHING;

COMMENT ON TABLE school_settings IS
  'School-scoped key/value configuration, including the admin-controlled result_ranking_method.';
