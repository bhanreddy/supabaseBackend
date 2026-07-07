-- Admin toggle for allowing accounts users to create staff/admin/driver accounts.

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS accounts_staff_creation_enabled BOOLEAN NOT NULL DEFAULT true;
