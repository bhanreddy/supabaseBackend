-- Add optional PEN (Permanent Education Number) for students.

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS pen_number VARCHAR(30) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_students_pen_active
  ON public.students (school_id, pen_number)
  WHERE deleted_at IS NULL AND pen_number IS NOT NULL;
