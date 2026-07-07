-- Payroll API routes require permission payroll.process; it was missing from RBAC seed.
-- Run once on existing databases (new schools get it via seed_school_defaults in schema.sql).

INSERT INTO permissions (school_id, code, name)
SELECT s.id, 'payroll.process', 'Process Payroll'
FROM schools s
WHERE NOT EXISTS (
  SELECT 1 FROM permissions p WHERE p.school_id = s.id AND p.code = 'payroll.process'
);

INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT r.school_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.school_id = r.school_id AND p.code = 'payroll.process'
WHERE r.code IN ('accounts', 'admin', 'principal')
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = r.school_id
  );
