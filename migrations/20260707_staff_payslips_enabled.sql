-- Allow admins to hide payslips from the staff portal (default: visible).
ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS staff_payslips_enabled BOOLEAN NOT NULL DEFAULT true;
