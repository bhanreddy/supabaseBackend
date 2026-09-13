-- School Stories (24h Instagram-style rings) and admin-managed student hero slides.
-- Tenant-scoped. API routes use JWT school_id; RLS is defense in depth.

BEGIN;

CREATE TABLE IF NOT EXISTS public.school_stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  media_url TEXT NOT NULL,
  storage_path TEXT,
  caption VARCHAR(180),
  uploaded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  author_name VARCHAR(120) NOT NULL DEFAULT 'School',
  author_photo_url TEXT,
  author_role VARCHAR(20) NOT NULL DEFAULT 'staff',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT chk_school_stories_url_not_blank
    CHECK (length(btrim(media_url)) > 0),
  CONSTRAINT chk_school_stories_author_role
    CHECK (author_role IN ('admin', 'staff')),
  CONSTRAINT chk_school_stories_expires_after_create
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_school_stories_feed
  ON public.school_stories (school_id, expires_at DESC, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_school_stories_author
  ON public.school_stories (school_id, uploaded_by, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.school_story_views (
  school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  story_id UUID NOT NULL REFERENCES public.school_stories(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (school_id, story_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_school_story_views_user
  ON public.school_story_views (school_id, user_id, viewed_at DESC);

CREATE TABLE IF NOT EXISTS public.school_hero_slides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  storage_path TEXT,
  title VARCHAR(80),
  caption VARCHAR(180),
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_school_hero_slides_url_not_blank
    CHECK (length(btrim(image_url)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_school_hero_slides_feed
  ON public.school_hero_slides (school_id, is_active, display_order, created_at, id);

DROP TRIGGER IF EXISTS trg_school_hero_slides_updated ON public.school_hero_slides;
CREATE TRIGGER trg_school_hero_slides_updated
BEFORE UPDATE ON public.school_hero_slides
FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

ALTER TABLE public.school_stories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_story_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_hero_slides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS school_stories_tenant_select ON public.school_stories;
CREATE POLICY school_stories_tenant_select
  ON public.school_stories
  FOR SELECT
  TO authenticated
  USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR school_id = public.auth_school_id()
  );

DROP POLICY IF EXISTS school_stories_staff_insert ON public.school_stories;
CREATE POLICY school_stories_staff_insert
  ON public.school_stories
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND public.auth_has_role(ARRAY['admin', 'principal', 'staff', 'teacher'])
    )
  );

DROP POLICY IF EXISTS school_stories_manage ON public.school_stories;
CREATE POLICY school_stories_manage
  ON public.school_stories
  FOR ALL
  TO authenticated
  USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND (
        public.auth_has_role(ARRAY['admin', 'principal'])
        OR uploaded_by = auth.uid()
      )
    )
  )
  WITH CHECK (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND (
        public.auth_has_role(ARRAY['admin', 'principal'])
        OR uploaded_by = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS school_story_views_tenant ON public.school_story_views;
CREATE POLICY school_story_views_tenant
  ON public.school_story_views
  FOR ALL
  TO authenticated
  USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND user_id = auth.uid()
    )
  )
  WITH CHECK (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS school_hero_slides_tenant_select ON public.school_hero_slides;
CREATE POLICY school_hero_slides_tenant_select
  ON public.school_hero_slides
  FOR SELECT
  TO authenticated
  USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR school_id = public.auth_school_id()
  );

DROP POLICY IF EXISTS school_hero_slides_admin_manage ON public.school_hero_slides;
CREATE POLICY school_hero_slides_admin_manage
  ON public.school_hero_slides
  FOR ALL
  TO authenticated
  USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND public.auth_has_role(ARRAY['admin', 'principal'])
    )
  )
  WITH CHECK (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
      school_id = public.auth_school_id()
      AND public.auth_has_role(ARRAY['admin', 'principal'])
    )
  );

COMMIT;
