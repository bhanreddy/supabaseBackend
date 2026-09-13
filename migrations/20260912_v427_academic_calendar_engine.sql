-- Migration: 20260912_v427_academic_calendar_engine.sql
-- Academic Calendar and Centralized School Scheduling Engine
-- Backward-compatible multi-tenant migration

BEGIN;

-- 1. Academic Terms table
CREATE TABLE IF NOT EXISTS public.academic_terms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    academic_year_id UUID NOT NULL REFERENCES public.academic_years(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('UPCOMING', 'ACTIVE', 'COMPLETED', 'ARCHIVED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_academic_term_dates CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_academic_terms_school_year
ON public.academic_terms(school_id, academic_year_id, sequence)
WHERE deleted_at IS NULL;

-- 2. Enhance academic_years with status and name
ALTER TABLE public.academic_years
    ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN IF NOT EXISTS name VARCHAR(100);

-- Safe check constraint for academic_years status
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_academic_years_status'
    ) THEN
        ALTER TABLE public.academic_years
        ADD CONSTRAINT chk_academic_years_status
        CHECK (status IN ('UPCOMING', 'ACTIVE', 'COMPLETED', 'ARCHIVED'));
    END IF;
END $$;

-- 3. Core Calendar Events table
CREATE TABLE IF NOT EXISTS public.calendar_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    academic_year_id UUID REFERENCES public.academic_years(id) ON DELETE SET NULL,
    academic_term_id UUID REFERENCES public.academic_terms(id) ON DELETE SET NULL,
    title VARCHAR(250) NOT NULL,
    title_te TEXT,
    description TEXT,
    description_te TEXT,
    event_type VARCHAR(50) NOT NULL DEFAULT 'SCHOOL_EVENT',
    start_datetime TIMESTAMPTZ NOT NULL,
    end_datetime TIMESTAMPTZ NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    is_all_day BOOLEAN NOT NULL DEFAULT false,
    location VARCHAR(250),
    status VARCHAR(30) NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'PUBLISHED', 'COMPLETED', 'CANCELLED', 'ARCHIVED')),
    priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
    
    -- Operational behavior flags
    attendance_enabled BOOLEAN DEFAULT NULL, -- NULL = default, true = override enable, false = override disable
    timetable_enabled BOOLEAN DEFAULT NULL,  -- NULL = default, true = override enable, false = override disable
    copy_timetable_from_day VARCHAR(20) DEFAULT NULL, -- e.g. 'monday' on Saturday
    holiday_type VARCHAR(50) DEFAULT NULL,   -- PUBLIC_HOLIDAY, SCHOOL_HOLIDAY, LOCAL_HOLIDAY, VACATION, EMERGENCY_HOLIDAY, OPTIONAL_HOLIDAY
    
    -- Integration links
    source_module VARCHAR(50) NOT NULL DEFAULT 'MANUAL', -- MANUAL, EXAM, FEES, HOMEWORK, ATTENDANCE, TIMETABLE, TRANSPORT, STAFF, NOTICE, SYSTEM
    source_entity_id VARCHAR(100) DEFAULT NULL,
    
    -- Recurrence rule
    recurrence_rule JSONB DEFAULT NULL,
    recurrence_parent_id UUID REFERENCES public.calendar_events(id) ON DELETE CASCADE,
    
    -- Reminders configuration
    reminder_schedules JSONB DEFAULT '["1d", "1h"]'::jsonb,
    
    -- Audit & Lifecycle
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    published_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT,
    attachments JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_calendar_event_times CHECK (end_datetime >= start_datetime)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_school_date
ON public.calendar_events(school_id, start_date, end_date)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_calendar_events_school_type
ON public.calendar_events(school_id, event_type)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_calendar_events_school_status
ON public.calendar_events(school_id, status)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_calendar_events_source
ON public.calendar_events(school_id, source_module, source_entity_id)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_calendar_events_recurrence
ON public.calendar_events(school_id, recurrence_parent_id)
WHERE deleted_at IS NULL;

