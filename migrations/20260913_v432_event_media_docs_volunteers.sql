-- Additive Event Management tables: gallery, documents, volunteers.
-- Does not alter or drop existing production event tables.

BEGIN;

CREATE TABLE IF NOT EXISTS public.event_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    album VARCHAR(120) NOT NULL DEFAULT 'General',
    media_type VARCHAR(20) NOT NULL CHECK (media_type IN ('PHOTO', 'VIDEO')),
    file_url TEXT NOT NULL,
    caption TEXT,
    visibility VARCHAR(20) NOT NULL DEFAULT 'SCHOOL' CHECK (visibility IN ('PRIVATE', 'SCHOOL', 'PARENTS', 'PUBLIC')),
    moderation_status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (moderation_status IN ('PENDING', 'APPROVED', 'REJECTED')),
    uploaded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_event_media_event ON public.event_media(school_id, event_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.event_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    document_type VARCHAR(50) NOT NULL,
    title VARCHAR(200) NOT NULL,
    file_url TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    access_level VARCHAR(20) NOT NULL DEFAULT 'STAFF' CHECK (access_level IN ('PUBLIC', 'PARENTS', 'STAFF', 'ADMIN', 'ACCOUNTS')),
    uploaded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_event_documents_event ON public.event_documents(school_id, event_id, document_type) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.event_volunteers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    volunteer_type VARCHAR(20) NOT NULL CHECK (volunteer_type IN ('STUDENT', 'STAFF')),
    student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    area VARCHAR(80) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'ASSIGNED')),
    shift_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_volunteers_event ON public.event_volunteers(school_id, event_id, status);

CREATE TABLE IF NOT EXISTS public.event_ai_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    prompt TEXT NOT NULL,
    draft_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPLIED', 'DISCARDED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
