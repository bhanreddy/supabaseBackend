-- School-scoped public website gallery.
-- SchoolIMS owns the metadata and image URLs; each school website reads the
-- public endpoint with its build/runtime school_id.

BEGIN;

CREATE TABLE IF NOT EXISTS public.school_website_gallery (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  storage_path TEXT,
  alt_text VARCHAR(180) NOT NULL DEFAULT 'School gallery photo',
  caption VARCHAR(180),
  category VARCHAR(60) NOT NULL DEFAULT 'School Life',
  display_order INTEGER NOT NULL DEFAULT 0,
  uploaded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_school_website_gallery_url_not_blank
    CHECK (length(btrim(image_url)) > 0),
  CONSTRAINT chk_school_website_gallery_alt_not_blank
    CHECK (length(btrim(alt_text)) > 0),
  CONSTRAINT chk_school_website_gallery_category_not_blank
    CHECK (length(btrim(category)) > 0),
  CONSTRAINT uq_school_website_gallery_url UNIQUE (school_id, image_url)
);

CREATE INDEX IF NOT EXISTS idx_school_website_gallery_school_order
  ON public.school_website_gallery (school_id, display_order, created_at, id);

DROP TRIGGER IF EXISTS trg_school_website_gallery_updated ON public.school_website_gallery;
CREATE TRIGGER trg_school_website_gallery_updated
BEFORE UPDATE ON public.school_website_gallery
FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

ALTER TABLE public.school_website_gallery ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS school_website_gallery_tenant_select ON public.school_website_gallery;
CREATE POLICY school_website_gallery_tenant_select
  ON public.school_website_gallery
  FOR SELECT
  TO authenticated
  USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR school_id = public.auth_school_id()
  );

DROP POLICY IF EXISTS school_website_gallery_admin_manage ON public.school_website_gallery;
CREATE POLICY school_website_gallery_admin_manage
  ON public.school_website_gallery
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

-- Preserve GHS Maddur's current gallery when the dynamic endpoint first goes
-- live. These are normal rows (storage_path is null because the originals are
-- served by the school site), so school 17's admin can remove them immediately.
INSERT INTO public.school_website_gallery
  (id, school_id, image_url, alt_text, caption, category, display_order)
SELECT seed.id, 17, seed.image_url, seed.alt_text, seed.caption, seed.category, seed.display_order
FROM (
  VALUES
    ('00000017-0000-4000-8000-000000000001'::uuid, 'https://www.ghsmaddur.in/campus-building.png', 'Geetanjali High School main building', NULL, 'Campus', 0),
    ('00000017-0000-4000-8000-000000000002'::uuid, 'https://www.ghsmaddur.in/bathukamma_ground.png', 'Bathukamma dance celebration on campus', NULL, 'Events', 1),
    ('00000017-0000-4000-8000-000000000003'::uuid, 'https://www.ghsmaddur.in/campus-aerial-1.png', 'Aerial view of the Maddur campus', NULL, 'Campus', 2),
    ('00000017-0000-4000-8000-000000000004'::uuid, 'https://www.ghsmaddur.in/bathukamma-celebration.png', 'Bathukamma Samburalu group photo', NULL, 'Events', 3),
    ('00000017-0000-4000-8000-000000000005'::uuid, 'https://www.ghsmaddur.in/campus-aerial-2.png', 'School buildings and courtyard from above', NULL, 'Campus', 4)
) AS seed(id, image_url, alt_text, caption, category, display_order)
WHERE EXISTS (SELECT 1 FROM public.schools WHERE id = 17)
ON CONFLICT DO NOTHING;

COMMIT;
