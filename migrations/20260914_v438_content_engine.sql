-- Migration: 20260914_v438_content_engine.sql
-- Description: Production-grade Reusable Content Engine for SchoolIMS
--              Supports Daily Thoughts, Daily News, audience targeting,
--              workflow states, version snapshots, media attachments,
--              immutable audit logging, bookmarks, and engagement analytics.


-- 1. UNIVERSAL CONTENT ITEMS TABLE
CREATE TABLE IF NOT EXISTS public.content_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    type VARCHAR(32) NOT NULL, -- 'THOUGHT', 'NEWS', 'ANNOUNCEMENT', 'EVENT', etc.
    title VARCHAR(255) NOT NULL,
    summary TEXT,
    body TEXT,
    language VARCHAR(10) NOT NULL DEFAULT 'en',
    status VARCHAR(32) NOT NULL DEFAULT 'DRAFT', -- 'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'REJECTED', 'ARCHIVED'
    priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL', -- 'LOW', 'NORMAL', 'HIGH', 'URGENT'
    rejection_reason TEXT,
    author_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    published_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    scheduled_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    is_featured BOOLEAN NOT NULL DEFAULT FALSE,
    cover_image_url TEXT,
    cover_storage_path TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_content_items_status CHECK (
        status IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'REJECTED', 'ARCHIVED')
    ),
    CONSTRAINT chk_content_items_priority CHECK (
        priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')
    ),
    CONSTRAINT chk_content_items_type CHECK (
        type IN ('THOUGHT', 'NEWS', 'ANNOUNCEMENT', 'EVENT', 'ACHIEVEMENT', 'ARTICLE', 'NOTICE', 'MOTIVATION', 'SAFETY_ALERT')
    )
);

