-- Supporting indexes for student-scoped list queries (school_id + student_id / class context).
-- Safe to run multiple times (IF NOT EXISTS).

CREATE INDEX IF NOT EXISTS idx_student_fees_student_school_due
  ON student_fees (school_id, student_id, due_date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notices_school_audience_publish
  ON notices (school_id, audience, publish_at DESC);
