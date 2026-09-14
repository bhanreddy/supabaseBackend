-- Migration: 20260914_v439_content_engine_hardening.sql
-- Additive hardening for the SchoolIMS Content Engine.
-- Does not drop existing content. Safe to run after 20260914_v438_content_engine.sql.

BEGIN;

-- 1. Thought slot occupancy (one live thought per school per calendar day)
ALTER TABLE public.content_thoughts
    ADD COLUMN IF NOT EXISTS occupies_slot BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_content_thoughts_active_slot
    ON public.content_thoughts (school_id, slot_date)
    WHERE occupies_slot IS TRUE;

-- 2. Idempotent likes (one LIKE per user per item)
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_analytics_like
    ON public.content_analytics (school_id, content_id, user_id)
    WHERE event_type = 'LIKE' AND user_id IS NOT NULL;

-- 3. Global + tenant news source uniqueness
-- Drop duplicate global (school_id IS NULL) seed rows only. Tenant rows are left untouched.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY lower(name)
               ORDER BY created_at ASC NULLS LAST, id ASC
           ) AS rn
    FROM public.news_sources
    WHERE school_id IS NULL
)
DELETE FROM public.news_sources
WHERE school_id IS NULL
  AND id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS uq_news_sources_tenant_name
    ON public.news_sources ((COALESCE(school_id, 0)), lower(name));

-- 4. Expiry lookup for feed queries
CREATE INDEX IF NOT EXISTS idx_content_items_expires
    ON public.content_items (school_id, status, expires_at)
    WHERE deleted_at IS NULL AND expires_at IS NOT NULL;

-- 5. Recurring publication schedules (Daily / weekdays / school days)
CREATE TABLE IF NOT EXISTS public.content_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    content_id UUID NOT NULL REFERENCES public.content_items(id) ON DELETE CASCADE,
    recurrence_type VARCHAR(32) NOT NULL DEFAULT 'ONCE',
    weekdays SMALLINT[] NOT NULL DEFAULT ARRAY[]::SMALLINT[],
    time_of_day TIME NOT NULL DEFAULT '08:00',
    timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
    next_run_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    override_duplicate BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_content_schedule_recurrence CHECK (
        recurrence_type IN ('ONCE', 'DAILY', 'WEEKDAYS', 'CUSTOM_WEEKDAYS', 'SCHOOL_DAYS')
    ),
    CONSTRAINT uq_content_schedule_item UNIQUE (content_id)
);

CREATE INDEX IF NOT EXISTS idx_content_schedules_due
    ON public.content_schedules (is_active, next_run_at)
    WHERE is_active IS TRUE;

CREATE INDEX IF NOT EXISTS idx_content_schedules_content
    ON public.content_schedules (school_id, content_id);

DROP TRIGGER IF EXISTS trg_content_schedules_updated ON public.content_schedules;
CREATE TRIGGER trg_content_schedules_updated
BEFORE UPDATE ON public.content_schedules
FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

-- 6. RLS on child tables (defense in depth; API uses service role)
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'content_items',
    'content_thoughts',
    'content_news',
    'content_targets',
    'content_media',
    'content_versions',
    'content_audit_logs',
    'content_bookmarks',
    'content_analytics',
    'content_translations',
    'content_schedules'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_all ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_all ON public.%I
         FOR ALL TO authenticated
         USING (
           auth.role() = ''service_role''
           OR public.is_super_admin()
           OR school_id = public.auth_school_id()
         )
         WITH CHECK (
           auth.role() = ''service_role''
           OR public.is_super_admin()
           OR school_id = public.auth_school_id()
         )',
      t, t
    );
  END LOOP;
END $$;

ALTER TABLE public.news_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.news_sources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS news_sources_tenant_all ON public.news_sources;
CREATE POLICY news_sources_tenant_all ON public.news_sources
FOR ALL TO authenticated
USING (
    auth.role() = 'service_role'
    OR public.is_super_admin()
    OR school_id IS NULL
    OR school_id = public.auth_school_id()
)
WITH CHECK (
    auth.role() = 'service_role'
    OR public.is_super_admin()
    OR school_id = public.auth_school_id()
);

COMMIT;
