BEGIN;

CREATE TABLE IF NOT EXISTS public.student_login_qr_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id integer NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL,
  version smallint NOT NULL DEFAULT 1 CHECK (version = 1),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  generated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  CONSTRAINT student_login_qr_expiry_after_issue CHECK (expires_at > issued_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_student_login_qr_active
  ON public.student_login_qr_credentials (school_id, student_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_student_login_qr_user
  ON public.student_login_qr_credentials (school_id, user_id);
CREATE INDEX IF NOT EXISTS idx_student_login_qr_expiry
  ON public.student_login_qr_credentials (expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE public.student_login_qr_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_login_qr_credentials FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.student_login_qr_credentials FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.student_login_qr_credentials TO postgres;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.student_login_qr_credentials TO service_role;
  END IF;
  EXECUTE format(
    'GRANT ALL ON TABLE public.student_login_qr_credentials TO %I',
    current_user
  );
END $$;

-- Covers password/email changes through every Auth API, including recovery links
-- and the Supabase console. Password hashes never leave the auth schema.
-- Run as the privileged migration owner (not an end-user JWT).
CREATE OR REPLACE FUNCTION public.revoke_student_login_qr_on_auth_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.encrypted_password IS DISTINCT FROM OLD.encrypted_password
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.banned_until IS DISTINCT FROM OLD.banned_until THEN
    UPDATE public.student_login_qr_credentials SET revoked_at = now()
      WHERE user_id = NEW.id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_student_login_qr_on_auth_change() FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.revoke_student_login_qr_on_auth_change() TO postgres;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON FUNCTION public.revoke_student_login_qr_on_auth_change() TO service_role;
  END IF;
END $$;
DROP TRIGGER IF EXISTS revoke_student_login_qr_on_auth_change ON auth.users;
CREATE TRIGGER revoke_student_login_qr_on_auth_change
AFTER UPDATE OF encrypted_password, email, banned_until ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.revoke_student_login_qr_on_auth_change();

COMMIT;