-- 4. Calendar Event Targets table (normalized audience targeting)
CREATE TABLE IF NOT EXISTS public.calendar_event_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.calendar_events(id) ON DELETE CASCADE,
    target_type VARCHAR(50) NOT NULL CHECK (target_type IN ('ENTIRE_SCHOOL', 'ROLE', 'CLASS', 'SECTION', 'USER', 'STUDENT')),
    target_id VARCHAR(100) NOT NULL, -- role name (e.g. 'staff'), class UUID, section UUID, user UUID, student UUID, or 'ALL'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_event_target UNIQUE (event_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_event_targets_lookup
ON public.calendar_event_targets(school_id, target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_calendar_event_targets_event
ON public.calendar_event_targets(event_id);

-- 5. Calendar Event Reminders
CREATE TABLE IF NOT EXISTS public.calendar_event_reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.calendar_events(id) ON DELETE CASCADE,
    remind_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'CANCELLED')),
    sent_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_event_remind_time UNIQUE (event_id, remind_at)
);

CREATE INDEX IF NOT EXISTS idx_calendar_event_reminders_pending
ON public.calendar_event_reminders(status, remind_at)
WHERE status = 'PENDING';

-- 6. Calendar Event Templates
CREATE TABLE IF NOT EXISTS public.calendar_event_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    default_priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
    default_audience_type VARCHAR(50) NOT NULL DEFAULT 'ENTIRE_SCHOOL',
    attendance_disabled BOOLEAN NOT NULL DEFAULT false,
    timetable_disabled BOOLEAN NOT NULL DEFAULT false,
    default_reminders JSONB DEFAULT '["1d"]'::jsonb,
    icon VARCHAR(50) DEFAULT 'calendar-outline',
    color VARCHAR(20) DEFAULT '#3B82F6',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_calendar_event_templates_school
ON public.calendar_event_templates(school_id)
WHERE deleted_at IS NULL;

-- 7. Calendar Event History / Audit
CREATE TABLE IF NOT EXISTS public.calendar_event_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.calendar_events(id) ON DELETE CASCADE,
    changed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    change_type VARCHAR(50) NOT NULL, -- CREATED, UPDATED, PUBLISHED, CANCELLED, RESCHEDULED, TARGET_CHANGED
    old_value JSONB,
    new_value JSONB,
    change_summary TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_event_history_event
ON public.calendar_event_history(event_id, created_at DESC);

-- 8. Seed default templates for all active schools
DO $$
DECLARE
    s_id INTEGER;
BEGIN
    FOR s_id IN SELECT id FROM public.schools LOOP
        IF NOT EXISTS (SELECT 1 FROM public.calendar_event_templates WHERE school_id = s_id AND name = 'Public Holiday') THEN
            INSERT INTO public.calendar_event_templates (school_id, name, event_type, default_priority, default_audience_type, attendance_disabled, timetable_disabled, default_reminders, icon, color)
            VALUES 
                (s_id, 'Public Holiday', 'HOLIDAY', 'NORMAL', 'ENTIRE_SCHOOL', true, true, '["1d"]'::jsonb, 'sunny-outline', '#EF4444'),
                (s_id, 'School Holiday', 'HOLIDAY', 'NORMAL', 'ENTIRE_SCHOOL', true, true, '["1d"]'::jsonb, 'airplane-outline', '#F59E0B'),
                (s_id, 'Special Working Day', 'SPECIAL_WORKING_DAY', 'HIGH', 'ENTIRE_SCHOOL', false, false, '["1d", "1h"]'::jsonb, 'briefcase-outline', '#10B981'),
                (s_id, 'Parent Teacher Meeting', 'PTM', 'HIGH', 'ENTIRE_SCHOOL', false, false, '["3d", "1d"]'::jsonb, 'people-outline', '#8B5CF6'),
                (s_id, 'Term Examination', 'EXAM', 'HIGH', 'CLASS', false, false, '["7d", "1d"]'::jsonb, 'clipboard-outline', '#3B82F6'),
                (s_id, 'Unit Test', 'TEST', 'NORMAL', 'CLASS', false, false, '["3d", "1d"]'::jsonb, 'document-text-outline', '#06B6D4'),
                (s_id, 'Staff Meeting', 'STAFF_MEETING', 'NORMAL', 'ROLE', false, false, '["1d", "1h"]'::jsonb, 'chatbubbles-outline', '#6366F1'),
                (s_id, 'Fee Due Date', 'FEE_DUE', 'HIGH', 'ENTIRE_SCHOOL', false, false, '["7d", "3d", "1d"]'::jsonb, 'wallet-outline', '#D97706'),
                (s_id, 'Annual Day / Sports Day', 'SCHOOL_EVENT', 'NORMAL', 'ENTIRE_SCHOOL', false, false, '["7d", "1d"]'::jsonb, 'trophy-outline', '#EC4899');
        END IF;
    END LOOP;
END $$;

COMMIT;
