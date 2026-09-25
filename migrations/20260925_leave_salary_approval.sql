-- Persist the salary treatment selected while an administrator reviews staff leave.
-- The requested leave type remains unchanged for audit purposes; payroll_treatment
-- is the authoritative input used by teacher-salary-v1.

ALTER TABLE leave_applications
  ADD COLUMN IF NOT EXISTS payroll_treatment TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_leave_payroll_treatment'
      AND conrelid = 'leave_applications'::regclass
  ) THEN
    ALTER TABLE leave_applications
      ADD CONSTRAINT chk_leave_payroll_treatment
      CHECK (payroll_treatment IS NULL OR payroll_treatment IN ('PAID_CL', 'PAID_LEAVE', 'UNPAID'));
  END IF;
END $$;

-- Preserve the behaviour of already-approved records while making their salary
-- treatment explicit. Rejected, cancelled, and pending requests stay undecided.
UPDATE leave_applications
SET payroll_treatment = CASE
  WHEN leave_type = 'casual' THEN 'PAID_CL'
  WHEN leave_type IN ('sick', 'earned', 'maternity', 'paternity') THEN 'PAID_LEAVE'
  ELSE 'UNPAID'
END
WHERE status = 'approved'
  AND payroll_treatment IS NULL;

CREATE INDEX IF NOT EXISTS idx_leave_payroll_cl_usage
  ON leave_applications (school_id, applicant_id, start_date, end_date)
  WHERE status = 'approved' AND payroll_treatment = 'PAID_CL';
