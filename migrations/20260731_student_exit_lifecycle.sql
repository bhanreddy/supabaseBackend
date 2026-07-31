-- Retain the exact academic year in which a student passed out or withdrew.
-- The student and all related academic/financial records remain soft-retained.
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS exit_academic_year_id UUID REFERENCES academic_years(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS exit_date DATE;

CREATE INDEX IF NOT EXISTS idx_students_exit_academic_year
  ON students (school_id, exit_academic_year_id)
  WHERE deleted_at IS NULL AND exit_academic_year_id IS NOT NULL;

-- Backfill terminal students from their most recent enrollment so existing
-- passed-out/withdrawn records immediately get the correct certificate year.
WITH latest_enrollment AS (
  SELECT DISTINCT ON (enrollment.school_id, enrollment.student_id)
    enrollment.school_id,
    enrollment.student_id,
    enrollment.academic_year_id,
    enrollment.end_date
  FROM student_enrollments enrollment
  JOIN academic_years academic_year ON academic_year.id = enrollment.academic_year_id
  WHERE enrollment.deleted_at IS NULL
  ORDER BY
    enrollment.school_id,
    enrollment.student_id,
    academic_year.start_date DESC,
    enrollment.start_date DESC,
    enrollment.created_at DESC
)
UPDATE students student
SET
  exit_academic_year_id = latest.academic_year_id,
  exit_date = COALESCE(latest.end_date, CURRENT_DATE)
FROM latest_enrollment latest
WHERE latest.student_id = student.id
  AND latest.school_id = student.school_id
  AND student.status_id IN (2, 3)
  AND student.deleted_at IS NULL
  AND student.exit_academic_year_id IS NULL;

-- Repair legacy terminal students whose enrollment or operational assignment
-- was left active by the old edit flow.
UPDATE student_enrollments enrollment
SET
  status = CASE WHEN student.status_id = 2 THEN 'completed'::enrollment_status_enum
                ELSE 'withdrawn'::enrollment_status_enum END,
  end_date = COALESCE(enrollment.end_date, student.exit_date, CURRENT_DATE),
  updated_at = NOW()
FROM students student
WHERE student.id = enrollment.student_id
  AND student.school_id = enrollment.school_id
  AND student.status_id IN (2, 3)
  AND student.deleted_at IS NULL
  AND enrollment.status = 'active'
  AND enrollment.deleted_at IS NULL;

UPDATE student_transport assignment
SET is_active = FALSE
FROM students student
WHERE student.id = assignment.student_id
  AND student.school_id = assignment.school_id
  AND student.status_id IN (2, 3)
  AND student.deleted_at IS NULL
  AND assignment.is_active = TRUE;

UPDATE hostel_allocations allocation
SET
  is_active = FALSE,
  vacated_at = COALESCE(allocation.vacated_at, student.exit_date, NOW())
FROM students student
WHERE student.id = allocation.student_id
  AND student.school_id = allocation.school_id
  AND student.status_id IN (2, 3)
  AND student.deleted_at IS NULL
  AND allocation.is_active = TRUE;
