-- Extension required for UUID generation and EXCLUDE constraints
-- Requires btree_gist for UUID equality in EXCLUDE constraints
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 0. REFERENCE TABLES (HARDENED)
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

-- 1. CORE TRIGGERS (GLOBAL)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. PERSONS (FIXED)
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

CREATE TRIGGER trg_persons_display_name
BEFORE INSERT OR UPDATE ON persons
FOR EACH ROW EXECUTE FUNCTION update_person_display_name();

-- 3. CONTACTS (CRITICAL FIX APPLIED)
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

-- ONLY ONE PRIMARY CONTACT PER TYPE
CREATE UNIQUE INDEX uq_primary_contact_only
ON person_contacts(person_id, contact_type)
WHERE is_primary = true;

CREATE TRIGGER trg_person_contacts_updated
BEFORE UPDATE ON person_contacts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3️⃣ HARDENED: Prevent duplicates (case-insensitive)
CREATE UNIQUE INDEX uq_person_contact_unique
ON person_contacts(person_id, contact_type, lower(contact_value))
WHERE deleted_at IS NULL;

-- 4. USERS & RBAC (ORPHAN FIXED)
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
    -- 4️⃣ HARDENED: Cascade delete on person removal (Option A)
    person_id UUID NOT NULL UNIQUE REFERENCES persons(id) ON DELETE RESTRICT,
    account_status account_status_enum NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 🔒 Enforce Active Person Check on User Creation
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

CREATE TRIGGER trg_user_active_person
BEFORE INSERT OR UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION ensure_active_person_ref();

CREATE TRIGGER trg_users_updated
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
    granted_by UUID REFERENCES users(id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role_id)
);

-- 5. STUDENTS (INDEXED)
CREATE TABLE IF NOT EXISTS student_statuses (
    id SMALLINT PRIMARY KEY,
    code VARCHAR(20) UNIQUE NOT NULL,
    is_terminal BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL UNIQUE REFERENCES persons(id) ON DELETE RESTRICT,
    admission_no VARCHAR(30) NOT NULL UNIQUE,
    admission_date DATE NOT NULL,
    category_id SMALLINT REFERENCES student_categories(id),
    religion_id SMALLINT REFERENCES religions(id),
    blood_group_id SMALLINT REFERENCES blood_groups(id),
    status_id SMALLINT NOT NULL REFERENCES student_statuses(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_students_status ON students(status_id);

CREATE TRIGGER trg_students_updated
BEFORE UPDATE ON students
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 6. PARENTS (PRIMARY GUARDIAN FIX)
CREATE TABLE IF NOT EXISTS parents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL UNIQUE REFERENCES persons(id) ON DELETE RESTRICT,
    occupation VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE TRIGGER trg_parents_updated
BEFORE UPDATE ON parents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS student_parents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 1️⃣ HARDENED: NOT NULL
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
    -- 2️⃣ HARDENED: No overlapping validity periods
    CONSTRAINT no_parent_date_overlap EXCLUDE USING gist (
        student_id WITH =,
        parent_id WITH =,
        daterange(valid_from, valid_to, '[]') WITH &&
    ),
    -- 1️⃣ POLISH: Check valid range
    CONSTRAINT chk_parent_valid_range CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from)
);

-- 🔒 Enforce Active Student/Parent Check
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

CREATE TRIGGER trg_student_parents_active
BEFORE INSERT OR UPDATE ON student_parents
FOR EACH ROW EXECUTE FUNCTION ensure_active_student_parent();

-- ONLY ONE PRIMARY PARENT
CREATE UNIQUE INDEX uq_student_primary_parent
ON student_parents(student_id)
WHERE is_primary_contact = true
  AND deleted_at IS NULL;

-- 7. ACADEMICS (CONSISTENCY ENFORCED)
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

