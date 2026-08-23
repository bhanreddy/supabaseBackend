-- Teachers can set per-paper maximums for component marks (participation,
-- written work, project work, slip test). Drop the old 10/10/10/20 CHECKs so
-- entered marks can follow those paper-level caps.

ALTER TABLE exam_subjects
  ADD COLUMN IF NOT EXISTS participation_max_marks DECIMAL(5,2) NOT NULL DEFAULT 10;
ALTER TABLE exam_subjects
  ADD COLUMN IF NOT EXISTS written_work_max_marks DECIMAL(5,2) NOT NULL DEFAULT 10;
ALTER TABLE exam_subjects
  ADD COLUMN IF NOT EXISTS project_work_max_marks DECIMAL(5,2) NOT NULL DEFAULT 10;
ALTER TABLE exam_subjects
  ADD COLUMN IF NOT EXISTS slip_test_max_marks DECIMAL(5,2) NOT NULL DEFAULT 20;

ALTER TABLE exam_subjects
  ALTER COLUMN max_marks TYPE DECIMAL(7,2);
ALTER TABLE exam_subjects
  ALTER COLUMN passing_marks TYPE DECIMAL(7,2);

ALTER TABLE marks DROP CONSTRAINT IF EXISTS marks_participation_range_check;
ALTER TABLE marks ADD CONSTRAINT marks_participation_nonnegative_check
  CHECK (participation_marks IS NULL OR participation_marks >= 0);

ALTER TABLE marks DROP CONSTRAINT IF EXISTS marks_written_work_range_check;
ALTER TABLE marks ADD CONSTRAINT marks_written_work_nonnegative_check
  CHECK (written_work_marks IS NULL OR written_work_marks >= 0);

ALTER TABLE marks DROP CONSTRAINT IF EXISTS marks_project_work_range_check;
ALTER TABLE marks ADD CONSTRAINT marks_project_work_nonnegative_check
  CHECK (project_work_marks IS NULL OR project_work_marks >= 0);

ALTER TABLE marks DROP CONSTRAINT IF EXISTS marks_slip_test_range_check;
ALTER TABLE marks ADD CONSTRAINT marks_slip_test_nonnegative_check
  CHECK (slip_test_marks IS NULL OR slip_test_marks >= 0);

ALTER TABLE exam_subjects DROP CONSTRAINT IF EXISTS exam_subjects_component_max_positive_check;
ALTER TABLE exam_subjects ADD CONSTRAINT exam_subjects_component_max_positive_check
  CHECK (
    participation_max_marks >= 1 AND participation_max_marks <= 999
    AND written_work_max_marks >= 1 AND written_work_max_marks <= 999
    AND project_work_max_marks >= 1 AND project_work_max_marks <= 999
    AND slip_test_max_marks >= 1 AND slip_test_max_marks <= 999
  );

COMMENT ON COLUMN exam_subjects.participation_max_marks IS
  'Maximum for Children''s Participation Responses when component schema is active.';
COMMENT ON COLUMN exam_subjects.written_work_max_marks IS
  'Maximum for Written Work when component schema is active.';
COMMENT ON COLUMN exam_subjects.project_work_max_marks IS
  'Maximum for Project Work when component schema is active.';
COMMENT ON COLUMN exam_subjects.slip_test_max_marks IS
  'Maximum for Slip Test when component schema is active.';
