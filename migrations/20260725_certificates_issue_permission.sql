-- Certificates for admin + accounts portals.
-- Creates school-scoped issued_certificates storage, serial allocator,
-- and certificates.issue permission (granted to admin, principal, accounts).

-- 1. issued_certificates (idempotent; matches hard-delete / backup scripts)
CREATE TABLE IF NOT EXISTS public.issued_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('TC', 'BONAFIDE')),
  serial_no TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data JSONB,
  issued_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_issued_certificates_school_serial UNIQUE (school_id, serial_no)
);

-- Harden older installs that may already have the table without school_id / constraints.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'issued_certificates'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'issued_certificates' AND column_name = 'school_id'
    ) THEN
      ALTER TABLE public.issued_certificates
        ADD COLUMN school_id INTEGER REFERENCES public.schools(id) ON DELETE CASCADE;
      UPDATE public.issued_certificates ic
      SET school_id = s.school_id
      FROM public.students s
      WHERE ic.student_id = s.id AND ic.school_id IS NULL;
      ALTER TABLE public.issued_certificates
        ALTER COLUMN school_id SET NOT NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'issued_certificates' AND column_name = 'issued_by'
    ) THEN
      ALTER TABLE public.issued_certificates
        ADD COLUMN issued_by UUID REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'issued_certificates' AND column_name = 'created_at'
    ) THEN
      ALTER TABLE public.issued_certificates
        ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_issued_certificates_school_id
  ON public.issued_certificates(school_id);
CREATE INDEX IF NOT EXISTS idx_issued_certificates_student_id
  ON public.issued_certificates(student_id);
CREATE INDEX IF NOT EXISTS idx_issued_certificates_issued_at
  ON public.issued_certificates(school_id, issued_at DESC);

-- 2. School-scoped serial allocator → e.g. TC/2026/042
CREATE OR REPLACE FUNCTION public.get_next_certificate_serial(
  p_school_id INTEGER,
  p_cert_type TEXT,
  p_cert_year INTEGER
) RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_type TEXT := upper(trim(p_cert_type));
  v_seq_name TEXT;
  v_n BIGINT;
BEGIN
  IF v_type NOT IN ('TC', 'BONAFIDE') THEN
    RAISE EXCEPTION 'Invalid certificate type: %', p_cert_type;
  END IF;
  IF p_cert_year IS NULL OR p_cert_year < 2000 OR p_cert_year > 2100 THEN
    RAISE EXCEPTION 'Invalid certificate year: %', p_cert_year;
  END IF;

  v_seq_name := lower(v_type) || '_cert_seq_school_' || p_school_id || '_' || p_cert_year;
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I START 1', v_seq_name);
  EXECUTE format('SELECT nextval(%L)', v_seq_name) INTO v_n;

  RETURN v_type || '/' || p_cert_year || '/' || lpad(v_n::text, 3, '0');
END;
$$;

-- Keep legacy RPC name working (maps to school 1) for any leftover direct clients.
CREATE OR REPLACE FUNCTION public.next_certificate_serial(cert_type TEXT, cert_year INTEGER)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN public.get_next_certificate_serial(1, cert_type, cert_year);
END;
$$;

-- 3. Permission seed for existing schools
INSERT INTO permissions (school_id, code, name)
SELECT s.id, 'certificates.issue', 'Issue Certificates'
FROM schools s
WHERE NOT EXISTS (
  SELECT 1 FROM permissions p
  WHERE p.school_id = s.id AND p.code = 'certificates.issue'
);

INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT r.school_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.school_id = r.school_id AND p.code = 'certificates.issue'
WHERE r.code IN ('admin', 'principal', 'accounts')
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = r.school_id
  );