-- 2️⃣ POLISH: Enrollment Status Enum
DO $$ BEGIN
    CREATE TYPE enrollment_status_enum AS ENUM ('active','completed','withdrawn');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS student_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 1️⃣ HARDENED: NOT NULL
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    academic_year_id UUID NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
    class_section_id UUID NOT NULL REFERENCES class_sections(id) ON DELETE RESTRICT,
    status enrollment_status_enum NOT NULL DEFAULT 'active',
    start_date DATE NOT NULL,
    end_date DATE,
    roll_number INTEGER, -- 🆕 Auto-assigned
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    -- ❌ REMOVED: UNIQUE (student_id, academic_year_id) to allow transfers
    CONSTRAINT no_enrollment_overlap EXCLUDE USING gist (
        student_id WITH =,
        daterange(start_date, end_date, '[]') WITH &&
    ),
    UNIQUE (class_section_id, academic_year_id, roll_number) -- Ensure unique roll per section
);

-- 🆕 Function to Recalculate Roll Numbers Alphabetically
CREATE OR REPLACE FUNCTION recalculate_section_rolls(
    p_class_section_id UUID,
    p_academic_year_id UUID
)
RETURNS VOID AS $$
DECLARE
    r RECORD;
    counter INTEGER := 1;
BEGIN
    FOR r IN
        SELECT se.id
        FROM student_enrollments se
        JOIN students s ON se.student_id = s.id
        JOIN persons p ON s.person_id = p.id
        WHERE se.class_section_id = p_class_section_id
          AND se.academic_year_id = p_academic_year_id
          AND se.status = 'active'
          AND se.deleted_at IS NULL
          AND s.deleted_at IS NULL
        ORDER BY p.first_name ASC, p.last_name ASC
    LOOP
        UPDATE student_enrollments
        SET roll_number = counter
        WHERE id = r.id;
        
        counter := counter + 1;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE INDEX idx_active_enrollments
ON student_enrollments(student_id)
WHERE status = 'active';

CREATE TRIGGER trg_student_enrollments_updated
BEFORE UPDATE ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 🔒 Enrollment Integrity Trigger
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

CREATE TRIGGER trg_validate_enrollment
BEFORE INSERT OR UPDATE ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION validate_enrollment_year();

-- 🔒 Enforce Active Student Check on Enrollment
CREATE OR REPLACE FUNCTION ensure_active_student_enrollment()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM students WHERE id = NEW.student_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot enroll a deleted student';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enroll_active_student
BEFORE INSERT OR UPDATE ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION ensure_active_student_enrollment();

-- 8. ATTENDANCE (FINAL)
DO $$ BEGIN
    CREATE TYPE attendance_status_enum AS ENUM ('present','absent','late','half_day');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS daily_attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 2️⃣ HARDENED: NOT NULL
    student_enrollment_id UUID NOT NULL REFERENCES student_enrollments(id),
    attendance_date DATE NOT NULL,
    status attendance_status_enum NOT NULL,
    marked_by UUID REFERENCES users(id) ON DELETE SET NULL,
    marked_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_attendance_date_past CHECK (attendance_date <= current_date)
);

CREATE TRIGGER trg_attendance_updated
BEFORE UPDATE ON daily_attendance
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX uq_attendance_active
ON daily_attendance(student_enrollment_id, attendance_date)
WHERE deleted_at IS NULL;

CREATE INDEX idx_attendance_date ON daily_attendance(attendance_date);
-- 3️⃣ HARDENED: Performance Index
CREATE INDEX idx_attendance_enrollment ON daily_attendance(student_enrollment_id);
-- 4️⃣ OPTIMIZATION: Composite Index for Reporting
CREATE INDEX idx_attendance_composite 
ON daily_attendance(student_enrollment_id, status, attendance_date);


-- 3️⃣ HARDENED: Attendance Integrity
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

CREATE TRIGGER trg_validate_attendance
BEFORE INSERT OR UPDATE ON daily_attendance
FOR EACH ROW EXECUTE FUNCTION validate_attendance_date();

-- 9. VIEWS (SOFT DELETE DISCIPLINE)
CREATE OR REPLACE VIEW active_students AS
SELECT * FROM students WHERE deleted_at IS NULL;

-- 2️⃣ POLISH: Partial Index for Active Students
CREATE INDEX idx_students_active
ON students(id)
WHERE deleted_at IS NULL;

CREATE OR REPLACE VIEW active_persons AS
SELECT * FROM persons WHERE deleted_at IS NULL;

-- 10. SEED DATA (REFERENCE TABLES)
INSERT INTO genders (id, name) VALUES
(1, 'Male'), (2, 'Female'), (3, 'Other')
ON CONFLICT (id) DO NOTHING;

