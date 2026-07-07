ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS accounts_dashboard_config JSONB NOT NULL DEFAULT '{}'::jsonb;
