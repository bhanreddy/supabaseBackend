-- Migration: 20260912_v429_academic_calendar_production.sql
-- Academic Calendar production hardening (backward compatible)

BEGIN;

-- 1. Expand audience targeting types
ALTER TABLE public.calendar_event_targets
    DROP CONSTRAINT IF EXISTS calendar_event_targets_target_type_check;

ALTER TABLE public.calendar_event_targets
    ADD CONSTRAINT calendar_event_targets_target_type_check
    CHECK (target_type IN (
        'ENTIRE_SCHOOL', 'ROLE', 'CLASS', 'SECTION', 'USER', 'STUDENT',
        'PARENT', 'STAFF', 'ACCOUNTS', 'DRIVER', 'GATEKEEPER'
    ));

-- 2. Expand event status (approval rejection path)
ALTER TABLE public.calendar_events
    DROP CONSTRAINT IF EXISTS calendar_events_status_check;

ALTER TABLE public.calendar_events
    ADD CONSTRAINT calendar_events_status_check
    CHECK (status IN (
        'DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'PUBLISHED',
        'COMPLETED', 'CANCELLED', 'ARCHIVED', 'REJECTED'
    ));

-- 3. PTM / conflict / override metadata
ALTER TABLE public.calendar_events
    ADD COLUMN IF NOT EXISTS teacher_id UUID,
    ADD COLUMN IF NOT EXISTS conflict_override BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS conflict_justification TEXT,
    ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- 4. Reminder notification linkage for idempotent retries
ALTER TABLE public.calendar_event_reminders
    ADD COLUMN IF NOT EXISTS notification_id UUID;

-- 5. Unique source linkage per tenant (prevents duplicate generated events)
WITH dups AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY school_id, source_module, source_entity_id
             ORDER BY created_at DESC
           ) AS rn
    FROM public.calendar_events
    WHERE deleted_at IS NULL AND source_entity_id IS NOT NULL
)
UPDATE public.calendar_events ce
SET deleted_at = now()
FROM dups
WHERE ce.id = dups.id AND dups.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_events_source_entity
    ON public.calendar_events (school_id, source_module, source_entity_id)
    WHERE deleted_at IS NULL AND source_entity_id IS NOT NULL;

-- 6. Search / date indexes matching actual query patterns
CREATE INDEX IF NOT EXISTS idx_calendar_events_title_search
    ON public.calendar_events (school_id, lower(title))
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_calendar_events_datetime
    ON public.calendar_events (school_id, start_datetime, end_datetime)
    WHERE deleted_at IS NULL;

-- 7. One ACTIVE academic year per school (archive extras first)
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY school_id ORDER BY start_date DESC, created_at DESC) AS rn
    FROM public.academic_years
    WHERE deleted_at IS NULL AND status = 'ACTIVE'
)
UPDATE public.academic_years ay
SET status = 'ARCHIVED'
FROM ranked
WHERE ay.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_academic_years_one_active
    ON public.academic_years (school_id)
    WHERE deleted_at IS NULL AND status = 'ACTIVE';

-- 8. School-level calendar settings (do not invent a second feature-flag system)
INSERT INTO public.school_settings (school_id, key, value, updated_at)
SELECT s.id, setting.key, setting.value, now()
FROM public.schools s
CROSS JOIN (VALUES
    ('academic_calendar_enabled', 'true'),
    ('calendar_approval_required', 'false'),
    ('calendar_homework_sync_enabled', 'true'),
    ('calendar_fee_sync_enabled', 'true'),
    ('calendar_device_sync_enabled', 'true')
) AS setting(key, value)
ON CONFLICT (school_id, key) DO NOTHING;

COMMIT;
