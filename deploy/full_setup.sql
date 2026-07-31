/*
  Project: IMS Backend Service
  Description: Consolidated, idempotent full setup script.
  Date: 2026-01-31
  Target: PostgreSQL 15+ / Supabase
  Execution: Run as 'postgres' or 'service_role'.
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

-- SECTION 01: EXTENSIONS
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- SECTION 02: CORE SCHEMA
-- ============================================================
-- SUPABASE BACKEND SCHEMA v3.1 (CONSOLIDATED & IDEMPOTENT)
-- ============================================================
-- INCLUDES:
--  1. Original v2 schema tables
--  2. Remediation Fixes (Financial, RLS, Indexes)
--  3. Idempotency Fixes (DROP IF EXISTS added for Triggers/Policies)
-- ============================================================

-- 0. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. REFERENCE TABLES
CREATE TABLE IF NOT EXISTS countries (
    code CHAR(2) PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS genders (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS student_categories (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS religions (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS blood_groups (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(10) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS relationship_types (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS staff_designations (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE
);

-- 2. CORE TRIGGERS (GLOBAL)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. PERSONS
CREATE TABLE IF NOT EXISTS persons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

DROP TRIGGER IF EXISTS trg_persons_updated ON persons;
CREATE TRIGGER trg_persons_updated
BEFORE UPDATE ON persons
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 5. USERS & RBAC
CREATE TABLE IF NOT EXISTS roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    is_system BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL
);

DO $$ BEGIN
    CREATE TYPE account_status_enum AS ENUM ('active','locked','disabled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
    permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
    account_status account_status_enum NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Note: deleted_at needed for soft delete index safety
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Soft Delete Safe Unique Index
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_person_active 
ON users(person_id) WHERE deleted_at IS NULL; 

CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
    granted_by UUID REFERENCES users(id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role_id)
);

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
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 6. STUDENTS
CREATE TABLE IF NOT EXISTS student_statuses (
    id SMALLINT PRIMARY KEY,
    code VARCHAR(20) UNIQUE NOT NULL,
    is_terminal BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

CREATE INDEX IF NOT EXISTS idx_students_status ON students(status_id);

-- Remediation: Soft Delete Safe Unique Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_admission_active 
ON students(admission_no) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_students_person_active 
ON students(person_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_students_updated ON students;
CREATE TRIGGER trg_students_updated
BEFORE UPDATE ON students
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 7. PARENTS
CREATE TABLE IF NOT EXISTS parents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
    occupation VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_parents_person_active 
ON parents(person_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_parents_updated ON parents;
CREATE TRIGGER trg_parents_updated
BEFORE UPDATE ON parents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS student_parents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

-- 8. ACADEMICS
CREATE TABLE IF NOT EXISTS academic_years (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(20) UNIQUE NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    CONSTRAINT chk_academic_year CHECK (start_date < end_date),
    CONSTRAINT no_academic_year_overlap EXCLUDE USING gist (
        daterange(start_date, end_date, '[]') WITH &&
    )
);

ALTER TABLE students
  ADD COLUMN IF NOT EXISTS exit_academic_year_id UUID REFERENCES academic_years(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS exit_date DATE;

CREATE INDEX IF NOT EXISTS idx_students_exit_academic_year
  ON students (exit_academic_year_id)
  WHERE deleted_at IS NULL AND exit_academic_year_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS classes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL UNIQUE,
    code VARCHAR(20)
);

CREATE TABLE IF NOT EXISTS sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL UNIQUE,
    code VARCHAR(20)
);

CREATE TABLE IF NOT EXISTS class_sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id UUID NOT NULL REFERENCES classes(id),
    section_id UUID NOT NULL REFERENCES sections(id),
    academic_year_id UUID NOT NULL REFERENCES academic_years(id),
    UNIQUE (class_id, section_id, academic_year_id)
);

DO $$ BEGIN
    CREATE TYPE enrollment_status_enum AS ENUM ('active','completed','withdrawn');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS student_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_enrollment_roll_number
ON student_enrollments (class_section_id, academic_year_id, roll_number)
WHERE status = 'active'
  AND deleted_at IS NULL
  AND roll_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_active_enrollments
ON student_enrollments(student_id)
WHERE status = 'active';

DROP TRIGGER IF EXISTS trg_student_enrollments_updated ON student_enrollments;
CREATE TRIGGER trg_student_enrollments_updated
BEFORE UPDATE ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Remediation: Set-Based Roll Number Calculation
CREATE OR REPLACE FUNCTION recalculate_section_rolls(
    p_class_section_id UUID,
    p_academic_year_id UUID
)
RETURNS VOID AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtext(p_class_section_id::text),
        hashtext(p_academic_year_id::text)
    );

    UPDATE student_enrollments
    SET roll_number = NULL
    WHERE class_section_id = p_class_section_id
      AND academic_year_id = p_academic_year_id
      AND status = 'active'
      AND deleted_at IS NULL
      AND roll_number IS NOT NULL;

    WITH ordered_students AS (
        SELECT
            se.id AS enrollment_id,
            ROW_NUMBER() OVER (
                ORDER BY
                    LOWER(BTRIM(COALESCE(p.first_name, ''))) ASC,
                    LOWER(BTRIM(COALESCE(p.middle_name, ''))) ASC,
                    LOWER(BTRIM(COALESCE(p.last_name, ''))) ASC,
                    s.admission_no ASC,
                    s.id ASC
            )::INTEGER as new_roll
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
    WHERE se.id = os.enrollment_id;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE OR REPLACE FUNCTION recalculate_rolls_after_enrollment_change()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM recalculate_section_rolls(OLD.class_section_id, OLD.academic_year_id);
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        PERFORM recalculate_section_rolls(OLD.class_section_id, OLD.academic_year_id);
    END IF;
    PERFORM recalculate_section_rolls(NEW.class_section_id, NEW.academic_year_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_recalculate_rolls_after_enrollment_change ON student_enrollments;
CREATE TRIGGER trg_recalculate_rolls_after_enrollment_change
AFTER INSERT OR DELETE OR UPDATE OF class_section_id, academic_year_id, status, deleted_at
ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION recalculate_rolls_after_enrollment_change();

CREATE OR REPLACE FUNCTION recalculate_rolls_after_student_name_change()
RETURNS TRIGGER AS $$
DECLARE target RECORD;
BEGIN
    IF ROW(OLD.first_name, OLD.middle_name, OLD.last_name)
       IS NOT DISTINCT FROM ROW(NEW.first_name, NEW.middle_name, NEW.last_name) THEN
        RETURN NEW;
    END IF;
    FOR target IN
        SELECT DISTINCT se.class_section_id, se.academic_year_id
        FROM students s
        JOIN student_enrollments se ON se.student_id = s.id
        WHERE s.person_id = NEW.id
          AND se.status = 'active'
          AND se.deleted_at IS NULL
    LOOP
        PERFORM recalculate_section_rolls(target.class_section_id, target.academic_year_id);
    END LOOP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_recalculate_rolls_after_student_name_change ON persons;
CREATE TRIGGER trg_recalculate_rolls_after_student_name_change
AFTER UPDATE OF first_name, middle_name, last_name ON persons
FOR EACH ROW EXECUTE FUNCTION recalculate_rolls_after_student_name_change();

CREATE OR REPLACE FUNCTION recalculate_rolls_after_student_delete_change()
RETURNS TRIGGER AS $$
DECLARE target RECORD;
BEGIN
    IF OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN
        RETURN NEW;
    END IF;
    FOR target IN
        SELECT DISTINCT se.class_section_id, se.academic_year_id
        FROM student_enrollments se
        WHERE se.student_id = NEW.id
          AND se.status = 'active'
          AND se.deleted_at IS NULL
    LOOP
        PERFORM recalculate_section_rolls(target.class_section_id, target.academic_year_id);
    END LOOP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_recalculate_rolls_after_student_delete_change ON students;
CREATE TRIGGER trg_recalculate_rolls_after_student_delete_change
AFTER UPDATE OF deleted_at ON students
FOR EACH ROW EXECUTE FUNCTION recalculate_rolls_after_student_delete_change();

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
DECLARE
  should_validate BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    should_validate := TRUE;
  ELSE
    should_validate :=
      NEW.student_id IS DISTINCT FROM OLD.student_id
      OR NEW.class_section_id IS DISTINCT FROM OLD.class_section_id
      OR NEW.academic_year_id IS DISTINCT FROM OLD.academic_year_id
      OR (NEW.status = 'active' AND NEW.status IS DISTINCT FROM OLD.status);
  END IF;

  IF should_validate AND EXISTS (
    SELECT 1 FROM students
    WHERE id = NEW.student_id AND deleted_at IS NOT NULL
  ) THEN
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
    student_enrollment_id UUID NOT NULL REFERENCES student_enrollments(id),
    attendance_date DATE NOT NULL,
    status attendance_status_enum NOT NULL,
    marked_by UUID REFERENCES users(id) ON DELETE SET NULL,
    marked_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_attendance_date_past CHECK (attendance_date <= current_date)
);

DROP TRIGGER IF EXISTS trg_attendance_updated ON daily_attendance;
CREATE TRIGGER trg_attendance_updated
BEFORE UPDATE ON daily_attendance
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_active
ON daily_attendance(student_enrollment_id, attendance_date)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_date ON daily_attendance(attendance_date);
CREATE INDEX IF NOT EXISTS idx_attendance_enrollment ON daily_attendance(student_enrollment_id);
CREATE INDEX IF NOT EXISTS idx_attendance_composite ON daily_attendance(student_enrollment_id, status, attendance_date);

CREATE OR REPLACE FUNCTION validate_attendance_date()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_attendance ON daily_attendance;
CREATE TRIGGER trg_validate_attendance
BEFORE INSERT OR UPDATE ON daily_attendance
FOR EACH ROW EXECUTE FUNCTION validate_attendance_date();

-- 10. STAFF
CREATE TABLE IF NOT EXISTS staff_statuses (
    id SMALLINT PRIMARY KEY,
    code VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(50) NOT NULL
);

INSERT INTO staff_statuses (id, code, name) VALUES
(1, 'active', 'Active'), (2, 'on_leave', 'On Leave'), (3, 'resigned', 'Resigned'), (4, 'terminated', 'Terminated')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_code_active 
ON staff(staff_code) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_person_active 
ON staff(person_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_staff_status ON staff(status_id);
CREATE INDEX IF NOT EXISTS idx_staff_active ON staff(id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_staff_updated ON staff;
CREATE TRIGGER trg_staff_updated
BEFORE UPDATE ON staff
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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


-- 11. FEES (REMEDIATED)
CREATE TABLE IF NOT EXISTS fee_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    code VARCHAR(30) UNIQUE,
    description TEXT,
    is_recurring BOOLEAN NOT NULL DEFAULT TRUE,
    is_optional BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fee_structures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academic_year_id UUID NOT NULL REFERENCES academic_years(id),
    class_id UUID NOT NULL REFERENCES classes(id),
    fee_type_id UUID NOT NULL REFERENCES fee_types(id),
    amount DECIMAL(12,2) NOT NULL,
    due_date DATE,
    frequency VARCHAR(20) DEFAULT 'monthly',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (academic_year_id, class_id, fee_type_id),
    CONSTRAINT chk_fee_amount_positive CHECK (amount > 0)
);

DROP TRIGGER IF EXISTS trg_fee_structures_updated ON fee_structures;
CREATE TRIGGER trg_fee_structures_updated
BEFORE UPDATE ON fee_structures
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$ BEGIN
    CREATE TYPE fee_status_enum AS ENUM ('pending','partial','paid','waived','overdue');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS student_fees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id),
    fee_structure_id UUID NOT NULL REFERENCES fee_structures(id),
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

CREATE INDEX IF NOT EXISTS idx_student_fees_student ON student_fees(student_id);
CREATE INDEX IF NOT EXISTS idx_student_fees_status ON student_fees(status);

DROP TRIGGER IF EXISTS trg_student_fees_updated ON student_fees;
CREATE TRIGGER trg_student_fees_updated
BEFORE UPDATE ON student_fees
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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
    student_fee_id UUID NOT NULL REFERENCES student_fees(id),
    amount DECIMAL(12,2) NOT NULL,
    payment_method payment_method_enum NOT NULL,
    transaction_ref VARCHAR(100),
    paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_by UUID REFERENCES users(id),
    remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_transaction_amount CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_transactions_paid_at ON fee_transactions(paid_at);

-- Remediation: Financial Trigger (INSERT/UPDATE/DELETE)
CREATE OR REPLACE FUNCTION update_fee_paid_amount()
RETURNS TRIGGER AS $$
BEGIN
    -- Handle DELETE or UPDATE (subtract old amount)
    IF (TG_OP = 'DELETE' OR TG_OP = 'UPDATE') THEN
        UPDATE student_fees 
        SET amount_paid = amount_paid - OLD.amount
        WHERE id = OLD.student_fee_id;
    END IF;

    -- Handle INSERT or UPDATE (add new amount)
    IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') THEN
        UPDATE student_fees 
        SET amount_paid = amount_paid + NEW.amount
        WHERE id = NEW.student_fee_id;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_paid_on_transaction ON fee_transactions;
CREATE TRIGGER trg_update_paid_on_transaction
AFTER INSERT OR UPDATE OR DELETE ON fee_transactions
FOR EACH ROW EXECUTE FUNCTION update_fee_paid_amount();

CREATE TABLE IF NOT EXISTS receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_no VARCHAR(30) NOT NULL UNIQUE,
    student_id UUID NOT NULL REFERENCES students(id),
    total_amount DECIMAL(12,2) NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    issued_by UUID REFERENCES users(id),
    remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS receipt_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    fee_transaction_id UUID NOT NULL REFERENCES fee_transactions(id),
    amount DECIMAL(12,2) NOT NULL
);

-- 12. EXAMS & RESULTS
CREATE TABLE IF NOT EXISTS subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20) UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS class_subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_section_id UUID NOT NULL REFERENCES class_sections(id),
    subject_id UUID NOT NULL REFERENCES subjects(id),
    teacher_id UUID REFERENCES staff(id),
    UNIQUE (class_section_id, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_class_subjects_teacher ON class_subjects(teacher_id);

DO $$ BEGIN
    CREATE TYPE exam_status_enum AS ENUM ('scheduled','ongoing','completed','cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS exams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    academic_year_id UUID NOT NULL REFERENCES academic_years(id),
    exam_type VARCHAR(50) NOT NULL, 
    start_date DATE,
    end_date DATE,
    status exam_status_enum NOT NULL DEFAULT 'scheduled',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_exam_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

DROP TRIGGER IF EXISTS trg_exams_updated ON exams;
CREATE TRIGGER trg_exams_updated
BEFORE UPDATE ON exams
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS exam_subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    subject_id UUID NOT NULL REFERENCES subjects(id),
    class_id UUID NOT NULL REFERENCES classes(id),
    exam_date DATE,
    max_marks DECIMAL(5,2) NOT NULL DEFAULT 100,
    passing_marks DECIMAL(5,2) NOT NULL DEFAULT 35,
    UNIQUE (exam_id, subject_id, class_id),
    CONSTRAINT chk_marks_valid CHECK (passing_marks <= max_marks AND max_marks > 0)
);

CREATE TABLE IF NOT EXISTS grading_scales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL,
    min_percentage DECIMAL(5,2) NOT NULL,
    max_percentage DECIMAL(5,2) NOT NULL,
    grade VARCHAR(5) NOT NULL,
    grade_point DECIMAL(3,1),
    CONSTRAINT chk_percentage_range CHECK (min_percentage >= 0 AND max_percentage <= 100 AND min_percentage < max_percentage)
);

CREATE TABLE IF NOT EXISTS marks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_subject_id UUID NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,
    student_enrollment_id UUID NOT NULL REFERENCES student_enrollments(id),
    marks_obtained DECIMAL(5,2),
    is_absent BOOLEAN NOT NULL DEFAULT FALSE,
    remarks TEXT,
    entered_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (exam_subject_id, student_enrollment_id),
    CONSTRAINT chk_marks_or_absent CHECK (is_absent = TRUE OR marks_obtained IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_marks_enrollment ON marks(student_enrollment_id);
CREATE INDEX IF NOT EXISTS idx_marks_exam_subject ON marks(exam_subject_id);

DROP TRIGGER IF EXISTS trg_marks_updated ON marks;
CREATE TRIGGER trg_marks_updated
BEFORE UPDATE ON marks
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 13. COMMUNICATION & SUPPORT
DO $$ BEGIN
    CREATE TYPE complaint_status_enum AS ENUM ('open','in_progress','resolved','closed','rejected');
    CREATE TYPE complaint_priority_enum AS ENUM ('low','medium','high','urgent');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS complaints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_no VARCHAR(30) UNIQUE,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(50), 
    priority complaint_priority_enum NOT NULL DEFAULT 'medium',
    status complaint_status_enum NOT NULL DEFAULT 'open',
    raised_by UUID NOT NULL REFERENCES users(id),
    raised_for_student_id UUID REFERENCES students(id), 
    assigned_to UUID REFERENCES users(id),
    resolution TEXT,
    resolved_by UUID REFERENCES users(id),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaints_raised_by ON complaints(raised_by);

DROP TRIGGER IF EXISTS trg_complaints_updated ON complaints;
CREATE TRIGGER trg_complaints_updated
BEFORE UPDATE ON complaints
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_notices_audience ON notices(audience);
CREATE INDEX IF NOT EXISTS idx_notices_publish ON notices(publish_at);

DROP TRIGGER IF EXISTS trg_notices_updated ON notices;
CREATE TRIGGER trg_notices_updated
BEFORE UPDATE ON notices
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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

DO $$ BEGIN
    CREATE TYPE leave_status_enum AS ENUM ('pending','approved','rejected','cancelled');
    CREATE TYPE leave_type_enum AS ENUM ('casual','sick','earned','maternity','paternity','unpaid','other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS leave_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    applicant_id UUID NOT NULL REFERENCES users(id),
    leave_type leave_type_enum NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason TEXT NOT NULL,
    status leave_status_enum NOT NULL DEFAULT 'pending',
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    review_remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_leave_dates CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_leaves_applicant ON leave_applications(applicant_id);
CREATE INDEX IF NOT EXISTS idx_leaves_status ON leave_applications(status);

DROP TRIGGER IF EXISTS trg_leaves_updated ON leave_applications;
CREATE TRIGGER trg_leaves_updated
BEFORE UPDATE ON leave_applications
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS diary_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_section_id UUID NOT NULL REFERENCES class_sections(id),
    subject_id UUID REFERENCES subjects(id),
    entry_date DATE NOT NULL,
    title VARCHAR(200),
    content TEXT NOT NULL,
    homework_due_date DATE,
    attachments JSONB, 
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_diary_class ON diary_entries(class_section_id);
CREATE INDEX IF NOT EXISTS idx_diary_date ON diary_entries(entry_date);

DROP TRIGGER IF EXISTS trg_diary_updated ON diary_entries;
CREATE TRIGGER trg_diary_updated
BEFORE UPDATE ON diary_entries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$ BEGIN
    CREATE TYPE day_of_week_enum AS ENUM ('monday','tuesday','wednesday','thursday','friday','saturday','sunday');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL, 
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT chk_period_times CHECK (end_time > start_time)
);

INSERT INTO periods (name, start_time, end_time, sort_order) VALUES
('Period 1', '08:00', '08:45', 1), ('Period 2', '08:45', '09:30', 2), ('Period 3', '09:30', '10:15', 3),
('Break', '10:15', '10:30', 4), ('Period 4', '10:30', '11:15', 5), ('Period 5', '11:15', '12:00', 6),
('Lunch', '12:00', '12:45', 7), ('Period 6', '12:45', '13:30', 8), ('Period 7', '13:30', '14:15', 9),
('Period 8', '14:15', '15:00', 10)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS timetable_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_section_id UUID NOT NULL REFERENCES class_sections(id),
    subject_id UUID REFERENCES subjects(id),
    teacher_id UUID REFERENCES staff(id),
    period_id UUID NOT NULL REFERENCES periods(id),
    day_of_week day_of_week_enum NOT NULL,
    room VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (class_section_id, period_id, day_of_week)
);

CREATE INDEX IF NOT EXISTS idx_timetable_class ON timetable_entries(class_section_id);
CREATE INDEX IF NOT EXISTS idx_timetable_teacher ON timetable_entries(teacher_id);

DROP TRIGGER IF EXISTS trg_timetable_updated ON timetable_entries;
CREATE TRIGGER trg_timetable_updated
BEFORE UPDATE ON timetable_entries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 14. TRANSPORT
CREATE TABLE IF NOT EXISTS transport_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20) UNIQUE,
    description TEXT,
    start_point VARCHAR(200),
    end_point VARCHAR(200),
    total_stops INTEGER,
    monthly_fee DECIMAL(12,2),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_transport_routes_updated ON transport_routes;
CREATE TRIGGER trg_transport_routes_updated
BEFORE UPDATE ON transport_routes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS buses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bus_no VARCHAR(50) NOT NULL UNIQUE,
    registration_no VARCHAR(50) UNIQUE,
    capacity INTEGER NOT NULL DEFAULT 40,
    driver_name VARCHAR(100),
    driver_phone VARCHAR(20),
    route_id UUID REFERENCES transport_routes(id),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_buses_route ON buses(route_id);

CREATE TABLE IF NOT EXISTS transport_stops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    latitude DECIMAL(10,8),
    longitude DECIMAL(11,8),
    pickup_time TIME,
    drop_time TIME,
    stop_order INTEGER NOT NULL,
    UNIQUE (route_id, stop_order)
);

CREATE TABLE IF NOT EXISTS student_transport (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id),
    route_id UUID NOT NULL REFERENCES transport_routes(id),
    stop_id UUID REFERENCES transport_stops(id),
    academic_year_id UUID NOT NULL REFERENCES academic_years(id),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (student_id, academic_year_id)
);

CREATE INDEX IF NOT EXISTS idx_student_transport_route ON student_transport(route_id);

CREATE TABLE IF NOT EXISTS bus_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bus_id UUID NOT NULL REFERENCES buses(id),
    latitude DECIMAL(10,8) NOT NULL,
    longitude DECIMAL(11,8) NOT NULL,
    speed DECIMAL(5,2),
    heading DECIMAL(5,2),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bus_locations_recent ON bus_locations(bus_id, recorded_at DESC);

-- 15. HOSTEL
CREATE TABLE IF NOT EXISTS hostel_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    code VARCHAR(20),
    gender_id SMALLINT REFERENCES genders(id),
    total_rooms INTEGER,
    warden_id UUID REFERENCES staff(id),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hostel_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    block_id UUID NOT NULL REFERENCES hostel_blocks(id),
    room_no VARCHAR(20) NOT NULL,
    floor INTEGER,
    capacity INTEGER NOT NULL DEFAULT 2,
    room_type VARCHAR(50) DEFAULT 'shared', 
    monthly_fee DECIMAL(12,2),
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (block_id, room_no)
);

CREATE TABLE IF NOT EXISTS hostel_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id),
    room_id UUID NOT NULL REFERENCES hostel_rooms(id),
    academic_year_id UUID NOT NULL REFERENCES academic_years(id),
    bed_no INTEGER,
    allocated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    vacated_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (student_id, academic_year_id)
);

CREATE INDEX IF NOT EXISTS idx_hostel_allocations_room ON hostel_allocations(room_id);

-- 16. EVENTS
DO $$ BEGIN
    CREATE TYPE event_type_enum AS ENUM ('academic','cultural','sports','holiday','meeting','exam','other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(200) NOT NULL,
    description TEXT,
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
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_dates ON events(start_date, end_date);

DROP TRIGGER IF EXISTS trg_events_updated ON events;
CREATE TRIGGER trg_events_updated
BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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
    title VARCHAR(200) NOT NULL,
    description TEXT,
    subject_id UUID REFERENCES subjects(id),
    class_id UUID REFERENCES classes(id),
    instructor_id UUID REFERENCES staff(id),
    is_published BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_lms_courses_updated ON lms_courses;
CREATE TRIGGER trg_lms_courses_updated
BEFORE UPDATE ON lms_courses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$ BEGIN
    CREATE TYPE material_type_enum AS ENUM ('video','document','link','quiz','assignment');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS lms_materials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id UUID NOT NULL REFERENCES lms_courses(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    material_type material_type_enum NOT NULL,
    content_url TEXT,
    file_size INTEGER,
    duration INTEGER, 
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_published BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lms_materials_course ON lms_materials(course_id);

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
('timetable.view', 'View Timetable'), ('timetable.manage', 'Manage Timetable')
ON CONFLICT (code) DO NOTHING;

-- Views
CREATE OR REPLACE VIEW active_students AS
SELECT * FROM students WHERE deleted_at IS NULL;

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
    IF (pg_trigger_depth() = 0) THEN
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
-- Already in schema, just ensuring it exists
-- ALTER TABLE student_fees ADD CONSTRAINT chk_paid_not_exceed ...
-- ============================================================
-- TIMETABLE & PROMOTION LOGIC (  Output)
-- ============================================================

-- 1. TIMETABLE VALIDATION
-- Requirement: Assigned teacher MUST belong to that class.
-- We verify against `class_subjects` or ensure teacher is staff.
-- Trigger to validate teacher assignment.

CREATE OR REPLACE FUNCTION validate_timetable_entry()
RETURNS TRIGGER AS $$
DECLARE
    v_is_valid BOOLEAN;
BEGIN
    -- Skip check if no teacher assigned (free period)
    IF NEW.teacher_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Check if teacher is assigned to this class (via class_subjects)
    -- This enforces: Teacher T teaches Subject S in Class C
    SELECT EXISTS (
        SELECT 1 FROM class_subjects cs
        WHERE cs.class_section_id = NEW.class_section_id
          AND cs.teacher_id = NEW.teacher_id
          AND (NEW.subject_id IS NULL OR cs.subject_id = NEW.subject_id)
    ) INTO v_is_valid;

    IF NOT v_is_valid THEN
        -- Fallback: If not strictly in class_subjects (e.g. substitute), 
        -- check if they are at least Active Staff.
        -- BUT Prompt says: "Assigned teacher MUST belong to that class".
        -- So strict check is better.
        RAISE EXCEPTION 'Teacher is not assigned to this class/subject in class_subjects mapping';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_timetable ON timetable_entries;
CREATE TRIGGER trg_validate_timetable
BEFORE INSERT OR UPDATE ON timetable_entries
FOR EACH ROW EXECUTE FUNCTION validate_timetable_entry();

-- 2. TIMETABLE RLS POLICIES
ALTER TABLE timetable_entries ENABLE ROW LEVEL SECURITY;

-- Helper to get current user's person_id (assuming linked via users table)
-- We already have auth_has_role.

-- Policy: Admin/Manage
CREATE POLICY "Timetable Manage" ON timetable_entries
FOR ALL
USING (
    auth_has_role(ARRAY['admin']) OR 
    EXISTS (
        SELECT 1 FROM user_roles ur 
        JOIN role_permissions rp ON ur.role_id = rp.role_id
        JOIN permissions p ON rp.permission_id = p.id
        WHERE ur.user_id = auth.uid() AND p.code = 'timetable.manage'
    )
);

-- Policy: View (Admin, Teacher, Student, Parent)
DROP POLICY IF EXISTS "Timetable View" ON timetable_entries;
CREATE POLICY "Timetable View" ON timetable_entries
FOR SELECT
USING (
    -- 1. Admin/Staff with View Perms
    auth_has_role(ARRAY['admin', 'accounts']) OR
    
    -- 2. Teacher (View OWN schedule)
    (
        auth_has_role(ARRAY['teacher', 'staff']) AND
        teacher_id IN (
            SELECT id FROM staff 
            WHERE person_id = (SELECT person_id FROM users WHERE id = auth.uid())
        )
    ) OR

    -- 3. Student (View CLASS schedule)
    (
        auth_has_role(ARRAY['student']) AND
        class_section_id IN (
            SELECT se.class_section_id 
            FROM student_enrollments se
            JOIN students s ON se.student_id = s.id
            WHERE s.person_id = (SELECT person_id FROM users WHERE id = auth.uid())
              AND se.status = 'active'
        )
    ) OR

    -- 4. Parent (View CHILD'S CLASS schedule)
    (
        auth_has_role(ARRAY['parent']) AND
        class_section_id IN (
            SELECT se.class_section_id
            FROM student_enrollments se
            JOIN students s ON se.student_id = s.id
            JOIN student_parents sp ON s.id = sp.student_id
            JOIN parents p ON sp.parent_id = p.id
            WHERE p.person_id = (SELECT person_id FROM users WHERE id = auth.uid())
              AND se.status = 'active'
        )
    )
);

-- 3. AUTOMATIC CLASS PROMOTION
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

-- SECTION 99: GRANTS & FINALIZATION
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, service_role;

-- Allow authenticated users to interact (enforced by RLS)
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO authenticated;

-- Commit Transaction
COMMIT;

-- VERIFICATION (Commented)
/*
SELECT table_name, row_security FROM pg_tables WHERE schemaname = 'public';
*/