INSERT INTO student_statuses (id, code, is_terminal) VALUES
(1, 'active', false),
(2, 'graduated', true),
(3, 'withdrawn', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO blood_groups (id, name) VALUES
(1, 'A+'), (2, 'A-'), (3, 'B+'), (4, 'B-'),
(5, 'AB+'), (6, 'AB-'), (7, 'O+'), (8, 'O-')
ON CONFLICT (id) DO NOTHING;

INSERT INTO staff_designations (id, name) VALUES
(1, 'Principal'), (2, 'Teacher'), (3, 'Admin')
ON CONFLICT (id) DO NOTHING;

INSERT INTO relationship_types (id, name) VALUES
(1, 'Father'), (2, 'Mother'), (3, 'Guardian')
ON CONFLICT (id) DO NOTHING;

INSERT INTO student_categories (id, name) VALUES
(1, 'General'), (2, 'OBC'), (3, 'SC/ST')
ON CONFLICT (id) DO NOTHING;

INSERT INTO religions (id, name) VALUES
(1, 'Hindu'), (2, 'Muslim'), (3, 'Christian'), (4, 'Sikh'), (5, 'Other')
ON CONFLICT (id) DO NOTHING;

-- 11. RBAC SEED DATA
-- Create Roles
INSERT INTO roles (code, name, is_system) VALUES
('admin', 'Administrator', true),
('teacher', 'Teacher', true),
('staff', 'Staff Member', true),
('accounts', 'Accounts Department', true),
('student', 'Student', true),
('parent', 'Parent', true)
ON CONFLICT (code) DO NOTHING;

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

CREATE TRIGGER trg_protect_system_roles_delete
BEFORE DELETE ON roles
FOR EACH ROW EXECUTE FUNCTION prevent_system_role_change();

CREATE TRIGGER trg_protect_system_roles_update
BEFORE UPDATE ON roles
FOR EACH ROW EXECUTE FUNCTION prevent_system_role_change();

-- Create Permissions
INSERT INTO permissions (code, name) VALUES
('students.view', 'View Students'),
('students.create', 'Create Students'),
('students.edit', 'Edit Students'),
('students.delete', 'Delete Students')
ON CONFLICT (code) DO NOTHING;

-- Assign Permissions to Roles (Admin gets all)
WITH admin_role AS (SELECT id FROM roles WHERE code = 'admin')
INSERT INTO role_permissions (role_id, permission_id)
SELECT admin_role.id, p.id FROM permissions p, admin_role
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 12. STAFF TABLE (Required for staffRoutes.js)
CREATE TABLE IF NOT EXISTS staff_statuses (
    id SMALLINT PRIMARY KEY,
    code VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(50) NOT NULL
);

INSERT INTO staff_statuses (id, code, name) VALUES
(1, 'active', 'Active'),
(2, 'on_leave', 'On Leave'),
(3, 'resigned', 'Resigned'),
(4, 'terminated', 'Terminated')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL UNIQUE REFERENCES persons(id) ON DELETE RESTRICT,
    staff_code VARCHAR(30) NOT NULL UNIQUE,
    designation_id SMALLINT REFERENCES staff_designations(id),
    joining_date DATE NOT NULL,
    status_id SMALLINT NOT NULL DEFAULT 1 REFERENCES staff_statuses(id),
    salary DECIMAL(12,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_staff_joining_past CHECK (joining_date <= current_date)
);

CREATE INDEX idx_staff_status ON staff(status_id);
CREATE INDEX idx_staff_active ON staff(id) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_staff_updated
BEFORE UPDATE ON staff
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 🔒 Enforce Active Person Check on Staff Creation
CREATE OR REPLACE FUNCTION ensure_active_person_staff()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM persons WHERE id = NEW.person_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot link staff to deleted person';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_staff_active_person
BEFORE INSERT OR UPDATE ON staff
FOR EACH ROW EXECUTE FUNCTION ensure_active_person_staff();

-- 13. ADDITIONAL PERMISSIONS FOR PHASE 1 MODULES
INSERT INTO permissions (code, name) VALUES
-- Staff permissions
('staff.view', 'View Staff'),
('staff.create', 'Create Staff'),
('staff.edit', 'Edit Staff'),
('staff.delete', 'Delete Staff'),
-- Users permissions
('users.view', 'View Users'),
('users.create', 'Create Users'),
('users.edit', 'Edit Users'),
('users.delete', 'Delete Users'),
-- Academics permissions
('academics.view', 'View Academics'),
('academics.manage', 'Manage Academics'),
-- Attendance permissions
('attendance.view', 'View Attendance'),
('attendance.mark', 'Mark Attendance'),
('attendance.edit', 'Edit Attendance'),
-- Accounts Department permissions
('fees.view', 'View Fees'),
('fees.manage', 'Manage Fees'),
('fees.collect', 'Collect Fees'),
('transactions.view', 'View Transactions'),
('receipts.generate', 'Generate Receipts'),
('reports.financial', 'View Financial Reports'),
('staff.create', 'Create Staff'),
('students.create', 'Create Students') -- Needed for Add Student feature
ON CONFLICT (code) DO NOTHING;

-- Assign new permissions to Admin role
WITH admin_role AS (SELECT id FROM roles WHERE code = 'admin')
INSERT INTO role_permissions (role_id, permission_id)
SELECT admin_role.id, p.id FROM permissions p, admin_role
WHERE p.code IN ('staff.view','staff.create','staff.edit','staff.delete',
                 'users.view','users.create','users.edit','users.delete',
                 'academics.view','academics.manage',
                 'attendance.view','attendance.mark','attendance.edit')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Assign teacher-specific permissions
WITH teacher_role AS (SELECT id FROM roles WHERE code = 'teacher')
INSERT INTO role_permissions (role_id, permission_id)
SELECT teacher_role.id, p.id FROM permissions p, teacher_role
WHERE p.code IN ('students.view', 'attendance.view', 'attendance.mark', 'academics.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Assign accounts department permissions
WITH accounts_role AS (SELECT id FROM roles WHERE code = 'accounts')
INSERT INTO role_permissions (role_id, permission_id)
SELECT accounts_role.id, p.id FROM permissions p, accounts_role
WHERE p.code IN ('fees.view', 'fees.manage', 'fees.collect', 
                 'transactions.view', 'receipts.generate', 'reports.financial',
                 'students.view', 'students.create', 'students.edit', 'academics.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================
-- PHASE 2: FEE MANAGEMENT TABLES
-- ============================================================

-- 14. FEE TYPES (e.g., Tuition, Transport, Lab, etc.)
CREATE TABLE IF NOT EXISTS fee_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    code VARCHAR(30) UNIQUE,
    description TEXT,
    is_recurring BOOLEAN NOT NULL DEFAULT TRUE,
    is_optional BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO fee_types (name, code, is_recurring, is_optional) VALUES
('Tuition Fee', 'TUITION', true, false),
('Transport Fee', 'TRANSPORT', true, true),
('Lab Fee', 'LAB', true, true),
('Library Fee', 'LIBRARY', true, false),
('Exam Fee', 'EXAM', false, false),
('Admission Fee', 'ADMISSION', false, false),
('Sports Fee', 'SPORTS', true, true)
ON CONFLICT (name) DO NOTHING;

-- 15. FEE STRUCTURES (Fee amount per class per academic year)
CREATE TABLE IF NOT EXISTS fee_structures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academic_year_id UUID NOT NULL REFERENCES academic_years(id),
    class_id UUID NOT NULL REFERENCES classes(id),
    fee_type_id UUID NOT NULL REFERENCES fee_types(id),
    amount DECIMAL(12,2) NOT NULL,
    due_date DATE,
    frequency VARCHAR(20) DEFAULT 'monthly', -- monthly, quarterly, yearly, one_time
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (academic_year_id, class_id, fee_type_id),
    CONSTRAINT chk_fee_amount_positive CHECK (amount > 0)
);

CREATE TRIGGER trg_fee_structures_updated
BEFORE UPDATE ON fee_structures
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 16. STUDENT FEES (Individual student fee assignments)
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
    period_month INTEGER, -- 1-12 for monthly fees
    period_year INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_amounts CHECK (amount_due >= 0 AND amount_paid >= 0 AND discount >= 0),
    CONSTRAINT chk_paid_not_exceed CHECK (amount_paid <= amount_due - discount)
);

CREATE INDEX idx_student_fees_student ON student_fees(student_id);
CREATE INDEX idx_student_fees_status ON student_fees(status);

CREATE TRIGGER trg_student_fees_updated
BEFORE UPDATE ON student_fees
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Auto-update fee status based on payments
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

CREATE TRIGGER trg_auto_fee_status
BEFORE UPDATE ON student_fees
FOR EACH ROW EXECUTE FUNCTION update_fee_status();

-- 17. FEE TRANSACTIONS (Payment records)
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

CREATE INDEX idx_transactions_paid_at ON fee_transactions(paid_at);

-- Update student_fees.amount_paid on transaction insert
CREATE OR REPLACE FUNCTION update_fee_paid_amount()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE student_fees 
    SET amount_paid = amount_paid + NEW.amount
    WHERE id = NEW.student_fee_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_paid_on_transaction
AFTER INSERT ON fee_transactions
FOR EACH ROW EXECUTE FUNCTION update_fee_paid_amount();

-- 18. RECEIPTS
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

-- ============================================================
-- PHASE 2: EXAMS & RESULTS TABLES
-- ============================================================

-- 19. SUBJECTS
CREATE TABLE IF NOT EXISTS subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20) UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO subjects (name, code) VALUES
('English', 'ENG'),
('Mathematics', 'MATH'),
('Science', 'SCI'),
('Social Studies', 'SST'),
('Hindi', 'HIN'),
('Computer Science', 'CS'),
('Physical Education', 'PE')
ON CONFLICT (code) DO NOTHING;

