-- ============================================================
-- MIGRATION: 20260910_v418_audit_and_historical_integrity.sql
-- Fixes audit log tenant attribution, performs deterministic historical backfill,
-- and creates indexes for performant historical multi-year querying.
-- ============================================================

BEGIN;

-- 1. Ensure school_id column exists on audit_logs
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'audit_logs' 
          AND column_name = 'school_id'
    ) THEN
        ALTER TABLE public.audit_logs ADD COLUMN school_id INTEGER REFERENCES public.schools(id) ON DELETE CASCADE;
    END IF;
END $$;

-- 2. Deterministic historical backfill:
-- For any existing audit log rows with NULL school_id where user_id belongs to a known school,
-- backfill school_id from users table. Preserves unresolved rows without deletion.
UPDATE public.audit_logs al
SET school_id = u.school_id
FROM public.users u
WHERE al.school_id IS NULL
  AND al.user_id = u.id
  AND u.school_id IS NOT NULL;

-- 3. Historical query performance indexes
CREATE INDEX IF NOT EXISTS idx_audit_logs_school_created
    ON public.audit_logs(school_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_daily_attendance_school_date
    ON public.daily_attendance(school_id, attendance_date);

CREATE INDEX IF NOT EXISTS idx_fee_transactions_school_paid
    ON public.fee_transactions(school_id, paid_at);

CREATE INDEX IF NOT EXISTS idx_students_school_academic_year
    ON public.students(school_id, academic_year_id);

-- 4. Enable tenant RLS on audit_logs if not already enabled
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    DROP POLICY IF EXISTS tenant_isolation_select_audit_logs ON public.audit_logs;
    CREATE POLICY tenant_isolation_select_audit_logs ON public.audit_logs
        FOR SELECT USING (school_id = current_school_id());

    DROP POLICY IF EXISTS tenant_isolation_insert_audit_logs ON public.audit_logs;
    CREATE POLICY tenant_isolation_insert_audit_logs ON public.audit_logs
        FOR INSERT WITH CHECK (school_id = current_school_id());
END $$;

COMMIT;
