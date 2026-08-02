

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

-- Idempotent "upsert" without ON CONFLICT (preserves semantics)
UPDATE schema_meta
SET value = '1.4', applied_at = now()
WHERE key = 'version';

INSERT INTO schema_meta (key, value)
SELECT 'version', '1.4'
WHERE NOT EXISTS (
  SELECT 1 FROM schema_meta WHERE key = 'version'
);

-- SECTION 00: CONNECTIVITY & RESILIENCE
-- Standard Connection Timeout: 30 seconds
-- Applied to: Application-level fetch (AbortSignal.timeout), PG handshake (connect_timeout).
-- Rationale: Handle high-latency edge networks observed in diagnostics (up to 16s).

-- SECTION 01: EXTENSIONS (single creation, extensions schema)
CREATE SCHEMA IF NOT EXISTS extensions;


CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA extensions;

-- Session-level search path (no ALTER DATABASE — non-transactional DDL not allowed inside BEGIN)
SET search_path = public, extensions;

-- ════════════════════════════════════════════════════════════
-- SECTION 0B: TYPE DEFINITIONS (ENUMS)
-- ════════════════════════════════════════════════════════════

DO $$ BEGIN
    CREATE TYPE contact_type_enum AS ENUM ('email','phone','address');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE account_status_enum AS ENUM ('active','locked','disabled');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE enrollment_status_enum AS ENUM ('active','completed','withdrawn');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE attendance_status_enum AS ENUM ('present','absent','late','half_day');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE fee_status_enum AS ENUM ('pending','partial','paid','waived','overdue');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE payment_method_enum AS ENUM ('cash','card','upi','bank_transfer','cheque','online');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE exam_status_enum AS ENUM ('scheduled','ongoing','completed','cancelled');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE complaint_status_enum AS ENUM ('open','in_progress','resolved','closed','rejected');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE complaint_priority_enum AS ENUM ('low','medium','high','urgent');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE notice_audience_enum AS ENUM ('all','students','staff','parents','class');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE leave_status_enum AS ENUM ('pending','approved','rejected','cancelled');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE leave_type_enum AS ENUM ('casual','sick','earned','maternity','paternity','unpaid','other');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE day_of_week_enum AS ENUM ('monday','tuesday','wednesday','thursday','friday','saturday','sunday');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE event_type_enum AS ENUM ('academic','cultural','sports','holiday','meeting','exam','other');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE material_type_enum AS ENUM ('video','document','link','quiz','assignment');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE payroll_status_enum AS ENUM ('pending', 'paid');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE notification_channel AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'PUSH');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE notification_status AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'FAILED', 'READ', 'DISMISSED');
EXCEPTION WHEN others THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE event_status AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');
EXCEPTION WHEN others THEN null; END $$;

-- ════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════
-- SECTION 0A: SCHOOLS (Multi-Tenant Root Table)
-- ════════════════════════════════════════════════════════════
-- ============================================================
-- SCHOOLS MASTER TABLE
-- Phase 1 — Multitenancy: source of truth for school identity
-- id is INTEGER SERIAL to match all existing school_id FK columns
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- SECTION 02: ALL FUNCTIONS
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION current_school_id()
RETURNS INTEGER
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_school_id', true), '')::INTEGER;
END;
$$;

CREATE OR REPLACE FUNCTION set_school_context(p_school_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    PERFORM set_config('app.current_school_id', p_school_id::TEXT, true);
END;
$$;

CREATE OR REPLACE FUNCTION auth_school_id()
RETURNS INTEGER
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.school_id
  FROM public.users u
  WHERE u.id = auth.uid()
    AND u.deleted_at IS NULL
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_person_display_name()
RETURNS TRIGGER
SET search_path = public
AS $$
BEGIN
  NEW.display_name := trim(concat_ws(' ', NEW.first_name, NEW.middle_name, NEW.last_name));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION normalize_optional_name()
RETURNS TRIGGER
SET search_path = public
AS $$
BEGIN
  NEW.middle_name := NULLIF(TRIM(COALESCE(NEW.middle_name, '')), '');
  IF NEW.middle_name IS NOT NULL
     AND LOWER(NEW.middle_name) IN ('null', 'none', 'undefined') THEN
    NEW.middle_name := NULL;
  END IF;

  NEW.last_name := NULLIF(TRIM(COALESCE(NEW.last_name, '')), '');
  IF NEW.last_name IS NOT NULL
     AND LOWER(NEW.last_name) IN ('null', 'none', 'undefined') THEN
    NEW.last_name := NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ensure_active_person_ref()
RETURNS TRIGGER
SET search_path = public
AS $$
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

CREATE OR REPLACE FUNCTION ensure_active_student_parent()
RETURNS TRIGGER
SET search_path = public
AS $$
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

CREATE OR REPLACE FUNCTION recalculate_section_rolls(
    p_class_section_id UUID,
    p_academic_year_id UUID
)
RETURNS VOID
SET search_path = public
AS $$
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
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_enrollment_year()
RETURNS TRIGGER
SET search_path = public
AS $$
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

CREATE OR REPLACE FUNCTION ensure_active_student_enrollment()
RETURNS TRIGGER
SET search_path = public
AS $$
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

CREATE OR REPLACE FUNCTION validate_attendance_entry()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
    v_class_section_id UUID;
    v_class_teacher_id UUID;
    v_school_id INTEGER;
    v_is_admin BOOLEAN;
    v_is_class_teacher BOOLEAN;
    v_is_p1_teacher BOOLEAN;
    v_is_afternoon_teacher BOOLEAN;
    v_is_substitute_teacher BOOLEAN;
    v_lunch_sort INTEGER;
    v_afternoon_period INTEGER;
    v_marker_person_id UUID;
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

    -- 2. Authorization Check (marked_by must be Class Teacher, Admin,
    --    Period 1 Teacher, or first-period-after-lunch Teacher)
    IF NEW.marked_by IS NOT NULL THEN
        SELECT se.class_section_id, cs.class_teacher_id, cs.school_id
          INTO v_class_section_id, v_class_teacher_id, v_school_id
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        WHERE se.id = NEW.student_enrollment_id;

        SELECT person_id INTO v_marker_person_id
        FROM users WHERE id = NEW.marked_by;

        SELECT EXISTS (
            SELECT 1 FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = NEW.marked_by AND r.code = 'admin'
        ) INTO v_is_admin;

        IF NOT v_is_admin THEN
            SELECT EXISTS (
                SELECT 1 FROM staff s
                WHERE s.id = v_class_teacher_id
                  AND s.person_id = v_marker_person_id
            ) INTO v_is_class_teacher;

            SELECT EXISTS (
                SELECT 1 FROM timetable_slots ts
                JOIN staff s ON ts.teacher_id = s.id
                WHERE ts.class_section_id = v_class_section_id
                  AND ts.period_number = 1
                  AND s.person_id = v_marker_person_id
                  AND ts.deleted_at IS NULL
            ) INTO v_is_p1_teacher;

            SELECT COALESCE(
                (SELECT sort_order FROM periods
                  WHERE school_id = v_school_id AND name ILIKE '%lunch%'
                  ORDER BY sort_order DESC LIMIT 1),
                (SELECT sort_order FROM periods
                  WHERE school_id = v_school_id AND is_break = true
                  ORDER BY (end_time - start_time) DESC, start_time LIMIT 1),
                (SELECT MIN(sort_order) - 1 FROM periods
                  WHERE school_id = v_school_id
                    AND COALESCE(is_break, false) = false
                    AND start_time >= TIME '13:00')
            ) INTO v_lunch_sort;

            SELECT p.sort_order INTO v_afternoon_period
            FROM periods p
            WHERE p.school_id = v_school_id
              AND COALESCE(p.is_break, false) = false
              AND (v_lunch_sort IS NULL OR p.sort_order > v_lunch_sort)
            ORDER BY p.sort_order
            LIMIT 1;

            SELECT EXISTS (
                SELECT 1 FROM timetable_slots ts
                JOIN staff s ON ts.teacher_id = s.id
                WHERE ts.class_section_id = v_class_section_id
                  AND v_afternoon_period IS NOT NULL
                  AND ts.period_number = v_afternoon_period
                  AND s.person_id = v_marker_person_id
                  AND ts.deleted_at IS NULL
            ) INTO v_is_afternoon_teacher;

            SELECT EXISTS (
                SELECT 1
                FROM timetable_substitutions substitution
                JOIN timetable_slots ts ON ts.id = substitution.timetable_slot_id
                JOIN staff s ON s.id = substitution.substitute_teacher_id
                WHERE substitution.school_id = v_school_id
                  AND substitution.substitution_date = NEW.attendance_date
                  AND substitution.cancelled_at IS NULL
                  AND substitution.period_number IN (1, v_afternoon_period)
                  AND ts.class_section_id = v_class_section_id
                  AND s.person_id = v_marker_person_id
            ) INTO v_is_substitute_teacher;

            IF NOT (
                v_is_class_teacher OR v_is_p1_teacher OR
                v_is_afternoon_teacher OR v_is_substitute_teacher
            ) THEN
                RAISE EXCEPTION 'Unauthorized: Only the assigned Class Teacher, attendance-session Teacher, Substitute Teacher, or Admin can mark attendance';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;

$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ensure_active_person_staff()
RETURNS TRIGGER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM persons WHERE id = NEW.person_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot link staff to deleted person';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_system_role_change()
RETURNS TRIGGER
SET search_path = public
AS $$
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

CREATE OR REPLACE FUNCTION propagate_fee_structure_updates()
RETURNS TRIGGER
SET search_path = public
AS $$
BEGIN
    IF NEW.amount IS DISTINCT FROM OLD.amount THEN
        UPDATE student_fees
        SET amount_due = NEW.amount, updated_at = now()
        WHERE fee_structure_id = NEW.id AND status IN ('pending', 'partial', 'overdue');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_fee_structure_mode()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE v_fee_mode TEXT;
BEGIN
    IF NEW.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT s.fee_mode INTO v_fee_mode FROM schools s WHERE s.id = NEW.school_id;

    IF COALESCE(v_fee_mode, 'per_class') = 'per_class' AND NEW.section_id IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot create section-level fee structure when school fee_mode is per_class';
    END IF;

    IF v_fee_mode = 'per_section' AND NEW.section_id IS NULL THEN
        RAISE EXCEPTION 'Cannot create class-level fee structure when school fee_mode is per_section';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION auto_assign_fees_on_structure_creation()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE v_fee_mode TEXT;
BEGIN
    IF NEW.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT s.fee_mode INTO v_fee_mode FROM schools s WHERE s.id = NEW.school_id;

    IF COALESCE(v_fee_mode, 'per_class') = 'per_class' AND NEW.section_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    IF v_fee_mode = 'per_section' AND NEW.section_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.section_id IS NULL THEN
        INSERT INTO student_fees (school_id, student_id, fee_structure_id, amount_due, amount_paid, status, due_date)
        SELECT NEW.school_id, se.student_id, NEW.id, NEW.amount, 0, 'pending', NEW.due_date
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        WHERE cs.class_id = NEW.class_id
          AND se.academic_year_id = NEW.academic_year_id
          AND se.status = 'active'
          AND se.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM student_fees sf WHERE sf.student_id = se.student_id AND sf.fee_structure_id = NEW.id AND sf.deleted_at IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM student_fees sf2
            JOIN fee_structures fs2 ON sf2.fee_structure_id = fs2.id
            WHERE sf2.student_id = se.student_id
              AND sf2.deleted_at IS NULL
              AND fs2.deleted_at IS NULL
              AND fs2.fee_type_id = NEW.fee_type_id
              AND fs2.academic_year_id = NEW.academic_year_id
              AND fs2.class_id = NEW.class_id
          );
    ELSE
        INSERT INTO student_fees (school_id, student_id, fee_structure_id, amount_due, amount_paid, status, due_date)
        SELECT NEW.school_id, se.student_id, NEW.id, NEW.amount, 0, 'pending', NEW.due_date
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        WHERE cs.class_id = NEW.class_id
          AND cs.section_id = NEW.section_id
          AND se.academic_year_id = NEW.academic_year_id
          AND se.status = 'active'
          AND se.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM student_fees sf WHERE sf.student_id = se.student_id AND sf.fee_structure_id = NEW.id AND sf.deleted_at IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM student_fees sf2
            JOIN fee_structures fs2 ON sf2.fee_structure_id = fs2.id
            WHERE sf2.student_id = se.student_id
              AND sf2.deleted_at IS NULL
              AND fs2.deleted_at IS NULL
              AND fs2.fee_type_id = NEW.fee_type_id
              AND fs2.academic_year_id = NEW.academic_year_id
              AND fs2.class_id = NEW.class_id
          );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION auto_assign_fees_on_enrollment()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
    v_class_id UUID;
    v_section_id UUID;
    v_old_class_id UUID;
    v_old_section_id UUID;
    v_fee_mode TEXT;
    v_newly_active BOOLEAN;
    v_transfer BOOLEAN;
BEGIN
    v_newly_active := NEW.status = 'active'
        AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active');
    v_transfer := TG_OP = 'UPDATE'
        AND NEW.status = 'active'
        AND OLD.status = 'active'
        AND NEW.deleted_at IS NULL
        AND NEW.class_section_id IS DISTINCT FROM OLD.class_section_id
        AND NEW.academic_year_id IS NOT DISTINCT FROM OLD.academic_year_id;

    IF NOT (v_newly_active OR v_transfer) THEN
        RETURN NEW;
    END IF;

    SELECT cs.class_id, cs.section_id INTO v_class_id, v_section_id
    FROM class_sections cs WHERE cs.id = NEW.class_section_id;

    SELECT COALESCE(s.fee_mode, 'per_class') INTO v_fee_mode
    FROM schools s WHERE s.id = NEW.school_id;

    IF v_transfer THEN
        SELECT cs.class_id, cs.section_id INTO v_old_class_id, v_old_section_id
        FROM class_sections cs WHERE cs.id = OLD.class_section_id;

        -- In per_class mode a section move within the same class does not
        -- change the fee location — nothing to do.
        IF v_fee_mode <> 'per_section' AND v_old_class_id IS NOT DISTINCT FROM v_class_id THEN
            RETURN NEW;
        END IF;

        -- (a) untouched fees at the old location are dropped
        UPDATE student_fees sf
        SET deleted_at = NOW(), updated_at = NOW()
        FROM fee_structures src
        WHERE sf.fee_structure_id = src.id
          AND sf.student_id = NEW.student_id
          AND sf.school_id = NEW.school_id
          AND sf.deleted_at IS NULL
          AND sf.amount_paid = 0
          AND sf.discount = 0
          AND src.school_id = NEW.school_id
          AND src.academic_year_id = NEW.academic_year_id
          AND src.class_id = v_old_class_id
          AND ((v_fee_mode = 'per_section' AND src.section_id = v_old_section_id)
            OR (v_fee_mode <> 'per_section' AND src.section_id IS NULL));

        -- (b) paid/discounted fees move with the student: re-point to the
        -- same fee type at the new location (one keeper per target to
        -- respect the assignment unique index)
        UPDATE student_fees sf
        SET fee_structure_id = k.tgt_id,
            amount_due = GREATEST(k.tgt_amount, sf.amount_paid + sf.discount),
            due_date = k.tgt_due_date,
            updated_at = NOW()
        FROM (
            SELECT DISTINCT ON (tgt.id)
                sf2.id AS fee_id,
                tgt.id AS tgt_id,
                tgt.amount AS tgt_amount,
                tgt.due_date AS tgt_due_date
            FROM student_fees sf2
            JOIN fee_structures src ON sf2.fee_structure_id = src.id
            JOIN fee_structures tgt
              ON tgt.school_id = src.school_id
             AND tgt.academic_year_id = src.academic_year_id
             AND tgt.fee_type_id = src.fee_type_id
             AND tgt.class_id = v_class_id
             AND ((v_fee_mode = 'per_section' AND tgt.section_id = v_section_id)
               OR (v_fee_mode <> 'per_section' AND tgt.section_id IS NULL))
             AND tgt.deleted_at IS NULL
             AND tgt.id <> src.id
            WHERE sf2.student_id = NEW.student_id
              AND sf2.school_id = NEW.school_id
              AND sf2.deleted_at IS NULL
              AND src.school_id = NEW.school_id
              AND src.academic_year_id = NEW.academic_year_id
              AND src.class_id = v_old_class_id
              AND ((v_fee_mode = 'per_section' AND src.section_id = v_old_section_id)
                OR (v_fee_mode <> 'per_section' AND src.section_id IS NULL))
              AND NOT EXISTS (
                SELECT 1 FROM student_fees sfx
                WHERE sfx.student_id = NEW.student_id
                  AND sfx.fee_structure_id = tgt.id
                  AND sfx.deleted_at IS NULL
              )
            ORDER BY tgt.id, sf2.amount_paid DESC, sf2.created_at
        ) k
        WHERE sf.id = k.fee_id;
    END IF;

    -- Assign structures at the (new) location the student doesn't have yet
    IF v_fee_mode = 'per_section' THEN
        INSERT INTO student_fees (school_id, student_id, fee_structure_id, amount_due, amount_paid, status, due_date)
        SELECT NEW.school_id, NEW.student_id, fs.id, fs.amount, 0, 'pending', fs.due_date
        FROM fee_structures fs
        WHERE fs.school_id = NEW.school_id
          AND fs.class_id = v_class_id
          AND fs.academic_year_id = NEW.academic_year_id
          AND fs.section_id = v_section_id
          AND fs.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM student_fees sf
            WHERE sf.student_id = NEW.student_id AND sf.fee_structure_id = fs.id AND sf.deleted_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM student_fees sf2
            JOIN fee_structures fs2 ON sf2.fee_structure_id = fs2.id
            WHERE sf2.student_id = NEW.student_id
              AND sf2.deleted_at IS NULL
              AND fs2.deleted_at IS NULL
              AND fs2.fee_type_id = fs.fee_type_id
              AND fs2.academic_year_id = fs.academic_year_id
              AND fs2.class_id = fs.class_id
          );
    ELSE
        INSERT INTO student_fees (school_id, student_id, fee_structure_id, amount_due, amount_paid, status, due_date)
        SELECT NEW.school_id, NEW.student_id, fs.id, fs.amount, 0, 'pending', fs.due_date
        FROM fee_structures fs
        WHERE fs.school_id = NEW.school_id
          AND fs.class_id = v_class_id
          AND fs.academic_year_id = NEW.academic_year_id
          AND fs.section_id IS NULL
          AND fs.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM student_fees sf
            WHERE sf.student_id = NEW.student_id AND sf.fee_structure_id = fs.id AND sf.deleted_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM student_fees sf2
            JOIN fee_structures fs2 ON sf2.fee_structure_id = fs2.id
            WHERE sf2.student_id = NEW.student_id
              AND sf2.deleted_at IS NULL
              AND fs2.deleted_at IS NULL
              AND fs2.fee_type_id = fs.fee_type_id
              AND fs2.academic_year_id = fs.academic_year_id
              AND fs2.class_id = fs.class_id
          );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_fee_status()
RETURNS TRIGGER
SET search_path = public
AS $$
BEGIN
    IF NEW.amount_paid >= (NEW.amount_due - NEW.discount) THEN
        NEW.status := 'paid';
    ELSIF NEW.amount_paid > 0 THEN
        NEW.status := 'partial';
    ELSIF NEW.due_date IS NOT NULL AND NEW.due_date < CURRENT_DATE THEN
        NEW.status := 'overdue';
    ELSE
        NEW.status := 'pending';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_fee_paid_amount()
RETURNS TRIGGER
SET search_path = public
AS $$
BEGIN
    UPDATE student_fees
    SET amount_paid = amount_paid + NEW.amount
    WHERE id = NEW.student_fee_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_fee_transaction_mutation()
RETURNS TRIGGER
SET search_path = public
AS $$
BEGIN
    RAISE EXCEPTION 'fee_transactions is append-only. UPDATE and DELETE are forbidden.';
END;
$$ LANGUAGE plpgsql;

-- Group-aware auto-receipt. When NEW.receipt_group is NULL (every single-fee
-- collection) this behaves as one-receipt-per-transaction. When set, all
-- transactions sharing the group roll into ONE receipt (combined multi-fee-type
-- collection — see migrations/20260708_combined_fee_receipt.sql).
CREATE OR REPLACE FUNCTION auto_generate_receipt()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
    v_receipt_id UUID;
    v_student_id UUID;
    v_receipt_no TEXT;
BEGIN
    SELECT student_id INTO v_student_id FROM student_fees WHERE id = NEW.student_fee_id;

    IF NEW.receipt_group IS NOT NULL THEN
        SELECT id INTO v_receipt_id
        FROM receipts
        WHERE school_id = NEW.school_id
          AND receipt_group = NEW.receipt_group;

        IF v_receipt_id IS NULL THEN
            v_receipt_no := get_next_receipt_no(NEW.school_id);
            INSERT INTO receipts (school_id, receipt_no, student_id, total_amount, issued_at, issued_by, remarks, receipt_group)
            VALUES (NEW.school_id, v_receipt_no, v_student_id, NEW.amount, NEW.paid_at, NEW.received_by, COALESCE(NEW.remarks, 'System Generated'), NEW.receipt_group)
            RETURNING id INTO v_receipt_id;
        ELSE
            UPDATE receipts
            SET total_amount = total_amount + NEW.amount
            WHERE id = v_receipt_id;
        END IF;

        INSERT INTO receipt_items (school_id, receipt_id, fee_transaction_id, amount)
        VALUES (NEW.school_id, v_receipt_id, NEW.id, NEW.amount);

        RETURN NEW;
    END IF;

    v_receipt_no := get_next_receipt_no(NEW.school_id);

    INSERT INTO receipts (school_id, receipt_no, student_id, total_amount, issued_at, issued_by, remarks)
    VALUES (NEW.school_id, v_receipt_no, v_student_id, NEW.amount, NEW.paid_at, NEW.received_by, COALESCE(NEW.remarks, 'System Generated'))
    RETURNING id INTO v_receipt_id;

    INSERT INTO receipt_items (school_id, receipt_id, fee_transaction_id, amount)
    VALUES (NEW.school_id, v_receipt_id, NEW.id, NEW.amount);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_marks_entry()
RETURNS TRIGGER
SET search_path = public
AS $$
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

CREATE OR REPLACE FUNCTION generate_ticket_no()
RETURNS TRIGGER
SET search_path = public
AS $$
BEGIN
  IF NEW.ticket_no IS NULL THEN
    NEW.ticket_no := 'TKT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || 
                     LPAD(NEXTVAL('complaint_ticket_seq')::TEXT, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION auth_has_role(role_codes text[])
RETURNS boolean
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 
    FROM user_roles ur
    JOIN roles r ON ur.role_id = r.id
    WHERE ur.user_id = auth.uid()
      AND ur.school_id = auth_school_id()
      AND r.school_id = auth_school_id()
      AND r.code = ANY(role_codes)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION validate_diary_entry()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
    v_is_admin BOOLEAN;
    v_person_id UUID;
BEGIN
    -- Check if Admin
    SELECT EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = NEW.created_by AND r.code = 'admin'
    ) INTO v_is_admin;

    -- 1. Subject Assignment Check (via class_subjects OR timetable_slots)
    IF NOT v_is_admin AND NEW.subject_id IS NOT NULL THEN
        SELECT person_id INTO v_person_id FROM users WHERE id = NEW.created_by;

        -- Check class_subjects first
        IF NOT EXISTS (
            SELECT 1 FROM class_subjects cs
            JOIN staff s ON cs.teacher_id = s.id
            WHERE cs.class_section_id = NEW.class_section_id
              AND cs.subject_id = NEW.subject_id
              AND cs.deleted_at IS NULL
              AND s.person_id = v_person_id
        )
        -- Fallback: check timetable_slots (teacher assigned via timetable)
        AND NOT EXISTS (
            SELECT 1 FROM timetable_slots ts
            JOIN staff s ON ts.teacher_id = s.id
            WHERE ts.class_section_id = NEW.class_section_id
              AND ts.subject_id = NEW.subject_id
              AND ts.deleted_at IS NULL
              AND s.person_id = v_person_id
        ) THEN
            RAISE EXCEPTION 'Unauthorized: You are not assigned to teach this subject in this class';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_lms_course_modify()