-- 20. CLASS SUBJECTS (Which subjects are taught in which class)
CREATE TABLE IF NOT EXISTS class_subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_section_id UUID NOT NULL REFERENCES class_sections(id),
    subject_id UUID NOT NULL REFERENCES subjects(id),
    teacher_id UUID REFERENCES staff(id),
    UNIQUE (class_section_id, subject_id)
);

-- 21. EXAMS
DO $$ BEGIN
    CREATE TYPE exam_status_enum AS ENUM ('scheduled','ongoing','completed','cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS exams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    academic_year_id UUID NOT NULL REFERENCES academic_years(id),
    exam_type VARCHAR(50) NOT NULL, -- midterm, final, unit_test, quarterly
    start_date DATE,
    end_date DATE,
    status exam_status_enum NOT NULL DEFAULT 'scheduled',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_exam_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE TRIGGER trg_exams_updated
BEFORE UPDATE ON exams
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 22. EXAM SUBJECTS (Subject-wise exam details)
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

-- 23. GRADING SCALES
CREATE TABLE IF NOT EXISTS grading_scales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL,
    min_percentage DECIMAL(5,2) NOT NULL,
    max_percentage DECIMAL(5,2) NOT NULL,
    grade VARCHAR(5) NOT NULL,
    grade_point DECIMAL(3,1),
    CONSTRAINT chk_percentage_range CHECK (min_percentage >= 0 AND max_percentage <= 100 AND min_percentage < max_percentage)
);

