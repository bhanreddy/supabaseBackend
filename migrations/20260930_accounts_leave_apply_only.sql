-- Accounts staff apply for their own leave. Approval stays with admin.

DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND rp.school_id = r.school_id
  AND r.code = 'accounts'
  AND p.code = 'leaves.approve';

INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT r.school_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.school_id = r.school_id AND p.code IN ('leaves.view', 'leaves.apply')
WHERE r.code = 'accounts'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions existing
    WHERE existing.role_id = r.id
      AND existing.permission_id = p.id
      AND existing.school_id = r.school_id
  );
