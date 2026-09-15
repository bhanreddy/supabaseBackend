-- ====================================================================
-- Migration: 20260914_v445_database_backup_subsystem.sql
-- Description: Production-grade database backup & disaster recovery metadata
-- ====================================================================

-- 1. backup_jobs table
CREATE TABLE IF NOT EXISTS public.backup_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    backup_id text NOT NULL UNIQUE,
    backup_type text NOT NULL CHECK (backup_type IN ('daily', 'weekly', 'monthly', 'manual')),
    status text NOT NULL CHECK (status IN ('pending', 'in_progress', 'success', 'failed')) DEFAULT 'pending',
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    duration_seconds integer,
    file_size_bytes bigint,
    storage_path text,
    checksum_sha256 text,
    database_version text,
    verification_status text NOT NULL CHECK (verification_status IN ('unverified', 'verified', 'failed')) DEFAULT 'unverified',
    verified_at timestamptz,
    error_message text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- 2. backup_events table (chronological fine-grained stage tracking)
CREATE TABLE IF NOT EXISTS public.backup_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    backup_job_id uuid REFERENCES public.backup_jobs(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    message text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- 3. backup_settings table (non-sensitive runtime configuration)
CREATE TABLE IF NOT EXISTS public.backup_settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    description text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes for performant filtering & history queries
CREATE INDEX IF NOT EXISTS idx_backup_jobs_created_at ON public.backup_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_jobs_status ON public.backup_jobs (status);
CREATE INDEX IF NOT EXISTS idx_backup_jobs_backup_type ON public.backup_jobs (backup_type);
CREATE INDEX IF NOT EXISTS idx_backup_events_job_id ON public.backup_events (backup_job_id, created_at ASC);

-- Default Settings Seeding (Idempotent)
INSERT INTO public.backup_settings (key, value, description)
VALUES 
    ('schedule', '{"cron": "0 2 * * *", "timezone": "Asia/Kolkata", "enabled": true}'::jsonb, 'Cloud Scheduler backup schedule'),
    ('retention', '{"daily_days": 30, "weekly_weeks": 12, "monthly_months": 12}'::jsonb, 'GCS lifecycle retention policy targets'),
    ('anomaly_detection', '{"threshold_percentage": 25, "enabled": true}'::jsonb, 'Backup size deviation alert threshold'),
    ('verification', '{"auto_verify": true, "mode": "checksum_and_size"}'::jsonb, 'Automated post-upload verification policy')
ON CONFLICT (key) DO NOTHING;

-- RLS Configuration
-- Enabled with no client policies: PostgREST anon/authenticated cannot read backup metadata.
-- Table owners and the backup worker's direct Postgres role bypass RLS (FORCE is not set).
-- Founder Console uses the SuperAdmin direct Postgres connection, not the anon key.
ALTER TABLE public.backup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all on backup_jobs" ON public.backup_jobs;
DROP POLICY IF EXISTS "Allow all on backup_events" ON public.backup_events;
DROP POLICY IF EXISTS "Allow all on backup_settings" ON public.backup_settings;

REVOKE ALL ON TABLE public.backup_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.backup_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.backup_settings FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.backup_jobs TO service_role;
GRANT ALL ON TABLE public.backup_events TO service_role;
GRANT ALL ON TABLE public.backup_settings TO service_role;
