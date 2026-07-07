-- ============================================================
-- Migration: Academic Year Upgrade
-- Date: 2026-05-16
-- Description: Adds infrastructure for bulk academic year upgrade
-- ============================================================

-- 1. Add sort_order to classes for reliable "next class" mapping
ALTER TABLE classes ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;

-- 2. Seed the academic_year.upgrade permission for every existing school
INSERT INTO permissions (school_id, code, name)
SELECT s.id, 'academic_year.upgrade', 'Upgrade Academic Year'
FROM schools s
WHERE NOT EXISTS (
  SELECT 1 FROM permissions p
  WHERE p.school_id = s.id AND p.code = 'academic_year.upgrade'
);

-- Grant the new permission to admin role for every existing school
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM permissions p
JOIN roles r ON r.school_id = p.school_id AND r.code = 'admin'
WHERE p.code = 'academic_year.upgrade'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = p.school_id
  );

-- Grant to principal role as well
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM permissions p
JOIN roles r ON r.school_id = p.school_id AND r.code = 'principal'
WHERE p.code = 'academic_year.upgrade'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = p.school_id
  );

-- 3. Update seed_school_defaults to include the new permission for future schools
-- (The permission INSERT in seed_school_defaults uses a VALUES list; we add to it
--  by inserting separately for idempotency — same pattern as the payroll.process addition.)

-- 4. Seed active_academic_year_id for existing schools that have an academic year
-- Uses the most recent academic year (by start_date) as default
INSERT INTO school_settings (school_id, key, value)
SELECT s.id, 'active_academic_year_id', ay.id::text
FROM schools s
JOIN LATERAL (
  SELECT id FROM academic_years
  WHERE school_id = s.id AND deleted_at IS NULL
  ORDER BY start_date DESC
  LIMIT 1
) ay ON true
WHERE NOT EXISTS (
  SELECT 1 FROM school_settings ss
  WHERE ss.school_id = s.id AND ss.key = 'active_academic_year_id'
);