INSERT INTO grading_scales (name, min_percentage, max_percentage, grade, grade_point) VALUES
('A+', 90, 100, 'A+', 10.0),
('A', 80, 89.99, 'A', 9.0),
('B+', 70, 79.99, 'B+', 8.0),
('B', 60, 69.99, 'B', 7.0),
('C+', 50, 59.99, 'C+', 6.0),
('C', 40, 49.99, 'C', 5.0),
('D', 35, 39.99, 'D', 4.0),
('F', 0, 34.99, 'F', 0.0)
ON CONFLICT DO NOTHING;

-- 24. MARKS
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

CREATE INDEX idx_marks_enrollment ON marks(student_enrollment_id);
CREATE INDEX idx_marks_exam_subject ON marks(exam_subject_id);

CREATE TRIGGER trg_marks_updated
BEFORE UPDATE ON marks
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- PHASE 2: PERMISSIONS
-- ============================================================

INSERT INTO permissions (code, name) VALUES
-- Fee permissions
('fees.view', 'View Fees'),
('fees.manage', 'Manage Fees'),
('fees.collect', 'Collect Fees'),
-- Exam/Results permissions
('exams.view', 'View Exams'),
('exams.manage', 'Manage Exams'),
('marks.view', 'View Marks'),
('marks.enter', 'Enter Marks'),
('results.view', 'View Results'),
('results.generate', 'Generate Results')
ON CONFLICT (code) DO NOTHING;

