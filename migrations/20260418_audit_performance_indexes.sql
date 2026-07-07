-- Audit performance indexes (idempotent). Requires pg_trgm for GIN indexes.

CREATE INDEX IF NOT EXISTS idx_fee_transactions_school_paid_at
  ON fee_transactions (school_id, paid_at DESC);

CREATE INDEX IF NOT EXISTS idx_bus_locations_bus_recorded
  ON bus_locations (bus_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_student_fees_school_status_due
  ON student_fees (school_id, status, due_date)
  WHERE deleted_at IS NULL;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_persons_display_name_trgm
  ON persons USING gin (display_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_students_admission_trgm
  ON students USING gin (admission_no gin_trgm_ops);
