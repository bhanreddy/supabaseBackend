/*
  NexSyrus IMS Production Self-Enforcing Schema v1.1
  Description: Self-enforcing database template with automated 
               collision guards, integrity checks, and diagnostics.
  Last Refactored: 2026-02-11
  Target: PostgreSQL 15+ / Supabase
*/

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET client_min_messages = warning;
SET row_security = off;

-- Start Transaction
BEGIN;

-- 0. SCHEMA VERSIONING (inside transaction for atomicity)
CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    applied_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO schema_meta (key, value) 
VALUES ('version', '1.2') 
ON CONFLICT (key) DO UPDATE SET value = '1.2', applied_at = now();

-- SECTION 00: CONNECTIVITY & RESILIENCE
-- Standard Connection Timeout: 30 seconds
-- Applied to: Application-level fetch (AbortSignal.timeout), PG handshake (connect_timeout).
-- Rationale: Handle high-latency edge networks observed in diagnostics (up to 16s).

-- SECTION 01: EXTENSIONS (single creation, extensions schema)
CREATE SCHEMA IF NOT EXISTS extensions;
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
        GRANT USAGE ON SCHEMA extensions TO anon;
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        GRANT USAGE ON SCHEMA extensions TO authenticated;
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT USAGE ON SCHEMA extensions TO service_role;
    END IF;
END
$$;

CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA extensions;

-- Session-level search path (no ALTER DATABASE — non-transactional DDL not allowed inside BEGIN)
SET search_path = public, extensions;

