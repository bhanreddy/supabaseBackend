BEGIN;

-- Both portals use the existing leave API, which scopes non-approvers to
-- their own applications. Seed existing schools and future schools equally.
CREATE OR REPLACE FUNCTION public.seed_school_employee_leave_access(p_school_id integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO permissions (school_id, code, name)
  SELECT p_school_id, v.code, v.name
  FROM (VALUES ('leaves.view', 'View Leaves'), ('leaves.apply', 'Apply for Leave')) v(code, name)
  WHERE NOT EXISTS (
    SELECT 1 FROM permissions p WHERE p.school_id = p_school_id AND p.code = v.code
  );

  INSERT INTO role_permissions (school_id, role_id, permission_id)
  SELECT r.school_id, r.id, p.id
  FROM roles r JOIN permissions p ON p.school_id = r.school_id
  WHERE r.school_id = p_school_id AND r.deleted_at IS NULL
    AND r.code IN ('accounts', 'librarian')
    AND p.code IN ('leaves.view', 'leaves.apply')
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.school_id = r.school_id AND rp.role_id = r.id AND rp.permission_id = p.id
    );
END;
$$;

SELECT public.seed_school_employee_leave_access(id) FROM schools;

CREATE OR REPLACE FUNCTION public.seed_new_school_employee_leave_access()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.seed_school_employee_leave_access(NEW.id);
  RETURN NEW;
END;
$$;

-- Runs after default roles and zz_trg_school_library_access creates Librarian.
DROP TRIGGER IF EXISTS zzz_trg_school_employee_leave_access ON schools;
CREATE TRIGGER zzz_trg_school_employee_leave_access AFTER INSERT ON schools
FOR EACH ROW EXECUTE FUNCTION public.seed_new_school_employee_leave_access();

REVOKE ALL ON FUNCTION public.seed_school_employee_leave_access(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_new_school_employee_leave_access() FROM PUBLIC, anon, authenticated;

COMMIT;
