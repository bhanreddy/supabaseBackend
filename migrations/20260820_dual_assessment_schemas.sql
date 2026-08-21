-- Preserve both detailed component marks and direct consolidated marks for the
-- same exam paper. `marks_obtained` remains the canonical score consumed by
-- existing reports; it mirrors whichever schema is active on exam_subjects.

ALTER TABLE exam_subjects
  ADD COLUMN IF NOT EXISTS assessment_schema VARCHAR(20) NOT NULL DEFAULT 'consolidated';
ALTER TABLE exam_subjects
  ADD COLUMN IF NOT EXISTS consolidated_max_marks DECIMAL(7,2) NOT NULL DEFAULT 25;

UPDATE exam_subjects
SET consolidated_max_marks = max_marks
WHERE assessment_schema = 'consolidated';

ALTER TABLE exam_subjects
  DROP CONSTRAINT IF EXISTS exam_subjects_assessment_schema_check;
ALTER TABLE exam_subjects
  ADD CONSTRAINT exam_subjects_assessment_schema_check
  CHECK (assessment_schema IN ('component', 'consolidated'));

ALTER TABLE marks
  ADD COLUMN IF NOT EXISTS consolidated_marks_obtained DECIMAL(7,2);
ALTER TABLE marks
  ADD COLUMN IF NOT EXISTS participation_marks DECIMAL(5,2);
ALTER TABLE marks
  ADD COLUMN IF NOT EXISTS written_work_marks DECIMAL(5,2);
ALTER TABLE marks
  ADD COLUMN IF NOT EXISTS project_work_marks DECIMAL(5,2);
ALTER TABLE marks
  ADD COLUMN IF NOT EXISTS slip_test_marks DECIMAL(5,2);

UPDATE marks
SET consolidated_marks_obtained = marks_obtained
WHERE consolidated_marks_obtained IS NULL;

ALTER TABLE marks DROP CONSTRAINT IF EXISTS marks_consolidated_nonnegative_check;
ALTER TABLE marks ADD CONSTRAINT marks_consolidated_nonnegative_check
  CHECK (consolidated_marks_obtained IS NULL OR consolidated_marks_obtained >= 0);
ALTER TABLE marks DROP CONSTRAINT IF EXISTS marks_participation_range_check;
ALTER TABLE marks ADD CONSTRAINT marks_participation_range_check
  CHECK (participation_marks IS NULL OR participation_marks BETWEEN 0 AND 10);
ALTER TABLE marks DROP CONSTRAINT IF EXISTS marks_written_work_range_check;
ALTER TABLE marks ADD CONSTRAINT marks_written_work_range_check
  CHECK (written_work_marks IS NULL OR written_work_marks BETWEEN 0 AND 10);
ALTER TABLE marks DROP CONSTRAINT IF EXISTS marks_project_work_range_check;
ALTER TABLE marks ADD CONSTRAINT marks_project_work_range_check
  CHECK (project_work_marks IS NULL OR project_work_marks BETWEEN 0 AND 10);
ALTER TABLE marks DROP CONSTRAINT IF EXISTS marks_slip_test_range_check;
ALTER TABLE marks ADD CONSTRAINT marks_slip_test_range_check
  CHECK (slip_test_marks IS NULL OR slip_test_marks BETWEEN 0 AND 20);

COMMENT ON COLUMN exam_subjects.assessment_schema IS
  'Active marks-entry schema: component or consolidated.';
COMMENT ON COLUMN exam_subjects.consolidated_max_marks IS
  'Maximum retained for consolidated marks while component schema is active.';
