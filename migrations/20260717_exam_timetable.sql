-- Exam timetable module: time slots on exam_subjects + publish gate and saved
-- generator parameters on exams. Additive / forward-only; safe to re-run.

-- exam_subjects: a row is one paper (exam x class x subject). It already has
-- exam_date; the timetable needs session times and audit timestamps.
ALTER TABLE exam_subjects ADD COLUMN IF NOT EXISTS start_time TIME;
ALTER TABLE exam_subjects ADD COLUMN IF NOT EXISTS end_time TIME;
ALTER TABLE exam_subjects ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE exam_subjects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_exam_subject_times'
  ) THEN
    ALTER TABLE exam_subjects ADD CONSTRAINT chk_exam_subject_times
      CHECK (start_time IS NULL OR end_time IS NULL OR end_time > start_time);
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_exam_subjects_updated ON exam_subjects;
CREATE TRIGGER trg_exam_subjects_updated
BEFORE UPDATE ON exam_subjects
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Serves the admin grid (per exam ordered by date) and the student/teacher
-- date-ordered reads.
CREATE INDEX IF NOT EXISTS idx_exam_subjects_exam_date
  ON exam_subjects(exam_id, exam_date) WHERE deleted_at IS NULL;

-- exams: students/teachers only ever see a timetable after the admin publishes
-- it; timetable_params remembers the last generator inputs so the wizard can
-- be reopened pre-filled and the schedule regenerated with tweaks.
ALTER TABLE exams ADD COLUMN IF NOT EXISTS timetable_published BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS timetable_published_at TIMESTAMPTZ;
ALTER TABLE exams ADD COLUMN IF NOT EXISTS timetable_params JSONB;
