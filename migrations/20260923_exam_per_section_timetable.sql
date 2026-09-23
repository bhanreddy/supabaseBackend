-- Exam timetable: add nullable class_section_id to exam_subjects for per-section scheduling.
-- Safe, forward-only, idempotent migration.

ALTER TABLE exam_subjects
  ADD COLUMN IF NOT EXISTS class_section_id UUID REFERENCES class_sections(id);

CREATE INDEX IF NOT EXISTS idx_exam_subjects_class_section_id
  ON exam_subjects(class_section_id) WHERE deleted_at IS NULL;

-- Replace global active unique index with partial unique indexes to support both
-- legacy/aligned/per_class (class-level, class_section_id IS NULL) and per-section rows.
DROP INDEX IF EXISTS idx_exam_subjects_active;

-- Legacy/aligned/per_class rows: unique active exam_id + class_id + subject_id when class_section_id IS NULL
CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_subjects_active_class
  ON exam_subjects(exam_id, class_id, subject_id)
  WHERE deleted_at IS NULL AND class_section_id IS NULL;

-- Per-section rows: unique active exam_id + class_section_id + subject_id when class_section_id IS NOT NULL
CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_subjects_active_section
  ON exam_subjects(exam_id, class_section_id, subject_id)
  WHERE deleted_at IS NULL AND class_section_id IS NOT NULL;
