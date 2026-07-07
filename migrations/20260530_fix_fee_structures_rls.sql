-- Fix RLS for fee_structures and student_fees so admin/accounts API paths
-- and any direct Supabase reads are school-scoped consistently.
-- Backend Express routes use the service-role postgres connection (bypasses RLS).
-- These policies protect direct authenticated Supabase client access.

BEGIN;

-- fee_structures: tenant isolation (SELECT/INSERT/UPDATE for school staff)
ALTER TABLE public.fee_structures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_select_fee_structures ON public.fee_structures;
DROP POLICY IF EXISTS tenant_isolation_insert_fee_structures ON public.fee_structures;
DROP POLICY IF EXISTS tenant_isolation_update_fee_structures ON public.fee_structures;
DROP POLICY IF EXISTS fee_structures_school_select ON public.fee_structures;

CREATE POLICY fee_structures_school_select
  ON public.fee_structures
  FOR SELECT
  TO authenticated
  USING (
    deleted_at IS NULL
    AND school_id = public.current_school_id()
  );

CREATE POLICY fee_structures_school_insert
  ON public.fee_structures
  FOR INSERT
  TO authenticated
  WITH CHECK (school_id = public.current_school_id());

CREATE POLICY fee_structures_school_update
  ON public.fee_structures
  FOR UPDATE
  TO authenticated
  USING (school_id = public.current_school_id())
  WITH CHECK (school_id = public.current_school_id());

-- student_fees: ensure admin-style reads via school_id (student own-row policy remains)
DROP POLICY IF EXISTS student_fees_school_select ON public.student_fees;

CREATE POLICY student_fees_school_select
  ON public.student_fees
  FOR SELECT
  TO authenticated
  USING (
    deleted_at IS NULL
    AND school_id = public.current_school_id()
  );

COMMIT;
