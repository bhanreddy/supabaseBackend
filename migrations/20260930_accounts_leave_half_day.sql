-- Accounts department reviews the same leave applications staff already submit.
-- Half-day leave is a single-date request counted as 0.5 payroll days.

ALTER TABLE leave_applications
  ADD COLUMN IF NOT EXISTS half_day BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE leave_applications
  DROP CONSTRAINT IF EXISTS chk_leave_half_day_single_date;

ALTER TABLE leave_applications
  ADD CONSTRAINT chk_leave_half_day_single_date
  CHECK (half_day = false OR start_date = end_date);

INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT r.school_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.school_id = r.school_id AND p.code IN ('leaves.view', 'leaves.apply')
WHERE r.code = 'accounts'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = r.school_id
  );