-- Admin gets all
WITH admin_role AS (SELECT id FROM roles WHERE code = 'admin')
INSERT INTO role_permissions (role_id, permission_id)
SELECT admin_role.id, p.id FROM permissions p, admin_role
WHERE p.code IN ('fees.view','fees.manage','fees.collect',
                 'exams.view','exams.manage','marks.view','marks.enter',
                 'results.view','results.generate')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Teachers can view exams and enter marks
WITH teacher_role AS (SELECT id FROM roles WHERE code = 'teacher')
INSERT INTO role_permissions (role_id, permission_id)
SELECT teacher_role.id, p.id FROM permissions p, teacher_role
WHERE p.code IN ('exams.view', 'marks.view', 'marks.enter', 'results.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Create Accounts role for fee collection
INSERT INTO roles (code, name, is_system) VALUES
('accounts', 'Accounts Staff', true)
ON CONFLICT (code) DO NOTHING;

WITH accounts_role AS (SELECT id FROM roles WHERE code = 'accounts')
INSERT INTO role_permissions (role_id, permission_id)
SELECT accounts_role.id, p.id FROM permissions p, accounts_role
WHERE p.code IN ('fees.view', 'fees.collect', 'students.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================
-- PHASE 3: COMMUNICATION & SUPPORT TABLES
-- ============================================================

-- 25. COMPLAINTS / GRIEVANCES
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
    ticket_no VARCHAR(30) UNIQUE,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(50), -- academic, fee, transport, hostel, other
    priority complaint_priority_enum NOT NULL DEFAULT 'medium',
    status complaint_status_enum NOT NULL DEFAULT 'open',
    -- Who raised it
    raised_by UUID NOT NULL REFERENCES users(id),
    raised_for_student_id UUID REFERENCES students(id), -- If complaint is about a student
    -- Assignment
    assigned_to UUID REFERENCES users(id),
    -- Resolution
    resolution TEXT,
    resolved_by UUID REFERENCES users(id),
    resolved_at TIMESTAMPTZ,
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_complaints_status ON complaints(status);
CREATE INDEX idx_complaints_raised_by ON complaints(raised_by);

CREATE TRIGGER trg_complaints_updated
BEFORE UPDATE ON complaints
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Auto-generate ticket number
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

CREATE SEQUENCE IF NOT EXISTS complaint_ticket_seq START 1;

CREATE TRIGGER trg_complaints_ticket
BEFORE INSERT ON complaints
FOR EACH ROW EXECUTE FUNCTION generate_ticket_no();

-- 26. NOTICES / ANNOUNCEMENTS
DO $$ BEGIN
    CREATE TYPE notice_audience_enum AS ENUM ('all','students','staff','parents','class');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS notices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    audience notice_audience_enum NOT NULL DEFAULT 'all',
    target_class_id UUID REFERENCES classes(id), -- If audience = 'class'
    priority complaint_priority_enum NOT NULL DEFAULT 'medium',
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    publish_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notices_audience ON notices(audience);
CREATE INDEX idx_notices_publish ON notices(publish_at);

CREATE TRIGGER trg_notices_updated
BEFORE UPDATE ON notices
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 27. LEAVE APPLICATIONS
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
    applicant_id UUID NOT NULL REFERENCES users(id),
    leave_type leave_type_enum NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason TEXT NOT NULL,
    status leave_status_enum NOT NULL DEFAULT 'pending',
    -- Approval
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    review_remarks TEXT,
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_leave_dates CHECK (end_date >= start_date)
);

CREATE INDEX idx_leaves_applicant ON leave_applications(applicant_id);
CREATE INDEX idx_leaves_status ON leave_applications(status);

CREATE TRIGGER trg_leaves_updated
BEFORE UPDATE ON leave_applications
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 28. DIARY / HOMEWORK
CREATE TABLE IF NOT EXISTS diary_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_section_id UUID NOT NULL REFERENCES class_sections(id),
    subject_id UUID REFERENCES subjects(id),
    entry_date DATE NOT NULL,
    title VARCHAR(200),
    content TEXT NOT NULL,
    homework_due_date DATE,
    attachments JSONB, -- Array of file URLs
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_diary_class ON diary_entries(class_section_id);
CREATE INDEX idx_diary_date ON diary_entries(entry_date);

CREATE TRIGGER trg_diary_updated
BEFORE UPDATE ON diary_entries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 29. TIMETABLE
DO $$ BEGIN
    CREATE TYPE day_of_week_enum AS ENUM ('monday','tuesday','wednesday','thursday','friday','saturday','sunday');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL, -- Period 1, Lunch, etc.
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT chk_period_times CHECK (end_time > start_time)
);

