-- SuperAdmin first-admin seed created person + user + admin role without a
-- matching `staff` row. Manage Staff only lists from `staff`, so those admins
-- were invisible. Backfill staff rows (and an Administrator designation when
-- needed) for any admin user that still lacks one.

INSERT INTO staff_designations (school_id, name)
SELECT DISTINCT u.school_id, 'Administrator'
FROM users u
JOIN user_roles ur
  ON ur.user_id = u.id
 AND ur.school_id = u.school_id
 AND ur.deleted_at IS NULL
JOIN roles r
  ON r.id = ur.role_id
 AND r.code = 'admin'
 AND r.school_id = u.school_id
WHERE u.person_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM staff st
    WHERE st.person_id = u.person_id
      AND st.school_id = u.school_id
      AND st.deleted_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM staff_designations sd
    WHERE sd.school_id = u.school_id
      AND sd.name = 'Administrator'
  );

INSERT INTO staff (school_id, person_id, staff_code, joining_date, status_id, designation_id)
SELECT
  u.school_id,
  u.person_id,
  'ADM-' || UPPER(SUBSTRING(REPLACE(u.person_id::text, '-', ''), 1, 8)),
  CURRENT_DATE,
  1,
  COALESCE(
    (SELECT sd.id FROM staff_designations sd
     WHERE sd.school_id = u.school_id AND sd.name = 'Administrator' LIMIT 1),
    (SELECT sd.id FROM staff_designations sd
     WHERE sd.school_id = u.school_id AND sd.name = 'Principal' LIMIT 1),
    (SELECT sd.id FROM staff_designations sd
     WHERE sd.school_id = u.school_id ORDER BY sd.id LIMIT 1)
  )
FROM users u
JOIN user_roles ur
  ON ur.user_id = u.id
 AND ur.school_id = u.school_id
 AND ur.deleted_at IS NULL
JOIN roles r
  ON r.id = ur.role_id
 AND r.code = 'admin'
 AND r.school_id = u.school_id
WHERE u.person_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM staff st
    WHERE st.person_id = u.person_id
      AND st.school_id = u.school_id
      AND st.deleted_at IS NULL
  );
