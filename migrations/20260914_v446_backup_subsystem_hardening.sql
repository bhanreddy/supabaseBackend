-- ====================================================================
-- Migration: 20260914_v446_backup_subsystem_hardening.sql
-- Description: Lock down backup metadata tables if v445 was applied with
--              open RLS policies / GRANT ALL to anon and authenticated.
-- ====================================================================

ALTER TABLE IF EXISTS public.backup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.backup_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.backup_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all on backup_jobs" ON public.backup_jobs;
DROP POLICY IF EXISTS "Allow all on backup_events" ON public.backup_events;
DROP POLICY IF EXISTS "Allow all on backup_settings" ON public.backup_settings;

REVOKE ALL ON TABLE public.backup_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.backup_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.backup_settings FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.backup_jobs TO service_role;
GRANT ALL ON TABLE public.backup_events TO service_role;
GRANT ALL ON TABLE public.backup_settings TO service_role;