RETURNS TRIGGER
SET search_path = public
AS $$
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

CREATE OR REPLACE FUNCTION prevent_direct_fee_update()
RETURNS TRIGGER
SET search_path = public
AS $$
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

CREATE OR REPLACE FUNCTION promote_students_academic_year(
    p_current_ay_id UUID,
    p_next_ay_id UUID
)
RETURNS JSONB
SET search_path = public
AS $$
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
        v_class_number := NULLIF(substring(r_enrollment.class_name FROM '\d+'), '')::INT;
        
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
                        school_id, student_id, academic_year_id, class_section_id, status, start_date, roll_number
                    ) VALUES (
                        r_enrollment.school_id,
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

CREATE OR REPLACE FUNCTION validate_timetable_entry()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
    v_teacher_collision BOOLEAN;
    v_room_collision BOOLEAN;
BEGIN
    -- Time-only updates (e.g. PUT /timetable/periods syncing slot times) must not
    -- re-run scheduling collision checks against unchanged assignments.
    IF TG_OP = 'UPDATE' THEN
        IF NEW.teacher_id IS NOT DISTINCT FROM OLD.teacher_id
           AND NEW.period_number IS NOT DISTINCT FROM OLD.period_number
           AND NEW.day_of_week IS NOT DISTINCT FROM OLD.day_of_week
           AND NEW.room_no IS NOT DISTINCT FROM OLD.room_no
           AND NEW.academic_year_id IS NOT DISTINCT FROM OLD.academic_year_id
           AND NEW.class_section_id IS NOT DISTINCT FROM OLD.class_section_id
           AND NEW.subject_id IS NOT DISTINCT FROM OLD.subject_id
        THEN
            RETURN NEW;
        END IF;
    END IF;

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
              AND day_of_week = NEW.day_of_week
              AND academic_year_id = NEW.academic_year_id
              AND deleted_at IS NULL
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
        ) INTO v_teacher_collision;

        IF v_teacher_collision THEN
            RAISE EXCEPTION 'Teacher Collision: Teacher is already booked for period % on %', NEW.period_number, NEW.day_of_week;
        END IF;
    END IF;

    -- 3. Room Collision Check
    IF NEW.room_no IS NOT NULL AND NEW.room_no <> '' THEN
        SELECT EXISTS (
            SELECT 1 FROM timetable_slots
            WHERE room_no = NEW.room_no
              AND period_number = NEW.period_number
              AND day_of_week = NEW.day_of_week
              AND academic_year_id = NEW.academic_year_id
              AND deleted_at IS NULL
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
        ) INTO v_room_collision;

        IF v_room_collision THEN
            RAISE EXCEPTION 'Room Collision: Room % is already occupied during period % on %', NEW.room_no, NEW.period_number, NEW.day_of_week;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_class_teacher_from_timetable()
RETURNS TRIGGER
SET search_path = public
AS $$
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

CREATE OR REPLACE FUNCTION ensure_student_enrollment(p_user_id UUID)
RETURNS JSONB
SET search_path = public
AS $$
DECLARE
    v_person_id UUID;
    v_student_id UUID;
    v_academic_year_id UUID;
    v_class_section_id UUID;
    v_enrollment_id UUID;
    v_enrollment_exists BOOLEAN;
BEGIN
    -- 0. Resolve Student ID & School from User ID (tenant-scoped)
    DECLARE v_school_id INTEGER;
    BEGIN
    SELECT person_id, school_id INTO v_person_id, v_school_id
    FROM users WHERE id = p_user_id AND deleted_at IS NULL;
    
    IF v_person_id IS NULL THEN
         RAISE EXCEPTION 'User not found';
    END IF;

    SELECT id INTO v_student_id FROM students
    WHERE person_id = v_person_id AND school_id = v_school_id;

    IF v_student_id IS NULL THEN
        RAISE EXCEPTION 'Student profile not found for this user';
    END IF;

    SELECT id INTO v_academic_year_id
    FROM academic_years
    WHERE start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE
      AND school_id = v_school_id
    LIMIT 1;

    IF v_academic_year_id IS NULL THEN
        SELECT id INTO v_academic_year_id
        FROM academic_years
        WHERE school_id = v_school_id
        ORDER BY start_date DESC
        LIMIT 1;
    END IF;
    
    IF v_academic_year_id IS NULL THEN
        RAISE EXCEPTION 'No academic year configured.';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM student_enrollments
        WHERE student_id = v_student_id
          AND academic_year_id = v_academic_year_id
          AND school_id = v_school_id
          AND deleted_at IS NULL
    ) INTO v_enrollment_exists;

    IF v_enrollment_exists THEN
        RETURN jsonb_build_object('status', 'exists', 'message', 'Enrollment already exists');
    END IF;

    SELECT cs.id INTO v_class_section_id
    FROM class_sections cs
    JOIN classes c ON cs.class_id = c.id
    JOIN sections s ON cs.section_id = s.id
    WHERE cs.academic_year_id = v_academic_year_id
      AND cs.school_id = v_school_id
    ORDER BY c.name ASC, s.name ASC
    LIMIT 1;

    IF v_class_section_id IS NULL THEN
         RAISE EXCEPTION 'No class sections defined for the current academic year.';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(v_class_section_id::text));
    
    INSERT INTO student_enrollments (
        school_id, student_id, academic_year_id, class_section_id, status, start_date, roll_number
    )
    VALUES (
        v_school_id,
        v_student_id, 
        v_academic_year_id, 
        v_class_section_id, 
        'active', 
        CURRENT_DATE,
        (SELECT COALESCE(MAX(roll_number), 0) + 1 FROM student_enrollments
         WHERE class_section_id = v_class_section_id AND school_id = v_school_id)
    )
    RETURNING id INTO v_enrollment_id;

    RETURN jsonb_build_object('status', 'created', 'enrollment_id', v_enrollment_id);
    END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION generate_monthly_payroll(
  p_month INTEGER,
  p_year INTEGER
)
RETURNS VOID
SET search_path = public
AS $$
BEGIN
  INSERT INTO staff_payroll (school_id, staff_id, base_salary, net_salary, payroll_month, payroll_year, status)
  SELECT 
    school_id,
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

CREATE OR REPLACE FUNCTION recalculate_staff_payroll(
    p_staff_id UUID, 
    p_month INTEGER, 
    p_year INTEGER
)
RETURNS VOID
SET search_path = public
AS $$
DECLARE
    v_base_salary DECIMAL(12,2);
    v_per_day_salary DECIMAL(12,2);
    v_total_deduction_days INTEGER := 0;
    v_deduction_amount DECIMAL(12,2);
    v_start_date DATE;
    v_end_date DATE;
    v_bonus DECIMAL(12,2) := 0;
    v_adjustment DECIMAL(12,2) := 0;
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

    SELECT COALESCE(sp.bonus, 0), COALESCE(sp.salary_adjustment, 0)
      INTO v_bonus, v_adjustment
    FROM staff_payroll sp
    WHERE sp.school_id = (SELECT school_id FROM staff WHERE id = p_staff_id)
      AND sp.staff_id = p_staff_id
      AND sp.payroll_month = p_month
      AND sp.payroll_year = p_year;

    -- Idempotent upsert without ON CONFLICT (preserves manual bonus/adjustment)
    UPDATE staff_payroll sp
    SET base_salary = v_base_salary,
        deductions = v_deduction_amount,
        net_salary = GREATEST(0, v_base_salary + v_bonus + v_adjustment - v_deduction_amount),
        updated_at = now()
    WHERE sp.school_id = (SELECT school_id FROM staff WHERE id = p_staff_id)
      AND sp.staff_id = p_staff_id
      AND sp.payroll_month = p_month
      AND sp.payroll_year = p_year;

    IF NOT FOUND THEN
      INSERT INTO staff_payroll (
        school_id, staff_id, payroll_month, payroll_year,
        base_salary, bonus, salary_adjustment, deductions, net_salary, status
      )
      VALUES (
        (SELECT school_id FROM staff WHERE id = p_staff_id),
        p_staff_id, p_month, p_year,
        v_base_salary, 0, 0, v_deduction_amount,
        GREATEST(0, v_base_salary - v_deduction_amount),
        'pending'
      );
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION trg_recalc_payroll_on_attendance()
RETURNS TRIGGER
SET search_path = public
AS $$
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

CREATE OR REPLACE FUNCTION get_financial_policy_value(code_input TEXT)
RETURNS JSONB 
SET search_path = public
AS $$
DECLARE val JSONB;
BEGIN
    SELECT current_value INTO val FROM financial_policy_rules
    WHERE rule_code = code_input AND school_id = auth_school_id();
    RETURN val;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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
    SELECT r.code INTO v_role_code FROM user_roles ur JOIN roles r ON ur.role_id = r.id
    WHERE ur.user_id = v_user_id AND ur.school_id = auth_school_id() AND r.school_id = auth_school_id()
    ORDER BY (CASE WHEN r.code = 'admin' THEN 1 WHEN r.code = 'principal' THEN 2 ELSE 3 END) LIMIT 1;

    IF v_role_code = 'admin' THEN RETURN TRUE; END IF;

    IF p_action_code = 'EXPENSE_AUTO_APPROVE' THEN
        SELECT current_value->>'amount' INTO v_auto_approve_limit FROM financial_policy_rules
        WHERE rule_code = 'EXPENSE_AUTO_APPROVE_LIMIT' AND school_id = auth_school_id();
        IF v_auto_approve_limit IS NOT NULL AND p_amount > v_auto_approve_limit::DECIMAL THEN
             RAISE EXCEPTION 'Amount % exceeds auto-approval limit of %', p_amount, v_auto_approve_limit;
        END IF;
    END IF;

    IF p_action_code = 'FEE_COLLECT_CASH' THEN
        DECLARE
            v_today_total DECIMAL;
            v_daily_limit JSONB;
        BEGIN
            SELECT COALESCE(SUM(amount), 0) INTO v_today_total FROM fee_transactions
            WHERE received_by = v_user_id AND payment_method = 'cash' AND paid_at::DATE = CURRENT_DATE
              AND school_id = auth_school_id();
            SELECT current_value INTO v_daily_limit FROM financial_policy_rules
            WHERE rule_code = 'CASH_COLLECTION_DAILY_LIMIT' AND school_id = auth_school_id();
            IF v_daily_limit IS NOT NULL AND (v_today_total + p_amount) > (v_daily_limit->>'amount')::DECIMAL THEN
                 RAISE EXCEPTION 'Daily cash limit exceeded. Collected: %, Attempt: %, Limit: %', v_today_total, p_amount, v_daily_limit->>'amount';
            END IF;
        END;
    END IF;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION enforce_financial_lock(p_date DATE, p_context TEXT)
RETURNS BOOLEAN 
SET search_path = public
AS $$
DECLARE v_lock_days INT;
BEGIN
    SELECT (current_value->>'amount')::INT INTO v_lock_days FROM financial_policy_rules
    WHERE rule_code = 'LOCK_PAST_MONTHS_DAYS' AND school_id = auth_school_id();
    IF v_lock_days IS NULL THEN v_lock_days := 7; END IF;
    IF p_date < DATE_TRUNC('month', CURRENT_DATE) THEN
        IF EXTRACT(DAY FROM CURRENT_DATE) > v_lock_days THEN
            RAISE EXCEPTION 'Financial period for % is locked. (Automatic lock enabled after day % of subsequent month)', p_date, v_lock_days;
        END IF;
    END IF;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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
                 AND ur.school_id = auth_school_id() AND r.school_id = auth_school_id()
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

CREATE OR REPLACE FUNCTION safe_div(n NUMERIC, d NUMERIC) RETURNS NUMERIC AS $$
BEGIN
    IF d = 0 OR d IS NULL THEN RETURN 0; END IF;
    RETURN n / d;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

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

CREATE OR REPLACE FUNCTION debug_user_permissions(p_user_id UUID)
RETURNS TABLE (
    role_code VARCHAR,
    permission_code VARCHAR,
    permission_name VARCHAR
) AS $$
DECLARE v_school INTEGER;
BEGIN
    SELECT school_id INTO v_school FROM users WHERE id = p_user_id AND deleted_at IS NULL;
    RETURN QUERY
    SELECT r.code::VARCHAR, p.code::VARCHAR, p.name::VARCHAR
    FROM user_roles ur
    JOIN roles r ON ur.role_id = r.id
    JOIN role_permissions rp ON r.id = rp.role_id
    JOIN permissions p ON rp.permission_id = p.id
    WHERE ur.user_id = p_user_id
      AND ur.school_id = v_school AND r.school_id = v_school
      AND rp.school_id = v_school AND p.school_id = v_school;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
    WHERE ts.teacher_id = (SELECT id FROM staff WHERE staff_code = p_staff_code AND school_id = auth_school_id())
      AND ts.school_id = auth_school_id()
    ORDER BY ts.period_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION perform_data_audit(p_school_id INTEGER)
RETURNS TABLE (issue_type TEXT, entity_id TEXT, details TEXT) AS $$
BEGIN
    RETURN QUERY SELECT 'ORPHAN_ENROLLMENT'::TEXT, se.id::TEXT, format('Student %s missing', se.student_id)
    FROM student_enrollments se 
    LEFT JOIN students s ON se.student_id = s.id 
    WHERE (s.id IS NULL OR s.deleted_at IS NOT NULL) 
      AND se.deleted_at IS NULL 
      AND s.school_id = p_school_id;


    -- 2. Invalid Class Teachers
    RETURN QUERY
    SELECT 'INVALID_CLASS_TEACHER'::TEXT, cs.id::TEXT, format('Staff %s missing or deleted', cs.class_teacher_id)
    FROM class_sections cs
    LEFT JOIN staff s ON cs.class_teacher_id = s.id
    WHERE cs.class_teacher_id IS NOT NULL AND (s.id IS NULL OR s.deleted_at IS NOT NULL)
      AND cs.school_id = p_school_id;

    -- 3. Duplicate Attendance
    RETURN QUERY
    SELECT 'DUPLICATE_ATTENDANCE'::TEXT, da.student_enrollment_id::TEXT, format('Date: %s', da.attendance_date)
    FROM daily_attendance da
    WHERE da.deleted_at IS NULL AND da.school_id = p_school_id
    GROUP BY da.student_enrollment_id, da.attendance_date
    HAVING COUNT(*) > 1;

    -- 4. Multiple Active Enrollments
    RETURN QUERY
    SELECT 'MULTIPLE_ACTIVE_ENROLLMENTS'::TEXT, se.student_id::TEXT, format('Academic Year ID: %s', se.academic_year_id)
    FROM student_enrollments se
    WHERE se.status = 'active' AND se.deleted_at IS NULL AND se.school_id = p_school_id
    GROUP BY se.student_id, se.academic_year_id
    HAVING COUNT(*) > 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION repair_data_integrity(p_school_id INTEGER DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    v_count INTEGER;
    v_sid INTEGER := COALESCE(p_school_id, auth_school_id());
BEGIN
    IF v_sid IS NULL THEN RAISE EXCEPTION 'school_id required'; END IF;

    WITH duplicates AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY student_enrollment_id, attendance_date ORDER BY updated_at DESC) as rn
        FROM daily_attendance WHERE deleted_at IS NULL AND school_id = v_sid
    )
    UPDATE daily_attendance SET deleted_at = NOW()
    WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);

    UPDATE class_subjects SET deleted_at = NOW()
    WHERE id IN (
        SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY class_section_id, subject_id ORDER BY id) as rn
            FROM class_subjects WHERE deleted_at IS NULL AND school_id = v_sid
        ) t WHERE rn > 1
    );

    INSERT INTO class_subjects (school_id, class_section_id, subject_id, teacher_id)
    SELECT DISTINCT v_sid, ts.class_section_id, ts.subject_id, ts.teacher_id
    FROM timetable_slots ts
    WHERE ts.teacher_id IS NOT NULL AND ts.school_id = v_sid
      AND NOT EXISTS (
        SELECT 1 FROM class_subjects cs
        WHERE cs.class_section_id = ts.class_section_id AND cs.subject_id = ts.subject_id AND cs.school_id = v_sid
    );

    UPDATE class_subjects cs
    SET teacher_id = ts.teacher_id
    FROM timetable_slots ts
    WHERE cs.class_section_id = ts.class_section_id
      AND cs.subject_id = ts.subject_id
      AND cs.teacher_id IS DISTINCT FROM ts.teacher_id
      AND cs.deleted_at IS NULL
      AND ts.teacher_id IS NOT NULL
      AND cs.school_id = v_sid AND ts.school_id = v_sid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION run_integrity_check(p_school_id INTEGER)
RETURNS TABLE (severity TEXT, category TEXT, entity_id TEXT, description TEXT) AS $$
BEGIN
    RETURN QUERY SELECT 'CRITICAL'::TEXT, 'COLLISION'::TEXT, t1.id::TEXT, format('Teacher double-booked')
    FROM timetable_slots t1 
    JOIN timetable_slots t2 ON t1.teacher_id = t2.teacher_id AND t1.day_of_week = t2.day_of_week AND t1.period_number = t2.period_number AND t1.academic_year_id = t2.academic_year_id
    WHERE t1.id < t2.id 
      AND t1.school_id = p_school_id;


    -- 2. Duplicate Attendance Audit
    RETURN QUERY
    SELECT 
        'HIGH'::TEXT, 'DUPLICATE_DATA'::TEXT, da.student_enrollment_id::TEXT, 
        format('Multiple attendance records for date %s', da.attendance_date)
    FROM daily_attendance da
    WHERE da.deleted_at IS NULL AND da.school_id = p_school_id
    GROUP BY da.student_enrollment_id, da.attendance_date
    HAVING COUNT(*) > 1;

    -- 3. Unauthorized Subject Mapping
    RETURN QUERY
    SELECT 
        'MEDIUM'::TEXT, 'MAPPING_ERROR'::TEXT, ts.id::TEXT, 
        format('Teacher is teaching Subject %s in Class Section %s without assignment', ts.subject_id, ts.class_section_id)
    FROM timetable_slots ts
    WHERE ts.teacher_id IS NOT NULL AND ts.school_id = p_school_id
      AND NOT EXISTS (
        SELECT 1 FROM class_subjects cs 
        WHERE cs.class_section_id = ts.class_section_id 
          AND cs.teacher_id = ts.teacher_id 
          AND cs.subject_id = ts.subject_id
          AND cs.deleted_at IS NULL
          AND cs.school_id = p_school_id
      );

    -- 4. Multi-Section Enrollment Check
    RETURN QUERY
    SELECT 
        'CRITICAL'::TEXT, 'ENROLLMENT_ERROR'::TEXT, se.student_id::TEXT, 
        format('Student has %s active enrollments in Academic Year %s', COUNT(*), se.academic_year_id)
    FROM student_enrollments se
    WHERE se.status = 'active' AND se.deleted_at IS NULL AND se.school_id = p_school_id
    GROUP BY se.student_id, se.academic_year_id
    HAVING COUNT(*) > 1;

    -- 5. Orphan Check
    RETURN QUERY
    SELECT 'HIGH'::TEXT, 'ORPHAN'::TEXT, se.id::TEXT, 'Enrollment linked to deleted student'
    FROM student_enrollments se
    LEFT JOIN students s ON se.student_id = s.id
    WHERE (s.id IS NULL OR s.deleted_at IS NOT NULL) AND se.deleted_at IS NULL
      AND se.school_id = p_school_id;

END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION recalculate_fee_ledger(p_school_id INTEGER DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    r_fee RECORD;
    v_calculated_paid DECIMAL(12,2);
    v_new_status fee_status_enum;
    v_remaining DECIMAL(12,2);
    v_sid INTEGER := COALESCE(p_school_id, auth_school_id());
BEGIN
    IF v_sid IS NULL THEN RAISE EXCEPTION 'school_id required'; END IF;
    PERFORM set_config('app.fee_recalc_mode', 'true', true);

    FOR r_fee IN 
        SELECT sf.id, sf.amount_due, sf.amount_paid, sf.discount, sf.status
        FROM student_fees sf WHERE sf.school_id = v_sid
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

CREATE OR REPLACE FUNCTION validate_timetable_entry()
RETURNS TRIGGER AS $$
DECLARE
    v_teacher_collision BOOLEAN;
    v_room_collision BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.teacher_id IS NOT DISTINCT FROM OLD.teacher_id
           AND NEW.period_number IS NOT DISTINCT FROM OLD.period_number
           AND NEW.day_of_week IS NOT DISTINCT FROM OLD.day_of_week
           AND NEW.room_no IS NOT DISTINCT FROM OLD.room_no
           AND NEW.academic_year_id IS NOT DISTINCT FROM OLD.academic_year_id
           AND NEW.class_section_id IS NOT DISTINCT FROM OLD.class_section_id
           AND NEW.subject_id IS NOT DISTINCT FROM OLD.subject_id
        THEN
            RETURN NEW;
        END IF;
    END IF;

    IF NEW.teacher_id IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM timetable_slots
            WHERE teacher_id = NEW.teacher_id
              AND period_number = NEW.period_number
              AND day_of_week = NEW.day_of_week
              AND academic_year_id = NEW.academic_year_id
              AND deleted_at IS NULL
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
        ) INTO v_teacher_collision;

        IF v_teacher_collision THEN
            RAISE EXCEPTION 'Teacher Collision: Teacher is already booked for period % on %', NEW.period_number, NEW.day_of_week;
        END IF;
    END IF;

    IF NEW.room_no IS NOT NULL AND NEW.room_no <> '' THEN
        SELECT EXISTS (
            SELECT 1 FROM timetable_slots
            WHERE room_no = NEW.room_no
              AND period_number = NEW.period_number
              AND day_of_week = NEW.day_of_week
              AND academic_year_id = NEW.academic_year_id
              AND deleted_at IS NULL
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
        ) INTO v_room_collision;

        IF v_room_collision THEN
            RAISE EXCEPTION 'Room Collision: Room % is already occupied during period % on %', NEW.room_no, NEW.period_number, NEW.day_of_week;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_attendance_entry()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
    v_class_section_id UUID;
    v_class_teacher_id UUID;
    v_school_id INTEGER;
    v_is_admin BOOLEAN;
    v_is_class_teacher BOOLEAN;
    v_is_p1_teacher BOOLEAN;
    v_is_afternoon_teacher BOOLEAN;
    v_is_substitute_teacher BOOLEAN;
    v_lunch_sort INTEGER;
    v_afternoon_period INTEGER;
    v_marker_person_id UUID;
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

    -- 2. Authorization Check (Class Teacher, Admin, Period 1, or first-after-lunch)
    IF NEW.marked_by IS NOT NULL THEN
        SELECT se.class_section_id, cs.class_teacher_id, cs.school_id
          INTO v_class_section_id, v_class_teacher_id, v_school_id
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        WHERE se.id = NEW.student_enrollment_id;

        SELECT person_id INTO v_marker_person_id
        FROM users WHERE id = NEW.marked_by;

        SELECT EXISTS (
            SELECT 1 FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = NEW.marked_by AND r.code = 'admin'
        ) INTO v_is_admin;

        IF NOT v_is_admin THEN
            SELECT EXISTS (
                SELECT 1 FROM staff s
                WHERE s.id = v_class_teacher_id
                  AND s.person_id = v_marker_person_id
            ) INTO v_is_class_teacher;

            SELECT EXISTS (
                SELECT 1 FROM timetable_slots ts
                JOIN staff s ON ts.teacher_id = s.id
                WHERE ts.class_section_id = v_class_section_id
                  AND ts.period_number = 1
                  AND s.person_id = v_marker_person_id
                  AND ts.deleted_at IS NULL
            ) INTO v_is_p1_teacher;

            SELECT COALESCE(
                (SELECT sort_order FROM periods
                  WHERE school_id = v_school_id AND name ILIKE '%lunch%'
                  ORDER BY sort_order DESC LIMIT 1),
                (SELECT sort_order FROM periods
                  WHERE school_id = v_school_id AND is_break = true
                  ORDER BY (end_time - start_time) DESC, start_time LIMIT 1),
                (SELECT MIN(sort_order) - 1 FROM periods
                  WHERE school_id = v_school_id
                    AND COALESCE(is_break, false) = false
                    AND start_time >= TIME '13:00')
            ) INTO v_lunch_sort;

            SELECT p.sort_order INTO v_afternoon_period
            FROM periods p
            WHERE p.school_id = v_school_id
              AND COALESCE(p.is_break, false) = false
              AND (v_lunch_sort IS NULL OR p.sort_order > v_lunch_sort)
            ORDER BY p.sort_order
            LIMIT 1;

            SELECT EXISTS (
                SELECT 1 FROM timetable_slots ts
                JOIN staff s ON ts.teacher_id = s.id
                WHERE ts.class_section_id = v_class_section_id
                  AND v_afternoon_period IS NOT NULL
                  AND ts.period_number = v_afternoon_period
                  AND s.person_id = v_marker_person_id
                  AND ts.deleted_at IS NULL
            ) INTO v_is_afternoon_teacher;

            SELECT EXISTS (
                SELECT 1
                FROM timetable_substitutions substitution
                JOIN timetable_slots ts ON ts.id = substitution.timetable_slot_id
                JOIN staff s ON s.id = substitution.substitute_teacher_id
                WHERE substitution.school_id = v_school_id
                  AND substitution.substitution_date = NEW.attendance_date
                  AND substitution.cancelled_at IS NULL
                  AND substitution.period_number IN (1, v_afternoon_period)
                  AND ts.class_section_id = v_class_section_id
                  AND s.person_id = v_marker_person_id
            ) INTO v_is_substitute_teacher;

            IF NOT (
                v_is_class_teacher OR v_is_p1_teacher OR
                v_is_afternoon_teacher OR v_is_substitute_teacher
            ) THEN
                RAISE EXCEPTION 'Unauthorized: Only the assigned Class Teacher, attendance-session Teacher, Substitute Teacher, or Admin can mark attendance';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION is_admin() RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = auth.uid()
          AND ur.school_id = auth_school_id()
          AND r.school_id = auth_school_id()
          AND r.code = 'admin'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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
    JOIN public.staff_designations sd ON s.designation_id = sd.id
    WHERE s.user_id = auth.uid()
      AND sd.name = 'Principal'
      AND s.school_id = auth_school_id()
      AND sd.school_id = auth_school_id()
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
  WHERE user_id = auth.uid()
    AND school_id = auth_school_id();
  
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
    JOIN public.staff_designations sd ON s.designation_id = sd.id
    WHERE s.user_id = auth.uid()
      AND sd.name = 'Senior Teacher'
      AND s.school_id = auth_school_id()
      AND sd.school_id = auth_school_id()
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
    IF NEW.attendance_date > CURRENT_DATE THEN
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
    SELECT 1 FROM public.staff WHERE user_id = auth.uid() AND staff.school_id = auth_school_id()
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION get_next_receipt_no(p_school_id INTEGER)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next_number BIGINT;
BEGIN
  IF p_school_id IS NULL THEN
    RAISE EXCEPTION 'school_id is required to generate a receipt number';
  END IF;

  INSERT INTO receipt_number_counters AS counters (school_id, last_number, updated_at)
  VALUES (
    p_school_id,
    GREATEST(
      1001::BIGINT,
      COALESCE((
        SELECT MAX(SUBSTRING(r.receipt_no FROM '([0-9]+)$')::BIGINT) + 1
        FROM receipts r
        WHERE r.school_id = p_school_id
          AND r.receipt_no ~ '[0-9]+$'
      ), 1001::BIGINT)
    ),
    NOW()
  )
  ON CONFLICT (school_id) DO UPDATE
  SET last_number = counters.last_number + 1,
      updated_at = NOW()
  RETURNING last_number INTO v_next_number;

  RETURN 'RCT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-'
    || LPAD(v_next_number::TEXT, 4, '0');
