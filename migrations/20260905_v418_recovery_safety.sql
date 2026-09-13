-- Forward-only correction. Original Batch 1 tables already exist in deployments.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE public.automation_execution_logs ADD COLUMN IF NOT EXISTS student_id UUID REFERENCES public.students(id) ON DELETE RESTRICT;
-- Resolve existing records only through tenant-owned students, including fee entities.
UPDATE public.automation_execution_logs l SET student_id = s.id
FROM public.students s
WHERE l.student_id IS NULL AND l.school_id = s.school_id
  AND (l.payload->>'studentId' = s.id::text OR (l.entity_type = 'student' AND l.entity_id = s.id::text)
    OR EXISTS (SELECT 1 FROM public.student_fees sf WHERE sf.id::text = l.entity_id
      AND sf.student_id = s.id AND sf.school_id = l.school_id AND l.entity_type = 'student_fee'));
-- These are internal server tables. Portal JWTs must never read or mutate them,
-- even when a deployment installed the optional generic tenant policy helper.
DO $$ DECLARE t text; p record; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['school_automation_rules', 'automation_execution_logs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', t, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
      EXECUTE format('CREATE POLICY internal_service_only ON public.%I TO service_role USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
END $$;
COMMIT;
