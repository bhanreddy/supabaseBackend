-- Migration: 20260912_v424_celebration_settings.sql
-- Celebration Event Engine & Birthday Banner Configuration
-- Multi-tenant settings per school with defensive defaults.

CREATE TABLE IF NOT EXISTS public.school_celebration_settings (
  school_id INTEGER PRIMARY KEY REFERENCES public.schools(id) ON DELETE CASCADE,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  student_birthday_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  staff_birthday_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  birthday_music_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  student_template TEXT NOT NULL DEFAULT 'Happy Birthday, {{first_name}}! 🎉\nWishing you joy, success, and a wonderful year ahead.',
  staff_template TEXT NOT NULL DEFAULT 'Celebrating {{full_name}}! 🎂\nHave a fantastic birthday from everyone at {{school_name}}!',
  student_visibility VARCHAR(30) NOT NULL DEFAULT 'class',
  staff_visibility VARCHAR(30) NOT NULL DEFAULT 'staff',
  show_student_photo BOOLEAN NOT NULL DEFAULT TRUE,
  show_staff_photo BOOLEAN NOT NULL DEFAULT TRUE,
  show_class BOOLEAN NOT NULL DEFAULT TRUE,
  show_section BOOLEAN NOT NULL DEFAULT TRUE,
  show_staff_designation BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_celebration_student_visibility
    CHECK (student_visibility IN ('self_only', 'class', 'school')),
  CONSTRAINT chk_celebration_staff_visibility
    CHECK (staff_visibility IN ('staff', 'school'))
);

DROP INDEX IF EXISTS public.idx_persons_dob_birthday;
CREATE INDEX IF NOT EXISTS idx_persons_dob_birthday
  ON public.persons (school_id, (EXTRACT(MONTH FROM dob)), (EXTRACT(DAY FROM dob)))
  WHERE deleted_at IS NULL AND dob IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_students_school_active_lifecycle
  ON public.students (school_id, status_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_staff_school_active_lifecycle
  ON public.staff (school_id, status_id)
  WHERE deleted_at IS NULL;

ALTER TABLE public.school_celebration_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_celebration_settings FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'school_celebration_settings'
      AND policyname = 'school_celebration_settings_isolation'
  ) THEN
    CREATE POLICY school_celebration_settings_isolation
      ON public.school_celebration_settings
      USING (school_id = NULLIF(current_setting('app.current_school_id', true), '')::integer);
  END IF;
END $$;

REVOKE ALL ON TABLE public.school_celebration_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.school_celebration_settings TO service_role;
