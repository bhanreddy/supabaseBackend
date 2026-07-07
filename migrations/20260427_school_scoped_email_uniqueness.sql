-- School-scoped canonical email uniqueness.
--
-- Current SchoolIMS schema stores user/parent/staff emails in person_contacts,
-- not directly on users/parents/staff. The guarded table blocks below remove
-- legacy global email constraints if an older live database still has email
-- columns, while the active invariant is enforced on person_contacts.

ALTER TABLE IF EXISTS users DROP CONSTRAINT IF EXISTS users_email_key;
ALTER TABLE IF EXISTS parents DROP CONSTRAINT IF EXISTS parents_email_key;
ALTER TABLE IF EXISTS staff DROP CONSTRAINT IF EXISTS staff_email_key;

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT conrelid::regclass::text AS table_name, conname
    FROM pg_constraint
    WHERE contype = 'u'
      AND conrelid IN (
        SELECT oid FROM pg_class
        WHERE oid IN (to_regclass('users'), to_regclass('parents'), to_regclass('staff'))
      )
      AND pg_get_constraintdef(oid) ~* '^UNIQUE \(email\)$'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', rec.table_name, rec.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'email'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_school_email_unique;
    ALTER TABLE users ADD CONSTRAINT users_school_email_unique UNIQUE (school_id, email);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'parents'
      AND column_name = 'email'
  ) THEN
    ALTER TABLE parents DROP CONSTRAINT IF EXISTS parents_school_email_unique;
    ALTER TABLE parents ADD CONSTRAINT parents_school_email_unique UNIQUE (school_id, email);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'staff'
      AND column_name = 'email'
  ) THEN
    ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_school_email_unique;
    ALTER TABLE staff ADD CONSTRAINT staff_school_email_unique UNIQUE (school_id, email);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS person_contacts_school_email_unique
ON person_contacts (school_id, lower(contact_value))
WHERE contact_type = 'email'
  AND deleted_at IS NULL;

-- Verification:
-- SELECT conname, contype
-- FROM pg_constraint
-- WHERE conrelid = 'users'::regclass;
--
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE schemaname = 'public'
--   AND tablename = 'person_contacts'
--   AND indexname = 'person_contacts_school_email_unique';
