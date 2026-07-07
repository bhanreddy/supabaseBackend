-- Staff portal dashboard calls GET /leaves which requires leaves.view.
-- seed_school_defaults only granted leaves.apply to staff; add leaves.view for all schools.

INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT r.school_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.school_id = r.school_id AND p.code = 'leaves.view'
WHERE r.code = 'staff'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = r.school_id
  );