INSERT INTO periods (name, start_time, end_time, sort_order) VALUES
('Period 1', '08:00', '08:45', 1),
('Period 2', '08:45', '09:30', 2),
('Period 3', '09:30', '10:15', 3),
('Break', '10:15', '10:30', 4),
('Period 4', '10:30', '11:15', 5),
('Period 5', '11:15', '12:00', 6),
('Lunch', '12:00', '12:45', 7),
('Period 6', '12:45', '13:30', 8),
('Period 7', '13:30', '14:15', 9),
('Period 8', '14:15', '15:00', 10)
ON CONFLICT DO NOTHING;

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
    -- Prevent duplicate entries for same class/period/day
    UNIQUE (class_section_id, period_id, day_of_week)
);

CREATE INDEX idx_timetable_class ON timetable_entries(class_section_id);
CREATE INDEX idx_timetable_teacher ON timetable_entries(teacher_id);

CREATE TRIGGER trg_timetable_updated
BEFORE UPDATE ON timetable_entries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- PHASE 3: PERMISSIONS
-- ============================================================

INSERT INTO permissions (code, name) VALUES
-- Complaints
('complaints.view', 'View Complaints'),
('complaints.create', 'Create Complaints'),
('complaints.manage', 'Manage Complaints'),
-- Notices
('notices.view', 'View Notices'),
('notices.create', 'Create Notices'),
('notices.manage', 'Manage Notices'),
-- Leaves
('leaves.view', 'View Leaves'),
('leaves.apply', 'Apply for Leave'),
('leaves.approve', 'Approve Leaves'),
-- Diary
('diary.view', 'View Diary'),
('diary.create', 'Create Diary Entries'),
-- Timetable
('timetable.view', 'View Timetable'),
('timetable.manage', 'Manage Timetable')
ON CONFLICT (code) DO NOTHING;

