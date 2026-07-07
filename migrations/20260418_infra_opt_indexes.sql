-- Infrastructure optimization indexes (idempotent). See OPT-07 in infra pass.

-- OPT-01: Staff present today (school + date + status)
CREATE INDEX IF NOT EXISTS idx_staff_attendance_school_date_status
  ON staff_attendance (school_id, attendance_date, status)
  WHERE deleted_at IS NULL;

-- OPT-05: Attendance notification fan-out (student lookup via enrollment)
CREATE INDEX IF NOT EXISTS idx_student_enrollments_student_school
  ON student_enrollments (student_id, school_id)
  WHERE status = 'active' AND deleted_at IS NULL;

-- OPT-08: Fee remind parent lookup
CREATE INDEX IF NOT EXISTS idx_student_parents_student_school
  ON student_parents (student_id, school_id)
  WHERE deleted_at IS NULL;

-- OPT-09: Receipts list by school + issued_at
CREATE INDEX IF NOT EXISTS idx_receipts_school_issued_at
  ON receipts (school_id, issued_at DESC);

-- OPT-11: Kill switch config lookup
CREATE INDEX IF NOT EXISTS idx_notification_config_key
  ON notification_config (key);

-- OPT-17: Staff list by school + designation
CREATE INDEX IF NOT EXISTS idx_staff_school_designation
  ON staff (school_id, designation_id)
  WHERE deleted_at IS NULL;

-- Admin dashboard open complaints
CREATE INDEX IF NOT EXISTS idx_complaints_school_status
  ON complaints (school_id, status);