CREATE INDEX IF NOT EXISTS idx_content_items_school_status ON public.content_items(school_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_items_school_type_status ON public.content_items(school_id, type, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_items_feed ON public.content_items(school_id, type, status, published_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_items_scheduled ON public.content_items(school_id, status, scheduled_at) WHERE deleted_at IS NULL AND status = 'SCHEDULED';
CREATE INDEX IF NOT EXISTS idx_content_items_author ON public.content_items(school_id, author_id) WHERE deleted_at IS NULL;

-- Full-text search index across title, summary, and body
CREATE INDEX IF NOT EXISTS idx_content_items_fts ON public.content_items USING gin(
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(body, ''))
) WHERE deleted_at IS NULL;

-- 2. DAILY THOUGHTS TABLE
CREATE TABLE IF NOT EXISTS public.content_thoughts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL UNIQUE REFERENCES public.content_items(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    quote TEXT NOT NULL,
    author VARCHAR(150) NOT NULL,
    author_description VARCHAR(255),
    category VARCHAR(64) NOT NULL DEFAULT 'Inspiration',
    slot_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_thoughts_school_slot ON public.content_thoughts(school_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_content_thoughts_category ON public.content_thoughts(school_id, category);

-- 3. DAILY NEWS TABLE
CREATE TABLE IF NOT EXISTS public.content_news (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL UNIQUE REFERENCES public.content_items(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    headline VARCHAR(255) NOT NULL,
    source_name VARCHAR(120),
    source_url TEXT,
    category VARCHAR(64) NOT NULL DEFAULT 'General',
    location VARCHAR(120),
    reading_time INTEGER NOT NULL DEFAULT 2, -- in minutes
    tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_news_school_cat ON public.content_news(school_id, category);
CREATE INDEX IF NOT EXISTS idx_content_news_tags ON public.content_news USING gin(tags);

-- 4. NEWS SOURCES ABSTRACTION
CREATE TABLE IF NOT EXISTS public.news_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER REFERENCES public.schools(id) ON DELETE CASCADE, -- NULL indicates global/verified source
    name VARCHAR(120) NOT NULL,
    source_url TEXT,
    source_type VARCHAR(50) NOT NULL DEFAULT 'MANUAL', -- 'MANUAL', 'RSS', 'API'
    category VARCHAR(64),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    trust_level VARCHAR(20) NOT NULL DEFAULT 'HIGH', -- 'STANDARD', 'HIGH', 'OFFICIAL'
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_news_sources_school ON public.news_sources(school_id) WHERE is_active = TRUE;

-- 5. CONTENT AUDIENCE TARGETS
CREATE TABLE IF NOT EXISTS public.content_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL REFERENCES public.content_items(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    target_type VARCHAR(32) NOT NULL, -- 'SCHOOL', 'ROLE', 'CLASS', 'SECTION', 'USER'
    target_id VARCHAR(64) NOT NULL,   -- 'all', 'student', 'parent', 'staff', 'teacher', UUID of class/section/user
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_content_target UNIQUE(content_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_content_targets_lookup ON public.content_targets(school_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_content_targets_content ON public.content_targets(content_id);

-- 6. CONTENT MEDIA ATTACHMENTS
CREATE TABLE IF NOT EXISTS public.content_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL REFERENCES public.content_items(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    media_type VARCHAR(20) NOT NULL DEFAULT 'image', -- 'image', 'video'
    url TEXT NOT NULL,
    storage_path TEXT,
    thumbnail_url TEXT,
    caption VARCHAR(255),
    sort_order INTEGER NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_media_content ON public.content_media(content_id, sort_order);

-- 7. CONTENT VERSION HISTORY
CREATE TABLE IF NOT EXISTS public.content_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL REFERENCES public.content_items(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    snapshot JSONB NOT NULL,
    changed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    change_summary TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_content_version UNIQUE(content_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_content_versions_content ON public.content_versions(content_id, version_number DESC);

-- 8. IMMUTABLE CONTENT AUDIT LOGS
CREATE TABLE IF NOT EXISTS public.content_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    content_id UUID NOT NULL REFERENCES public.content_items(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL, -- 'CREATED', 'EDITED', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SCHEDULED', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED', 'RESTORED'
    performed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    changed_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    previous_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    new_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_audit_content ON public.content_audit_logs(school_id, content_id, created_at DESC);

-- 9. USER BOOKMARKS
CREATE TABLE IF NOT EXISTS public.content_bookmarks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    content_id UUID NOT NULL REFERENCES public.content_items(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_content_user_bookmark UNIQUE(school_id, user_id, content_id)
);

CREATE INDEX IF NOT EXISTS idx_content_bookmarks_user ON public.content_bookmarks(school_id, user_id, created_at DESC);

-- 10. ENGAGEMENT ANALYTICS
CREATE TABLE IF NOT EXISTS public.content_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    content_id UUID NOT NULL REFERENCES public.content_items(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    event_type VARCHAR(32) NOT NULL, -- 'VIEW', 'LIKE', 'BOOKMARK', 'SHARE', 'NOTIFICATION_OPEN', 'READ_PROGRESS', 'READ_COMPLETED'
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_analytics_agg ON public.content_analytics(school_id, content_id, event_type);
CREATE INDEX IF NOT EXISTS idx_content_analytics_user ON public.content_analytics(school_id, user_id, event_type);

-- 11. CONTENT MULTI-LANGUAGE TRANSLATIONS
CREATE TABLE IF NOT EXISTS public.content_translations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_id UUID NOT NULL REFERENCES public.content_items(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    language VARCHAR(10) NOT NULL, -- 'te', 'hi', etc.
    title VARCHAR(255) NOT NULL,
    summary TEXT,
    body TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_content_translation UNIQUE(content_id, language)
);

CREATE INDEX IF NOT EXISTS idx_content_translations_lang ON public.content_translations(content_id, language);

-- 12. TRIGGERS FOR TIMESTAMP UPDATES
DROP TRIGGER IF EXISTS trg_content_items_updated ON public.content_items;
CREATE TRIGGER trg_content_items_updated
BEFORE UPDATE ON public.content_items
FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

DROP TRIGGER IF EXISTS trg_content_thoughts_updated ON public.content_thoughts;
CREATE TRIGGER trg_content_thoughts_updated
BEFORE UPDATE ON public.content_thoughts
FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

DROP TRIGGER IF EXISTS trg_content_news_updated ON public.content_news;
CREATE TRIGGER trg_content_news_updated
BEFORE UPDATE ON public.content_news
FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

-- 13. ROW LEVEL SECURITY
ALTER TABLE public.content_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_thoughts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_news ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.news_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_translations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS content_items_tenant_select ON public.content_items;
CREATE POLICY content_items_tenant_select ON public.content_items
FOR SELECT TO authenticated
USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR school_id = public.auth_school_id()
);

DROP POLICY IF EXISTS content_items_tenant_insert ON public.content_items;
CREATE POLICY content_items_tenant_insert ON public.content_items
FOR INSERT TO authenticated
WITH CHECK (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
        school_id = public.auth_school_id()
        AND public.auth_has_role(ARRAY['admin', 'principal', 'staff', 'teacher'])
    )
);

DROP POLICY IF EXISTS content_items_tenant_manage ON public.content_items;
CREATE POLICY content_items_tenant_manage ON public.content_items
FOR ALL TO authenticated
USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (
        school_id = public.auth_school_id()
        AND public.auth_has_role(ARRAY['admin', 'principal', 'staff', 'teacher'])
    )
);

-- 14. SEED RBAC PERMISSIONS FOR CONTENT ENGINE
INSERT INTO public.permissions (school_id, code, name)
SELECT s.id, v.code, v.name
FROM public.schools s
CROSS JOIN (VALUES
    ('content.view',     'View SchoolIMS Daily Thoughts & News'),
    ('content.create',   'Draft Content Items (Thoughts, News, Announcements)'),
    ('content.submit',   'Submit Content for Review & Approval'),
    ('content.approve',  'Review, Approve, or Reject Submitted Content'),
    ('content.publish',  'Publish or Schedule Content School-Wide'),
    ('content.manage',   'Full Content Engine Administration, Sources, & Analytics')
) AS v(code, name)
WHERE NOT EXISTS (
    SELECT 1 FROM public.permissions p
    WHERE p.school_id = s.id AND p.code = v.code
);

-- Map all permissions to admin and principal
INSERT INTO public.role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM public.permissions p
JOIN public.roles r ON r.school_id = p.school_id AND r.code IN ('admin', 'principal')
WHERE p.code LIKE 'content.%'
ON CONFLICT DO NOTHING;

-- Map create, submit, and view permissions to staff and teachers
INSERT INTO public.role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM public.permissions p
JOIN public.roles r ON r.school_id = p.school_id AND r.code IN ('staff', 'teacher')
WHERE p.code IN (
    'content.view',
    'content.create',
    'content.submit'
)
ON CONFLICT DO NOTHING;

-- Map view permission to students and parents
INSERT INTO public.role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM public.permissions p
JOIN public.roles r ON r.school_id = p.school_id AND r.code IN ('student', 'parent')
WHERE p.code = 'content.view'
ON CONFLICT DO NOTHING;

-- 15. SEED STANDARD NEWS SOURCES (Global and reusable)
INSERT INTO public.news_sources (school_id, name, source_url, source_type, category, trust_level)
VALUES
    (NULL, 'SchoolIMS Editorial', 'https://schoolims.com', 'MANUAL', 'Campus', 'OFFICIAL'),
    (NULL, 'Press Trust of India (PTI)', 'https://www.ptinews.com', 'MANUAL', 'National', 'HIGH'),
    (NULL, 'ISRO Updates', 'https://www.isro.gov.in', 'MANUAL', 'Space', 'OFFICIAL'),
    (NULL, 'Science Daily', 'https://www.sciencedaily.com', 'MANUAL', 'Science', 'HIGH'),
    (NULL, 'National Geographic Kids', 'https://kids.nationalgeographic.com', 'MANUAL', 'Education', 'HIGH')
ON CONFLICT DO NOTHING;

