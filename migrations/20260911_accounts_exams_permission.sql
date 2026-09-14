-- Expose the admin exams screen in the accounts portal.
-- exams.view / exams.manage already exist; grant them to Accounts so the
-- shared exams APIs succeed for accountants.

INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT r.school_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.school_id = r.school_id AND p.code IN ('exams.view', 'exams.manage')
WHERE r.code = 'accounts'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = r.school_id
  );