-- Admin gets all
WITH admin_role AS (SELECT id FROM roles WHERE code = 'admin')
INSERT INTO role_permissions (role_id, permission_id)
SELECT admin_role.id, p.id FROM permissions p, admin_role
WHERE p.code IN ('complaints.view','complaints.create','complaints.manage',
                 'notices.view','notices.create','notices.manage',
                 'leaves.view','leaves.apply','leaves.approve',
                 'diary.view','diary.create',
                 'timetable.view','timetable.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Teachers
WITH teacher_role AS (SELECT id FROM roles WHERE code = 'teacher')
INSERT INTO role_permissions (role_id, permission_id)
SELECT teacher_role.id, p.id FROM permissions p, teacher_role
WHERE p.code IN ('complaints.view','complaints.create',
                 'notices.view',
                 'leaves.view','leaves.apply',
                 'diary.view','diary.create',
                 'timetable.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Staff
WITH staff_role AS (SELECT id FROM roles WHERE code = 'staff')
INSERT INTO role_permissions (role_id, permission_id)
SELECT staff_role.id, p.id FROM permissions p, staff_role
WHERE p.code IN ('complaints.view','complaints.create',
                 'notices.view',
                 'leaves.view','leaves.apply',
                 'timetable.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ============================================================
-- PHASE 4: EXTENDED MODULES
-- ============================================================

-- 30. TRANSPORT - ROUTES
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

CREATE TRIGGER trg_transport_routes_updated
BEFORE UPDATE ON transport_routes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 31. TRANSPORT - BUSES
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

-- 32. TRANSPORT - STOPS
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

-- 33. TRANSPORT - STUDENT ASSIGNMENTS
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

-- 34. TRANSPORT - LIVE TRACKING
CREATE TABLE IF NOT EXISTS bus_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bus_id UUID NOT NULL REFERENCES buses(id),
    latitude DECIMAL(10,8) NOT NULL,
    longitude DECIMAL(11,8) NOT NULL,
    speed DECIMAL(5,2),
    heading DECIMAL(5,2),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bus_locations_recent ON bus_locations(bus_id, recorded_at DESC);

-- 35. HOSTEL - BLOCKS
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

-- 36. HOSTEL - ROOMS
CREATE TABLE IF NOT EXISTS hostel_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    block_id UUID NOT NULL REFERENCES hostel_blocks(id),
    room_no VARCHAR(20) NOT NULL,
    floor INTEGER,
    capacity INTEGER NOT NULL DEFAULT 2,
    room_type VARCHAR(50) DEFAULT 'shared', -- single, shared, dormitory
    monthly_fee DECIMAL(12,2),
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (block_id, room_no)
);

-- 37. HOSTEL - ALLOCATIONS
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

CREATE INDEX idx_hostel_allocations_room ON hostel_allocations(room_id);

-- 38. EVENTS
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

CREATE INDEX idx_events_dates ON events(start_date, end_date);

CREATE TRIGGER trg_events_updated
BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 39. LMS - COURSES
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

CREATE TRIGGER trg_lms_courses_updated
BEFORE UPDATE ON lms_courses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 40. LMS - COURSE MATERIALS
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
    duration INTEGER, -- in minutes for videos
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_published BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_lms_materials_course ON lms_materials(course_id);

-- ============================================================
-- PHASE 4: PERMISSIONS
-- ============================================================

INSERT INTO permissions (code, name) VALUES
-- Transport
('transport.view', 'View Transport'),
('transport.manage', 'Manage Transport'),
-- Hostel
('hostel.view', 'View Hostel'),
('hostel.manage', 'Manage Hostel'),
-- Events
('events.view', 'View Events'),
('events.manage', 'Manage Events'),
-- LMS
('lms.view', 'View LMS'),
('lms.create', 'Create LMS Content'),
('lms.manage', 'Manage LMS')
ON CONFLICT (code) DO NOTHING;

-- Admin gets all
WITH admin_role AS (SELECT id FROM roles WHERE code = 'admin')
INSERT INTO role_permissions (role_id, permission_id)
SELECT admin_role.id, p.id FROM permissions p, admin_role
WHERE p.code IN ('transport.view','transport.manage',
                 'hostel.view','hostel.manage',
                 'events.view','events.manage',
                 'lms.view','lms.create','lms.manage')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Teachers can view and create LMS
WITH teacher_role AS (SELECT id FROM roles WHERE code = 'teacher')
INSERT INTO role_permissions (role_id, permission_id)
SELECT teacher_role.id, p.id FROM permissions p, teacher_role
WHERE p.code IN ('transport.view', 'events.view', 'lms.view', 'lms.create')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Staff can view
WITH staff_role AS (SELECT id FROM roles WHERE code = 'staff')
INSERT INTO role_permissions (role_id, permission_id)
SELECT staff_role.id, p.id FROM permissions p, staff_role
WHERE p.code IN ('students.view', 'attendance.view', 'leaves.manage', 'complaints.view', 'fees.view', 'diary.view', 'timetable.view', 'notices.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Students
WITH student_role AS (SELECT id FROM roles WHERE code = 'student')
INSERT INTO role_permissions (role_id, permission_id)
SELECT student_role.id, p.id FROM permissions p, student_role
WHERE p.code IN ('complaints.view','complaints.create','attendance.view','fees.view','exams.view','marks.view','results.view','notices.view','diary.view','timetable.view','events.view','transport.view','lms.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Parents
WITH parent_role AS (SELECT id FROM roles WHERE code = 'parent')
INSERT INTO role_permissions (role_id, permission_id)
SELECT parent_role.id, p.id FROM permissions p, parent_role
WHERE p.code IN ('complaints.view','complaints.create','attendance.view','fees.view','results.view','notices.view','diary.view','events.view')
ON CONFLICT (role_id, permission_id) DO NOTHING;
