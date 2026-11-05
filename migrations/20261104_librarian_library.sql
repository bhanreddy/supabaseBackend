BEGIN;

-- Re-run for existing schools; new schools receive the same role through the trigger.
CREATE OR REPLACE FUNCTION public.seed_school_library_access(p_school_id integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO roles (school_id, code, name, is_system)
  SELECT p_school_id, 'librarian', 'Librarian', true
  WHERE NOT EXISTS (SELECT 1 FROM roles WHERE school_id = p_school_id AND code = 'librarian' AND deleted_at IS NULL);
  INSERT INTO permissions (school_id, code, name)
  SELECT p_school_id, v.code, v.name FROM (VALUES
    ('library.view', 'View Library'), ('library.manage', 'Manage Library'),
    ('complaints.view', 'View Complaints'), ('complaints.create', 'Create Complaints')
  ) v(code, name)
  WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.school_id = p_school_id AND p.code = v.code);
  INSERT INTO role_permissions (school_id, role_id, permission_id)
  SELECT r.school_id, r.id, p.id FROM roles r JOIN permissions p ON p.school_id = r.school_id
  WHERE r.school_id = p_school_id AND r.deleted_at IS NULL
    AND ((r.code = 'librarian' AND p.code IN ('library.view', 'library.manage', 'complaints.view', 'complaints.create'))
      OR (r.code IN ('admin', 'principal') AND p.code IN ('library.view', 'library.manage')))
    AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.school_id = r.school_id AND rp.role_id = r.id AND rp.permission_id = p.id);
END;
$$;
SELECT public.seed_school_library_access(id) FROM schools;
CREATE OR REPLACE FUNCTION public.seed_new_school_library_access()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.seed_school_library_access(NEW.id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_school_library_access ON schools;
DROP TRIGGER IF EXISTS zz_trg_school_library_access ON schools;
-- PostgreSQL runs same-event triggers alphabetically. Run after the existing
-- trg_school_seed_defaults so the new principal/admin roles receive access too.
CREATE TRIGGER zz_trg_school_library_access AFTER INSERT ON schools
FOR EACH ROW EXECUTE FUNCTION public.seed_new_school_library_access();

CREATE TABLE IF NOT EXISTS library_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id integer NOT NULL REFERENCES schools(id),
  title text NOT NULL, author text NOT NULL, isbn text, category text, publisher text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz, UNIQUE (school_id, id)
);
CREATE TABLE IF NOT EXISTS library_copies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer NOT NULL REFERENCES schools(id),
  book_id uuid NOT NULL, accession_no text NOT NULL, shelf text,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'loaned', 'lost', 'damaged', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, accession_no), UNIQUE (school_id, id),
  FOREIGN KEY (school_id, book_id) REFERENCES library_books(school_id, id)
);
CREATE TABLE IF NOT EXISTS library_settings (
  school_id integer PRIMARY KEY REFERENCES schools(id),
  loan_days integer NOT NULL DEFAULT 14 CHECK (loan_days BETWEEN 1 AND 365),
  max_loans integer NOT NULL DEFAULT 3 CHECK (max_loans BETWEEN 1 AND 100),
  max_renewals integer NOT NULL DEFAULT 2 CHECK (max_renewals BETWEEN 0 AND 20),
  fine_per_day numeric(10,2) NOT NULL DEFAULT 0 CHECK (fine_per_day BETWEEN 0 AND 10000)
);
CREATE TABLE IF NOT EXISTS library_loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer NOT NULL REFERENCES schools(id),
  copy_id uuid NOT NULL, borrower_person_id uuid NOT NULL REFERENCES persons(id),
  issued_at timestamptz NOT NULL DEFAULT now(), due_date date NOT NULL, returned_at timestamptz,
  return_condition text CHECK (return_condition IN ('available', 'lost', 'damaged')),
  renewal_count integer NOT NULL DEFAULT 0,
  fine_per_day numeric(10,2) NOT NULL DEFAULT 0,
  fine_amount numeric(10,2) NOT NULL DEFAULT 0 CHECK (fine_amount >= 0),
  fine_paid numeric(10,2) NOT NULL DEFAULT 0 CHECK (fine_paid >= 0 AND fine_paid <= fine_amount),
  issued_by uuid REFERENCES users(id), returned_by uuid REFERENCES users(id),
  FOREIGN KEY (school_id, copy_id) REFERENCES library_copies(school_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_library_active_copy ON library_loans(school_id, copy_id) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_library_borrower ON library_loans(school_id, borrower_person_id);
CREATE INDEX IF NOT EXISTS idx_library_due ON library_loans(school_id, due_date) WHERE returned_at IS NULL;
CREATE TABLE IF NOT EXISTS library_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer NOT NULL REFERENCES schools(id),
  book_id uuid NOT NULL, borrower_person_id uuid NOT NULL REFERENCES persons(id),
  created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
  FOREIGN KEY (school_id, book_id) REFERENCES library_books(school_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_library_reservation ON library_reservations(school_id, book_id, borrower_person_id) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS library_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer NOT NULL REFERENCES schools(id),
  actor_id uuid REFERENCES users(id), action text NOT NULL, details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Access is through the tenant-bound API, never through public Supabase clients.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['library_books','library_copies','library_settings','library_loans','library_reservations','library_activity'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE %I TO postgres, service_role', t);
    EXECUTE format('GRANT ALL ON TABLE %I TO %I', t, current_user);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.seed_school_library_access(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_new_school_library_access() FROM PUBLIC, anon, authenticated;
COMMIT;
