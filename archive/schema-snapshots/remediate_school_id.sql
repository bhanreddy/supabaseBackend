-- STANDALONE REMEDIATION SCRIPT: Fix school_id Type Mismatch (v3)
-- Target: Ensure school_id is INTEGER NOT NULL and constraints are correct

BEGIN;

-- 1. Ensure schools table exists in public schema
CREATE TABLE IF NOT EXISTS public.schools (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    primary_color VARCHAR(20),
    logo_url TEXT,
    website_url TEXT,
    address TEXT,
    contact_number VARCHAR(20),
    email VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    settings JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Ensure default school exists
INSERT INTO public.schools (id, name, slug) 
VALUES (1, 'Default School', 'default')
ON CONFLICT (id) DO NOTHING;

-- 2. Drop dependent views first to allow column type changes
DROP VIEW IF EXISTS active_students;
DROP VIEW IF EXISTS active_persons;

-- 3. Remediate school_id columns in all affected tables
DO $$
DECLARE
    t_name TEXT;
    v_constraint_name TEXT;
    v_data_type TEXT;
    tables_to_fix TEXT[] := ARRAY[
        'students', 'staff', 'events', 'notices', 'classes', 
        'complaints', 'daily_attendance', 'expenses', 
        'lms_courses', 'timetable_slots', 'school_settings',
        'academic_years'
    ];
BEGIN
    FOREACH t_name IN ARRAY tables_to_fix LOOP
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t_name AND table_schema = 'public') THEN
            
            RAISE NOTICE 'Processing table: %', t_name;

            -- Check if column exists
            SELECT udt_name INTO v_data_type 
            FROM information_schema.columns 
            WHERE table_name = t_name AND column_name = 'school_id' AND table_schema = 'public';

            IF v_data_type IS NULL THEN
                -- Column MISSING: Add it
                RAISE NOTICE '  - Column school_id is MISSING. Adding it.';
                EXECUTE format('ALTER TABLE %I ADD COLUMN school_id INTEGER NOT NULL DEFAULT 1', t_name);
                EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I_school_id_fkey FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE', t_name, t_name);
                EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(school_id)', 'idx_' || t_name || '_school_id', t_name);
            ELSIF v_data_type = 'uuid' THEN
                -- Column is UUID: Convert it
                RAISE NOTICE '  - Column school_id is UUID. Converting to INTEGER.';
                
                -- Drop constraints/indexes first
                FOR v_constraint_name IN 
                    SELECT constraint_name 
                    FROM information_schema.key_column_usage 
                    WHERE table_name = t_name AND column_name = 'school_id' AND table_schema = 'public'
                LOOP
                    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t_name, v_constraint_name);
                END LOOP;

                EXECUTE format('DROP INDEX IF EXISTS %I', 'idx_' || t_name || '_school_id');

                -- Convert
                EXECUTE format('ALTER TABLE %I ALTER COLUMN school_id TYPE INTEGER USING 1', t_name);
                EXECUTE format('ALTER TABLE %I ALTER COLUMN school_id SET DEFAULT 1', t_name);
                EXECUTE format('ALTER TABLE %I ALTER COLUMN school_id SET NOT NULL', t_name);
                
                -- Re-add FK
                EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I_school_id_fkey FOREIGN KEY (school_id) REFERENCES schools(id) ON DELETE CASCADE', t_name, t_name);
                EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(school_id)', 'idx_' || t_name || '_school_id', t_name);
            ELSE
                RAISE NOTICE '  - Column school_id is already % (OK)', v_data_type;
            END IF;

            -- Special Fix for school_settings: UNIQUE constraint must include school_id
            IF t_name = 'school_settings' THEN
                RAISE NOTICE '  - Fixing school_settings constraints';
                ALTER TABLE school_settings DROP CONSTRAINT IF EXISTS school_settings_key_key;
                -- The schema expects UNIQUE (school_id, key)
                -- We drop any old unique on just 'key' and add the composite one
                -- Check if it already exists
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'school_settings_school_id_key_key') THEN
                    ALTER TABLE school_settings ADD CONSTRAINT school_settings_school_id_key_key UNIQUE (school_id, key);
                END IF;
            END IF;

            RAISE NOTICE '✅ SUCCESS: Table % remediated', t_name;
        ELSE
            RAISE NOTICE '⏭️ SKIP: Table % not found', t_name;
        END IF;
    END LOOP;
END $$;

-- 4. Re-create views
CREATE OR REPLACE VIEW active_students AS
SELECT * FROM students WHERE deleted_at IS NULL AND status_id IN (SELECT id FROM student_statuses WHERE code = 'active');

CREATE OR REPLACE VIEW active_persons AS
SELECT * FROM persons WHERE deleted_at IS NULL;

-- 5. Ensure current_school_id() function exists
CREATE OR REPLACE FUNCTION public.current_school_id()
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN COALESCE(
    current_setting('app.current_school_id', true)::integer,
    1
  );
END;
$function$;

COMMIT;
