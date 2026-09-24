-- Migration: Add timetable_version and timetable_published_version to exams
-- Supports draft editing of published timetables and idempotent notifications on republish.

ALTER TABLE public.exams
  ADD COLUMN IF NOT EXISTS timetable_version integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS timetable_published_version integer DEFAULT 0 NOT NULL;

-- Backfill existing published exams so they are aligned
UPDATE public.exams
SET timetable_published_version = timetable_version
WHERE timetable_published = TRUE AND timetable_published_version = 0;
