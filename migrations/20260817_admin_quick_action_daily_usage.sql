-- School-wide daily usage totals for admin dashboard quick actions.
-- One atomic counter per school, local calendar day, and action route makes the
-- most-used ordering consistent for every admin without retaining click-level data.

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_quick_action_daily_usage (
  school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  action_key VARCHAR(160) NOT NULL,
  click_count INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (school_id, usage_date, action_key),
  CONSTRAINT admin_quick_action_key_not_blank CHECK (length(btrim(action_key)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_admin_quick_action_daily_usage_rank
  ON public.admin_quick_action_daily_usage (school_id, usage_date, click_count DESC);

ALTER TABLE public.admin_quick_action_daily_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_quick_action_usage_school_select
  ON public.admin_quick_action_daily_usage;
CREATE POLICY admin_quick_action_usage_school_select
  ON public.admin_quick_action_daily_usage
  FOR SELECT
  TO authenticated
  USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND public.auth_has_role(ARRAY['admin'])
    )
  );

DROP POLICY IF EXISTS admin_quick_action_usage_school_manage
  ON public.admin_quick_action_daily_usage;
CREATE POLICY admin_quick_action_usage_school_manage
  ON public.admin_quick_action_daily_usage
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