END;
$$;

CREATE OR REPLACE FUNCTION get_next_complaint_ticket(p_school_id INTEGER) RETURNS TEXT AS $$
DECLARE
  v_seq_name TEXT := 'complaint_ticket_seq_school_' || p_school_id;
BEGIN
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I START 1', v_seq_name);
  RETURN 'TKT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-S' || p_school_id || '-' || LPAD(NEXTVAL(v_seq_name)::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_next_certificate_serial(
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



CREATE TABLE IF NOT EXISTS schools (
  id         SERIAL      PRIMARY KEY,                           -- INTEGER auto-increment; matches all tenant school_id FK columns
  name       TEXT        NOT NULL,                              -- Display name shown in app UI
  code       TEXT        UNIQUE NOT NULL,                       -- Matches EXPO_PUBLIC_SCHOOL_CODE in each per-school app build
  address    TEXT,                                              -- Physical address, nullable
  logo_url   TEXT,                                              -- CDN URL for school branding, nullable
  is_active  BOOLEAN     NOT NULL DEFAULT true,                 -- Soft-disable a school without deleting rows
  timetable_mode TEXT    NOT NULL DEFAULT 'uniform'             -- 'uniform' = one schedule for all 6 days | 'per_day' = distinct per weekday
                 CHECK (timetable_mode IN ('uniform', 'per_day')),
  fee_mode     TEXT        NOT NULL DEFAULT 'per_class'          -- 'per_class' = one fee per class | 'per_section' = fee per section
                 CHECK (fee_mode IN ('per_class', 'per_section')),
  pf_enabled BOOLEAN     NOT NULL DEFAULT false,                -- PaperForge access gate (additive, production-safe, default disabled)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()                 -- Audit timestamp
);

-- Backward-compat for deployments created before timetable modes shipped.
ALTER TABLE schools ADD COLUMN IF NOT EXISTS timetable_mode TEXT NOT NULL DEFAULT 'uniform';
ALTER TABLE schools ADD COLUMN IF NOT EXISTS fee_mode TEXT NOT NULL DEFAULT 'per_class';
ALTER TABLE schools ADD COLUMN IF NOT EXISTS accounts_dashboard_config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS payroll_distribution_blocked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS staff_payslips_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS accounts_staff_creation_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS partial_fee_payment_enabled BOOLEAN NOT NULL DEFAULT true;
-- PaperForge access gate (additive, production-safe, default disabled)
ALTER TABLE schools ADD COLUMN IF NOT EXISTS pf_enabled BOOLEAN NOT NULL DEFAULT false;

-- Internal, transaction-safe receipt number state. Each school owns one row.
CREATE TABLE IF NOT EXISTS receipt_number_counters (
  school_id INTEGER PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  last_number BIGINT NOT NULL CHECK (last_number >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE receipt_number_counters ENABLE ROW LEVEL SECURITY;

-- Schools are provisioned by the NexSyrus super admin via API.
-- No school is seeded at schema level. Fresh DB starts empty.
-- Legacy compatibility: if an old NOT NULL slug column exists on schools,
-- relax it so the above seed (which does not populate slug) can succeed.


-- Helper: Get current school from session GUC

-- Helper: RPC for clients to set school context

GRANT EXECUTE ON FUNCTION current_school_id() TO authenticated, service_role;
-- Prevent clients from arbitrarily switching tenant context.
REVOKE EXECUTE ON FUNCTION set_school_context(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION set_school_context(INTEGER) TO service_role;

-- Multitenancy: derive school from the authenticated user record (single source of truth).

GRANT EXECUTE ON FUNCTION auth_school_id() TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════
-- SECTION 0C: PER-SCHOOL SEED DEFAULTS
-- ════════════════════════════════════════════════════════════
-- SCOPE: PER-SCHOOL — Automatically invoked for every new school
-- via the trg_school_seed_defaults trigger on the schools table.
-- Seeds: staff designations, periods, RBAC (roles, permissions,
-- role-permissions), financial policies, and school settings.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION seed_school_defaults(p_school_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 1. Staff Designations
  INSERT INTO staff_designations (school_id, name)
  SELECT p_school_id, v.name
  FROM (VALUES
    ('Principal'), ('Vice Principal'), ('Teacher'), ('Senior Teacher'),
    ('Lab Assistant'), ('Librarian'), ('Clerk'), ('Peon'), ('Driver'), ('Other')
  ) AS v(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM staff_designations sd WHERE sd.school_id = p_school_id AND sd.name = v.name
  );

  -- 2. Periods (Default timetable structure)
  INSERT INTO periods (school_id, name, start_time, end_time, sort_order, is_break)
  SELECT p_school_id, v.name, v.start_time, v.end_time, v.sort_order, v.is_break
  FROM (VALUES
    ('Period 1', '08:00'::time, '08:45'::time, 1,  FALSE),
    ('Period 2', '08:45'::time, '09:30'::time, 2,  FALSE),
    ('Period 3', '09:30'::time, '10:15'::time, 3,  FALSE),
    ('Break',    '10:15'::time, '10:30'::time, 4,  TRUE),
    ('Period 4', '10:30'::time, '11:15'::time, 5,  FALSE),
    ('Period 5', '11:15'::time, '12:00'::time, 6,  FALSE),
    ('Lunch',    '12:00'::time, '12:45'::time, 7,  TRUE),
    ('Period 6', '12:45'::time, '13:30'::time, 8,  FALSE),
    ('Period 7', '13:30'::time, '14:15'::time, 9,  FALSE),
    ('Period 8', '14:15'::time, '15:00'::time, 10, FALSE)
  ) AS v(name, start_time, end_time, sort_order, is_break)
  WHERE NOT EXISTS (
    SELECT 1 FROM periods p WHERE p.school_id = p_school_id AND p.name = v.name
  );

  -- 3. Permissions (System-level permission codes)
  INSERT INTO permissions (school_id, code, name)
  SELECT p_school_id, v.code, v.name
  FROM (VALUES
    ('students.view', 'View Students'), ('students.create', 'Create Students'),
    ('students.edit', 'Edit Students'), ('students.delete', 'Delete Students'),
    ('staff.view', 'View Staff'), ('staff.create', 'Create Staff'),
    ('staff.edit', 'Edit Staff'), ('staff.delete', 'Delete Staff'),
    ('users.view', 'View Users'), ('users.create', 'Create Users'),
    ('users.edit', 'Edit Users'), ('users.delete', 'Delete Users'),
    ('academics.view', 'View Academics'), ('academics.manage', 'Manage Academics'),
    ('attendance.view', 'View Attendance'), ('attendance.mark', 'Mark Attendance'),
    ('attendance.edit', 'Edit Attendance'),
    ('fees.view', 'View Fees'), ('fees.manage', 'Manage Fees'),
    ('fees.collect', 'Collect Fees'),
    ('transactions.view', 'View Transactions'),
    ('receipts.generate', 'Generate Receipts'),
    ('reports.financial', 'View Financial Reports'),
    ('exams.view', 'View Exams'), ('exams.manage', 'Manage Exams'),
    ('marks.view', 'View Marks'), ('marks.enter', 'Enter Marks'),
    ('results.view', 'View Results'), ('results.generate', 'Generate Results'),
    ('transport.view', 'View Transport'), ('transport.manage', 'Manage Transport'),
    ('hostel.view', 'View Hostel'), ('hostel.manage', 'Manage Hostel'),
    ('events.view', 'View Events'), ('events.manage', 'Manage Events'),
    ('lms.view', 'View LMS'), ('lms.create', 'Create LMS Content'),
    ('lms.manage', 'Manage LMS'),
    ('complaints.view', 'View Complaints'), ('complaints.create', 'Create Complaints'),
    ('complaints.manage', 'Manage Complaints'),
    ('notices.view', 'View Notices'), ('notices.create', 'Create Notices'),
    ('notices.manage', 'Manage Notices'),
    ('leaves.view', 'View Leaves'), ('leaves.apply', 'Apply for Leave'),
    ('leaves.approve', 'Approve Leaves'),
    ('diary.view', 'View Diary'), ('diary.create', 'Create Diary Entries'),
    ('timetable.view', 'View Timetable'), ('timetable.manage', 'Manage Timetable'),
    ('dashboard.view', 'View Dashboard'),
    ('results.publish', 'Publish Results'),
    ('diary.manage', 'Manage Diary'),
    ('expenses.view', 'View Expenses'), ('expenses.create', 'Create Expenses'),
    ('expenses.edit', 'Edit Expenses'), ('expenses.delete', 'Delete Expenses'),
    ('expenses.approve', 'Approve Expenses'),
    ('payroll.process', 'Process Payroll'),
    ('academic_year.upgrade', 'Upgrade Academic Year'),
    ('certificates.issue', 'Issue Certificates'),
    -- RBAC & Segregation-of-Duties (Phase 1)
    ('refund.create', 'Create Refunds'),
    ('salary.view', 'View Salary'),
    ('payslip.view', 'View Payslips'),
    ('fee.underpayment.approve', 'Approve Fee Underpayments')
  ) AS v(code, name)
  WHERE NOT EXISTS (
    SELECT 1 FROM permissions p WHERE p.school_id = p_school_id AND p.code = v.code
  );

  -- 4. Roles
  INSERT INTO roles (school_id, code, name, is_system)
  SELECT p_school_id, v.code, v.name, v.is_system
  FROM (VALUES
    ('admin', 'Administrator', true),
    ('staff', 'Staff/Teacher', true),
    ('student', 'Student', true),
    ('parent', 'Parent / Guardian', true),
    ('accounts', 'Accounts Manager', true),
    ('principal', 'Principal', true),
    ('driver', 'Driver', true)
  ) AS v(code, name, is_system)
  WHERE NOT EXISTS (
    SELECT 1 FROM roles r WHERE r.school_id = p_school_id AND r.code = v.code
  );

  -- 5. Role-Permission Mappings
  -- Admin: All permissions
  INSERT INTO role_permissions (school_id, role_id, permission_id)
  SELECT p_school_id, r.id, p.id
  FROM roles r CROSS JOIN permissions p
  WHERE r.code = 'admin' AND r.school_id = p_school_id AND p.school_id = p_school_id
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = p_school_id
    );

  -- Staff: Academic & Operations
  INSERT INTO role_permissions (school_id, role_id, permission_id)
  SELECT p_school_id, r.id, p.id
  FROM roles r CROSS JOIN permissions p
  WHERE r.code = 'staff' AND r.school_id = p_school_id AND p.school_id = p_school_id
    AND p.code IN (
      'students.view', 'academics.view', 'attendance.view', 'attendance.mark',
      'exams.view', 'marks.enter', 'marks.view', 'diary.view', 'diary.create',
      'timetable.view', 'leaves.view', 'leaves.apply', 'notices.view', 'events.view', 'lms.view',
      'lms.create', 'lms.manage', 'complaints.view', 'complaints.create'
    )
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = p_school_id
    );

  -- Student: View Only
  INSERT INTO role_permissions (school_id, role_id, permission_id)
  SELECT p_school_id, r.id, p.id
  FROM roles r CROSS JOIN permissions p
  WHERE r.code = 'student' AND r.school_id = p_school_id AND p.school_id = p_school_id
    AND p.code IN (
      'academics.view', 'attendance.view', 'exams.view', 'results.view',
      'diary.view', 'timetable.view', 'notices.view', 'events.view', 'lms.view',
      'fees.view', 'complaints.view'
    )
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = p_school_id
    );

  -- Parent / Guardian: same read-only parent portal surface (+ complaint create)
  INSERT INTO role_permissions (school_id, role_id, permission_id)
  SELECT p_school_id, r.id, p.id
  FROM roles r CROSS JOIN permissions p
  WHERE r.code = 'parent' AND r.school_id = p_school_id AND p.school_id = p_school_id
    AND p.code IN (
      'academics.view', 'attendance.view', 'exams.view', 'results.view',
      'diary.view', 'timetable.view', 'notices.view', 'events.view', 'lms.view',
      'fees.view', 'complaints.view', 'complaints.create'
    )
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = p_school_id
    );

  -- Accounts: Fee collection + student records (+ toggle-gated staff manage-users).
  -- Segregation of duties (RBAC epic): NO expenses management, NO payroll, and NO
  -- salary/payslip/refund/approval perms.
  -- staff.view/create/edit/delete are RETAINED here because two existing features
  -- depend on them — the admin opt-in `accounts_staff_creation_enabled` toggle
  -- (enforced at the route via assertAccountsCanCreateStaff) and the accounts
  -- manage-users password-reset flow. Salary output is gated separately by
  -- salary.view (management-only) at the route layer. Whether to remove staff
  -- management from accounts entirely is a product decision (see GATE 1 note).
  INSERT INTO role_permissions (school_id, role_id, permission_id)
  SELECT p_school_id, r.id, p.id
  FROM roles r CROSS JOIN permissions p
  WHERE r.code = 'accounts' AND r.school_id = p_school_id AND p.school_id = p_school_id
    AND p.code IN (
      'fees.view', 'fees.manage', 'fees.collect', 'transactions.view',
      'receipts.generate', 'reports.financial', 'notices.view', 'staff.view',
      'staff.create', 'staff.edit', 'staff.delete', 'dashboard.view', 'academics.view',
      'students.view', 'students.create', 'students.edit', 'students.delete',
      'certificates.issue'
    )
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = p_school_id
    );

  -- Principal: Full Access (same as Admin)
  INSERT INTO role_permissions (school_id, role_id, permission_id)
  SELECT p_school_id, r.id, p.id
  FROM roles r CROSS JOIN permissions p
  WHERE r.code = 'principal' AND r.school_id = p_school_id AND p.school_id = p_school_id
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = p_school_id
    );

  -- Driver: Transport-only
  INSERT INTO role_permissions (school_id, role_id, permission_id)
  SELECT p_school_id, r.id, p.id
  FROM roles r CROSS JOIN permissions p
  WHERE r.code = 'driver' AND r.school_id = p_school_id AND p.school_id = p_school_id
    AND p.code IN ('transport.view', 'notices.view')
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = p_school_id
    );

  -- 6. Financial Policy Rules
  INSERT INTO financial_policy_rules (school_id, rule_code, rule_name, description, value_type, default_value, current_value)
  SELECT p_school_id, v.rule_code, v.rule_name, v.description, v.value_type, v.default_value, v.current_value
  FROM (VALUES
    ('EXPENSE_AUTO_APPROVE_LIMIT', 'Expense Auto-Approval Limit', 'Expenses below this amount are auto-approved.', 'amount', '1000'::jsonb, '1000'::jsonb),
    ('CASH_COLLECTION_DAILY_LIMIT', 'Daily Cash Collection Limit', 'Maximum cash a user can collect per day.', 'amount', '50000'::jsonb, '50000'::jsonb),
    ('FEE_WAIVER_MAX_PERCENT', 'Max Fee Waiver Percentage', 'Maximum percentage of fee that can be waived.', 'percentage', '20'::jsonb, '20'::jsonb),
    ('PAYROLL_OVERRIDE_ALLOWED', 'Payroll Override Allowed', 'Can payroll values be manually overridden?', 'boolean', 'false'::jsonb, 'false'::jsonb),
    ('LOCK_PAST_MONTHS_DAYS', 'Lock Past Months After (Days)', 'Number of days after which previous month data is locked.', 'amount', '7'::jsonb, '7'::jsonb)
  ) AS v(rule_code, rule_name, description, value_type, default_value, current_value)
  WHERE NOT EXISTS (
    SELECT 1 FROM financial_policy_rules fpr WHERE fpr.school_id = p_school_id AND fpr.rule_code = v.rule_code
  );

  -- 7. School Settings (defaults — school_name derived from schools.name)
  INSERT INTO school_settings (school_id, key, value)
  SELECT p_school_id, v.key, v.value
  FROM (VALUES
    ('school_name',        (SELECT COALESCE(name, 'Unnamed School') FROM schools WHERE id = p_school_id)),
    ('school_timezone',    'Asia/Kolkata'),
    ('school_hours_start', '08:00'),
    ('school_hours_end',   '17:00'),
    ('admin_email',        '')
  ) AS v(key, value)
  WHERE NOT EXISTS (
    SELECT 1 FROM school_settings ss WHERE ss.school_id = p_school_id AND ss.key = v.key
  );

END;
$$;

