-- Migration: 20260912_v428_academic_calendar_hardening.sql
-- Academic Calendar Hardening: Column additions and composite performance indexes

-- 1. Add updated_at to calendar_event_reminders
ALTER TABLE public.calendar_event_reminders
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 2. Performance indexes for high-frequency calendar queries
CREATE INDEX IF NOT EXISTS idx_calendar_events_window
    ON public.calendar_events (school_id, status, start_date, end_date)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_calendar_event_reminders_queue
    ON public.calendar_event_reminders (school_id, status, remind_at);

CREATE INDEX IF NOT EXISTS idx_calendar_event_targets_lookup_covering
    ON public.calendar_event_targets (school_id, target_type, target_id, event_id);