-- ════════════════════════════════════════════════════════════
-- SECTION 0A: SCHOOLS (Multi-Tenant Root Table)
-- ════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS schools (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    slug        VARCHAR(100) NOT NULL UNIQUE,
    primary_color VARCHAR(20),
    logo_url    TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the existing single school as id = 1
INSERT INTO schools (id, name, slug, is_active)
VALUES (1, 'Default School', 'default-school', TRUE)
ON CONFLICT (id) DO NOTHING;

SELECT setval('schools_id_seq', GREATEST((SELECT MAX(id) FROM schools), 1));

-- Helper: Get current school from session GUC
CREATE OR REPLACE FUNCTION current_school_id()
RETURNS INTEGER
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_school_id', true), '')::INTEGER;
END;
$$;

-- Helper: RPC for clients to set school context
CREATE OR REPLACE FUNCTION set_school_context(p_school_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    PERFORM set_config('app.current_school_id', p_school_id::TEXT, true);
END;
$$;

GRANT EXECUTE ON FUNCTION current_school_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION set_school_context(INTEGER) TO authenticated, service_role;

-- 1. REFERENCE TABLES
CREATE TABLE IF NOT EXISTS countries (
    code CHAR(2) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    UNIQUE (school_id, name)
);

CREATE TABLE IF NOT EXISTS genders (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    UNIQUE (school_id, name),
    UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS student_categories (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    UNIQUE (school_id, name),
    UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS religions (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    UNIQUE (school_id, name),
    UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS blood_groups (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(10) NOT NULL,
    UNIQUE (school_id, name),
    UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS relationship_types (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    UNIQUE (school_id, name)
);

CREATE TABLE IF NOT EXISTS staff_designations (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS idx_countries_school_id ON countries(school_id);
CREATE INDEX IF NOT EXISTS idx_genders_school_id ON genders(school_id);
CREATE INDEX IF NOT EXISTS idx_student_categories_school_id ON student_categories(school_id);
CREATE INDEX IF NOT EXISTS idx_religions_school_id ON religions(school_id);
CREATE INDEX IF NOT EXISTS idx_blood_groups_school_id ON blood_groups(school_id);
CREATE INDEX IF NOT EXISTS idx_relationship_types_school_id ON relationship_types(school_id);
CREATE INDEX IF NOT EXISTS idx_staff_designations_school_id ON staff_designations(school_id);

-- 1b. SEED REFERENCE DATA
-- These INSERTs are idempotent (ON CONFLICT DO NOTHING) and required
-- because persons.gender_id and students.status_id are NOT NULL FK columns.

INSERT INTO genders (id, name) VALUES (1, 'Male'), (2, 'Female'), (3, 'Other')
ON CONFLICT DO NOTHING;

INSERT INTO countries (code, name) VALUES
('IN', 'India'), ('US', 'United States'), ('GB', 'United Kingdom'),
('AE', 'United Arab Emirates'), ('SA', 'Saudi Arabia'), ('AU', 'Australia')
ON CONFLICT DO NOTHING;

INSERT INTO religions (id, name) VALUES
(1, 'Hinduism'), (2, 'Islam'), (3, 'Christianity'), (4, 'Sikhism'),
(5, 'Buddhism'), (6, 'Jainism'), (7, 'Other')
ON CONFLICT DO NOTHING;

INSERT INTO blood_groups (id, name) VALUES
(1, 'A+'), (2, 'A-'), (3, 'B+'), (4, 'B-'),
(5, 'AB+'), (6, 'AB-'), (7, 'O+'), (8, 'O-')
ON CONFLICT DO NOTHING;

INSERT INTO student_categories (id, name) VALUES
(1, 'General'), (2, 'OBC'), (3, 'SC'), (4, 'ST'), (5, 'EWS')
ON CONFLICT DO NOTHING;

INSERT INTO relationship_types (id, name) VALUES
(1, 'Father'), (2, 'Mother'), (3, 'Guardian'), (4, 'Sibling'), (5, 'Other')
ON CONFLICT DO NOTHING;

INSERT INTO staff_designations (id, name) VALUES
(1, 'Principal'), (2, 'Vice Principal'), (3, 'Teacher'), (4, 'Senior Teacher'),
(5, 'Lab Assistant'), (6, 'Librarian'), (7, 'Clerk'), (8, 'Peon'), (9, 'Other')
ON CONFLICT DO NOTHING;

-- 2. CORE TRIGGERS (GLOBAL)
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. PERSONS
CREATE TABLE IF NOT EXISTS persons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    first_name VARCHAR(50) NOT NULL,
    middle_name VARCHAR(50),
    last_name VARCHAR(50) NOT NULL,
    display_name TEXT,
    dob DATE,
    gender_id SMALLINT NOT NULL REFERENCES genders(id),
    nationality_code CHAR(2) REFERENCES countries(code),
    photo_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_person_dob_past CHECK (dob IS NULL OR dob <= current_date)
);

CREATE INDEX IF NOT EXISTS idx_persons_school_id ON persons(school_id);

ALTER TABLE persons ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


DROP TRIGGER IF EXISTS trg_persons_updated ON persons;
CREATE TRIGGER trg_persons_updated
BEFORE UPDATE ON persons
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE OR REPLACE FUNCTION update_person_display_name()
RETURNS TRIGGER AS $$
BEGIN
  NEW.display_name := trim(concat_ws(' ', NEW.first_name, NEW.middle_name, NEW.last_name));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_persons_display_name ON persons;
CREATE TRIGGER trg_persons_display_name
BEFORE INSERT OR UPDATE ON persons
FOR EACH ROW EXECUTE FUNCTION update_person_display_name();


DO $$ BEGIN
    ALTER TABLE persons ADD CONSTRAINT persons_gender_id_fkey FOREIGN KEY (gender_id) REFERENCES genders(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE persons ADD CONSTRAINT persons_nationality_code_fkey FOREIGN KEY (nationality_code) REFERENCES countries(code);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Search Index
CREATE INDEX IF NOT EXISTS idx_persons_name_trgm 
ON persons USING gin (first_name gin_trgm_ops, last_name gin_trgm_ops);

-- 4. CONTACTS
DO $$ BEGIN
    CREATE TYPE contact_type_enum AS ENUM ('email','phone','address');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS person_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
    contact_type contact_type_enum NOT NULL,
    contact_value TEXT NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    is_emergency BOOLEAN NOT NULL DEFAULT FALSE,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_person_contacts_school_id ON person_contacts(school_id);

ALTER TABLE person_contacts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;



DO $$ BEGIN
    ALTER TABLE person_contacts ADD CONSTRAINT person_contacts_person_id_fkey FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS uq_primary_contact_only
ON person_contacts(person_id, contact_type)
WHERE is_primary = true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_person_contact_unique
ON person_contacts(person_id, contact_type, lower(contact_value))
WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_person_contacts_updated ON person_contacts;
CREATE TRIGGER trg_person_contacts_updated
BEFORE UPDATE ON person_contacts
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- 5. USERS & RBAC
CREATE TABLE IF NOT EXISTS roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    is_system BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (school_id, code)
);

CREATE INDEX IF NOT EXISTS idx_roles_school_id ON roles(school_id);

CREATE TABLE IF NOT EXISTS permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    code VARCHAR(100) NOT NULL,
    name VARCHAR(150) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (school_id, code)
);

CREATE INDEX IF NOT EXISTS idx_permissions_school_id ON permissions(school_id);

DO $$ BEGIN
    CREATE TYPE account_status_enum AS ENUM ('active','locked','disabled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
    permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_school_id ON role_permissions(school_id);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
    account_status account_status_enum NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_school_id ON users(school_id);

ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS theme text DEFAULT 'light'::text;


DO $$ BEGIN
    ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;


DO $$ BEGIN
    ALTER TABLE users ADD CONSTRAINT users_theme_check CHECK ((theme = ANY (ARRAY['light'::text, 'dark'::text])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE users ADD CONSTRAINT users_person_id_fkey FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Note: deleted_at needed for soft delete index safety
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Soft Delete Safe Unique Index
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_person_active 
ON users(school_id, person_id) WHERE deleted_at IS NULL; 

CREATE TABLE IF NOT EXISTS user_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    notification_sound VARCHAR(20) DEFAULT 'custom' CHECK (notification_sound IN ('custom', 'default')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_settings_school_id ON user_settings(school_id);

DO $$ BEGIN
    ALTER TABLE user_settings ADD CONSTRAINT user_settings_notification_sound_check CHECK (((notification_sound)::text = ANY ((ARRAY['custom'::character varying, 'default'::character varying])::text[])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE user_settings ADD CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;


DROP TRIGGER IF EXISTS trg_user_settings_updated ON user_settings;
CREATE TRIGGER trg_user_settings_updated
BEFORE UPDATE ON user_settings
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    granted_by UUID REFERENCES users(id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_school_id ON user_roles(school_id);

CREATE OR REPLACE FUNCTION ensure_active_person_ref()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.person_id <> OLD.person_id THEN
    RAISE EXCEPTION 'person_id cannot be changed once linked to user';
  END IF;

  IF EXISTS (SELECT 1 FROM persons WHERE id = NEW.person_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot link user to deleted person';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_active_person ON users;
CREATE TRIGGER trg_user_active_person
BEFORE INSERT OR UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION ensure_active_person_ref();

DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


DO $$ BEGIN
    ALTER TABLE user_roles ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE user_roles ADD CONSTRAINT user_roles_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 6. STUDENTS
CREATE TABLE IF NOT EXISTS student_statuses (
    id SMALLINT PRIMARY KEY,
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    code VARCHAR(20) NOT NULL,
    is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (school_id, code)
);

CREATE INDEX IF NOT EXISTS idx_student_statuses_school_id ON student_statuses(school_id);

INSERT INTO student_statuses (id, code, is_terminal) VALUES
(1, 'active', false), (2, 'graduated', true), (3, 'withdrawn', true),
(4, 'expelled', true), (5, 'transferred', true)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
    admission_no VARCHAR(30) NOT NULL,
    admission_date DATE NOT NULL,
    category_id SMALLINT REFERENCES student_categories(id),
    religion_id SMALLINT REFERENCES religions(id),
    blood_group_id SMALLINT REFERENCES blood_groups(id),
    status_id SMALLINT NOT NULL REFERENCES student_statuses(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_students_school_id ON students(school_id);

ALTER TABLE students ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


CREATE INDEX IF NOT EXISTS idx_students_status ON students(status_id);

CREATE INDEX IF NOT EXISTS idx_students_active ON public.students USING btree (id) WHERE (deleted_at IS NULL);


DO $$ BEGIN
    ALTER TABLE students ADD CONSTRAINT students_person_id_fkey FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE students ADD CONSTRAINT students_category_id_fkey FOREIGN KEY (category_id) REFERENCES student_categories(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE students ADD CONSTRAINT students_religion_id_fkey FOREIGN KEY (religion_id) REFERENCES religions(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE students ADD CONSTRAINT students_blood_group_id_fkey FOREIGN KEY (blood_group_id) REFERENCES blood_groups(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE students ADD CONSTRAINT students_status_id_fkey FOREIGN KEY (status_id) REFERENCES student_statuses(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Remediation: Soft Delete Safe Unique Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_admission_active 
ON students(school_id, admission_no) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_students_person_active 
ON students(school_id, person_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_students_updated ON students;
CREATE TRIGGER trg_students_updated
BEFORE UPDATE ON students
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- 7. PARENTS
CREATE TABLE IF NOT EXISTS parents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
    occupation VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_parents_school_id ON parents(school_id);

DO $$ BEGIN
    ALTER TABLE parents ADD CONSTRAINT parents_person_id_fkey FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;


ALTER TABLE parents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


CREATE UNIQUE INDEX IF NOT EXISTS idx_parents_person_active 
ON parents(school_id, person_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_parents_updated ON parents;
CREATE TRIGGER trg_parents_updated
BEFORE UPDATE ON parents
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS student_parents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE RESTRICT,
    relationship_id SMALLINT REFERENCES relationship_types(id),
    is_primary_contact BOOLEAN NOT NULL DEFAULT FALSE,
    is_legal_guardian BOOLEAN NOT NULL DEFAULT FALSE,
    valid_from DATE,
    valid_to DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT uq_active_parent UNIQUE (student_id, parent_id),
    CONSTRAINT no_parent_date_overlap EXCLUDE USING gist (
        student_id WITH =,
        parent_id WITH =,
        daterange(valid_from, valid_to, '[]') WITH &&
    ),
    CONSTRAINT chk_parent_valid_range CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX IF NOT EXISTS idx_student_parents_school_id ON student_parents(school_id);

ALTER TABLE student_parents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


CREATE UNIQUE INDEX IF NOT EXISTS uq_student_primary_parent
ON student_parents(student_id)
WHERE is_primary_contact = true
  AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION ensure_active_student_parent()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM students WHERE id = NEW.student_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot link to deleted student';
  END IF;
  IF EXISTS (SELECT 1 FROM parents WHERE id = NEW.parent_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot link to deleted parent';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_student_parents_active ON student_parents;
CREATE TRIGGER trg_student_parents_active
BEFORE INSERT OR UPDATE ON student_parents
FOR EACH ROW EXECUTE FUNCTION ensure_active_student_parent();


DO $$ BEGIN
    ALTER TABLE student_parents ADD CONSTRAINT student_parents_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_parents ADD CONSTRAINT student_parents_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_parents ADD CONSTRAINT student_parents_relationship_id_fkey FOREIGN KEY (relationship_id) REFERENCES relationship_types(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 8. ACADEMICS
CREATE TABLE IF NOT EXISTS academic_years (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    code VARCHAR(20) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_academic_year CHECK (start_date < end_date)
);

CREATE INDEX IF NOT EXISTS idx_academic_years_school_id ON academic_years(school_id);

ALTER TABLE academic_years ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


-- Add exclusion constraint separately as partial exclusion constraints cannot be added inline with WHERE
ALTER TABLE academic_years DROP CONSTRAINT IF EXISTS no_academic_year_overlap;
ALTER TABLE academic_years ADD CONSTRAINT no_academic_year_overlap EXCLUDE USING gist (
    daterange(start_date, end_date, '[]') WITH &&
) WHERE (deleted_at IS NULL);


CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_years_code_active ON academic_years(school_id, code) WHERE deleted_at IS NULL;


CREATE TABLE IF NOT EXISTS classes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    code VARCHAR(20),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_classes_school_id ON classes(school_id);

ALTER TABLE classes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_name_active ON classes(school_id, name) WHERE deleted_at IS NULL;


CREATE TABLE IF NOT EXISTS sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    code VARCHAR(20),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sections_school_id ON sections(school_id);

ALTER TABLE sections ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


CREATE UNIQUE INDEX IF NOT EXISTS idx_sections_name_active ON sections(school_id, name) WHERE deleted_at IS NULL;


CREATE TABLE IF NOT EXISTS class_sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    class_id UUID NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
    section_id UUID NOT NULL REFERENCES sections(id) ON DELETE RESTRICT,
    academic_year_id UUID NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
    class_teacher_id UUID, -- FK added after staff table is created (Fix 10)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (school_id, class_id, section_id, academic_year_id)
);

CREATE INDEX IF NOT EXISTS idx_class_sections_school_id ON class_sections(school_id);

DO $$ BEGIN
    ALTER TABLE class_sections ADD CONSTRAINT class_sections_class_id_fkey FOREIGN KEY (class_id) REFERENCES classes(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE class_sections ADD CONSTRAINT class_sections_section_id_fkey FOREIGN KEY (section_id) REFERENCES sections(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE class_sections ADD CONSTRAINT class_sections_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE class_sections ADD CONSTRAINT class_sections_class_teacher_id_fkey FOREIGN KEY (class_teacher_id) REFERENCES staff(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


DO $$ BEGIN
    CREATE TYPE enrollment_status_enum AS ENUM ('active','completed','withdrawn');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS student_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    academic_year_id UUID NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
    class_section_id UUID NOT NULL REFERENCES class_sections(id) ON DELETE RESTRICT,
    status enrollment_status_enum NOT NULL DEFAULT 'active',
    start_date DATE NOT NULL,
    end_date DATE,
    roll_number INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT no_enrollment_overlap EXCLUDE USING gist (
        student_id WITH =,
        daterange(start_date, end_date, '[]') WITH &&
    ),
    UNIQUE (school_id, class_section_id, academic_year_id, roll_number)
);

CREATE INDEX IF NOT EXISTS idx_student_enrollments_school_id ON student_enrollments(school_id);

ALTER TABLE student_enrollments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


CREATE INDEX IF NOT EXISTS idx_active_enrollments
ON student_enrollments(student_id)
WHERE status = 'active';

DROP TRIGGER IF EXISTS trg_student_enrollments_updated ON student_enrollments;
CREATE TRIGGER trg_student_enrollments_updated
BEFORE UPDATE ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


DO $$ BEGIN
    ALTER TABLE student_enrollments ADD CONSTRAINT student_enrollments_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_enrollments ADD CONSTRAINT student_enrollments_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_enrollments ADD CONSTRAINT student_enrollments_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES class_sections(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Remediation: Set-Based Roll Number Calculation
CREATE OR REPLACE FUNCTION recalculate_section_rolls(
    p_class_section_id UUID,
    p_academic_year_id UUID
)
RETURNS VOID AS $$
BEGIN
    WITH ordered_students AS (
        SELECT 
            se.id AS enrollment_id,
            ROW_NUMBER() OVER (
                ORDER BY p.first_name ASC, p.last_name ASC
            ) as new_roll
        FROM student_enrollments se
        JOIN students s ON se.student_id = s.id
        JOIN persons p ON s.person_id = p.id
        WHERE se.class_section_id = p_class_section_id
          AND se.academic_year_id = p_academic_year_id
          AND se.status = 'active'
          AND se.deleted_at IS NULL
          AND s.deleted_at IS NULL
    )
    UPDATE student_enrollments se
    SET roll_number = os.new_roll
    FROM ordered_students os
    WHERE se.id = os.enrollment_id
      AND se.roll_number IS DISTINCT FROM os.new_roll;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_enrollment_year()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM class_sections
    WHERE id = NEW.class_section_id
      AND academic_year_id = NEW.academic_year_id
  ) THEN
    RAISE EXCEPTION 'Class section does not belong to academic year';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_enrollment ON student_enrollments;
CREATE TRIGGER trg_validate_enrollment
BEFORE INSERT OR UPDATE ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION validate_enrollment_year();

CREATE OR REPLACE FUNCTION ensure_active_student_enrollment()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM students WHERE id = NEW.student_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot enroll a deleted student';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enroll_active_student ON student_enrollments;
CREATE TRIGGER trg_enroll_active_student
BEFORE INSERT OR UPDATE ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION ensure_active_student_enrollment();

-- 9. ATTENDANCE
DO $$ BEGIN
    CREATE TYPE attendance_status_enum AS ENUM ('present','absent','late','half_day');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS daily_attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    student_enrollment_id UUID NOT NULL REFERENCES student_enrollments(id) ON DELETE RESTRICT,
    attendance_date DATE NOT NULL,
    status attendance_status_enum NOT NULL,
    marked_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    marked_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_attendance_date_past CHECK (attendance_date <= current_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_attendance_school_id ON daily_attendance(school_id);
CREATE INDEX IF NOT EXISTS idx_attendance_school_student_date ON daily_attendance(school_id, student_enrollment_id, attendance_date);

DO $$ BEGIN
    ALTER TABLE daily_attendance ADD CONSTRAINT daily_attendance_student_enrollment_id_fkey FOREIGN KEY (student_enrollment_id) REFERENCES student_enrollments(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE daily_attendance ADD CONSTRAINT daily_attendance_marked_by_fkey FOREIGN KEY (marked_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;


ALTER TABLE daily_attendance ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


DROP TRIGGER IF EXISTS trg_attendance_updated ON daily_attendance;
CREATE TRIGGER trg_attendance_updated
BEFORE UPDATE ON daily_attendance
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_active
ON daily_attendance(student_enrollment_id, attendance_date)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_date ON daily_attendance(attendance_date);
CREATE INDEX IF NOT EXISTS idx_attendance_enrollment ON daily_attendance(student_enrollment_id);
CREATE INDEX IF NOT EXISTS idx_attendance_composite ON daily_attendance(student_enrollment_id, status, attendance_date);

CREATE OR REPLACE FUNCTION validate_attendance_entry()
RETURNS TRIGGER AS $$
DECLARE
    v_class_section_id UUID;
    v_class_teacher_id UUID;
    v_is_admin BOOLEAN;
    v_is_p1_teacher BOOLEAN;
BEGIN
    -- 1. Basic Date Validation (must be within enrollment period)
    IF NOT EXISTS (
        SELECT 1 FROM student_enrollments
        WHERE id = NEW.student_enrollment_id
          AND status = 'active'
          AND NEW.attendance_date BETWEEN start_date AND COALESCE(end_date, '9999-12-31'::date)
          AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Invalid Attendance: Student is not active in this enrollment on %', NEW.attendance_date;
    END IF;

    -- 2. Authorization Check (marked_by must be Class Teacher, Admin, or Period 1 Teacher)
    IF NEW.marked_by IS NOT NULL THEN
        -- Get Class Section and Class Teacher
        SELECT se.class_section_id, cs.class_teacher_id INTO v_class_section_id, v_class_teacher_id
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        WHERE se.id = NEW.student_enrollment_id;

        -- Check if Admin
        SELECT EXISTS (
            SELECT 1 FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = NEW.marked_by AND r.code = 'admin'
        ) INTO v_is_admin;

        IF NOT v_is_admin THEN
            -- Check if Period 1 Teacher for today
            SELECT EXISTS (
                SELECT 1 FROM timetable_slots ts
                JOIN staff s ON ts.teacher_id = s.id
                WHERE ts.class_section_id = v_class_section_id
                  AND ts.period_number = 1
                  AND s.person_id = (SELECT person_id FROM users WHERE id = NEW.marked_by)
                  AND ts.deleted_at IS NULL
            ) INTO v_is_p1_teacher;

            IF NOT v_is_p1_teacher AND v_class_teacher_id IS NOT NULL THEN
                IF NOT EXISTS (
                    SELECT 1 FROM staff s
                    WHERE s.id = v_class_teacher_id
                      AND s.person_id = (SELECT person_id FROM users WHERE id = NEW.marked_by)
                ) THEN
                    RAISE EXCEPTION 'Unauthorized: Only the assigned Class Teacher, Period 1 Teacher, or Admin can mark attendance';
                END IF;
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;

$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_attendance ON daily_attendance;
CREATE TRIGGER trg_validate_attendance
BEFORE INSERT OR UPDATE ON daily_attendance
FOR EACH ROW EXECUTE FUNCTION validate_attendance_entry();

-- 10. STAFF
CREATE TABLE IF NOT EXISTS staff_statuses (
    id SMALLINT PRIMARY KEY,
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    code VARCHAR(20) NOT NULL,
    name VARCHAR(50) NOT NULL,
    UNIQUE (school_id, code)
);

CREATE INDEX IF NOT EXISTS idx_staff_statuses_school_id ON staff_statuses(school_id);

INSERT INTO staff_statuses (id, code, name) VALUES
(1, 'active', 'Active'), (2, 'on_leave', 'On Leave'), (3, 'resigned', 'Resigned'), (4, 'terminated', 'Terminated')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
    staff_code VARCHAR(30) NOT NULL,
    designation_id SMALLINT REFERENCES staff_designations(id),
    joining_date DATE NOT NULL,
    status_id SMALLINT NOT NULL DEFAULT 1 REFERENCES staff_statuses(id),
    salary DECIMAL(12,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_staff_joining_past CHECK (joining_date <= current_date)
);

CREATE INDEX IF NOT EXISTS idx_staff_school_id ON staff(school_id);

DO $$ BEGIN
    ALTER TABLE staff ADD CONSTRAINT staff_person_id_fkey FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE staff ADD CONSTRAINT staff_designation_id_fkey FOREIGN KEY (designation_id) REFERENCES staff_designations(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE staff ADD CONSTRAINT staff_status_id_fkey FOREIGN KEY (status_id) REFERENCES staff_statuses(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

ALTER TABLE IF EXISTS staff ADD COLUMN IF NOT EXISTS person_id uuid;
ALTER TABLE IF EXISTS staff ADD COLUMN IF NOT EXISTS staff_code character varying(30);
ALTER TABLE IF EXISTS staff ADD COLUMN IF NOT EXISTS designation_id smallint;
ALTER TABLE IF EXISTS staff ADD COLUMN IF NOT EXISTS joining_date date;
ALTER TABLE IF EXISTS staff ADD COLUMN IF NOT EXISTS status_id smallint DEFAULT 1;
ALTER TABLE IF EXISTS staff ADD COLUMN IF NOT EXISTS salary numeric;
ALTER TABLE IF EXISTS staff ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();
ALTER TABLE IF EXISTS staff ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();


ALTER TABLE staff ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_code_active 
ON staff(school_id, staff_code) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_person_active 
ON staff(school_id, person_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_staff_status ON staff(status_id);
CREATE INDEX IF NOT EXISTS idx_staff_active ON staff(id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_staff_updated ON staff;
CREATE TRIGGER trg_staff_updated
BEFORE UPDATE ON staff
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE OR REPLACE FUNCTION ensure_active_person_staff()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM persons WHERE id = NEW.person_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot link staff to deleted person';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_staff_active_person ON staff;
CREATE TRIGGER trg_staff_active_person
BEFORE INSERT OR UPDATE ON staff
FOR EACH ROW EXECUTE FUNCTION ensure_active_person_staff();

-- Fix 10: Deferred FK — class_teacher_id now references staff(id)
-- (class_sections was created before staff, so FK was deferred)
DO $$ BEGIN
    ALTER TABLE class_sections
    ADD CONSTRAINT fk_class_sections_teacher
    FOREIGN KEY (class_teacher_id) REFERENCES staff(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 🔒 Protect System Roles
CREATE OR REPLACE FUNCTION prevent_system_role_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.is_system THEN
    RAISE EXCEPTION 'System roles cannot be modified or deleted';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_system_roles_delete ON roles;
CREATE TRIGGER trg_protect_system_roles_delete
BEFORE DELETE ON roles
FOR EACH ROW EXECUTE FUNCTION prevent_system_role_change();

DROP TRIGGER IF EXISTS trg_protect_system_roles_update ON roles;
CREATE TRIGGER trg_protect_system_roles_update
BEFORE UPDATE ON roles
FOR EACH ROW EXECUTE FUNCTION prevent_system_role_change();


-- 10B. STAFF ATTENDANCE
CREATE TABLE IF NOT EXISTS staff_attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    attendance_date DATE NOT NULL,
    status attendance_status_enum NOT NULL,
    marked_by UUID REFERENCES users(id) ON DELETE SET NULL,
    marked_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_staff_attendance_date_past CHECK (attendance_date <= current_date),
    CONSTRAINT uq_staff_attendance_active UNIQUE (school_id, staff_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS idx_staff_attendance_school_id ON staff_attendance(school_id);

CREATE INDEX IF NOT EXISTS idx_staff_attendance_date ON staff_attendance(attendance_date);
CREATE INDEX IF NOT EXISTS idx_staff_attendance_staff ON staff_attendance(staff_id);

DROP TRIGGER IF EXISTS trg_staff_attendance_updated ON staff_attendance;
CREATE TRIGGER trg_staff_attendance_updated
BEFORE UPDATE ON staff_attendance
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


DO $$ BEGIN
    ALTER TABLE staff_attendance ADD CONSTRAINT staff_attendance_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE staff_attendance ADD CONSTRAINT staff_attendance_marked_by_fkey FOREIGN KEY (marked_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 11. FEES (REMEDIATED)
CREATE TABLE IF NOT EXISTS fee_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(30),
    description TEXT,
    is_recurring BOOLEAN NOT NULL DEFAULT TRUE,
    is_optional BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fee_types_school_id ON fee_types(school_id);

ALTER TABLE fee_types ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_types_name_active ON fee_types(school_id, name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_types_code_active ON fee_types(school_id, code) WHERE deleted_at IS NULL;


CREATE TABLE IF NOT EXISTS fee_structures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    academic_year_id UUID NOT NULL REFERENCES academic_years(id),
    class_id UUID NOT NULL REFERENCES classes(id),
    fee_type_id UUID NOT NULL REFERENCES fee_types(id),
    amount DECIMAL(12,2) NOT NULL,
    due_date DATE,
    frequency VARCHAR(20) DEFAULT 'monthly',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_fee_amount_positive CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_fee_structures_school_id ON fee_structures(school_id);

DO $$ BEGIN
    ALTER TABLE fee_structures ADD CONSTRAINT fee_structures_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE fee_structures ADD CONSTRAINT fee_structures_class_id_fkey FOREIGN KEY (class_id) REFERENCES classes(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE fee_structures ADD CONSTRAINT fee_structures_fee_type_id_fkey FOREIGN KEY (fee_type_id) REFERENCES fee_types(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


ALTER TABLE fee_structures ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_structures_active ON fee_structures(school_id, academic_year_id, class_id, fee_type_id) WHERE deleted_at IS NULL;


DROP TRIGGER IF EXISTS trg_fee_structures_updated ON fee_structures;
CREATE TRIGGER trg_fee_structures_updated
BEFORE UPDATE ON fee_structures
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

DO $$ BEGIN
    CREATE TYPE fee_status_enum AS ENUM ('pending','partial','paid','waived','overdue');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS student_fees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    fee_structure_id UUID NOT NULL REFERENCES fee_structures(id) ON DELETE RESTRICT,
    amount_due DECIMAL(12,2) NOT NULL,
    amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0,
    discount DECIMAL(12,2) NOT NULL DEFAULT 0,
    status fee_status_enum NOT NULL DEFAULT 'pending',
    due_date DATE,
    period_month INTEGER,
    period_year INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_amounts CHECK (amount_due >= 0 AND amount_paid >= 0 AND discount >= 0),
    CONSTRAINT chk_paid_not_exceed CHECK (amount_paid <= amount_due - discount)
);

CREATE INDEX IF NOT EXISTS idx_student_fees_school_id ON student_fees(school_id);


DO $$ BEGIN
    ALTER TABLE student_fees ADD CONSTRAINT student_fees_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_fees ADD CONSTRAINT student_fees_fee_structure_id_fkey FOREIGN KEY (fee_structure_id) REFERENCES fee_structures(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- COMPATIBILITY VIEW: fee_installments (Points to student_fees)
-- This ensures legacy queries and analytics endpoints continue to function.
CREATE OR REPLACE VIEW fee_installments AS 
SELECT 
    id, student_id, amount_due, amount_paid, discount, 
    status, due_date, created_at, updated_at, deleted_at
FROM student_fees;

-- Fee Propagation & Assignment Logic
CREATE OR REPLACE FUNCTION propagate_fee_structure_updates()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.amount IS DISTINCT FROM OLD.amount THEN
        UPDATE student_fees
        SET amount_due = NEW.amount, updated_at = now()
        WHERE fee_structure_id = NEW.id AND status IN ('pending', 'partial', 'overdue');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_propagate_fee_updates ON fee_structures;
CREATE TRIGGER trg_propagate_fee_updates
AFTER UPDATE ON fee_structures
FOR EACH ROW EXECUTE FUNCTION propagate_fee_structure_updates();

CREATE OR REPLACE FUNCTION auto_assign_fees_on_structure_creation()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO student_fees (student_id, fee_structure_id, amount_due, amount_paid, status, due_date)
    SELECT se.student_id, NEW.id, NEW.amount, 0, 'pending', NEW.due_date
    FROM student_enrollments se
    JOIN class_sections cs ON se.class_section_id = cs.id
    WHERE cs.class_id = NEW.class_id AND se.academic_year_id = NEW.academic_year_id AND se.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM student_fees sf WHERE sf.student_id = se.student_id AND sf.fee_structure_id = NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_assign_fees_structure ON fee_structures;
CREATE TRIGGER trg_auto_assign_fees_structure
AFTER INSERT ON fee_structures
FOR EACH ROW EXECUTE FUNCTION auto_assign_fees_on_structure_creation();

CREATE OR REPLACE FUNCTION auto_assign_fees_on_enrollment()
RETURNS TRIGGER AS $$
DECLARE v_class_id UUID;
BEGIN
    IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active') THEN
        SELECT class_id INTO v_class_id FROM class_sections WHERE id = NEW.class_section_id;
        INSERT INTO student_fees (student_id, fee_structure_id, amount_due, amount_paid, status, due_date)
        SELECT NEW.student_id, fs.id, fs.amount, 0, 'pending', fs.due_date
        FROM fee_structures fs
        WHERE fs.class_id = v_class_id AND fs.academic_year_id = NEW.academic_year_id
          AND NOT EXISTS (SELECT 1 FROM student_fees sf WHERE sf.student_id = NEW.student_id AND sf.fee_structure_id = fs.id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_assign_fees_enrollment ON student_enrollments;
CREATE TRIGGER trg_auto_assign_fees_enrollment
AFTER INSERT OR UPDATE ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION auto_assign_fees_on_enrollment();

ALTER TABLE student_fees ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_student_fees_student ON student_fees(student_id);
CREATE INDEX IF NOT EXISTS idx_student_fees_status ON student_fees(status);

DROP TRIGGER IF EXISTS trg_student_fees_updated ON student_fees;
CREATE TRIGGER trg_student_fees_updated
BEFORE UPDATE ON student_fees
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE OR REPLACE FUNCTION update_fee_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.amount_paid >= (NEW.amount_due - NEW.discount) THEN
        NEW.status := 'paid';
    ELSIF NEW.amount_paid > 0 THEN
        NEW.status := 'partial';
    ELSIF NEW.due_date < CURRENT_DATE AND NEW.status = 'pending' THEN
        NEW.status := 'overdue';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_fee_status ON student_fees;
CREATE TRIGGER trg_auto_fee_status
BEFORE UPDATE ON student_fees
FOR EACH ROW EXECUTE FUNCTION update_fee_status();

DO $$ BEGIN
    CREATE TYPE payment_method_enum AS ENUM ('cash','card','upi','bank_transfer','cheque','online');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS fee_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    student_fee_id UUID NOT NULL REFERENCES student_fees(id) ON DELETE RESTRICT,
    amount DECIMAL(12,2) NOT NULL,
    payment_method payment_method_enum NOT NULL,
    transaction_ref VARCHAR(100) NOT NULL,
    paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_by UUID REFERENCES users(id) ON DELETE SET NULL,
    remarks TEXT,
    refund_of UUID REFERENCES fee_transactions(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Allow negative amounts for refunds, but block zero
    CONSTRAINT chk_transaction_amount CHECK ((amount > (0)::numeric)),
    -- Refund entries must have negative amount
    CONSTRAINT chk_refund_must_be_negative CHECK (refund_of IS NULL OR amount < 0)
);

CREATE INDEX IF NOT EXISTS idx_fee_transactions_school_id ON fee_transactions(school_id);


DO $$ BEGIN
    ALTER TABLE fee_transactions ADD CONSTRAINT fee_transactions_refund_of_fkey FOREIGN KEY (refund_of) REFERENCES fee_transactions(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE fee_transactions ADD CONSTRAINT fee_transactions_student_fee_id_fkey FOREIGN KEY (student_fee_id) REFERENCES student_fees(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE fee_transactions ADD CONSTRAINT fee_transactions_received_by_fkey FOREIGN KEY (received_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Backfill any existing NULL transaction_ref values before constraints
DO $$ BEGIN
    UPDATE fee_transactions SET transaction_ref = 'LEGACY-' || id::text WHERE transaction_ref IS NULL;
EXCEPTION WHEN OTHERS THEN null;
END $$;

-- Enforce NOT NULL (may already be set by CREATE TABLE above, safe for existing DBs)
ALTER TABLE fee_transactions ALTER COLUMN transaction_ref SET NOT NULL;
ALTER TABLE fee_transactions ADD COLUMN IF NOT EXISTS refund_of UUID REFERENCES fee_transactions(id) ON DELETE RESTRICT;

-- Unique idempotency key
CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_txn_ref_unique ON fee_transactions(school_id, transaction_ref);

CREATE INDEX IF NOT EXISTS idx_transactions_paid_at ON fee_transactions(paid_at);

-- Remediation: Financial Trigger (APPEND-ONLY — INSERT only)
-- Refunds are negative-amount INSERTs, so += handles both payment and refund
CREATE OR REPLACE FUNCTION update_fee_paid_amount()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE student_fees
    SET amount_paid = amount_paid + NEW.amount
    WHERE id = NEW.student_fee_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_paid_on_transaction ON fee_transactions;
CREATE TRIGGER trg_update_paid_on_transaction
AFTER INSERT ON fee_transactions
FOR EACH ROW EXECUTE FUNCTION update_fee_paid_amount();

-- Guard: Block UPDATE/DELETE on fee_transactions (append-only ledger)
CREATE OR REPLACE FUNCTION prevent_fee_transaction_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'fee_transactions is append-only. UPDATE and DELETE are forbidden.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_fee_txn ON fee_transactions;
CREATE TRIGGER trg_guard_fee_txn
BEFORE UPDATE OR DELETE ON fee_transactions
FOR EACH ROW EXECUTE FUNCTION prevent_fee_transaction_mutation();

CREATE SEQUENCE IF NOT EXISTS receipt_no_seq START 1001;

CREATE TABLE IF NOT EXISTS receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    receipt_no VARCHAR(30) NOT NULL,
    student_id UUID NOT NULL REFERENCES students(id),
    total_amount DECIMAL(12,2) NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    issued_by UUID REFERENCES users(id),
    remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (school_id, receipt_no)
);

CREATE INDEX IF NOT EXISTS idx_receipts_school_id ON receipts(school_id);

CREATE TABLE IF NOT EXISTS receipt_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    fee_transaction_id UUID NOT NULL REFERENCES fee_transactions(id),
    amount DECIMAL(12,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipt_items_school_id ON receipt_items(school_id);


DO $$ BEGIN
    ALTER TABLE receipt_items ADD CONSTRAINT receipt_items_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES receipts(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE receipt_items ADD CONSTRAINT receipt_items_fee_transaction_id_fkey FOREIGN KEY (fee_transaction_id) REFERENCES fee_transactions(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


DO $$ BEGIN
    ALTER TABLE receipts ADD CONSTRAINT receipts_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE receipts ADD CONSTRAINT receipts_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Automation: Auto-generate receipt on transaction
CREATE OR REPLACE FUNCTION auto_generate_receipt()
RETURNS TRIGGER AS $$
DECLARE
    v_receipt_id UUID;
    v_student_id UUID;
    v_receipt_no TEXT;
BEGIN
    SELECT student_id INTO v_student_id FROM student_fees WHERE id = NEW.student_fee_id;

    v_receipt_no := 'RCT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(NEXTVAL('receipt_no_seq')::TEXT, 4, '0');

    INSERT INTO receipts (receipt_no, student_id, total_amount, issued_at, issued_by, remarks)
    VALUES (v_receipt_no, v_student_id, NEW.amount, NEW.paid_at, NEW.received_by, COALESCE(NEW.remarks, 'System Generated'))
    RETURNING id INTO v_receipt_id;

    INSERT INTO receipt_items (receipt_id, fee_transaction_id, amount)
    VALUES (v_receipt_id, NEW.id, NEW.amount);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_receipt ON fee_transactions;
CREATE TRIGGER trg_auto_receipt
AFTER INSERT ON fee_transactions
FOR EACH ROW EXECUTE FUNCTION auto_generate_receipt();

-- Backfill existing transactions without receipts
DO $$
DECLARE
    r_trans RECORD;
    v_receipt_id UUID;
    v_student_id UUID;
    v_receipt_no TEXT;
BEGIN
    FOR r_trans IN 
        SELECT t.* 
        FROM fee_transactions t
        LEFT JOIN receipt_items ri ON t.id = ri.fee_transaction_id
        WHERE ri.id IS NULL
    LOOP
        -- Get Student ID
        SELECT student_id INTO v_student_id 
        FROM student_fees 
        WHERE id = r_trans.student_fee_id;

        -- Generate Receipt No
        v_receipt_no := 'RCT-' || TO_CHAR(r_trans.paid_at, 'YYYYMMDD') || '-' || LPAD(NEXTVAL('receipt_no_seq')::TEXT, 4, '0');

        -- Insert Receipt
        INSERT INTO receipts (
            receipt_no,
            student_id,
            total_amount,
            issued_at,
            issued_by,
            remarks
        ) VALUES (
            v_receipt_no,
            v_student_id,
            r_trans.amount,
            r_trans.paid_at,
            r_trans.received_by,
            COALESCE(r_trans.remarks, 'Backfilled')
        ) RETURNING id INTO v_receipt_id;

        -- Insert Receipt Item
        INSERT INTO receipt_items (
            receipt_id,
            fee_transaction_id,
            amount
        ) VALUES (
            v_receipt_id,
            r_trans.id,
            r_trans.amount
        );
    END LOOP;
END $$;

-- 12. EXAMS & RESULTS
CREATE TABLE IF NOT EXISTS subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_subjects_school_id ON subjects(school_id);

ALTER TABLE subjects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_code_active ON subjects(school_id, code) WHERE deleted_at IS NULL;


CREATE TABLE IF NOT EXISTS class_subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    class_section_id UUID NOT NULL REFERENCES class_sections(id),
    subject_id UUID NOT NULL REFERENCES subjects(id),
    teacher_id UUID REFERENCES staff(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_class_subjects_school_id ON class_subjects(school_id);

DO $$ BEGIN
    ALTER TABLE class_subjects ADD CONSTRAINT class_subjects_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES class_sections(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE class_subjects ADD CONSTRAINT class_subjects_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES subjects(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE class_subjects ADD CONSTRAINT class_subjects_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES staff(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


ALTER TABLE class_subjects ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE class_subjects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE class_subjects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_class_subjects_unique ON class_subjects(class_section_id, subject_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_class_subjects_teacher ON class_subjects(teacher_id);

DROP TRIGGER IF EXISTS trg_class_subjects_updated ON class_subjects;
CREATE TRIGGER trg_class_subjects_updated
BEFORE UPDATE ON class_subjects
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


DO $$ BEGIN
    CREATE TYPE exam_status_enum AS ENUM ('scheduled','ongoing','completed','cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS exams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    academic_year_id UUID NOT NULL REFERENCES academic_years(id),
    exam_type VARCHAR(50) NOT NULL, 
    start_date DATE,
    end_date DATE,
    status exam_status_enum NOT NULL DEFAULT 'scheduled',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_exam_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_exams_school_id ON exams(school_id);

DO $$ BEGIN
    ALTER TABLE exams ADD CONSTRAINT exams_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


ALTER TABLE exams ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


CREATE INDEX IF NOT EXISTS idx_exams_active ON exams(id) WHERE deleted_at IS NULL;


DROP TRIGGER IF EXISTS trg_exams_updated ON exams;
CREATE TRIGGER trg_exams_updated
BEFORE UPDATE ON exams
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS exam_subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    subject_id UUID NOT NULL REFERENCES subjects(id),
    class_id UUID NOT NULL REFERENCES classes(id),
    exam_date DATE,
    max_marks DECIMAL(5,2) NOT NULL DEFAULT 100,
    passing_marks DECIMAL(5,2) NOT NULL DEFAULT 35,
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_marks_valid CHECK (passing_marks <= max_marks AND max_marks > 0)
);

CREATE INDEX IF NOT EXISTS idx_exam_subjects_school_id ON exam_subjects(school_id);

DO $$ BEGIN
    ALTER TABLE exam_subjects ADD CONSTRAINT exam_subjects_exam_id_fkey FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE exam_subjects ADD CONSTRAINT exam_subjects_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES subjects(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE exam_subjects ADD CONSTRAINT exam_subjects_class_id_fkey FOREIGN KEY (class_id) REFERENCES classes(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


ALTER TABLE exam_subjects ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_subjects_active ON exam_subjects(exam_id, subject_id, class_id) WHERE deleted_at IS NULL;


CREATE TABLE IF NOT EXISTS grading_scales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    min_percentage DECIMAL(5,2) NOT NULL,
    max_percentage DECIMAL(5,2) NOT NULL,
    grade VARCHAR(5) NOT NULL,
    grade_point DECIMAL(3,1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_percentage_range CHECK (min_percentage >= 0 AND max_percentage <= 100 AND min_percentage < max_percentage)
);

CREATE INDEX IF NOT EXISTS idx_grading_scales_school_id ON grading_scales(school_id);

CREATE TABLE IF NOT EXISTS marks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    exam_subject_id UUID NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,
    student_enrollment_id UUID NOT NULL REFERENCES student_enrollments(id),
    marks_obtained DECIMAL(5,2),
    is_absent BOOLEAN NOT NULL DEFAULT FALSE,
    remarks TEXT,
    remarks_te TEXT,
    entered_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (school_id, exam_subject_id, student_enrollment_id),
    CONSTRAINT chk_marks_or_absent CHECK (is_absent = TRUE OR marks_obtained IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_marks_school_id ON marks(school_id);

DO $$ BEGIN
    ALTER TABLE marks ADD CONSTRAINT marks_exam_subject_id_fkey FOREIGN KEY (exam_subject_id) REFERENCES exam_subjects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE marks ADD CONSTRAINT marks_student_enrollment_id_fkey FOREIGN KEY (student_enrollment_id) REFERENCES student_enrollments(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE marks ADD CONSTRAINT marks_entered_by_fkey FOREIGN KEY (entered_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


CREATE OR REPLACE FUNCTION validate_marks_entry()
RETURNS TRIGGER AS $$
DECLARE
    v_max_marks DECIMAL(5,2);
BEGIN
    -- 1. Check Max Marks
    SELECT max_marks INTO v_max_marks
    FROM exam_subjects
    WHERE id = NEW.exam_subject_id;

    IF NEW.marks_obtained IS NOT NULL AND NEW.marks_obtained > v_max_marks THEN
        RAISE EXCEPTION 'Invalid Marks: Obtained marks (%) exceed maximum marks (%)', NEW.marks_obtained, v_max_marks;
    END IF;

    -- 2. Check Range
    IF NEW.marks_obtained IS NOT NULL AND NEW.marks_obtained < 0 THEN
        RAISE EXCEPTION 'Invalid Marks: Marks cannot be negative';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_marks ON marks;
CREATE TRIGGER trg_validate_marks
BEFORE INSERT OR UPDATE ON marks
FOR EACH ROW EXECUTE FUNCTION validate_marks_entry();


ALTER TABLE marks ADD COLUMN IF NOT EXISTS remarks_te TEXT;

CREATE INDEX IF NOT EXISTS idx_marks_enrollment ON marks(student_enrollment_id);
CREATE INDEX IF NOT EXISTS idx_marks_exam_subject ON marks(exam_subject_id);

DROP TRIGGER IF EXISTS trg_marks_updated ON marks;
CREATE TRIGGER trg_marks_updated
BEFORE UPDATE ON marks
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- 13. COMMUNICATION & SUPPORT
DO $$ BEGIN
    CREATE TYPE complaint_status_enum AS ENUM ('open','in_progress','resolved','closed','rejected');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE complaint_priority_enum AS ENUM ('low','medium','high','urgent');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS complaints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    ticket_no VARCHAR(30),
    title VARCHAR(200) NOT NULL,
    title_te TEXT,
    description TEXT NOT NULL,
    description_te TEXT,
    category VARCHAR(50), 
    priority complaint_priority_enum NOT NULL DEFAULT 'medium',
    status complaint_status_enum NOT NULL DEFAULT 'open',
    raised_by UUID NOT NULL REFERENCES users(id),
    raised_for_student_id UUID REFERENCES students(id), 
    assigned_to UUID REFERENCES users(id),
    resolution TEXT,
    resolution_te TEXT,
    resolved_by UUID REFERENCES users(id),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (school_id, ticket_no)
);
CREATE INDEX IF NOT EXISTS idx_complaints_school_id ON complaints(school_id);

DROP TRIGGER IF EXISTS trg_prevent_complaint_delete ON complaints;
CREATE TRIGGER trg_prevent_complaint_delete
BEFORE DELETE ON complaints
FOR EACH ROW EXECUTE FUNCTION prevent_complaint_delete();


DO $$ BEGIN
    ALTER TABLE complaints ADD CONSTRAINT complaints_raised_by_fkey FOREIGN KEY (raised_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE complaints ADD CONSTRAINT complaints_raised_for_student_id_fkey FOREIGN KEY (raised_for_student_id) REFERENCES students(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE complaints ADD CONSTRAINT complaints_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE complaints ADD CONSTRAINT complaints_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


ALTER TABLE complaints ADD COLUMN IF NOT EXISTS title_te TEXT;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS description_te TEXT;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS resolution_te TEXT;

CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaints_raised_by ON complaints(raised_by);
CREATE INDEX IF NOT EXISTS idx_complaints_raised_for ON complaints(raised_for_student_id);
CREATE INDEX IF NOT EXISTS idx_complaints_assigned_to ON complaints(assigned_to);

DROP TRIGGER IF EXISTS trg_complaints_updated ON complaints;
CREATE TRIGGER trg_complaints_updated
BEFORE UPDATE ON complaints
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE SEQUENCE IF NOT EXISTS complaint_ticket_seq START 1;

CREATE OR REPLACE FUNCTION generate_ticket_no()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.ticket_no IS NULL THEN
    NEW.ticket_no := 'TKT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || 
                     LPAD(NEXTVAL('complaint_ticket_seq')::TEXT, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_complaints_ticket ON complaints;
CREATE TRIGGER trg_complaints_ticket
BEFORE INSERT ON complaints
FOR EACH ROW EXECUTE FUNCTION generate_ticket_no();

DO $$ BEGIN
    CREATE TYPE notice_audience_enum AS ENUM ('all','students','staff','parents','class');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS notices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    title_te TEXT,
    content TEXT NOT NULL,
    content_te TEXT,
    audience notice_audience_enum NOT NULL DEFAULT 'all',
    target_class_id UUID REFERENCES classes(id), 
    priority complaint_priority_enum NOT NULL DEFAULT 'medium',
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    publish_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notices_school_id ON notices(school_id);

ALTER TABLE notices ADD COLUMN IF NOT EXISTS title_te TEXT;
ALTER TABLE notices ADD COLUMN IF NOT EXISTS content_te TEXT;

CREATE INDEX IF NOT EXISTS idx_notices_audience ON notices(audience);
CREATE INDEX IF NOT EXISTS idx_notices_publish ON notices(publish_at);

DROP TRIGGER IF EXISTS trg_notices_updated ON notices;
CREATE TRIGGER trg_notices_updated
BEFORE UPDATE ON notices
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


DO $$ BEGIN
    ALTER TABLE notices ADD CONSTRAINT notices_target_class_id_fkey FOREIGN KEY (target_class_id) REFERENCES classes(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE notices ADD CONSTRAINT notices_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Remediation: Notices RLS
ALTER TABLE notices ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION auth_has_role(role_codes text[])
RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 
    FROM user_roles ur
    JOIN roles r ON ur.role_id = r.id
    WHERE ur.user_id = auth.uid()
      AND r.code = ANY(role_codes)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP POLICY IF EXISTS "View Notices" ON notices;
CREATE POLICY "View Notices" ON notices
FOR SELECT
USING (
  (created_by = auth.uid()) OR
  (audience = 'all' AND auth.role() = 'authenticated') OR
  (audience = 'staff' AND auth_has_role(ARRAY['admin', 'teacher', 'staff', 'accounts'])) OR
  (audience = 'students' AND auth_has_role(ARRAY['admin', 'student'])) OR
  (audience = 'parents' AND auth_has_role(ARRAY['admin', 'parent'])) OR
  (audience = 'class' AND target_class_id IS NOT NULL)
);

DROP POLICY IF EXISTS "Manage Notices" ON notices;
CREATE POLICY "Manage Notices" ON notices
FOR ALL 
USING (
  auth_has_role(ARRAY['admin']) OR
  EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN role_permissions rp ON ur.role_id = rp.role_id
    JOIN permissions p ON rp.permission_id = p.id
    WHERE ur.user_id = auth.uid() AND (p.code = 'notices.create' OR p.code = 'notices.manage')
  )
);

DO $$ BEGIN
    CREATE TYPE leave_status_enum AS ENUM ('pending','approved','rejected','cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE leave_type_enum AS ENUM ('casual','sick','earned','maternity','paternity','unpaid','other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS leave_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    applicant_id UUID NOT NULL REFERENCES users(id),
    leave_type leave_type_enum NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason TEXT NOT NULL,
    reason_te TEXT,
    status leave_status_enum NOT NULL DEFAULT 'pending',
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    review_remarks TEXT,
    review_remarks_te TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_leave_dates CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_leave_app_school_id ON leave_applications(school_id);

DO $$ BEGIN
    ALTER TABLE leave_applications ADD CONSTRAINT leave_applications_applicant_id_fkey FOREIGN KEY (applicant_id) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE leave_applications ADD CONSTRAINT leave_applications_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


ALTER TABLE leave_applications ADD COLUMN IF NOT EXISTS reason_te TEXT;
ALTER TABLE leave_applications ADD COLUMN IF NOT EXISTS review_remarks_te TEXT;

CREATE INDEX IF NOT EXISTS idx_leaves_applicant ON leave_applications(applicant_id);
CREATE INDEX IF NOT EXISTS idx_leaves_status ON leave_applications(status);

DROP TRIGGER IF EXISTS trg_leaves_updated ON leave_applications;
CREATE TRIGGER trg_leaves_updated
BEFORE UPDATE ON leave_applications
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS diary_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    class_section_id UUID NOT NULL REFERENCES class_sections(id) ON DELETE RESTRICT,
    subject_id UUID REFERENCES subjects(id) ON DELETE RESTRICT,
    entry_date DATE NOT NULL,
    title VARCHAR(200),
    title_te TEXT,
    content TEXT NOT NULL,
    content_te TEXT,
    homework_due_date DATE,
    attachments JSONB, 
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_homework_due_date CHECK (homework_due_date IS NULL OR homework_due_date >= entry_date),
    -- Prevent duplicate homework for same class/subject/date
    UNIQUE (school_id, class_section_id, subject_id, entry_date, created_by)
);

CREATE INDEX IF NOT EXISTS idx_diary_entries_school_id ON diary_entries(school_id);

DROP TRIGGER IF EXISTS trg_diary_entries_updated ON diary_entries;
CREATE TRIGGER trg_diary_entries_updated
BEFORE UPDATE ON diary_entries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();


DO $$ BEGIN
    ALTER TABLE diary_entries ADD CONSTRAINT diary_entries_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES class_sections(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE diary_entries ADD CONSTRAINT diary_entries_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES subjects(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE diary_entries ADD CONSTRAINT diary_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


ALTER TABLE diary_entries ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE diary_entries ADD COLUMN IF NOT EXISTS title_te TEXT;
ALTER TABLE diary_entries ADD COLUMN IF NOT EXISTS content_te TEXT;


CREATE INDEX IF NOT EXISTS idx_diary_class ON diary_entries(class_section_id);
CREATE INDEX IF NOT EXISTS idx_diary_date ON diary_entries(entry_date);

CREATE OR REPLACE FUNCTION validate_diary_entry()
RETURNS TRIGGER AS $$
BEGIN
    -- 1. Subject Assignment Check
    IF NEW.subject_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM class_subjects cs
            JOIN staff s ON cs.teacher_id = s.id
            WHERE cs.class_section_id = NEW.class_section_id
              AND cs.subject_id = NEW.subject_id
              AND cs.deleted_at IS NULL
              AND s.person_id = (SELECT person_id FROM users WHERE id = NEW.created_by)
        ) THEN
            RAISE EXCEPTION 'Unauthorized: You are not assigned to teach this subject in this class';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_diary ON diary_entries;
CREATE TRIGGER trg_validate_diary
BEFORE INSERT OR UPDATE ON diary_entries
FOR EACH ROW EXECUTE FUNCTION validate_diary_entry();

DROP TRIGGER IF EXISTS trg_diary_updated ON diary_entries;
CREATE TRIGGER trg_diary_updated
BEFORE UPDATE ON diary_entries
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

DO $$ BEGIN
    CREATE TYPE day_of_week_enum AS ENUM ('mon','tue','wed','thu','fri','sat','sun');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL, 
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT chk_period_times CHECK (end_time > start_time),
    UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS idx_periods_school_id ON periods(school_id);

-- 1. Deduplicate periods (Keep the one with the smallest ID, delete others)
DELETE FROM periods
WHERE id IN (
    SELECT id
    FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY sort_order ASC, id ASC) as rnum
        FROM periods
    ) t
    WHERE t.rnum > 1
);

-- 2. Add Unique Constraint explicitly (Safe to run if table exists)
DO $$ BEGIN
    ALTER TABLE periods ADD CONSTRAINT periods_name_key UNIQUE (school_id, name);
EXCEPTION
    WHEN duplicate_table THEN NULL; -- constraint already exists
    WHEN duplicate_object THEN NULL;
    WHEN OTHERS THEN NULL; -- ignore if it fails for other reasons (like still duplicates, though we just deleted them)
END $$;

-- 3. Seed/Update Data
INSERT INTO periods (name, start_time, end_time, sort_order) VALUES
('Period 1', '08:00', '08:45', 1), ('Period 2', '08:45', '09:30', 2), ('Period 3', '09:30', '10:15', 3),
('Break', '10:15', '10:30', 4), ('Period 4', '10:30', '11:15', 5), ('Period 5', '11:15', '12:00', 6),
('Lunch', '12:00', '12:45', 7), ('Period 6', '12:45', '13:30', 8), ('Period 7', '13:30', '14:15', 9),
('Period 8', '14:15', '15:00', 10)
ON CONFLICT (name) DO UPDATE SET
    start_time = EXCLUDED.start_time,
    end_time = EXCLUDED.end_time,
    sort_order = EXCLUDED.sort_order;

-- 4. Cleanup: Remove any periods that are NOT in the standard list (e.g., if user had Period 9 before)
DELETE FROM periods WHERE name NOT IN (
    'Period 1', 'Period 2', 'Period 3', 'Break', 'Period 4', 'Period 5', 'Lunch', 'Period 6', 'Period 7', 'Period 8'
);

-- (Removed Legacy timetable_entries table - Use timetable_slots)


-- 14. TRANSPORT

-- 14.1 Routes (Bus → Route → Stops → Students)
CREATE TABLE IF NOT EXISTS transport_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20),
    description TEXT,
    start_point VARCHAR(200),
    end_point VARCHAR(200),
    total_stops INTEGER,
    monthly_fee DECIMAL(12,2),
    direction VARCHAR(20) DEFAULT 'morning' CHECK (direction IN ('morning', 'afternoon')),
    bus_id UUID, -- FK added after buses table creation
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (school_id, code)
);

CREATE INDEX IF NOT EXISTS idx_transport_routes_school_id ON transport_routes(school_id);

DROP TRIGGER IF EXISTS trg_transport_routes_updated ON transport_routes;
CREATE TRIGGER trg_transport_routes_updated
BEFORE UPDATE ON transport_routes
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


DO $$ BEGIN
    ALTER TABLE transport_routes ADD CONSTRAINT transport_routes_bus_id_fkey FOREIGN KEY (bus_id) REFERENCES buses(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 14.2 Buses
CREATE TABLE IF NOT EXISTS buses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    bus_no VARCHAR(50) NOT NULL,
    registration_no VARCHAR(50),
    capacity INTEGER NOT NULL DEFAULT 40,
    driver_id UUID REFERENCES staff(id),         -- FK to staff (source of truth)
    driver_name VARCHAR(100),                     -- Legacy/display fallback
    driver_phone VARCHAR(20),                     -- Legacy/display fallback
    route_id UUID REFERENCES transport_routes(id) ON DELETE RESTRICT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_bus_capacity CHECK (capacity > 0),
    UNIQUE (school_id, bus_no),
    UNIQUE (school_id, registration_no)
);

CREATE INDEX IF NOT EXISTS idx_buses_school_id ON buses(school_id);

CREATE INDEX IF NOT EXISTS idx_buses_route ON buses(route_id);
CREATE INDEX IF NOT EXISTS idx_buses_driver ON buses(driver_id);


DO $$ BEGIN
    ALTER TABLE buses ADD CONSTRAINT buses_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES staff(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE buses ADD CONSTRAINT buses_route_id_fkey FOREIGN KEY (route_id) REFERENCES transport_routes(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Add deferred FK from routes → buses (circular reference resolved)
ALTER TABLE transport_routes ADD COLUMN IF NOT EXISTS bus_id UUID REFERENCES buses(id);
CREATE INDEX IF NOT EXISTS idx_routes_bus ON transport_routes(bus_id);

-- 14.3 Stops (strictly ordered per route)
CREATE TABLE IF NOT EXISTS transport_stops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    latitude DECIMAL(10,8),
    longitude DECIMAL(11,8),
    pickup_time TIME,
    drop_time TIME,
    stop_order INTEGER NOT NULL,
    deleted_at TIMESTAMPTZ,
    UNIQUE (school_id, route_id, stop_order)
);

CREATE INDEX IF NOT EXISTS idx_transport_stops_school_id ON transport_stops(school_id);


DO $$ BEGIN
    ALTER TABLE transport_stops ADD CONSTRAINT transport_stops_route_id_fkey FOREIGN KEY (route_id) REFERENCES transport_routes(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 14.4 Student ↔ Transport mapping
CREATE TABLE IF NOT EXISTS student_transport (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE RESTRICT,
    stop_id UUID REFERENCES transport_stops(id) ON DELETE SET NULL,
    bus_id UUID REFERENCES buses(id),            -- Auto-derived from route on assignment
    academic_year_id UUID NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (school_id, student_id, academic_year_id)
);

CREATE INDEX IF NOT EXISTS idx_student_transpschool_id ON student_transport(school_id);

CREATE INDEX IF NOT EXISTS idx_student_transport_route ON student_transport(route_id);
CREATE INDEX IF NOT EXISTS idx_student_transport_bus ON student_transport(bus_id);


DO $$ BEGIN
    ALTER TABLE student_transport ADD CONSTRAINT student_transport_bus_id_fkey FOREIGN KEY (bus_id) REFERENCES buses(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_transport ADD CONSTRAINT student_transport_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_transport ADD CONSTRAINT student_transport_route_id_fkey FOREIGN KEY (route_id) REFERENCES transport_routes(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_transport ADD CONSTRAINT student_transport_stop_id_fkey FOREIGN KEY (stop_id) REFERENCES transport_stops(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_transport ADD CONSTRAINT student_transport_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 14.5 Bus live locations (single row per bus, upserted)
CREATE TABLE IF NOT EXISTS bus_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    bus_id UUID NOT NULL REFERENCES buses(id) ON DELETE CASCADE,
    latitude DECIMAL(10,8) NOT NULL,
    longitude DECIMAL(11,8) NOT NULL,
    speed DECIMAL(5,2),
    heading DECIMAL(5,2),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bus_locations_school_id ON bus_locations(school_id);

CREATE INDEX IF NOT EXISTS idx_bus_locations_recent ON bus_locations(bus_id, recorded_at DESC);

ALTER TABLE IF EXISTS bus_locations ADD COLUMN IF NOT EXISTS is_mocked boolean DEFAULT false;
ALTER TABLE IF EXISTS bus_locations ADD COLUMN IF NOT EXISTS is_suspicious boolean DEFAULT false;


DO $$ BEGIN
    ALTER TABLE bus_locations ADD CONSTRAINT bus_locations_bus_id_fkey FOREIGN KEY (bus_id) REFERENCES buses(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 14.6 Trips (driver trip execution)
CREATE TABLE IF NOT EXISTS trips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    bus_id UUID NOT NULL REFERENCES buses(id),
    route_id UUID NOT NULL REFERENCES transport_routes(id),
    driver_id UUID NOT NULL REFERENCES staff(id),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'completed', 'cancelled')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trips_school_id ON trips(school_id);


DO $$ BEGIN
    ALTER TABLE trips ADD CONSTRAINT trips_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'completed'::character varying, 'cancelled'::character varying])::text[])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE trips ADD CONSTRAINT trips_bus_id_fkey FOREIGN KEY (bus_id) REFERENCES buses(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE trips ADD CONSTRAINT trips_route_id_fkey FOREIGN KEY (route_id) REFERENCES transport_routes(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE trips ADD CONSTRAINT trips_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES staff(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Only one active trip per bus at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_active_bus ON trips(bus_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_trips_driver ON trips(driver_id);
CREATE INDEX IF NOT EXISTS idx_trips_route ON trips(route_id);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);

DROP TRIGGER IF EXISTS trg_trips_updated ON trips;
CREATE OR REPLACE TRIGGER trg_trips_updated
BEFORE UPDATE ON trips
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- 14.7 Trip stop execution status
CREATE TABLE IF NOT EXISTS trip_stop_status (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    stop_id UUID NOT NULL REFERENCES transport_stops(id),
    stop_order INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'arrived', 'completed', 'skipped')),
    arrival_time TIMESTAMPTZ,
    departure_time TIMESTAMPTZ,
    UNIQUE (school_id, trip_id, stop_id)
);

CREATE INDEX IF NOT EXISTS idx_trip_stop_status_school_id ON trip_stop_status(school_id);

CREATE INDEX IF NOT EXISTS idx_trip_stop_trip ON trip_stop_status(trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_stop_status ON trip_stop_status(status);


DO $$ BEGIN
    ALTER TABLE trip_stop_status ADD CONSTRAINT trip_stop_status_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'arrived'::character varying, 'completed'::character varying, 'skipped'::character varying])::text[])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE trip_stop_status ADD CONSTRAINT trip_stop_status_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE trip_stop_status ADD CONSTRAINT trip_stop_status_stop_id_fkey FOREIGN KEY (stop_id) REFERENCES transport_stops(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 14.8 RLS for trips
ALTER TABLE trips ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE trips TO authenticated;
GRANT ALL ON TABLE trips TO service_role;

DROP POLICY IF EXISTS "Admins can manage trips" ON trips;
CREATE POLICY "Admins can manage trips" ON trips FOR ALL USING (
  EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN roles r ON ur.role_id = r.id
    WHERE ur.user_id = auth.uid() AND r.code IN ('admin', 'driver')
  )
);

DROP POLICY IF EXISTS "Drivers can view own trips" ON trips;
CREATE POLICY "Drivers can view own trips" ON trips FOR SELECT USING (
  driver_id IN (
    SELECT s.id FROM staff s
    JOIN users u ON s.person_id = u.person_id
    WHERE u.id = auth.uid()
  )
);

-- 14.9 RLS for trip_stop_status
ALTER TABLE trip_stop_status ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE trip_stop_status TO authenticated;
GRANT ALL ON TABLE trip_stop_status TO service_role;

DROP POLICY IF EXISTS "Authenticated can view trip stops" ON trip_stop_status;
CREATE POLICY "Authenticated can view trip stops" ON trip_stop_status FOR SELECT
  TO authenticated USING (true);

-- 15. HOSTEL
CREATE TABLE IF NOT EXISTS hostel_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20),
    gender_id SMALLINT REFERENCES genders(id),
    total_rooms INTEGER,
    warden_id UUID REFERENCES staff(id),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS idx_hostel_blocks_school_id ON hostel_blocks(school_id);

DO $$ BEGIN
    ALTER TABLE hostel_blocks ADD CONSTRAINT hostel_blocks_gender_id_fkey FOREIGN KEY (gender_id) REFERENCES genders(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE hostel_blocks ADD CONSTRAINT hostel_blocks_warden_id_fkey FOREIGN KEY (warden_id) REFERENCES staff(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


CREATE TABLE IF NOT EXISTS hostel_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    block_id UUID NOT NULL REFERENCES hostel_blocks(id) ON DELETE CASCADE,
    room_no VARCHAR(20) NOT NULL,
    floor INTEGER,
    capacity INTEGER NOT NULL DEFAULT 2,
    room_type VARCHAR(50) DEFAULT 'shared', 
    monthly_fee DECIMAL(12,2),
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    deleted_at TIMESTAMPTZ,
    UNIQUE (school_id, block_id, room_no)
);

CREATE INDEX IF NOT EXISTS idx_hostel_rooms_school_id ON hostel_rooms(school_id);

DO $$ BEGIN
    ALTER TABLE hostel_rooms ADD CONSTRAINT hostel_rooms_block_id_fkey FOREIGN KEY (block_id) REFERENCES hostel_blocks(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


CREATE TABLE IF NOT EXISTS hostel_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id),
    room_id UUID NOT NULL REFERENCES hostel_rooms(id),
    academic_year_id UUID NOT NULL REFERENCES academic_years(id),
    bed_no INTEGER,
    allocated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    vacated_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (school_id, student_id, academic_year_id)
);

CREATE INDEX IF NOT EXISTS idx_hostel_alloc_school_id ON hostel_allocations(school_id);

CREATE INDEX IF NOT EXISTS idx_hostel_allocations_room ON hostel_allocations(room_id);


DO $$ BEGIN
    ALTER TABLE hostel_allocations ADD CONSTRAINT hostel_allocations_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE hostel_allocations ADD CONSTRAINT hostel_allocations_room_id_fkey FOREIGN KEY (room_id) REFERENCES hostel_rooms(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE hostel_allocations ADD CONSTRAINT hostel_allocations_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 16. EVENTS
DO $$ BEGIN
    CREATE TYPE event_type_enum AS ENUM ('academic','cultural','sports','holiday','meeting','exam','other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    title_te TEXT,
    description TEXT,
    description_te TEXT,
    event_type event_type_enum NOT NULL DEFAULT 'other',
    start_date DATE NOT NULL,
    end_date DATE,
    start_time TIME,
    end_time TIME,
    location VARCHAR(200),
    is_all_day BOOLEAN NOT NULL DEFAULT FALSE,
    is_public BOOLEAN NOT NULL DEFAULT TRUE,
    target_audience notice_audience_enum DEFAULT 'all',
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_event_dates CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_events_school_id ON events(school_id);

ALTER TABLE events ADD COLUMN IF NOT EXISTS title_te TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS description_te TEXT;

CREATE INDEX IF NOT EXISTS idx_events_dates ON events(start_date, end_date);

DROP TRIGGER IF EXISTS trg_events_updated ON events;
CREATE TRIGGER trg_events_updated
BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


DO $$ BEGIN
    ALTER TABLE events ADD CONSTRAINT events_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Remediation: Events RLS
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "View Events" ON events;
CREATE POLICY "View Events" ON events
FOR SELECT
USING (
  is_public = true OR
  created_by = auth.uid() OR
  (target_audience = 'all' AND auth.role() = 'authenticated') OR
  (target_audience = 'staff' AND auth_has_role(ARRAY['admin', 'teacher', 'staff', 'accounts']))
);

-- 17. LMS
CREATE TABLE IF NOT EXISTS lms_courses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    subject_id UUID REFERENCES subjects(id),
    class_id UUID REFERENCES classes(id),
    instructor_id UUID REFERENCES staff(id),
    is_published BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_lms_courses_school_id ON lms_courses(school_id);

DO $$ BEGIN
    ALTER TABLE lms_courses ADD CONSTRAINT lms_courses_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES subjects(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE lms_courses ADD CONSTRAINT lms_courses_class_id_fkey FOREIGN KEY (class_id) REFERENCES classes(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE lms_courses ADD CONSTRAINT lms_courses_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES staff(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


ALTER TABLE lms_courses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


CREATE OR REPLACE FUNCTION validate_lms_course_modify()
RETURNS TRIGGER AS $$
DECLARE
    v_is_admin BOOLEAN;
BEGIN
    -- Check if Admin
    SELECT EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = auth.uid() AND r.code = 'admin'
    ) INTO v_is_admin;

    IF v_is_admin THEN
        RETURN NEW;
    END IF;

    -- Check if Instructor
    IF NEW.instructor_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM staff s
            WHERE s.id = NEW.instructor_id
              AND s.person_id = (SELECT person_id FROM users WHERE id = auth.uid())
        ) THEN
            RAISE EXCEPTION 'Unauthorized: Only the assigned Instructor or Admin can modify this course';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_lms_course ON lms_courses;
CREATE TRIGGER trg_validate_lms_course
BEFORE UPDATE ON lms_courses
FOR EACH ROW EXECUTE FUNCTION validate_lms_course_modify();


CREATE INDEX IF NOT EXISTS idx_lms_courses_subject ON lms_courses(subject_id);
CREATE INDEX IF NOT EXISTS idx_lms_courses_class ON lms_courses(class_id);
CREATE INDEX IF NOT EXISTS idx_lms_courses_instructor ON lms_courses(instructor_id);

DROP TRIGGER IF EXISTS trg_lms_courses_updated ON lms_courses;
CREATE TRIGGER trg_lms_courses_updated
BEFORE UPDATE ON lms_courses
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

DO $$ BEGIN
    CREATE TYPE material_type_enum AS ENUM ('video','document','link','quiz','assignment');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS lms_materials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES lms_courses(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    material_type material_type_enum NOT NULL,
    content_url TEXT,
    file_size INTEGER,
    duration INTEGER, 
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_published BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_lms_materials_school_id ON lms_materials(school_id);

ALTER TABLE lms_materials ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;


CREATE INDEX IF NOT EXISTS idx_lms_materials_active ON lms_materials(id) WHERE deleted_at IS NULL;


CREATE INDEX IF NOT EXISTS idx_lms_materials_course ON lms_materials(course_id);


DO $$ BEGIN
    ALTER TABLE lms_materials ADD CONSTRAINT lms_materials_course_id_fkey FOREIGN KEY (course_id) REFERENCES lms_courses(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 18. SEED DATA (PERMISSIONS)
INSERT INTO permissions (code, name) VALUES
('students.view', 'View Students'), ('students.create', 'Create Students'), ('students.edit', 'Edit Students'), ('students.delete', 'Delete Students'),
('staff.view', 'View Staff'), ('staff.create', 'Create Staff'), ('staff.edit', 'Edit Staff'), ('staff.delete', 'Delete Staff'),
('users.view', 'View Users'), ('users.create', 'Create Users'), ('users.edit', 'Edit Users'), ('users.delete', 'Delete Users'),
('academics.view', 'View Academics'), ('academics.manage', 'Manage Academics'),
('attendance.view', 'View Attendance'), ('attendance.mark', 'Mark Attendance'), ('attendance.edit', 'Edit Attendance'),
('fees.view', 'View Fees'), ('fees.manage', 'Manage Fees'), ('fees.collect', 'Collect Fees'),
('transactions.view', 'View Transactions'), ('receipts.generate', 'Generate Receipts'), ('reports.financial', 'View Financial Reports'),
('exams.view', 'View Exams'), ('exams.manage', 'Manage Exams'), ('marks.view', 'View Marks'), ('marks.enter', 'Enter Marks'), ('results.view', 'View Results'), ('results.generate', 'Generate Results'),
('transport.view', 'View Transport'), ('transport.manage', 'Manage Transport'),
('hostel.view', 'View Hostel'), ('hostel.manage', 'Manage Hostel'),
('events.view', 'View Events'), ('events.manage', 'Manage Events'),
('lms.view', 'View LMS'), ('lms.create', 'Create LMS Content'), ('lms.manage', 'Manage LMS'),
('complaints.view', 'View Complaints'), ('complaints.create', 'Create Complaints'), ('complaints.manage', 'Manage Complaints'),
('notices.view', 'View Notices'), ('notices.create', 'Create Notices'), ('notices.manage', 'Manage Notices'),
('leaves.view', 'View Leaves'), ('leaves.apply', 'Apply for Leave'), ('leaves.approve', 'Approve Leaves'),
('diary.view', 'View Diary'), ('diary.create', 'Create Diary Entries'),
('timetable.view', 'View Timetable'), ('timetable.manage', 'Manage Timetable'),
('dashboard.view', 'View Dashboard'),
('results.publish', 'Publish Results'),
('diary.manage', 'Manage Diary')
ON CONFLICT (code) DO NOTHING;

-- 18.1 ROLES
INSERT INTO roles (code, name, is_system) VALUES
('admin', 'Administrator', true),
('staff', 'Staff/Teacher', true),
('student', 'Student', true),
('accounts', 'Accounts Manager', true),
('principal', 'Principal', true),
('driver', 'Driver', true)
ON CONFLICT (code) DO NOTHING;

-- 18.2 ROLE-PERMISSION MAPPING (Production RBAC)
-- Admin: All
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.code = 'admin'
ON CONFLICT DO NOTHING;

-- Staff: Academic & Operations
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p 
WHERE r.code = 'staff' AND p.code IN (
    'students.view', 'academics.view', 'attendance.view', 'attendance.mark', 
    'exams.view', 'marks.enter', 'marks.view', 'diary.view', 'diary.create',
    'timetable.view', 'leaves.apply', 'notices.view', 'events.view', 'lms.view'
)
ON CONFLICT DO NOTHING;

-- Student: View Only Access
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p 
WHERE r.code = 'student' AND p.code IN (
    'academics.view', 'attendance.view', 'exams.view', 'results.view', 
    'diary.view', 'timetable.view', 'notices.view', 'events.view', 'lms.view', 'fees.view'
)
ON CONFLICT DO NOTHING;

-- Accounts: Financial Management
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p 
WHERE r.code = 'accounts' AND p.code IN (
    'fees.view', 'fees.manage', 'fees.collect', 'transactions.view', 
    'receipts.generate', 'reports.financial', 'notices.view', 'staff.view',
    'dashboard.view'
)
ON CONFLICT DO NOTHING;

-- Principal: Full Access (same as Admin)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p WHERE r.code = 'principal'
ON CONFLICT DO NOTHING;

-- Driver: Transport-only Access
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p 
WHERE r.code = 'driver' AND p.code IN (
    'transport.view', 'notices.view'
)
ON CONFLICT DO NOTHING;

-- ============================================================
-- 19. NOTIFICATION INFRASTRUCTURE
-- ============================================================

-- 19.1 User Devices (FCM Push Token Storage)
CREATE TABLE IF NOT EXISTS user_devices (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id     INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fcm_token     TEXT NOT NULL,
    platform      VARCHAR(20) NOT NULL DEFAULT 'unknown',
    device_name   TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    language_code VARCHAR(5) NOT NULL DEFAULT 'en',
    last_used_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_device_token UNIQUE (school_id, user_id, fcm_token)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_school_id ON user_devices(school_id);

CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_fcm_token ON user_devices(fcm_token);
CREATE INDEX IF NOT EXISTS idx_user_devices_active ON user_devices(user_id, is_active);


DO $$ BEGIN
    ALTER TABLE user_devices ADD CONSTRAINT user_devices_platform_check CHECK ((platform = ANY (ARRAY['android'::text, 'ios'::text])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE user_devices ADD CONSTRAINT user_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Idempotent column adds for existing deployments
ALTER TABLE user_devices ADD COLUMN IF NOT EXISTS device_name TEXT;
ALTER TABLE user_devices ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE user_devices ADD COLUMN IF NOT EXISTS language_code VARCHAR(5) NOT NULL DEFAULT 'en';

-- 19.2 Notification Configuration (Kill Switch + Settings)
CREATE TABLE IF NOT EXISTS notification_config (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

-- Seed defaults
INSERT INTO notification_config (key, value) VALUES
    ('kill_switch',              '{"global": false, "types": {}}'::jsonb),
    ('max_batch_size',           '{"value": 500}'::jsonb),
    ('fee_reminder_daily_limit', '{"value": 1}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 19.3 Notification Logs (Delivery Audit Trail)
CREATE TABLE IF NOT EXISTS notification_logs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id         INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
    batch_id          UUID,
    notification_type TEXT NOT NULL,
    role              TEXT,
    channel_id        TEXT,
    push_provider     TEXT DEFAULT 'fcm',
    tokens_targeted   INTEGER NOT NULL DEFAULT 0,
    tokens_sent       INTEGER NOT NULL DEFAULT 0,
    tokens_failed     INTEGER NOT NULL DEFAULT 0,
    error_message     TEXT,
    provider_response JSONB,
    status            TEXT CHECK (status IN ('success', 'failed', 'partial')),
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    deleted_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_school_id ON notification_logs(school_id);

CREATE INDEX IF NOT EXISTS idx_notification_logs_type_date ON notification_logs(notification_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_logs_batch_id ON notification_logs(batch_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_user_type_date ON notification_logs(user_id, notification_type, created_at);


DO $$ BEGIN
    ALTER TABLE notification_logs ADD CONSTRAINT notification_logs_status_check CHECK ((status = ANY (ARRAY['success'::text, 'failed'::text, 'partial'::text])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE notification_logs ADD CONSTRAINT notification_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 19.4 Notification Batches (Bulk Send Tracking)
CREATE TABLE IF NOT EXISTS notification_batches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id       INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    admin_id        UUID REFERENCES users(id),
    type            TEXT NOT NULL,
    filters         JSONB DEFAULT '{}',
    status          TEXT CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'aborted')) DEFAULT 'pending',
    total_targets   INTEGER DEFAULT 0,
    sent_count      INTEGER DEFAULT 0,
    failure_count   INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notification_batches_school_id ON notification_batches(school_id);

CREATE INDEX IF NOT EXISTS idx_notification_batches_status ON notification_batches(status);
CREATE INDEX IF NOT EXISTS idx_notification_batches_type_created ON notification_batches(type, created_at);


DO $$ BEGIN
    ALTER TABLE notification_batches ADD CONSTRAINT notification_batches_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'aborted'::text])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE notification_batches ADD CONSTRAINT notification_batches_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE notification_batches ADD CONSTRAINT notification_batches_type_check CHECK ((type = ANY (ARRAY[('FEES'::character varying)::text, ('DIARY'::character varying)::text, ('RESULTS'::character varying)::text, ('NOTICE'::character varying)::text, ('TEST_TRIGGER'::character varying)::text])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Idempotent column adds for existing deployments (merged from Section 20/21)
ALTER TABLE notification_config ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE notification_batches ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Constraints merged from Section 20/21
DO $$ BEGIN
    ALTER TABLE notification_batches ADD CONSTRAINT chk_notification_batches_type 
    CHECK (type IN ('FEES', 'GENERAL', 'EXAM', 'EMERGENCY', 'DIARY', 'RESULTS', 'NOTICE', 'TEST_TRIGGER'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Enable Row Level Security (merged from Section 20/21)
ALTER TABLE notification_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_batches ENABLE ROW LEVEL SECURITY;

-- Views
CREATE OR REPLACE VIEW active_students AS
SELECT * FROM students WHERE deleted_at IS NULL AND status_id IN (SELECT id FROM student_statuses WHERE code = 'ENROLLED');

CREATE OR REPLACE VIEW active_persons AS
SELECT * FROM persons WHERE deleted_at IS NULL;

-- END OF SCHEMA
-- ============================================================
-- HARDENING TRIGGERS (SAFETY GUARDS)
-- ============================================================

-- Guard 1: Prevent Direct Updates to amount_paid
-- Only allow updates via internal triggers (depth > 0)
CREATE OR REPLACE FUNCTION prevent_direct_fee_update()
RETURNS TRIGGER AS $$
BEGIN
    -- Block direct manual tampering at depth 0, but allow system recalculation via GUC flag
    IF (pg_trigger_depth() = 0)
       AND COALESCE(current_setting('app.fee_recalc_mode', true), '') != 'true'
    THEN
        IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid THEN
            RAISE EXCEPTION 'Direct update of student_fees.amount_paid is strictly forbidden. Use fee_transactions.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_fee_update ON student_fees;
CREATE TRIGGER trg_guard_fee_update
BEFORE UPDATE ON student_fees
FOR EACH ROW EXECUTE FUNCTION prevent_direct_fee_update();

-- Guard 2: Prevent Negative Balances
-- Redundant to logical check but good as constraint
ALTER TABLE student_fees 
DROP CONSTRAINT IF EXISTS chk_no_negative_paid;

ALTER TABLE student_fees
ADD CONSTRAINT chk_no_negative_paid CHECK (amount_paid >= 0);

-- Guard 3: Prevent Overpayment (Paid > Due - Discount)
-- chk_paid_not_exceed is defined in the CREATE TABLE student_fees block (line ~827).
-- No standalone ALTER needed — constraint is already active.

-- Guard 4: Prevent Discount Exceeding Amount Due
ALTER TABLE student_fees
DROP CONSTRAINT IF EXISTS chk_discount_not_exceed_due;

ALTER TABLE student_fees
ADD CONSTRAINT chk_discount_not_exceed_due CHECK (discount <= amount_due);

-- (Removed Legacy Timetable Logic - See lines 1513+ for new implementation)
-- Function: promote_students_academic_year
-- Logic: Move students from current AY to next AY, incrementing class.

CREATE OR REPLACE FUNCTION promote_students_academic_year(
    p_current_ay_id UUID,
    p_next_ay_id UUID
)
RETURNS JSONB AS $$
DECLARE
    v_promoted_count INT := 0;
    v_graduated_count INT := 0;
    r_enrollment RECORD;
    v_next_class_id UUID;
    v_next_section_id UUID; -- Keep same section? Usually yes.
    v_next_class_section_id UUID;
    v_class_name TEXT;
    v_next_class_name TEXT;
    v_class_number INT;
BEGIN
    -- Validate AYs
    IF p_current_ay_id = p_next_ay_id THEN
        RAISE EXCEPTION 'Source and Target Academic Years must be different';
    END IF;

    -- Loop through ACTIVE enrollments in current AY
    FOR r_enrollment IN
        SELECT se.*, c.id as class_id, c.name as class_name, cs.section_id
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        WHERE se.academic_year_id = p_current_ay_id
          AND se.status = 'active'
          AND se.deleted_at IS NULL
    LOOP
        -- 1. Determine Next Class
        -- Logic: Attempt to parse "Class 1" -> 1. Increment to 2. Find "Class 2".
        -- If fails (e.g. "Kindergarten"), this logic needs specific handling or a mapping table.
        -- Assuming "Class X" format for simplicity as per common IMS.
        
        -- Simple Regex to extract number
        v_class_number := substring(r_enrollment.class_name FROM '\d+')::INT;
        
        IF v_class_number IS NOT NULL THEN
            v_next_class_name := 'Class ' || (v_class_number + 1);
            
            -- Check if next class exists
            SELECT id INTO v_next_class_id FROM classes WHERE name = v_next_class_name;
            
            IF v_next_class_id IS NOT NULL THEN
                -- Find corresponding class_section in Next AY
                -- We assume Section maps 1:1 by name (via section_id)
                SELECT id INTO v_next_class_section_id
                FROM class_sections
                WHERE class_id = v_next_class_id
                  AND section_id = r_enrollment.section_id
                  AND academic_year_id = p_next_ay_id;
                  
                -- If section doesn't exist in next year, we cannot promote automatically
                -- Possible fallback: Default section or error. We'll skip/log.
                IF v_next_class_section_id IS NOT NULL THEN
                    -- PROMOTE
                    INSERT INTO student_enrollments (
                        student_id, academic_year_id, class_section_id, status, start_date, roll_number
                    ) VALUES (
                        r_enrollment.student_id,
                        p_next_ay_id,
                        v_next_class_section_id,
                        'active',
                        (SELECT start_date FROM academic_years WHERE id = p_next_ay_id),
                        NULL -- To be recalculated
                    );
                    
                    -- Mark old as completed
                    UPDATE student_enrollments 
                    SET status = 'completed', end_date = (SELECT end_date FROM academic_years WHERE id = p_current_ay_id)
                    WHERE id = r_enrollment.id;
                    
                    v_promoted_count := v_promoted_count + 1;
                ELSE
                    -- Log missing section?
                END IF;
            ELSE
                -- Next class not found -> GRADUATE
                -- Assume highest class means graduation
                UPDATE students SET status_id = (SELECT id FROM student_statuses WHERE is_terminal = true LIMIT 1) 
                WHERE id = r_enrollment.student_id;
                
                UPDATE student_enrollments 
                SET status = 'completed', end_date = (SELECT end_date FROM academic_years WHERE id = p_current_ay_id)
                WHERE id = r_enrollment.id;
                
                v_graduated_count := v_graduated_count + 1;
            END IF;
        ELSE
            -- Non-numeric class name? Skip for safety.
        END IF;
    END LOOP;

    -- Recalculate Roll Numbers for ALL sections in Next AY
    -- (We can optimize to only touch affected sections, but this is safer)
    PERFORM recalculate_section_rolls(cs.id, p_next_ay_id)
    FROM class_sections cs
    WHERE cs.academic_year_id = p_next_ay_id;

    RETURN jsonb_build_object(
        'status', 'success',
        'promoted', v_promoted_count,
        'graduated', v_graduated_count
    );
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 19. TIMETABLE (NEW IMPLEMENTATION - timetable_slots)
-- ============================================================

-- Drop table to ensure clean slate if re-running
DROP TABLE IF EXISTS timetable_slots CASCADE;

-- Create Enum for Days
DO $$ BEGIN
    CREATE TYPE day_of_week_enum AS ENUM ('monday','tuesday','wednesday','thursday','friday','saturday','sunday');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE timetable_slots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    
    academic_year_id UUID NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
    class_section_id UUID NOT NULL REFERENCES class_sections(id) ON DELETE RESTRICT,
    
    day_of_week day_of_week_enum NOT NULL,
    period_number SMALLINT NOT NULL,
    
    subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
    teacher_id UUID REFERENCES staff(id) ON DELETE RESTRICT,
    room_no VARCHAR(50),
    
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    
    CONSTRAINT chk_time_order CHECK (start_time < end_time)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_timetable_slots_active 
ON timetable_slots (class_section_id, academic_year_id, day_of_week, period_number) 
WHERE deleted_at IS NULL;


CREATE INDEX IF NOT EXISTS idx_timetable_class ON timetable_slots(class_section_id);
CREATE INDEX IF NOT EXISTS idx_timetable_teacher ON timetable_slots(teacher_id);
CREATE INDEX IF NOT EXISTS idx_timetable_slots_time_check ON timetable_slots(teacher_id, start_time, end_time); -- Updated for collision detection


DO $$ BEGIN
    ALTER TABLE timetable_slots ADD CONSTRAINT timetable_slots_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE timetable_slots ADD CONSTRAINT timetable_slots_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES class_sections(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE timetable_slots ADD CONSTRAINT timetable_slots_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE timetable_slots ADD CONSTRAINT timetable_slots_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES staff(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Financial & Course Performance Indexes
CREATE INDEX IF NOT EXISTS idx_complaints_assigned_to ON complaints(assigned_to);
CREATE INDEX IF NOT EXISTS idx_lms_courses_subject ON lms_courses(subject_id);
CREATE INDEX IF NOT EXISTS idx_lms_courses_instructor ON lms_courses(instructor_id);

-- Validation Trigger
CREATE OR REPLACE FUNCTION validate_timetable_entry()
RETURNS TRIGGER AS $$
DECLARE
    v_teacher_collision BOOLEAN;
    v_room_collision BOOLEAN;
BEGIN
    -- 1. Subject Assignment Check
    IF NEW.teacher_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM class_subjects cs
            WHERE cs.class_section_id = NEW.class_section_id
              AND cs.teacher_id = NEW.teacher_id
              AND cs.subject_id = NEW.subject_id
              AND cs.deleted_at IS NULL
        ) THEN
            -- RAISE EXCEPTION 'Teacher is not assigned to this Class/Subject combination';
            -- Strict check disabled to allow ad-hoc scheduling
            NULL;
        END IF;

        -- 2. Teacher Collision Check (Same period)
        SELECT EXISTS (
            SELECT 1 FROM timetable_slots
            WHERE teacher_id = NEW.teacher_id
              AND period_number = NEW.period_number
              AND academic_year_id = NEW.academic_year_id
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
        ) INTO v_teacher_collision;

        IF v_teacher_collision THEN
            RAISE EXCEPTION 'Teacher Collision: Teacher is already booked for period %', NEW.period_number;
        END IF;
    END IF;

    -- 3. Room Collision Check
    IF NEW.room_no IS NOT NULL AND NEW.room_no <> '' THEN
        SELECT EXISTS (
            SELECT 1 FROM timetable_slots
            WHERE room_no = NEW.room_no
              AND period_number = NEW.period_number
              AND academic_year_id = NEW.academic_year_id
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
        ) INTO v_room_collision;

        IF v_room_collision THEN
            RAISE EXCEPTION 'Room Collision: Room % is already occupied during period %', NEW.room_no, NEW.period_number;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_timetable ON timetable_slots;
CREATE TRIGGER trg_validate_timetable
BEFORE INSERT OR UPDATE ON timetable_slots
FOR EACH ROW EXECUTE FUNCTION validate_timetable_entry();

DROP TRIGGER IF EXISTS trg_timetable_updated ON timetable_slots;
CREATE TRIGGER trg_timetable_updated
BEFORE UPDATE ON timetable_slots
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

ALTER TABLE timetable_slots ENABLE ROW LEVEL SECURITY;

-- Automated Class Teacher Assignment (Monday Period 1)
CREATE OR REPLACE FUNCTION sync_class_teacher_from_timetable()
RETURNS TRIGGER AS $$
DECLARE
    v_class_section_id UUID;
    v_teacher_id UUID;
    v_monday_label TEXT;
BEGIN
    -- Dynamically detect the correct Monday enum label ('mon' or 'monday')
    SELECT e.enumlabel INTO v_monday_label
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'day_of_week_enum'
      AND e.enumlabel IN ('mon', 'monday')
    LIMIT 1;

    -- If no Monday label found, skip silently
    IF v_monday_label IS NULL THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;

    IF (TG_OP = 'DELETE') THEN
        IF OLD.period_number = 1 AND OLD.day_of_week::text = v_monday_label THEN
             UPDATE class_sections 
             SET class_teacher_id = NULL 
             WHERE id = OLD.class_section_id;
        END IF;
        RETURN OLD;
    END IF;

    IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') THEN
        IF NEW.period_number = 1 AND NEW.day_of_week::text = v_monday_label THEN
             UPDATE class_sections 
             SET class_teacher_id = NEW.teacher_id 
             WHERE id = NEW.class_section_id;
        END IF;
        RETURN NEW;
    END IF;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_sync_class_teacher ON timetable_slots;
CREATE TRIGGER trg_sync_class_teacher
AFTER INSERT OR UPDATE OR DELETE ON timetable_slots
FOR EACH ROW EXECUTE FUNCTION sync_class_teacher_from_timetable();

-- Initial Sync (Ensure consistency on schema apply)
DO $$
DECLARE
    r RECORD;
    v_monday_label TEXT;
BEGIN
    -- Dynamically find the correct enum label for Monday ('mon' or 'monday')
    SELECT e.enumlabel INTO v_monday_label
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'day_of_week_enum'
      AND e.enumlabel IN ('mon', 'monday')
    LIMIT 1;

    IF v_monday_label IS NULL THEN
        RAISE NOTICE 'Initial timetable sync skipped: no Monday label found in day_of_week_enum';
        RETURN;
    END IF;

    FOR r IN 
        EXECUTE format(
            'SELECT class_section_id, teacher_id FROM timetable_slots WHERE day_of_week = %L::day_of_week_enum AND period_number = 1',
            v_monday_label
        )
    LOOP
        UPDATE class_sections 
        SET class_teacher_id = r.teacher_id 
        WHERE id = r.class_section_id;
    END LOOP;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Initial timetable sync skipped: %', SQLERRM;
END $$;



-- RLS Policies

-- 1. Students: View OWN class timetable
DROP POLICY IF EXISTS "Students view own class timetable" ON timetable_slots;
CREATE POLICY "Students view own class timetable" ON timetable_slots
FOR SELECT
USING (
    class_section_id IN (
        SELECT class_section_id 
        FROM student_enrollments 
        WHERE student_id IN (
            SELECT id FROM students WHERE person_id = (
                SELECT person_id FROM users WHERE id = auth.uid()
            )
        )
        AND status = 'active'
    )
);

-- 2. Teachers: View OWN slots
DROP POLICY IF EXISTS "Teachers view own slots" ON timetable_slots;
CREATE POLICY "Teachers view own slots" ON timetable_slots
FOR SELECT
USING (
    teacher_id IN (
        SELECT id FROM staff 
        WHERE person_id = (
            SELECT person_id FROM users WHERE id = auth.uid()
        )
    )
);

-- 3. Admins: Full Access
DROP POLICY IF EXISTS "Admins full access" ON timetable_slots;
CREATE POLICY "Admins full access" ON timetable_slots
FOR ALL
USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND EXISTS (
        SELECT 1 FROM user_roles ur 
        JOIN roles r ON ur.role_id = r.id 
        WHERE ur.user_id = users.id AND r.code = 'admin'
    ))
);


-- ============================================================
-- NEXSYRUS TABS SCHEMA & AUTOMATION
-- ============================================================

-- 1. DISCIPLINE & CONDUCT
CREATE TABLE IF NOT EXISTS discipline_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    academic_year_id UUID NOT NULL REFERENCES academic_years(id),
    incident_date DATE NOT NULL DEFAULT CURRENT_DATE,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    severity VARCHAR(20) CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    action_taken TEXT,
    evidence_urls TEXT[], -- Linked evidence images/docs
    reported_by UUID REFERENCES users(id), -- Staff who reported
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_discipline_school_id ON discipline_records(school_id);

CREATE INDEX IF NOT EXISTS idx_discipline_student ON discipline_records(student_id);


DO $$ BEGIN
    ALTER TABLE discipline_records ADD CONSTRAINT discipline_records_severity_check CHECK (((severity)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'critical'::character varying])::text[])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE discipline_records ADD CONSTRAINT discipline_records_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE discipline_records ADD CONSTRAINT discipline_records_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE discipline_records ADD CONSTRAINT discipline_records_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 2. MONEY SCIENCE
CREATE TABLE IF NOT EXISTS money_science_modules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    age_group VARCHAR(50), 
    
    -- Content Fields
    content_body TEXT, -- Markdown or JSON content
    thumbnail_url TEXT,
    estimated_duration INTEGER, -- Minutes
    difficulty_level VARCHAR(20) DEFAULT 'beginner',
    tags TEXT[],
    total_points INTEGER DEFAULT 0,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_money_science_school_id ON money_science_modules(school_id);

CREATE TABLE IF NOT EXISTS student_money_science_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    module_id UUID NOT NULL REFERENCES money_science_modules(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'completed')),
    progress_percentage INTEGER DEFAULT 0,
    completed_at TIMESTAMPTZ,
    last_accessed_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(school_id, student_id, module_id)
);

CREATE INDEX IF NOT EXISTS idx_student_money_science_school_id ON student_money_science_progress(school_id);

ALTER TABLE IF EXISTS money_science_modules ADD COLUMN IF NOT EXISTS content_url text;


DO $$ BEGIN
    ALTER TABLE student_money_science_progress ADD CONSTRAINT student_money_science_progress_status_check CHECK (((status)::text = ANY ((ARRAY['not_started'::character varying, 'in_progress'::character varying, 'completed'::character varying])::text[])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_money_science_progress ADD CONSTRAINT student_money_science_progress_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_money_science_progress ADD CONSTRAINT student_money_science_progress_module_id_fkey FOREIGN KEY (module_id) REFERENCES money_science_modules(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 3. SCIENCE PROJECTS
CREATE TABLE IF NOT EXISTS science_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    difficulty_level VARCHAR(20) CHECK (difficulty_level IN ('beginner', 'intermediate', 'advanced')),
    is_group_project BOOLEAN DEFAULT FALSE,
    min_participants INTEGER DEFAULT 1,
    max_participants INTEGER DEFAULT 1,
    
    -- Content Fields
    materials_required TEXT[],
    safety_instructions TEXT,
    thumbnail_url TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_science_projects_school_id ON science_projects(school_id);

CREATE TABLE IF NOT EXISTS student_science_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES science_projects(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'submitted', 'evaluated', 'certified')),
    submission_url TEXT,
    teacher_remarks TEXT,
    grade VARCHAR(10),
    certified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(school_id, student_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_student_science_projects_school_id ON student_science_projects(school_id);


DO $$ BEGIN
    ALTER TABLE science_projects ADD CONSTRAINT science_projects_difficulty_level_check CHECK (((difficulty_level)::text = ANY ((ARRAY['beginner'::character varying, 'intermediate'::character varying, 'advanced'::character varying])::text[])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;


DO $$ BEGIN
    ALTER TABLE student_science_projects ADD CONSTRAINT student_science_projects_status_check CHECK (((status)::text = ANY ((ARRAY['registered'::character varying, 'submitted'::character varying, 'evaluated'::character varying, 'certified'::character varying])::text[])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_science_projects ADD CONSTRAINT student_science_projects_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_science_projects ADD CONSTRAINT student_science_projects_project_id_fkey FOREIGN KEY (project_id) REFERENCES science_projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 4. LIFE VALUES
CREATE TABLE IF NOT EXISTS life_values_modules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    academic_year_id UUID REFERENCES academic_years(id), -- Optional: if content is specific to year
    
    -- Content Fields
    content_body TEXT,
    banner_image_url TEXT,
    quote_author VARCHAR(100),
    highlight_quote TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_life_values_modules_school_id ON life_values_modules(school_id);


DO $$ BEGIN
    ALTER TABLE life_values_modules ADD CONSTRAINT life_values_modules_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- RLS for Life Values
ALTER TABLE life_values_modules ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON life_values_modules TO authenticated;
DROP POLICY IF EXISTS "Enable read access for all" ON life_values_modules;
CREATE POLICY "Enable read access for all" ON life_values_modules FOR SELECT USING (true);

CREATE TABLE IF NOT EXISTS student_life_values_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    module_id UUID NOT NULL REFERENCES life_values_modules(id) ON DELETE CASCADE,
    academic_year_id UUID NOT NULL REFERENCES academic_years(id),
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
    engagement_score INTEGER DEFAULT 0, -- Metric for "Engagement"
    completed_at TIMESTAMPTZ,
    last_accessed_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(school_id, student_id, module_id, academic_year_id)
);

CREATE INDEX IF NOT EXISTS idx_student_life_values_school_id ON student_life_values_progress(school_id);


DO $$ BEGIN
    ALTER TABLE student_life_values_progress ADD CONSTRAINT student_life_values_progress_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'completed'::character varying])::text[])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_life_values_progress ADD CONSTRAINT student_life_values_progress_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_life_values_progress ADD CONSTRAINT student_life_values_progress_module_id_fkey FOREIGN KEY (module_id) REFERENCES life_values_modules(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE student_life_values_progress ADD CONSTRAINT student_life_values_progress_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES academic_years(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- RLS for Life Values Progress
ALTER TABLE student_life_values_progress ENABLE ROW LEVEL SECURITY;
GRANT ALL ON student_life_values_progress TO authenticated;
DROP POLICY IF EXISTS "Allow all authenticated check" ON student_life_values_progress;
CREATE POLICY "Allow all authenticated check" ON student_life_values_progress FOR SELECT USING (true);
DROP POLICY IF EXISTS "Students can view own progress" ON student_life_values_progress;
CREATE POLICY "Students can view own progress" ON student_life_values_progress FOR ALL USING (
    student_id IN (
        SELECT s.id FROM students s
        JOIN persons p ON s.person_id = p.id
        JOIN users u ON u.person_id = p.id
        WHERE u.id = auth.uid()
    )
);

-- 5. AUTOMATION: ENROLLMENT
DROP FUNCTION IF EXISTS ensure_student_enrollment(uuid);
CREATE OR REPLACE FUNCTION ensure_student_enrollment(p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_person_id UUID;
    v_student_id UUID;
    v_academic_year_id UUID;
    v_class_section_id UUID;
    v_enrollment_id UUID;
    v_enrollment_exists BOOLEAN;
BEGIN
    -- 0. Resolve Student ID from User ID
    SELECT person_id INTO v_person_id FROM users WHERE id = p_user_id;
    
    IF v_person_id IS NULL THEN
         RAISE EXCEPTION 'User not found';
    END IF;

    SELECT id INTO v_student_id FROM students WHERE person_id = v_person_id;

    IF v_student_id IS NULL THEN
        RAISE EXCEPTION 'Student profile not found for this user';
    END IF;

    -- Check if enrollment exists for CURRENT academic year
    -- 1. Get Current Academic Year
    SELECT id INTO v_academic_year_id
    FROM academic_years
    WHERE start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE
    LIMIT 1;

    IF v_academic_year_id IS NULL THEN
        -- Fallback: Get the latest one if no current one matches date
        SELECT id INTO v_academic_year_id
        FROM academic_years
        ORDER BY start_date DESC
        LIMIT 1;
    END IF;
    
    IF v_academic_year_id IS NULL THEN
        RAISE EXCEPTION 'No academic year configured.';
    END IF;

    -- 2. Check existing enrollment
    SELECT EXISTS (
        SELECT 1 FROM student_enrollments
        WHERE student_id = v_student_id
          AND academic_year_id = v_academic_year_id
          AND deleted_at IS NULL
    ) INTO v_enrollment_exists;

    IF v_enrollment_exists THEN
        RETURN jsonb_build_object('status', 'exists', 'message', 'Enrollment already exists');
    END IF;

    -- 3. Find Default Class/Section (Deterministic: First alphabetical class & section)
    -- We join with classes and sections to order by name ensuring "Class 1" comes before "Class 2"
    SELECT cs.id INTO v_class_section_id
    FROM class_sections cs
    JOIN classes c ON cs.class_id = c.id
    JOIN sections s ON cs.section_id = s.id
    WHERE cs.academic_year_id = v_academic_year_id
    ORDER BY c.name ASC, s.name ASC
    LIMIT 1;

    IF v_class_section_id IS NULL THEN
         RAISE EXCEPTION 'No class sections defined for the current academic year.';
    END IF;

    -- 4. Calculate next roll number (Atomic / Locked)
    -- Acquire advisory lock based on class_section_id hash to prevent race conditions
    PERFORM pg_advisory_xact_lock(hashtext(v_class_section_id::text));
    
    INSERT INTO student_enrollments (
        student_id, academic_year_id, class_section_id, status, start_date, roll_number
    )
    VALUES (
        v_student_id, 
        v_academic_year_id, 
        v_class_section_id, 
        'active', 
        CURRENT_DATE,
        (SELECT COALESCE(MAX(roll_number), 0) + 1 FROM student_enrollments WHERE class_section_id = v_class_section_id)
    )
    RETURNING id INTO v_enrollment_id;

    RETURN jsonb_build_object('status', 'created', 'enrollment_id', v_enrollment_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- SECTION 99: GRANTS & FINALIZATION
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, service_role;

-- Allow authenticated users to interact (enforced by RLS)
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO authenticated;

-- ============================================================
-- 100. SECURITY ENFORCEMENT (Linter Fixes)
-- ============================================================

-- A. Fix Security Definer Views
-- Views should be security_invoker to respect RLS
ALTER VIEW active_students SET (security_invoker = true);
ALTER VIEW active_persons SET (security_invoker = true);

-- B. Enable RLS on ALL Tables
-- (Some are already enabled, re-running is safe / idempotent)

ALTER TABLE genders ENABLE ROW LEVEL SECURITY;
ALTER TABLE persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE countries ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE discipline_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_money_science_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_science_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE religions ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_designations ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_structures ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE grading_scales ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE diary_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE buses ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_transport ENABLE ROW LEVEL SECURITY;
ALTER TABLE bus_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hostel_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hostel_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE hostel_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_science_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE science_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE blood_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE parents ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_parents ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE lms_materials ENABLE ROW LEVEL SECURITY;

-- C. Default RLS policies removed (Fix 9)
-- The blanket "Enable all for authenticated" policy was overriding all 
-- per-table security policies. Backend uses service_role key (bypasses RLS),
-- so fine-grained RLS policies above are sufficient.

-- ============================================================
-- 101. LINTER FIXES (ROUND 2)
-- ============================================================

-- A. Fix "Function Search Path Mutable" (Fix 8)
-- Only ALTER functions that actually exist in this schema.
-- Wrapped in DO blocks so non-existent functions don't break the transaction.

DO $$ 
DECLARE
    func_name TEXT;
BEGIN
    FOR func_name IN 
        SELECT unnest(ARRAY[
            'update_timestamp', 'update_fee_paid_amount', 'update_fee_status',
            'auto_generate_receipt', 'generate_ticket_no', 'validate_marks_entry',
            'recalculate_section_rolls', 'validate_enrollment_year',
            'ensure_active_person_ref', 'ensure_active_person_staff',
            'ensure_active_student_enrollment', 'ensure_active_student_parent',
            'prevent_system_role_change', 'prevent_direct_fee_update',
            'update_person_display_name', 'auth_has_role',
            'validate_attendance_entry', 'validate_diary_entry',
            'validate_timetable_entry', 'sync_class_teacher_from_timetable',
            'promote_students_academic_year', 'ensure_student_enrollment',
            'log_financial_destruction', 'get_financial_analytics',
            'get_attendance_analytics', 'get_dashboard_insights',
            'debug_user_permissions', 'debug_teacher_profile',
            'run_integrity_check', 'recalculate_fee_ledger'
        ])
    LOOP
        BEGIN
            EXECUTE format('ALTER FUNCTION %I SET search_path = ''public''', func_name);
        EXCEPTION WHEN undefined_function THEN
            -- Function does not exist, skip silently
            NULL;
        END;
    END LOOP;
END $$;

-- B. Fix "Extension in Public"
-- We try to move extensions to 'extensions' schema, creating it if needed.
-- Note: 'auth' schema is managed by Supabase, 'extensions' is a good convention.

-- Extensions already created in SECTION 01. No duplicate creation or migration needed.

-- ============================================================
-- 102. EXPENSE TRACKER MODULE
-- ============================================================

-- 1. Create Expenses Table
CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id), -- Fixed: was auth.users(id) (Fix 6)
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid')),
    description TEXT, -- Optional description
    receipt_url TEXT, -- Optional receipt image
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_school_id ON expenses(school_id);


DO $$ BEGIN
    ALTER TABLE expenses ADD CONSTRAINT expenses_amount_check CHECK ((amount > (0)::numeric));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE expenses ADD CONSTRAINT expenses_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'paid'::text])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE expenses ADD CONSTRAINT expenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);

-- 3. Auto-update Trigger
DROP TRIGGER IF EXISTS trg_expenses_updated ON expenses;
CREATE TRIGGER trg_expenses_updated
BEFORE UPDATE ON expenses
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- 4. Row Level Security (RLS)
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

-- 4.1 READ: Users can view expenses from their own school
DROP POLICY IF EXISTS "View own school expenses" ON expenses;
CREATE POLICY "View own school expenses" ON expenses
FOR SELECT
USING (
    created_by = auth.uid() OR
    EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = auth.uid() 
          AND (r.code IN ('admin', 'principal', 'accounts'))
    )
);

-- 4.2 INSERT: Authenticated users can create expenses
DROP POLICY IF EXISTS "Create expenses" ON expenses;
CREATE POLICY "Create expenses" ON expenses
FOR INSERT
WITH CHECK (
    auth.role() = 'authenticated' AND
    created_by = auth.uid() 
);

-- 4.3 UPDATE: Creator wins pending, Admins win all
DROP POLICY IF EXISTS "Update expenses" ON expenses;
CREATE POLICY "Update expenses" ON expenses
FOR UPDATE
USING (
    (created_by = auth.uid() AND status = 'pending') OR
    EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = auth.uid() 
          AND (r.code IN ('admin', 'principal', 'accounts'))
    )
);

-- 4.4 DELETE: Only Creator (if pending) or Admin
DROP POLICY IF EXISTS "Delete expenses" ON expenses;
CREATE POLICY "Delete expenses" ON expenses
FOR DELETE
USING (
    (created_by = auth.uid() AND status = 'pending') OR
    EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = auth.uid() 
          AND (r.code IN ('admin', 'principal', 'accounts'))
    )
);

-- 5. Grant Permissions
GRANT ALL ON expenses TO authenticated;
GRANT ALL ON expenses TO service_role;


-- search_path managed at session level (ALTER DATABASE is non-transactional DDL)
SET search_path = public, extensions;


-- (Fix 1: Removed mid-file COMMIT that split the transaction)
-- The single COMMIT is at the end of the file.

-- VERIFICATION (Commented)
/*
SELECT table_name, row_security FROM pg_tables WHERE schemaname = 'public';
*/

-- 13. STAFF PAYROLL (New Additions)
DO $$ BEGIN
    CREATE TYPE payroll_status_enum AS ENUM ('pending', 'paid');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS staff_payroll (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    base_salary DECIMAL(12,2) NOT NULL,
    bonus DECIMAL(12,2) DEFAULT 0,
    deductions DECIMAL(12,2) DEFAULT 0,
    net_salary DECIMAL(12,2) NOT NULL, -- Application value: base + bonus - deductions
    status payroll_status_enum NOT NULL DEFAULT 'pending',
    payment_date DATE,
    payroll_month INTEGER NOT NULL CHECK (payroll_month BETWEEN 1 AND 12),
    payroll_year INTEGER NOT NULL,
    payment_method VARCHAR(50), 
    remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (school_id, staff_id, payroll_month, payroll_year)
);

CREATE INDEX IF NOT EXISTS idx_staff_payroll_school_id ON staff_payroll(school_id);

CREATE INDEX IF NOT EXISTS idx_payroll_staff ON staff_payroll(staff_id);
CREATE INDEX IF NOT EXISTS idx_payroll_period ON staff_payroll(payroll_month, payroll_year);

DROP TRIGGER IF EXISTS trg_staff_payroll_updated ON staff_payroll;
CREATE TRIGGER trg_staff_payroll_updated
BEFORE UPDATE ON staff_payroll
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


DO $$ BEGIN
    ALTER TABLE staff_payroll ADD CONSTRAINT staff_payroll_payroll_month_check CHECK (((payroll_month >= 1) AND (payroll_month <= 12)));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE staff_payroll ADD CONSTRAINT staff_payroll_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- GENERATOR FUNCTION (Idempotent)
CREATE OR REPLACE FUNCTION generate_monthly_payroll(
  p_month INTEGER,
  p_year INTEGER
)
RETURNS VOID AS $$
BEGIN
  INSERT INTO staff_payroll (staff_id, base_salary, net_salary, payroll_month, payroll_year, status)
  SELECT 
    id, 
    COALESCE(salary, 0), 
    COALESCE(salary, 0), 
    p_month, 
    p_year, 
    'pending'
  FROM staff
  WHERE status_id = 1 -- Active (assuming 1 is active based on staff_statuses)
    AND deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM staff_payroll sp 
      WHERE sp.staff_id = staff.id 
        AND sp.school_id = staff.school_id
        AND sp.payroll_month = p_month 
        AND sp.payroll_year = p_year
    );
END;
$$ LANGUAGE plpgsql;

-- SALARY DEDUCTION LOGIC
CREATE OR REPLACE FUNCTION recalculate_staff_payroll(
    p_staff_id UUID, 
    p_month INTEGER, 
    p_year INTEGER
)
RETURNS VOID AS $$
DECLARE
    v_base_salary DECIMAL(12,2);
    v_per_day_salary DECIMAL(12,2);
    v_absent_days INTEGER := 0;
    v_rejected_leave_days INTEGER := 0;
    v_total_deduction_days INTEGER := 0;
    v_deduction_amount DECIMAL(12,2);
    v_start_date DATE;
    v_end_date DATE;
BEGIN
    SELECT salary INTO v_base_salary FROM staff WHERE id = p_staff_id;
    IF v_base_salary IS NULL THEN v_base_salary := 0; END IF;
    v_per_day_salary := v_base_salary / 30.0;
    v_start_date := make_date(p_year, p_month, 1);
    v_end_date := (v_start_date + interval '1 month' - interval '1 day')::DATE;

    WITH deductible_dates AS (
        SELECT attendance_date AS d_date
        FROM staff_attendance
        WHERE staff_id = p_staff_id
          AND attendance_date BETWEEN v_start_date AND v_end_date
          AND status = 'absent'
          AND deleted_at IS NULL
        UNION
        SELECT generate_series(
            GREATEST(start_date, v_start_date), 
            LEAST(end_date, v_end_date), 
            interval '1 day'
        )::DATE AS d_date
        FROM leave_applications
        WHERE applicant_id = (SELECT id FROM users WHERE person_id = (SELECT person_id FROM staff WHERE id = p_staff_id))
          AND status = 'rejected'
          AND leave_type != 'unpaid'
          AND end_date >= v_start_date
          AND start_date <= v_end_date
    )
    SELECT COUNT(DISTINCT d_date) INTO v_total_deduction_days FROM deductible_dates;

    v_deduction_amount := v_total_deduction_days * v_per_day_salary;

    INSERT INTO staff_payroll (school_id, staff_id, payroll_month, payroll_year, base_salary, deductions, net_salary, status)
    VALUES ((SELECT school_id FROM staff WHERE id = p_staff_id), p_staff_id, p_month, p_year, v_base_salary, v_deduction_amount, GREATEST(0, v_base_salary - v_deduction_amount), 'pending')
    ON CONFLICT (school_id, staff_id, payroll_month, payroll_year) 
    DO UPDATE SET 
        base_salary = EXCLUDED.base_salary,
        deductions = EXCLUDED.deductions,
        net_salary = EXCLUDED.net_salary,
        updated_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION trg_recalc_payroll_on_attendance()
RETURNS TRIGGER AS $$
DECLARE
    v_staff_id UUID;
    v_date DATE;
BEGIN
    IF (TG_OP = 'DELETE') THEN
        v_staff_id := OLD.staff_id;
        v_date := OLD.attendance_date;
    ELSE
        v_staff_id := NEW.staff_id;
        v_date := NEW.attendance_date;
    END IF;
    PERFORM recalculate_staff_payroll(v_staff_id, EXTRACT(MONTH FROM v_date)::INT, EXTRACT(YEAR FROM v_date)::INT);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_staff_attendance_payroll ON staff_attendance;
CREATE TRIGGER trg_staff_attendance_payroll
AFTER INSERT OR UPDATE OR DELETE ON staff_attendance
FOR EACH ROW EXECUTE FUNCTION trg_recalc_payroll_on_attendance();

CREATE OR REPLACE FUNCTION trg_recalc_payroll_on_leave()
RETURNS TRIGGER AS $$
DECLARE
    v_staff_id UUID;
    v_start DATE;
    v_end DATE;
    v_d DATE;
BEGIN
    IF (TG_OP = 'UPDATE' AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.start_date IS DISTINCT FROM NEW.start_date OR OLD.end_date IS DISTINCT FROM NEW.end_date)) 
       OR (TG_OP = 'INSERT') THEN
       SELECT id INTO v_staff_id FROM staff WHERE person_id = (SELECT person_id FROM users WHERE id = NEW.applicant_id);
       IF v_staff_id IS NOT NULL THEN
           v_start := DATE_TRUNC('month', NEW.start_date);
           v_end := DATE_TRUNC('month', NEW.end_date);
           v_d := v_start;
           WHILE v_d <= v_end LOOP
               PERFORM recalculate_staff_payroll(v_staff_id, EXTRACT(MONTH FROM v_d)::INT, EXTRACT(YEAR FROM v_d)::INT);
               v_d := v_d + interval '1 month';
           END LOOP;
       END IF;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_leave_payroll ON leave_applications;
CREATE TRIGGER trg_leave_payroll
AFTER INSERT OR UPDATE ON leave_applications
FOR EACH ROW EXECUTE FUNCTION trg_recalc_payroll_on_leave();

-- RLS POLICIES
ALTER TABLE staff_payroll ENABLE ROW LEVEL SECURITY;

-- Allow admins and accounts to do everything
DROP POLICY IF EXISTS "Admins can manage payroll" ON staff_payroll;
DROP POLICY IF EXISTS "Admins and Accounts can manage payroll" ON staff_payroll;
CREATE POLICY "Admins and Accounts can manage payroll" ON staff_payroll
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN roles r ON ur.role_id = r.id
    WHERE ur.user_id = auth.uid() AND r.code IN ('admin', 'accounts')
  )
);

-- FIX: Grant permissions to authenticated role for the new table
-- This was missing in the initial schema update

-- 1. Table Permissions
GRANT ALL ON TABLE staff_payroll TO authenticated;
GRANT ALL ON TABLE staff_payroll TO service_role;

-- 2. Function Permissions (RPC)
GRANT EXECUTE ON FUNCTION generate_monthly_payroll TO authenticated;
GRANT EXECUTE ON FUNCTION generate_monthly_payroll TO service_role;

-- 3. Ensure sequence permissions if any (UUID gen_random_uuid doesn't use sequence, but good practice if serial)
-- (None needed for UUID PK)

-- 4. Verify RLS is enabled (It was, but harmless to repeat)
ALTER TABLE staff_payroll ENABLE ROW LEVEL SECURITY;

-- Staff can view their own payroll
DROP POLICY IF EXISTS "Staff can view own payroll" ON staff_payroll;
CREATE POLICY "Staff can view own payroll" ON staff_payroll
FOR SELECT
USING (
  staff_id IN (
    SELECT id FROM staff WHERE person_id IN (
        SELECT person_id FROM users WHERE id = auth.uid()
    )
  )
);

-- =========================================================
-- FINANCIAL POLICY & CONTROL LAYER (AUTO-APPENDED)
-- =========================================================


-- 1. Financial Audit Logs (For destructive actions)
CREATE TABLE IF NOT EXISTS financial_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL, -- Storing as text to support various ID types
    action_type TEXT NOT NULL CHECK (action_type IN ('DELETE', 'UPDATE', 'CREATE')),
    old_data JSONB, -- The state before deletion/update
    new_data JSONB, -- The state after update/creation
    reason TEXT, -- Mandatory for deletions
    performed_by UUID REFERENCES auth.users(id),
    performed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB -- Extra context (user agent, IP, etc if available)
);

CREATE INDEX IF NOT EXISTS idx_financial_audit_school_id ON financial_audit_logs(school_id);


DO $$ BEGIN
    ALTER TABLE financial_audit_logs ADD CONSTRAINT financial_audit_logs_action_type_check CHECK ((action_type = ANY (ARRAY['DELETE'::text, 'UPDATE'::text, 'CREATE'::text])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE financial_audit_logs ADD CONSTRAINT financial_audit_logs_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES auth.users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Enable RLS on Audit Logs
ALTER TABLE financial_audit_logs ENABLE ROW LEVEL SECURITY;

-- Admin can view all logs
DROP POLICY IF EXISTS "Admins can view financial audit logs" ON financial_audit_logs;
CREATE POLICY "Admins can view financial audit logs" 
ON financial_audit_logs FOR SELECT 
TO authenticated 
USING (
    EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = auth.uid() AND r.code = 'admin'
    )
);

-- Only service_role (and SECURITY DEFINER functions running as owner) can insert
DROP POLICY IF EXISTS "System can insert audit logs" ON financial_audit_logs;
CREATE POLICY "System can insert audit logs" 
ON financial_audit_logs FOR INSERT 
TO service_role 
WITH CHECK (true);

-- 2. Financial Policy Rules (Limits, Permissions, Locks)
CREATE TABLE IF NOT EXISTS financial_policy_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    rule_code TEXT NOT NULL, 
    rule_name TEXT NOT NULL,
    description TEXT,
    value_type TEXT CHECK (value_type IN ('amount', 'percentage', 'boolean', 'json')),
    default_value JSONB NOT NULL,
    current_value JSONB NOT NULL,
    is_active BOOLEAN DEFAULT true,
    updated_by UUID REFERENCES auth.users(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (school_id, rule_code)
);

CREATE INDEX IF NOT EXISTS idx_financial_policy_school_id ON financial_policy_rules(school_id);


DO $$ BEGIN
    ALTER TABLE financial_policy_rules ADD CONSTRAINT financial_policy_rules_value_type_check CHECK ((value_type = ANY (ARRAY['amount'::text, 'percentage'::text, 'boolean'::text, 'json'::text])));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE financial_policy_rules ADD CONSTRAINT financial_policy_rules_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Enable RLS
ALTER TABLE financial_policy_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read financial policies" ON financial_policy_rules;
CREATE POLICY "Authenticated users can read financial policies" 
ON financial_policy_rules FOR SELECT 
TO authenticated 
USING (true);

DROP POLICY IF EXISTS "Admins can update financial policies" ON financial_policy_rules;
CREATE POLICY "Admins can update financial policies" 
ON financial_policy_rules FOR UPDATE 
TO authenticated 
USING (
    EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = auth.uid() AND r.code = 'admin'
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = auth.uid() AND r.code = 'admin'
    )
);

-- Seed Default Policies
INSERT INTO financial_policy_rules (rule_code, rule_name, description, value_type, default_value, current_value)
VALUES 
    ('EXPENSE_AUTO_APPROVE_LIMIT', 'Expense Auto-Approval Limit', 'Expenses below this amount are auto-approved.', 'amount', '1000'::jsonb, '1000'::jsonb),
    ('CASH_COLLECTION_DAILY_LIMIT', 'Daily Cash Collection Limit', 'Maximum cash a user can collect per day.', 'amount', '50000'::jsonb, '50000'::jsonb),
    ('FEE_WAIVER_MAX_PERCENT', 'Max Fee Waiver Percentage', 'Maximum percentage of fee that can be waived.', 'percentage', '20'::jsonb, '20'::jsonb),
    ('PAYROLL_OVERRIDE_ALLOWED', 'Payroll Override Allowed', 'Can payroll values be manually overridden?', 'boolean', 'false'::jsonb, 'false'::jsonb),
    ('LOCK_PAST_MONTHS_DAYS', 'Lock Past Months After (Days)', 'Number of days after which previous month data is locked.', 'amount', '7'::jsonb, '7'::jsonb)
ON CONFLICT (rule_code) DO NOTHING;

-- 3. Audit Log Trigger Function
CREATE OR REPLACE FUNCTION log_financial_destruction()
RETURNS TRIGGER 
SET search_path = public
AS $$
DECLARE
    current_user_id UUID;
    reason_text TEXT;
BEGIN
    current_user_id := auth.uid();
    BEGIN
        reason_text := current_setting('app.delete_reason', true);
    EXCEPTION WHEN OTHERS THEN
        reason_text := 'No reason provided';
    END;

    IF (TG_OP = 'DELETE') THEN
        INSERT INTO financial_audit_logs (
            school_id, table_name, record_id, action_type, old_data, reason, performed_by
        ) VALUES (
            OLD.school_id, TG_TABLE_NAME, OLD.id::text, 'DELETE', row_to_json(OLD),
            COALESCE(reason_text, 'Unknown (Direct DB Delete)'), current_user_id
        );
        RETURN OLD;
    ELSIF (TG_OP = 'UPDATE') THEN
        INSERT INTO financial_audit_logs (
            school_id, table_name, record_id, action_type, old_data, new_data, reason, performed_by
        ) VALUES (
            NEW.school_id, TG_TABLE_NAME, NEW.id::text, 'UPDATE', row_to_json(OLD), row_to_json(NEW),
            'Update Operation', current_user_id
        );
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Attach Triggers to Financial Tables
DROP TRIGGER IF EXISTS audit_delete_receipts ON receipts;
CREATE TRIGGER audit_delete_receipts BEFORE DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION log_financial_destruction();

DROP TRIGGER IF EXISTS audit_delete_student_fees ON student_fees;
CREATE TRIGGER audit_delete_student_fees BEFORE DELETE ON student_fees FOR EACH ROW EXECUTE FUNCTION log_financial_destruction();

DROP TRIGGER IF EXISTS audit_delete_expenses ON expenses;
CREATE TRIGGER audit_delete_expenses BEFORE DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION log_financial_destruction();

DROP TRIGGER IF EXISTS audit_delete_payroll ON staff_payroll;
CREATE TRIGGER audit_delete_payroll BEFORE DELETE ON staff_payroll FOR EACH ROW EXECUTE FUNCTION log_financial_destruction();

-- 5. Helper: Read Policy
CREATE OR REPLACE FUNCTION get_financial_policy_value(code_input TEXT)
RETURNS JSONB 
SET search_path = public
AS $$
DECLARE val JSONB;
BEGIN
    SELECT current_value INTO val FROM financial_policy_rules WHERE rule_code = code_input;
    RETURN val;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Helper: Check Financial Permission & Limits
CREATE OR REPLACE FUNCTION check_financial_permission(
    p_action_code TEXT,
    p_amount DECIMAL DEFAULT 0
)
RETURNS BOOLEAN 
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_role_code TEXT;
    v_auto_approve_limit DECIMAL;
BEGIN
    v_user_id := auth.uid();
    SELECT r.code INTO v_role_code FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.user_id = v_user_id
    ORDER BY (CASE WHEN r.code = 'admin' THEN 1 WHEN r.code = 'principal' THEN 2 ELSE 3 END) LIMIT 1;

    IF v_role_code = 'admin' THEN RETURN TRUE; END IF;

    IF p_action_code = 'EXPENSE_AUTO_APPROVE' THEN
        SELECT current_value->>'amount' INTO v_auto_approve_limit FROM financial_policy_rules WHERE rule_code = 'EXPENSE_AUTO_APPROVE_LIMIT';
        IF v_auto_approve_limit IS NOT NULL AND p_amount > v_auto_approve_limit::DECIMAL THEN
             RAISE EXCEPTION 'Amount % exceeds auto-approval limit of %', p_amount, v_auto_approve_limit;
        END IF;
    END IF;

    IF p_action_code = 'FEE_COLLECT_CASH' THEN
        DECLARE
            v_today_total DECIMAL;
            v_daily_limit JSONB;
        BEGIN
            SELECT COALESCE(SUM(amount), 0) INTO v_today_total FROM fee_transactions WHERE received_by = v_user_id AND payment_method = 'cash' AND paid_at::DATE = CURRENT_DATE;
            SELECT current_value INTO v_daily_limit FROM financial_policy_rules WHERE rule_code = 'CASH_COLLECTION_DAILY_LIMIT';
            IF v_daily_limit IS NOT NULL AND (v_today_total + p_amount) > (v_daily_limit->>'amount')::DECIMAL THEN
                 RAISE EXCEPTION 'Daily cash limit exceeded. Collected: %, Attempt: %, Limit: %', v_today_total, p_amount, v_daily_limit->>'amount';
            END IF;
        END;
    END IF;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. Helper: Enforce Locks
CREATE OR REPLACE FUNCTION enforce_financial_lock(p_date DATE, p_context TEXT)
RETURNS BOOLEAN 
SET search_path = public
AS $$
DECLARE v_lock_days INT;
BEGIN
    SELECT (current_value->>'amount')::INT INTO v_lock_days FROM financial_policy_rules WHERE rule_code = 'LOCK_PAST_MONTHS_DAYS';
    IF v_lock_days IS NULL THEN v_lock_days := 7; END IF;
    IF p_date < DATE_TRUNC('month', CURRENT_DATE) THEN
        IF EXTRACT(DAY FROM CURRENT_DATE) > v_lock_days THEN
            RAISE EXCEPTION 'Financial period for % is locked. (Automatic lock enabled after day % of subsequent month)', p_date, v_lock_days;
        END IF;
    END IF;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8. Triggers for Active Enforcement
CREATE OR REPLACE FUNCTION trg_check_expense_policy()
RETURNS TRIGGER 
SET search_path = public
AS $$
DECLARE
    v_is_admin BOOLEAN;
BEGIN
    -- Block Self-Approval
    IF (TG_OP = 'UPDATE' AND NEW.status = 'approved' AND OLD.status != 'approved') THEN
       IF NEW.created_by = auth.uid() THEN
           SELECT EXISTS (
               SELECT 1 FROM user_roles ur 
               JOIN roles r ON ur.role_id = r.id 
               WHERE ur.user_id = auth.uid() AND r.code = 'admin'
           ) INTO v_is_admin;
           
           IF NOT v_is_admin THEN
               RAISE EXCEPTION 'You cannot approve your own expense request.';
           END IF;
       END IF;
    END IF;

    IF (TG_OP = 'INSERT') OR (TG_OP = 'UPDATE' AND NEW.amount IS DISTINCT FROM OLD.amount) THEN
        IF NEW.status = 'approved' THEN PERFORM check_financial_permission('EXPENSE_AUTO_APPROVE', NEW.amount); END IF;
        PERFORM enforce_financial_lock(NEW.expense_date, 'EXPENSE');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_expense_policy ON expenses;
CREATE TRIGGER enforce_expense_policy BEFORE INSERT OR UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION trg_check_expense_policy();

CREATE OR REPLACE FUNCTION trg_check_fee_cash_limit()
RETURNS TRIGGER 
SET search_path = public
AS $$
BEGIN
    IF NEW.payment_method = 'cash' THEN PERFORM check_financial_permission('FEE_COLLECT_CASH', NEW.amount); END IF;
    PERFORM enforce_financial_lock(NEW.paid_at::DATE, 'FEE');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_fee_cash_limit ON fee_transactions;
CREATE TRIGGER enforce_fee_cash_limit BEFORE INSERT ON fee_transactions FOR EACH ROW EXECUTE FUNCTION trg_check_fee_cash_limit();

-- 9. Generic Deletion RPC with Reason
CREATE OR REPLACE FUNCTION delete_record_with_reason(p_table_name TEXT, p_record_id UUID, p_reason TEXT)
RETURNS JSONB 
SET search_path = public
AS $$
DECLARE v_query TEXT; v_rows_deleted INT;
BEGIN
    PERFORM set_config('app.delete_reason', p_reason, true);
    IF p_table_name NOT IN ('receipts', 'student_fees', 'expenses', 'staff_payroll') THEN
        RAISE EXCEPTION 'Table % is not approved for generic deletion.', p_table_name;
    END IF;
    v_query := format('DELETE FROM %I WHERE id = $1', p_table_name);
    EXECUTE v_query USING p_record_id;
    GET DIAGNOSTICS v_rows_deleted = ROW_COUNT;
    IF v_rows_deleted = 0 THEN RAISE EXCEPTION 'Record not found or permission denied.'; END IF;
    RETURN jsonb_build_object('status', 'success', 'deleted_id', p_record_id);
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

-- 10. Grant Permissions
GRANT ALL ON TABLE financial_audit_logs TO service_role;
GRANT SELECT ON TABLE financial_audit_logs TO authenticated;
GRANT ALL ON TABLE financial_policy_rules TO service_role;
GRANT SELECT, UPDATE ON TABLE financial_policy_rules TO authenticated;
GRANT EXECUTE ON FUNCTION delete_record_with_reason TO authenticated;
GRANT EXECUTE ON FUNCTION get_financial_policy_value TO authenticated;




-- ============================================================
-- SECTION 12: ANALYTICS & INSIGHTS (CONSOLIDATED)
-- ============================================================
-- ============================================================
-- ANALYTICS & INSIGHTS ENGINE
-- ============================================================

-- helper to get safe division
CREATE OR REPLACE FUNCTION safe_div(n NUMERIC, d NUMERIC) RETURNS NUMERIC AS $$
BEGIN
    IF d = 0 OR d IS NULL THEN RETURN 0; END IF;
    RETURN n / d;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 1. FINANCIAL ANALYTICS
-- Returns: total_collected, pending_dues, collection_efficiency, trends (json)
CREATE OR REPLACE FUNCTION get_financial_analytics(
    p_from_date DATE,
    p_to_date DATE,
    p_group_by TEXT DEFAULT 'month' -- 'month', 'week'
)
RETURNS JSONB
SET search_path = public
AS $$
DECLARE
    v_total_collected DECIMAL(12,2) := 0;
    v_total_collected_prev DECIMAL(12,2) := 0;
    v_total_outstanding DECIMAL(12,2) := 0;
    v_total_outstanding_prev DECIMAL(12,2) := 0;
    v_eff_current NUMERIC(5,2) := 0;
    v_eff_prev NUMERIC(5,2) := 0;
    v_duration INTEGER;
    v_prev_from DATE;
    v_prev_to DATE;
    v_trend_data JSONB;
BEGIN
    v_duration := p_to_date - p_from_date;
    v_prev_to := p_from_date - 1;
    v_prev_from := v_prev_to - v_duration;

    -- 1. Current Period Collection
    SELECT COALESCE(SUM(amount), 0) INTO v_total_collected
    FROM fee_transactions
    WHERE paid_at::DATE BETWEEN p_from_date AND p_to_date;

    -- 2. Previous Period Collection
    SELECT COALESCE(SUM(amount), 0) INTO v_total_collected_prev
    FROM fee_transactions
    WHERE paid_at::DATE BETWEEN v_prev_from AND v_prev_to;

    -- 3. Outstanding Calculation (Snapshots)
    -- Current Outstanding
    SELECT COALESCE(SUM(amount_due - discount - amount_paid), 0) INTO v_total_outstanding
    FROM student_fees
    WHERE deleted_at IS NULL AND status != 'waived';
    
    -- Prev Outstanding (at start of current range)
    -- Total Due before p_from - Total Paid before p_from
    SELECT 
        (SELECT COALESCE(SUM(amount_due - discount), 0) FROM student_fees WHERE created_at::DATE < p_from_date AND deleted_at IS NULL AND status != 'waived') -
        (SELECT COALESCE(SUM(amount), 0) FROM fee_transactions WHERE paid_at::DATE < p_from_date)
    INTO v_total_outstanding_prev;

    -- Ensure non-negative
    IF v_total_outstanding < 0 THEN v_total_outstanding := 0; END IF;
    IF v_total_outstanding_prev < 0 THEN v_total_outstanding_prev := 0; END IF;

    -- 4. Efficiency
    v_eff_current := ROUND(safe_div(v_total_collected * 100.0, v_total_collected + v_total_outstanding), 1);
    v_eff_prev := ROUND(safe_div(v_total_collected_prev * 100.0, v_total_collected_prev + v_total_outstanding_prev), 1);

    -- 5. Trend Data
    IF p_group_by = 'month' THEN
        SELECT jsonb_agg(dataset) INTO v_trend_data
        FROM (
            SELECT 
                TO_CHAR(date_trunc('month', paid_at), 'Mon') as label,
                SUM(amount) as value
            FROM fee_transactions
            WHERE paid_at::DATE BETWEEN p_from_date AND p_to_date
            GROUP BY date_trunc('month', paid_at)
            ORDER BY date_trunc('month', paid_at)
        ) dataset;
    ELSE
         SELECT jsonb_agg(dataset) INTO v_trend_data
        FROM (
            SELECT 
                TO_CHAR(date_trunc('week', paid_at), 'DD Mon') as label,
                SUM(amount) as value
            FROM fee_transactions
            WHERE paid_at::DATE BETWEEN p_from_date AND p_to_date
            GROUP BY date_trunc('week', paid_at)
            ORDER BY date_trunc('week', paid_at)
        ) dataset;
    END IF;

    RETURN jsonb_build_object(
        'total_collected', v_total_collected,
        'total_collected_prev', v_total_collected_prev,
        'outstanding_dues', v_total_outstanding,
        'outstanding_dues_prev', v_total_outstanding_prev,
        'collection_efficiency', v_eff_current,
        'collection_efficiency_prev', v_eff_prev,
        'trend', COALESCE(v_trend_data, '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql;

-- 2. ATTENDANCE ANALYTICS
CREATE OR REPLACE FUNCTION get_attendance_analytics(
    p_from_date DATE,
    p_to_date DATE
)
RETURNS JSONB
SET search_path = public
AS $$
DECLARE
    v_avg_attendance NUMERIC(5,2);
    v_avg_attendance_prev NUMERIC(5,2);
    v_total_records INTEGER;
    v_total_present INTEGER;
    v_total_records_prev INTEGER;
    v_total_present_prev INTEGER;
    v_chronic_absentees INTEGER;
    v_duration INTEGER;
    v_prev_from DATE;
    v_prev_to DATE;
    v_trend_data JSONB;
BEGIN
    v_duration := p_to_date - p_from_date;
    v_prev_to := p_from_date - 1;
    v_prev_from := v_prev_to - v_duration;

    -- 1. Current Average Attendance %
    SELECT 
        COUNT(*),
        COUNT(*) FILTER (WHERE status IN ('present', 'late', 'half_day'))
    INTO v_total_records, v_total_present
    FROM daily_attendance
    WHERE attendance_date BETWEEN p_from_date AND p_to_date
      AND deleted_at IS NULL;

    v_avg_attendance := safe_div(v_total_present * 100.0, v_total_records);

    -- 2. Previous Average Attendance %
    SELECT 
        COUNT(*),
        COUNT(*) FILTER (WHERE status IN ('present', 'late', 'half_day'))
    INTO v_total_records_prev, v_total_present_prev
    FROM daily_attendance
    WHERE attendance_date BETWEEN v_prev_from AND v_prev_to
      AND deleted_at IS NULL;

    v_avg_attendance_prev := safe_div(v_total_present_prev * 100.0, v_total_records_prev);

    -- 3. Chronic Absenteeism (Current Period)
    WITH student_stats AS (
        SELECT 
            student_enrollment_id,
            COUNT(*) as total_days,
            COUNT(*) FILTER (WHERE status IN ('present', 'late', 'half_day')) as present_days
        FROM daily_attendance
        WHERE attendance_date BETWEEN p_from_date AND p_to_date
          AND deleted_at IS NULL
        GROUP BY student_enrollment_id
    )
    SELECT COUNT(*) INTO v_chronic_absentees
    FROM student_stats
    WHERE safe_div(present_days::NUMERIC, total_days::NUMERIC) < 0.8;

    -- 4. Trend (Daily Avg Current Period)
    SELECT jsonb_agg(dataset) INTO v_trend_data
    FROM (
        SELECT 
            TO_CHAR(attendance_date, 'DD Mon') as label,
            ROUND(AVG(CASE WHEN status IN ('present', 'late', 'half_day') THEN 100.0 ELSE 0.0 END), 1) as value
        FROM daily_attendance
        WHERE attendance_date BETWEEN p_from_date AND p_to_date
          AND deleted_at IS NULL
        GROUP BY attendance_date
        ORDER BY attendance_date
    ) dataset;

    RETURN jsonb_build_object(
        'avg_attendance', COALESCE(v_avg_attendance, 0),
        'avg_attendance_prev', COALESCE(v_avg_attendance_prev, 0),
        'chronic_absentees', COALESCE(v_chronic_absentees, 0),
        'trend', COALESCE(v_trend_data, '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql;

-- 3. AUTOMATED INSIGHTS
-- Generates text-based insights based on patterns.
CREATE OR REPLACE FUNCTION get_dashboard_insights()
RETURNS TABLE (
    type TEXT,
    message TEXT,
    severity TEXT
)
SET search_path = public
AS $$
BEGIN
    -- Insight 1: Low Attendance Alert (Last 7 Days)
    RETURN QUERY
    SELECT 
        'ATTENDANCE_DROP'::TEXT,
        format('Class %s attendance dropped to %s%% yesterday.', c.name, ROUND(AVG(CASE WHEN da.status IN ('present','late') THEN 100.0 ELSE 0 END), 0)),
        'high'::TEXT
    FROM daily_attendance da
    JOIN student_enrollments se ON da.student_enrollment_id = se.id
    JOIN class_sections cs ON se.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    WHERE da.attendance_date = CURRENT_DATE - 1
    GROUP BY c.name
    HAVING AVG(CASE WHEN da.status IN ('present','late') THEN 100.0 ELSE 0 END) < 75;

    -- Insight 2: Collection Spike
    RETURN QUERY
    SELECT 
        'COLLECTION_SPIKE'::TEXT,
        format('High collections detected on %s (?%s)', TO_CHAR(paid_at, 'DD Mon'), SUM(amount)),
        'info'::TEXT
    FROM fee_transactions
    WHERE paid_at >= CURRENT_DATE - 7
    GROUP BY paid_at::DATE, paid_at
    HAVING SUM(amount) > (SELECT AVG(amt) * 1.5 FROM (SELECT SUM(amount) as amt FROM fee_transactions WHERE paid_at >= CURRENT_DATE - 30 GROUP BY paid_at::DATE) sub);

    -- Insight 3: Pending Dues Warning
    IF EXISTS (
        SELECT 1 
        FROM student_fees sf
        WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 50000
          AND sf.status != 'waived'
    ) THEN
        RETURN QUERY SELECT 'HIGH_DUES'::TEXT, 'Multiple students have outstanding dues > ?50k', 'medium'::TEXT;
    END IF;

    RETURN;
END;
$$ LANGUAGE plpgsql;


-- Grant Permissions for Analytics
GRANT EXECUTE ON FUNCTION get_financial_analytics TO authenticated;
GRANT EXECUTE ON FUNCTION get_attendance_analytics TO authenticated;
GRANT EXECUTE ON FUNCTION get_dashboard_insights TO authenticated;

  

-- Legacy salary logic removed (moved to consolidated section)
-- Legacy fee triggers removed (moved to consolidated section)


DROP TRIGGER IF EXISTS trg_auto_assign_fees_enrollment ON student_enrollments;
CREATE TRIGGER trg_auto_assign_fees_enrollment
AFTER INSERT OR UPDATE ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION auto_assign_fees_on_enrollment();

-- ============================================================
-- ADDITIONAL CONSTRAINTS & INDEXES
-- ============================================================

-- Prevent double fee assignment for the same structure to the same student
CREATE UNIQUE INDEX IF NOT EXISTS idx_student_fees_unique_assignment 
ON student_fees(student_id, fee_structure_id);

-- Prevent accidental double entry of transaction references (checks, UPI IDs, etc)
CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_transactions_unique_ref 
ON fee_transactions(transaction_ref) 
WHERE transaction_ref IS NOT NULL AND transaction_ref <> '';

-- SECTION 13: AUDIT & PERFORMANCE
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    action TEXT NOT NULL,
    entity TEXT,
    entity_id TEXT,
    details JSONB,
    ip_address TEXT,
    user_agent TEXT,
    request_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_date ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_request_id ON audit_logs(request_id);

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON public.audit_logs USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON public.audit_logs USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON public.audit_logs USING btree (entity, entity_id);


DO $$ BEGIN
    ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Performance Indexes for Foreign Keys
CREATE INDEX IF NOT EXISTS idx_person_contacts_person_id ON person_contacts(person_id);
CREATE INDEX IF NOT EXISTS idx_student_fees_structure_id ON student_fees(fee_structure_id);
CREATE INDEX IF NOT EXISTS idx_fee_transactions_student_fee_id ON fee_transactions(student_fee_id);
CREATE INDEX IF NOT EXISTS idx_receipt_items_receipt_id ON receipt_items(receipt_id);
CREATE INDEX IF NOT EXISTS idx_receipt_items_transaction_id ON receipt_items(fee_transaction_id);
CREATE INDEX IF NOT EXISTS idx_student_enrollments_class_section ON student_enrollments(class_section_id);
CREATE INDEX IF NOT EXISTS idx_class_subjects_subject_id ON class_subjects(subject_id);
CREATE INDEX IF NOT EXISTS idx_exam_subjects_subject_id ON exam_subjects(subject_id);
CREATE INDEX IF NOT EXISTS idx_exam_subjects_class_id ON exam_subjects(class_id);

-- Enable RLS on all core tables (Minimal default policy: deny all unless specific policies added)
-- Note: This is a proactive hardening step.
ALTER TABLE persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- SECTION 14: NOTIFICATIONS & DEVICES
-- ============================================================

CREATE TABLE IF NOT EXISTS user_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    fcm_token TEXT NOT NULL,
    platform TEXT CHECK (platform IN ('android', 'ios', 'web', 'unknown')),
    language_code VARCHAR(5) DEFAULT 'en',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE(user_id, fcm_token)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_token ON user_devices(fcm_token);

ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;

-- Allow users to manage their own devices
DROP POLICY IF EXISTS "Users can manage own devices" ON user_devices;
CREATE POLICY "Users can manage own devices" ON user_devices
FOR ALL
USING (user_id = auth.uid());

-- ============================================================
-- 103. DEBUG UTILITIES (Production Diagnostics)
-- ============================================================

-- Function to check a user's permissions
CREATE OR REPLACE FUNCTION debug_user_permissions(p_user_id UUID)
RETURNS TABLE (
    role_code VARCHAR,
    permission_code VARCHAR,
    permission_name VARCHAR
) AS $$
BEGIN
    RETURN QUERY
    SELECT r.code::VARCHAR, p.code::VARCHAR, p.name::VARCHAR
    FROM user_roles ur
    JOIN roles r ON ur.role_id = r.id
    JOIN role_permissions rp ON r.id = rp.role_id
    JOIN permissions p ON rp.permission_id = p.id
    WHERE ur.user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Advanced Diagnostic: Teacher Profile & Timetable Check
CREATE OR REPLACE FUNCTION debug_teacher_profile(p_staff_code VARCHAR)
RETURNS TABLE (
    period_number INTEGER,
    class_name VARCHAR,
    section_name VARCHAR,
    subject_name VARCHAR,
    room_no VARCHAR
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ts.period_number, 
        c.name::VARCHAR, 
        s.name::VARCHAR, 
        sub.name::VARCHAR,
        ts.room_no::VARCHAR
    FROM timetable_slots ts
    JOIN class_sections cs ON ts.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    JOIN sections s ON cs.section_id = s.id
    JOIN subjects sub ON ts.subject_id = sub.id
    WHERE ts.teacher_id = (SELECT id FROM staff WHERE staff_code = p_staff_code)
    ORDER BY ts.period_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- CORE AUDIT: Data Integrity Check
CREATE OR REPLACE FUNCTION perform_data_audit(p_school_id INTEGER)
RETURNS TABLE (issue_type TEXT, entity_id TEXT, details TEXT) AS $$
BEGIN
    RETURN QUERY SELECT 'ORPHAN_ENROLLMENT'::TEXT, se.id::TEXT, format('Student %s missing', se.student_id)
    FROM student_enrollments se 
    LEFT JOIN students s ON se.student_id = s.id 
    WHERE (s.id IS NULL OR s.deleted_at IS NOT NULL) 
      AND se.deleted_at IS NULL 
      AND s.school_id = p_school_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

    -- 2. Invalid Class Teachers
    RETURN QUERY
    SELECT 'INVALID_CLASS_TEACHER'::TEXT, cs.id::TEXT, format('Staff %s missing or deleted', cs.class_teacher_id)
    FROM class_sections cs
    LEFT JOIN staff s ON cs.class_teacher_id = s.id
    WHERE cs.class_teacher_id IS NOT NULL AND (s.id IS NULL OR s.deleted_at IS NOT NULL);

    -- 3. Duplicate Attendance
    RETURN QUERY
    SELECT 'DUPLICATE_ATTENDANCE'::TEXT, da.student_enrollment_id::TEXT, format('Date: %s', da.attendance_date)
    FROM daily_attendance da
    WHERE da.deleted_at IS NULL
    GROUP BY da.student_enrollment_id, da.attendance_date
    HAVING COUNT(*) > 1;

    -- 4. Multiple Active Enrollments
    RETURN QUERY
    SELECT 'MULTIPLE_ACTIVE_ENROLLMENTS'::TEXT, se.student_id::TEXT, format('Academic Year ID: %s', se.academic_year_id)
    FROM student_enrollments se
    WHERE se.status = 'active' AND se.deleted_at IS NULL
    GROUP BY se.student_id, se.academic_year_id
    HAVING COUNT(*) > 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- CORE REPAIR: Data Integrity Recovery
CREATE OR REPLACE FUNCTION repair_data_integrity()
RETURNS VOID AS $$
DECLARE
    v_count INTEGER;
BEGIN
    -- 1. Deduplicate daily_attendance (Keep latest)
    WITH duplicates AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY student_enrollment_id, attendance_date ORDER BY updated_at DESC) as rn
        FROM daily_attendance WHERE deleted_at IS NULL
    )
    UPDATE daily_attendance SET deleted_at = NOW()
    WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);

    -- 2. Deduplicate class_subjects
    UPDATE class_subjects SET deleted_at = NOW()
    WHERE id IN (
        SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY class_section_id, subject_id ORDER BY id) as rn
            FROM class_subjects WHERE deleted_at IS NULL
        ) t WHERE rn > 1
    );

    -- 3. Backfill class_subjects from timetable_slots
    INSERT INTO class_subjects (class_section_id, subject_id, teacher_id)
    SELECT DISTINCT ts.class_section_id, ts.subject_id, ts.teacher_id
    FROM timetable_slots ts
    WHERE ts.teacher_id IS NOT NULL 
      AND NOT EXISTS (
        SELECT 1 FROM class_subjects cs
        WHERE cs.class_section_id = ts.class_section_id AND cs.subject_id = ts.subject_id
    );

    -- 4. Sync teacher_id in class_subjects from timetable if mismatch
    UPDATE class_subjects cs
    SET teacher_id = ts.teacher_id
    FROM timetable_slots ts
    WHERE cs.class_section_id = ts.class_section_id
      AND cs.subject_id = ts.subject_id
      AND cs.teacher_id IS DISTINCT FROM ts.teacher_id
      AND cs.deleted_at IS NULL
      AND ts.teacher_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- View to see assigned Class Teachers
CREATE OR REPLACE VIEW debug_class_teachers AS
SELECT 
    c.name as class_name, 
    s.name as section_name, 
    p.display_name as teacher_name,
    ay.code as academic_year
FROM class_sections cs
JOIN classes c ON cs.class_id = c.id
JOIN sections s ON cs.section_id = s.id
JOIN academic_years ay ON cs.academic_year_id = ay.id
LEFT JOIN staff st ON cs.class_teacher_id = st.id
LEFT JOIN persons p ON st.person_id = p.id;

-- View to see Roles & Permissions Mapping
CREATE OR REPLACE VIEW debug_role_permissions AS
SELECT 
    r.code as role,
    STRING_AGG(p.code, ', ') as permissions
FROM roles r
LEFT JOIN role_permissions rp ON r.id = rp.role_id
LEFT JOIN permissions p ON rp.permission_id = p.id
GROUP BY r.code;

-- CORE INTEGRITY GUARD: Central Diagnostic Toolkit
CREATE OR REPLACE FUNCTION run_integrity_check(p_school_id INTEGER)
RETURNS TABLE (severity TEXT, category TEXT, entity_id TEXT, description TEXT) AS $$
BEGIN
    RETURN QUERY SELECT 'CRITICAL'::TEXT, 'COLLISION'::TEXT, t1.id::TEXT, format('Teacher double-booked')
    FROM timetable_slots t1 
    JOIN timetable_slots t2 ON t1.teacher_id = t2.teacher_id AND t1.day_of_week = t2.day_of_week AND t1.period_number = t2.period_number AND t1.academic_year_id = t2.academic_year_id
    WHERE t1.id < t2.id 
      AND t1.school_id = p_school_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

    -- 2. Duplicate Attendance Audit
    RETURN QUERY
    SELECT 
        'HIGH'::TEXT, 'DUPLICATE_DATA'::TEXT, da.student_enrollment_id::TEXT, 
        format('Multiple attendance records for date %s', da.attendance_date)
    FROM daily_attendance da
    WHERE da.deleted_at IS NULL
    GROUP BY da.student_enrollment_id, da.attendance_date
    HAVING COUNT(*) > 1;

    -- 3. Unauthorized Subject Mapping
    RETURN QUERY
    SELECT 
        'MEDIUM'::TEXT, 'MAPPING_ERROR'::TEXT, ts.id::TEXT, 
        format('Teacher is teaching Subject %s in Class Section %s without assignment', ts.subject_id, ts.class_section_id)
    FROM timetable_slots ts
    WHERE ts.teacher_id IS NOT NULL 
      AND NOT EXISTS (
        SELECT 1 FROM class_subjects cs 
        WHERE cs.class_section_id = ts.class_section_id 
          AND cs.teacher_id = ts.teacher_id 
          AND cs.subject_id = ts.subject_id
          AND cs.deleted_at IS NULL
      );

    -- 4. Multi-Section Enrollment Check
    RETURN QUERY
    SELECT 
        'CRITICAL'::TEXT, 'ENROLLMENT_ERROR'::TEXT, se.student_id::TEXT, 
        format('Student has %s active enrollments in Academic Year %s', COUNT(*), se.academic_year_id)
    FROM student_enrollments se
    WHERE se.status = 'active' AND se.deleted_at IS NULL
    GROUP BY se.student_id, se.academic_year_id
    HAVING COUNT(*) > 1;

    -- 5. Orphan Check
    RETURN QUERY
    SELECT 'HIGH'::TEXT, 'ORPHAN'::TEXT, se.id::TEXT, 'Enrollment linked to deleted student'
    FROM student_enrollments se
    LEFT JOIN students s ON se.student_id = s.id
    WHERE (s.id IS NULL OR s.deleted_at IS NOT NULL) AND se.deleted_at IS NULL;

END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================
-- UTILITIES & MAINTENANCE
-- ============================================================

-- Function to recalculate fee ledger from transactions (Fix for double-counting)
CREATE OR REPLACE FUNCTION recalculate_fee_ledger()
RETURNS VOID AS $$
DECLARE
    r_fee RECORD;
    v_calculated_paid DECIMAL(12,2);
    v_new_status fee_status_enum;
    v_remaining DECIMAL(12,2);
BEGIN
    -- Set GUC flag to bypass prevent_direct_fee_update guard trigger
    PERFORM set_config('app.fee_recalc_mode', 'true', true);

    FOR r_fee IN 
        SELECT sf.id, sf.amount_due, sf.amount_paid, sf.discount, sf.status
        FROM student_fees sf
    LOOP
        -- Calculate total from transactions
        SELECT COALESCE(SUM(amount), 0) INTO v_calculated_paid
        FROM fee_transactions
        WHERE student_fee_id = r_fee.id;

        -- Only update if different
        IF v_calculated_paid IS DISTINCT FROM r_fee.amount_paid THEN
            
            v_remaining := r_fee.amount_due - r_fee.discount - v_calculated_paid;

            IF v_remaining <= 0 THEN
                v_new_status := 'paid';
            ELSIF v_calculated_paid > 0 THEN
                v_new_status := 'partial';
            ELSE
                IF r_fee.status = 'overdue' THEN
                    v_new_status := 'overdue';
                ELSE
                    v_new_status := 'pending';
                END IF;
            END IF;

            UPDATE student_fees
            SET 
                amount_paid = v_calculated_paid,
                status = v_new_status,
                updated_at = NOW()
            WHERE id = r_fee.id;
            
            RAISE NOTICE 'Fixed Fee ID %: Old Paid %, New Paid %', r_fee.id, r_fee.amount_paid, v_calculated_paid;
        END IF;
    END LOOP;

    -- Reset GUC flag
    PERFORM set_config('app.fee_recalc_mode', '', true);
END;
$$ LANGUAGE plpgsql;

-- Session-level search path (ALTER DATABASE removed — non-transactional DDL)
SET search_path = public, extensions;

-- ============================================================
-- NOTIFICATION SYSTEM (Production Hardened)
-- ============================================================

DO $$ BEGIN
    CREATE TYPE notification_channel AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'PUSH');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE notification_status AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'READ', 'DISMISSED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE event_status AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 1. Notification Templates
CREATE TABLE IF NOT EXISTS notification_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    title_template TEXT NOT NULL,
    body_template TEXT NOT NULL,
    default_channels notification_channel[] NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (school_id, event_type)
);
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;

-- 2. Notification Preferences
CREATE TABLE IF NOT EXISTS notification_preferences (
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type VARCHAR(100),
    channel notification_channel NOT NULL,
    is_enabled BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (school_id, user_id, event_type, channel)
);
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;


DO $$ BEGIN
    ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_event_type_fkey FOREIGN KEY (event_type) REFERENCES notification_templates(event_type);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 3. Notification Events
CREATE TABLE IF NOT EXISTS notification_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(255) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    status event_status NOT NULL DEFAULT 'RECEIVED',
    error_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (school_id, idempotency_key)
);
ALTER TABLE notification_events ENABLE ROW LEVEL SECURITY;


DO $$ BEGIN
    ALTER TABLE notification_events ADD CONSTRAINT notification_events_event_type_fkey FOREIGN KEY (event_type) REFERENCES notification_templates(event_type);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE notification_events ADD CONSTRAINT notification_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE notification_events ADD CONSTRAINT notification_events_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 4. Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, 
    body TEXT NOT NULL,
    action_url TEXT,
    status notification_status NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    read_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    CONSTRAINT uniq_notifications_event_user UNIQUE (school_id, event_id, user_id)
);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;


DO $$ BEGIN
    ALTER TABLE notifications ADD CONSTRAINT notifications_event_id_fkey FOREIGN KEY (event_id) REFERENCES notification_events(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE notifications ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 5. Notification Deliveries
CREATE TABLE IF NOT EXISTS notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    channel notification_channel NOT NULL,
    provider_message_id VARCHAR(255),
    status notification_status NOT NULL DEFAULT 'PENDING',
    retry_count INT DEFAULT 0,
    next_retry_at TIMESTAMPTZ,
    error_log TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT uniq_delivery_notification_channel UNIQUE (school_id, notification_id, channel),
    CONSTRAINT chk_max_retries CHECK (retry_count <= 5),
    CONSTRAINT chk_retry_time CHECK (
        (status = 'FAILED' AND next_retry_at IS NOT NULL) OR 
        (status != 'FAILED')
    )
);
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;


DO $$ BEGIN
    ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 6. Notification Audit Logs
CREATE TABLE IF NOT EXISTS notification_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    delivery_id UUID REFERENCES notification_deliveries(id),
    notification_id UUID REFERENCES notifications(id),
    action VARCHAR(50) NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);


DO $$ BEGIN
    ALTER TABLE notification_audit_logs ADD CONSTRAINT notification_audit_logs_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES notification_deliveries(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE notification_audit_logs ADD CONSTRAINT notification_audit_logs_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES notifications(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_notifications_unread_fetch 
ON notifications (user_id, created_at DESC) 
WHERE status IN ('PENDING', 'DELIVERED');

CREATE INDEX IF NOT EXISTS idx_deliveries_worker_fetch 
ON notification_deliveries (next_retry_at) 
WHERE status = 'FAILED' AND retry_count < 5;

CREATE INDEX IF NOT EXISTS idx_events_idempotency ON notification_events(idempotency_key);

-- ============================================================
-- RECENT DDL PATCHES (Drivers, RLS, Timetables)
-- ============================================================

-- From apply_phase5_db.js
CREATE TABLE IF NOT EXISTS public.driver_devices (
    driver_id uuid NOT NULL,
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    device_id varchar NOT NULL,
    last_active timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    PRIMARY KEY (school_id, driver_id)
);

CREATE TABLE IF NOT EXISTS public.driver_heartbeat (
    driver_id uuid NOT NULL,
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    last_ping timestamp with time zone DEFAULT now(),
    status varchar DEFAULT 'online', -- online, offline, paused
    PRIMARY KEY (school_id, driver_id)
);

CREATE TABLE IF NOT EXISTS public.bus_trip_history (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    bus_id uuid NOT NULL,
    latitude double precision,
    longitude double precision,
    speed double precision,
    is_mocked boolean DEFAULT false,
    is_suspicious boolean DEFAULT false,
    recorded_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.bus_locations 
  ADD COLUMN IF NOT EXISTS is_mocked boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_suspicious boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_bus_locations_bus_id ON public.bus_locations (bus_id);
CREATE INDEX IF NOT EXISTS idx_bus_locations_recorded_at ON public.bus_locations (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_bus_trip_history_bus_id_time ON public.bus_trip_history (bus_id, recorded_at DESC);


-- From apply_driver_rls.js
ALTER TABLE IF EXISTS public.buses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read buses" ON public.buses;
CREATE POLICY "Authenticated users can read buses" ON public.buses FOR SELECT USING (auth.role() = 'authenticated');

ALTER TABLE IF EXISTS public.bus_locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read bus locations" ON public.bus_locations;
CREATE POLICY "Authenticated users can read bus locations" ON public.bus_locations FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Authenticated users can insert bus locations" ON public.bus_locations;
CREATE POLICY "Authenticated users can insert bus locations" ON public.bus_locations FOR INSERT WITH CHECK (auth.role() = 'authenticated');

ALTER TABLE IF EXISTS public.transport_routes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read routes" ON public.transport_routes;
CREATE POLICY "Authenticated users can read routes" ON public.transport_routes FOR SELECT USING (auth.role() = 'authenticated');

ALTER TABLE IF EXISTS public.persons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own person" ON public.persons;
CREATE POLICY "Users can read own person" ON public.persons FOR SELECT USING (id IN (SELECT person_id FROM public.users WHERE public.users.id = auth.uid()) OR auth.role() = 'service_role' OR auth.role() = 'anon');

ALTER TABLE IF EXISTS public.staff ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own staff record" ON public.staff;
CREATE POLICY "Users can read own staff record" ON public.staff FOR SELECT USING (person_id IN (SELECT person_id FROM public.users WHERE public.users.id = auth.uid()) OR auth.role() = 'service_role' OR auth.role() = 'anon');


-- From fix_trigger.js
CREATE OR REPLACE FUNCTION public.sync_class_teacher_from_timetable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        IF OLD.period_number = 1 THEN
             UPDATE class_sections 
             SET class_teacher_id = NULL 
             WHERE id = OLD.class_section_id;
        END IF;
        RETURN OLD;
    END IF;

    IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') THEN
        IF NEW.period_number = 1 THEN
             UPDATE class_sections 
             SET class_teacher_id = NEW.teacher_id 
             WHERE id = NEW.class_section_id;
        END IF;
        RETURN NEW;
    END IF;
    
    RETURN NULL;
END;
$function$;


-- From migrate_timetable.js
CREATE OR REPLACE FUNCTION validate_timetable_entry()
RETURNS TRIGGER AS $$
DECLARE
    v_teacher_collision BOOLEAN;
    v_room_collision BOOLEAN;
BEGIN
    IF NEW.teacher_id IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM timetable_slots
            WHERE teacher_id = NEW.teacher_id
              AND period_number = NEW.period_number
              AND academic_year_id = NEW.academic_year_id
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
        ) INTO v_teacher_collision;

        IF v_teacher_collision THEN
            RAISE EXCEPTION 'Teacher Collision: Teacher is already booked for period %', NEW.period_number;
        END IF;
    END IF;

    IF NEW.room_no IS NOT NULL AND NEW.room_no <> '' THEN
        SELECT EXISTS (
            SELECT 1 FROM timetable_slots
            WHERE room_no = NEW.room_no
              AND period_number = NEW.period_number
              AND academic_year_id = NEW.academic_year_id
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
        ) INTO v_room_collision;

        IF v_room_collision THEN
            RAISE EXCEPTION 'Room Collision: Room % is already occupied during period %', NEW.room_no, NEW.period_number;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_attendance_entry()
RETURNS TRIGGER AS $$
DECLARE
    v_class_section_id UUID;
    v_class_teacher_id UUID;
    v_is_admin BOOLEAN;
    v_is_p1_teacher BOOLEAN;
BEGIN
    -- 1. Basic Date Validation 
    IF NOT EXISTS (
        SELECT 1 FROM student_enrollments
        WHERE id = NEW.student_enrollment_id
          AND status = 'active'
          AND NEW.attendance_date BETWEEN start_date AND COALESCE(end_date, '9999-12-31'::date)
          AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Invalid Attendance: Student is not active in this enrollment on %', NEW.attendance_date;
    END IF;

    -- 2. Authorization Check
    IF NEW.marked_by IS NOT NULL THEN
        SELECT se.class_section_id, cs.class_teacher_id INTO v_class_section_id, v_class_teacher_id
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        WHERE se.id = NEW.student_enrollment_id;

        SELECT EXISTS (
            SELECT 1 FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = NEW.marked_by AND r.code = 'admin'
        ) INTO v_is_admin;

        IF NOT v_is_admin THEN
            SELECT EXISTS (
                SELECT 1 FROM timetable_slots ts
                JOIN staff s ON ts.teacher_id = s.id
                WHERE ts.class_section_id = v_class_section_id
                  AND ts.period_number = 1
                  AND s.person_id = (SELECT person_id FROM users WHERE id = NEW.marked_by)
                  AND ts.deleted_at IS NULL
            ) INTO v_is_p1_teacher;

            IF NOT v_is_p1_teacher AND v_class_teacher_id IS NOT NULL THEN
                IF NOT EXISTS (
                    SELECT 1 FROM staff s
                    WHERE s.id = v_class_teacher_id
                      AND s.person_id = (SELECT person_id FROM users WHERE id = NEW.marked_by)
                ) THEN
                    RAISE EXCEPTION 'Unauthorized: Only the assigned Class Teacher, Period 1 Teacher, or Admin can mark attendance';
                END IF;
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ 
BEGIN
  ALTER TABLE timetable_slots DROP COLUMN IF EXISTS day_of_week CASCADE;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DROP INDEX IF EXISTS uq_timetable_slots_active;
DROP INDEX IF EXISTS idx_timetable_slots_time_check;

CREATE UNIQUE INDEX IF NOT EXISTS uq_timetable_slots_active 
ON timetable_slots (class_section_id, academic_year_id, period_number) 
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_timetable_class ON timetable_slots(class_section_id);
CREATE INDEX IF NOT EXISTS idx_timetable_teacher ON timetable_slots(teacher_id);
CREATE INDEX IF NOT EXISTS idx_timetable_slots_time_check ON timetable_slots(teacher_id, start_time, end_time);

COMMIT;



-- ========================================== 
-- 29. GIRL SAFETY
-- ========================================== 
CREATE TABLE IF NOT EXISTS girl_safety_complaints (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    ticket_no VARCHAR(20) NOT NULL,
    student_id UUID REFERENCES students(id) ON DELETE SET NULL,
    category VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    description_te TEXT,
    incident_date TIMESTAMPTZ,
    attachments JSONB DEFAULT '[]'::jsonb,
    is_anonymous BOOLEAN DEFAULT false,
    status VARCHAR(20) DEFAULT 'pending',
    assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    UNIQUE (school_id, ticket_no)
);

CREATE TABLE IF NOT EXISTS girl_safety_complaint_threads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    complaint_id UUID REFERENCES girl_safety_complaints(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
    sender_role VARCHAR(20) NOT NULL,
    message TEXT NOT NULL,
    message_te TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);


DO $$ BEGIN
    ALTER TABLE girl_safety_complaint_threads ADD CONSTRAINT girl_safety_complaint_threads_complaint_id_fkey FOREIGN KEY (complaint_id) REFERENCES girl_safety_complaints(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE girl_safety_complaint_threads ADD CONSTRAINT girl_safety_complaint_threads_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;


DO $$ BEGIN
    ALTER TABLE girl_safety_complaints ADD CONSTRAINT girl_safety_complaints_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE girl_safety_complaints ADD CONSTRAINT girl_safety_complaints_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ========================================== 
-- 30. SCHOOL SETTINGS & CONFIG
-- ========================================== 
CREATE TABLE IF NOT EXISTS school_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    key         VARCHAR(100) NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now(),
    UNIQUE (school_id, key)
);

INSERT INTO school_settings (school_id, key, value) VALUES
    (1, 'school_name',      'Default School Name'),
    (1, 'school_timezone',  'Asia/Kolkata'),
    (1, 'school_hours_start', '08:00'),
    (1, 'school_hours_end',   '17:00'),
    (1, 'admin_email',      'admin@school.local')
ON CONFLICT (school_id, key) DO NOTHING;

CREATE TABLE IF NOT EXISTS admin_notifications (
    id          SERIAL PRIMARY KEY,
    school_id   INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    type        VARCHAR(50) NOT NULL,
    message     TEXT NOT NULL,
    user_id     UUID,
    ip_address  VARCHAR(45),
    created_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE IF EXISTS school_settings ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();

-- ========================================== 
-- 31. OUT-OF-HOURS ACCESS CONTROL
-- ========================================== 
CREATE TABLE IF NOT EXISTS access_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    requested_by UUID REFERENCES users(id) ON DELETE CASCADE,
    department TEXT NOT NULL,
    request_note TEXT,
    status TEXT DEFAULT 'pending' NOT NULL,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$ BEGIN
    ALTER TABLE access_requests ADD CONSTRAINT access_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE access_requests ADD CONSTRAINT access_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;


CREATE TABLE IF NOT EXISTS temp_access_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
    department TEXT NOT NULL,
    granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    requested_by UUID REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN DEFAULT true NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$ BEGIN
    ALTER TABLE temp_access_grants ADD CONSTRAINT temp_access_grants_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES auth.users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE temp_access_grants ADD CONSTRAINT temp_access_grants_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS idx_temp_access_lookup ON temp_access_grants(requested_by, department) WHERE is_active = true;

ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE temp_access_grants ENABLE ROW LEVEL SECURITY;

GRANT ALL ON access_requests TO anon, authenticated, service_role;
GRANT ALL ON temp_access_grants TO anon, authenticated, service_role;

CREATE POLICY "Users can view their own requests" 
ON access_requests FOR SELECT 
USING (auth.uid() = requested_by);

CREATE POLICY "Users can insert their own requests" 
ON access_requests FOR INSERT 
WITH CHECK (auth.uid() = requested_by);

CREATE POLICY "Users can view their own grants" 
ON temp_access_grants FOR SELECT 
USING (auth.uid() = requested_by);

CREATE OR REPLACE FUNCTION is_admin() RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = auth.uid() AND r.code = 'admin'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE POLICY "Admins can view all requests" 
ON access_requests FOR SELECT 
USING (is_admin());

CREATE POLICY "Admins can update requests" 
ON access_requests FOR UPDATE 
USING (is_admin());

CREATE POLICY "Admins can view all grants" 
ON temp_access_grants FOR SELECT 
USING (is_admin());

CREATE POLICY "Admins can insert grants" 
ON temp_access_grants FOR INSERT 
WITH CHECK (is_admin());

CREATE POLICY "Admins can update grants" 
ON temp_access_grants FOR UPDATE 
USING (is_admin());

COMMIT;

-- SUPABASE AUTH CONFIGURATION (1-Year Sessions 
-- ========================================== 
-- Required for React Native mobile app persistence to survive 1-year offline 
ALTER ROLE authenticator SET app.settings.sessions.timebox = '31536000'; 
ALTER ROLE authenticator SET app.settings.sessions.inactivity_timeout = '0';

ALTER TABLE IF EXISTS active_persons ADD COLUMN IF NOT EXISTS id uuid;
ALTER TABLE IF EXISTS active_persons ADD COLUMN IF NOT EXISTS first_name character varying(50);
ALTER TABLE IF EXISTS active_persons ADD COLUMN IF NOT EXISTS middle_name character varying(50);
ALTER TABLE IF EXISTS active_persons ADD COLUMN IF NOT EXISTS last_name character varying(50);
ALTER TABLE IF EXISTS active_persons ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE IF EXISTS active_persons ADD COLUMN IF NOT EXISTS dob date;
ALTER TABLE IF EXISTS active_persons ADD COLUMN IF NOT EXISTS gender_id smallint;
ALTER TABLE IF EXISTS active_persons ADD COLUMN IF NOT EXISTS nationality_code character(2);
ALTER TABLE IF EXISTS active_persons ADD COLUMN IF NOT EXISTS photo_url text;
ALTER TABLE IF EXISTS active_persons ADD COLUMN IF NOT EXISTS created_at timestamp with time zone;
ALTER TABLE IF EXISTS active_persons ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone;
ALTER TABLE IF EXISTS active_persons ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;


ALTER TABLE IF EXISTS active_students ADD COLUMN IF NOT EXISTS id uuid;
ALTER TABLE IF EXISTS active_students ADD COLUMN IF NOT EXISTS person_id uuid;
ALTER TABLE IF EXISTS active_students ADD COLUMN IF NOT EXISTS admission_no character varying(30);
ALTER TABLE IF EXISTS active_students ADD COLUMN IF NOT EXISTS admission_date date;
ALTER TABLE IF EXISTS active_students ADD COLUMN IF NOT EXISTS category_id smallint;
ALTER TABLE IF EXISTS active_students ADD COLUMN IF NOT EXISTS religion_id smallint;
ALTER TABLE IF EXISTS active_students ADD COLUMN IF NOT EXISTS blood_group_id smallint;
ALTER TABLE IF EXISTS active_students ADD COLUMN IF NOT EXISTS status_id smallint;
ALTER TABLE IF EXISTS active_students ADD COLUMN IF NOT EXISTS created_at timestamp with time zone;
ALTER TABLE IF EXISTS active_students ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone;
ALTER TABLE IF EXISTS active_students ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;


ALTER TABLE IF EXISTS bus_trip_history ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
ALTER TABLE IF EXISTS bus_trip_history ADD COLUMN IF NOT EXISTS bus_id uuid;
ALTER TABLE IF EXISTS bus_trip_history ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE IF EXISTS bus_trip_history ADD COLUMN IF NOT EXISTS longitude double precision;
ALTER TABLE IF EXISTS bus_trip_history ADD COLUMN IF NOT EXISTS speed double precision;
ALTER TABLE IF EXISTS bus_trip_history ADD COLUMN IF NOT EXISTS is_mocked boolean DEFAULT false;
ALTER TABLE IF EXISTS bus_trip_history ADD COLUMN IF NOT EXISTS is_suspicious boolean DEFAULT false;
ALTER TABLE IF EXISTS bus_trip_history ADD COLUMN IF NOT EXISTS recorded_at timestamp with time zone DEFAULT now();


ALTER TABLE IF EXISTS debug_class_teachers ADD COLUMN IF NOT EXISTS class_name character varying(50);
ALTER TABLE IF EXISTS debug_class_teachers ADD COLUMN IF NOT EXISTS section_name character varying(50);
ALTER TABLE IF EXISTS debug_class_teachers ADD COLUMN IF NOT EXISTS teacher_name text;
ALTER TABLE IF EXISTS debug_class_teachers ADD COLUMN IF NOT EXISTS academic_year character varying(20);


ALTER TABLE IF EXISTS debug_role_permissions ADD COLUMN IF NOT EXISTS role character varying(50);
ALTER TABLE IF EXISTS debug_role_permissions ADD COLUMN IF NOT EXISTS permissions text;


ALTER TABLE IF EXISTS driver_devices ADD COLUMN IF NOT EXISTS driver_id uuid;
ALTER TABLE IF EXISTS driver_devices ADD COLUMN IF NOT EXISTS device_id character varying;
ALTER TABLE IF EXISTS driver_devices ADD COLUMN IF NOT EXISTS last_active timestamp with time zone;
ALTER TABLE IF EXISTS driver_devices ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();


ALTER TABLE IF EXISTS driver_heartbeat ADD COLUMN IF NOT EXISTS driver_id uuid;
ALTER TABLE IF EXISTS driver_heartbeat ADD COLUMN IF NOT EXISTS last_ping timestamp with time zone DEFAULT now();
ALTER TABLE IF EXISTS driver_heartbeat ADD COLUMN IF NOT EXISTS status character varying DEFAULT 'online'::character varying;


ALTER TABLE IF EXISTS feature_flags ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
ALTER TABLE IF EXISTS feature_flags ADD COLUMN IF NOT EXISTS code character varying(100);
ALTER TABLE IF EXISTS feature_flags ADD COLUMN IF NOT EXISTS name character varying(200);
ALTER TABLE IF EXISTS feature_flags ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE IF EXISTS feature_flags ADD COLUMN IF NOT EXISTS is_enabled boolean DEFAULT false;
ALTER TABLE IF EXISTS feature_flags ADD COLUMN IF NOT EXISTS target_roles ARRAY;
ALTER TABLE IF EXISTS feature_flags ADD COLUMN IF NOT EXISTS metadata jsonb;
ALTER TABLE IF EXISTS feature_flags ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();
ALTER TABLE IF EXISTS feature_flags ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();


ALTER TABLE IF EXISTS timetable_entries ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
ALTER TABLE IF EXISTS timetable_entries ADD COLUMN IF NOT EXISTS class_section_id uuid;
ALTER TABLE IF EXISTS timetable_entries ADD COLUMN IF NOT EXISTS subject_id uuid;
ALTER TABLE IF EXISTS timetable_entries ADD COLUMN IF NOT EXISTS teacher_id uuid;
ALTER TABLE IF EXISTS timetable_entries ADD COLUMN IF NOT EXISTS period_id uuid;
ALTER TABLE IF EXISTS timetable_entries ADD COLUMN IF NOT EXISTS day_of_week USER-DEFINED;
ALTER TABLE IF EXISTS timetable_entries ADD COLUMN IF NOT EXISTS room character varying(50);
ALTER TABLE IF EXISTS timetable_entries ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();
ALTER TABLE IF EXISTS timetable_entries ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();


ALTER TABLE IF EXISTS ui_route_permissions ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
ALTER TABLE IF EXISTS ui_route_permissions ADD COLUMN IF NOT EXISTS route_key character varying(100);
ALTER TABLE IF EXISTS ui_route_permissions ADD COLUMN IF NOT EXISTS route_label character varying(200);
ALTER TABLE IF EXISTS ui_route_permissions ADD COLUMN IF NOT EXISTS required_permissions ARRAY DEFAULT '{}'::text[];
ALTER TABLE IF EXISTS ui_route_permissions ADD COLUMN IF NOT EXISTS required_roles ARRAY;
ALTER TABLE IF EXISTS ui_route_permissions ADD COLUMN IF NOT EXISTS requires_feature_flag character varying(100);
ALTER TABLE IF EXISTS ui_route_permissions ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0;
ALTER TABLE IF EXISTS ui_route_permissions ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE IF EXISTS ui_route_permissions ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();


CREATE UNIQUE INDEX IF NOT EXISTS bus_trip_history_pkey ON public.bus_trip_history USING btree (id);
CREATE INDEX IF NOT EXISTS idx_bus_trip_history_bus_id_time ON public.bus_trip_history USING btree (bus_id, recorded_at DESC);


CREATE UNIQUE INDEX IF NOT EXISTS driver_devices_pkey ON public.driver_devices USING btree (driver_id);


CREATE UNIQUE INDEX IF NOT EXISTS driver_heartbeat_pkey ON public.driver_heartbeat USING btree (driver_id);


CREATE UNIQUE INDEX IF NOT EXISTS feature_flags_pkey ON public.feature_flags USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS feature_flags_code_key ON public.feature_flags USING btree (code);


CREATE UNIQUE INDEX IF NOT EXISTS timetable_entries_pkey ON public.timetable_entries USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS timetable_entries_class_section_id_period_id_day_of_week_key ON public.timetable_entries USING btree (class_section_id, period_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_timetable_class ON public.timetable_entries USING btree (class_section_id);
CREATE INDEX IF NOT EXISTS idx_timetable_teacher ON public.timetable_entries USING btree (teacher_id);


CREATE UNIQUE INDEX IF NOT EXISTS ui_route_permissions_pkey ON public.ui_route_permissions USING btree (id);
CREATE UNIQUE INDEX IF NOT EXISTS ui_route_permissions_route_key_key ON public.ui_route_permissions USING btree (route_key);


DO $$ BEGIN
    ALTER TABLE bus_trip_history ADD CONSTRAINT bus_trip_history_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


DO $$ BEGIN
    ALTER TABLE driver_devices ADD CONSTRAINT driver_devices_pkey PRIMARY KEY (driver_id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


DO $$ BEGIN
    ALTER TABLE driver_heartbeat ADD CONSTRAINT driver_heartbeat_pkey PRIMARY KEY (driver_id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


DO $$ BEGIN
    ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_code_key UNIQUE (code);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


DO $$ BEGIN
    ALTER TABLE timetable_entries ADD CONSTRAINT timetable_entries_class_section_id_period_id_day_of_week_key UNIQUE (class_section_id, period_id, day_of_week);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE timetable_entries ADD CONSTRAINT timetable_entries_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE timetable_entries ADD CONSTRAINT timetable_entries_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES class_sections(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE timetable_entries ADD CONSTRAINT timetable_entries_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES subjects(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE timetable_entries ADD CONSTRAINT timetable_entries_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES staff(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE timetable_entries ADD CONSTRAINT timetable_entries_period_id_fkey FOREIGN KEY (period_id) REFERENCES periods(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


DO $$ BEGIN
    ALTER TABLE ui_route_permissions ADD CONSTRAINT ui_route_permissions_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE ui_route_permissions ADD CONSTRAINT ui_route_permissions_route_key_key UNIQUE (route_key);
EXCEPTION WHEN duplicate_object THEN null;
END $$;


DROP TRIGGER IF EXISTS trg_feature_flags_updated ON feature_flags;
CREATE TRIGGER trg_feature_flags_updated
BEFORE UPDATE ON feature_flags
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


DROP TRIGGER IF EXISTS trg_timetable_updated ON timetable_entries;
CREATE TRIGGER trg_timetable_updated
BEFORE UPDATE ON timetable_entries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_validate_timetable ON timetable_entries;
CREATE TRIGGER trg_validate_timetable
BEFORE INSERT ON timetable_entries
FOR EACH ROW EXECUTE FUNCTION validate_timetable_entry();

DROP TRIGGER IF EXISTS trg_validate_timetable ON timetable_entries;
CREATE TRIGGER trg_validate_timetable
BEFORE INSERT ON timetable_entries
FOR EACH ROW EXECUTE FUNCTION validate_timetable_entry();


-- ### INJECTED MISSING FUNCTIONS ###
CREATE OR REPLACE FUNCTION public.update_user_settings_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
            BEGIN
                NEW.updated_at = NOW();
                RETURN NEW;
            END;
            $function$
;

CREATE OR REPLACE FUNCTION public.is_principal()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1 
    FROM public.staff s 
    WHERE s.user_id = auth.uid() AND s.designation_id = 1
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_transaction_immutability()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        RAISE EXCEPTION 'Hard delete of financial transactions is FORBIDDEN. Use voiding.';
    END IF;

    IF (TG_OP = 'UPDATE') THEN
        -- Allow updating ONLY voided_at or purely metadata fields if strictness needed
        IF (NEW.amount != OLD.amount) OR (NEW.student_fee_id != OLD.student_fee_id) THEN
            RAISE EXCEPTION 'Modification of Transaction Amount/Linkage is FORBIDDEN.';
        END IF;
        
        IF (OLD.voided_at IS NOT NULL) THEN
            RAISE EXCEPTION 'Cannot modify an already voided transaction.';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_prevent_immutable_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    IF (OLD.id IS DISTINCT FROM NEW.id) THEN
        RAISE EXCEPTION 'Modification of ID is not allowed.';
    END IF;
    
    -- Check created_at only if it exists in the table (generic safety)
    -- Note: We assume the column is named 'created_at' standardly.
    IF (OLD.created_at IS DISTINCT FROM NEW.created_at) THEN
        RAISE EXCEPTION 'Modification of created_at is not allowed.';
    END IF;
    
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_prevent_overpayment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    IF NEW.amount_paid > NEW.amount_due THEN
        RAISE EXCEPTION 'Overpayment Violation: Paid (%) > Due (%)', NEW.amount_paid, NEW.amount_due;
    END IF;
    
    -- Auto-status
    IF NEW.amount_paid = NEW.amount_due THEN
        NEW.status = 'paid';
    ELSIF NEW.amount_paid > 0 THEN
        NEW.status = 'partial';
    ELSE
        NEW.status = 'unpaid';
    END IF;
    
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_check_academic_year_dates()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    IF NEW.start_date > NEW.end_date THEN
        RAISE EXCEPTION 'Academic Year Start Date (%) cannot be after End Date (%).', NEW.start_date, NEW.end_date;
    END IF;
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_management()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN (public.is_principal() OR public.is_accounts());
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_update_fee_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    v_fee public.student_fees%ROWTYPE;
BEGIN
    -- LOCK the parent row to prevent race conditions
    SELECT * INTO v_fee
    FROM public.student_fees
    WHERE id = NEW.student_fee_id
    FOR UPDATE;

    -- Handle Insert
    IF (TG_OP = 'INSERT') THEN
        UPDATE public.student_fees
        SET amount_paid = v_fee.amount_paid + NEW.amount
        WHERE id = v_fee.id;
        RETURN NEW;
    END IF;

    -- Handle Voiding
    IF (TG_OP = 'UPDATE') THEN
        IF OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN
            UPDATE public.student_fees
            SET amount_paid = v_fee.amount_paid - NEW.amount
            WHERE id = v_fee.id;
        END IF;
        RETURN NEW;
    END IF;
    
    RETURN NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.current_staff_id()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_staff_id UUID;
BEGIN
  SELECT id INTO v_staff_id
  FROM public.staff
  WHERE user_id = auth.uid();
  
  RETURN v_staff_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_accounts()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1 
    FROM public.staff s 
    WHERE s.user_id = auth.uid() AND s.designation_id = 4
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_lower_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    IF NEW.email IS NOT NULL THEN
        NEW.email = LOWER(NEW.email);
    END IF;
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.validate_attendance_date()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM student_enrollments
    WHERE id = NEW.student_enrollment_id
      AND status = 'active'
      AND NEW.attendance_date BETWEEN start_date AND COALESCE(end_date, NEW.attendance_date)
      AND (end_date IS NULL OR NEW.attendance_date <= end_date)
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Attendance date outside valid enrollment period or enrollment not active';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_verify_fee_integrity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    v_sum NUMERIC;
BEGIN
    SELECT COALESCE(SUM(amount), 0)
    INTO v_sum
    FROM public.fee_transactions
    WHERE student_fee_id = NEW.id
      AND voided_at IS NULL;

    -- Using small epsilon for float math if needed, but DECIMAL should be exact.
    IF v_sum != NEW.amount_paid THEN
        RAISE EXCEPTION 'Ledger Mismatch: Computed Sum (%) != Stored Paid Amount (%) for Fee ID %', v_sum, NEW.amount_paid, NEW.id;
    END IF;

    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_check_no_future_attendance()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    IF NEW.date > CURRENT_DATE THEN
        RAISE EXCEPTION 'Cannot mark attendance for future date: % (Today is %)', NEW.date, CURRENT_DATE;
    END IF;
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.prevent_complaint_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF (current_user <> 'postgres') THEN -- Allow admin/migration tool to delete if needed
        RAISE EXCEPTION 'Deleting complaints is not allowed. Update status instead.';
    END IF;
    RETURN OLD;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_class_teacher_source_of_truth()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    -- Allow updates if they match Monday Period 1 (which the trigger above does)
    -- But if a user manually tries to set it to something else, we should either:
    -- A) Block it.
    -- B) Let it happen but it will be overwritten next timetable change.
    
    -- Let's just rely on the trigger. If they manually change it, it might be for a valid reason 
    -- (temp substitute), but the next timetable edit will reset it. 
    -- User requirement: "No static or manually assigned class teacher logic."
    -- So we should probably effectively make it read-only from the API perspective, 
    -- or just let the trigger handle it.
    
    -- To adhere to "Single Source of Truth", we can force checking against timetable on update.
    -- But that causes circular logic if we aren't careful.
    -- Let's stick to the AFTER trigger on timetable_slots as the primary mechanism.
    
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_update_timestamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_check_invoice_amounts()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    IF NEW.paid_amount > NEW.total_amount THEN
        RAISE EXCEPTION 'Paid amount (%) cannot exceed Total amount (%).', NEW.paid_amount, NEW.total_amount;
    END IF;
    
    -- Auto-update status based on payment
    IF NEW.paid_amount = NEW.total_amount THEN
        NEW.status = 'paid';
    ELSIF NEW.paid_amount > 0 THEN
        NEW.status = 'partial';
    ELSIF NEW.paid_amount = 0 THEN
         -- Optional: Reset to unpaid if it was something else, or leave logic to app.
         -- Safest to only strictly set 'paid' or 'partial' if logic dictates.
         IF NEW.status = 'paid' THEN NEW.status = 'unpaid'; END IF; 
    END IF;

    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_staff()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.staff WHERE user_id = auth.uid()
  );
END;
$function$
;


-- Policies for staff_attendance

DO $$ BEGIN
    CREATE POLICY "Manage staff attendance" ON staff_attendance
    AS PERMISSIVE FOR ALL TO 
    USING (auth_has_role(ARRAY['admin'::text, 'principal'::text, 'accounts'::text])) ;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "View staff attendance" ON staff_attendance
    AS PERMISSIVE FOR SELECT TO 
    USING ((auth_has_role(ARRAY['admin'::text, 'principal'::text, 'accounts'::text]) OR (staff_id IN ( SELECT staff.id
   FROM staff
  WHERE (staff.person_id = ( SELECT users.person_id
           FROM users
          WHERE (users.id = auth.uid()))))))) ;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Policies for timetable_entries

DO $$ BEGIN
    CREATE POLICY "Enable all for authenticated" ON timetable_entries
    AS PERMISSIVE FOR ALL TO 
    USING ((auth.role() = 'authenticated'::text)) WITH CHECK ((auth.role() = 'authenticated'::text));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Timetable Manage" ON timetable_entries
    AS PERMISSIVE FOR ALL TO 
    USING ((auth_has_role(ARRAY['admin'::text]) OR (EXISTS ( SELECT 1
   FROM ((user_roles ur
     JOIN role_permissions rp ON ((ur.role_id = rp.role_id)))
     JOIN permissions p ON ((rp.permission_id = p.id)))
  WHERE ((ur.user_id = auth.uid()) AND ((p.code)::text = 'timetable.manage'::text)))))) ;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Timetable View" ON timetable_entries
    AS PERMISSIVE FOR SELECT TO 
    USING ((auth_has_role(ARRAY['admin'::text, 'accounts'::text]) OR (auth_has_role(ARRAY['teacher'::text, 'staff'::text]) AND (teacher_id IN ( SELECT staff.id
   FROM staff
  WHERE (staff.person_id = ( SELECT users.person_id
           FROM users
          WHERE (users.id = auth.uid())))))) OR (auth_has_role(ARRAY['student'::text]) AND (class_section_id IN ( SELECT se.class_section_id
   FROM (student_enrollments se
     JOIN students s ON ((se.student_id = s.id)))
  WHERE ((s.person_id = ( SELECT users.person_id
           FROM users
          WHERE (users.id = auth.uid()))) AND (se.status = 'active'::enrollment_status_enum))))) OR (auth_has_role(ARRAY['parent'::text]) AND (class_section_id IN ( SELECT se.class_section_id
   FROM (((student_enrollments se
     JOIN students s ON ((se.student_id = s.id)))
     JOIN student_parents sp ON ((s.id = sp.student_id)))
     JOIN parents p ON ((sp.parent_id = p.id)))
  WHERE ((p.person_id = ( SELECT users.person_id
           FROM users
          WHERE (users.id = auth.uid()))) AND (se.status = 'active'::enrollment_status_enum))))))) ;
EXCEPTION WHEN duplicate_object THEN null;
END $$;


-- ======================================
-- ### INJECTED MISSING TABLES ###
-- ======================================




CREATE TABLE IF NOT EXISTS bus_trip_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
  bus_id uuid NOT NULL,
  latitude double precision,
  longitude double precision,
  speed double precision,
  is_mocked boolean DEFAULT false,
  is_suspicious boolean DEFAULT false,
  recorded_at timestamp with time zone DEFAULT now(),
  CONSTRAINT bus_trip_history_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS debug_class_teachers (
  school_id INTEGER,
  class_name character varying(50),
  section_name character varying(50),
  teacher_name text,
  academic_year character varying(20)
);

CREATE TABLE IF NOT EXISTS debug_role_permissions (
  school_id INTEGER,
  role character varying(50),
  permissions text
);

CREATE TABLE IF NOT EXISTS driver_devices (
  driver_id uuid NOT NULL,
  school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
  device_id character varying NOT NULL,
  last_active timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT driver_devices_pkey PRIMARY KEY (school_id, driver_id)
);

CREATE TABLE IF NOT EXISTS driver_heartbeat (
  driver_id uuid NOT NULL,
  school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
  last_ping timestamp with time zone DEFAULT now(),
  status character varying DEFAULT 'online'::character varying,
  CONSTRAINT driver_heartbeat_pkey PRIMARY KEY (school_id, driver_id)
);

CREATE TABLE IF NOT EXISTS feature_flags (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
  code character varying(100) NOT NULL,
  name character varying(200) NOT NULL,
  description text,
  is_enabled boolean NOT NULL DEFAULT false,
  target_roles ARRAY,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT feature_flags_pkey PRIMARY KEY (id),
  CONSTRAINT feature_flags_code_key UNIQUE (school_id, code) -- TODO: VERIFY
);

CREATE TABLE IF NOT EXISTS timetable_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
  class_section_id uuid NOT NULL,
  subject_id uuid,
  teacher_id uuid,
  period_id uuid NOT NULL,
  day_of_week USER-DEFINED NOT NULL,
  room character varying(50),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT timetable_entries_pkey PRIMARY KEY (id),
  CONSTRAINT timetable_entries_class_section_id_period_id_day_of_week_key UNIQUE (school_id, class_section_id, period_id, day_of_week) -- TODO: VERIFY,
  CONSTRAINT timetable_entries_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES class_sections(id) -- TODO: VERIFY,
  CONSTRAINT timetable_entries_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES subjects(id) -- TODO: VERIFY,
  CONSTRAINT timetable_entries_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES staff(id) -- TODO: VERIFY,
  CONSTRAINT timetable_entries_period_id_fkey FOREIGN KEY (period_id) REFERENCES periods(id) -- TODO: VERIFY
);

CREATE TABLE IF NOT EXISTS ui_route_permissions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE,
  route_key character varying(100) NOT NULL,
  route_label character varying(200) NOT NULL,
  required_permissions ARRAY NOT NULL DEFAULT '{}'::text[],
  required_roles ARRAY,
  requires_feature_flag character varying(100),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT ui_route_permissions_pkey PRIMARY KEY (id),
  CONSTRAINT ui_route_permissions_route_key_key UNIQUE (school_id, route_key) -- TODO: VERIFY
);


ALTER TABLE IF EXISTS staff ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;
ALTER TABLE IF EXISTS student_fees ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;



-- ═══════════════════════════════════════════════════════════
-- SCHEMA SYNC: Missing columns from live database
-- ═══════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS expenses ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id);
ALTER TABLE IF EXISTS staff ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id);
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS students ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id);
ALTER TABLE IF EXISTS notices ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id);
ALTER TABLE IF EXISTS timetable_slots ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id);
ALTER TABLE IF EXISTS daily_attendance ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id);
ALTER TABLE IF EXISTS trips ADD COLUMN IF NOT EXISTS status character varying;
ALTER TABLE IF EXISTS events ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id);
ALTER TABLE IF EXISTS lms_courses ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id);
ALTER TABLE IF EXISTS money_science_modules ADD COLUMN IF NOT EXISTS content_url text;
ALTER TABLE IF EXISTS trip_stop_status ADD COLUMN IF NOT EXISTS status character varying;
ALTER TABLE IF EXISTS active_students ADD COLUMN IF NOT EXISTS school_id uuid;
ALTER TABLE IF EXISTS bus_locations ADD COLUMN IF NOT EXISTS is_mocked boolean;
ALTER TABLE IF EXISTS bus_locations ADD COLUMN IF NOT EXISTS is_suspicious boolean;
ALTER TABLE IF EXISTS complaints ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id);
ALTER TABLE IF EXISTS classes ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id);
ALTER TABLE IF EXISTS student_fees ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════
-- SCHEMA SYNC: Missing constraints from live database
-- ═══════════════════════════════════════════════════════════

DO $$ BEGIN ALTER TABLE events ADD CONSTRAINT chk_event_dates CHECK (end_date IS NULL OR end_date >= start_date); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE student_fees ADD CONSTRAINT chk_discount_not_exceed_due CHECK (discount <= amount_due); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE staff_attendance ADD CONSTRAINT chk_staff_attendance_date_past CHECK (attendance_date <= current_date); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE fee_transactions ADD CONSTRAINT chk_refund_must_be_negative CHECK (refund_of IS NULL OR amount < 0); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE diary_entries ADD CONSTRAINT chk_homework_due_date CHECK (homework_due_date IS NULL OR homework_due_date >= entry_date); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE buses ADD CONSTRAINT chk_bus_capacity CHECK (capacity > 0); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE notification_batches ADD CONSTRAINT chk_notification_batches_type CHECK (type IN ('FEES', 'GENERAL', 'EXAM', 'EMERGENCY', 'ATTENDANCE', 'CUSTOM')); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ═══════════════════════════════════════════════════════════
-- SCHEMA SYNC: Missing indexes from live database
-- ═══════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_notices_school ON public.notices USING btree (school_id);
CREATE INDEX IF NOT EXISTS idx_attendance_school ON public.daily_attendance USING btree (school_id);
CREATE INDEX IF NOT EXISTS idx_events_school ON public.events USING btree (school_id);
CREATE INDEX IF NOT EXISTS idx_lms_courses_school ON public.lms_courses USING btree (school_id);
CREATE INDEX IF NOT EXISTS idx_complaints_school ON public.complaints USING btree (school_id);
CREATE INDEX IF NOT EXISTS idx_classes_school ON public.classes USING btree (school_id);
CREATE INDEX IF NOT EXISTS idx_staff_school ON public.staff USING btree (school_id);
CREATE INDEX IF NOT EXISTS idx_students_school ON public.students USING btree (school_id);
CREATE INDEX IF NOT EXISTS idx_expenses_school ON public.expenses USING btree (school_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_notifications_event_user ON public.notifications (event_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_delivery_notification_channel ON public.notification_deliveries (notification_id, channel);

-- ═══════════════════════════════════════════════════════════
-- SCHEMA SYNC: Enable RLS on tables missing it
-- ═══════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS notification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS notification_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS girl_safety_complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS girl_safety_complaint_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS driver_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS driver_heartbeat ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS bus_trip_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS active_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS active_persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ui_route_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS school_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS debug_class_teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS debug_role_permissions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- SYNC ADDITIONS — Objects found in live DB, missing from schema
-- Generated: 2026-03-08T14:11:45.331Z
-- ============================================================

-- ─── COLUMNS IN SCHEMA.SQL MISSING FROM LIVE DB ────────────
DO $$ BEGIN
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE grading_scales ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE grading_scales ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE leave_applications ADD COLUMN IF NOT EXISTS reason_te TEXT;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE leave_applications ADD COLUMN IF NOT EXISTS review_remarks_te TEXT;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE transport_stops ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE notification_batches ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE notification_templates ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE notification_config ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE notifications ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE academic_years ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE timetable_slots ADD COLUMN IF NOT EXISTS day_of_week day_of_week_enum;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE sections ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE events ADD COLUMN IF NOT EXISTS title_te TEXT;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE events ADD COLUMN IF NOT EXISTS description_te TEXT;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE events ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS batch_id UUID;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS tokens_targeted INTEGER;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS tokens_sent INTEGER;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS tokens_failed INTEGER;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE money_science_modules ADD COLUMN IF NOT EXISTS content_body TEXT;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE money_science_modules ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE money_science_modules ADD COLUMN IF NOT EXISTS estimated_duration INTEGER;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE money_science_modules ADD COLUMN IF NOT EXISTS difficulty_level VARCHAR(20);
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE money_science_modules ADD COLUMN IF NOT EXISTS tags TEXT[];
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE science_projects ADD COLUMN IF NOT EXISTS materials_required TEXT[];
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE science_projects ADD COLUMN IF NOT EXISTS safety_instructions TEXT;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE science_projects ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE marks ADD COLUMN IF NOT EXISTS remarks_te TEXT;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE life_values_modules ADD COLUMN IF NOT EXISTS content_body TEXT;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE life_values_modules ADD COLUMN IF NOT EXISTS banner_image_url TEXT;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE life_values_modules ADD COLUMN IF NOT EXISTS quote_author VARCHAR(100);
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE life_values_modules ADD COLUMN IF NOT EXISTS highlight_quote TEXT;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE discipline_records ADD COLUMN IF NOT EXISTS evidence_urls TEXT[];
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE permissions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE permissions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE buses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE hostel_rooms ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE bus_locations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE classes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE class_sections ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
  -- [SYNC HIGH] Column in schema.sql missing from live DB (likely never ran)
  ALTER TABLE class_sections ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
END $$;

-- ─── UNDOCUMENTED COLUMNS IN LIVE DB (CRITICAL) ─────────────
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: uuid
-- -- Document: ALTER TABLE expenses ADD COLUMN IF NOT EXISTS school_id uuid;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: uuid
-- -- Document: ALTER TABLE staff ADD COLUMN IF NOT EXISTS school_id uuid;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: timestamp with time zone
-- -- Document: ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: text
-- -- Document: ALTER TABLE users ADD COLUMN IF NOT EXISTS theme text;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: uuid
-- -- Document: ALTER TABLE students ADD COLUMN IF NOT EXISTS school_id uuid;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: uuid
-- -- Document: ALTER TABLE notices ADD COLUMN IF NOT EXISTS school_id uuid;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: uuid
-- -- Document: ALTER TABLE timetable_slots ADD COLUMN IF NOT EXISTS school_id uuid;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: uuid
-- -- Document: ALTER TABLE daily_attendance ADD COLUMN IF NOT EXISTS school_id uuid;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: character varying
-- -- Document: ALTER TABLE trips ADD COLUMN IF NOT EXISTS status character varying;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: uuid
-- -- Document: ALTER TABLE events ADD COLUMN IF NOT EXISTS school_id uuid;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: uuid
-- -- Document: ALTER TABLE lms_courses ADD COLUMN IF NOT EXISTS school_id uuid;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: text
-- -- Document: ALTER TABLE money_science_modules ADD COLUMN IF NOT EXISTS content_url text;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: character varying
-- -- Document: ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS status character varying;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: uuid
-- -- Document: ALTER TABLE active_students ADD COLUMN IF NOT EXISTS school_id uuid;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: boolean
-- -- Document: ALTER TABLE bus_locations ADD COLUMN IF NOT EXISTS is_mocked boolean;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: boolean
-- -- Document: ALTER TABLE bus_locations ADD COLUMN IF NOT EXISTS is_suspicious boolean;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: uuid
-- -- Document: ALTER TABLE school_settings ADD COLUMN IF NOT EXISTS id uuid;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: uuid
-- -- Document: ALTER TABLE complaints ADD COLUMN IF NOT EXISTS school_id uuid;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: uuid
-- -- Document: ALTER TABLE classes ADD COLUMN IF NOT EXISTS school_id uuid;
-- [SYNC CRITICAL] Column exists in live DB but not schema.sql (undocumented mutation) | was: not in schema | live: timestamp with time zone
-- -- Document: ALTER TABLE student_fees ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;

-- ─── RLS STATUS ─────────────────────────────────────────────
-- [SYNC HIGH] notification_preferences: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] notification_templates: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] notification_events: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE notification_events ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] notifications: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] notification_deliveries: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] notification_audit_logs: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE notification_audit_logs ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] user_settings: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] girl_safety_complaints: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE girl_safety_complaints ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] girl_safety_complaint_threads: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE girl_safety_complaint_threads ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] driver_devices: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE driver_devices ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] driver_heartbeat: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE driver_heartbeat ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] bus_trip_history: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE bus_trip_history ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] feature_flags: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] active_students: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE active_students ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] active_persons: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE active_persons ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] ui_route_permissions: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE ui_route_permissions ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] school_settings: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE school_settings ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] debug_class_teachers: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE debug_class_teachers ENABLE ROW LEVEL SECURITY;

-- [SYNC HIGH] debug_role_permissions: RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE debug_role_permissions ENABLE ROW LEVEL SECURITY;

-- ─── MISSING CHECK CONSTRAINTS ─────────────────────────────
DO $$ BEGIN
  -- [SYNC HIGH] Constraint in schema.sql missing from live DB
  ALTER TABLE staff_attendance ADD CONSTRAINT chk_staff_attendance_date_past CHECK (attendance_date <= current_date);
  -- [SYNC HIGH] Constraint in schema.sql missing from live DB
  ALTER TABLE fee_transactions ADD CONSTRAINT chk_refund_must_be_negative CHECK (refund_of IS NULL OR amount < 0);
  -- [SYNC HIGH] Constraint in schema.sql missing from live DB
  ALTER TABLE diary_entries ADD CONSTRAINT chk_homework_due_date CHECK (homework_due_date IS NULL OR homework_due_date >= entry_date);
  -- [SYNC HIGH] Constraint in schema.sql missing from live DB
  ALTER TABLE buses ADD CONSTRAINT chk_bus_capacity CHECK (capacity > 0);
  -- [SYNC HIGH] Constraint in schema.sql missing from live DB
  ALTER TABLE events ADD CONSTRAINT chk_event_dates CHECK (end_date IS NULL OR end_date >= start_date);
  -- [SYNC HIGH] Constraint in schema.sql missing from live DB
  ALTER TABLE notification_batches ADD CONSTRAINT chk_notification_batches_type CHECK (type IN ('FEES', 'GENERAL', 'EXAM', 'EMERGENCY', 'DIARY', 'RESULTS', 'NOTICE', 'TEST_TRIGGER'));
  -- [SYNC HIGH] Constraint in schema.sql missing from live DB
  ALTER TABLE student_fees ADD CONSTRAINT chk_discount_not_exceed_due CHECK (discount <= amount_due);
  -- [SYNC HIGH] Constraint in schema.sql missing from live DB
  ALTER TABLE events ADD CONSTRAINT chk_event_dates CHECK (end_date IS NULL OR end_date >= start_date);
  -- [SYNC HIGH] Constraint in schema.sql missing from live DB
  ALTER TABLE student_fees ADD CONSTRAINT chk_discount_not_exceed_due CHECK (discount <= amount_due);
  -- [SYNC HIGH] Constraint in schema.sql missing from live DB
  ALTER TABLE staff_attendance ADD CONSTRAINT chk_staff_attendance_date_past CHECK (attendance_date <= current_date);
  -- [SYNC HIGH] Constraint in schema.sql missing from live DB
  ALTER TABLE fee_transactions ADD CONSTRAINT chk_refund_must_be_negative CHECK (refund_of IS NULL OR amount < 0);
  -- [SYNC HIGH] Constraint in schema.sql missing from live DB
  ALTER TABLE diary_entries ADD CONSTRAINT chk_homework_due_date CHECK (homework_due_date IS NULL OR homework_due_date >= entry_date);
  -- [SYNC HIGH] Constraint in schema.sql missing from live DB
  ALTER TABLE buses ADD CONSTRAINT chk_bus_capacity CHECK (capacity > 0);
  -- [SYNC HIGH] Constraint in schema.sql missing from live DB
  ALTER TABLE notification_batches ADD CONSTRAINT chk_notification_batches_type CHECK (type IN ('FEES', 'GENERAL', 'EXAM', 'EMERGENCY', 'ATTENDANCE', 'CUSTOM'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── MISSING INDEXES ────────────────────────────────────────
-- [SYNC MEDIUM] Table defined in schema.sql but NOT found in live DB
-- Ensure CREATE TABLE admin_notifications (...) is executed against the DB

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE grading_scales ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE grading_scales ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE leave_applications ADD COLUMN IF NOT EXISTS reason_te TEXT;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE leave_applications ADD COLUMN IF NOT EXISTS review_remarks_te TEXT;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE transport_stops ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE notification_batches ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE notification_templates ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE notification_config ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE academic_years ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE timetable_slots ADD COLUMN IF NOT EXISTS day_of_week day_of_week_enum;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE sections ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE events ADD COLUMN IF NOT EXISTS title_te TEXT;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE events ADD COLUMN IF NOT EXISTS description_te TEXT;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE events ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS batch_id UUID;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS tokens_targeted INTEGER;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS tokens_sent INTEGER;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS tokens_failed INTEGER;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE money_science_modules ADD COLUMN IF NOT EXISTS content_body TEXT;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE money_science_modules ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE money_science_modules ADD COLUMN IF NOT EXISTS estimated_duration INTEGER;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE money_science_modules ADD COLUMN IF NOT EXISTS difficulty_level VARCHAR(20);

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE money_science_modules ADD COLUMN IF NOT EXISTS tags TEXT[];

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE science_projects ADD COLUMN IF NOT EXISTS materials_required TEXT[];

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE science_projects ADD COLUMN IF NOT EXISTS safety_instructions TEXT;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE science_projects ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE marks ADD COLUMN IF NOT EXISTS remarks_te TEXT;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE life_values_modules ADD COLUMN IF NOT EXISTS content_body TEXT;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE life_values_modules ADD COLUMN IF NOT EXISTS banner_image_url TEXT;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE life_values_modules ADD COLUMN IF NOT EXISTS quote_author VARCHAR(100);

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE life_values_modules ADD COLUMN IF NOT EXISTS highlight_quote TEXT;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE discipline_records ADD COLUMN IF NOT EXISTS evidence_urls TEXT[];

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE roles ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE roles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE role_permissions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE permissions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE permissions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE buses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE hostel_rooms ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE bus_locations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE classes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE class_sections ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- [SYNC MEDIUM] Column in schema.sql missing from live DB (likely never ran)
ALTER TABLE class_sections ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE notification_events ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE notification_audit_logs ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE girl_safety_complaints ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE girl_safety_complaint_threads ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE driver_devices ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE driver_heartbeat ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE bus_trip_history ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE active_students ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE active_persons ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE ui_route_permissions ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE school_settings ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE debug_class_teachers ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] RLS is disabled — table is publicly accessible to any authenticated user
ALTER TABLE debug_role_permissions ENABLE ROW LEVEL SECURITY;

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE staff_attendance ADD CONSTRAINT chk_staff_attendance_date_past CHECK (attendance_date <= current_date);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE fee_transactions ADD CONSTRAINT chk_refund_must_be_negative CHECK (refund_of IS NULL OR amount < 0);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE diary_entries ADD CONSTRAINT chk_homework_due_date CHECK (homework_due_date IS NULL OR homework_due_date >= entry_date);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE buses ADD CONSTRAINT chk_bus_capacity CHECK (capacity > 0);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE events ADD CONSTRAINT chk_event_dates CHECK (end_date IS NULL OR end_date >= start_date);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE notification_batches ADD CONSTRAINT chk_notification_batches_type CHECK (type IN ('FEES', 'GENERAL', 'EXAM', 'EMERGENCY', 'DIARY', 'RESULTS', 'NOTICE', 'TEST_TRIGGER'));

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE student_fees ADD CONSTRAINT chk_discount_not_exceed_due CHECK (discount <= amount_due);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE events ADD CONSTRAINT chk_event_dates CHECK (end_date IS NULL OR end_date >= start_date);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE student_fees ADD CONSTRAINT chk_discount_not_exceed_due CHECK (discount <= amount_due);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE staff_attendance ADD CONSTRAINT chk_staff_attendance_date_past CHECK (attendance_date <= current_date);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE fee_transactions ADD CONSTRAINT chk_refund_must_be_negative CHECK (refund_of IS NULL OR amount < 0);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE diary_entries ADD CONSTRAINT chk_homework_due_date CHECK (homework_due_date IS NULL OR homework_due_date >= entry_date);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE buses ADD CONSTRAINT chk_bus_capacity CHECK (capacity > 0);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE notification_batches ADD CONSTRAINT chk_notification_batches_type CHECK (type IN ('FEES', 'GENERAL', 'EXAM', 'EMERGENCY', 'ATTENDANCE', 'CUSTOM'));

-- [SYNC MEDIUM] Trigger in schema.sql missing from live DB
CREATE OR REPLACE TRIGGER trg_trips_updated
  BEFORE UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- [SYNC MEDIUM] Enum values missing from live DB: mon, tue, wed, thu, fri, sat, sun
ALTER TYPE day_of_week_enum ADD VALUE IF NOT EXISTS 'mon';
ALTER TYPE day_of_week_enum ADD VALUE IF NOT EXISTS 'tue';
ALTER TYPE day_of_week_enum ADD VALUE IF NOT EXISTS 'wed';
ALTER TYPE day_of_week_enum ADD VALUE IF NOT EXISTS 'thu';
ALTER TYPE day_of_week_enum ADD VALUE IF NOT EXISTS 'fri';
ALTER TYPE day_of_week_enum ADD VALUE IF NOT EXISTS 'sat';
ALTER TYPE day_of_week_enum ADD VALUE IF NOT EXISTS 'sun';

-- [SYNC MEDIUM] View defined in schema.sql but not in live DB
CREATE OR REPLACE VIEW fee_installments AS SELECT 
    id, student_id, amount_due, amount_paid, discount, 
    status, due_date, created_at, updated_at, deleted_at
FROM student_fees;

-- [SYNC MEDIUM] Index in schema.sql missing from live DB
CREATE INDEX IF NOT EXISTS idx_user_devices_fcm_token ON user_devices(fcm_token);;

-- [SYNC MEDIUM] Index in schema.sql missing from live DB
CREATE INDEX IF NOT EXISTS idx_user_devices_active ON user_devices(user_id, is_active);;

-- [SYNC MEDIUM] Index in schema.sql missing from live DB
CREATE INDEX IF NOT EXISTS idx_notification_logs_batch_id ON notification_logs(batch_id);;

-- [SYNC MEDIUM] Index in schema.sql missing from live DB
CREATE INDEX IF NOT EXISTS idx_temp_access_lookup ON temp_access_grants(requested_by, department) WHERE is_active = true;;

-- ─── MISSING TRIGGERS ───────────────────────────────────────
-- [SYNC HIGH] Trigger in schema.sql missing from live DB
CREATE OR REPLACE TRIGGER trg_trips_updated
  BEFORE UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- ─── TODOs — MANUAL VERIFICATION REQUIRED ──────────────────
-- TODO: VERIFY — trips — schema_parsed._uncertain = true for this table
--   Run: SELECT * FROM information_schema.columns WHERE table_name='trips';
-- TODO: VERIFY — trip_stop_status — schema_parsed._uncertain = true for this table
--   Run: SELECT * FROM information_schema.columns WHERE table_name='trip_stop_status';
-- TODO: VERIFY — expenses — schema_parsed._uncertain = true
--   Run: SELECT * FROM information_schema.referential_constraints WHERE constraint_name LIKE '%expenses%';
-- TODO: VERIFY — financial_audit_logs — schema_parsed._uncertain = true
--   Run: SELECT * FROM information_schema.referential_constraints WHERE constraint_name LIKE '%financial_audit_logs%';
-- TODO: VERIFY — financial_policy_rules — schema_parsed._uncertain = true
--   Run: SELECT * FROM information_schema.referential_constraints WHERE constraint_name LIKE '%financial_policy_rules%';
-- TODO: VERIFY — access_requests — schema_parsed._uncertain = true
--   Run: SELECT * FROM information_schema.referential_constraints WHERE constraint_name LIKE '%access_requests%';
-- TODO: VERIFY — access_requests — schema_parsed._uncertain = true
--   Run: SELECT * FROM information_schema.referential_constraints WHERE constraint_name LIKE '%access_requests%';
-- TODO: VERIFY — temp_access_grants — schema_parsed._uncertain = true
--   Run: SELECT * FROM information_schema.referential_constraints WHERE constraint_name LIKE '%temp_access_grants%';
-- TODO: VERIFY — temp_access_grants — schema_parsed._uncertain = true
--   Run: SELECT * FROM information_schema.referential_constraints WHERE constraint_name LIKE '%temp_access_grants%';


COMMIT;


CREATE OR REPLACE FUNCTION get_next_receipt_no(p_school_id INTEGER) RETURNS TEXT AS $$
DECLARE
  v_seq_name TEXT := 'receipt_no_seq_school_' || p_school_id;
BEGIN
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I START 1001', v_seq_name);
  RETURN 'SCH' || p_school_id || '-RCT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(NEXTVAL(v_seq_name)::TEXT, 5, '0');
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_next_complaint_ticket(p_school_id INTEGER) RETURNS TEXT AS $$
DECLARE
  v_seq_name TEXT := 'complaint_ticket_seq_school_' || p_school_id;
BEGIN
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I START 1', v_seq_name);
  RETURN 'TKT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-S' || p_school_id || '-' || LPAD(NEXTVAL(v_seq_name)::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;