-- Trigger: Auto-seed defaults when a new school is created
CREATE OR REPLACE FUNCTION trg_seed_school_on_create()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM seed_school_defaults(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_school_seed_defaults ON schools;
CREATE TRIGGER trg_school_seed_defaults
AFTER INSERT ON schools
FOR EACH ROW EXECUTE FUNCTION trg_seed_school_on_create();

GRANT EXECUTE ON FUNCTION seed_school_defaults(INTEGER) TO service_role;

-- 1. REFERENCE TABLES
CREATE TABLE IF NOT EXISTS countries (
    code CHAR(2) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS genders (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS student_categories (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS religions (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS blood_groups (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(10) NOT NULL,
    UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS relationship_types (
    id SMALLINT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS staff_designations (
    id SERIAL PRIMARY KEY,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    UNIQUE (school_id, name)
);

CREATE INDEX IF NOT EXISTS idx_staff_designations_school_id ON staff_designations(school_id);


-- ENSURE SCHOOL_ID ON ALL TABLES


CREATE INDEX IF NOT EXISTS idx_staff_designations_school_id ON staff_designations(school_id);

-- 1b. SEED REFERENCE DATA
-- These INSERTs are idempotent (ON CONFLICT DO NOTHING) and required
-- because persons.gender_id and students.status_id are NOT NULL FK columns.

INSERT INTO genders (id, name)
SELECT v.id, v.name
FROM (VALUES
  (1, 'Male'),
  (2, 'Female'),
  (3, 'Other')
) AS v(id, name)
WHERE NOT EXISTS (
  SELECT 1 FROM genders g WHERE g.id = v.id
);

INSERT INTO countries (code, name)
SELECT v.code, v.name
FROM (VALUES
  ('IN', 'India'),
  ('US', 'United States'),
  ('GB', 'United Kingdom'),
  ('AE', 'United Arab Emirates'),
  ('SA', 'Saudi Arabia'),
  ('AU', 'Australia')
) AS v(code, name)
WHERE NOT EXISTS (
  SELECT 1 FROM countries c WHERE c.code = v.code
);

INSERT INTO religions (id, name)
SELECT v.id, v.name
FROM (VALUES
  (1, 'Hinduism'),
  (2, 'Islam'),
  (3, 'Christianity'),
  (4, 'Sikhism'),
  (5, 'Buddhism'),
  (6, 'Jainism'),
  (7, 'Other')
) AS v(id, name)
WHERE NOT EXISTS (
  SELECT 1 FROM religions r WHERE r.id = v.id
);

INSERT INTO blood_groups (id, name)
SELECT v.id, v.name
FROM (VALUES
  (1, 'A+'),
  (2, 'A-'),
  (3, 'B+'),
  (4, 'B-'),
  (5, 'AB+'),
  (6, 'AB-'),
  (7, 'O+'),
  (8, 'O-')
) AS v(id, name)
WHERE NOT EXISTS (
  SELECT 1 FROM blood_groups b WHERE b.id = v.id
);

INSERT INTO student_categories (id, name)
SELECT v.id, v.name
FROM (VALUES
  (1, 'General'),
  (2, 'OBC'),
  (3, 'SC'),
  (4, 'ST'),
  (5, 'EWS'),
  (6, 'BC'),
  (7, 'BC-A'),
  (8, 'BC-B'),
  (9, 'BC-C'),
  (10, 'BC-D'),
  (11, 'BC-E')
) AS v(id, name)
WHERE NOT EXISTS (
  SELECT 1 FROM student_categories sc WHERE sc.id = v.id
);

INSERT INTO relationship_types (id, name)
SELECT v.id, v.name
FROM (VALUES
  (1, 'Father'),
  (2, 'Mother'),
  (3, 'Guardian'),
  (4, 'Sibling'),
  (5, 'Other')
) AS v(id, name)
WHERE NOT EXISTS (
  SELECT 1 FROM relationship_types rt WHERE rt.id = v.id
);

-- [MOVED TO seed_school_defaults()] Staff designations are now auto-seeded per school.

-- 2. CORE TRIGGERS (GLOBAL)

-- 3. PERSONS
CREATE TABLE IF NOT EXISTS persons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name VARCHAR(50) NOT NULL,
    middle_name VARCHAR(50),
    last_name VARCHAR(50),
    display_name TEXT,
    dob DATE,
    gender_id SMALLINT NOT NULL REFERENCES genders(id),
    nationality_code CHAR(2) REFERENCES countries(code),
    photo_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_person_dob_past CHECK (dob IS NULL OR dob <= current_date),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_persons_school_id ON persons(school_id);


DROP TRIGGER IF EXISTS trg_persons_updated ON persons;
CREATE TRIGGER trg_persons_updated
BEFORE UPDATE ON persons
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


DROP TRIGGER IF EXISTS trg_normalize_person_optional_names ON persons;
CREATE TRIGGER trg_normalize_person_optional_names
BEFORE INSERT OR UPDATE ON persons
FOR EACH ROW EXECUTE FUNCTION normalize_optional_name();

DROP TRIGGER IF EXISTS trg_persons_display_name ON persons;
CREATE TRIGGER trg_persons_display_name
BEFORE INSERT OR UPDATE ON persons
FOR EACH ROW EXECUTE FUNCTION update_person_display_name();


-- Search Index
CREATE INDEX IF NOT EXISTS idx_persons_name_trgm 
ON persons USING gin (first_name gin_trgm_ops, last_name gin_trgm_ops);

-- 4. CONTACTS


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
    deleted_at TIMESTAMPTZ,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_person_contacts_school_id ON person_contacts(school_id);


-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS uq_primary_contact_only
ON person_contacts(person_id, contact_type)
WHERE is_primary = true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_person_contact_unique
ON person_contacts(person_id, contact_type, lower(contact_value))
WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS person_contacts_school_email_unique
ON person_contacts(school_id, lower(contact_value))
WHERE contact_type = 'email'
  AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_person_contacts_updated ON person_contacts;
CREATE TRIGGER trg_person_contacts_updated
BEFORE UPDATE ON person_contacts
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- 5. USERS & RBAC
CREATE TABLE IF NOT EXISTS roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    is_system BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (school_id, code),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_roles_school_id ON roles(school_id);

CREATE TABLE IF NOT EXISTS permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(100) NOT NULL,
    name VARCHAR(150) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (school_id, code),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_permissions_school_id ON permissions(school_id);


CREATE TABLE IF NOT EXISTS role_permissions (
    role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
    permission_id UUID REFERENCES permissions(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (role_id, permission_id),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_school_id ON role_permissions(school_id);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
    account_status account_status_enum NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    theme text DEFAULT 'light'::text,
    is_super_admin BOOLEAN DEFAULT false,
    is_temporary_password BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_school_id ON users(school_id);

-- Index for faster lookups on admin users with temporary passwords
CREATE INDEX IF NOT EXISTS idx_users_is_temporary_password 
ON users (is_temporary_password) 
WHERE is_temporary_password = TRUE;

-- Note: deleted_at needed for soft delete index safety


-- Soft Delete Safe Unique Index
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_person_active 
ON users(school_id, person_id) WHERE deleted_at IS NULL; 

CREATE TABLE IF NOT EXISTS user_settings (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    notification_sound VARCHAR(20) DEFAULT 'custom' CHECK (notification_sound IN ('custom', 'default')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_settings_school_id ON user_settings(school_id);


DROP TRIGGER IF EXISTS trg_user_settings_updated ON user_settings;
CREATE TRIGGER trg_user_settings_updated
BEFORE UPDATE ON user_settings
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
    granted_by UUID REFERENCES users(id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, role_id),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_roles_school_id ON user_roles(school_id);


DROP TRIGGER IF EXISTS trg_user_active_person ON users;
CREATE TRIGGER trg_user_active_person
BEFORE INSERT OR UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION ensure_active_person_ref();

DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


-- 6. STUDENTS
CREATE TABLE IF NOT EXISTS student_statuses (
    id SMALLINT PRIMARY KEY,
    code VARCHAR(20) NOT NULL,
    is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (code)
);


INSERT INTO student_statuses (id, code, is_terminal)
SELECT v.id, v.code, v.is_terminal
FROM (VALUES
  (1, 'active', false),
  (2, 'graduated', true),
  (3, 'withdrawn', true),
  (4, 'expelled', true),
  (5, 'transferred', true)
) AS v(id, code, is_terminal)
WHERE NOT EXISTS (
  SELECT 1 FROM student_statuses ss WHERE ss.id = v.id
);

CREATE TABLE IF NOT EXISTS students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
    admission_no VARCHAR(30) NOT NULL,
    pen_number VARCHAR(30),
    admission_date DATE NOT NULL,
    category_id SMALLINT REFERENCES student_categories(id),
    religion_id SMALLINT REFERENCES religions(id),
    blood_group_id SMALLINT REFERENCES blood_groups(id),
    village VARCHAR(100),
    aadhaar_number VARCHAR(12),
    tc_number VARCHAR(50),
    previous_school BOOLEAN,
    status_id SMALLINT NOT NULL REFERENCES student_statuses(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_students_school_id ON students(school_id);


CREATE INDEX IF NOT EXISTS idx_students_status ON students(status_id);

CREATE INDEX IF NOT EXISTS idx_students_active ON public.students USING btree (id) WHERE (deleted_at IS NULL);


-- Remediation: Soft Delete Safe Unique Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_admission_active 
ON students(school_id, admission_no) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_students_pen_active
ON students(school_id, pen_number) WHERE deleted_at IS NULL AND pen_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_students_person_active 
ON students(school_id, person_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_students_updated ON students;
CREATE TRIGGER trg_students_updated
BEFORE UPDATE ON students
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Durable previews and audit rows for the admin single-field Excel updater.
CREATE TABLE IF NOT EXISTS student_bulk_update_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    original_filename TEXT,
    field_key VARCHAR(50) NOT NULL,
    field_label VARCHAR(100) NOT NULL,
    allow_blank_clear BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'preview'
        CHECK (status IN ('preview', 'committed', 'failed')),
    total_rows INTEGER NOT NULL DEFAULT 0,
    valid_rows INTEGER NOT NULL DEFAULT 0,
    invalid_rows INTEGER NOT NULL DEFAULT 0,
    unchanged_rows INTEGER NOT NULL DEFAULT 0,
    success_rows INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    committed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_student_bulk_update_batches_school
    ON student_bulk_update_batches (school_id, created_at DESC);

CREATE TABLE IF NOT EXISTS student_bulk_update_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES student_bulk_update_batches(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    row_number INTEGER NOT NULL,
    admission_no TEXT,
    raw_value TEXT,
    normalized_value TEXT,
    new_display_value TEXT,
    current_value TEXT,
    student_id UUID REFERENCES students(id) ON DELETE SET NULL,
    person_id UUID REFERENCES persons(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'valid'
        CHECK (status IN ('valid', 'invalid', 'unchanged', 'success', 'failed')),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at TIMESTAMPTZ,
    UNIQUE (batch_id, row_number)
);

CREATE INDEX IF NOT EXISTS idx_student_bulk_update_rows_batch
    ON student_bulk_update_rows (batch_id, row_number);

CREATE INDEX IF NOT EXISTS idx_student_bulk_update_rows_student
    ON student_bulk_update_rows (school_id, student_id)
    WHERE student_id IS NOT NULL;

-- Issued certificates (TC / Bonafide) — used by admin + accounts portals
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

CREATE INDEX IF NOT EXISTS idx_issued_certificates_school_id
  ON public.issued_certificates(school_id);
CREATE INDEX IF NOT EXISTS idx_issued_certificates_student_id
  ON public.issued_certificates(student_id);
CREATE INDEX IF NOT EXISTS idx_issued_certificates_issued_at
  ON public.issued_certificates(school_id, issued_at DESC);

-- 7. PARENTS
CREATE TABLE IF NOT EXISTS parents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE RESTRICT,
    occupation VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_parents_school_id ON parents(school_id);


CREATE UNIQUE INDEX IF NOT EXISTS idx_parents_person_active 
ON parents(school_id, person_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_parents_updated ON parents;
CREATE TRIGGER trg_parents_updated
BEFORE UPDATE ON parents
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

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
    CONSTRAINT chk_parent_valid_range CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_student_parents_school_id ON student_parents(school_id);


CREATE UNIQUE INDEX IF NOT EXISTS uq_student_primary_parent
ON student_parents(student_id)
WHERE is_primary_contact = true
  AND deleted_at IS NULL;


DROP TRIGGER IF EXISTS trg_student_parents_active ON student_parents;
CREATE TRIGGER trg_student_parents_active
BEFORE INSERT OR UPDATE ON student_parents
FOR EACH ROW EXECUTE FUNCTION ensure_active_student_parent();


-- 8. ACADEMICS
CREATE TABLE IF NOT EXISTS academic_years (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(20) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_academic_year CHECK (start_date < end_date),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_academic_years_school_id ON academic_years(school_id);


CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_years_code_active ON academic_years(school_id, code) WHERE deleted_at IS NULL;

ALTER TABLE students
  ADD COLUMN IF NOT EXISTS exit_academic_year_id UUID REFERENCES academic_years(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS exit_date DATE;

CREATE INDEX IF NOT EXISTS idx_students_exit_academic_year
  ON students (school_id, exit_academic_year_id)
  WHERE deleted_at IS NULL AND exit_academic_year_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS classes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL,
    code VARCHAR(20),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_classes_school_id ON classes(school_id);


CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_name_active ON classes(school_id, name) WHERE deleted_at IS NULL;


CREATE TABLE IF NOT EXISTS sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL,
    code VARCHAR(20),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sections_school_id ON sections(school_id);


CREATE UNIQUE INDEX IF NOT EXISTS idx_sections_name_active ON sections(school_id, name) WHERE deleted_at IS NULL;


CREATE TABLE IF NOT EXISTS class_sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    class_id UUID NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
    section_id UUID NOT NULL REFERENCES sections(id) ON DELETE RESTRICT,
    academic_year_id UUID NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
    class_teacher_id UUID, -- FK added after staff table is created (Fix 10)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (school_id, class_id, section_id, academic_year_id)
);

CREATE INDEX IF NOT EXISTS idx_class_sections_school_id ON class_sections(school_id);


CREATE TABLE IF NOT EXISTS student_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_student_enrollments_school_id ON student_enrollments(school_id);

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
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


-- Remediation: Set-Based Roll Number Calculation


DROP TRIGGER IF EXISTS trg_validate_enrollment ON student_enrollments;
CREATE TRIGGER trg_validate_enrollment
BEFORE INSERT OR UPDATE ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION validate_enrollment_year();


DROP TRIGGER IF EXISTS trg_enroll_active_student ON student_enrollments;
CREATE TRIGGER trg_enroll_active_student
BEFORE INSERT OR UPDATE ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION ensure_active_student_enrollment();

CREATE OR REPLACE FUNCTION recalculate_rolls_after_enrollment_change()
RETURNS TRIGGER
SET search_path = public
AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recalculate_rolls_after_enrollment_change ON student_enrollments;
CREATE TRIGGER trg_recalculate_rolls_after_enrollment_change
AFTER INSERT OR DELETE OR UPDATE OF class_section_id, academic_year_id, status, deleted_at
ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION recalculate_rolls_after_enrollment_change();

CREATE OR REPLACE FUNCTION recalculate_rolls_after_student_name_change()
RETURNS TRIGGER
SET search_path = public
AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recalculate_rolls_after_student_name_change ON persons;
CREATE TRIGGER trg_recalculate_rolls_after_student_name_change
AFTER UPDATE OF first_name, middle_name, last_name ON persons
FOR EACH ROW EXECUTE FUNCTION recalculate_rolls_after_student_name_change();

CREATE OR REPLACE FUNCTION recalculate_rolls_after_student_delete_change()
RETURNS TRIGGER
SET search_path = public
AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recalculate_rolls_after_student_delete_change ON students;
CREATE TRIGGER trg_recalculate_rolls_after_student_delete_change
AFTER UPDATE OF deleted_at ON students
FOR EACH ROW EXECUTE FUNCTION recalculate_rolls_after_student_delete_change();

-- 9. ATTENDANCE


CREATE TABLE IF NOT EXISTS daily_attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_enrollment_id UUID NOT NULL REFERENCES student_enrollments(id) ON DELETE RESTRICT,
    attendance_date DATE NOT NULL,
    status attendance_status_enum NOT NULL,
  remarks TEXT,
    marked_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    marked_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_attendance_date_past CHECK (attendance_date <= current_date),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_daily_attendance_school_id ON daily_attendance(school_id);
CREATE INDEX IF NOT EXISTS idx_attendance_school_student_date ON daily_attendance(school_id, student_enrollment_id, attendance_date);


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


DROP TRIGGER IF EXISTS trg_validate_attendance ON daily_attendance;
CREATE TRIGGER trg_validate_attendance
BEFORE INSERT OR UPDATE ON daily_attendance
FOR EACH ROW EXECUTE FUNCTION validate_attendance_entry();

-- 10. STAFF
CREATE TABLE IF NOT EXISTS staff_statuses (
    id SMALLINT PRIMARY KEY,
    code VARCHAR(20) NOT NULL,
    name VARCHAR(50) NOT NULL,
    UNIQUE (code)
);


INSERT INTO staff_statuses (id, code, name)
SELECT v.id, v.code, v.name
FROM (VALUES
  (1, 'active', 'Active'),
  (2, 'on_leave', 'On Leave'),
  (3, 'resigned', 'Resigned'),
  (4, 'terminated', 'Terminated')
) AS v(id, code, name)
WHERE NOT EXISTS (
  SELECT 1 FROM staff_statuses ss WHERE ss.id = v.id
);

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
    CONSTRAINT chk_staff_joining_past CHECK (joining_date <= current_date),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_staff_school_id ON staff(school_id);


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


DROP TRIGGER IF EXISTS trg_staff_active_person ON staff;
CREATE TRIGGER trg_staff_active_person
BEFORE INSERT OR UPDATE ON staff
FOR EACH ROW EXECUTE FUNCTION ensure_active_person_staff();

-- Fix 10: Deferred FK — class_teacher_id now references staff(id)
-- (class_sections was created before staff, so FK was deferred)


-- 🔒 Protect System Roles

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
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    attendance_date DATE NOT NULL,
    status attendance_status_enum NOT NULL,
    marked_by UUID REFERENCES users(id) ON DELETE SET NULL,
    marked_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_staff_attendance_date_past CHECK (attendance_date <= current_date),
    CONSTRAINT uq_staff_attendance_active UNIQUE (staff_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS idx_staff_attendance_school_id ON staff_attendance(school_id);

CREATE INDEX IF NOT EXISTS idx_staff_attendance_date ON staff_attendance(attendance_date);
CREATE INDEX IF NOT EXISTS idx_staff_attendance_staff ON staff_attendance(staff_id);

DROP TRIGGER IF EXISTS trg_staff_attendance_updated ON staff_attendance;
CREATE TRIGGER trg_staff_attendance_updated
BEFORE UPDATE ON staff_attendance
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


-- 11. FEES (REMEDIATED)
CREATE TABLE IF NOT EXISTS fee_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    code VARCHAR(30),
    description TEXT,
    is_recurring BOOLEAN NOT NULL DEFAULT TRUE,
    is_optional BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fee_types_school_id ON fee_types(school_id);

CREATE INDEX IF NOT EXISTS idx_fee_types_school_sort
  ON fee_types (school_id, sort_order)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_types_name_active ON fee_types(school_id, name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_types_code_active ON fee_types(school_id, code) WHERE deleted_at IS NULL;


CREATE TABLE IF NOT EXISTS fee_structures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    academic_year_id UUID NOT NULL REFERENCES academic_years(id),
    class_id UUID NOT NULL REFERENCES classes(id),
    section_id UUID REFERENCES sections(id) ON DELETE RESTRICT,
    fee_type_id UUID NOT NULL REFERENCES fee_types(id),
    amount DECIMAL(12,2) NOT NULL,
    due_date DATE,
    frequency VARCHAR(20) DEFAULT 'monthly',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    -- TRUE when this structure was hidden by a fee-mode switch (restorable on
    -- toggle-back), as opposed to deleted on purpose by the user.
    mode_deactivated BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT chk_fee_amount_positive CHECK (amount > 0),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fee_structures_school_id ON fee_structures(school_id);

CREATE INDEX IF NOT EXISTS idx_fee_structures_mode_deactivated
  ON fee_structures (school_id)
  WHERE mode_deactivated = TRUE;

CREATE INDEX IF NOT EXISTS idx_fee_structures_section_id
  ON fee_structures(section_id)
  WHERE section_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_structures_class_level_active
  ON fee_structures (school_id, academic_year_id, class_id, fee_type_id)
  WHERE deleted_at IS NULL AND section_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_structures_section_level_active
  ON fee_structures (school_id, academic_year_id, class_id, section_id, fee_type_id)
  WHERE deleted_at IS NULL AND section_id IS NOT NULL;


DROP TRIGGER IF EXISTS trg_fee_structures_updated ON fee_structures;
CREATE TRIGGER trg_fee_structures_updated
BEFORE UPDATE ON fee_structures
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


CREATE TABLE IF NOT EXISTS student_fees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    CONSTRAINT chk_paid_not_exceed CHECK (amount_paid <= amount_due - discount),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_student_fees_school_id ON student_fees(school_id);


-- COMPATIBILITY VIEW: fee_installments (Points to student_fees)
-- This ensures legacy queries and analytics endpoints continue to function.
DROP VIEW IF EXISTS fee_installments CASCADE; CREATE OR REPLACE VIEW fee_installments AS 
SELECT 
    id, student_id, amount_due, amount_paid, discount, 
    status, due_date, created_at, updated_at, deleted_at
FROM student_fees;

-- Fee Propagation & Assignment Logic

DROP TRIGGER IF EXISTS trg_validate_fee_structure_mode ON fee_structures;
CREATE TRIGGER trg_validate_fee_structure_mode
BEFORE INSERT OR UPDATE ON fee_structures
FOR EACH ROW EXECUTE FUNCTION validate_fee_structure_mode();


DROP TRIGGER IF EXISTS trg_propagate_fee_updates ON fee_structures;
CREATE TRIGGER trg_propagate_fee_updates
AFTER UPDATE ON fee_structures
FOR EACH ROW EXECUTE FUNCTION propagate_fee_structure_updates();


DROP TRIGGER IF EXISTS trg_auto_assign_fees_structure ON fee_structures;
CREATE TRIGGER trg_auto_assign_fees_structure
AFTER INSERT ON fee_structures
FOR EACH ROW EXECUTE FUNCTION auto_assign_fees_on_structure_creation();


DROP TRIGGER IF EXISTS trg_auto_assign_fees_enrollment ON student_enrollments;
CREATE TRIGGER trg_auto_assign_fees_enrollment
AFTER INSERT OR UPDATE ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION auto_assign_fees_on_enrollment();


CREATE INDEX IF NOT EXISTS idx_student_fees_student ON student_fees(student_id);
CREATE INDEX IF NOT EXISTS idx_student_fees_status ON student_fees(status);

DROP TRIGGER IF EXISTS trg_student_fees_updated ON student_fees;
CREATE TRIGGER trg_student_fees_updated
BEFORE UPDATE ON student_fees
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


DROP TRIGGER IF EXISTS trg_auto_fee_status ON student_fees;
CREATE TRIGGER trg_auto_fee_status
BEFORE UPDATE ON student_fees
FOR EACH ROW EXECUTE FUNCTION update_fee_status();


CREATE TABLE IF NOT EXISTS fee_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_fee_id UUID NOT NULL REFERENCES student_fees(id) ON DELETE RESTRICT,
    amount DECIMAL(12,2) NOT NULL,
    payment_method payment_method_enum NOT NULL,
    transaction_ref VARCHAR(100) NOT NULL,
    paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_by UUID REFERENCES users(id) ON DELETE SET NULL,
    remarks TEXT,
    refund_of UUID REFERENCES fee_transactions(id) ON DELETE RESTRICT,
    -- Non-null when this transaction is part of a combined multi-fee-type
    -- collection; siblings sharing this UUID roll into one receipt.
    receipt_group UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Payments are strictly positive; refunds (refund_of set) are strictly negative.
    CONSTRAINT chk_transaction_amount CHECK ((refund_of IS NULL AND amount > 0) OR (refund_of IS NOT NULL AND amount < 0)),
    -- Refund entries must have negative amount
    CONSTRAINT chk_refund_must_be_negative CHECK (refund_of IS NULL OR amount < 0),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fee_transactions_school_id ON fee_transactions(school_id);


-- Generic approval queue (RBAC epic Phase 3). First consumer: fee_underpayment —
-- a term fee paid below its remaining balance is held here as PENDING instead of
-- posting, routed to a fee.underpayment.approve holder. Reusable for future
-- workflows (e.g. large fee waivers) by adding a new `type` value.
CREATE TABLE IF NOT EXISTS approval_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    type VARCHAR(64) NOT NULL,
    requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    payload JSONB NOT NULL,
    reason TEXT,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_approval_requests_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'))
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_school_status
    ON approval_requests (school_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_requests_pending_type
    ON approval_requests (school_id, type)
    WHERE status = 'PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_fee_payment_deletion_scope
    ON approval_requests (school_id, type, ((payload->>'scope_key')))
    WHERE type = 'fee_payment_deletion'
      AND status IN ('PENDING', 'APPROVED')
      AND payload->>'consumed_at' IS NULL;


-- Backfill any existing NULL transaction_ref values before constraints


-- Enforce NOT NULL (may already be set by CREATE TABLE above, safe for existing DBs)
ALTER TABLE fee_transactions ALTER COLUMN transaction_ref SET NOT NULL;


-- Unique idempotency key
CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_txn_ref_unique ON fee_transactions(school_id, transaction_ref);

CREATE INDEX IF NOT EXISTS idx_transactions_paid_at ON fee_transactions(paid_at);
CREATE INDEX IF NOT EXISTS idx_fee_transactions_refund_of
    ON fee_transactions (school_id, refund_of)
    WHERE refund_of IS NOT NULL;

-- Remediation: Financial Trigger (APPEND-ONLY — INSERT only)
-- Refunds are negative-amount INSERTs, so += handles both payment and refund

DROP TRIGGER IF EXISTS trg_update_paid_on_transaction ON fee_transactions;
CREATE TRIGGER trg_update_paid_on_transaction
AFTER INSERT ON fee_transactions
FOR EACH ROW EXECUTE FUNCTION update_fee_paid_amount();

-- Guard: Block UPDATE/DELETE on fee_transactions (append-only ledger)

DROP TRIGGER IF EXISTS trg_guard_fee_txn ON fee_transactions;
CREATE TRIGGER trg_guard_fee_txn
BEFORE UPDATE OR DELETE ON fee_transactions
FOR EACH ROW EXECUTE FUNCTION prevent_fee_transaction_mutation();

CREATE SEQUENCE IF NOT EXISTS receipt_no_seq START 1001;

CREATE TABLE IF NOT EXISTS receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    receipt_no VARCHAR(30) NOT NULL,
    student_id UUID NOT NULL REFERENCES students(id),
    total_amount DECIMAL(12,2) NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    issued_by UUID REFERENCES users(id),
    remarks TEXT,
    -- Groups the sibling transactions of a combined multi-fee-type collection
    -- into this single receipt.
    receipt_group UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (school_id, receipt_no)
);

CREATE INDEX IF NOT EXISTS idx_receipts_school_id ON receipts(school_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_group_unique
  ON receipts (school_id, receipt_group)
  WHERE receipt_group IS NOT NULL;

CREATE TABLE IF NOT EXISTS receipt_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    fee_transaction_id UUID NOT NULL REFERENCES fee_transactions(id),
    amount DECIMAL(12,2) NOT NULL,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_receipt_items_school_id ON receipt_items(school_id);


-- Automation: Auto-generate receipt on transaction

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
        v_receipt_no := 'RCT-' || TO_CHAR(r_trans.paid_at, 'YYYYMMDD') || '-'
            || SUBSTRING(get_next_receipt_no(r_trans.school_id) FROM '([0-9]+)$');

        -- Insert Receipt
        INSERT INTO receipts (
            school_id,
            receipt_no,
            student_id,
            total_amount,
            issued_at,
            issued_by,
            remarks
        ) VALUES (
            r_trans.school_id,
            v_receipt_no,
            v_student_id,
            r_trans.amount,
            r_trans.paid_at,
            r_trans.received_by,
            COALESCE(r_trans.remarks, 'Backfilled')
        ) RETURNING id INTO v_receipt_id;

        -- Insert Receipt Item
        INSERT INTO receipt_items (
            school_id,
            receipt_id,
            fee_transaction_id,
            amount
        ) VALUES (
            r_trans.school_id,
            v_receipt_id,
            r_trans.id,
            r_trans.amount
        );
    END LOOP;
END $$;

-- 12. EXAMS & RESULTS
CREATE TABLE IF NOT EXISTS subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subjects_school_id ON subjects(school_id);


CREATE UNIQUE INDEX IF NOT EXISTS idx_subjects_code_active ON subjects(school_id, code) WHERE deleted_at IS NULL;


CREATE TABLE IF NOT EXISTS class_subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_section_id UUID NOT NULL REFERENCES class_sections(id),
    subject_id UUID NOT NULL REFERENCES subjects(id),
    teacher_id UUID REFERENCES staff(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_class_subjects_school_id ON class_subjects(school_id);


CREATE UNIQUE INDEX IF NOT EXISTS idx_class_subjects_unique ON class_subjects(school_id, class_section_id, subject_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_class_subjects_teacher ON class_subjects(teacher_id);

DROP TRIGGER IF EXISTS trg_class_subjects_updated ON class_subjects;
CREATE TRIGGER trg_class_subjects_updated
BEFORE UPDATE ON class_subjects
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


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
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_exam_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_exams_school_id ON exams(school_id);


CREATE INDEX IF NOT EXISTS idx_exams_active ON exams(id) WHERE deleted_at IS NULL;


DROP TRIGGER IF EXISTS trg_exams_updated ON exams;
CREATE TRIGGER trg_exams_updated
BEFORE UPDATE ON exams
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS exam_subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    subject_id UUID NOT NULL REFERENCES subjects(id),
    class_id UUID NOT NULL REFERENCES classes(id),
    exam_date DATE,
    max_marks DECIMAL(5,2) NOT NULL DEFAULT 100,
    passing_marks DECIMAL(5,2) NOT NULL DEFAULT 35,
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_marks_valid CHECK (passing_marks <= max_marks AND max_marks > 0),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_exam_subjects_school_id ON exam_subjects(school_id);


CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_subjects_active ON exam_subjects(exam_id, subject_id, class_id) WHERE deleted_at IS NULL;


CREATE TABLE IF NOT EXISTS grading_scales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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


DROP TRIGGER IF EXISTS trg_validate_marks ON marks;
CREATE TRIGGER trg_validate_marks
BEFORE INSERT OR UPDATE ON marks
FOR EACH ROW EXECUTE FUNCTION validate_marks_entry();


CREATE INDEX IF NOT EXISTS idx_marks_enrollment ON marks(student_enrollment_id);
CREATE INDEX IF NOT EXISTS idx_marks_exam_subject ON marks(exam_subject_id);

DROP TRIGGER IF EXISTS trg_marks_updated ON marks;
CREATE TRIGGER trg_marks_updated
BEFORE UPDATE ON marks
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- 13. COMMUNICATION & SUPPORT

CREATE TABLE IF NOT EXISTS parent_visits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
    parent_id UUID REFERENCES parents(id) ON DELETE SET NULL,
    parent_name VARCHAR(150) NOT NULL,
    relationship VARCHAR(50),
    purpose TEXT NOT NULL,
    notes TEXT,
    visited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    recorded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_parent_visit_name_not_blank CHECK (length(btrim(parent_name)) > 0),
    CONSTRAINT chk_parent_visit_purpose_not_blank CHECK (length(btrim(purpose)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_parent_visits_school_date
ON parent_visits(school_id, visited_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_parent_visits_student_date
ON parent_visits(school_id, student_id, visited_at DESC) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_parent_visits_updated ON parent_visits;
CREATE TRIGGER trg_parent_visits_updated
BEFORE UPDATE ON parent_visits
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

ALTER TABLE parent_visits ENABLE ROW LEVEL SECURITY;


CREATE TABLE IF NOT EXISTS complaints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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
    deleted_at TIMESTAMPTZ,
    UNIQUE (school_id, ticket_no)
);
CREATE INDEX IF NOT EXISTS idx_complaints_school_id ON complaints(school_id);

DROP TRIGGER IF EXISTS trg_prevent_complaint_delete ON complaints;
CREATE TRIGGER trg_prevent_complaint_delete
BEFORE DELETE ON complaints
FOR EACH ROW EXECUTE FUNCTION prevent_complaint_delete();


CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaints_raised_by ON complaints(raised_by);
CREATE INDEX IF NOT EXISTS idx_complaints_raised_for ON complaints(raised_for_student_id);
CREATE INDEX IF NOT EXISTS idx_complaints_assigned_to ON complaints(assigned_to);

DROP TRIGGER IF EXISTS trg_complaints_updated ON complaints;
CREATE TRIGGER trg_complaints_updated
BEFORE UPDATE ON complaints
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE SEQUENCE IF NOT EXISTS complaint_ticket_seq START 1;


DROP TRIGGER IF EXISTS trg_complaints_ticket ON complaints;
CREATE TRIGGER trg_complaints_ticket
BEFORE INSERT ON complaints
FOR EACH ROW EXECUTE FUNCTION generate_ticket_no();


CREATE TABLE IF NOT EXISTS notices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notices_school_id ON notices(school_id);


CREATE INDEX IF NOT EXISTS idx_notices_audience ON notices(audience);
CREATE INDEX IF NOT EXISTS idx_notices_publish ON notices(publish_at);

DROP TRIGGER IF EXISTS trg_notices_updated ON notices;
CREATE TRIGGER trg_notices_updated
BEFORE UPDATE ON notices
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


-- Remediation: Notices RLS
ALTER TABLE notices ENABLE ROW LEVEL SECURITY;


DROP POLICY IF EXISTS "View Notices" ON notices;
CREATE POLICY "View Notices" ON notices FOR SELECT
USING (
  (auth.role() = 'service_role') OR (
    notices.school_id = auth_school_id() AND (
      (created_by = auth.uid()) OR
      (audience = 'all' AND auth.role() = 'authenticated') OR
      (audience = 'staff' AND auth_has_role(ARRAY['admin', 'teacher', 'staff', 'accounts'])) OR
      (audience = 'students' AND auth_has_role(ARRAY['admin', 'student'])) OR
      (audience = 'parents' AND auth_has_role(ARRAY['admin', 'parent'])) OR
      (audience = 'class' AND target_class_id IS NOT NULL)
    )
  )
);

DROP POLICY IF EXISTS "Manage Notices" ON notices;
CREATE POLICY "Manage Notices" ON notices FOR ALL 
USING (
  (auth.role() = 'service_role') OR (
    notices.school_id = auth_school_id() AND (
      auth_has_role(ARRAY['admin']) OR
      EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN role_permissions rp ON ur.role_id = rp.role_id
        JOIN permissions p ON rp.permission_id = p.id
        WHERE ur.user_id = auth.uid()
          AND ur.school_id = auth_school_id()
          AND rp.school_id = auth_school_id()
          AND p.school_id = auth_school_id()
          AND (p.code = 'notices.create' OR p.code = 'notices.manage')
      )
    )
  )
);


CREATE TABLE IF NOT EXISTS leave_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    CONSTRAINT chk_leave_dates CHECK (end_date >= start_date),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_leave_app_school_id ON leave_applications(school_id);


CREATE INDEX IF NOT EXISTS idx_leaves_applicant ON leave_applications(applicant_id);
CREATE INDEX IF NOT EXISTS idx_leaves_status ON leave_applications(status);

DROP TRIGGER IF EXISTS trg_leaves_updated ON leave_applications;
CREATE TRIGGER trg_leaves_updated
BEFORE UPDATE ON leave_applications
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS diary_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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


CREATE INDEX IF NOT EXISTS idx_diary_class ON diary_entries(class_section_id);
CREATE INDEX IF NOT EXISTS idx_diary_date ON diary_entries(entry_date);


DROP TRIGGER IF EXISTS trg_validate_diary ON diary_entries;
CREATE TRIGGER trg_validate_diary
BEFORE INSERT OR UPDATE ON diary_entries
FOR EACH ROW EXECUTE FUNCTION validate_diary_entry();

DROP TRIGGER IF EXISTS trg_diary_updated ON diary_entries;
CREATE TRIGGER trg_diary_updated
BEFORE UPDATE ON diary_entries
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


CREATE TABLE IF NOT EXISTS periods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL, 
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_break BOOLEAN NOT NULL DEFAULT FALSE,  -- Lunch/short-break slots (no subject/teacher assignment)
    CONSTRAINT chk_period_times CHECK (end_time > start_time),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

-- Backward-compat for deployments created before the break flag shipped.
ALTER TABLE periods ADD COLUMN IF NOT EXISTS is_break BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE periods DROP CONSTRAINT IF EXISTS periods_name_key;

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


-- 3. Seed/Update Data

ALTER TABLE IF EXISTS periods DROP CONSTRAINT IF EXISTS periods_name_key;


ALTER TABLE IF EXISTS roles DROP CONSTRAINT IF EXISTS roles_code_key;


ALTER TABLE IF EXISTS permissions DROP CONSTRAINT IF EXISTS permissions_code_key;


ALTER TABLE IF EXISTS feature_flags DROP CONSTRAINT IF EXISTS feature_flags_code_key;


ALTER TABLE IF EXISTS ui_route_permissions DROP CONSTRAINT IF EXISTS ui_route_permissions_route_key_key;


-- [MOVED TO seed_school_defaults()] Periods are now auto-seeded per school.
-- The dangerous global DELETE FROM periods has been removed (schools may customize periods).

-- (Removed Legacy timetable_entries table - Use timetable_slots)


-- 14. TRANSPORT

-- 14.1 Routes (Bus → Route → Stops → Students)
CREATE TABLE IF NOT EXISTS transport_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    deleted_at TIMESTAMPTZ,
    UNIQUE (code),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transport_routes_school_id ON transport_routes(school_id);
CREATE INDEX IF NOT EXISTS idx_transport_routes_active ON transport_routes(school_id) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_transport_routes_updated ON transport_routes;
CREATE TRIGGER trg_transport_routes_updated
BEFORE UPDATE ON transport_routes
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


-- 14.1 Buses
CREATE TABLE IF NOT EXISTS buses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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


-- Add deferred FK from routes → buses (circular reference resolved)

CREATE INDEX IF NOT EXISTS idx_routes_bus ON transport_routes(bus_id);

-- 14.3 Stops (strictly ordered per route)
CREATE TABLE IF NOT EXISTS transport_stops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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


-- 14.4 Student ↔ Transport mapping
CREATE TABLE IF NOT EXISTS student_transport (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE RESTRICT,
    stop_id UUID REFERENCES transport_stops(id) ON DELETE SET NULL,
    bus_id UUID REFERENCES buses(id),            -- Auto-derived from route on assignment
    academic_year_id UUID NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT student_transport_student_id_academic_year_id_key UNIQUE (student_id, academic_year_id)
);

CREATE INDEX IF NOT EXISTS idx_student_transpschool_id ON student_transport(school_id);

CREATE INDEX IF NOT EXISTS idx_student_transport_route ON student_transport(route_id);
CREATE INDEX IF NOT EXISTS idx_student_transport_bus ON student_transport(bus_id);

-- Cycle 3 schema alignment for route upserts.
ALTER TABLE IF EXISTS daily_attendance
  ADD COLUMN IF NOT EXISTS remarks TEXT;

ALTER TABLE IF EXISTS staff_attendance
  DROP CONSTRAINT IF EXISTS uq_staff_attendance_active;

ALTER TABLE IF EXISTS staff_attendance
  ADD CONSTRAINT uq_staff_attendance_active UNIQUE (staff_id, attendance_date);

ALTER TABLE IF EXISTS student_transport
  DROP CONSTRAINT IF EXISTS student_transport_school_id_student_id_academic_year_id_key;

ALTER TABLE IF EXISTS student_transport
  DROP CONSTRAINT IF EXISTS student_transport_student_id_academic_year_id_key;

ALTER TABLE IF EXISTS student_transport
  ADD CONSTRAINT student_transport_student_id_academic_year_id_key UNIQUE (student_id, academic_year_id);


-- 14.4.1 Bulk transport import audit
CREATE TABLE IF NOT EXISTS transport_import_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    original_filename TEXT,
    academic_year_id UUID NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'preview'
        CHECK (status IN ('preview', 'committed', 'failed')),
    total_rows INTEGER NOT NULL DEFAULT 0,
    valid_rows INTEGER NOT NULL DEFAULT 0,
    success_rows INTEGER NOT NULL DEFAULT 0,
    failed_rows INTEGER NOT NULL DEFAULT 0,
    skipped_rows INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    committed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_transport_import_batches_school
    ON transport_import_batches(school_id, created_at DESC);

CREATE TABLE IF NOT EXISTS transport_import_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES transport_import_batches(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    row_number INTEGER NOT NULL,
    full_name TEXT,
    admission_no TEXT,
    stop_name TEXT,
    student_id UUID REFERENCES students(id) ON DELETE SET NULL,
    stop_id UUID REFERENCES transport_stops(id) ON DELETE SET NULL,
    route_id UUID REFERENCES transport_routes(id) ON DELETE SET NULL,
    route_name TEXT,
    status TEXT NOT NULL DEFAULT 'valid'
        CHECK (status IN ('valid', 'invalid', 'success', 'failed')),
    error_message TEXT,
    warning_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (batch_id, row_number)
);

CREATE INDEX IF NOT EXISTS idx_transport_import_rows_batch
    ON transport_import_rows(batch_id, row_number);


-- 14.5 Bus live locations (single row per bus, upserted)
CREATE TABLE IF NOT EXISTS bus_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bus_id UUID NOT NULL REFERENCES buses(id) ON DELETE CASCADE,
    latitude DECIMAL(10,8) NOT NULL,
    longitude DECIMAL(11,8) NOT NULL,
    speed DECIMAL(5,2),
    heading DECIMAL(5,2),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    is_mocked boolean DEFAULT false,
    is_suspicious boolean DEFAULT false,
    -- One live row per bus: required by the ON CONFLICT (bus_id) upsert in
    -- POST /transport/buses/:id/location (full track lives in bus_trip_history).
    CONSTRAINT bus_locations_bus_id_key UNIQUE (bus_id)
);

CREATE INDEX IF NOT EXISTS idx_bus_locations_school_id ON bus_locations(school_id);

CREATE INDEX IF NOT EXISTS idx_bus_locations_recent ON bus_locations(bus_id, recorded_at DESC);

-- Backward-compat for databases created before the single-row upsert shipped.
DO $$ BEGIN
  ALTER TABLE bus_locations ADD CONSTRAINT bus_locations_bus_id_key UNIQUE (bus_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- 14.6 Trips (driver trip execution)
CREATE TABLE IF NOT EXISTS trips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bus_id UUID NOT NULL REFERENCES buses(id),
    route_id UUID NOT NULL REFERENCES transport_routes(id),
    driver_id UUID NOT NULL REFERENCES staff(id),
    status VARCHAR(20) NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'completed', 'cancelled')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trips_school_id ON trips(school_id);


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
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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

-- Live-tracking proximity push dedupe (see migrations/20260715_transport_live_tracking.sql)
ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS approach_notified_at TIMESTAMPTZ;

-- ── Live tracking v2 Phase A: calibration capture ──────────────────────────
-- (see migrations/20260715_transport_calibration_phase_a.sql and
--  TRANSPORT_LIVE_TRACKING_PLAN.md; 'afternoon' folds into the 'evening' leg)

-- Learned geofence per (stop, leg): accuracy-weighted GPS centroid.
CREATE TABLE IF NOT EXISTS route_stop_geo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
    stop_id UUID NOT NULL REFERENCES transport_stops(id) ON DELETE CASCADE,
    trip_direction TEXT NOT NULL CHECK (trip_direction IN ('morning', 'evening')),
    latitude DECIMAL(10,8) NOT NULL,
    longitude DECIMAL(11,8) NOT NULL,
    sample_weight NUMERIC NOT NULL DEFAULT 0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    radius_m NUMERIC NOT NULL DEFAULT 150,
    last_accuracy_m NUMERIC,
    locked BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (school_id, stop_id, trip_direction)
);

CREATE INDEX IF NOT EXISTS idx_route_stop_geo_route ON route_stop_geo(school_id, route_id, trip_direction);

-- Learned travel time between consecutive stops (EWMA + EW variance).
CREATE TABLE IF NOT EXISTS route_segment_time (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
    trip_direction TEXT NOT NULL CHECK (trip_direction IN ('morning', 'evening')),
    from_stop_id UUID NOT NULL REFERENCES transport_stops(id) ON DELETE CASCADE,
    to_stop_id UUID NOT NULL REFERENCES transport_stops(id) ON DELETE CASCADE,
    ewma_seconds NUMERIC NOT NULL,
    ewvar_seconds NUMERIC NOT NULL DEFAULT 0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    last_seconds NUMERIC,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (school_id, route_id, trip_direction, from_stop_id, to_stop_id)
);

CREATE INDEX IF NOT EXISTS idx_route_segment_time_route ON route_segment_time(school_id, route_id, trip_direction);

-- Graduation gate per (route, leg): flips is_calibrated after 2 clean trips.
CREATE TABLE IF NOT EXISTS route_leg_calibration (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
    trip_direction TEXT NOT NULL CHECK (trip_direction IN ('morning', 'evening')),
    is_calibrated BOOLEAN NOT NULL DEFAULT false,
    stops_total INTEGER NOT NULL DEFAULT 0,
    stops_calibrated INTEGER NOT NULL DEFAULT 0,
    segments_total INTEGER NOT NULL DEFAULT 0,
    segments_learned INTEGER NOT NULL DEFAULT 0,
    clean_trip_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (school_id, route_id, trip_direction)
);

-- Provenance + geofence working state (Phase B debounce/dwell).
ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS arrival_source TEXT
    CHECK (arrival_source IN ('manual', 'geofence', 'timeout'));
ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS geofence_hits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS first_seen_in_radius TIMESTAMPTZ;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS late_notified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_trip_stop_trip ON trip_stop_status(trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_stop_status ON trip_stop_status(status);
CREATE INDEX IF NOT EXISTS idx_trip_stop_status_trip_school_order_status
  ON trip_stop_status(trip_id, school_id, stop_order, status);
CREATE INDEX IF NOT EXISTS idx_trips_school_bus_live
  ON trips(school_id, bus_id, created_at DESC) WHERE status IN ('active', 'in_progress');
CREATE UNIQUE INDEX IF NOT EXISTS uq_trips_one_live_trip_per_bus
  ON trips(school_id, bus_id) WHERE status IN ('active', 'in_progress');


-- 14.8 RLS for trips
ALTER TABLE trips ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE trips TO authenticated;
GRANT ALL ON TABLE trips TO service_role;

DROP POLICY IF EXISTS "Admins can manage trips" ON trips;
CREATE POLICY "Admins can manage trips" ON trips FOR ALL USING (
  (auth.role() = 'service_role') OR (
    trips.school_id = auth_school_id() AND
    EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = auth.uid() AND r.code IN ('admin', 'driver')
    )
  )
);

DROP POLICY IF EXISTS "Drivers can view own trips" ON trips;
CREATE POLICY "Drivers can view own trips" ON trips FOR SELECT USING (
  (auth.role() = 'service_role') OR (
    trips.school_id = auth_school_id() AND
    driver_id IN (
      SELECT s.id FROM staff s
      JOIN users u ON s.person_id = u.person_id
      WHERE u.id = auth.uid()
        AND u.school_id = auth_school_id()
        AND s.school_id = auth_school_id()
    )
  )
);

-- 14.9 RLS for trip_stop_status
ALTER TABLE trip_stop_status ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE trip_stop_status TO authenticated;
GRANT ALL ON TABLE trip_stop_status TO service_role;

DROP POLICY IF EXISTS "Authenticated can view trip stops" ON trip_stop_status;
CREATE POLICY "Authenticated can view trip stops" ON trip_stop_status FOR SELECT
  TO authenticated USING (trip_stop_status.school_id = auth_school_id());

-- 15. HOSTEL
CREATE TABLE IF NOT EXISTS hostel_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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


CREATE TABLE IF NOT EXISTS hostel_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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


CREATE TABLE IF NOT EXISTS hostel_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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


-- 16. EVENTS


CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    CONSTRAINT chk_event_dates CHECK (end_date IS NULL OR end_date >= start_date),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_school_id ON events(school_id);


CREATE INDEX IF NOT EXISTS idx_events_dates ON events(start_date, end_date);

DROP TRIGGER IF EXISTS trg_events_updated ON events;
CREATE TRIGGER trg_events_updated
BEFORE UPDATE ON events
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


-- Remediation: Events RLS
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "View Events" ON events;
CREATE POLICY "View Events" ON events FOR SELECT
USING (
  (auth.role() = 'service_role') OR (
    events.school_id = auth_school_id() AND (
      is_public = true OR
      created_by = auth.uid() OR
      (target_audience = 'all' AND auth.role() = 'authenticated') OR
      (target_audience = 'staff' AND auth_has_role(ARRAY['admin', 'teacher', 'staff', 'accounts']))
    )
  )
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
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lms_courses_school_id ON lms_courses(school_id);


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
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lms_materials_school_id ON lms_materials(school_id);


CREATE INDEX IF NOT EXISTS idx_lms_materials_active ON lms_materials(id) WHERE deleted_at IS NULL;


CREATE INDEX IF NOT EXISTS idx_lms_materials_course ON lms_materials(course_id);

-- LMS material aggregate view counter (incremented when a student completes a video watch)
ALTER TABLE lms_materials ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;


-- 18. SEED DATA (PERMISSIONS, ROLES, ROLE-PERMISSIONS)
-- [MOVED TO seed_school_defaults()] All RBAC data is now auto-seeded per school.

-- ============================================================
-- 19. NOTIFICATION INFRASTRUCTURE
-- ============================================================

-- 19.1 User Devices (FCM Push Token Storage)
CREATE TABLE IF NOT EXISTS user_devices (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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


-- Idempotent column adds for existing deployments


-- 19.2 Notification Configuration (Kill Switch + Settings)
CREATE TABLE IF NOT EXISTS notification_config (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

-- Seed defaults
INSERT INTO notification_config (key, value)
SELECT v.key, v.value
FROM (VALUES
  ('kill_switch',              '{"global": false, "types": {}}'::jsonb),
  ('max_batch_size',           '{"value": 500}'::jsonb),
  ('fee_reminder_daily_limit', '{"value": 1}'::jsonb)
) AS v(key, value)
WHERE NOT EXISTS (
  SELECT 1 FROM notification_config nc WHERE nc.key = v.key
);

-- 19.3 Notification Logs (Delivery Audit Trail)
CREATE TABLE IF NOT EXISTS notification_logs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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


-- 19.4 Notification Batches (Bulk Send Tracking)
CREATE TABLE IF NOT EXISTS notification_batches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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


-- Idempotent column adds for existing deployments (merged from Section 20/21)


-- Constraints merged from Section 20/21


-- Enable Row Level Security (merged from Section 20/21)
ALTER TABLE notification_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_batches ENABLE ROW LEVEL SECURITY;

-- Views
DROP VIEW IF EXISTS active_students CASCADE; CREATE OR REPLACE VIEW active_students AS
SELECT * FROM students WHERE deleted_at IS NULL AND status_id IN (SELECT id FROM student_statuses WHERE code = 'ENROLLED');

DROP VIEW IF EXISTS active_persons CASCADE; CREATE OR REPLACE VIEW active_persons AS
SELECT * FROM persons WHERE deleted_at IS NULL;

-- END OF SCHEMA
-- ============================================================
-- HARDENING TRIGGERS (SAFETY GUARDS)
-- ============================================================

-- Guard 1: Prevent Direct Updates to amount_paid
-- Only allow updates via internal triggers (depth > 0)

DROP TRIGGER IF EXISTS trg_guard_fee_update ON student_fees;
CREATE TRIGGER trg_guard_fee_update
BEFORE UPDATE ON student_fees
FOR EACH ROW EXECUTE FUNCTION prevent_direct_fee_update();

-- Guard 2: Prevent Negative Balances
-- Redundant to logical check but good as constraint
ALTER TABLE student_fees 
DROP CONSTRAINT IF EXISTS chk_no_negative_paid;

ALTER TABLE IF EXISTS student_fees DROP CONSTRAINT IF EXISTS chk_no_negative_paid;
ALTER TABLE student_fees
ADD CONSTRAINT chk_no_negative_paid CHECK (amount_paid >= 0);

-- Guard 3: Prevent Overpayment (Paid > Due - Discount)
-- chk_paid_not_exceed is defined in the CREATE TABLE student_fees block (line ~827).
-- No standalone ALTER needed — constraint is already active.

-- Guard 4: Prevent Discount Exceeding Amount Due
ALTER TABLE student_fees
DROP CONSTRAINT IF EXISTS chk_discount_not_exceed_due;

ALTER TABLE IF EXISTS student_fees DROP CONSTRAINT IF EXISTS chk_discount_not_exceed_due;
ALTER TABLE student_fees
ADD CONSTRAINT chk_discount_not_exceed_due CHECK (discount <= amount_due);

-- (Removed Legacy Timetable Logic - See lines 1513+ for new implementation)
-- Function: promote_students_academic_year
-- Logic: Move students from current AY to next AY, incrementing class.


-- ============================================================
-- 19. TIMETABLE (NEW IMPLEMENTATION - timetable_slots)
-- ============================================================

-- Drop table to ensure clean slate if re-running
DROP TABLE IF EXISTS timetable_slots CASCADE;

-- Create Enum for Days


CREATE TABLE IF NOT EXISTS timetable_slots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
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
    
    CONSTRAINT chk_time_order CHECK (start_time < end_time),
    school_id INTEGER REFERENCES schools(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_timetable_slots_active 
ON timetable_slots (class_section_id, academic_year_id, day_of_week, period_number) 
WHERE deleted_at IS NULL;


CREATE INDEX IF NOT EXISTS idx_timetable_class ON timetable_slots(class_section_id);
CREATE INDEX IF NOT EXISTS idx_timetable_teacher ON timetable_slots(teacher_id);
CREATE INDEX IF NOT EXISTS idx_timetable_slots_time_check ON timetable_slots(teacher_id, start_time, end_time); -- Updated for collision detection

-- One-day substitutions decorate the permanent timetable for exactly one date.
-- They are not copied into timetable_slots, so the regular teacher resumes
-- automatically the following day while the substitution remains auditable.
CREATE TABLE IF NOT EXISTS timetable_substitutions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id      UUID NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
  substitution_date     DATE NOT NULL,
  timetable_slot_id     UUID NOT NULL REFERENCES timetable_slots(id) ON DELETE RESTRICT,
  period_number         SMALLINT NOT NULL CHECK (period_number > 0),
  absent_teacher_id     UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  substitute_teacher_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  reason                VARCHAR(500),
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_substitution_different_teachers
    CHECK (absent_teacher_id <> substitute_teacher_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_timetable_substitution_slot_date_active
  ON timetable_substitutions(school_id, substitution_date, timetable_slot_id)
  WHERE cancelled_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_timetable_substitute_period_date_active
  ON timetable_substitutions(school_id, substitution_date, substitute_teacher_id, period_number)
  WHERE cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_timetable_substitution_date
  ON timetable_substitutions(school_id, substitution_date);

CREATE INDEX IF NOT EXISTS idx_timetable_substitution_teacher_date
  ON timetable_substitutions(substitute_teacher_id, substitution_date)
  WHERE cancelled_at IS NULL;

DROP TRIGGER IF EXISTS trg_timetable_substitutions_updated ON timetable_substitutions;
CREATE TRIGGER trg_timetable_substitutions_updated
  BEFORE UPDATE ON timetable_substitutions
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

ALTER TABLE timetable_substitutions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Substitutions: read own school" ON timetable_substitutions;
CREATE POLICY "Substitutions: read own school"
  ON timetable_substitutions FOR SELECT
  USING (
    auth.role() = 'service_role'
    OR is_super_admin()
    OR school_id = auth_school_id()
  );

DROP POLICY IF EXISTS "Substitutions: admin manage own school" ON timetable_substitutions;
CREATE POLICY "Substitutions: admin manage own school"
  ON timetable_substitutions FOR ALL
  USING (
    auth.role() = 'service_role'
    OR is_super_admin()
    OR (school_id = auth_school_id() AND auth_has_role(ARRAY['admin', 'principal']))
  )
  WITH CHECK (
    auth.role() = 'service_role'
    OR is_super_admin()
    OR (school_id = auth_school_id() AND auth_has_role(ARRAY['admin', 'principal']))
  );


-- Financial & Course Performance Indexes
CREATE INDEX IF NOT EXISTS idx_complaints_assigned_to ON complaints(assigned_to);
CREATE INDEX IF NOT EXISTS idx_lms_courses_subject ON lms_courses(subject_id);
CREATE INDEX IF NOT EXISTS idx_lms_courses_instructor ON lms_courses(instructor_id);

-- Validation Trigger

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
CREATE POLICY "Students view own class timetable" ON timetable_slots FOR SELECT
USING (
    (auth.role() = 'service_role') OR (
      timetable_slots.school_id = auth_school_id()
      AND class_section_id IN (
          SELECT class_section_id 
          FROM student_enrollments 
          WHERE student_id IN (
              SELECT id FROM students WHERE person_id = (
                  SELECT person_id FROM users WHERE id = auth.uid() AND users.school_id = auth_school_id()
              ) AND students.school_id = auth_school_id()
          )
          AND status = 'active'
      )
    )
);

-- 2. Teachers: View OWN slots
DROP POLICY IF EXISTS "Teachers view own slots" ON timetable_slots;
CREATE POLICY "Teachers view own slots" ON timetable_slots FOR SELECT
USING (
    (auth.role() = 'service_role') OR (
      timetable_slots.school_id = auth_school_id()
      AND teacher_id IN (
          SELECT id FROM staff 
          WHERE person_id = (
              SELECT person_id FROM users WHERE id = auth.uid() AND users.school_id = auth_school_id()
          ) AND staff.school_id = auth_school_id()
      )
    )
);

-- 3. Admins: Full Access
DROP POLICY IF EXISTS "Admins full access" ON timetable_slots;
CREATE POLICY "Admins full access" ON timetable_slots FOR ALL
USING (
    (auth.role() = 'service_role') OR (
      timetable_slots.school_id = auth_school_id()
      AND EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND users.school_id = auth_school_id() AND EXISTS (
          SELECT 1 FROM user_roles ur 
          JOIN roles r ON ur.role_id = r.id 
          WHERE ur.user_id = users.id AND r.code = 'admin'
      ))
    )
);


-- ============================================================
-- NEXSYRUS TABS SCHEMA & AUTOMATION
-- ============================================================

-- 1. DISCIPLINE & CONDUCT
CREATE TABLE IF NOT EXISTS discipline_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    deleted_at TIMESTAMPTZ,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_discipline_school_id ON discipline_records(school_id);

CREATE INDEX IF NOT EXISTS idx_discipline_student ON discipline_records(student_id);


-- 2. MONEY SCIENCE
CREATE TABLE IF NOT EXISTS money_science_modules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    content_url text
);

CREATE INDEX IF NOT EXISTS idx_money_science_school_id ON money_science_modules(school_id);

CREATE TABLE IF NOT EXISTS student_money_science_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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


-- 3. SCIENCE PROJECTS
CREATE TABLE IF NOT EXISTS science_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    content_url TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_science_projects_school_id ON science_projects(school_id);

CREATE TABLE IF NOT EXISTS student_science_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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


-- 4. LIFE VALUES
CREATE TABLE IF NOT EXISTS life_values_modules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(200) NOT NULL,
    description TEXT,
    academic_year_id UUID REFERENCES academic_years(id), -- Optional: if content is specific to year
    
    -- Content Fields
    content_body TEXT,
    banner_image_url TEXT,
    quote_author VARCHAR(100),
    highlight_quote TEXT,
    content_url TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_life_values_modules_school_id ON life_values_modules(school_id);


-- RLS for Life Values
ALTER TABLE life_values_modules ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON life_values_modules TO authenticated;
DROP POLICY IF EXISTS "Enable read access for all" ON life_values_modules;
CREATE POLICY "Enable read access for all" ON life_values_modules FOR SELECT USING (
    (auth.role() = 'service_role') OR (
      life_values_modules.school_id = auth_school_id()
    )
);

CREATE TABLE IF NOT EXISTS student_life_values_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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


-- RLS for Life Values Progress
ALTER TABLE student_life_values_progress ENABLE ROW LEVEL SECURITY;
GRANT ALL ON student_life_values_progress TO authenticated;
DROP POLICY IF EXISTS "Allow all authenticated check" ON student_life_values_progress;
CREATE POLICY "Allow all authenticated check" ON student_life_values_progress FOR SELECT USING (
    (auth.role() = 'service_role') OR (
      student_life_values_progress.school_id = auth_school_id()
    )
);
DROP POLICY IF EXISTS "Students can view own progress" ON student_life_values_progress;
CREATE POLICY "Students can view own progress" ON student_life_values_progress FOR ALL USING (
    (auth.role() = 'service_role') OR (
      student_life_values_progress.school_id = auth_school_id()
      AND student_id IN (
          SELECT s.id FROM students s
          JOIN persons p ON s.person_id = p.id
          JOIN users u ON u.person_id = p.id
          WHERE u.id = auth.uid()
            AND u.school_id = auth_school_id()
            AND s.school_id = auth_school_id()
            AND p.school_id = auth_school_id()
      )
    )
);

-- 5. AUTOMATION: ENROLLMENT
DROP FUNCTION IF EXISTS ensure_student_enrollment(uuid);

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
DO $$ BEGIN ALTER VIEW debug_class_teachers SET (security_invoker = true); EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER VIEW debug_role_permissions SET (security_invoker = true); EXCEPTION WHEN others THEN NULL; END $$;

-- B. Enable RLS on ALL Tables
-- (Some are already enabled, re-running is safe / idempotent)

-- Enable RLS safely on all known tables (skips non-existent ones)
DO $$
DECLARE tbl TEXT;
DECLARE rls_tables TEXT[] := ARRAY[
  'genders', 'persons', 'countries', 'person_contacts',
  'receipt_items', 'marks', 'discipline_records',
  'student_money_science_progress', 'student_science_projects',
  'roles', 'role_permissions', 'permissions',
  'students', 'student_categories', 'religions',
  'classes', 'class_sections', 'sections',
  'staff_designations', 'staff_statuses',
  'daily_attendance', 'staff',
  'fee_structures', 'student_fees', 'class_subjects', 'subjects',
  'fee_types', 'fee_transactions', 'receipts',
  'exams', 'exam_subjects', 'grading_scales',
  'complaints', 'leave_applications', 'diary_entries',
  'periods', 'transport_routes', 'transport_stops', 'buses',
  'student_transport', 'bus_locations',
  'hostel_blocks', 'hostel_rooms', 'hostel_allocations',
  'lms_courses', 'money_science_modules', 'science_projects',
  'audit_logs', 'user_roles', 'users', 'blood_groups',
  'student_statuses', 'parents', 'student_parents',
  'relationship_types', 'academic_years', 'student_enrollments',
  'lms_materials'
];
BEGIN
  FOREACH tbl IN ARRAY rls_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = tbl) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    END IF;
  END LOOP;
END $$;

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

/* ALTER FUNCTION loop removed because it fails on overloaded functions */

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
    created_by UUID NOT NULL REFERENCES users(id), -- Fixed: was auth.users(id) (Fix 6)
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,  
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid')),
    description TEXT, -- Optional description
    receipt_url TEXT, -- Optional receipt image
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    approved_by UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_expenses_school_id ON expenses(school_id);


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
CREATE POLICY "View own school expenses" ON expenses FOR SELECT
USING (
    (auth.role() = 'service_role') OR (
      expenses.school_id = auth_school_id() AND (
        created_by = auth.uid() OR
        EXISTS (
            SELECT 1 FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = auth.uid() 
              AND (r.code IN ('admin', 'principal', 'accounts'))
        )
      )
    )
);

-- 4.2 INSERT: Authenticated users can create expenses
DROP POLICY IF EXISTS "Create expenses" ON expenses;
CREATE POLICY "Create expenses" ON expenses FOR INSERT
WITH CHECK (
    (auth.role() = 'service_role') OR (
      auth.role() = 'authenticated' AND
      expenses.school_id = auth_school_id() AND
      created_by = auth.uid() 
    )
);

-- 4.3 UPDATE: Creator wins pending, Admins win all
DROP POLICY IF EXISTS "Update expenses" ON expenses;
CREATE POLICY "Update expenses" ON expenses FOR UPDATE
USING (
    (auth.role() = 'service_role') OR (
      expenses.school_id = auth_school_id() AND (
        (created_by = auth.uid() AND status = 'pending') OR
        EXISTS (
            SELECT 1 FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = auth.uid() 
              AND (r.code IN ('admin', 'principal', 'accounts'))
        )
      )
    )
);

-- 4.4 DELETE: Only Creator (if pending) or Admin
DROP POLICY IF EXISTS "Delete expenses" ON expenses;
CREATE POLICY "Delete expenses" ON expenses FOR DELETE
USING (
    (auth.role() = 'service_role') OR (
      expenses.school_id = auth_school_id() AND (
        (created_by = auth.uid() AND status = 'pending') OR
        EXISTS (
            SELECT 1 FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = auth.uid() 
              AND (r.code IN ('admin', 'principal', 'accounts'))
        )
      )
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


-- 13. STAFF PAYROLL (New Additions)


CREATE TABLE IF NOT EXISTS staff_payroll (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    base_salary DECIMAL(12,2) NOT NULL,
    bonus DECIMAL(12,2) DEFAULT 0,
    salary_adjustment DECIMAL(12,2) NOT NULL DEFAULT 0,
    deductions DECIMAL(12,2) DEFAULT 0,
    net_salary DECIMAL(12,2) NOT NULL, -- Application value: base + bonus + salary_adjustment - deductions
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

ALTER TABLE staff_payroll ADD COLUMN IF NOT EXISTS salary_adjustment DECIMAL(12,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_staff_payroll_school_id ON staff_payroll(school_id);

CREATE INDEX IF NOT EXISTS idx_payroll_staff ON staff_payroll(staff_id);
CREATE INDEX IF NOT EXISTS idx_payroll_period ON staff_payroll(payroll_month, payroll_year);

DROP TRIGGER IF EXISTS trg_staff_payroll_updated ON staff_payroll;
CREATE TRIGGER trg_staff_payroll_updated
BEFORE UPDATE ON staff_payroll
FOR EACH ROW EXECUTE FUNCTION update_timestamp();


-- GENERATOR FUNCTION (Idempotent)

-- SALARY DEDUCTION LOGIC


DROP TRIGGER IF EXISTS trg_staff_attendance_payroll ON staff_attendance;
CREATE TRIGGER trg_staff_attendance_payroll
AFTER INSERT OR UPDATE OR DELETE ON staff_attendance
FOR EACH ROW EXECUTE FUNCTION trg_recalc_payroll_on_attendance();


DROP TRIGGER IF EXISTS trg_leave_payroll ON leave_applications;
CREATE TRIGGER trg_leave_payroll
AFTER INSERT OR UPDATE ON leave_applications
FOR EACH ROW EXECUTE FUNCTION trg_recalc_payroll_on_leave();

-- RLS POLICIES
ALTER TABLE staff_payroll ENABLE ROW LEVEL SECURITY;

-- Allow admins and accounts to do everything
DROP POLICY IF EXISTS "Admins can manage payroll" ON staff_payroll;
DROP POLICY IF EXISTS "Admins and Accounts can manage payroll" ON staff_payroll;
CREATE POLICY "Admins and Accounts can manage payroll" ON staff_payroll FOR ALL
USING (
  (auth.role() = 'service_role') OR (
    staff_payroll.school_id = auth_school_id()
    AND EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = auth.uid() AND r.code IN ('admin', 'accounts')
    )
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
CREATE POLICY "Staff can view own payroll" ON staff_payroll FOR SELECT
USING (
  (auth.role() = 'service_role') OR (
    staff_payroll.school_id = auth_school_id()
    AND staff_id IN (
      SELECT id FROM staff WHERE person_id IN (
          SELECT person_id FROM users WHERE id = auth.uid() AND users.school_id = auth_school_id()
      ) AND staff.school_id = auth_school_id()
    )
  )
);

-- =========================================================
-- FINANCIAL POLICY & CONTROL LAYER (AUTO-APPENDED)
-- =========================================================


-- 1. Financial Audit Logs (For destructive actions)
CREATE TABLE IF NOT EXISTS financial_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL, -- Storing as text to support various ID types
    action_type TEXT NOT NULL CHECK (action_type IN ('DELETE', 'UPDATE', 'CREATE')),
    old_data JSONB, -- The state before deletion/update
    new_data JSONB, -- The state after update/creation
    reason TEXT, -- Mandatory for deletions
    performed_by UUID REFERENCES auth.users(id),
    performed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB, -- Extra context (user agent, IP, etc if available)
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_financial_audit_school_id ON financial_audit_logs(school_id);


-- Enable RLS on Audit Logs
ALTER TABLE financial_audit_logs ENABLE ROW LEVEL SECURITY;

-- Admin can view all logs
DROP POLICY IF EXISTS "Admins can view financial audit logs" ON financial_audit_logs;
CREATE POLICY "Admins can view financial audit logs" ON financial_audit_logs FOR SELECT 
TO authenticated 
USING (
    (auth.role() = 'service_role') OR (
      financial_audit_logs.school_id = auth_school_id()
      AND EXISTS (
          SELECT 1 FROM user_roles ur
          JOIN roles r ON ur.role_id = r.id
          WHERE ur.user_id = auth.uid() AND r.code = 'admin'
      )
    )
);

-- Only service_role (and SECURITY DEFINER functions running as owner) can insert
DROP POLICY IF EXISTS "System can insert audit logs" ON financial_audit_logs;
CREATE POLICY "System can insert audit logs" ON financial_audit_logs FOR INSERT 
TO service_role 
WITH CHECK (true);

-- 2. Financial Policy Rules (Limits, Permissions, Locks)
CREATE TABLE IF NOT EXISTS financial_policy_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
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


-- Enable RLS
ALTER TABLE financial_policy_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read financial policies" ON financial_policy_rules;
CREATE POLICY "Authenticated users can read financial policies" ON financial_policy_rules FOR SELECT 
TO authenticated 
USING (
    (auth.role() = 'service_role') OR (
      financial_policy_rules.school_id = auth_school_id()
    )
);

DROP POLICY IF EXISTS "Admins can update financial policies" ON financial_policy_rules;
CREATE POLICY "Admins can update financial policies" ON financial_policy_rules FOR UPDATE 
TO authenticated 
USING (
    (auth.role() = 'service_role') OR (
      financial_policy_rules.school_id = auth_school_id()
      AND EXISTS (
          SELECT 1 FROM user_roles ur
          JOIN roles r ON ur.role_id = r.id
          WHERE ur.user_id = auth.uid() AND r.code = 'admin'
      )
    )
)
WITH CHECK (
    (auth.role() = 'service_role') OR (
      financial_policy_rules.school_id = auth_school_id()
      AND EXISTS (
          SELECT 1 FROM user_roles ur
          JOIN roles r ON ur.role_id = r.id
          WHERE ur.user_id = auth.uid() AND r.code = 'admin'
      )
    )
);

-- Seed Default Policies
-- [MOVED TO seed_school_defaults()] Financial policies are now auto-seeded per school.

-- 3. Audit Log Trigger Function

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

-- 6. Helper: Check Financial Permission & Limits

-- 7. Helper: Enforce Locks

-- 8. Triggers for Active Enforcement

DROP TRIGGER IF EXISTS enforce_expense_policy ON expenses;
CREATE TRIGGER enforce_expense_policy BEFORE INSERT OR UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION trg_check_expense_policy();


DROP TRIGGER IF EXISTS enforce_fee_cash_limit ON fee_transactions;
CREATE TRIGGER enforce_fee_cash_limit BEFORE INSERT ON fee_transactions FOR EACH ROW EXECUTE FUNCTION trg_check_fee_cash_limit();

-- 9. Generic Deletion RPC with Reason

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

-- 1. FINANCIAL ANALYTICS
-- Returns: total_collected, pending_dues, collection_efficiency, trends (json)

-- 2. ATTENDANCE ANALYTICS

-- 3. AUTOMATED INSIGHTS
-- Generates text-based insights based on patterns.


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

-- Prevent double fee assignment for the same structure to the same student.
-- Partial index: soft-deleted rows must not block fee-mode repointing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_student_fees_unique_assignment 
ON student_fees(student_id, fee_structure_id)
WHERE deleted_at IS NULL;

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
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    school_id INTEGER REFERENCES schools(id)
);


-- Phase 2 will backfill + enforce NOT NULL

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_date ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_request_id ON audit_logs(request_id);

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON public.audit_logs USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON public.audit_logs USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON public.audit_logs USING btree (entity, entity_id);


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

-- Phase 4 will introduce RLS (intentionally omitted here).

-- SECTION 14: NOTIFICATIONS & DEVICES
-- ============================================================

-- ============================================================
-- 103. DEBUG UTILITIES (Production Diagnostics)
-- ============================================================

-- Function to check a user's permissions

-- Advanced Diagnostic: Teacher Profile & Timetable Check

-- CORE AUDIT: Data Integrity Check

-- CORE REPAIR: Data Integrity Recovery

-- View to see assigned Class Teachers
DROP VIEW IF EXISTS debug_class_teachers CASCADE; CREATE OR REPLACE VIEW debug_class_teachers AS
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
DROP VIEW IF EXISTS debug_role_permissions CASCADE; CREATE OR REPLACE VIEW debug_role_permissions AS
SELECT 
    r.code as role,
    STRING_AGG(p.code, ', ') as permissions
FROM roles r
LEFT JOIN role_permissions rp ON r.id = rp.role_id
LEFT JOIN permissions p ON rp.permission_id = p.id
GROUP BY r.code;

-- CORE INTEGRITY GUARD: Central Diagnostic Toolkit

-- ============================================================
-- UTILITIES & MAINTENANCE
-- ============================================================

-- Function to recalculate fee ledger from transactions (Fix for double-counting)

-- Session-level search path (ALTER DATABASE removed — non-transactional DDL)
SET search_path = public, extensions;

-- ============================================================
-- NOTIFICATION SYSTEM (Production Hardened)
-- ============================================================


-- 1. Notification Templates
CREATE TABLE IF NOT EXISTS notification_templates (
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type VARCHAR(100),
    channel notification_channel NOT NULL,
    is_enabled BOOLEAN DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (school_id, user_id, event_type, channel)
);
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;


-- 3. Notification Events
CREATE TABLE IF NOT EXISTS notification_events (
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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


-- 4. Notifications
CREATE TABLE IF NOT EXISTS notifications (
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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


-- 5. Notification Deliveries
CREATE TABLE IF NOT EXISTS notification_deliveries (
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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


-- 6. Notification Audit Logs
CREATE TABLE IF NOT EXISTS notification_audit_logs (
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id UUID REFERENCES notification_deliveries(id),
    notification_id UUID REFERENCES notifications(id),
    action VARCHAR(50) NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);


-- Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_notifications_unread_fetch
ON notifications (user_id, created_at DESC)
WHERE status IN ('PENDING', 'DELIVERED');

-- Phase 4a: per-account unread-count badges (POST /notifications/unread-counts).
-- Supports COUNT(*) WHERE user_id = ? AND school_id = ? AND read_at IS NULL AND
-- deleted_at IS NULL. Distinct from idx_notifications_unread_fetch above, whose
-- partial predicate is status-based and therefore cannot serve a read_at-based
-- count. Additive + IF NOT EXISTS (production-safe, no row/query impact).
CREATE INDEX IF NOT EXISTS idx_notifications_unread_count
ON notifications (user_id, school_id)
WHERE read_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_deliveries_worker_fetch 
ON notification_deliveries (next_retry_at) 
WHERE status = 'FAILED' AND retry_count < 5;

CREATE INDEX IF NOT EXISTS idx_events_idempotency ON notification_events(idempotency_key);

-- ============================================================
-- RECENT DDL PATCHES (Drivers, RLS, Timetables)
-- ============================================================

-- From apply_phase5_db.js
ALTER TABLE public.bus_locations 
  ADD COLUMN IF NOT EXISTS is_mocked boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_suspicious boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_bus_locations_bus_id ON public.bus_locations (bus_id);
CREATE INDEX IF NOT EXISTS idx_bus_locations_recorded_at ON public.bus_locations (recorded_at DESC);
-- (bus_trip_history index moved after table definition below)
DROP POLICY IF EXISTS "Users can read own person" ON public.persons;
CREATE POLICY "Users can read own person" ON public.persons
FOR SELECT USING (
  (auth.role() = 'service_role') OR (
    public.persons.school_id = auth_school_id()
    AND id IN (
      SELECT person_id FROM public.users
      WHERE public.users.id = auth.uid()
        AND public.users.school_id = auth_school_id()
    )
  )
);

ALTER TABLE IF EXISTS public.staff ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can read own staff record" ON public.staff;
CREATE POLICY "Users can read own staff record" ON public.staff
FOR SELECT USING (
  (auth.role() = 'service_role') OR (
    public.staff.school_id = auth_school_id()
    AND person_id IN (
      SELECT person_id FROM public.users
      WHERE public.users.id = auth.uid()
        AND public.users.school_id = auth_school_id()
    )
  )
);


-- From fix_trigger.js


-- From migrate_timetable.js


DROP INDEX IF EXISTS uq_timetable_slots_active;
DROP INDEX IF EXISTS idx_timetable_slots_time_check;

-- Per-day uniqueness: include day_of_week so the same period can carry
-- different content on different weekdays (per_day mode). Existing rows
-- are all 'monday', so this stays valid for uniform-mode schools.
CREATE UNIQUE INDEX IF NOT EXISTS uq_timetable_slots_active
ON timetable_slots (class_section_id, academic_year_id, day_of_week, period_number)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_timetable_class ON timetable_slots(class_section_id);
CREATE INDEX IF NOT EXISTS idx_timetable_teacher ON timetable_slots(teacher_id);
CREATE INDEX IF NOT EXISTS idx_timetable_slots_time_check ON timetable_slots(teacher_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_timetable_slots_section_day
  ON timetable_slots (class_section_id, academic_year_id, day_of_week)
  WHERE deleted_at IS NULL;


-- ==========================================
-- 30. SCHOOL SETTINGS & CONFIG
-- ========================================== 
CREATE TABLE IF NOT EXISTS school_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    key         VARCHAR(100) NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now(),
    UNIQUE (school_id, key)
);

-- Key/value config per school. Common keys: branding (school_name, …), hours, etc.
-- UPI fee collection (Collect fee via UPI / QR): managed by API PUT /api/v1/settings/upi
--   upi_id            — VPA, e.g. schoolname@okaxis
--   upi_display_name  — account holder / payee name shown in UPI apps (pn parameter)

-- [MOVED TO seed_school_defaults()] School settings are now auto-seeded per school.
-- UPI settings (upi_id, upi_display_name) should be configured per-school via the admin API.

CREATE TABLE IF NOT EXISTS admin_notifications (
    id          SERIAL PRIMARY KEY,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    type        VARCHAR(50) NOT NULL,
    message     TEXT NOT NULL,
    user_id     UUID,
    ip_address  VARCHAR(45),
    created_at  TIMESTAMPTZ DEFAULT now()
);


-- ========================================== 
-- -----------------------------------------------------
-- NEW POLICIES: SuperAdmin complete access to Content
-- -----------------------------------------------------

DROP POLICY IF EXISTS "Superadmin full access" ON public.money_science_modules;
CREATE POLICY "Superadmin full access" ON public.money_science_modules
    FOR ALL
    USING (
        (auth.jwt() ->> 'role'::text) = 'service_role'::text OR 
        (auth.jwt() ->> 'role'::text) = 'superadmin'::text
    )
    WITH CHECK (
        (auth.jwt() ->> 'role'::text) = 'service_role'::text OR 
        (auth.jwt() ->> 'role'::text) = 'superadmin'::text
    );

DROP POLICY IF EXISTS "Superadmin full access" ON public.life_values_modules;
CREATE POLICY "Superadmin full access" ON public.life_values_modules
    FOR ALL
    USING (
        (auth.jwt() ->> 'role'::text) = 'service_role'::text OR 
        (auth.jwt() ->> 'role'::text) = 'superadmin'::text
    )
    WITH CHECK (
        (auth.jwt() ->> 'role'::text) = 'service_role'::text OR 
        (auth.jwt() ->> 'role'::text) = 'superadmin'::text
    );

DROP POLICY IF EXISTS "Superadmin full access" ON public.science_projects;
CREATE POLICY "Superadmin full access" ON public.science_projects
    FOR ALL
    USING (
        (auth.jwt() ->> 'role'::text) = 'service_role'::text OR 
        (auth.jwt() ->> 'role'::text) = 'superadmin'::text
    )
    WITH CHECK (
        (auth.jwt() ->> 'role'::text) = 'service_role'::text OR 
        (auth.jwt() ->> 'role'::text) = 'superadmin'::text
    );
-- ========================================== 
-- 31. OUT-OF-HOURS ACCESS CONTROL
-- ========================================== 
CREATE TABLE IF NOT EXISTS access_requests (
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by UUID REFERENCES users(id) ON DELETE CASCADE,
    department TEXT NOT NULL,
    request_note TEXT,
    status TEXT DEFAULT 'pending' NOT NULL,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS temp_access_grants (
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    department TEXT NOT NULL,
    granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    requested_by UUID REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN DEFAULT true NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);


CREATE INDEX IF NOT EXISTS idx_temp_access_lookup ON temp_access_grants(requested_by, department) WHERE is_active = true;

ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE temp_access_grants ENABLE ROW LEVEL SECURITY;

GRANT ALL ON access_requests TO authenticated, service_role;
GRANT ALL ON temp_access_grants TO authenticated, service_role;

DROP POLICY IF EXISTS "Users can view their own requests" ON access_requests;
CREATE POLICY "Users can view their own requests" ON access_requests FOR SELECT 
USING ((auth.role() = 'service_role') OR (school_id = auth_school_id() AND requested_by = auth.uid()));

DROP POLICY IF EXISTS "Users can insert their own requests" ON access_requests;
CREATE POLICY "Users can insert their own requests" ON access_requests FOR INSERT 
WITH CHECK ((auth.role() = 'service_role') OR (school_id = auth_school_id() AND requested_by = auth.uid()));

DROP POLICY IF EXISTS "Users can view their own grants" ON temp_access_grants;
CREATE POLICY "Users can view their own grants" ON temp_access_grants FOR SELECT 
USING ((auth.role() = 'service_role') OR (school_id = auth_school_id() AND requested_by = auth.uid()));


DROP POLICY IF EXISTS "Admins can view all requests" ON access_requests;
CREATE POLICY "Admins can view all requests" ON access_requests FOR SELECT 
USING ((auth.role() = 'service_role') OR (school_id = auth_school_id() AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.user_id = auth.uid() AND r.code = 'admin')));

DROP POLICY IF EXISTS "Admins can update requests" ON access_requests;
CREATE POLICY "Admins can update requests" ON access_requests FOR UPDATE 
USING ((auth.role() = 'service_role') OR (school_id = auth_school_id() AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.user_id = auth.uid() AND r.code = 'admin')));

DROP POLICY IF EXISTS "Admins can view all grants" ON temp_access_grants;
CREATE POLICY "Admins can view all grants" ON temp_access_grants FOR SELECT 
USING ((auth.role() = 'service_role') OR (school_id = auth_school_id() AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.user_id = auth.uid() AND r.code = 'admin')));

DROP POLICY IF EXISTS "Admins can insert grants" ON temp_access_grants;
CREATE POLICY "Admins can insert grants" ON temp_access_grants FOR INSERT 
WITH CHECK ((auth.role() = 'service_role') OR (school_id = auth_school_id() AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.user_id = auth.uid() AND r.code = 'admin')));

DROP POLICY IF EXISTS "Admins can update grants" ON temp_access_grants;
CREATE POLICY "Admins can update grants" ON temp_access_grants FOR UPDATE 
USING ((auth.role() = 'service_role') OR (school_id = auth_school_id() AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.user_id = auth.uid() AND r.code = 'admin')));



-- (indexes for bus_trip_history, driver_devices, driver_heartbeat, feature_flags, timetable_entries
--  are created after their respective CREATE TABLE definitions below)


-- ### INJECTED MISSING FUNCTIONS ###


-- Policies for staff_attendance


-- Policies for timetable_entries


-- ======================================
-- ### INJECTED MISSING TABLES ###
-- ======================================


CREATE TABLE IF NOT EXISTS bus_trip_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  bus_id uuid NOT NULL,
  latitude double precision,
  longitude double precision,
  speed double precision,
  heading double precision,
  is_mocked boolean DEFAULT false,
  is_suspicious boolean DEFAULT false,
  recorded_at timestamp with time zone DEFAULT now(),
  CONSTRAINT bus_trip_history_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_bus_trip_history_bus_id_time ON bus_trip_history (bus_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_bus_trip_history_school_id ON bus_trip_history (school_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bus_trip_history_bus_recorded_at ON bus_trip_history (bus_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_bus_trip_history_school_recorded_at ON bus_trip_history (school_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_bus_locations_school_bus_recorded
  ON bus_locations (school_id, bus_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_route_stop_geo_school_route_leg_stop
  ON route_stop_geo (school_id, route_id, trip_direction, stop_id);
CREATE INDEX IF NOT EXISTS idx_route_segment_time_school_route_leg_endpoints
  ON route_segment_time (school_id, route_id, trip_direction, from_stop_id, to_stop_id);

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
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  device_id character varying NOT NULL,
  last_active timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT driver_devices_pkey PRIMARY KEY (school_id, driver_id)
);

CREATE TABLE IF NOT EXISTS driver_heartbeat (
  driver_id uuid NOT NULL,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  last_ping timestamp with time zone DEFAULT now(),
  status character varying DEFAULT 'online'::character varying,
  CONSTRAINT driver_heartbeat_pkey PRIMARY KEY (school_id, driver_id)
);

CREATE TABLE IF NOT EXISTS feature_flags (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  code character varying(100) NOT NULL,
  name character varying(200) NOT NULL,
  description text,
  is_enabled boolean NOT NULL DEFAULT false,
  target_roles text[],
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT feature_flags_pkey PRIMARY KEY (id),
  CONSTRAINT feature_flags_code_key UNIQUE (code) -- TODO: VERIFY
);

CREATE TABLE IF NOT EXISTS timetable_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_section_id uuid NOT NULL,
  subject_id uuid,
  teacher_id uuid,
  period_id uuid NOT NULL,
  day_of_week day_of_week_enum NOT NULL,
  room character varying(50),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT timetable_entries_pkey PRIMARY KEY (id),
  CONSTRAINT timetable_entries_class_section_id_period_id_day_of_week_key UNIQUE (school_id, class_section_id, period_id, day_of_week),
  CONSTRAINT timetable_entries_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES class_sections(id),
  CONSTRAINT timetable_entries_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES subjects(id),
  CONSTRAINT timetable_entries_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES staff(id),
  CONSTRAINT timetable_entries_period_id_fkey FOREIGN KEY (period_id) REFERENCES periods(id)
);

CREATE TABLE IF NOT EXISTS ui_route_permissions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  route_key character varying(100) NOT NULL,
  route_label character varying(200) NOT NULL,
  required_permissions text[] NOT NULL DEFAULT '{}'::text[],
  required_roles text[],
  requires_feature_flag character varying(100),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT ui_route_permissions_pkey PRIMARY KEY (id),
  CONSTRAINT ui_route_permissions_route_key_key UNIQUE (school_id, route_key) -- TODO: VERIFY
);

-- Indexes and triggers for feature_flags
DROP TRIGGER IF EXISTS trg_feature_flags_updated ON feature_flags;
CREATE TRIGGER trg_feature_flags_updated
BEFORE UPDATE ON feature_flags
FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Indexes and triggers for timetable_entries
CREATE UNIQUE INDEX IF NOT EXISTS timetable_entries_class_period_day_key ON public.timetable_entries USING btree (class_section_id, period_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_timetable_class ON public.timetable_entries USING btree (class_section_id);
CREATE INDEX IF NOT EXISTS idx_timetable_teacher ON public.timetable_entries USING btree (teacher_id);

DROP TRIGGER IF EXISTS trg_timetable_updated ON timetable_entries;
CREATE TRIGGER trg_timetable_updated
BEFORE UPDATE ON timetable_entries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_validate_timetable ON timetable_entries;
CREATE TRIGGER trg_validate_timetable
BEFORE INSERT ON timetable_entries
FOR EACH ROW EXECUTE FUNCTION validate_timetable_entry();


-- ═══════════════════════════════════════════════════════════
-- SCHEMA SYNC: Missing columns from live database
-- ═══════════════════════════════════════════════════════════


-- ALTER TABLE IF EXISTS active_students ADD COLUMN IF NOT EXISTS school_id uuid;
ALTER TABLE IF EXISTS public.business_units ADD COLUMN IF NOT EXISTS subscription_price numeric;
ALTER TABLE IF EXISTS public.business_units ADD COLUMN IF NOT EXISTS subscription_plan text;
ALTER TABLE IF EXISTS public.business_units ADD COLUMN IF NOT EXISTS phone text;


-- ═══════════════════════════════════════════════════════════
-- SCHEMA SYNC: Missing constraints from live database
-- ═══════════════════════════════════════════════════════════


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
ALTER TABLE IF EXISTS driver_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS driver_heartbeat ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS bus_trip_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS feature_flags ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE IF EXISTS active_students ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE IF EXISTS active_persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ui_route_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS school_settings ENABLE ROW LEVEL SECURITY;


-- [SYNC MEDIUM] Enable RLS on remaining tables (safe: checks existence via pg_tables)
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('schema_meta', 'spatial_ref_sys', 'super_admins')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
  END LOOP;
END $$;

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE IF EXISTS staff_attendance DROP CONSTRAINT IF EXISTS chk_staff_attendance_date_past;
ALTER TABLE staff_attendance ADD CONSTRAINT chk_staff_attendance_date_past CHECK (attendance_date <= current_date) NOT VALID;

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE IF EXISTS fee_transactions DROP CONSTRAINT IF EXISTS chk_refund_must_be_negative;
ALTER TABLE fee_transactions ADD CONSTRAINT chk_refund_must_be_negative CHECK (refund_of IS NULL OR amount < 0) NOT VALID;

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE IF EXISTS diary_entries DROP CONSTRAINT IF EXISTS chk_homework_due_date;
ALTER TABLE diary_entries ADD CONSTRAINT chk_homework_due_date CHECK (homework_due_date IS NULL OR homework_due_date >= entry_date);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE IF EXISTS buses DROP CONSTRAINT IF EXISTS chk_bus_capacity;
ALTER TABLE buses ADD CONSTRAINT chk_bus_capacity CHECK (capacity > 0);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE IF EXISTS events DROP CONSTRAINT IF EXISTS chk_event_dates;
ALTER TABLE events ADD CONSTRAINT chk_event_dates CHECK (end_date IS NULL OR end_date >= start_date);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE IF EXISTS notification_batches DROP CONSTRAINT IF EXISTS chk_notification_batches_type;
ALTER TABLE notification_batches ADD CONSTRAINT chk_notification_batches_type CHECK (type IN ('FEES', 'GENERAL', 'EXAM', 'EMERGENCY', 'DIARY', 'RESULTS', 'NOTICE', 'TEST_TRIGGER'));

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE IF EXISTS student_fees DROP CONSTRAINT IF EXISTS chk_discount_not_exceed_due;
ALTER TABLE student_fees ADD CONSTRAINT chk_discount_not_exceed_due CHECK (discount <= amount_due) NOT VALID;

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE IF EXISTS events DROP CONSTRAINT IF EXISTS chk_event_dates;
ALTER TABLE events ADD CONSTRAINT chk_event_dates CHECK (end_date IS NULL OR end_date >= start_date);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE IF EXISTS student_fees DROP CONSTRAINT IF EXISTS chk_discount_not_exceed_due;
ALTER TABLE student_fees ADD CONSTRAINT chk_discount_not_exceed_due CHECK (discount <= amount_due) NOT VALID;

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE IF EXISTS staff_attendance DROP CONSTRAINT IF EXISTS chk_staff_attendance_date_past;
ALTER TABLE staff_attendance ADD CONSTRAINT chk_staff_attendance_date_past CHECK (attendance_date <= current_date) NOT VALID;

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE IF EXISTS fee_transactions DROP CONSTRAINT IF EXISTS chk_refund_must_be_negative;
ALTER TABLE fee_transactions ADD CONSTRAINT chk_refund_must_be_negative CHECK (refund_of IS NULL OR amount < 0) NOT VALID;

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE IF EXISTS diary_entries DROP CONSTRAINT IF EXISTS chk_homework_due_date;
ALTER TABLE diary_entries ADD CONSTRAINT chk_homework_due_date CHECK (homework_due_date IS NULL OR homework_due_date >= entry_date);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE IF EXISTS buses DROP CONSTRAINT IF EXISTS chk_bus_capacity;
ALTER TABLE buses ADD CONSTRAINT chk_bus_capacity CHECK (capacity > 0);

-- [SYNC MEDIUM] Constraint in schema.sql missing from live DB
ALTER TABLE IF EXISTS notification_batches DROP CONSTRAINT IF EXISTS chk_notification_batches_type;
ALTER TABLE notification_batches ADD CONSTRAINT chk_notification_batches_type CHECK (type IN ('FEES', 'GENERAL', 'EXAM', 'EMERGENCY', 'ATTENDANCE', 'CUSTOM', 'DIARY', 'RESULTS', 'NOTICE', 'TEST_TRIGGER')) NOT VALID;

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
DROP VIEW IF EXISTS fee_installments CASCADE; CREATE OR REPLACE VIEW fee_installments AS SELECT 
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


-- ════════════════════════════════════════════════════════════════════════════════
-- SUPER ADMINS
-- ════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS super_admins (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL UNIQUE,
  full_name   TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES super_admins(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login  TIMESTAMPTZ
);

ALTER TABLE super_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE super_admins FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION update_super_admin_last_login(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE super_admins SET last_login = now() WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM super_admins
    WHERE id = auth.uid()
      AND is_active = true
  );
$$;

GRANT EXECUTE ON FUNCTION is_super_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION update_super_admin_last_login(UUID) TO service_role;

-- ════════════════════════════════════════════════════════════════════════════════
-- MULTITENANCY HARDENING BLOCK (Production Enforcement)
-- Applied: Adds FORCE RLS, missing tenant-scoped policies, safe defaults.
-- ════════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────
-- 1. FORCE ROW LEVEL SECURITY on all tenant tables
--    Prevents table-owner (postgres) from bypassing RLS,
--    ensuring SECURITY DEFINER functions also obey policies.
-- ─────────────────────────────────────────────────────────
DO $$ 
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN 
    SELECT tablename FROM pg_tables 
    WHERE schemaname = 'public' 
      AND tablename NOT IN ('schema_meta', 'spatial_ref_sys', 'super_admins')
  LOOP
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────
-- 2. RLS + policy on schools table itself
-- ─────────────────────────────────────────────────────────
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Super admin and tenant school read" ON schools;
CREATE POLICY "Super admin and tenant school read" ON schools FOR SELECT
USING (
  (auth.role() = 'service_role')
  OR is_super_admin()
  OR (id = auth_school_id())
);

DROP POLICY IF EXISTS "Super admin manages schools" ON schools;
CREATE POLICY "Super admin manages schools" ON schools FOR ALL
USING (
  (auth.role() = 'service_role')
  OR is_super_admin()
)
WITH CHECK (
  (auth.role() = 'service_role')
  OR is_super_admin()
);

-- ─────────────────────────────────────────────────────────
-- 0. Cleanup stale policies from tables without school_id
-- ─────────────────────────────────────────────────────────
DO $$ 
DECLARE 
  tbl TEXT;
  bad_policies TEXT[] := ARRAY['Tenant isolation: read own school', 'Tenant isolation: admin manage own school'];
  pol TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['notification_config', 'student_statuses', 'staff_statuses'])
  LOOP
    FOREACH pol IN ARRAY bad_policies LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol, tbl);
    END LOOP;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────
-- 3. Global Read policies for reference tables
--    These are shared across all schools (no school_id).
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE ref_tables TEXT[] := ARRAY[
  'genders', 'religions', 'blood_groups', 'relationship_types', 
  'countries', 'student_categories', 'notification_config', 'student_statuses', 'staff_statuses'
];
tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ref_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = tbl) THEN
      EXECUTE format(
        'DROP POLICY IF EXISTS "Global read" ON public.%I; '
        'CREATE POLICY "Global read" ON public.%I FOR SELECT USING (true)',
        tbl, tbl
      );
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────
-- 4. Tenant-scoped default policies for tables that
--    currently have RLS enabled but ZERO policies
--    (they were silently deny-all, now explicitly scoped).
--
--    Pattern: authenticated users see rows matching their
--    school. service_role bypasses. Admin roles get full
--    CRUD within their school.
-- ─────────────────────────────────────────────────────────

-- Helper: reusable tenant-scoped admin policy creator
CREATE OR REPLACE FUNCTION _create_tenant_policies(p_table TEXT)
RETURNS VOID AS $_mt$
BEGIN
  IF p_table = 'super_admins' THEN
    RAISE NOTICE '_create_tenant_policies: skipping % — platform authority table', p_table;
    RETURN;
  END IF;

  -- Guard: skip if table has no school_id column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = p_table
      AND column_name = 'school_id'
  ) THEN
    RAISE NOTICE '_create_tenant_policies: skipping % — no school_id column', p_table;
    RETURN;
  END IF;

  EXECUTE format(
    'DROP POLICY IF EXISTS "Tenant isolation: read own school" ON public.%I; '
    'CREATE POLICY "Tenant isolation: read own school" ON public.%I FOR SELECT '
    'USING ((auth.role() = ''service_role'') OR is_super_admin() OR (school_id = auth_school_id()))',
    p_table, p_table
  );
  EXECUTE format(
    'DROP POLICY IF EXISTS "Tenant isolation: admin manage own school" ON public.%I; '
    'CREATE POLICY "Tenant isolation: admin manage own school" ON public.%I FOR ALL '
    'USING ((auth.role() = ''service_role'') OR is_super_admin() OR (school_id = auth_school_id() AND auth_has_role(ARRAY[''admin'']))) '
    'WITH CHECK ((auth.role() = ''service_role'') OR is_super_admin() OR (school_id = auth_school_id() AND auth_has_role(ARRAY[''admin''])))',
    p_table, p_table
  );
END;
$_mt$ LANGUAGE plpgsql;

-- Apply to all tables that have school_id + RLS enabled but no existing policies
DO $$
DECLARE tables_needing_policies TEXT[] := ARRAY[
  'users', 'user_roles', 'user_settings',
  'persons', 'person_contacts',
  'roles', 'permissions', 'role_permissions',
  'students',
  'parents', 'student_parents',
  'academic_years', 'student_enrollments',
  'classes', 'sections', 'class_sections',
  'subjects', 'class_subjects',
  'daily_attendance',
  'staff', 'staff_designations',
  'fee_types', 'fee_structures', 'student_fees', 'fee_transactions',
  'receipts', 'receipt_items',
  'exams', 'exam_subjects', 'grading_scales', 'marks',
  'complaints', 'parent_visits', 'leave_applications', 'diary_entries', 'periods',
  'transport_routes', 'transport_stops', 'buses', 'student_transport', 'bus_locations',
  'hostel_blocks', 'hostel_rooms', 'hostel_allocations',
  'lms_courses', 'lms_materials',
  'money_science_modules', 'science_projects',
  'student_money_science_progress', 'student_science_projects',
  'discipline_records',
  'audit_logs',
  'notification_logs', 'notification_batches',
  'notification_templates', 'notification_preferences',
  'notification_events', 'notifications', 'notification_deliveries',
  'notification_audit_logs',
  'school_settings', 'feature_flags', 'ui_route_permissions',
  'driver_devices', 'driver_heartbeat', 'bus_trip_history',
  'admin_notifications',
  'timetable_entries'
];
tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY tables_needing_policies LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = tbl) THEN
      PERFORM _create_tenant_policies(tbl);
    END IF;
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS _create_tenant_policies(TEXT);

-- ─────────────────────────────────────────────────────────
-- 5. Safe defaults: change school_id DEFAULT 1 → DEFAULT auth_school_id()
--    so INSERTs without explicit school_id land in the caller's school.
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN pg_tables t ON t.tablename = c.table_name AND t.schemaname = 'public'
    WHERE c.table_schema = 'public'
      AND c.column_name = 'school_id'
      AND c.column_default = '1'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN school_id SET DEFAULT auth_school_id()',
      rec.table_name
    );
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────
-- 5. Remove stale global UNIQUE(name) constraints on
--    reference tables that conflict with multitenancy.
-- ─────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────
-- 6. Restrict schema-level grants: revoke blanket anon
--    access to schema objects
-- ─────────────────────────────────────────────────────────


-- Re-grant minimal anon access only for auth flow
GRANT USAGE ON SCHEMA public TO anon;

-- ─────────────────────────────────────────────────────────
-- 7. Re-enable row_security after migration
--    (counteracts SET row_security = off at top of file)
-- ─────────────────────────────────────────────────────────
SET row_security = on;

-- ─────────────────────────────────────────────────────────
-- 8. RLS + policy on schema_meta (internal versioning)
-- ─────────────────────────────────────────────────────────
ALTER TABLE schema_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_meta FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role only" ON schema_meta;
CREATE POLICY "Service role only" ON schema_meta FOR ALL
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

-- ────────────────────────────────────────────────────────
-- END MULTITENANCY HARDENING BLOCK
-- (Phase 2+ will reintroduce RLS policies explicitly.)
-- ────────────────────────────────────────────────────────

-- Commit the transaction started at the top of this file

-- ============================================================
-- Migration: Create founder-console base tables & analytics views
-- Fixes: "Could not find the table in the schema cache" warnings
-- ============================================================

-- ── 1. founders ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.founders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  email       text,
  full_name   text,
  role        text NOT NULL DEFAULT 'FOUNDER',   -- FOUNDER | APPROVER
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 2. business_units ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.business_units (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  code        text,
  subscription_price numeric,
  subscription_plan  text,
  phone       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 3. collections ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.collections (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id        uuid REFERENCES public.business_units(id),
  amount                  numeric NOT NULL DEFAULT 0,
  month                   integer NOT NULL,
  year                    integer NOT NULL,
  payment_mode            text NOT NULL DEFAULT 'CASH',  -- CASH|UPI|BANK|CHEQUE|OTHER
  status                  text NOT NULL DEFAULT 'PENDING', -- PENDING|APPROVED|REJECTED
  notes                   text,
  created_by_founder_id   uuid REFERENCES public.founders(id),
  approved_by_founder_id  uuid REFERENCES public.founders(id),
  rejection_reason        text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- ── 4. enquiries ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.enquiries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text,
  email       text,
  phone       text,
  status      text NOT NULL DEFAULT 'NEW',  -- NEW|CONTACTED|QUALIFIED|CLOSED|REJECTED
  source      text,
  category    text,
  assigned_to uuid,
  deal_value  numeric,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 5. activity_logs ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  action      text NOT NULL,
  actor_id    uuid,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 6. settings ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.settings (
  key   text PRIMARY KEY,
  value jsonb
);

-- ── Add missing columns to expenses if they don't exist ──────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='expenses' AND column_name='created_by_founder_id') THEN
    ALTER TABLE public.expenses ADD COLUMN created_by_founder_id uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='expenses' AND column_name='approved_by_founder_id') THEN
    ALTER TABLE public.expenses ADD COLUMN approved_by_founder_id uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='expenses' AND column_name='rejection_reason') THEN
    ALTER TABLE public.expenses ADD COLUMN rejection_reason text;
  END IF;
END $$;

-- ============================================================
-- ANALYTICS VIEWS
-- ============================================================
-- CREATE OR REPLACE VIEW cannot change a column's data type (e.g. EXTRACT → numeric
-- vs ::int). Drop dependent views first so definitions can be reapplied cleanly.
DROP VIEW IF EXISTS public.monthly_expense_summary_v2 CASCADE;
DROP VIEW IF EXISTS public.monthly_enquiry_summary CASCADE;
DROP VIEW IF EXISTS public.monthly_closed_deals CASCADE;

-- ── monthly_income_summary ───────────────────────────────────
CREATE OR REPLACE VIEW public.monthly_income_summary AS
SELECT
  year,
  month,
  COALESCE(SUM(amount), 0) AS total_amount,
  COUNT(*)                  AS count
FROM public.collections
WHERE status = 'APPROVED'
GROUP BY year, month
ORDER BY year, month;

-- ── monthly_enquiry_summary ──────────────────────────────────
CREATE OR REPLACE VIEW public.monthly_enquiry_summary AS
SELECT
  EXTRACT(YEAR  FROM created_at)::int  AS year,
  EXTRACT(MONTH FROM created_at)::int  AS month,
  COUNT(*)                              AS total_enquiries,
  COUNT(*) FILTER (WHERE status = 'CLOSED') AS closed_count
FROM public.enquiries
GROUP BY year, month
ORDER BY year, month;

-- ── monthly_closed_deals ─────────────────────────────────────
CREATE OR REPLACE VIEW public.monthly_closed_deals AS
SELECT
  EXTRACT(YEAR  FROM updated_at)::int  AS year,
  EXTRACT(MONTH FROM updated_at)::int  AS month,
  COUNT(*)                              AS count,
  COALESCE(SUM(deal_value), 0)          AS total_deal_value
FROM public.enquiries
WHERE status = 'CLOSED'
GROUP BY year, month
ORDER BY year, month;

-- ── conversion_rate ──────────────────────────────────────────
CREATE OR REPLACE VIEW public.conversion_rate AS
SELECT
  CASE
    WHEN COUNT(*) = 0 THEN 0
    ELSE ROUND(
      (COUNT(*) FILTER (WHERE status = 'CLOSED'))::numeric
      / COUNT(*)::numeric * 100, 2
    )
  END AS conversion_rate
FROM public.enquiries;

-- ── cost_per_lead ────────────────────────────────────────────
CREATE OR REPLACE VIEW public.cost_per_lead AS
SELECT
  CASE
    WHEN (SELECT COUNT(*) FROM public.enquiries) = 0 THEN 0
    ELSE ROUND(
      (SELECT COALESCE(SUM(amount), 0) FROM public.expenses WHERE status = 'APPROVED' AND category = 'MARKETING')
      / GREATEST((SELECT COUNT(*) FROM public.enquiries), 1)::numeric,
      2
    )
  END AS cost_per_lead;

-- ── pending_metrics_summary ──────────────────────────────────
CREATE OR REPLACE VIEW public.pending_metrics_summary AS
SELECT
  (SELECT COALESCE(SUM(amount), 0) FROM public.collections WHERE status = 'APPROVED')  AS approved_income,
  (SELECT COALESCE(SUM(amount), 0) FROM public.collections WHERE status = 'PENDING')   AS pending_collections,
  (SELECT COALESCE(SUM(amount), 0) FROM public.expenses    WHERE status = 'APPROVED')  AS approved_expenses,
  (SELECT COALESCE(SUM(amount), 0) FROM public.collections WHERE status = 'APPROVED')
    - (SELECT COALESCE(SUM(amount), 0) FROM public.expenses WHERE status = 'APPROVED') AS net_profit;

-- ── Disable RLS on new tables (superAdmin uses service role / anon key) ──
ALTER TABLE public.founders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collections   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enquiries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings      ENABLE ROW LEVEL SECURITY;

-- Allow anon/authenticated full access (the superAdmin app uses anon key)
DROP POLICY IF EXISTS "Allow all on founders" ON public.founders;
CREATE POLICY "Allow all on founders" ON public.founders FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all on business_units" ON public.business_units;
CREATE POLICY "Allow all on business_units" ON public.business_units FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all on collections" ON public.collections;
CREATE POLICY "Allow all on collections" ON public.collections FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all on enquiries" ON public.enquiries;
CREATE POLICY "Allow all on enquiries" ON public.enquiries FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all on activity_logs" ON public.activity_logs;
CREATE POLICY "Allow all on activity_logs" ON public.activity_logs FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Allow all on settings" ON public.settings;
CREATE POLICY "Allow all on settings" ON public.settings FOR ALL USING (true) WITH CHECK (true);


-- ============================================================
-- Migration: Create remaining missing founder-console views
-- ============================================================

-- ── leads_by_website ─────────────────────────────────────────
CREATE OR REPLACE VIEW public.leads_by_website AS
SELECT 
  COALESCE(source, 'Unknown') AS source,
  COUNT(*) AS leads,
  COUNT(*) FILTER (WHERE status = 'CLOSED') AS deals,
  COALESCE(SUM(deal_value) FILTER (WHERE status = 'CLOSED'), 0) AS revenue
FROM public.enquiries
GROUP BY source
ORDER BY leads DESC;

-- ── founder_lead_performance ─────────────────────────────────
CREATE OR REPLACE VIEW public.founder_lead_performance AS
SELECT 
  f.full_name AS founder_name,
  COUNT(e.id) AS leads,
  COUNT(e.id) FILTER (WHERE e.status = 'CLOSED') AS deals,
  COALESCE(SUM(e.deal_value) FILTER (WHERE e.status = 'CLOSED'), 0) AS revenue
FROM public.founders f
LEFT JOIN public.enquiries e ON e.assigned_to = f.id
GROUP BY f.id, f.full_name
ORDER BY revenue DESC, deals DESC, leads DESC;

-- ── monthly_expense_summary (For ROI) ──────────────────────
DROP VIEW IF EXISTS public.monthly_expense_summary CASCADE;
CREATE VIEW public.monthly_expense_summary AS
SELECT
  EXTRACT(year FROM created_at)::integer AS year,
  EXTRACT(month FROM created_at)::integer AS month,
  SUM(amount) AS total_amount
FROM public.expenses
WHERE status = 'APPROVED'
GROUP BY EXTRACT(year FROM created_at)::integer, EXTRACT(month FROM created_at)::integer;

-- ── monthly_expense_summary_v2 (For Category Breakdown) ────
-- (v2 already dropped at start of ANALYTICS VIEWS; drop again if script is split)
DROP VIEW IF EXISTS public.monthly_expense_summary_v2 CASCADE;
CREATE VIEW public.monthly_expense_summary_v2 AS
SELECT
  EXTRACT(year FROM created_at)::integer AS year,
  EXTRACT(month FROM created_at)::integer AS month,
  category,
  SUM(amount) AS total_amount
FROM public.expenses
WHERE status = 'APPROVED'
GROUP BY EXTRACT(year FROM created_at)::integer, EXTRACT(month FROM created_at)::integer, category;

GRANT SELECT ON public.monthly_expense_summary TO authenticated;
GRANT SELECT ON public.monthly_expense_summary_v2 TO authenticated;

-- ════════════════════════════════════════════════════════════
-- DCGD — Department of Career Growth & Development (Nexsyrus microservice data)
-- Global catalog: no school_id; API + RLS gate access by role.
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dcgd_programs (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    icon            TEXT NOT NULL DEFAULT 'ribbon-outline',
    display_order   INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dcgd_programs_display_order ON dcgd_programs (display_order);
CREATE INDEX IF NOT EXISTS idx_dcgd_programs_is_active ON dcgd_programs (is_active);
CREATE INDEX IF NOT EXISTS idx_dcgd_programs_active_order ON dcgd_programs (display_order) WHERE is_active = true;

DROP TRIGGER IF EXISTS trg_dcgd_programs_updated ON dcgd_programs;
CREATE TRIGGER trg_dcgd_programs_updated
    BEFORE UPDATE ON dcgd_programs
    FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TABLE IF NOT EXISTS dcgd_settings (
    id          SMALLINT PRIMARY KEY DEFAULT 1,
    page_title  TEXT NOT NULL DEFAULT 'DCGD',
    subtitle    TEXT NOT NULL DEFAULT 'Department of Career Growth and Development',
    is_visible  BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT dcgd_settings_singleton CHECK (id = 1)
);

DROP TRIGGER IF EXISTS trg_dcgd_settings_updated ON dcgd_settings;
CREATE TRIGGER trg_dcgd_settings_updated
    BEFORE UPDATE ON dcgd_settings
    FOR EACH ROW EXECUTE FUNCTION update_timestamp();

INSERT INTO dcgd_settings (id, page_title, subtitle, is_visible)
VALUES (1, 'DCGD', 'Department of Career Growth and Development', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO dcgd_programs (name, description, icon, display_order, is_active)
SELECT v.name, v.description, v.icon, v.display_order, true
FROM (VALUES
    ('CSE Foundation', 'Computer science fundamentals, logical thinking, and early exposure to programming concepts.', 'hardware-chip-outline', 1),
    ('JEE Foundation', 'Physics, chemistry, and mathematics rigour aimed at engineering entrance readiness.', 'flask-outline', 2),
    ('IPMAT Foundation', 'Quant, verbal ability, and reasoning tracks tailored for integrated management programmes.', 'briefcase-outline', 3),
    ('NEET Foundation', 'Biology-forward prep with board alignment for medical entrance trajectories.', 'medkit-outline', 4),
    ('Navodaya', 'Structured support for Jawahar Navodaya entrance patterns and scholastic depth.', 'school-outline', 5),
    ('Gurukula', 'Classical and holistic learning pathways with disciplined study routines.', 'book-outline', 6)
) AS v(name, description, icon, display_order)
WHERE NOT EXISTS (SELECT 1 FROM dcgd_programs LIMIT 1);

ALTER TABLE dcgd_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE dcgd_programs FORCE ROW LEVEL SECURITY;
ALTER TABLE dcgd_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE dcgd_settings FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON dcgd_programs TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON dcgd_settings TO authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE dcgd_programs_id_seq TO authenticated, service_role;

DROP POLICY IF EXISTS "dcgd_programs_super_admin_all" ON dcgd_programs;
CREATE POLICY "dcgd_programs_super_admin_all" ON dcgd_programs
    FOR ALL
    USING (auth.role() = 'service_role' OR is_super_admin())
    WITH CHECK (auth.role() = 'service_role' OR is_super_admin());

DROP POLICY IF EXISTS "dcgd_programs_student_read_active" ON dcgd_programs;
CREATE POLICY "dcgd_programs_student_read_active" ON dcgd_programs
    FOR SELECT
    USING (
        auth.role() = 'service_role'
        OR is_super_admin()
        OR (is_active = true AND auth_has_role(ARRAY['student']::text[]))
    );

DROP POLICY IF EXISTS "dcgd_settings_super_admin_all" ON dcgd_settings;
CREATE POLICY "dcgd_settings_super_admin_all" ON dcgd_settings
    FOR ALL
    USING (auth.role() = 'service_role' OR is_super_admin())
    WITH CHECK (auth.role() = 'service_role' OR is_super_admin());

DROP POLICY IF EXISTS "dcgd_settings_student_read_visible" ON dcgd_settings;
CREATE POLICY "dcgd_settings_student_read_visible" ON dcgd_settings
    FOR SELECT
    USING (
        auth.role() = 'service_role'
        OR is_super_admin()
        OR (is_visible = true AND auth_has_role(ARRAY['student']::text[]))
    );

-- ── DCGD Program Content (per-program materials managed by SuperAdmin) ──

CREATE TABLE IF NOT EXISTS dcgd_program_content (
    id              SERIAL PRIMARY KEY,
    program_id      INTEGER NOT NULL REFERENCES dcgd_programs(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    link_url        TEXT,
    pdf_url         TEXT,
    image_url       TEXT,
    content_body    TEXT,
    display_order   INTEGER NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dcgd_content_program_order ON dcgd_program_content (program_id, display_order);
CREATE INDEX IF NOT EXISTS idx_dcgd_content_active ON dcgd_program_content (is_active) WHERE is_active = true;

DROP TRIGGER IF EXISTS trg_dcgd_content_updated ON dcgd_program_content;
CREATE TRIGGER trg_dcgd_content_updated
    BEFORE UPDATE ON dcgd_program_content
    FOR EACH ROW EXECUTE FUNCTION update_timestamp();

ALTER TABLE dcgd_program_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE dcgd_program_content FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON dcgd_program_content TO authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE dcgd_program_content_id_seq TO authenticated, service_role;

DROP POLICY IF EXISTS "dcgd_content_super_admin_all" ON dcgd_program_content;
CREATE POLICY "dcgd_content_super_admin_all" ON dcgd_program_content
    FOR ALL
    USING (auth.role() = 'service_role' OR is_super_admin())
    WITH CHECK (auth.role() = 'service_role' OR is_super_admin());

DROP POLICY IF EXISTS "dcgd_content_student_read_active" ON dcgd_program_content;
CREATE POLICY "dcgd_content_student_read_active" ON dcgd_program_content
    FOR SELECT
    USING (
        auth.role() = 'service_role'
        OR is_super_admin()
        OR (is_active = true AND auth_has_role(ARRAY['student']::text[]))
    );

-- ════════════════════════════════════════════════════════════
-- BACKFILL: Seed defaults for any existing schools that lack them.
-- This is idempotent (uses NOT EXISTS checks in seed_school_defaults).
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_school RECORD;
BEGIN
  FOR v_school IN SELECT id FROM schools LOOP
    PERFORM seed_school_defaults(v_school.id);
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════
-- SECTION: TELUGU TRANSLATION COLUMNS (_te suffix)
-- Idempotent additions for multilingual support.
-- ════════════════════════════════════════════════════════════

-- subjects: name_te
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS name_te TEXT;

-- exams: name_te
ALTER TABLE exams ADD COLUMN IF NOT EXISTS name_te TEXT;

-- fee_types: name_te, description_te
ALTER TABLE fee_types ADD COLUMN IF NOT EXISTS name_te TEXT;
ALTER TABLE fee_types ADD COLUMN IF NOT EXISTS description_te TEXT;

-- transport_routes: name_te, description_te, start_point_te, end_point_te
ALTER TABLE transport_routes ADD COLUMN IF NOT EXISTS name_te TEXT;
ALTER TABLE transport_routes ADD COLUMN IF NOT EXISTS description_te TEXT;
ALTER TABLE transport_routes ADD COLUMN IF NOT EXISTS start_point_te TEXT;
ALTER TABLE transport_routes ADD COLUMN IF NOT EXISTS end_point_te TEXT;

-- transport_stops: name_te
ALTER TABLE transport_stops ADD COLUMN IF NOT EXISTS name_te TEXT;

-- ============================================================
-- TRANSPORT SERVICE — Phase 1 Schema (SchoolIMS v2)
-- Checkpoint trips, driver–route assignments, extended statuses.
-- Matches INTEGER school_id FK to schools(id) everywhere.
-- Student assignments remain on student_transport (existing table).
-- ============================================================

-- Extend route directions (existing: morning | afternoon only)
ALTER TABLE transport_routes DROP CONSTRAINT IF EXISTS transport_routes_direction_check;
ALTER TABLE transport_routes ADD CONSTRAINT transport_routes_direction_check
  CHECK (direction IS NULL OR direction IN ('morning', 'afternoon', 'evening', 'both'));

CREATE TABLE IF NOT EXISTS driver_route_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
    driver_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (school_id, route_id, driver_id)
);

CREATE INDEX IF NOT EXISTS idx_driver_route_assignments_driver
  ON driver_route_assignments (driver_id, school_id)
  WHERE deleted_at IS NULL AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_driver_route_assignments_route
  ON driver_route_assignments (route_id, school_id)
  WHERE deleted_at IS NULL AND is_active = TRUE;

DROP TRIGGER IF EXISTS trg_driver_route_assignments_updated ON driver_route_assignments;
CREATE TRIGGER trg_driver_route_assignments_updated
  BEFORE UPDATE ON driver_route_assignments
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

ALTER TABLE trips ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE trips ADD COLUMN IF NOT EXISTS trip_date DATE;

ALTER TABLE trips ADD COLUMN IF NOT EXISTS trip_direction VARCHAR(20);

UPDATE trips SET trip_date = (started_at AT TIME ZONE 'UTC')::date WHERE trip_date IS NULL;

ALTER TABLE trips ALTER COLUMN started_at DROP NOT NULL;

ALTER TABLE trips ALTER COLUMN started_at DROP DEFAULT;

ALTER TABLE trips DROP CONSTRAINT IF EXISTS trips_status_check;

ALTER TABLE trips ADD CONSTRAINT trips_status_check
  CHECK (status IN ('scheduled', 'active', 'in_progress', 'completed', 'cancelled'));

DROP INDEX IF EXISTS idx_trips_active_bus;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_active_like_bus
  ON trips (bus_id)
  WHERE status IN ('active', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_trips_route_date ON trips (school_id, route_id, trip_date);

CREATE INDEX IF NOT EXISTS idx_trips_school_date_status
  ON trips (school_id, trip_date, status);

-- ============================================================
-- SECTION: Academic Year Upgrade Infrastructure
-- Date: 2026-05-16
-- ============================================================

-- 1. Add sort_order to classes for reliable "next class" ordering
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

-- 3. Seed active_academic_year_id for existing schools that have an academic year
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

COMMIT;
-- ============================================================================
-- 20260710_messenger_tables.sql
-- In-app 1:1 messenger: parent↔admin, admin↔teacher, teacher↔parent
-- ============================================================================

-- 1. Conversations — one row per 1:1 thread
CREATE TABLE IF NOT EXISTS message_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    pair_type TEXT NOT NULL CHECK (pair_type IN ('parent_admin', 'admin_teacher', 'teacher_parent')),
    participant_low_user_id UUID NOT NULL REFERENCES users(id),
    participant_high_user_id UUID NOT NULL REFERENCES users(id),
    student_id UUID NULL REFERENCES students(id),
    subject TEXT NULL,
    last_message_at TIMESTAMPTZ NULL,
    last_message_preview TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ NULL
    -- Unique constraint handled via index below to support COALESCE expression
);

CREATE UNIQUE INDEX IF NOT EXISTS unq_message_conversations_pair
    ON message_conversations (
        school_id, 
        participant_low_user_id, 
        participant_high_user_id, 
        COALESCE(student_id, '00000000-0000-0000-0000-000000000000')
    );

-- 2. Participants — 2 rows per conversation (read state + mute per user)
CREATE TABLE IF NOT EXISTS message_participants (
    conversation_id UUID NOT NULL REFERENCES message_conversations(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    last_read_at TIMESTAMPTZ NULL,
    muted BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (conversation_id, user_id)
);

-- 3. Messages — individual messages in a thread
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES message_conversations(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    sender_user_id UUID NOT NULL REFERENCES users(id),
    body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
    reply_to_message_id UUID NULL REFERENCES messages(id) ON DELETE SET NULL,
    forwarded_from_message_id UUID NULL REFERENCES messages(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at TIMESTAMPTZ NULL,
    deleted_at TIMESTAMPTZ NULL
);

-- ============================================================================
-- Indexes (keyset pagination + unread must be fast)
-- ============================================================================

-- Thread messages: keyset pagination by (created_at DESC, id DESC)
CREATE INDEX IF NOT EXISTS idx_messages_conv_created
    ON messages (conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_messages_reply_to
    ON messages (reply_to_message_id)
    WHERE reply_to_message_id IS NOT NULL;

-- Conversation list for a user: find all conversations where user is participant_low
CREATE INDEX IF NOT EXISTS idx_conv_low_user
    ON message_conversations (school_id, participant_low_user_id, last_message_at DESC NULLS LAST);

-- Conversation list for a user: find all conversations where user is participant_high
CREATE INDEX IF NOT EXISTS idx_conv_high_user
    ON message_conversations (school_id, participant_high_user_id, last_message_at DESC NULLS LAST);

-- Fast participant lookup for access checks and unread count
CREATE INDEX IF NOT EXISTS idx_participants_user
    ON message_participants (user_id, school_id);

-- ============================================================================
-- Triggers
-- ============================================================================

-- Reuse existing update_timestamp() for updated_at on conversations
CREATE TRIGGER trg_message_conversations_updated_at
    BEFORE UPDATE ON message_conversations
    FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Auto-update conversation preview on new message insert
CREATE OR REPLACE FUNCTION update_conversation_on_message()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE message_conversations
    SET last_message_at = NEW.created_at,
        last_message_preview = LEFT(NEW.body, 100),
        updated_at = now()
    WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_messages_update_conversation
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION update_conversation_on_message();
