-- GET /leaves requires leaves.view for the staff portal.
-- Teachers currently use the combined staff role, but include the legacy
-- teacher role so schools carrying that role are repaired as well.

-- Repair permission catalog drift before assigning the permission.
INSERT INTO permissions (school_id, code, name)
SELECT s.id, 'leaves.view', 'View Leaves'
FROM schools s
WHERE NOT EXISTS (
  SELECT 1
  FROM permissions p
  WHERE p.school_id = s.id
    AND p.code = 'leaves.view'
);

INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT r.school_id, r.id, p.id
FROM roles r
JOIN permissions p
  ON p.school_id = r.school_id
 AND p.code = 'leaves.view'
WHERE r.code IN ('staff', 'teacher')
  AND NOT EXISTS (
    SELECT 1
    FROM role_permissions rp
    WHERE rp.school_id = r.school_id
      AND rp.role_id = r.id
      AND rp.permission_id = p.id
  );
