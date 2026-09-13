-- Migration: 20260913_v434_admission_workflow_hardening.sql
-- Additive hardening for the premium admission workflow. Never drops existing data.

BEGIN;

-- Sequential enquiry / application numbering (avoids COUNT(*) races)
CREATE TABLE IF NOT EXISTS public.admission_counters (
    school_id INTEGER PRIMARY KEY REFERENCES public.schools(id) ON DELETE CASCADE,
    enquiry_seq INTEGER NOT NULL DEFAULT 0,
    application_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.admission_counters (school_id, enquiry_seq, application_seq)
SELECT s.id,
       COALESCE((SELECT COUNT(*) FROM public.admission_enquiries e WHERE e.school_id = s.id), 0),
       COALESCE((SELECT COUNT(*) FROM public.admission_applications a WHERE a.school_id = s.id), 0)
FROM public.schools s
ON CONFLICT (school_id) DO NOTHING;

-- Optimistic locking, conversion display, reminder tracking
ALTER TABLE public.admission_applications
    ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS converted_admission_no VARCHAR(40),
    ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_reminder_type VARCHAR(50);

ALTER TABLE public.admission_documents
    ADD COLUMN IF NOT EXISTS file_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS original_file_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS storage_path TEXT;

ALTER TABLE public.admission_tasks
    ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;

ALTER TABLE public.admission_settings
    ADD COLUMN IF NOT EXISTS default_sla_hours_per_stage INTEGER NOT NULL DEFAULT 48,
    ADD COLUMN IF NOT EXISTS max_applicant_reminders INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS reminder_interval_hours INTEGER NOT NULL DEFAULT 24;

CREATE INDEX IF NOT EXISTS idx_admission_docs_hash
    ON public.admission_documents(school_id, file_hash)
    WHERE file_hash IS NOT NULL;

-- Conversion forensic log (success and failed attempts)
CREATE TABLE IF NOT EXISTS public.admission_conversion_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES public.admission_applications(id) ON DELETE CASCADE,
    student_id UUID REFERENCES public.students(id) ON DELETE SET NULL,
    admission_no VARCHAR(40),
    actor_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'SUCCESS',
    error_message TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admission_conversion_logs_app
    ON public.admission_conversion_logs(school_id, application_id, created_at DESC);

-- Dedicated waitlist rows (rank + promotion tracking)
CREATE TABLE IF NOT EXISTS public.admission_waitlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES public.admission_applications(id) ON DELETE CASCADE,
    class_id UUID REFERENCES public.classes(id) ON DELETE SET NULL,
    academic_year_id UUID REFERENCES public.academic_years(id) ON DELETE SET NULL,
    rank INTEGER,
    reason TEXT,
    notified_at TIMESTAMPTZ,
    promoted_at TIMESTAMPTZ,
    promoted_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_admission_waitlist_app UNIQUE (school_id, application_id)
);

CREATE INDEX IF NOT EXISTS idx_admission_waitlist_class
    ON public.admission_waitlist(school_id, class_id, rank)
    WHERE promoted_at IS NULL;

-- Notification templates (school-overridable copy)
CREATE TABLE IF NOT EXISTS public.admission_notification_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_type VARCHAR(80) NOT NULL,
    subject_template TEXT NOT NULL,
    body_template TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_admission_notif_template UNIQUE (school_id, event_type)
);

-- Idempotency for retry-safe notifications / conversion
CREATE TABLE IF NOT EXISTS public.admission_idempotency_keys (
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(120) NOT NULL,
    action VARCHAR(80) NOT NULL,
    entity_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (school_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_admission_idempotency_created
    ON public.admission_idempotency_keys(created_at);

-- Tenant isolation for new + existing admission tables.
-- Application-layer school_id predicates remain the primary control because the
-- API uses a BYPASSRLS connection. RLS + revoke-from-portal roles protect any
-- accidental PostgREST / authenticated access path.
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'admission_settings',
        'admission_workflow_stages',
        'admission_document_requirements',
        'admission_capacities',
        'admission_enquiries',
        'admission_applications',
        'admission_application_stage_history',
        'admission_documents',
        'admission_tasks',
        'admission_interviews',
        'admission_notes',
        'admission_communications',
        'admission_audit_logs',
        'admission_counters',
        'admission_conversion_logs',
        'admission_waitlist',
        'admission_notification_templates',
        'admission_idempotency_keys'
    ]
    LOOP
        IF to_regclass('public.' || tbl) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
            EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON public.%I', tbl, tbl);
            EXECUTE format(
                'CREATE POLICY tenant_isolation_%I ON public.%I USING (school_id = public.current_school_id()) WITH CHECK (school_id = public.current_school_id())',
                tbl, tbl
            );
            EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', tbl);
            EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
        END IF;
    END LOOP;
END $$;

COMMIT;
