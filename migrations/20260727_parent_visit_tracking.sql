-- Parent visit register.
-- Records every school visit made to discuss a student so admins can see an
-- auditable count and the previous follow-up context.

BEGIN;

CREATE TABLE IF NOT EXISTS public.parent_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE RESTRICT,
  parent_id UUID REFERENCES public.parents(id) ON DELETE SET NULL,
  parent_name VARCHAR(150) NOT NULL,
  relationship VARCHAR(50),
  purpose TEXT NOT NULL,
  notes TEXT,
  visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT chk_parent_visit_name_not_blank
    CHECK (length(btrim(parent_name)) > 0),
  CONSTRAINT chk_parent_visit_purpose_not_blank
    CHECK (length(btrim(purpose)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_parent_visits_school_date
  ON public.parent_visits (school_id, visited_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_parent_visits_student_date
  ON public.parent_visits (school_id, student_id, visited_at DESC)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_parent_visits_updated ON public.parent_visits;
CREATE TRIGGER trg_parent_visits_updated
BEFORE UPDATE ON public.parent_visits
FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

ALTER TABLE public.parent_visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS parent_visits_school_select ON public.parent_visits;
CREATE POLICY parent_visits_school_select
  ON public.parent_visits
  FOR SELECT
  TO authenticated
  USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR school_id = public.auth_school_id()
  );

DROP POLICY IF EXISTS parent_visits_school_admin_manage ON public.parent_visits;
CREATE POLICY parent_visits_school_admin_manage
  ON public.parent_visits
  FOR ALL
  TO authenticated
  USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND public.auth_has_role(ARRAY['admin'])
    )
  )
  WITH CHECK (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND public.auth_has_role(ARRAY['admin'])
    )
  );

COMMIT;
