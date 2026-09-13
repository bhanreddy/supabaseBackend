-- SchoolIMS release baseline: schema-only export of deployed public schema.
-- Captured 2026-09-05, PostgreSQL 17.6. No customer rows or credentials.
-- Fresh installations ONLY, through scripts/migrate_release.js --init.
-- Requires the Supabase auth schema/functions and platform roles.
-- Legacy conversion migrations remain immutable; do not replay them after this baseline.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.11 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: account_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.account_status_enum AS ENUM (
    'active',
    'locked',
    'disabled'
);


--
-- Name: attendance_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.attendance_status_enum AS ENUM (
    'present',
    'absent',
    'late',
    'half_day'
);


--
-- Name: complaint_priority_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.complaint_priority_enum AS ENUM (
    'low',
    'medium',
    'high',
    'urgent',
    'critical'
);


--
-- Name: complaint_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.complaint_status_enum AS ENUM (
    'open',
    'in_progress',
    'resolved',
    'closed',
    'rejected',
    'waiting_on_client',
    'escalated',
    'reopened'
);


--
-- Name: contact_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.contact_type_enum AS ENUM (
    'email',
    'phone',
    'address'
);


--
-- Name: day_of_week_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.day_of_week_enum AS ENUM (
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
    'mon',
    'tue',
    'wed',
    'thu',
    'fri',
    'sat',
    'sun'
);


--
-- Name: defaulter_due_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.defaulter_due_source AS ENUM (
    'manual_legacy',
    'carried_forward'
);


--
-- Name: defaulter_due_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.defaulter_due_status AS ENUM (
    'pending',
    'partially_paid',
    'cleared'
);


--
-- Name: enrollment_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.enrollment_status_enum AS ENUM (
    'active',
    'completed',
    'withdrawn'
);


--
-- Name: event_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_status AS ENUM (
    'RECEIVED',
    'PROCESSED',
    'FAILED'
);


--
-- Name: event_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.event_type_enum AS ENUM (
    'academic',
    'cultural',
    'sports',
    'holiday',
    'meeting',
    'exam',
    'other'
);


--
-- Name: exam_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.exam_status_enum AS ENUM (
    'scheduled',
    'ongoing',
    'completed',
    'cancelled'
);


--
-- Name: fee_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.fee_status_enum AS ENUM (
    'pending',
    'partial',
    'paid',
    'waived',
    'overdue'
);


--
-- Name: leave_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.leave_status_enum AS ENUM (
    'pending',
    'approved',
    'rejected',
    'cancelled'
);


--
-- Name: leave_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.leave_type_enum AS ENUM (
    'casual',
    'sick',
    'earned',
    'maternity',
    'paternity',
    'unpaid',
    'other'
);


--
-- Name: material_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.material_type_enum AS ENUM (
    'video',
    'document',
    'link',
    'quiz',
    'assignment'
);


--
-- Name: notice_audience_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notice_audience_enum AS ENUM (
    'all',
    'students',
    'staff',
    'parents',
    'class'
);


--
-- Name: notification_channel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_channel AS ENUM (
    'IN_APP',
    'EMAIL',
    'SMS',
    'PUSH'
);


--
-- Name: notification_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_status AS ENUM (
    'PENDING',
    'PROCESSING',
    'DELIVERED',
    'FAILED',
    'READ',
    'DISMISSED'
);


--
-- Name: payment_method_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_method_enum AS ENUM (
    'cash',
    'card',
    'upi',
    'bank_transfer',
    'cheque',
    'online'
);


--
-- Name: payroll_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payroll_status_enum AS ENUM (
    'pending',
    'paid'
);


--
-- Name: portal_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.portal_type_enum AS ENUM (
    'student',
    'staff',
    'admin',
    'accounts',
    'driver',
    'library',
    'transport'
);


--
-- Name: receipt_payment_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.receipt_payment_type AS ENUM (
    'fee',
    'arrears'
);


--
-- Name: transport_billing_cycle; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.transport_billing_cycle AS ENUM (
    'monthly',
    'quarterly',
    'term',
    'annual'
);


--
-- Name: academic_year_start_year(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.academic_year_start_year(p_code text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT COALESCE(NULLIF(split_part(p_code, '-', 1), '')::INTEGER, 0);
$$;


--
-- Name: auth_has_role(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_has_role(role_codes text[]) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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
$$;


--
-- Name: auth_school_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_school_id() RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT u.school_id
  FROM public.users u
  WHERE u.id = auth.uid()
    AND u.deleted_at IS NULL
  LIMIT 1
$$;


--
-- Name: auto_assign_fees_on_enrollment(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_assign_fees_on_enrollment() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: auto_assign_fees_on_structure_creation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_assign_fees_on_structure_creation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
          AND NOT EXISTS (
            SELECT 1 FROM student_fees sf
            WHERE sf.student_id = se.student_id AND sf.fee_structure_id = NEW.id AND sf.deleted_at IS NULL
          )
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
          AND NOT EXISTS (
            SELECT 1 FROM student_fees sf
            WHERE sf.student_id = se.student_id AND sf.fee_structure_id = NEW.id AND sf.deleted_at IS NULL
          )
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
$$;


--
-- Name: auto_generate_receipt(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_generate_receipt() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_receipt_id UUID;
    v_student_id UUID;
    v_receipt_no TEXT;
BEGIN
    SELECT student_id INTO v_student_id
    FROM public.student_fees
    WHERE id = NEW.student_fee_id;

    IF NEW.receipt_group IS NOT NULL THEN
        SELECT id INTO v_receipt_id
        FROM public.receipts
        WHERE school_id = NEW.school_id
          AND receipt_group = NEW.receipt_group;

        IF v_receipt_id IS NULL THEN
            v_receipt_no := public.get_next_receipt_no(NEW.school_id);

            INSERT INTO public.receipts (
                school_id,
                receipt_no,
                student_id,
                total_amount,
                issued_at,
                issued_by,
                remarks,
                receipt_group
            )
            VALUES (
                NEW.school_id,
                v_receipt_no,
                v_student_id,
                NEW.amount,
                NEW.paid_at,
                NEW.received_by,
                COALESCE(NEW.remarks, 'System Generated'),
                NEW.receipt_group
            )
            RETURNING id INTO v_receipt_id;
        ELSE
            UPDATE public.receipts
            SET total_amount = total_amount + NEW.amount
            WHERE id = v_receipt_id;
        END IF;

        INSERT INTO public.receipt_items (
            school_id,
            receipt_id,
            fee_transaction_id,
            amount
        )
        VALUES (NEW.school_id, v_receipt_id, NEW.id, NEW.amount);

        RETURN NEW;
    END IF;

    v_receipt_no := public.get_next_receipt_no(NEW.school_id);

    INSERT INTO public.receipts (
        school_id,
        receipt_no,
        student_id,
        total_amount,
        issued_at,
        issued_by,
        remarks
    )
    VALUES (
        NEW.school_id,
        v_receipt_no,
        v_student_id,
        NEW.amount,
        NEW.paid_at,
        NEW.received_by,
        COALESCE(NEW.remarks, 'System Generated')
    )
    RETURNING id INTO v_receipt_id;

    INSERT INTO public.receipt_items (
        school_id,
        receipt_id,
        fee_transaction_id,
        amount
    )
    VALUES (NEW.school_id, v_receipt_id, NEW.id, NEW.amount);

    RETURN NEW;
END;
$$;


--
-- Name: billing_documents_guard_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.billing_documents_guard_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status = 'issued' THEN
    -- The single allowed transition: issued -> cancelled, touching nothing else.
    IF NEW.status = 'cancelled' AND ROW(
        NEW.document_number, NEW.document_type, NEW.financial_year,
        NEW.client_legal_name, NEW.client_gstin, NEW.client_billing_address,
        NEW.client_state_code, NEW.supplier_gstin, NEW.supplier_state_code,
        NEW.place_of_supply_state_code, NEW.line_items, NEW.taxable_value,
        NEW.cgst_rate, NEW.cgst_amount, NEW.sgst_rate, NEW.sgst_amount,
        NEW.igst_rate, NEW.igst_amount, NEW.total_amount
      ) IS NOT DISTINCT FROM ROW(
        OLD.document_number, OLD.document_type, OLD.financial_year,
        OLD.client_legal_name, OLD.client_gstin, OLD.client_billing_address,
        OLD.client_state_code, OLD.supplier_gstin, OLD.supplier_state_code,
        OLD.place_of_supply_state_code, OLD.line_items, OLD.taxable_value,
        OLD.cgst_rate, OLD.cgst_amount, OLD.sgst_rate, OLD.sgst_amount,
        OLD.igst_rate, OLD.igst_amount, OLD.total_amount
      ) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'billing_documents row % is issued and immutable; only status -> cancelled is permitted (issue a new linked document to correct)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: check_financial_permission(text, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_financial_permission(p_action_code text, p_amount numeric DEFAULT 0) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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
$$;


--
-- Name: compute_attendance_day_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compute_attendance_day_status() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_attended INTEGER := 0;  -- sessions marked present/late
    v_marked   INTEGER := 0;  -- sessions explicitly marked with any status
BEGIN
    -- Preserve legacy/manual writes that only set the overall status.
    IF NEW.morning_status IS NULL AND NEW.afternoon_status IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.morning_status IS NOT NULL THEN
        v_marked := v_marked + 1;
        IF NEW.morning_status IN ('present', 'late') THEN
            v_attended := v_attended + 1;
        END IF;
    END IF;

    IF NEW.afternoon_status IS NOT NULL THEN
        v_marked := v_marked + 1;
        IF NEW.afternoon_status IN ('present', 'late') THEN
            v_attended := v_attended + 1;
        END IF;
    END IF;

    IF v_attended = 0 THEN
        NEW.status := 'absent';
    ELSIF v_marked = 2 AND v_attended = 1 THEN
        NEW.status := 'half_day';
    ELSE
        NEW.status := 'present';
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: current_school_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_school_id() RETURNS integer
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_school_id', true), '')::INTEGER;
END;
$$;


--
-- Name: current_staff_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_staff_id() RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_staff_id UUID;
BEGIN
  SELECT id INTO v_staff_id
  FROM public.staff
  WHERE user_id = auth.uid()
    AND school_id = auth_school_id();
  
  RETURN v_staff_id;
END;
$$;


--
-- Name: debug_teacher_profile(character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.debug_teacher_profile(p_staff_code character varying) RETURNS TABLE(period_number integer, class_name character varying, section_name character varying, subject_name character varying, room_no character varying)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: debug_user_permissions(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.debug_user_permissions(p_user_id uuid) RETURNS TABLE(role_code character varying, permission_code character varying, permission_name character varying)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: delete_record_with_reason(text, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_record_with_reason(p_table_name text, p_record_id uuid, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
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
$_$;


--
-- Name: derive_defaulter_status(numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.derive_defaulter_status(p_balance numeric, p_paid numeric) RETURNS public.defaulter_due_status
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN p_balance <= 0 THEN 'cleared'::defaulter_due_status
    WHEN p_paid > 0 THEN 'partially_paid'::defaulter_due_status
    ELSE 'pending'::defaulter_due_status
  END;
$$;


--
-- Name: enforce_class_teacher_source_of_truth(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_class_teacher_source_of_truth() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: enforce_financial_lock(date, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_financial_lock(p_date date, p_context text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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
$$;


--
-- Name: ensure_active_person_ref(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_active_person_ref() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: ensure_active_person_staff(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_active_person_staff() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM persons WHERE id = NEW.person_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot link staff to deleted person';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: ensure_active_student_enrollment(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_active_student_enrollment() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
            OR (
                NEW.status = 'active'
                AND NEW.status IS DISTINCT FROM OLD.status
            );
    END IF;

    IF should_validate AND EXISTS (
        SELECT 1
        FROM students
        WHERE id = NEW.student_id
          AND deleted_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Cannot enroll a deleted student';
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: ensure_active_student_parent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_active_student_parent() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: fn_check_academic_year_dates(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_check_academic_year_dates() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    IF NEW.start_date > NEW.end_date THEN
        RAISE EXCEPTION 'Academic Year Start Date (%) cannot be after End Date (%).', NEW.start_date, NEW.end_date;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: fn_check_invoice_amounts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_check_invoice_amounts() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: fn_check_no_future_attendance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_check_no_future_attendance() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    IF NEW.attendance_date > CURRENT_DATE THEN
        RAISE EXCEPTION 'Cannot mark attendance for future date: % (Today is %)', NEW.date, CURRENT_DATE;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: fn_lower_email(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_lower_email() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    IF NEW.email IS NOT NULL THEN
        NEW.email = LOWER(NEW.email);
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: fn_prevent_immutable_changes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_prevent_immutable_changes() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: fn_prevent_overpayment(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_prevent_overpayment() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: fn_transaction_immutability(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_transaction_immutability() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: fn_update_fee_balance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_update_fee_balance() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: fn_update_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_update_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: fn_verify_fee_integrity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_verify_fee_integrity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: generate_monthly_payroll(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_monthly_payroll(p_month integer, p_year integer) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: generate_ticket_no(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_ticket_no() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.ticket_no IS NULL THEN
    NEW.ticket_no := 'TKT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || 
                     LPAD(NEXTVAL('complaint_ticket_seq')::TEXT, 4, '0');
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: get_attendance_analytics(date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_attendance_analytics(p_from_date date, p_to_date date) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: get_dashboard_insights(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_dashboard_insights() RETURNS TABLE(type text, message text, severity text)
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: get_financial_analytics(date, date, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_financial_analytics(p_from_date date, p_to_date date, p_group_by text DEFAULT 'month'::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: get_financial_policy_value(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_financial_policy_value(code_input text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE val JSONB;
BEGIN
    SELECT current_value INTO val FROM financial_policy_rules
    WHERE rule_code = code_input AND school_id = auth_school_id();
    RETURN val;
END;
$$;


--
-- Name: get_next_adj_receipt_no(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_next_adj_receipt_no(p_school_id integer) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_seq_name TEXT := 'adj_receipt_no_seq_school_' || p_school_id;
BEGIN
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I START 1', v_seq_name);
  RETURN 'ADJ-' || LPAD(NEXTVAL(v_seq_name)::TEXT, 4, '0');
END;
$$;


--
-- Name: get_next_certificate_serial(integer, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_next_certificate_serial(p_school_id integer, p_cert_type text, p_cert_year integer) RETURNS text
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


--
-- Name: get_next_complaint_ticket(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_next_complaint_ticket(p_school_id integer) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_seq_name TEXT := 'complaint_ticket_seq_school_' || p_school_id;
BEGIN
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I START 1', v_seq_name);
  RETURN 'TKT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-S' || p_school_id || '-' || LPAD(NEXTVAL(v_seq_name)::TEXT, 4, '0');
END;
$$;


--
-- Name: get_next_receipt_no(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_next_receipt_no(p_school_id integer) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
    v_next_number BIGINT;
BEGIN
    IF p_school_id IS NULL THEN
        RAISE EXCEPTION 'school_id is required to generate a receipt number';
    END IF;

    INSERT INTO public.receipt_number_counters AS counters (
        school_id,
        last_number,
        updated_at
    )
    VALUES (
        p_school_id,
        GREATEST(
            1001::BIGINT,
            COALESCE((
                SELECT MAX(SUBSTRING(r.receipt_no FROM '([0-9]+)$')::BIGINT) + 1
                FROM public.receipts r
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
$_$;


--
-- Name: FUNCTION get_next_receipt_no(p_school_id integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_next_receipt_no(p_school_id integer) IS 'Returns the next receipt number from the requesting school''s independent series.';


--
-- Name: get_next_ticket_number(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_next_ticket_number(p_school_id integer) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_year INTEGER := EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER;
    v_next_number BIGINT;
BEGIN
    IF p_school_id IS NULL THEN
        RAISE EXCEPTION 'school_id is required to generate a ticket number';
    END IF;

    INSERT INTO public.ticket_number_counters AS counters (
        school_id,
        year,
        last_number,
        updated_at
    )
    VALUES (
        p_school_id,
        v_year,
        1,
        NOW()
    )
    ON CONFLICT (school_id, year) DO UPDATE
    SET last_number = counters.last_number + 1,
        updated_at = NOW()
    RETURNING counters.last_number INTO v_next_number;

    RETURN 'TKT-' || v_year::TEXT || '-' || LPAD(v_next_number::TEXT, 5, '0');
END;
$$;


--
-- Name: is_accounts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_accounts() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
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
$$;


--
-- Name: is_management(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_management() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN (public.is_principal() OR public.is_accounts());
END;
$$;


--
-- Name: is_principal(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_principal() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: is_staff(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_staff() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.staff WHERE user_id = auth.uid() AND staff.school_id = auth_school_id()
  );
END;
$$;


--
-- Name: is_super_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_super_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM super_admins
    WHERE id = auth.uid()
      AND is_active = true
  );
$$;


--
-- Name: log_financial_destruction(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_financial_destruction() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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
$$;


--
-- Name: next_certificate_serial(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_certificate_serial(cert_type text, cert_year integer) RETURNS text
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN public.get_next_certificate_serial(1, cert_type, cert_year);
END;
$$;


--
-- Name: normalize_optional_name(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_optional_name() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: perform_data_audit(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.perform_data_audit(p_school_id integer) RETURNS TABLE(issue_type text, entity_id text, details text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: prevent_complaint_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_complaint_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF (current_user <> 'postgres') THEN -- Allow admin/migration tool to delete if needed
        RAISE EXCEPTION 'Deleting complaints is not allowed. Update status instead.';
    END IF;
    RETURN OLD;
END;
$$;


--
-- Name: prevent_direct_fee_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_direct_fee_update() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: prevent_fee_transaction_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_fee_transaction_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    RAISE EXCEPTION 'fee_transactions is append-only. UPDATE and DELETE are forbidden.';
END;
$$;


--
-- Name: prevent_published_result_mark_changes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_published_result_mark_changes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  target_exam_subject_id UUID;
  target_exam_id UUID;
  is_published BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_exam_subject_id := OLD.exam_subject_id;
  ELSE
    target_exam_subject_id := NEW.exam_subject_id;
  END IF;

  SELECT es.exam_id
    INTO target_exam_id
  FROM exam_subjects es
  WHERE es.id = target_exam_subject_id;

  SELECT e.results_published
    INTO is_published
  FROM exams e
  WHERE e.id = target_exam_id
  FOR SHARE;

  IF COALESCE(is_published, FALSE) THEN
    RAISE EXCEPTION 'Published results are locked. Unpublish them before changing marks.'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: prevent_published_result_paper_changes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_published_result_paper_changes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  target_exam_id UUID;
  is_published BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' AND
     ROW(NEW.exam_id, NEW.subject_id, NEW.class_id, NEW.exam_date,
         NEW.start_time, NEW.end_time, NEW.max_marks, NEW.passing_marks, NEW.deleted_at)
     IS NOT DISTINCT FROM
     ROW(OLD.exam_id, OLD.subject_id, OLD.class_id, OLD.exam_date,
         OLD.start_time, OLD.end_time, OLD.max_marks, OLD.passing_marks, OLD.deleted_at) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    target_exam_id := OLD.exam_id;
  ELSE
    target_exam_id := NEW.exam_id;
  END IF;

  SELECT e.results_published
    INTO is_published
  FROM exams e
  WHERE e.id = target_exam_id
  FOR SHARE;

  IF COALESCE(is_published, FALSE) THEN
    RAISE EXCEPTION 'Published results are locked. Unpublish them before changing exam papers.'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: prevent_system_role_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_system_role_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: promote_students_academic_year(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.promote_students_academic_year(p_current_ay_id uuid, p_next_ay_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: propagate_fee_structure_updates(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.propagate_fee_structure_updates() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    IF NEW.amount IS DISTINCT FROM OLD.amount THEN
        UPDATE student_fees
        SET amount_due = NEW.amount, updated_at = now()
        WHERE fee_structure_id = NEW.id AND status IN ('pending', 'partial', 'overdue');
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: recalculate_fee_ledger(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recalculate_fee_ledger(p_school_id integer DEFAULT NULL::integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: recalculate_rolls_after_enrollment_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recalculate_rolls_after_enrollment_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM recalculate_section_rolls(
            OLD.class_section_id,
            OLD.academic_year_id
        );
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        PERFORM recalculate_section_rolls(
            OLD.class_section_id,
            OLD.academic_year_id
        );
    END IF;

    PERFORM recalculate_section_rolls(
        NEW.class_section_id,
        NEW.academic_year_id
    );
    RETURN NEW;
END;
$$;


--
-- Name: recalculate_rolls_after_student_delete_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recalculate_rolls_after_student_delete_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    target RECORD;
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
        PERFORM recalculate_section_rolls(
            target.class_section_id,
            target.academic_year_id
        );
    END LOOP;

    RETURN NEW;
END;
$$;


--
-- Name: recalculate_rolls_after_student_name_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recalculate_rolls_after_student_name_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    target RECORD;
BEGIN
    IF ROW(OLD.first_name, OLD.middle_name, OLD.last_name)
       IS NOT DISTINCT FROM
       ROW(NEW.first_name, NEW.middle_name, NEW.last_name) THEN
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
        PERFORM recalculate_section_rolls(
            target.class_section_id,
            target.academic_year_id
        );
    END LOOP;

    RETURN NEW;
END;
$$;


--
-- Name: recalculate_section_rolls(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recalculate_section_rolls(p_class_section_id uuid, p_academic_year_id uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_manual BOOLEAN := false;
    v_start INTEGER := 1;
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtext(p_class_section_id::text),
        hashtext(p_academic_year_id::text)
    );

    SELECT COALESCE(manual_roll_numbers, false), COALESCE(roll_number_start, 1)
      INTO v_manual, v_start
    FROM class_sections
    WHERE id = p_class_section_id;

    IF v_manual THEN
        -- Stage existing positive values as negative numbers. This preserves
        -- the teacher's order while avoiding transient unique-index collisions.
        UPDATE student_enrollments
        SET roll_number = -roll_number
        WHERE class_section_id = p_class_section_id
          AND academic_year_id = p_academic_year_id
          AND status = 'active'
          AND deleted_at IS NULL
          AND roll_number IS NOT NULL
          AND roll_number > 0;

        WITH ordered_students AS (
            SELECT
                se.id AS enrollment_id,
                (v_start - 1 + ROW_NUMBER() OVER (
                    ORDER BY
                        ABS(se.roll_number) ASC NULLS LAST,
                        LOWER(BTRIM(COALESCE(p.first_name, ''))) ASC,
                        LOWER(BTRIM(COALESCE(p.middle_name, ''))) ASC,
                        LOWER(BTRIM(COALESCE(p.last_name, ''))) ASC,
                        s.admission_no ASC,
                        s.id ASC
                ))::INTEGER AS new_roll
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
        SET roll_number = ordered_students.new_roll
        FROM ordered_students
        WHERE se.id = ordered_students.enrollment_id;
    ELSE
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
                )::INTEGER AS new_roll
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
        SET roll_number = ordered_students.new_roll
        FROM ordered_students
        WHERE se.id = ordered_students.enrollment_id;
    END IF;
END;
$$;


--
-- Name: recalculate_staff_payroll(uuid, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recalculate_staff_payroll(p_staff_id uuid, p_month integer, p_year integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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
$$;


--
-- Name: refresh_defaulter_due_balance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_defaulter_due_balance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.balance := GREATEST(NEW.original_amount - NEW.paid_amount, 0);
  NEW.status := derive_defaulter_status(NEW.balance, NEW.paid_amount);
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;


--
-- Name: repair_data_integrity(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.repair_data_integrity(p_school_id integer DEFAULT NULL::integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: run_integrity_check(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.run_integrity_check(p_school_id integer) RETURNS TABLE(severity text, category text, entity_id text, description text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: safe_div(numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.safe_div(n numeric, d numeric) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
    IF d = 0 OR d IS NULL THEN RETURN 0; END IF;
    RETURN n / d;
END;
$$;


--
-- Name: seed_school_defaults(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.seed_school_defaults(p_school_id integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- 1. Staff Designations
  INSERT INTO staff_designations (school_id, name)
  SELECT p_school_id, v.name
  FROM (VALUES
    ('Principal'), ('Vice Principal'), ('Teacher'), ('Senior Teacher'),
    ('Lab Assistant'), ('Librarian'), ('Clerk'), ('Peon'), ('Other')
  ) AS v(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM staff_designations sd WHERE sd.school_id = p_school_id AND sd.name = v.name
  );

  -- 2. Periods (Default timetable structure)
  INSERT INTO periods (school_id, name, start_time, end_time, sort_order)
  SELECT p_school_id, v.name, v.start_time, v.end_time, v.sort_order
  FROM (VALUES
    ('Period 1', '08:00'::time, '08:45'::time, 1),
    ('Period 2', '08:45'::time, '09:30'::time, 2),
    ('Period 3', '09:30'::time, '10:15'::time, 3),
    ('Break',    '10:15'::time, '10:30'::time, 4),
    ('Period 4', '10:30'::time, '11:15'::time, 5),
    ('Period 5', '11:15'::time, '12:00'::time, 6),
    ('Lunch',    '12:00'::time, '12:45'::time, 7),
    ('Period 6', '12:45'::time, '13:30'::time, 8),
    ('Period 7', '13:30'::time, '14:15'::time, 9),
    ('Period 8', '14:15'::time, '15:00'::time, 10)
  ) AS v(name, start_time, end_time, sort_order)
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
    ('payroll.process', 'Process Payroll')
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
      'timetable.view', 'leaves.apply', 'notices.view', 'events.view', 'lms.view',
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

  -- Accounts: Financial Management
  INSERT INTO role_permissions (school_id, role_id, permission_id)
  SELECT p_school_id, r.id, p.id
  FROM roles r CROSS JOIN permissions p
  WHERE r.code = 'accounts' AND r.school_id = p_school_id AND p.school_id = p_school_id
    AND p.code IN (
      'fees.view', 'fees.manage', 'fees.collect', 'transactions.view',
      'receipts.generate', 'reports.financial', 'notices.view', 'staff.view',
      'staff.create', 'staff.edit', 'dashboard.view', 'academics.view',
      'students.view', 'students.create', 'students.edit',
      'expenses.view', 'expenses.create', 'expenses.edit', 'expenses.delete',
      'payroll.process'
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


--
-- Name: set_school_context(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_school_context(p_school_id integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    PERFORM set_config('app.current_school_id', p_school_id::TEXT, true);
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: student_id_for_session(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.student_id_for_session() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT s.id
  FROM public.students s
  WHERE s.auth_user_id = auth.uid()
    AND s.deleted_at IS NULL
  LIMIT 1;
$$;


--
-- Name: sync_class_teacher_from_timetable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_class_teacher_from_timetable() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: trg_check_expense_policy(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_check_expense_policy() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: trg_check_fee_cash_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_check_fee_cash_limit() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    IF NEW.payment_method = 'cash' THEN PERFORM check_financial_permission('FEE_COLLECT_CASH', NEW.amount); END IF;
    PERFORM enforce_financial_lock(NEW.paid_at::DATE, 'FEE');
    RETURN NEW;
END;
$$;


--
-- Name: trg_recalc_payroll_on_attendance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_recalc_payroll_on_attendance() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: trg_recalc_payroll_on_leave(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_recalc_payroll_on_leave() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: trg_seed_hostel_rbac_on_school_create(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_seed_hostel_rbac_on_school_create() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  INSERT INTO permissions (school_id, code, name)
  VALUES
    (NEW.id, 'hostel.view', 'View Hostel'),
    (NEW.id, 'hostel.manage', 'Manage Hostel Setup, Fees and Requests'),
    (NEW.id, 'hostel.allocate', 'Assign and Vacate Hostel Students')
  ON CONFLICT (school_id, code)
  DO UPDATE SET name = EXCLUDED.name, deleted_at = NULL;

  INSERT INTO role_permissions (school_id, role_id, permission_id)
  SELECT r.school_id, r.id, p.id
  FROM roles r
  JOIN permissions p ON p.school_id = r.school_id
  WHERE r.school_id = NEW.id
    AND (
      (r.code IN ('admin', 'principal') AND p.code IN ('hostel.view', 'hostel.manage', 'hostel.allocate'))
      OR (r.code = 'accounts' AND p.code IN ('hostel.view', 'hostel.allocate'))
    )
  ON CONFLICT (role_id, permission_id)
  DO UPDATE SET school_id = EXCLUDED.school_id, deleted_at = NULL;

  RETURN NEW;
END;
$$;


--
-- Name: trg_seed_school_on_create(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_seed_school_on_create() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  PERFORM seed_school_defaults(NEW.id);
  RETURN NEW;
END;
$$;


--
-- Name: update_conversation_on_message(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_conversation_on_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE message_conversations
    SET last_message_at = NEW.created_at,
        last_message_preview = LEFT(NEW.body, 100),
        updated_at = now()
    WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$;


--
-- Name: update_fee_paid_amount(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_fee_paid_amount() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    UPDATE student_fees
    SET amount_paid = amount_paid + NEW.amount
    WHERE id = NEW.student_fee_id;
    RETURN NULL;
END;
$$;


--
-- Name: update_fee_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_fee_status() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: update_person_display_name(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_person_display_name() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.display_name := trim(concat_ws(' ', NEW.first_name, NEW.middle_name, NEW.last_name));
  RETURN NEW;
END;
$$;


--
-- Name: update_super_admin_last_login(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_super_admin_last_login(p_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE super_admins SET last_login = now() WHERE id = p_id;
END;
$$;


--
-- Name: update_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: update_user_settings_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_user_settings_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
            BEGIN
                NEW.updated_at = NOW();
                RETURN NEW;
            END;
            $$;


--
-- Name: validate_attendance_date(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_attendance_date() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: validate_attendance_entry(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_attendance_entry() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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

    -- 2. Authorization Check (marked_by must be an admin, the class teacher,
    --    an attendance-session teacher, or the exact-date substitute for that
    --    attendance-driving period).
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
$$;


--
-- Name: validate_diary_entry(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_diary_entry() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: validate_enrollment_year(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_enrollment_year() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: validate_fee_structure_mode(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_fee_structure_mode() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: validate_lms_course_modify(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_lms_course_modify() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: validate_marks_entry(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_marks_entry() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
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
$$;


--
-- Name: validate_timetable_entry(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_timetable_entry() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
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
        IF NOT EXISTS (
            SELECT 1 FROM class_subjects cs
            WHERE cs.class_section_id = NEW.class_section_id
              AND cs.teacher_id = NEW.teacher_id
              AND cs.subject_id = NEW.subject_id
              AND cs.deleted_at IS NULL
        ) THEN
            NULL;
        END IF;

        SELECT EXISTS (
            SELECT 1 FROM timetable_slots
            WHERE teacher_id = NEW.teacher_id
              AND period_number = NEW.period_number
              AND day_of_week = NEW.day_of_week
              AND academic_year_id = NEW.academic_year_id
              AND deleted_at IS NULL
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
              AND NOT (
                class_section_id = NEW.class_section_id
                AND academic_year_id = NEW.academic_year_id
                AND day_of_week = NEW.day_of_week
                AND period_number = NEW.period_number
              )
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
              AND NOT (
                class_section_id = NEW.class_section_id
                AND academic_year_id = NEW.academic_year_id
                AND day_of_week = NEW.day_of_week
                AND period_number = NEW.period_number
              )
        ) INTO v_room_collision;

        IF v_room_collision THEN
            RAISE EXCEPTION 'Room Collision: Room % is already occupied during period % on %', NEW.room_no, NEW.period_number, NEW.day_of_week;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: academic_years; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.academic_years (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying(20) NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    CONSTRAINT chk_academic_year CHECK ((start_date < end_date))
);

ALTER TABLE ONLY public.academic_years FORCE ROW LEVEL SECURITY;


--
-- Name: access_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.access_requests (
    school_id integer NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    requested_by uuid,
    department text NOT NULL,
    request_note text,
    status text DEFAULT 'pending'::text NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.access_requests FORCE ROW LEVEL SECURITY;


--
-- Name: persons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.persons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    first_name character varying(50) NOT NULL,
    middle_name character varying(50),
    last_name character varying(50),
    display_name text,
    dob date,
    gender_id smallint NOT NULL,
    nationality_code character(2),
    photo_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    CONSTRAINT chk_person_dob_past CHECK (((dob IS NULL) OR (dob <= CURRENT_DATE)))
);

ALTER TABLE ONLY public.persons FORCE ROW LEVEL SECURITY;


--
-- Name: active_persons; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.active_persons WITH (security_invoker='true') AS
 SELECT id,
    first_name,
    middle_name,
    last_name,
    display_name,
    dob,
    gender_id,
    nationality_code,
    photo_url,
    created_at,
    updated_at,
    deleted_at,
    school_id
   FROM public.persons
  WHERE (deleted_at IS NULL);


--
-- Name: student_statuses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_statuses (
    id smallint NOT NULL,
    code character varying(20) NOT NULL,
    is_terminal boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public.student_statuses FORCE ROW LEVEL SECURITY;


--
-- Name: students; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.students (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    person_id uuid NOT NULL,
    admission_no character varying(30) NOT NULL,
    admission_date date NOT NULL,
    category_id smallint,
    religion_id smallint,
    blood_group_id smallint,
    status_id smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    auth_user_id uuid,
    pen_number character varying(30),
    apar_number text,
    village character varying(100),
    exit_academic_year_id uuid,
    exit_date date,
    aadhaar_number character varying(12),
    tc_number character varying(50),
    previous_school boolean
);

ALTER TABLE ONLY public.students FORCE ROW LEVEL SECURITY;


--
-- Name: active_students; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.active_students WITH (security_invoker='true') AS
 SELECT id,
    person_id,
    admission_no,
    admission_date,
    category_id,
    religion_id,
    blood_group_id,
    status_id,
    created_at,
    updated_at,
    deleted_at,
    school_id
   FROM public.students
  WHERE ((deleted_at IS NULL) AND (status_id IN ( SELECT student_statuses.id
           FROM public.student_statuses
          WHERE ((student_statuses.code)::text = 'ENROLLED'::text))));


--
-- Name: activity_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    action text NOT NULL,
    actor_id uuid,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.activity_logs FORCE ROW LEVEL SECURITY;


--
-- Name: adj_receipt_no_seq_school_1; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.adj_receipt_no_seq_school_1
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: adj_receipt_no_seq_school_12; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.adj_receipt_no_seq_school_12
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: adj_receipt_no_seq_school_13; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.adj_receipt_no_seq_school_13
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: adj_receipt_no_seq_school_14; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.adj_receipt_no_seq_school_14
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: adj_receipt_no_seq_school_15; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.adj_receipt_no_seq_school_15
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: adj_receipt_no_seq_school_16; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.adj_receipt_no_seq_school_16
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: adj_receipt_no_seq_school_17; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.adj_receipt_no_seq_school_17
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: adj_receipt_no_seq_school_18; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.adj_receipt_no_seq_school_18
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_notifications (
    id integer NOT NULL,
    school_id integer NOT NULL,
    type character varying(50) NOT NULL,
    message text NOT NULL,
    user_id uuid,
    ip_address character varying(45),
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.admin_notifications FORCE ROW LEVEL SECURITY;


--
-- Name: admin_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_notifications_id_seq OWNED BY public.admin_notifications.id;


--
-- Name: admin_quick_action_daily_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_quick_action_daily_usage (
    school_id integer NOT NULL,
    usage_date date NOT NULL,
    action_key character varying(160) NOT NULL,
    click_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_quick_action_daily_usage_click_count_check CHECK ((click_count >= 0)),
    CONSTRAINT admin_quick_action_key_not_blank CHECK ((length(btrim((action_key)::text)) > 0))
);


--
-- Name: approval_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    type character varying(64) NOT NULL,
    requested_by uuid NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    payload jsonb NOT NULL,
    reason text,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_approval_requests_status CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'APPROVED'::character varying, 'REJECTED'::character varying])::text[])))
);


--
-- Name: attendance_interventions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_interventions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    student_id uuid NOT NULL,
    status character varying(30) DEFAULT 'not_reviewed'::character varying NOT NULL,
    notes text,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attendance_interventions_status_check CHECK (((status)::text = ANY ((ARRAY['not_reviewed'::character varying, 'parent_contacted'::character varying, 'monitoring'::character varying, 'resolved'::character varying])::text[])))
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    action text NOT NULL,
    entity text,
    entity_id text,
    details jsonb,
    ip_address text,
    user_agent text,
    request_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    school_id integer
);

ALTER TABLE ONLY public.audit_logs FORCE ROW LEVEL SECURITY;


--
-- Name: automation_execution_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_execution_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    rule_key character varying(60) NOT NULL,
    entity_type character varying(40) NOT NULL,
    entity_id character varying(64) NOT NULL,
    idempotency_key character varying(160) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    stage character varying(40),
    channel character varying(20) DEFAULT 'push'::character varying NOT NULL,
    recipient_user_ids jsonb DEFAULT '[]'::jsonb,
    payload jsonb DEFAULT '{}'::jsonb,
    scheduled_at timestamp with time zone DEFAULT now() NOT NULL,
    executed_at timestamp with time zone,
    error_summary text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_automation_exec_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'completed'::character varying, 'failed'::character varying, 'skipped'::character varying])::text[])))
);


--
-- Name: billing_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_clients (
    client_kind text NOT NULL,
    client_cluster_id text NOT NULL,
    client_external_id text NOT NULL,
    monthly_fee numeric(12,2),
    payment_link text,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    plan_name text DEFAULT 'NexSyrus School ERP'::text NOT NULL,
    billing_cycle text DEFAULT 'monthly'::text NOT NULL,
    subscription_status text DEFAULT 'active'::text NOT NULL,
    current_period_start date,
    current_period_end date,
    next_due_date date,
    amount_due numeric(12,2) DEFAULT 0 NOT NULL,
    currency character(3) DEFAULT 'INR'::bpchar NOT NULL,
    reminder_enabled boolean DEFAULT false NOT NULL,
    reminder_message character varying(280),
    last_paid_at timestamp with time zone,
    CONSTRAINT billing_clients_amount_due_check CHECK ((amount_due >= (0)::numeric)),
    CONSTRAINT billing_clients_billing_cycle_check CHECK ((billing_cycle = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'annual'::text, 'custom'::text]))),
    CONSTRAINT billing_clients_client_kind_check CHECK ((client_kind = ANY (ARRAY['school'::text, 'medical'::text]))),
    CONSTRAINT billing_clients_monthly_fee_check CHECK (((monthly_fee IS NULL) OR (monthly_fee >= (0)::numeric))),
    CONSTRAINT billing_clients_subscription_status_check CHECK ((subscription_status = ANY (ARRAY['trial'::text, 'active'::text, 'past_due'::text, 'paused'::text, 'cancelled'::text])))
);


--
-- Name: billing_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_config (
    id integer DEFAULT 1 NOT NULL,
    supplier_legal_name text,
    supplier_gstin text,
    supplier_state_code text,
    supplier_address text,
    invoice_prefix text DEFAULT 'NEX'::text NOT NULL,
    default_gst_rate numeric(4,2) DEFAULT 18.00 NOT NULL,
    default_sac_code text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    supplier_logo_url text,
    CONSTRAINT billing_config_id_check CHECK ((id = 1))
);


--
-- Name: billing_document_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_document_counters (
    financial_year text NOT NULL,
    document_type text NOT NULL,
    last_number integer DEFAULT 0 NOT NULL,
    CONSTRAINT billing_document_counters_document_type_check CHECK ((document_type = ANY (ARRAY['tax_invoice'::text, 'receipt'::text])))
);


--
-- Name: billing_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_number text NOT NULL,
    document_type text NOT NULL,
    financial_year text NOT NULL,
    client_id text,
    client_kind text,
    client_cluster_id text,
    client_legal_name text NOT NULL,
    client_gstin text,
    client_billing_address text NOT NULL,
    client_state_code text,
    supplier_gstin text NOT NULL,
    supplier_state_code text NOT NULL,
    place_of_supply_state_code text NOT NULL,
    line_items jsonb NOT NULL,
    taxable_value numeric(12,2) NOT NULL,
    cgst_rate numeric(4,2),
    cgst_amount numeric(12,2),
    sgst_rate numeric(4,2),
    sgst_amount numeric(12,2),
    igst_rate numeric(4,2),
    igst_amount numeric(12,2),
    total_amount numeric(12,2) NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    pdf_url text,
    issued_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT billing_documents_client_kind_check CHECK ((client_kind = ANY (ARRAY['school'::text, 'medical'::text]))),
    CONSTRAINT billing_documents_document_type_check CHECK ((document_type = ANY (ARRAY['tax_invoice'::text, 'receipt'::text]))),
    CONSTRAINT billing_documents_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'issued'::text, 'cancelled'::text])))
);


--
-- Name: blood_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blood_groups (
    id smallint NOT NULL,
    name character varying(10) NOT NULL
);

ALTER TABLE ONLY public.blood_groups FORCE ROW LEVEL SECURITY;


--
-- Name: blueprints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blueprints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    subject_id text NOT NULL,
    class_id text NOT NULL,
    title text NOT NULL,
    total_marks integer NOT NULL,
    sections jsonb NOT NULL,
    difficulty_distribution jsonb NOT NULL,
    bloom_distribution jsonb NOT NULL,
    created_by text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: bonafide_cert_seq_school_12_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bonafide_cert_seq_school_12_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bonafide_cert_seq_school_13_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bonafide_cert_seq_school_13_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bonafide_cert_seq_school_14_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bonafide_cert_seq_school_14_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bonafide_cert_seq_school_15_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bonafide_cert_seq_school_15_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bonafide_cert_seq_school_16_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bonafide_cert_seq_school_16_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bonafide_cert_seq_school_17_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bonafide_cert_seq_school_17_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bonafide_cert_seq_school_18_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bonafide_cert_seq_school_18_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bonafide_cert_seq_school_19_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bonafide_cert_seq_school_19_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bonafide_cert_seq_school_1_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bonafide_cert_seq_school_1_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bonafide_cert_seq_school_1_2099; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bonafide_cert_seq_school_1_2099
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bonafide_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bonafide_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bus_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bus_locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bus_id uuid NOT NULL,
    latitude numeric(10,8) NOT NULL,
    longitude numeric(11,8) NOT NULL,
    speed numeric(5,2),
    heading numeric(5,2),
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    is_mocked boolean DEFAULT false,
    is_suspicious boolean DEFAULT false
);

ALTER TABLE ONLY public.bus_locations FORCE ROW LEVEL SECURITY;


--
-- Name: bus_stop_attendance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bus_stop_attendance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    trip_id uuid NOT NULL,
    stop_id uuid NOT NULL,
    student_id uuid NOT NULL,
    route_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    attendance_date date DEFAULT CURRENT_DATE NOT NULL,
    status character varying(20) DEFAULT 'absent'::character varying NOT NULL,
    marked_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bus_stop_attendance_status_check CHECK (((status)::text = ANY ((ARRAY['present'::character varying, 'absent'::character varying])::text[])))
);


--
-- Name: bus_trip_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bus_trip_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    bus_id uuid NOT NULL,
    latitude double precision,
    longitude double precision,
    speed double precision,
    is_mocked boolean DEFAULT false,
    is_suspicious boolean DEFAULT false,
    recorded_at timestamp with time zone DEFAULT now(),
    heading double precision
);

ALTER TABLE ONLY public.bus_trip_history FORCE ROW LEVEL SECURITY;


--
-- Name: buses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.buses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    bus_no character varying(50) NOT NULL,
    registration_no character varying(50),
    capacity integer DEFAULT 40 NOT NULL,
    driver_id uuid,
    driver_name character varying(100),
    driver_phone character varying(20),
    route_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    speed_limit_override integer,
    CONSTRAINT chk_bus_capacity CHECK ((capacity > 0))
);

ALTER TABLE ONLY public.buses FORCE ROW LEVEL SECURITY;


--
-- Name: business_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.business_units (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    code text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    subscription_price numeric,
    subscription_plan text,
    phone text
);

ALTER TABLE ONLY public.business_units FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN business_units.subscription_price; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.business_units.subscription_price IS 'Optional subscription price for this unit (e.g. INR per billing period)';


--
-- Name: class_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.class_sections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    class_id uuid NOT NULL,
    section_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    class_teacher_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    manual_roll_numbers boolean DEFAULT false NOT NULL,
    roll_number_start integer DEFAULT 1 NOT NULL,
    CONSTRAINT class_sections_roll_number_start_positive CHECK (((roll_number_start >= 1) AND (roll_number_start <= 9999)))
);

ALTER TABLE ONLY public.class_sections FORCE ROW LEVEL SECURITY;


--
-- Name: class_subjects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.class_subjects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    class_section_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    teacher_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL
);

ALTER TABLE ONLY public.class_subjects FORCE ROW LEVEL SECURITY;


--
-- Name: classes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.classes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(50) NOT NULL,
    code character varying(20),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    sort_order integer DEFAULT 0
);

ALTER TABLE ONLY public.classes FORCE ROW LEVEL SECURITY;


--
-- Name: clusters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clusters (
    cluster_id text NOT NULL,
    label text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    school_backend_url text NOT NULL,
    medical_backend_url text NOT NULL,
    school_supabase_url text,
    medical_supabase_url text,
    school_anon_key text,
    medical_anon_key text,
    max_schools integer DEFAULT 40,
    school_count integer DEFAULT 0,
    medical_count integer DEFAULT 0,
    school_service_role_key text,
    medical_service_role_key text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: collections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_unit_id uuid,
    amount numeric DEFAULT 0 NOT NULL,
    month integer NOT NULL,
    year integer NOT NULL,
    payment_mode text DEFAULT 'CASH'::text NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    notes text,
    created_by_founder_id uuid,
    approved_by_founder_id uuid,
    rejection_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.collections FORCE ROW LEVEL SECURITY;


--
-- Name: complaint_ticket_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.complaint_ticket_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: complaints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.complaints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    ticket_no character varying(30),
    title character varying(200) NOT NULL,
    title_te text,
    description text NOT NULL,
    description_te text,
    category character varying(50),
    priority public.complaint_priority_enum DEFAULT 'medium'::public.complaint_priority_enum NOT NULL,
    status public.complaint_status_enum DEFAULT 'open'::public.complaint_status_enum NOT NULL,
    raised_by uuid NOT NULL,
    raised_for_student_id uuid,
    assigned_to uuid,
    resolution text,
    resolution_te text,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.complaints FORCE ROW LEVEL SECURITY;


--
-- Name: context_switch_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.context_switch_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    device_id text,
    from_context_id uuid,
    to_context_id uuid NOT NULL,
    switch_reason text DEFAULT 'user_initiated'::text NOT NULL,
    ip_address text,
    user_agent text,
    request_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    school_id integer
);


--
-- Name: enquiries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enquiries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text,
    email text,
    phone text,
    status text DEFAULT 'NEW'::text NOT NULL,
    source text,
    category text,
    assigned_to uuid,
    deal_value numeric,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    account_id uuid,
    priority text DEFAULT 'MEDIUM'::text NOT NULL,
    next_follow_up_at timestamp with time zone,
    last_activity_at timestamp with time zone,
    closed_reason text,
    converted_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT enquiries_priority_check CHECK ((priority = ANY (ARRAY['LOW'::text, 'MEDIUM'::text, 'HIGH'::text, 'URGENT'::text])))
);

ALTER TABLE ONLY public.enquiries FORCE ROW LEVEL SECURITY;


--
-- Name: conversion_rate; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.conversion_rate AS
 SELECT
        CASE
            WHEN (count(*) = 0) THEN (0)::numeric
            ELSE round((((count(*) FILTER (WHERE (status = 'CLOSED'::text)))::numeric / (count(*))::numeric) * (100)::numeric), 2)
        END AS conversion_rate
   FROM public.enquiries;


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_by uuid NOT NULL,
    title text NOT NULL,
    category text NOT NULL,
    amount numeric(12,2) NOT NULL,
    expense_date date DEFAULT CURRENT_DATE NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    description text,
    receipt_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    school_id integer,
    approved_by uuid,
    created_by_founder_id uuid,
    approved_by_founder_id uuid,
    rejection_reason text,
    CONSTRAINT expenses_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT expenses_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'paid'::text])))
);

ALTER TABLE ONLY public.expenses FORCE ROW LEVEL SECURITY;


--
-- Name: cost_per_lead; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.cost_per_lead AS
 SELECT
        CASE
            WHEN (( SELECT count(*) AS count
               FROM public.enquiries) = 0) THEN (0)::numeric
            ELSE round((( SELECT COALESCE(sum(expenses.amount), (0)::numeric) AS "coalesce"
               FROM public.expenses
              WHERE ((expenses.status = 'APPROVED'::text) AND (expenses.category = 'MARKETING'::text))) / (GREATEST(( SELECT count(*) AS count
               FROM public.enquiries), (1)::bigint))::numeric), 2)
        END AS cost_per_lead;


--
-- Name: countries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.countries (
    code character(2) NOT NULL,
    name character varying(100) NOT NULL
);

ALTER TABLE ONLY public.countries FORCE ROW LEVEL SECURITY;


--
-- Name: crm_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    account_type text DEFAULT 'PROSPECT'::text NOT NULL,
    vertical text DEFAULT 'OTHER'::text NOT NULL,
    lifecycle_stage text DEFAULT 'LEAD'::text NOT NULL,
    owner_founder_id uuid,
    external_client_id text,
    cluster_id text,
    website text,
    phone text,
    email text,
    billing_status text,
    health_score integer,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_accounts_account_type_check CHECK ((account_type = ANY (ARRAY['PROSPECT'::text, 'CUSTOMER'::text, 'PARTNER'::text, 'INACTIVE'::text]))),
    CONSTRAINT crm_accounts_health_score_check CHECK (((health_score IS NULL) OR ((health_score >= 0) AND (health_score <= 100)))),
    CONSTRAINT crm_accounts_lifecycle_stage_check CHECK ((lifecycle_stage = ANY (ARRAY['LEAD'::text, 'QUALIFIED'::text, 'ONBOARDING'::text, 'ACTIVE'::text, 'AT_RISK'::text, 'CHURNED'::text]))),
    CONSTRAINT crm_accounts_vertical_check CHECK ((vertical = ANY (ARRAY['SCHOOL'::text, 'MEDICAL'::text, 'RETAIL'::text, 'OTHER'::text])))
);


--
-- Name: crm_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    activity_type text NOT NULL,
    account_id uuid,
    enquiry_id uuid,
    task_id uuid,
    actor_id uuid,
    summary text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_activities_check CHECK (((account_id IS NOT NULL) OR (enquiry_id IS NOT NULL)))
);


--
-- Name: crm_automation_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_automation_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    trigger_event text NOT NULL,
    conditions jsonb DEFAULT '{}'::jsonb NOT NULL,
    actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crm_automation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_automation_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rule_id uuid,
    event_key text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid,
    status text DEFAULT 'PENDING'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_automation_runs_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'SUCCEEDED'::text, 'FAILED'::text, 'SKIPPED'::text])))
);


--
-- Name: crm_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    full_name text NOT NULL,
    role_title text,
    email text,
    phone text,
    is_primary boolean DEFAULT false NOT NULL,
    preferred_channel text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_contacts_preferred_channel_check CHECK (((preferred_channel IS NULL) OR (preferred_channel = ANY (ARRAY['PHONE'::text, 'EMAIL'::text, 'WHATSAPP'::text, 'IN_APP'::text]))))
);


--
-- Name: crm_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    task_type text DEFAULT 'FOLLOW_UP'::text NOT NULL,
    status text DEFAULT 'OPEN'::text NOT NULL,
    priority text DEFAULT 'MEDIUM'::text NOT NULL,
    owner_founder_id uuid,
    account_id uuid,
    enquiry_id uuid,
    due_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_by uuid,
    automation_rule_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_tasks_check CHECK (((account_id IS NOT NULL) OR (enquiry_id IS NOT NULL))),
    CONSTRAINT crm_tasks_priority_check CHECK ((priority = ANY (ARRAY['LOW'::text, 'MEDIUM'::text, 'HIGH'::text, 'URGENT'::text]))),
    CONSTRAINT crm_tasks_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'IN_PROGRESS'::text, 'COMPLETED'::text, 'CANCELLED'::text]))),
    CONSTRAINT crm_tasks_task_type_check CHECK ((task_type = ANY (ARRAY['FOLLOW_UP'::text, 'CALL'::text, 'EMAIL'::text, 'MEETING'::text, 'ONBOARDING'::text, 'COLLECTION'::text, 'APPROVAL'::text, 'OTHER'::text])))
);


--
-- Name: daily_attendance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_attendance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_enrollment_id uuid NOT NULL,
    attendance_date date NOT NULL,
    status public.attendance_status_enum NOT NULL,
    marked_by uuid,
    marked_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    remarks text,
    morning_status public.attendance_status_enum,
    afternoon_status public.attendance_status_enum,
    CONSTRAINT chk_attendance_date_past CHECK ((attendance_date <= CURRENT_DATE))
);

ALTER TABLE ONLY public.daily_attendance FORCE ROW LEVEL SECURITY;


--
-- Name: dcgd_programs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dcgd_programs (
    id integer NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    icon text DEFAULT 'ribbon-outline'::text NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.dcgd_programs FORCE ROW LEVEL SECURITY;


--
-- Name: dcgd_programs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dcgd_programs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dcgd_programs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dcgd_programs_id_seq OWNED BY public.dcgd_programs.id;


--
-- Name: dcgd_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dcgd_settings (
    id smallint DEFAULT 1 NOT NULL,
    page_title text DEFAULT 'DCGD'::text NOT NULL,
    subtitle text DEFAULT 'Department of Career Growth and Development'::text NOT NULL,
    is_visible boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dcgd_settings_singleton CHECK ((id = 1))
);

ALTER TABLE ONLY public.dcgd_settings FORCE ROW LEVEL SECURITY;


--
-- Name: sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(50) NOT NULL,
    code character varying(20),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL
);

ALTER TABLE ONLY public.sections FORCE ROW LEVEL SECURITY;


--
-- Name: staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    person_id uuid NOT NULL,
    staff_code character varying(30) NOT NULL,
    designation_id smallint,
    joining_date date NOT NULL,
    status_id smallint DEFAULT 1 NOT NULL,
    salary numeric(12,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    CONSTRAINT chk_staff_joining_past CHECK ((joining_date <= CURRENT_DATE))
);

ALTER TABLE ONLY public.staff FORCE ROW LEVEL SECURITY;


--
-- Name: debug_class_teachers; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.debug_class_teachers AS
 SELECT c.name AS class_name,
    s.name AS section_name,
    p.display_name AS teacher_name,
    ay.code AS academic_year
   FROM (((((public.class_sections cs
     JOIN public.classes c ON ((cs.class_id = c.id)))
     JOIN public.sections s ON ((cs.section_id = s.id)))
     JOIN public.academic_years ay ON ((cs.academic_year_id = ay.id)))
     LEFT JOIN public.staff st ON ((cs.class_teacher_id = st.id)))
     LEFT JOIN public.persons p ON ((st.person_id = p.id)));


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying(100) NOT NULL,
    name character varying(150) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL
);

ALTER TABLE ONLY public.permissions FORCE ROW LEVEL SECURITY;


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    role_id uuid NOT NULL,
    permission_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL
);

ALTER TABLE ONLY public.role_permissions FORCE ROW LEVEL SECURITY;


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(100) NOT NULL,
    is_system boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL
);

ALTER TABLE ONLY public.roles FORCE ROW LEVEL SECURITY;


--
-- Name: debug_role_permissions; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.debug_role_permissions AS
 SELECT r.code AS role,
    string_agg((p.code)::text, ', '::text) AS permissions
   FROM ((public.roles r
     LEFT JOIN public.role_permissions rp ON ((r.id = rp.role_id)))
     LEFT JOIN public.permissions p ON ((rp.permission_id = p.id)))
  GROUP BY r.code;


--
-- Name: defaulter_dues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.defaulter_dues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    student_id uuid NOT NULL,
    due_academic_year text NOT NULL,
    original_amount numeric(12,2) NOT NULL,
    paid_amount numeric(12,2) DEFAULT 0 NOT NULL,
    balance numeric(12,2) DEFAULT 0 NOT NULL,
    source public.defaulter_due_source NOT NULL,
    status public.defaulter_due_status DEFAULT 'pending'::public.defaulter_due_status NOT NULL,
    remarks text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT chk_defaulter_balance_nonneg CHECK ((balance >= (0)::numeric)),
    CONSTRAINT chk_defaulter_original_nonneg CHECK ((original_amount >= (0)::numeric)),
    CONSTRAINT chk_defaulter_paid_nonneg CHECK ((paid_amount >= (0)::numeric))
);


--
-- Name: defaulter_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.defaulter_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    defaulter_due_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    payment_method public.payment_method_enum NOT NULL,
    transaction_ref character varying(100) NOT NULL,
    received_by uuid,
    remarks text,
    paid_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_defaulter_payment_amount CHECK ((amount > (0)::numeric))
);


--
-- Name: diary_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.diary_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    class_section_id uuid NOT NULL,
    subject_id uuid,
    entry_date date NOT NULL,
    title character varying(200),
    title_te text,
    content text NOT NULL,
    content_te text,
    homework_due_date date,
    attachments jsonb,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT chk_homework_due_date CHECK (((homework_due_date IS NULL) OR (homework_due_date >= entry_date)))
);

ALTER TABLE ONLY public.diary_entries FORCE ROW LEVEL SECURITY;


--
-- Name: discipline_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discipline_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    incident_date date DEFAULT CURRENT_DATE NOT NULL,
    title character varying(200) NOT NULL,
    description text,
    severity character varying(20),
    action_taken text,
    evidence_urls text[],
    reported_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    CONSTRAINT discipline_records_severity_check CHECK (((severity)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'critical'::character varying])::text[])))
);

ALTER TABLE ONLY public.discipline_records FORCE ROW LEVEL SECURITY;


--
-- Name: driver_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_devices (
    driver_id uuid NOT NULL,
    school_id integer NOT NULL,
    device_id character varying NOT NULL,
    last_active timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.driver_devices FORCE ROW LEVEL SECURITY;


--
-- Name: driver_heartbeat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_heartbeat (
    driver_id uuid NOT NULL,
    school_id integer NOT NULL,
    last_ping timestamp with time zone DEFAULT now(),
    status character varying DEFAULT 'online'::character varying
);

ALTER TABLE ONLY public.driver_heartbeat FORCE ROW LEVEL SECURITY;


--
-- Name: driver_route_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_route_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    route_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: employee_code_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.employee_code_seq
    START WITH 1001
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: employee_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    payroll_run_id uuid,
    document_type text NOT NULL,
    document_number text NOT NULL,
    verification_token uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employee_documents_document_type_check CHECK ((document_type = ANY (ARRAY['PAYSLIP'::text, 'EMPLOYMENT_CERTIFICATE'::text, 'EXPERIENCE_CERTIFICATE'::text, 'INTERNSHIP_CERTIFICATE'::text, 'OFFER_LETTER'::text, 'RELIEVING_LETTER'::text])))
);


--
-- Name: employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_code text NOT NULL,
    full_name text NOT NULL,
    email text,
    phone text,
    designation text NOT NULL,
    department text NOT NULL,
    employment_type text DEFAULT 'FULL_TIME'::text NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    joining_date date NOT NULL,
    exit_date date,
    date_of_birth date,
    pan_number text,
    bank_account_number text,
    bank_ifsc text,
    basic_salary numeric(12,2) DEFAULT 0 NOT NULL,
    hra numeric(12,2) DEFAULT 0 NOT NULL,
    allowances numeric(12,2) DEFAULT 0 NOT NULL,
    fixed_deductions numeric(12,2) DEFAULT 0 NOT NULL,
    pf_enabled boolean DEFAULT false NOT NULL,
    esi_enabled boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employees_allowances_check CHECK ((allowances >= (0)::numeric)),
    CONSTRAINT employees_basic_salary_check CHECK ((basic_salary >= (0)::numeric)),
    CONSTRAINT employees_check CHECK (((exit_date IS NULL) OR (exit_date >= joining_date))),
    CONSTRAINT employees_employment_type_check CHECK ((employment_type = ANY (ARRAY['FULL_TIME'::text, 'PART_TIME'::text, 'CONTRACT'::text, 'INTERN'::text]))),
    CONSTRAINT employees_fixed_deductions_check CHECK ((fixed_deductions >= (0)::numeric)),
    CONSTRAINT employees_hra_check CHECK ((hra >= (0)::numeric)),
    CONSTRAINT employees_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'ON_LEAVE'::text, 'EXITED'::text])))
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title character varying(200) NOT NULL,
    title_te text,
    description text,
    description_te text,
    event_type public.event_type_enum DEFAULT 'other'::public.event_type_enum NOT NULL,
    start_date date NOT NULL,
    end_date date,
    start_time time without time zone,
    end_time time without time zone,
    location character varying(200),
    is_all_day boolean DEFAULT false NOT NULL,
    is_public boolean DEFAULT true NOT NULL,
    target_audience public.notice_audience_enum DEFAULT 'all'::public.notice_audience_enum,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    CONSTRAINT chk_event_dates CHECK (((end_date IS NULL) OR (end_date >= start_date)))
);

ALTER TABLE ONLY public.events FORCE ROW LEVEL SECURITY;


--
-- Name: exam_room_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exam_room_allocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    exam_id uuid NOT NULL,
    exam_date date NOT NULL,
    session_start time without time zone DEFAULT '00:00:00'::time without time zone NOT NULL,
    room_id uuid NOT NULL,
    invigilator_staff_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: exam_rooms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exam_rooms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    name character varying(100) NOT NULL,
    capacity integer DEFAULT 30 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    row_count integer DEFAULT 5 NOT NULL,
    column_count integer DEFAULT 6 NOT NULL,
    CONSTRAINT chk_exam_room_capacity CHECK ((capacity > 0)),
    CONSTRAINT chk_exam_room_columns CHECK (((column_count >= 1) AND (column_count <= 100))),
    CONSTRAINT chk_exam_room_geometry_capacity CHECK ((capacity = (row_count * column_count))),
    CONSTRAINT chk_exam_room_rows CHECK (((row_count >= 1) AND (row_count <= 100)))
);


--
-- Name: exam_seat_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exam_seat_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    room_allocation_id uuid NOT NULL,
    exam_id uuid NOT NULL,
    exam_date date NOT NULL,
    session_start time without time zone DEFAULT '00:00:00'::time without time zone NOT NULL,
    student_enrollment_id uuid NOT NULL,
    class_id uuid NOT NULL,
    seat_no integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: exam_subjects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exam_subjects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    exam_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    class_id uuid NOT NULL,
    exam_date date,
    max_marks numeric(7,2) DEFAULT 100 NOT NULL,
    passing_marks numeric(7,2) DEFAULT 35 NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    start_time time without time zone,
    end_time time without time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    syllabus jsonb,
    assessment_schema character varying(20) DEFAULT 'consolidated'::character varying NOT NULL,
    consolidated_max_marks numeric(7,2) DEFAULT 25 NOT NULL,
    participation_max_marks numeric(5,2) DEFAULT 10 NOT NULL,
    written_work_max_marks numeric(5,2) DEFAULT 10 NOT NULL,
    project_work_max_marks numeric(5,2) DEFAULT 10 NOT NULL,
    slip_test_max_marks numeric(5,2) DEFAULT 20 NOT NULL,
    CONSTRAINT chk_exam_subject_times CHECK (((start_time IS NULL) OR (end_time IS NULL) OR (end_time > start_time))),
    CONSTRAINT chk_marks_valid CHECK (((passing_marks <= max_marks) AND (max_marks > (0)::numeric))),
    CONSTRAINT exam_subjects_assessment_schema_check CHECK (((assessment_schema)::text = ANY ((ARRAY['component'::character varying, 'consolidated'::character varying])::text[]))),
    CONSTRAINT exam_subjects_component_max_positive_check CHECK (((participation_max_marks >= (1)::numeric) AND (participation_max_marks <= (999)::numeric) AND (written_work_max_marks >= (1)::numeric) AND (written_work_max_marks <= (999)::numeric) AND (project_work_max_marks >= (1)::numeric) AND (project_work_max_marks <= (999)::numeric) AND (slip_test_max_marks >= (1)::numeric) AND (slip_test_max_marks <= (999)::numeric)))
);

ALTER TABLE ONLY public.exam_subjects FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN exam_subjects.assessment_schema; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.exam_subjects.assessment_schema IS 'Active marks-entry schema: component or consolidated.';


--
-- Name: COLUMN exam_subjects.consolidated_max_marks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.exam_subjects.consolidated_max_marks IS 'Maximum retained for consolidated marks while component schema is active.';


--
-- Name: COLUMN exam_subjects.participation_max_marks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.exam_subjects.participation_max_marks IS 'Maximum for Children''s Participation Responses when component schema is active.';


--
-- Name: COLUMN exam_subjects.written_work_max_marks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.exam_subjects.written_work_max_marks IS 'Maximum for Written Work when component schema is active.';


--
-- Name: COLUMN exam_subjects.project_work_max_marks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.exam_subjects.project_work_max_marks IS 'Maximum for Project Work when component schema is active.';


--
-- Name: COLUMN exam_subjects.slip_test_max_marks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.exam_subjects.slip_test_max_marks IS 'Maximum for Slip Test when component schema is active.';


--
-- Name: exams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    academic_year_id uuid NOT NULL,
    exam_type character varying(50) NOT NULL,
    start_date date,
    end_date date,
    status public.exam_status_enum DEFAULT 'scheduled'::public.exam_status_enum NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    name_te text,
    timetable_published boolean DEFAULT false NOT NULL,
    timetable_published_at timestamp with time zone,
    timetable_params jsonb,
    allocation_params jsonb,
    results_published boolean DEFAULT false NOT NULL,
    results_published_at timestamp with time zone,
    results_published_by uuid,
    CONSTRAINT chk_exam_dates CHECK (((end_date IS NULL) OR (start_date IS NULL) OR (end_date >= start_date)))
);

ALTER TABLE ONLY public.exams FORCE ROW LEVEL SECURITY;


--
-- Name: feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_flags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    code character varying(100) NOT NULL,
    name character varying(200) NOT NULL,
    description text,
    is_enabled boolean DEFAULT false NOT NULL,
    target_roles text[],
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.feature_flags FORCE ROW LEVEL SECURITY;


--
-- Name: fee_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fee_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    student_id uuid NOT NULL,
    student_fee_id uuid,
    fee_component character varying(255) NOT NULL,
    amount numeric(12,2) NOT NULL,
    reason text NOT NULL,
    receipt_no character varying(50) NOT NULL,
    adjusted_by uuid NOT NULL,
    adjusted_by_name character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    adjustment_type text DEFAULT 'waive'::text NOT NULL,
    transport_fee_id uuid,
    CONSTRAINT chk_adj_amount CHECK ((amount >= (0)::numeric)),
    CONSTRAINT chk_fee_adjustments_adjustment_type CHECK ((adjustment_type = ANY (ARRAY['waive'::text, 'add'::text]))),
    CONSTRAINT chk_fee_adjustments_single_target CHECK ((num_nonnulls(student_fee_id, transport_fee_id) = 1))
);


--
-- Name: student_fees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_fees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_id uuid NOT NULL,
    fee_structure_id uuid NOT NULL,
    amount_due numeric(12,2) NOT NULL,
    amount_paid numeric(12,2) DEFAULT 0 NOT NULL,
    discount numeric(12,2) DEFAULT 0 NOT NULL,
    status public.fee_status_enum DEFAULT 'pending'::public.fee_status_enum NOT NULL,
    due_date date,
    period_month integer,
    period_year integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    school_id integer NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT chk_amounts CHECK (((amount_due >= (0)::numeric) AND (amount_paid >= (0)::numeric) AND (discount >= (0)::numeric))),
    CONSTRAINT chk_no_negative_paid CHECK ((amount_paid >= (0)::numeric)),
    CONSTRAINT chk_paid_not_exceed CHECK ((amount_paid <= (amount_due - discount)))
);

ALTER TABLE ONLY public.student_fees FORCE ROW LEVEL SECURITY;


--
-- Name: fee_installments; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.fee_installments AS
 SELECT id,
    student_id,
    amount_due,
    amount_paid,
    discount,
    status,
    due_date,
    created_at,
    updated_at,
    deleted_at
   FROM public.student_fees;


--
-- Name: fee_structures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fee_structures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    academic_year_id uuid NOT NULL,
    class_id uuid NOT NULL,
    fee_type_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    due_date date,
    frequency character varying(20) DEFAULT 'monthly'::character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    section_id uuid,
    mode_deactivated boolean DEFAULT false NOT NULL,
    CONSTRAINT chk_fee_amount_positive CHECK ((amount > (0)::numeric))
);

ALTER TABLE ONLY public.fee_structures FORCE ROW LEVEL SECURITY;


--
-- Name: fee_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fee_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_fee_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    payment_method public.payment_method_enum NOT NULL,
    transaction_ref character varying(100) NOT NULL,
    paid_at timestamp with time zone DEFAULT now() NOT NULL,
    received_by uuid,
    remarks text,
    refund_of uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    school_id integer NOT NULL,
    receipt_group uuid,
    CONSTRAINT chk_refund_must_be_negative CHECK (((refund_of IS NULL) OR (amount < (0)::numeric))),
    CONSTRAINT chk_transaction_amount CHECK ((((refund_of IS NULL) AND (amount > (0)::numeric)) OR ((refund_of IS NOT NULL) AND (amount < (0)::numeric))))
);

ALTER TABLE ONLY public.fee_transactions FORCE ROW LEVEL SECURITY;


--
-- Name: fee_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fee_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    code character varying(30),
    description text,
    is_recurring boolean DEFAULT true NOT NULL,
    is_optional boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    name_te text,
    description_te text,
    sort_order integer DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY public.fee_types FORCE ROW LEVEL SECURITY;


--
-- Name: festival_posters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.festival_posters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title character varying(120) NOT NULL,
    image_path text NOT NULL,
    target_apps text[] DEFAULT '{schoolims,medipos,paperforge}'::text[] NOT NULL,
    starts_at timestamp with time zone DEFAULT now() NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: financial_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.financial_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    table_name text NOT NULL,
    record_id text NOT NULL,
    action_type text NOT NULL,
    old_data jsonb,
    new_data jsonb,
    reason text,
    performed_by uuid,
    performed_at timestamp with time zone DEFAULT now(),
    metadata jsonb,
    school_id integer NOT NULL,
    CONSTRAINT financial_audit_logs_action_type_check CHECK ((action_type = ANY (ARRAY['DELETE'::text, 'UPDATE'::text, 'CREATE'::text])))
);

ALTER TABLE ONLY public.financial_audit_logs FORCE ROW LEVEL SECURITY;


--
-- Name: financial_policy_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.financial_policy_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    rule_code text NOT NULL,
    rule_name text NOT NULL,
    description text,
    value_type text,
    default_value jsonb NOT NULL,
    current_value jsonb NOT NULL,
    is_active boolean DEFAULT true,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT financial_policy_rules_value_type_check CHECK ((value_type = ANY (ARRAY['amount'::text, 'percentage'::text, 'boolean'::text, 'json'::text])))
);

ALTER TABLE ONLY public.financial_policy_rules FORCE ROW LEVEL SECURITY;


--
-- Name: founders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.founders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    email text,
    full_name text,
    role text DEFAULT 'FOUNDER'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.founders FORCE ROW LEVEL SECURITY;


--
-- Name: founder_lead_performance; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.founder_lead_performance AS
 SELECT f.full_name AS founder_name,
    count(e.id) AS leads,
    count(e.id) FILTER (WHERE (e.status = 'CLOSED'::text)) AS deals,
    COALESCE(sum(e.deal_value) FILTER (WHERE (e.status = 'CLOSED'::text)), (0)::numeric) AS revenue
   FROM (public.founders f
     LEFT JOIN public.enquiries e ON ((e.assigned_to = f.id)))
  GROUP BY f.id, f.full_name
  ORDER BY COALESCE(sum(e.deal_value) FILTER (WHERE (e.status = 'CLOSED'::text)), (0)::numeric) DESC, (count(e.id) FILTER (WHERE (e.status = 'CLOSED'::text))) DESC, (count(e.id)) DESC;


--
-- Name: genders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.genders (
    id smallint NOT NULL,
    name character varying(50) NOT NULL
);

ALTER TABLE ONLY public.genders FORCE ROW LEVEL SECURITY;


--
-- Name: generated_papers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generated_papers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    blueprint_id uuid,
    school_id integer NOT NULL,
    subject_id text NOT NULL,
    title text NOT NULL,
    total_marks integer NOT NULL,
    sections jsonb NOT NULL,
    created_by text NOT NULL,
    created_at text NOT NULL,
    pdf_url text
);


--
-- Name: grading_scales; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grading_scales (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    name character varying(50) NOT NULL,
    min_percentage numeric(5,2) NOT NULL,
    max_percentage numeric(5,2) NOT NULL,
    grade character varying(5) NOT NULL,
    grade_point numeric(3,1),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT chk_percentage_range CHECK (((min_percentage >= (0)::numeric) AND (max_percentage <= (100)::numeric) AND (min_percentage < max_percentage)))
);

ALTER TABLE ONLY public.grading_scales FORCE ROW LEVEL SECURITY;


--
-- Name: hostel_allocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hostel_allocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    student_id uuid NOT NULL,
    room_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    bed_no integer,
    allocated_at timestamp with time zone DEFAULT now() NOT NULL,
    vacated_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY public.hostel_allocations FORCE ROW LEVEL SECURITY;


--
-- Name: hostel_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hostel_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    name character varying(100) NOT NULL,
    code character varying(20),
    gender_id smallint,
    total_rooms integer,
    warden_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.hostel_blocks FORCE ROW LEVEL SECURITY;


--
-- Name: hostel_permission_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hostel_permission_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    student_id uuid NOT NULL,
    request_type character varying(40) NOT NULL,
    reason text NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    requested_by uuid,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    admin_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hostel_permission_request_dates_check CHECK ((ends_on >= starts_on)),
    CONSTRAINT hostel_permission_request_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying])::text[]))),
    CONSTRAINT hostel_permission_request_type_check CHECK (((request_type)::text = ANY ((ARRAY['outing'::character varying, 'overnight_leave'::character varying, 'late_return'::character varying, 'visitor'::character varying, 'other'::character varying])::text[])))
);


--
-- Name: hostel_rooms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hostel_rooms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    block_id uuid NOT NULL,
    room_no character varying(20) NOT NULL,
    floor integer,
    capacity integer DEFAULT 2 NOT NULL,
    room_type character varying(50) DEFAULT 'shared'::character varying,
    monthly_fee numeric(12,2),
    is_available boolean DEFAULT true NOT NULL,
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.hostel_rooms FORCE ROW LEVEL SECURITY;


--
-- Name: internal_user_permission_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.internal_user_permission_overrides (
    user_id uuid NOT NULL,
    permission text NOT NULL,
    effect text NOT NULL,
    changed_by uuid,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT internal_user_permission_overrides_effect_check CHECK ((effect = ANY (ARRAY['GRANT'::text, 'DENY'::text])))
);


--
-- Name: internal_user_schools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.internal_user_schools (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    school_id integer NOT NULL,
    assigned_by uuid,
    assigned_at timestamp with time zone DEFAULT now()
);


--
-- Name: internal_user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.internal_user_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    refresh_token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);


--
-- Name: internal_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.internal_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    auth_user_id uuid,
    full_name text NOT NULL,
    employee_id text NOT NULL,
    email text NOT NULL,
    phone text,
    password_hash text,
    role text NOT NULL,
    manager_id uuid,
    territory text,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    last_login timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    token_version integer DEFAULT 0 NOT NULL,
    CONSTRAINT internal_users_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text, 'SUSPENDED'::text, 'INVITED'::text])))
);


--
-- Name: issued_certificates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.issued_certificates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_id uuid,
    type text NOT NULL,
    serial_no text NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    data jsonb,
    created_at timestamp with time zone DEFAULT now(),
    school_id integer NOT NULL,
    issued_by uuid
);

ALTER TABLE ONLY public.issued_certificates FORCE ROW LEVEL SECURITY;


--
-- Name: leads_by_website; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.leads_by_website AS
 SELECT COALESCE(source, 'Unknown'::text) AS source,
    count(*) AS leads,
    count(*) FILTER (WHERE (status = 'CLOSED'::text)) AS deals,
    COALESCE(sum(deal_value) FILTER (WHERE (status = 'CLOSED'::text)), (0)::numeric) AS revenue
   FROM public.enquiries
  GROUP BY source
  ORDER BY (count(*)) DESC;


--
-- Name: leave_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leave_applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    applicant_id uuid NOT NULL,
    leave_type public.leave_type_enum NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    reason text NOT NULL,
    reason_te text,
    status public.leave_status_enum DEFAULT 'pending'::public.leave_status_enum NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    review_remarks text,
    review_remarks_te text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    school_id integer NOT NULL,
    CONSTRAINT chk_leave_dates CHECK ((end_date >= start_date))
);

ALTER TABLE ONLY public.leave_applications FORCE ROW LEVEL SECURITY;


--
-- Name: life_values_modules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.life_values_modules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title character varying(200) NOT NULL,
    description text,
    academic_year_id uuid,
    content_body text,
    banner_image_url text,
    quote_author character varying(100),
    highlight_quote text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    school_id integer NOT NULL,
    content_url text
);

ALTER TABLE ONLY public.life_values_modules FORCE ROW LEVEL SECURITY;


--
-- Name: lms_courses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lms_courses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title character varying(200) NOT NULL,
    description text,
    subject_id uuid,
    class_id uuid,
    instructor_id uuid,
    is_published boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL
);

ALTER TABLE ONLY public.lms_courses FORCE ROW LEVEL SECURITY;


--
-- Name: lms_materials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lms_materials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    course_id uuid NOT NULL,
    title character varying(200) NOT NULL,
    description text,
    material_type public.material_type_enum NOT NULL,
    content_url text,
    file_size integer,
    duration integer,
    sort_order integer DEFAULT 0 NOT NULL,
    is_published boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    view_count integer DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY public.lms_materials FORCE ROW LEVEL SECURITY;


--
-- Name: marks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    exam_subject_id uuid NOT NULL,
    student_enrollment_id uuid NOT NULL,
    marks_obtained numeric(5,2),
    is_absent boolean DEFAULT false NOT NULL,
    remarks text,
    remarks_te text,
    entered_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    consolidated_marks_obtained numeric(7,2),
    participation_marks numeric(5,2),
    written_work_marks numeric(5,2),
    project_work_marks numeric(5,2),
    slip_test_marks numeric(5,2),
    CONSTRAINT chk_marks_or_absent CHECK (((is_absent = true) OR (marks_obtained IS NOT NULL))),
    CONSTRAINT marks_consolidated_nonnegative_check CHECK (((consolidated_marks_obtained IS NULL) OR (consolidated_marks_obtained >= (0)::numeric))),
    CONSTRAINT marks_participation_nonnegative_check CHECK (((participation_marks IS NULL) OR (participation_marks >= (0)::numeric))),
    CONSTRAINT marks_project_work_nonnegative_check CHECK (((project_work_marks IS NULL) OR (project_work_marks >= (0)::numeric))),
    CONSTRAINT marks_slip_test_nonnegative_check CHECK (((slip_test_marks IS NULL) OR (slip_test_marks >= (0)::numeric))),
    CONSTRAINT marks_written_work_nonnegative_check CHECK (((written_work_marks IS NULL) OR (written_work_marks >= (0)::numeric)))
);

ALTER TABLE ONLY public.marks FORCE ROW LEVEL SECURITY;


--
-- Name: message_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    pair_type text NOT NULL,
    participant_low_user_id uuid,
    participant_high_user_id uuid,
    student_id uuid,
    subject text,
    last_message_at timestamp with time zone,
    last_message_preview text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    is_group boolean DEFAULT false NOT NULL,
    group_name text,
    group_mode text,
    created_by uuid,
    CONSTRAINT chk_message_conversations_group_mode CHECK (((group_mode IS NULL) OR (group_mode = ANY (ARRAY['broadcast'::text, 'chat'::text])))),
    CONSTRAINT chk_message_conversations_group_shape CHECK ((((is_group = true) AND (group_name IS NOT NULL) AND (group_mode IS NOT NULL)) OR ((is_group = false) AND (group_name IS NULL) AND (group_mode IS NULL)))),
    CONSTRAINT message_conversations_pair_type_check CHECK ((pair_type = ANY (ARRAY['parent_admin'::text, 'admin_teacher'::text, 'teacher_parent'::text, 'group'::text, 'support'::text])))
);


--
-- Name: message_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_participants (
    conversation_id uuid NOT NULL,
    school_id integer NOT NULL,
    user_id uuid NOT NULL,
    last_read_at timestamp with time zone,
    muted boolean DEFAULT false NOT NULL,
    is_group_admin boolean DEFAULT false NOT NULL,
    last_delivered_at timestamp with time zone
);


--
-- Name: message_typing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_typing (
    conversation_id uuid NOT NULL,
    school_id integer NOT NULL,
    user_id uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    school_id integer NOT NULL,
    sender_user_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    edited_at timestamp with time zone,
    deleted_at timestamp with time zone,
    client_msg_id text,
    reply_to_message_id uuid,
    forwarded_from_message_id uuid,
    CONSTRAINT messages_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 4000)))
);


--
-- Name: money_science_modules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.money_science_modules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title character varying(200) NOT NULL,
    description text,
    age_group character varying(50),
    content_body text,
    thumbnail_url text,
    estimated_duration integer,
    difficulty_level character varying(20) DEFAULT 'beginner'::character varying,
    tags text[],
    total_points integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    school_id integer NOT NULL,
    content_url text
);

ALTER TABLE ONLY public.money_science_modules FORCE ROW LEVEL SECURITY;


--
-- Name: monthly_closed_deals; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.monthly_closed_deals AS
 SELECT (EXTRACT(year FROM updated_at))::integer AS year,
    (EXTRACT(month FROM updated_at))::integer AS month,
    count(*) AS count,
    COALESCE(sum(deal_value), (0)::numeric) AS total_deal_value
   FROM public.enquiries
  WHERE (status = 'CLOSED'::text)
  GROUP BY ((EXTRACT(year FROM updated_at))::integer), ((EXTRACT(month FROM updated_at))::integer)
  ORDER BY ((EXTRACT(year FROM updated_at))::integer), ((EXTRACT(month FROM updated_at))::integer);


--
-- Name: monthly_enquiry_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.monthly_enquiry_summary AS
 SELECT (EXTRACT(year FROM created_at))::integer AS year,
    (EXTRACT(month FROM created_at))::integer AS month,
    count(*) AS total_enquiries,
    count(*) FILTER (WHERE (status = 'CLOSED'::text)) AS closed_count
   FROM public.enquiries
  GROUP BY ((EXTRACT(year FROM created_at))::integer), ((EXTRACT(month FROM created_at))::integer)
  ORDER BY ((EXTRACT(year FROM created_at))::integer), ((EXTRACT(month FROM created_at))::integer);


--
-- Name: monthly_expense_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.monthly_expense_summary AS
 SELECT (EXTRACT(year FROM created_at))::integer AS year,
    (EXTRACT(month FROM created_at))::integer AS month,
    sum(amount) AS total_amount
   FROM public.expenses
  WHERE (status = 'APPROVED'::text)
  GROUP BY ((EXTRACT(year FROM created_at))::integer), ((EXTRACT(month FROM created_at))::integer);


--
-- Name: monthly_expense_summary_v2; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.monthly_expense_summary_v2 AS
 SELECT (EXTRACT(year FROM created_at))::integer AS year,
    (EXTRACT(month FROM created_at))::integer AS month,
    category,
    sum(amount) AS total_amount
   FROM public.expenses
  WHERE (status = 'APPROVED'::text)
  GROUP BY ((EXTRACT(year FROM created_at))::integer), ((EXTRACT(month FROM created_at))::integer), category;


--
-- Name: monthly_income_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.monthly_income_summary AS
 SELECT year,
    month,
    COALESCE(sum(amount), (0)::numeric) AS total_amount,
    count(*) AS count
   FROM public.collections
  WHERE (status = 'APPROVED'::text)
  GROUP BY year, month
  ORDER BY year, month;


--
-- Name: notices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title character varying(200) NOT NULL,
    title_te text,
    content text NOT NULL,
    content_te text,
    audience public.notice_audience_enum DEFAULT 'all'::public.notice_audience_enum NOT NULL,
    target_class_id uuid,
    priority public.complaint_priority_enum DEFAULT 'medium'::public.complaint_priority_enum NOT NULL,
    is_pinned boolean DEFAULT false NOT NULL,
    publish_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    school_id integer NOT NULL,
    audiences public.notice_audience_enum[] DEFAULT ARRAY['all'::public.notice_audience_enum] NOT NULL
);

ALTER TABLE ONLY public.notices FORCE ROW LEVEL SECURITY;


--
-- Name: notification_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_audit_logs (
    school_id integer NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    delivery_id uuid,
    notification_id uuid,
    action character varying(50) NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.notification_audit_logs FORCE ROW LEVEL SECURITY;


--
-- Name: notification_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    admin_id uuid,
    type text NOT NULL,
    filters jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'pending'::text,
    total_targets integer DEFAULT 0,
    sent_count integer DEFAULT 0,
    failure_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    channel_type text,
    target_class_ids uuid[],
    tokens_targeted integer DEFAULT 0,
    no_token_count integer DEFAULT 0,
    parent_batch_id uuid,
    CONSTRAINT notification_batches_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'aborted'::text])))
);

ALTER TABLE ONLY public.notification_batches FORCE ROW LEVEL SECURITY;


--
-- Name: notification_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_config (
    key text NOT NULL,
    value jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.notification_config FORCE ROW LEVEL SECURITY;


--
-- Name: notification_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_deliveries (
    school_id integer NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    notification_id uuid NOT NULL,
    channel public.notification_channel NOT NULL,
    provider_message_id character varying(255),
    status public.notification_status DEFAULT 'PENDING'::public.notification_status NOT NULL,
    retry_count integer DEFAULT 0,
    next_retry_at timestamp with time zone,
    error_log text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    CONSTRAINT chk_max_retries CHECK ((retry_count <= 5)),
    CONSTRAINT chk_retry_time CHECK ((((status = 'FAILED'::public.notification_status) AND (next_retry_at IS NOT NULL)) OR (status <> 'FAILED'::public.notification_status)))
);

ALTER TABLE ONLY public.notification_deliveries FORCE ROW LEVEL SECURITY;


--
-- Name: notification_dispatch_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_dispatch_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    batch_id uuid NOT NULL,
    user_id uuid NOT NULL,
    fcm_token text,
    status text NOT NULL,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notification_dispatch_recipients_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'failed'::text, 'no_token'::text, 'skipped'::text])))
);


--
-- Name: notification_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_events (
    school_id integer NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    idempotency_key character varying(255) NOT NULL,
    event_type character varying(100) NOT NULL,
    actor_id uuid,
    target_user_id uuid NOT NULL,
    payload jsonb NOT NULL,
    status public.event_status DEFAULT 'RECEIVED'::public.event_status NOT NULL,
    error_reason text,
    created_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.notification_events FORCE ROW LEVEL SECURITY;


--
-- Name: notification_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    user_id uuid,
    batch_id uuid,
    notification_type text NOT NULL,
    role text,
    channel_id text,
    push_provider text DEFAULT 'fcm'::text,
    tokens_targeted integer DEFAULT 0 NOT NULL,
    tokens_sent integer DEFAULT 0 NOT NULL,
    tokens_failed integer DEFAULT 0 NOT NULL,
    error_message text,
    provider_response jsonb,
    status text,
    created_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    CONSTRAINT notification_logs_status_check CHECK ((status = ANY (ARRAY['success'::text, 'failed'::text, 'partial'::text])))
);

ALTER TABLE ONLY public.notification_logs FORCE ROW LEVEL SECURITY;


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preferences (
    school_id integer NOT NULL,
    user_id uuid NOT NULL,
    event_type character varying(100) NOT NULL,
    channel public.notification_channel NOT NULL,
    is_enabled boolean DEFAULT true,
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.notification_preferences FORCE ROW LEVEL SECURITY;


--
-- Name: notification_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_templates (
    school_id integer NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type character varying(100) NOT NULL,
    title_template text NOT NULL,
    body_template text NOT NULL,
    default_channels public.notification_channel[] NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.notification_templates FORCE ROW LEVEL SECURITY;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    school_id integer NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    user_id uuid NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    action_url text,
    status public.notification_status DEFAULT 'PENDING'::public.notification_status NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    read_at timestamp with time zone,
    expires_at timestamp with time zone,
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.notifications FORCE ROW LEVEL SECURITY;


--
-- Name: parent_visits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parent_visits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    student_id uuid NOT NULL,
    parent_id uuid,
    parent_name character varying(150) NOT NULL,
    relationship character varying(50),
    purpose text NOT NULL,
    notes text,
    visited_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT chk_parent_visit_name_not_blank CHECK ((length(btrim((parent_name)::text)) > 0)),
    CONSTRAINT chk_parent_visit_purpose_not_blank CHECK ((length(btrim(purpose)) > 0))
);


--
-- Name: parents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    person_id uuid NOT NULL,
    occupation character varying(100),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL
);

ALTER TABLE ONLY public.parents FORCE ROW LEVEL SECURITY;


--
-- Name: payroll_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_config (
    id integer DEFAULT 1 NOT NULL,
    organisation_name text DEFAULT 'NexSyrus'::text NOT NULL,
    organisation_address text,
    authorised_signatory text,
    authorised_signatory_title text DEFAULT 'Founder & CEO'::text,
    salary_day integer DEFAULT 28 NOT NULL,
    auto_process_enabled boolean DEFAULT true NOT NULL,
    pf_rate numeric(5,2) DEFAULT 12.00 NOT NULL,
    esi_rate numeric(5,2) DEFAULT 0.75 NOT NULL,
    esi_gross_limit numeric(12,2) DEFAULT 21000 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    authorised_signatory_image text,
    CONSTRAINT payroll_config_id_check CHECK ((id = 1)),
    CONSTRAINT payroll_config_salary_day_check CHECK (((salary_day >= 1) AND (salary_day <= 28)))
);


--
-- Name: payroll_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employee_id uuid NOT NULL,
    payroll_month integer NOT NULL,
    payroll_year integer NOT NULL,
    working_days numeric(5,2) NOT NULL,
    paid_days numeric(5,2) NOT NULL,
    basic_pay numeric(12,2) NOT NULL,
    hra_pay numeric(12,2) NOT NULL,
    allowance_pay numeric(12,2) NOT NULL,
    gross_pay numeric(12,2) NOT NULL,
    pf_deduction numeric(12,2) DEFAULT 0 NOT NULL,
    esi_deduction numeric(12,2) DEFAULT 0 NOT NULL,
    other_deductions numeric(12,2) DEFAULT 0 NOT NULL,
    total_deductions numeric(12,2) DEFAULT 0 NOT NULL,
    net_pay numeric(12,2) NOT NULL,
    status text DEFAULT 'PROCESSED'::text NOT NULL,
    calculation_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    processed_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payroll_runs_payroll_month_check CHECK (((payroll_month >= 1) AND (payroll_month <= 12))),
    CONSTRAINT payroll_runs_payroll_year_check CHECK (((payroll_year >= 2000) AND (payroll_year <= 2200))),
    CONSTRAINT payroll_runs_status_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'PROCESSED'::text, 'PAID'::text, 'FAILED'::text])))
);


--
-- Name: pending_metrics_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.pending_metrics_summary AS
 SELECT ( SELECT COALESCE(sum(collections.amount), (0)::numeric) AS "coalesce"
           FROM public.collections
          WHERE (collections.status = 'APPROVED'::text)) AS approved_income,
    ( SELECT COALESCE(sum(collections.amount), (0)::numeric) AS "coalesce"
           FROM public.collections
          WHERE (collections.status = 'PENDING'::text)) AS pending_collections,
    ( SELECT COALESCE(sum(expenses.amount), (0)::numeric) AS "coalesce"
           FROM public.expenses
          WHERE (expenses.status = 'APPROVED'::text)) AS approved_expenses,
    (( SELECT COALESCE(sum(collections.amount), (0)::numeric) AS "coalesce"
           FROM public.collections
          WHERE (collections.status = 'APPROVED'::text)) - ( SELECT COALESCE(sum(expenses.amount), (0)::numeric) AS "coalesce"
           FROM public.expenses
          WHERE (expenses.status = 'APPROVED'::text))) AS net_profit;


--
-- Name: periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(50) NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    school_id integer NOT NULL,
    is_break boolean DEFAULT false NOT NULL,
    CONSTRAINT chk_period_times CHECK ((end_time > start_time))
);

ALTER TABLE ONLY public.periods FORCE ROW LEVEL SECURITY;


--
-- Name: person_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.person_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    person_id uuid NOT NULL,
    contact_type public.contact_type_enum NOT NULL,
    contact_value text NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    is_emergency boolean DEFAULT false NOT NULL,
    is_verified boolean DEFAULT false NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL
);

ALTER TABLE ONLY public.person_contacts FORCE ROW LEVEL SECURITY;


--
-- Name: question_bank; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.question_bank (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    subject_id text NOT NULL,
    class_id text,
    content text NOT NULL,
    options jsonb,
    correct_answer text,
    difficulty_level text NOT NULL,
    bloom_level text NOT NULL,
    weightage integer NOT NULL,
    topics text,
    created_by text NOT NULL,
    created_at text NOT NULL,
    updated_at text,
    synced_at text,
    CONSTRAINT question_bank_bloom_level_check CHECK ((bloom_level = ANY (ARRAY['KNOWLEDGE'::text, 'UNDERSTANDING'::text, 'APPLICATION'::text, 'ANALYSIS'::text, 'EVALUATION'::text, 'CREATION'::text]))),
    CONSTRAINT question_bank_difficulty_level_check CHECK ((difficulty_level = ANY (ARRAY['EASY'::text, 'MEDIUM'::text, 'HARD'::text])))
);


--
-- Name: receipt_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receipt_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    receipt_id uuid NOT NULL,
    fee_transaction_id uuid NOT NULL,
    amount numeric(12,2) NOT NULL,
    school_id integer NOT NULL
);

ALTER TABLE ONLY public.receipt_items FORCE ROW LEVEL SECURITY;


--
-- Name: receipt_no_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.receipt_no_seq
    START WITH 1001
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: receipt_number_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receipt_number_counters (
    school_id integer NOT NULL,
    last_number bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT receipt_number_counters_last_number_check CHECK ((last_number >= 0))
);


--
-- Name: TABLE receipt_number_counters; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.receipt_number_counters IS 'Transaction-safe last issued receipt number, independently maintained per school.';


--
-- Name: receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    receipt_no character varying(30) NOT NULL,
    student_id uuid NOT NULL,
    total_amount numeric(12,2) NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    issued_by uuid,
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    payment_type public.receipt_payment_type DEFAULT 'fee'::public.receipt_payment_type NOT NULL,
    defaulter_payment_id uuid,
    fee_type character varying(30) DEFAULT 'tuition'::character varying NOT NULL,
    transport_payment_id uuid,
    receipt_group uuid
);

ALTER TABLE ONLY public.receipts FORCE ROW LEVEL SECURITY;


--
-- Name: relationship_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.relationship_types (
    id smallint NOT NULL,
    name character varying(50) NOT NULL
);

ALTER TABLE ONLY public.relationship_types FORCE ROW LEVEL SECURITY;


--
-- Name: religions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.religions (
    id smallint NOT NULL,
    name character varying(50) NOT NULL
);

ALTER TABLE ONLY public.religions FORCE ROW LEVEL SECURITY;


--
-- Name: route_leg_calibration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.route_leg_calibration (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    route_id uuid NOT NULL,
    trip_direction text NOT NULL,
    is_calibrated boolean DEFAULT false NOT NULL,
    stops_total integer DEFAULT 0 NOT NULL,
    stops_calibrated integer DEFAULT 0 NOT NULL,
    segments_total integer DEFAULT 0 NOT NULL,
    segments_learned integer DEFAULT 0 NOT NULL,
    clean_trip_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT route_leg_calibration_trip_direction_check CHECK ((trip_direction = ANY (ARRAY['morning'::text, 'evening'::text])))
);


--
-- Name: route_segment_time; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.route_segment_time (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    route_id uuid NOT NULL,
    trip_direction text NOT NULL,
    from_stop_id uuid NOT NULL,
    to_stop_id uuid NOT NULL,
    ewma_seconds numeric NOT NULL,
    ewvar_seconds numeric DEFAULT 0 NOT NULL,
    sample_count integer DEFAULT 0 NOT NULL,
    last_seconds numeric,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT route_segment_time_trip_direction_check CHECK ((trip_direction = ANY (ARRAY['morning'::text, 'evening'::text])))
);


--
-- Name: route_stop_geo; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.route_stop_geo (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    route_id uuid NOT NULL,
    stop_id uuid NOT NULL,
    trip_direction text NOT NULL,
    latitude numeric(10,8) NOT NULL,
    longitude numeric(11,8) NOT NULL,
    sample_weight numeric DEFAULT 0 NOT NULL,
    sample_count integer DEFAULT 0 NOT NULL,
    radius_m numeric DEFAULT 150 NOT NULL,
    last_accuracy_m numeric,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    CONSTRAINT route_stop_geo_trip_direction_check CHECK ((trip_direction = ANY (ARRAY['morning'::text, 'evening'::text])))
);


--
-- Name: saas_subscription_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saas_subscription_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    merchant_order_id character varying(63) NOT NULL,
    provider_order_id text,
    initiated_by uuid,
    amount numeric(12,2) NOT NULL,
    currency character(3) DEFAULT 'INR'::bpchar NOT NULL,
    gateway text DEFAULT 'phonepe'::text NOT NULL,
    status text DEFAULT 'initiated'::text NOT NULL,
    checkout_url text,
    provider_state text,
    provider_payload jsonb,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT saas_subscription_payments_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT saas_subscription_payments_gateway_check CHECK ((gateway = 'phonepe'::text)),
    CONSTRAINT saas_subscription_payments_status_check CHECK ((status = ANY (ARRAY['initiated'::text, 'pending'::text, 'completed'::text, 'failed'::text, 'expired'::text])))
);


--
-- Name: saas_subscription_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saas_subscription_receipts (
    id uuid NOT NULL,
    school_id integer NOT NULL,
    document_number text NOT NULL,
    financial_year text NOT NULL,
    total_amount numeric(12,2) NOT NULL,
    status text DEFAULT 'issued'::text NOT NULL,
    document_payload jsonb NOT NULL,
    issued_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT saas_subscription_receipts_status_check CHECK ((status = ANY (ARRAY['issued'::text, 'cancelled'::text]))),
    CONSTRAINT saas_subscription_receipts_total_amount_check CHECK ((total_amount >= (0)::numeric))
);


--
-- Name: saas_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saas_subscriptions (
    school_id integer NOT NULL,
    plan_name text DEFAULT 'NexSyrus School ERP'::text NOT NULL,
    billing_cycle text DEFAULT 'monthly'::text NOT NULL,
    subscription_status text DEFAULT 'active'::text NOT NULL,
    monthly_fee numeric(12,2),
    current_period_start date,
    current_period_end date,
    next_due_date date,
    amount_due numeric(12,2) DEFAULT 0 NOT NULL,
    currency character(3) DEFAULT 'INR'::bpchar NOT NULL,
    reminder_enabled boolean DEFAULT false NOT NULL,
    reminder_message character varying(280),
    last_paid_at timestamp with time zone,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT saas_subscriptions_amount_due_check CHECK ((amount_due >= (0)::numeric)),
    CONSTRAINT saas_subscriptions_billing_cycle_check CHECK ((billing_cycle = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'annual'::text, 'custom'::text]))),
    CONSTRAINT saas_subscriptions_subscription_status_check CHECK ((subscription_status = ANY (ARRAY['trial'::text, 'active'::text, 'past_due'::text, 'paused'::text, 'cancelled'::text])))
);


--
-- Name: schema_meta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_meta (
    key text NOT NULL,
    value text,
    applied_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.schema_meta FORCE ROW LEVEL SECURITY;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    filename text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: school_automation_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_automation_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    rule_key character varying(60) NOT NULL,
    is_enabled boolean DEFAULT false NOT NULL,
    trigger_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    action_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_triggered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: school_feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_feature_flags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    role text DEFAULT 'student'::text NOT NULL,
    feature_key text NOT NULL,
    enabled boolean NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: school_onboarding_checklists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_onboarding_checklists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    task_key text NOT NULL,
    title text NOT NULL,
    category text NOT NULL,
    status text DEFAULT 'NOT_STARTED'::text,
    blocker_reason text,
    notes text,
    completed_by uuid,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT school_onboarding_checklists_category_check CHECK ((category = ANY (ARRAY['CONTRACT_AND_SETUP'::text, 'DATA_INGESTION'::text, 'HARDWARE_AND_INFRA'::text, 'APP_BUILD'::text, 'TRAINING_AND_GO_LIVE'::text]))),
    CONSTRAINT school_onboarding_checklists_status_check CHECK ((status = ANY (ARRAY['NOT_STARTED'::text, 'IN_PROGRESS'::text, 'COMPLETED'::text, 'BLOCKED'::text, 'NOT_APPLICABLE'::text])))
);


--
-- Name: school_requirements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_requirements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    title text NOT NULL,
    description text,
    category text DEFAULT 'FEATURE'::text,
    priority text DEFAULT 'MEDIUM'::text,
    status text DEFAULT 'OPEN'::text,
    raised_by uuid,
    assigned_to uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    feasibility_status text,
    resolution_notes text,
    CONSTRAINT school_requirements_category_check CHECK ((category = ANY (ARRAY['PAYMENT'::text, 'CUSTOM_APP'::text, 'TRANSPORT'::text, 'ATTENDANCE'::text, 'ACADEMIC'::text, 'REPORTS'::text, 'FEATURE'::text, 'CUSTOMIZATION'::text, 'INTEGRATION'::text, 'DATA'::text, 'HARDWARE'::text, 'OTHER'::text]))),
    CONSTRAINT school_requirements_priority_check CHECK ((priority = ANY (ARRAY['LOW'::text, 'MEDIUM'::text, 'HIGH'::text, 'CRITICAL'::text]))),
    CONSTRAINT school_requirements_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'UNDER_REVIEW'::text, 'IN_DEVELOPMENT'::text, 'DEPLOYED'::text, 'REJECTED'::text])))
);


--
-- Name: school_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    key character varying(100) NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.school_settings FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE school_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.school_settings IS 'School-scoped key/value configuration, including the admin-controlled result_ranking_method.';


--
-- Name: school_website_gallery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_website_gallery (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    image_url text NOT NULL,
    storage_path text,
    alt_text character varying(180) DEFAULT 'School gallery photo'::character varying NOT NULL,
    caption character varying(180),
    category character varying(60) DEFAULT 'School Life'::character varying NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_school_website_gallery_alt_not_blank CHECK ((length(btrim((alt_text)::text)) > 0)),
    CONSTRAINT chk_school_website_gallery_category_not_blank CHECK ((length(btrim((category)::text)) > 0)),
    CONSTRAINT chk_school_website_gallery_url_not_blank CHECK ((length(btrim(image_url)) > 0))
);


--
-- Name: schools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schools (
    id integer NOT NULL,
    name text NOT NULL,
    code text NOT NULL,
    address text,
    logo_url text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cluster_id text DEFAULT 'cluster_a'::text,
    backend_url text,
    android_package text,
    ios_bundle_id text,
    primary_color text DEFAULT '#1A73E8'::text,
    onboarding_status text DEFAULT 'pending_build'::text,
    onboarding_completed_at timestamp with time zone,
    accounts_dashboard_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    minimum_app_version character varying(20) DEFAULT '1.0.0'::character varying NOT NULL,
    force_update_enabled boolean DEFAULT false NOT NULL,
    payment_banner_enabled boolean DEFAULT false NOT NULL,
    payment_banner_reason character varying(280),
    fee_mode text DEFAULT 'per_class'::text NOT NULL,
    timetable_mode text DEFAULT 'uniform'::text NOT NULL,
    payroll_distribution_blocked boolean DEFAULT false NOT NULL,
    accounts_staff_creation_enabled boolean DEFAULT true NOT NULL,
    partial_fee_payment_enabled boolean DEFAULT true NOT NULL,
    staff_payslips_enabled boolean DEFAULT true NOT NULL,
    partial_fee_direct_collect_enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT chk_schools_fee_mode CHECK ((fee_mode = ANY (ARRAY['per_class'::text, 'per_section'::text]))),
    CONSTRAINT chk_schools_timetable_mode CHECK ((timetable_mode = ANY (ARRAY['uniform'::text, 'per_day'::text]))),
    CONSTRAINT schools_onboarding_status_check CHECK ((onboarding_status = ANY (ARRAY['pending_build'::text, 'apk_delivered'::text, 'live'::text, 'suspended'::text])))
);

ALTER TABLE ONLY public.schools FORCE ROW LEVEL SECURITY;


--
-- Name: schools_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.schools_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: schools_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schools_id_seq OWNED BY public.schools.id;


--
-- Name: science_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.science_projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title character varying(200) NOT NULL,
    description text,
    difficulty_level character varying(20),
    is_group_project boolean DEFAULT false,
    min_participants integer DEFAULT 1,
    max_participants integer DEFAULT 1,
    materials_required text[],
    safety_instructions text,
    thumbnail_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    school_id integer NOT NULL,
    content_url text,
    CONSTRAINT science_projects_difficulty_level_check CHECK (((difficulty_level)::text = ANY ((ARRAY['beginner'::character varying, 'intermediate'::character varying, 'advanced'::character varying])::text[])))
);

ALTER TABLE ONLY public.science_projects FORCE ROW LEVEL SECURITY;


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    key text NOT NULL,
    value jsonb
);

ALTER TABLE ONLY public.settings FORCE ROW LEVEL SECURITY;


--
-- Name: staff_attendance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_attendance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    staff_id uuid NOT NULL,
    attendance_date date NOT NULL,
    status public.attendance_status_enum NOT NULL,
    marked_by uuid,
    marked_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.staff_attendance FORCE ROW LEVEL SECURITY;


--
-- Name: staff_designations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_designations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_designations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_designations (
    id smallint DEFAULT nextval('public.staff_designations_id_seq'::regclass) NOT NULL,
    school_id integer NOT NULL,
    name character varying(100) NOT NULL
);

ALTER TABLE ONLY public.staff_designations FORCE ROW LEVEL SECURITY;


--
-- Name: staff_payroll; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_payroll (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    staff_id uuid NOT NULL,
    base_salary numeric(12,2) NOT NULL,
    bonus numeric(12,2) DEFAULT 0,
    deductions numeric(12,2) DEFAULT 0,
    net_salary numeric(12,2) NOT NULL,
    status public.payroll_status_enum DEFAULT 'pending'::public.payroll_status_enum NOT NULL,
    payment_date date,
    payroll_month integer NOT NULL,
    payroll_year integer NOT NULL,
    payment_method character varying(50),
    remarks text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    salary_adjustment numeric(12,2) DEFAULT 0 NOT NULL,
    CONSTRAINT staff_payroll_payroll_month_check CHECK (((payroll_month >= 1) AND (payroll_month <= 12)))
);

ALTER TABLE ONLY public.staff_payroll FORCE ROW LEVEL SECURITY;


--
-- Name: staff_statuses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_statuses (
    id smallint NOT NULL,
    code character varying(20) NOT NULL,
    name character varying(50) NOT NULL
);

ALTER TABLE ONLY public.staff_statuses FORCE ROW LEVEL SECURITY;


--
-- Name: student_bulk_update_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_bulk_update_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    uploaded_by uuid,
    original_filename text,
    field_key character varying(50) NOT NULL,
    field_label character varying(100) NOT NULL,
    allow_blank_clear boolean DEFAULT false NOT NULL,
    status text DEFAULT 'preview'::text NOT NULL,
    total_rows integer DEFAULT 0 NOT NULL,
    valid_rows integer DEFAULT 0 NOT NULL,
    invalid_rows integer DEFAULT 0 NOT NULL,
    unchanged_rows integer DEFAULT 0 NOT NULL,
    success_rows integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    committed_at timestamp with time zone,
    CONSTRAINT student_bulk_update_batches_status_check CHECK ((status = ANY (ARRAY['preview'::text, 'committed'::text, 'failed'::text])))
);


--
-- Name: student_bulk_update_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_bulk_update_rows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    batch_id uuid NOT NULL,
    school_id integer NOT NULL,
    row_number integer NOT NULL,
    admission_no text,
    raw_value text,
    normalized_value text,
    new_display_value text,
    current_value text,
    student_id uuid,
    person_id uuid,
    status text DEFAULT 'valid'::text NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    CONSTRAINT student_bulk_update_rows_status_check CHECK ((status = ANY (ARRAY['valid'::text, 'invalid'::text, 'unchanged'::text, 'success'::text, 'failed'::text])))
);


--
-- Name: student_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_categories (
    id smallint NOT NULL,
    name character varying(50) NOT NULL
);

ALTER TABLE ONLY public.student_categories FORCE ROW LEVEL SECURITY;


--
-- Name: student_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_enrollments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    student_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    class_section_id uuid NOT NULL,
    status public.enrollment_status_enum DEFAULT 'active'::public.enrollment_status_enum NOT NULL,
    start_date date NOT NULL,
    end_date date,
    roll_number integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

ALTER TABLE ONLY public.student_enrollments FORCE ROW LEVEL SECURITY;


--
-- Name: student_life_values_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_life_values_progress (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    student_id uuid NOT NULL,
    module_id uuid NOT NULL,
    academic_year_id uuid NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    engagement_score integer DEFAULT 0,
    completed_at timestamp with time zone,
    last_accessed_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT student_life_values_progress_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'completed'::character varying])::text[])))
);

ALTER TABLE ONLY public.student_life_values_progress FORCE ROW LEVEL SECURITY;


--
-- Name: student_money_science_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_money_science_progress (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    student_id uuid NOT NULL,
    module_id uuid NOT NULL,
    status character varying(20) DEFAULT 'not_started'::character varying NOT NULL,
    progress_percentage integer DEFAULT 0,
    completed_at timestamp with time zone,
    last_accessed_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT student_money_science_progress_status_check CHECK (((status)::text = ANY ((ARRAY['not_started'::character varying, 'in_progress'::character varying, 'completed'::character varying])::text[])))
);

ALTER TABLE ONLY public.student_money_science_progress FORCE ROW LEVEL SECURITY;


--
-- Name: student_parents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_parents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    student_id uuid NOT NULL,
    parent_id uuid NOT NULL,
    relationship_id smallint,
    is_primary_contact boolean DEFAULT false NOT NULL,
    is_legal_guardian boolean DEFAULT false NOT NULL,
    valid_from date,
    valid_to date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    CONSTRAINT chk_parent_valid_range CHECK (((valid_from IS NULL) OR (valid_to IS NULL) OR (valid_to >= valid_from)))
);

ALTER TABLE ONLY public.student_parents FORCE ROW LEVEL SECURITY;


--
-- Name: student_science_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_science_projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    student_id uuid NOT NULL,
    project_id uuid NOT NULL,
    status character varying(20) DEFAULT 'registered'::character varying NOT NULL,
    submission_url text,
    teacher_remarks text,
    grade character varying(10),
    certified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT student_science_projects_status_check CHECK (((status)::text = ANY ((ARRAY['registered'::character varying, 'submitted'::character varying, 'evaluated'::character varying, 'certified'::character varying])::text[])))
);

ALTER TABLE ONLY public.student_science_projects FORCE ROW LEVEL SECURITY;


--
-- Name: student_transport; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_transport (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    student_id uuid NOT NULL,
    route_id uuid NOT NULL,
    stop_id uuid,
    bus_id uuid,
    academic_year_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.student_transport FORCE ROW LEVEL SECURITY;


--
-- Name: subjects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subjects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    code character varying(20),
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL,
    name_te text
);

ALTER TABLE ONLY public.subjects FORCE ROW LEVEL SECURITY;


--
-- Name: super_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.super_admins (
    id uuid NOT NULL,
    email text NOT NULL,
    full_name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login timestamp with time zone
);

ALTER TABLE ONLY public.super_admins FORCE ROW LEVEL SECURITY;


--
-- Name: support_message_notification_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_message_notification_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    school_id integer NOT NULL,
    target_user_id uuid NOT NULL,
    preview text NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    CONSTRAINT support_message_notification_outbox_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'PROCESSING'::text, 'SENT'::text, 'FAILED'::text])))
);


--
-- Name: support_ticket_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_ticket_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    school_id integer NOT NULL,
    sender_id uuid NOT NULL,
    sender_role character varying(30) NOT NULL,
    message text NOT NULL,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_internal boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: support_ticket_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_ticket_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id text NOT NULL,
    author_id uuid,
    author_name text,
    note text NOT NULL,
    is_internal boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: support_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    ticket_number character varying(32) NOT NULL,
    created_by uuid NOT NULL,
    parent_id uuid NOT NULL,
    student_id uuid,
    category character varying(50) NOT NULL,
    subject character varying(255) NOT NULL,
    description text NOT NULL,
    priority character varying(20) DEFAULT 'medium'::character varying NOT NULL,
    status character varying(30) DEFAULT 'open'::character varying NOT NULL,
    assigned_to uuid,
    assigned_department character varying(50),
    response_due_at timestamp with time zone,
    resolution_due_at timestamp with time zone,
    resolved_at timestamp with time zone,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT support_tickets_priority_check CHECK (((priority)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'urgent'::character varying])::text[]))),
    CONSTRAINT support_tickets_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'in_progress'::character varying, 'waiting_for_parent'::character varying, 'resolved'::character varying, 'closed'::character varying])::text[])))
);


--
-- Name: tc_cert_seq_school_14_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tc_cert_seq_school_14_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tc_cert_seq_school_15_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tc_cert_seq_school_15_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tc_cert_seq_school_16_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tc_cert_seq_school_16_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tc_cert_seq_school_17_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tc_cert_seq_school_17_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tc_cert_seq_school_18_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tc_cert_seq_school_18_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tc_cert_seq_school_19_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tc_cert_seq_school_19_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tc_cert_seq_school_1_2026; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tc_cert_seq_school_1_2026
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tc_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tc_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: temp_access_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temp_access_grants (
    school_id integer NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    department text NOT NULL,
    granted_by uuid,
    requested_by uuid,
    expires_at timestamp with time zone NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.temp_access_grants FORCE ROW LEVEL SECURITY;


--
-- Name: tenant_student_deletion_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_student_deletion_audit (
    id bigint NOT NULL,
    run_id uuid NOT NULL,
    school_id integer NOT NULL,
    table_name text NOT NULL,
    rows_deleted bigint NOT NULL,
    deleted_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_by text NOT NULL
);


--
-- Name: tenant_student_deletion_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.tenant_student_deletion_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.tenant_student_deletion_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ticket_number_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_number_counters (
    school_id integer NOT NULL,
    year integer NOT NULL,
    last_number bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_number_counters_last_number_check CHECK ((last_number >= 0))
);


--
-- Name: timetable_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.timetable_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    class_section_id uuid NOT NULL,
    subject_id uuid,
    teacher_id uuid,
    period_id uuid NOT NULL,
    day_of_week public.day_of_week_enum NOT NULL,
    room character varying(50),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.timetable_entries FORCE ROW LEVEL SECURITY;


--
-- Name: timetable_slots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.timetable_slots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    academic_year_id uuid NOT NULL,
    class_section_id uuid NOT NULL,
    day_of_week public.day_of_week_enum NOT NULL,
    period_number smallint NOT NULL,
    subject_id uuid NOT NULL,
    teacher_id uuid,
    room_no character varying(50),
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone,
    school_id integer,
    CONSTRAINT chk_time_order CHECK ((start_time < end_time))
);

ALTER TABLE ONLY public.timetable_slots FORCE ROW LEVEL SECURITY;


--
-- Name: timetable_substitutions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.timetable_substitutions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    academic_year_id uuid NOT NULL,
    substitution_date date NOT NULL,
    timetable_slot_id uuid NOT NULL,
    period_number smallint NOT NULL,
    absent_teacher_id uuid NOT NULL,
    substitute_teacher_id uuid NOT NULL,
    reason character varying(500),
    created_by uuid,
    cancelled_by uuid,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_auto_suggested boolean DEFAULT false NOT NULL,
    leave_application_id uuid,
    CONSTRAINT chk_substitution_different_teachers CHECK ((absent_teacher_id <> substitute_teacher_id)),
    CONSTRAINT timetable_substitutions_period_number_check CHECK ((period_number > 0))
);


--
-- Name: transport_fee; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transport_fee (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    route_id uuid NOT NULL,
    stop_id uuid NOT NULL,
    academic_year text NOT NULL,
    fee_amount numeric(12,2) NOT NULL,
    billing_cycle public.transport_billing_cycle DEFAULT 'term'::public.transport_billing_cycle NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_transport_fee_amount CHECK ((fee_amount >= (0)::numeric))
);


--
-- Name: transport_fee_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transport_fee_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    student_id uuid NOT NULL,
    academic_year text NOT NULL,
    transport_fee_id uuid,
    amount numeric(12,2) NOT NULL,
    payment_method public.payment_method_enum NOT NULL,
    transaction_ref character varying(100) NOT NULL,
    received_by uuid,
    remarks text,
    paid_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    refund_of uuid,
    CONSTRAINT chk_transport_payment_amount CHECK ((((refund_of IS NULL) AND (amount > (0)::numeric)) OR ((refund_of IS NOT NULL) AND (amount < (0)::numeric))))
);


--
-- Name: transport_import_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transport_import_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    uploaded_by uuid,
    original_filename text,
    academic_year_id uuid NOT NULL,
    status text DEFAULT 'preview'::text NOT NULL,
    total_rows integer DEFAULT 0 NOT NULL,
    valid_rows integer DEFAULT 0 NOT NULL,
    success_rows integer DEFAULT 0 NOT NULL,
    failed_rows integer DEFAULT 0 NOT NULL,
    skipped_rows integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    committed_at timestamp with time zone,
    CONSTRAINT transport_import_batches_status_check CHECK ((status = ANY (ARRAY['preview'::text, 'committed'::text, 'failed'::text])))
);


--
-- Name: transport_import_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transport_import_rows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    batch_id uuid NOT NULL,
    school_id integer NOT NULL,
    row_number integer NOT NULL,
    full_name text,
    admission_no text,
    stop_name text,
    student_id uuid,
    stop_id uuid,
    route_id uuid,
    route_name text,
    status text DEFAULT 'valid'::text NOT NULL,
    error_message text,
    warning_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT transport_import_rows_status_check CHECK ((status = ANY (ARRAY['valid'::text, 'invalid'::text, 'success'::text, 'failed'::text])))
);


--
-- Name: transport_routes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transport_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    code character varying(20),
    description text,
    start_point character varying(200),
    end_point character varying(200),
    total_stops integer,
    monthly_fee numeric(12,2),
    direction character varying(20) DEFAULT 'morning'::character varying,
    bus_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    school_id integer NOT NULL,
    name_te text,
    deleted_at timestamp with time zone,
    speed_limit_override integer,
    CONSTRAINT transport_routes_direction_check CHECK (((direction IS NULL) OR ((direction)::text = ANY ((ARRAY['morning'::character varying, 'afternoon'::character varying, 'evening'::character varying, 'both'::character varying])::text[]))))
);

ALTER TABLE ONLY public.transport_routes FORCE ROW LEVEL SECURITY;


--
-- Name: transport_safety_incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transport_safety_incidents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    incident_type character varying(30) NOT NULL,
    vehicle_id uuid,
    driver_id uuid,
    route_id uuid,
    trip_id uuid,
    student_id uuid,
    threshold_value numeric,
    max_value numeric,
    avg_value numeric,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    duration_seconds integer,
    start_latitude double precision,
    start_longitude double precision,
    status character varying(30) DEFAULT 'active'::character varying NOT NULL,
    acknowledged_by uuid,
    acknowledged_at timestamp with time zone,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    resolution_notes text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT transport_safety_incidents_incident_type_check CHECK (((incident_type)::text = ANY ((ARRAY['overspeed'::character varying, 'sos'::character varying, 'safeguarding_anomaly'::character varying])::text[]))),
    CONSTRAINT transport_safety_incidents_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'recovered'::character varying, 'verification_pending'::character varying, 'acknowledged'::character varying, 'resolved'::character varying, 'false_positive'::character varying])::text[])))
);


--
-- Name: transport_stops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transport_stops (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    route_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    latitude numeric(10,8),
    longitude numeric(11,8),
    pickup_time time without time zone,
    drop_time time without time zone,
    stop_order integer NOT NULL,
    deleted_at timestamp with time zone,
    name_te text
);

ALTER TABLE ONLY public.transport_stops FORCE ROW LEVEL SECURITY;


--
-- Name: trip_stop_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip_stop_status (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    trip_id uuid NOT NULL,
    stop_id uuid NOT NULL,
    stop_order integer NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    arrival_time timestamp with time zone,
    departure_time timestamp with time zone,
    approach_notified_at timestamp with time zone,
    arrival_source text,
    geofence_hits integer DEFAULT 0 NOT NULL,
    first_seen_in_radius timestamp with time zone,
    CONSTRAINT trip_stop_status_arrival_source_check CHECK ((arrival_source = ANY (ARRAY['manual'::text, 'geofence'::text, 'timeout'::text]))),
    CONSTRAINT trip_stop_status_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'arrived'::character varying, 'completed'::character varying, 'skipped'::character varying])::text[])))
);

ALTER TABLE ONLY public.trip_stop_status FORCE ROW LEVEL SECURITY;


--
-- Name: trips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trips (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bus_id uuid NOT NULL,
    route_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    school_id integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    trip_date date,
    trip_direction character varying(20),
    late_notified_at timestamp with time zone,
    CONSTRAINT trips_status_check CHECK (((status)::text = ANY ((ARRAY['scheduled'::character varying, 'active'::character varying, 'in_progress'::character varying, 'completed'::character varying, 'cancelled'::character varying])::text[])))
);

ALTER TABLE ONLY public.trips FORCE ROW LEVEL SECURITY;


--
-- Name: ui_route_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ui_route_permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    route_key character varying(100) NOT NULL,
    route_label character varying(200) NOT NULL,
    required_permissions text[] DEFAULT '{}'::text[] NOT NULL,
    required_roles text[],
    requires_feature_flag character varying(100),
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.ui_route_permissions FORCE ROW LEVEL SECURITY;


--
-- Name: user_access_contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_access_contexts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    school_id integer NOT NULL,
    context_key text NOT NULL,
    portal_type public.portal_type_enum NOT NULL,
    role_codes text[] DEFAULT '{}'::text[] NOT NULL,
    student_id uuid,
    staff_id uuid,
    parent_id uuid,
    display_name text NOT NULL,
    subtitle text,
    photo_url text,
    sort_order integer DEFAULT 0 NOT NULL,
    source text DEFAULT 'direct_role'::text NOT NULL,
    is_switchable boolean DEFAULT true NOT NULL,
    valid_from timestamp with time zone,
    valid_to timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: user_active_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_active_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    device_id text NOT NULL,
    active_context_id uuid,
    session_fingerprint text,
    last_switched_at timestamp with time zone,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id integer NOT NULL,
    user_id uuid NOT NULL,
    fcm_token text NOT NULL,
    platform character varying(20) DEFAULT 'unknown'::character varying NOT NULL,
    device_name text,
    is_active boolean DEFAULT true NOT NULL,
    language_code character varying(5) DEFAULT 'en'::character varying NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.user_devices FORCE ROW LEVEL SECURITY;


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    granted_by uuid,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    school_id integer NOT NULL
);

ALTER TABLE ONLY public.user_roles FORCE ROW LEVEL SECURITY;


--
-- Name: user_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_settings (
    user_id uuid NOT NULL,
    notification_sound character varying(20) DEFAULT 'custom'::character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    school_id integer NOT NULL,
    CONSTRAINT user_settings_notification_sound_check CHECK (((notification_sound)::text = ANY ((ARRAY['custom'::character varying, 'default'::character varying])::text[])))
);

ALTER TABLE ONLY public.user_settings FORCE ROW LEVEL SECURITY;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    person_id uuid NOT NULL,
    account_status public.account_status_enum DEFAULT 'active'::public.account_status_enum NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone,
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    school_id integer NOT NULL,
    theme text DEFAULT 'light'::text,
    deleted_at timestamp with time zone,
    is_super_admin boolean DEFAULT false,
    is_temporary_password boolean DEFAULT false,
    unrestricted_access boolean DEFAULT false NOT NULL,
    unrestricted_access_granted_by uuid,
    unrestricted_access_granted_at timestamp with time zone,
    last_active_at timestamp with time zone,
    is_support_bot boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY public.users FORCE ROW LEVEL SECURITY;


--
-- Name: admin_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notifications ALTER COLUMN id SET DEFAULT nextval('public.admin_notifications_id_seq'::regclass);


--
-- Name: dcgd_programs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dcgd_programs ALTER COLUMN id SET DEFAULT nextval('public.dcgd_programs_id_seq'::regclass);


--
-- Name: schools id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schools ALTER COLUMN id SET DEFAULT nextval('public.schools_id_seq'::regclass);


--
-- Name: academic_years academic_years_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.academic_years
    ADD CONSTRAINT academic_years_pkey PRIMARY KEY (id);


--
-- Name: access_requests access_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_requests
    ADD CONSTRAINT access_requests_pkey PRIMARY KEY (id);


--
-- Name: activity_logs activity_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_logs
    ADD CONSTRAINT activity_logs_pkey PRIMARY KEY (id);


--
-- Name: admin_notifications admin_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notifications
    ADD CONSTRAINT admin_notifications_pkey PRIMARY KEY (id);


--
-- Name: admin_quick_action_daily_usage admin_quick_action_daily_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_quick_action_daily_usage
    ADD CONSTRAINT admin_quick_action_daily_usage_pkey PRIMARY KEY (school_id, usage_date, action_key);


--
-- Name: approval_requests approval_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_pkey PRIMARY KEY (id);


--
-- Name: attendance_interventions attendance_interventions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_interventions
    ADD CONSTRAINT attendance_interventions_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: automation_execution_logs automation_execution_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_execution_logs
    ADD CONSTRAINT automation_execution_logs_pkey PRIMARY KEY (id);


--
-- Name: billing_clients billing_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_clients
    ADD CONSTRAINT billing_clients_pkey PRIMARY KEY (client_kind, client_cluster_id, client_external_id);


--
-- Name: billing_config billing_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_config
    ADD CONSTRAINT billing_config_pkey PRIMARY KEY (id);


--
-- Name: billing_document_counters billing_document_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_document_counters
    ADD CONSTRAINT billing_document_counters_pkey PRIMARY KEY (financial_year, document_type);


--
-- Name: billing_documents billing_documents_document_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_documents
    ADD CONSTRAINT billing_documents_document_number_key UNIQUE (document_number);


--
-- Name: billing_documents billing_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_documents
    ADD CONSTRAINT billing_documents_pkey PRIMARY KEY (id);


--
-- Name: blood_groups blood_groups_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blood_groups
    ADD CONSTRAINT blood_groups_name_key UNIQUE (name);


--
-- Name: blood_groups blood_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blood_groups
    ADD CONSTRAINT blood_groups_pkey PRIMARY KEY (id);


--
-- Name: blueprints blueprints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blueprints
    ADD CONSTRAINT blueprints_pkey PRIMARY KEY (id);


--
-- Name: bus_locations bus_locations_bus_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_locations
    ADD CONSTRAINT bus_locations_bus_id_key UNIQUE (bus_id);


--
-- Name: bus_locations bus_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_locations
    ADD CONSTRAINT bus_locations_pkey PRIMARY KEY (id);


--
-- Name: bus_stop_attendance bus_stop_attendance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_stop_attendance
    ADD CONSTRAINT bus_stop_attendance_pkey PRIMARY KEY (id);


--
-- Name: bus_stop_attendance bus_stop_attendance_school_id_trip_id_stop_id_student_id_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_stop_attendance
    ADD CONSTRAINT bus_stop_attendance_school_id_trip_id_stop_id_student_id_at_key UNIQUE (school_id, trip_id, stop_id, student_id, attendance_date);


--
-- Name: bus_trip_history bus_trip_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_trip_history
    ADD CONSTRAINT bus_trip_history_pkey PRIMARY KEY (id);


--
-- Name: buses buses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buses
    ADD CONSTRAINT buses_pkey PRIMARY KEY (id);


--
-- Name: buses buses_school_id_bus_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buses
    ADD CONSTRAINT buses_school_id_bus_no_key UNIQUE (school_id, bus_no);


--
-- Name: buses buses_school_id_registration_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buses
    ADD CONSTRAINT buses_school_id_registration_no_key UNIQUE (school_id, registration_no);


--
-- Name: business_units business_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_units
    ADD CONSTRAINT business_units_pkey PRIMARY KEY (id);


--
-- Name: student_fees chk_discount_not_exceed_due; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.student_fees
    ADD CONSTRAINT chk_discount_not_exceed_due CHECK ((discount <= amount_due)) NOT VALID;


--
-- Name: notification_batches chk_notification_batches_type; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.notification_batches
    ADD CONSTRAINT chk_notification_batches_type CHECK ((type = ANY (ARRAY['FEES'::text, 'GENERAL'::text, 'EXAM'::text, 'EMERGENCY'::text, 'ATTENDANCE'::text, 'CUSTOM'::text, 'DIARY'::text, 'RESULTS'::text, 'NOTICE'::text, 'TEST_TRIGGER'::text, 'BROADCAST'::text]))) NOT VALID;


--
-- Name: staff_attendance chk_staff_attendance_date_past; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.staff_attendance
    ADD CONSTRAINT chk_staff_attendance_date_past CHECK ((attendance_date <= CURRENT_DATE)) NOT VALID;


--
-- Name: class_sections class_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_sections
    ADD CONSTRAINT class_sections_pkey PRIMARY KEY (id);


--
-- Name: class_sections class_sections_school_id_class_id_section_id_academic_year__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_sections
    ADD CONSTRAINT class_sections_school_id_class_id_section_id_academic_year__key UNIQUE (school_id, class_id, section_id, academic_year_id);


--
-- Name: class_subjects class_subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_subjects
    ADD CONSTRAINT class_subjects_pkey PRIMARY KEY (id);


--
-- Name: classes classes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_pkey PRIMARY KEY (id);


--
-- Name: clusters clusters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clusters
    ADD CONSTRAINT clusters_pkey PRIMARY KEY (cluster_id);


--
-- Name: collections collections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_pkey PRIMARY KEY (id);


--
-- Name: complaints complaints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.complaints
    ADD CONSTRAINT complaints_pkey PRIMARY KEY (id);


--
-- Name: complaints complaints_school_id_ticket_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.complaints
    ADD CONSTRAINT complaints_school_id_ticket_no_key UNIQUE (school_id, ticket_no);


--
-- Name: context_switch_logs context_switch_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_switch_logs
    ADD CONSTRAINT context_switch_logs_pkey PRIMARY KEY (id);


--
-- Name: countries countries_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.countries
    ADD CONSTRAINT countries_name_key UNIQUE (name);


--
-- Name: countries countries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.countries
    ADD CONSTRAINT countries_pkey PRIMARY KEY (code);


--
-- Name: crm_accounts crm_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_accounts
    ADD CONSTRAINT crm_accounts_pkey PRIMARY KEY (id);


--
-- Name: crm_activities crm_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activities
    ADD CONSTRAINT crm_activities_pkey PRIMARY KEY (id);


--
-- Name: crm_automation_rules crm_automation_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_automation_rules
    ADD CONSTRAINT crm_automation_rules_pkey PRIMARY KEY (id);


--
-- Name: crm_automation_runs crm_automation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_automation_runs
    ADD CONSTRAINT crm_automation_runs_pkey PRIMARY KEY (id);


--
-- Name: crm_automation_runs crm_automation_runs_rule_id_event_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_automation_runs
    ADD CONSTRAINT crm_automation_runs_rule_id_event_key_key UNIQUE (rule_id, event_key);


--
-- Name: crm_contacts crm_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contacts
    ADD CONSTRAINT crm_contacts_pkey PRIMARY KEY (id);


--
-- Name: crm_tasks crm_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tasks
    ADD CONSTRAINT crm_tasks_pkey PRIMARY KEY (id);


--
-- Name: daily_attendance daily_attendance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_attendance
    ADD CONSTRAINT daily_attendance_pkey PRIMARY KEY (id);


--
-- Name: dcgd_programs dcgd_programs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dcgd_programs
    ADD CONSTRAINT dcgd_programs_pkey PRIMARY KEY (id);


--
-- Name: dcgd_settings dcgd_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dcgd_settings
    ADD CONSTRAINT dcgd_settings_pkey PRIMARY KEY (id);


--
-- Name: defaulter_dues defaulter_dues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.defaulter_dues
    ADD CONSTRAINT defaulter_dues_pkey PRIMARY KEY (id);


--
-- Name: defaulter_payments defaulter_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.defaulter_payments
    ADD CONSTRAINT defaulter_payments_pkey PRIMARY KEY (id);


--
-- Name: diary_entries diary_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diary_entries
    ADD CONSTRAINT diary_entries_pkey PRIMARY KEY (id);


--
-- Name: diary_entries diary_entries_school_id_class_section_id_subject_id_entry_d_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diary_entries
    ADD CONSTRAINT diary_entries_school_id_class_section_id_subject_id_entry_d_key UNIQUE (school_id, class_section_id, subject_id, entry_date, created_by);


--
-- Name: discipline_records discipline_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discipline_records
    ADD CONSTRAINT discipline_records_pkey PRIMARY KEY (id);


--
-- Name: driver_devices driver_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_devices
    ADD CONSTRAINT driver_devices_pkey PRIMARY KEY (school_id, driver_id);


--
-- Name: driver_heartbeat driver_heartbeat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_heartbeat
    ADD CONSTRAINT driver_heartbeat_pkey PRIMARY KEY (school_id, driver_id);


--
-- Name: driver_route_assignments driver_route_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_route_assignments
    ADD CONSTRAINT driver_route_assignments_pkey PRIMARY KEY (id);


--
-- Name: driver_route_assignments driver_route_assignments_school_id_route_id_driver_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_route_assignments
    ADD CONSTRAINT driver_route_assignments_school_id_route_id_driver_id_key UNIQUE (school_id, route_id, driver_id);


--
-- Name: employee_documents employee_documents_document_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_document_number_key UNIQUE (document_number);


--
-- Name: employee_documents employee_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_pkey PRIMARY KEY (id);


--
-- Name: employees employees_employee_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_employee_code_key UNIQUE (employee_code);


--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);


--
-- Name: enquiries enquiries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: exam_room_allocations exam_room_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_room_allocations
    ADD CONSTRAINT exam_room_allocations_pkey PRIMARY KEY (id);


--
-- Name: exam_rooms exam_rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_rooms
    ADD CONSTRAINT exam_rooms_pkey PRIMARY KEY (id);


--
-- Name: exam_seat_assignments exam_seat_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_seat_assignments
    ADD CONSTRAINT exam_seat_assignments_pkey PRIMARY KEY (id);


--
-- Name: exam_subjects exam_subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_subjects
    ADD CONSTRAINT exam_subjects_pkey PRIMARY KEY (id);


--
-- Name: exams exams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: feature_flags feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (id);


--
-- Name: fee_adjustments fee_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_adjustments
    ADD CONSTRAINT fee_adjustments_pkey PRIMARY KEY (id);


--
-- Name: fee_structures fee_structures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_pkey PRIMARY KEY (id);


--
-- Name: fee_transactions fee_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_transactions
    ADD CONSTRAINT fee_transactions_pkey PRIMARY KEY (id);


--
-- Name: fee_types fee_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_types
    ADD CONSTRAINT fee_types_pkey PRIMARY KEY (id);


--
-- Name: festival_posters festival_posters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.festival_posters
    ADD CONSTRAINT festival_posters_pkey PRIMARY KEY (id);


--
-- Name: financial_audit_logs financial_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_audit_logs
    ADD CONSTRAINT financial_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: financial_policy_rules financial_policy_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_policy_rules
    ADD CONSTRAINT financial_policy_rules_pkey PRIMARY KEY (id);


--
-- Name: financial_policy_rules financial_policy_rules_school_id_rule_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_policy_rules
    ADD CONSTRAINT financial_policy_rules_school_id_rule_code_key UNIQUE (school_id, rule_code);


--
-- Name: founders founders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.founders
    ADD CONSTRAINT founders_pkey PRIMARY KEY (id);


--
-- Name: genders genders_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.genders
    ADD CONSTRAINT genders_name_key UNIQUE (name);


--
-- Name: genders genders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.genders
    ADD CONSTRAINT genders_pkey PRIMARY KEY (id);


--
-- Name: generated_papers generated_papers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_papers
    ADD CONSTRAINT generated_papers_pkey PRIMARY KEY (id);


--
-- Name: grading_scales grading_scales_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grading_scales
    ADD CONSTRAINT grading_scales_pkey PRIMARY KEY (id);


--
-- Name: hostel_allocations hostel_allocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_allocations
    ADD CONSTRAINT hostel_allocations_pkey PRIMARY KEY (id);


--
-- Name: hostel_allocations hostel_allocations_school_id_student_id_academic_year_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_allocations
    ADD CONSTRAINT hostel_allocations_school_id_student_id_academic_year_id_key UNIQUE (school_id, student_id, academic_year_id);


--
-- Name: hostel_blocks hostel_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_blocks
    ADD CONSTRAINT hostel_blocks_pkey PRIMARY KEY (id);


--
-- Name: hostel_blocks hostel_blocks_school_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_blocks
    ADD CONSTRAINT hostel_blocks_school_id_name_key UNIQUE (school_id, name);


--
-- Name: hostel_permission_requests hostel_permission_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_permission_requests
    ADD CONSTRAINT hostel_permission_requests_pkey PRIMARY KEY (id);


--
-- Name: hostel_rooms hostel_rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_rooms
    ADD CONSTRAINT hostel_rooms_pkey PRIMARY KEY (id);


--
-- Name: hostel_rooms hostel_rooms_school_id_block_id_room_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_rooms
    ADD CONSTRAINT hostel_rooms_school_id_block_id_room_no_key UNIQUE (school_id, block_id, room_no);


--
-- Name: internal_user_permission_overrides internal_user_permission_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_user_permission_overrides
    ADD CONSTRAINT internal_user_permission_overrides_pkey PRIMARY KEY (user_id, permission);


--
-- Name: internal_user_schools internal_user_schools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_user_schools
    ADD CONSTRAINT internal_user_schools_pkey PRIMARY KEY (id);


--
-- Name: internal_user_sessions internal_user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_user_sessions
    ADD CONSTRAINT internal_user_sessions_pkey PRIMARY KEY (id);


--
-- Name: internal_user_sessions internal_user_sessions_refresh_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_user_sessions
    ADD CONSTRAINT internal_user_sessions_refresh_token_hash_key UNIQUE (refresh_token_hash);


--
-- Name: internal_users internal_users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_users
    ADD CONSTRAINT internal_users_email_key UNIQUE (email);


--
-- Name: internal_users internal_users_employee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_users
    ADD CONSTRAINT internal_users_employee_id_key UNIQUE (employee_id);


--
-- Name: internal_users internal_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_users
    ADD CONSTRAINT internal_users_pkey PRIMARY KEY (id);


--
-- Name: issued_certificates issued_certificates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_pkey PRIMARY KEY (id);


--
-- Name: issued_certificates issued_certificates_serial_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_serial_no_key UNIQUE (serial_no);


--
-- Name: leave_applications leave_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_applications
    ADD CONSTRAINT leave_applications_pkey PRIMARY KEY (id);


--
-- Name: life_values_modules life_values_modules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.life_values_modules
    ADD CONSTRAINT life_values_modules_pkey PRIMARY KEY (id);


--
-- Name: lms_courses lms_courses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lms_courses
    ADD CONSTRAINT lms_courses_pkey PRIMARY KEY (id);


--
-- Name: lms_materials lms_materials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lms_materials
    ADD CONSTRAINT lms_materials_pkey PRIMARY KEY (id);


--
-- Name: marks marks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_pkey PRIMARY KEY (id);


--
-- Name: marks marks_school_id_exam_subject_id_student_enrollment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_school_id_exam_subject_id_student_enrollment_id_key UNIQUE (school_id, exam_subject_id, student_enrollment_id);


--
-- Name: message_conversations message_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_conversations
    ADD CONSTRAINT message_conversations_pkey PRIMARY KEY (id);


--
-- Name: message_participants message_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_participants
    ADD CONSTRAINT message_participants_pkey PRIMARY KEY (conversation_id, user_id);


--
-- Name: message_typing message_typing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_typing
    ADD CONSTRAINT message_typing_pkey PRIMARY KEY (conversation_id, user_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: money_science_modules money_science_modules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.money_science_modules
    ADD CONSTRAINT money_science_modules_pkey PRIMARY KEY (id);


--
-- Name: student_enrollments no_enrollment_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_enrollments
    ADD CONSTRAINT no_enrollment_overlap EXCLUDE USING gist (student_id WITH =, daterange(start_date, end_date, '[]'::text) WITH &&);


--
-- Name: student_parents no_parent_date_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_parents
    ADD CONSTRAINT no_parent_date_overlap EXCLUDE USING gist (student_id WITH =, parent_id WITH =, daterange(valid_from, valid_to, '[]'::text) WITH &&);


--
-- Name: notices notices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notices
    ADD CONSTRAINT notices_pkey PRIMARY KEY (id);


--
-- Name: notification_audit_logs notification_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_audit_logs
    ADD CONSTRAINT notification_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: notification_batches notification_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_batches
    ADD CONSTRAINT notification_batches_pkey PRIMARY KEY (id);


--
-- Name: notification_config notification_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_config
    ADD CONSTRAINT notification_config_pkey PRIMARY KEY (key);


--
-- Name: notification_deliveries notification_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id);


--
-- Name: notification_dispatch_recipients notification_dispatch_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_dispatch_recipients
    ADD CONSTRAINT notification_dispatch_recipients_pkey PRIMARY KEY (id);


--
-- Name: notification_events notification_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_events
    ADD CONSTRAINT notification_events_pkey PRIMARY KEY (id);


--
-- Name: notification_events notification_events_school_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_events
    ADD CONSTRAINT notification_events_school_id_idempotency_key_key UNIQUE (school_id, idempotency_key);


--
-- Name: notification_logs notification_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_logs
    ADD CONSTRAINT notification_logs_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (school_id, user_id, event_type, channel);


--
-- Name: notification_templates notification_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_pkey PRIMARY KEY (id);


--
-- Name: notification_templates notification_templates_school_id_event_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_school_id_event_type_key UNIQUE (school_id, event_type);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: parent_visits parent_visits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parent_visits
    ADD CONSTRAINT parent_visits_pkey PRIMARY KEY (id);


--
-- Name: parents parents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parents
    ADD CONSTRAINT parents_pkey PRIMARY KEY (id);


--
-- Name: payroll_config payroll_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_config
    ADD CONSTRAINT payroll_config_pkey PRIMARY KEY (id);


--
-- Name: payroll_runs payroll_runs_employee_id_payroll_year_payroll_month_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_employee_id_payroll_year_payroll_month_key UNIQUE (employee_id, payroll_year, payroll_month);


--
-- Name: payroll_runs payroll_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_pkey PRIMARY KEY (id);


--
-- Name: periods periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.periods
    ADD CONSTRAINT periods_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_school_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_school_id_code_key UNIQUE (school_id, code);


--
-- Name: person_contacts person_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.person_contacts
    ADD CONSTRAINT person_contacts_pkey PRIMARY KEY (id);


--
-- Name: persons persons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persons
    ADD CONSTRAINT persons_pkey PRIMARY KEY (id);


--
-- Name: question_bank question_bank_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.question_bank
    ADD CONSTRAINT question_bank_pkey PRIMARY KEY (id);


--
-- Name: receipt_items receipt_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_items
    ADD CONSTRAINT receipt_items_pkey PRIMARY KEY (id);


--
-- Name: receipt_number_counters receipt_number_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_number_counters
    ADD CONSTRAINT receipt_number_counters_pkey PRIMARY KEY (school_id);


--
-- Name: receipts receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_pkey PRIMARY KEY (id);


--
-- Name: receipts receipts_school_id_receipt_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_school_id_receipt_no_key UNIQUE (school_id, receipt_no);


--
-- Name: relationship_types relationship_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationship_types
    ADD CONSTRAINT relationship_types_name_key UNIQUE (name);


--
-- Name: relationship_types relationship_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationship_types
    ADD CONSTRAINT relationship_types_pkey PRIMARY KEY (id);


--
-- Name: religions religions_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.religions
    ADD CONSTRAINT religions_name_key UNIQUE (name);


--
-- Name: religions religions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.religions
    ADD CONSTRAINT religions_pkey PRIMARY KEY (id);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_id);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: roles roles_school_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_school_id_code_key UNIQUE (school_id, code);


--
-- Name: route_leg_calibration route_leg_calibration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_leg_calibration
    ADD CONSTRAINT route_leg_calibration_pkey PRIMARY KEY (id);


--
-- Name: route_leg_calibration route_leg_calibration_school_id_route_id_trip_direction_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_leg_calibration
    ADD CONSTRAINT route_leg_calibration_school_id_route_id_trip_direction_key UNIQUE (school_id, route_id, trip_direction);


--
-- Name: route_segment_time route_segment_time_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_segment_time
    ADD CONSTRAINT route_segment_time_pkey PRIMARY KEY (id);


--
-- Name: route_segment_time route_segment_time_school_id_route_id_trip_direction_from_s_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_segment_time
    ADD CONSTRAINT route_segment_time_school_id_route_id_trip_direction_from_s_key UNIQUE (school_id, route_id, trip_direction, from_stop_id, to_stop_id);


--
-- Name: route_stop_geo route_stop_geo_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_stop_geo
    ADD CONSTRAINT route_stop_geo_pkey PRIMARY KEY (id);


--
-- Name: route_stop_geo route_stop_geo_school_id_stop_id_trip_direction_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_stop_geo
    ADD CONSTRAINT route_stop_geo_school_id_stop_id_trip_direction_key UNIQUE (school_id, stop_id, trip_direction);


--
-- Name: saas_subscription_payments saas_subscription_payments_merchant_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saas_subscription_payments
    ADD CONSTRAINT saas_subscription_payments_merchant_order_id_key UNIQUE (merchant_order_id);


--
-- Name: saas_subscription_payments saas_subscription_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saas_subscription_payments
    ADD CONSTRAINT saas_subscription_payments_pkey PRIMARY KEY (id);


--
-- Name: saas_subscription_receipts saas_subscription_receipts_document_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saas_subscription_receipts
    ADD CONSTRAINT saas_subscription_receipts_document_number_key UNIQUE (document_number);


--
-- Name: saas_subscription_receipts saas_subscription_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saas_subscription_receipts
    ADD CONSTRAINT saas_subscription_receipts_pkey PRIMARY KEY (id);


--
-- Name: saas_subscriptions saas_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saas_subscriptions
    ADD CONSTRAINT saas_subscriptions_pkey PRIMARY KEY (school_id);


--
-- Name: schema_meta schema_meta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_meta
    ADD CONSTRAINT schema_meta_pkey PRIMARY KEY (key);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: school_automation_rules school_automation_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_automation_rules
    ADD CONSTRAINT school_automation_rules_pkey PRIMARY KEY (id);


--
-- Name: school_feature_flags school_feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_feature_flags
    ADD CONSTRAINT school_feature_flags_pkey PRIMARY KEY (id);


--
-- Name: school_feature_flags school_feature_flags_school_id_role_feature_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_feature_flags
    ADD CONSTRAINT school_feature_flags_school_id_role_feature_key_key UNIQUE (school_id, role, feature_key);


--
-- Name: school_onboarding_checklists school_onboarding_checklists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_onboarding_checklists
    ADD CONSTRAINT school_onboarding_checklists_pkey PRIMARY KEY (id);


--
-- Name: school_requirements school_requirements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_requirements
    ADD CONSTRAINT school_requirements_pkey PRIMARY KEY (id);


--
-- Name: school_settings school_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_settings
    ADD CONSTRAINT school_settings_pkey PRIMARY KEY (id);


--
-- Name: school_settings school_settings_school_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_settings
    ADD CONSTRAINT school_settings_school_id_key_key UNIQUE (school_id, key);


--
-- Name: school_website_gallery school_website_gallery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_website_gallery
    ADD CONSTRAINT school_website_gallery_pkey PRIMARY KEY (id);


--
-- Name: schools schools_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schools
    ADD CONSTRAINT schools_code_key UNIQUE (code);


--
-- Name: schools schools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schools
    ADD CONSTRAINT schools_pkey PRIMARY KEY (id);


--
-- Name: science_projects science_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.science_projects
    ADD CONSTRAINT science_projects_pkey PRIMARY KEY (id);


--
-- Name: sections sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);


--
-- Name: staff_attendance staff_attendance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_pkey PRIMARY KEY (id);


--
-- Name: staff_designations staff_designations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_designations
    ADD CONSTRAINT staff_designations_pkey PRIMARY KEY (id);


--
-- Name: staff_designations staff_designations_school_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_designations
    ADD CONSTRAINT staff_designations_school_id_name_key UNIQUE (school_id, name);


--
-- Name: staff_payroll staff_payroll_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_payroll
    ADD CONSTRAINT staff_payroll_pkey PRIMARY KEY (id);


--
-- Name: staff_payroll staff_payroll_school_id_staff_id_payroll_month_payroll_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_payroll
    ADD CONSTRAINT staff_payroll_school_id_staff_id_payroll_month_payroll_year_key UNIQUE (school_id, staff_id, payroll_month, payroll_year);


--
-- Name: staff staff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_pkey PRIMARY KEY (id);


--
-- Name: staff_statuses staff_statuses_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_statuses
    ADD CONSTRAINT staff_statuses_code_key UNIQUE (code);


--
-- Name: staff_statuses staff_statuses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_statuses
    ADD CONSTRAINT staff_statuses_pkey PRIMARY KEY (id);


--
-- Name: student_bulk_update_batches student_bulk_update_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_bulk_update_batches
    ADD CONSTRAINT student_bulk_update_batches_pkey PRIMARY KEY (id);


--
-- Name: student_bulk_update_rows student_bulk_update_rows_batch_id_row_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_bulk_update_rows
    ADD CONSTRAINT student_bulk_update_rows_batch_id_row_number_key UNIQUE (batch_id, row_number);


--
-- Name: student_bulk_update_rows student_bulk_update_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_bulk_update_rows
    ADD CONSTRAINT student_bulk_update_rows_pkey PRIMARY KEY (id);


--
-- Name: student_categories student_categories_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_categories
    ADD CONSTRAINT student_categories_name_key UNIQUE (name);


--
-- Name: student_categories student_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_categories
    ADD CONSTRAINT student_categories_pkey PRIMARY KEY (id);


--
-- Name: student_enrollments student_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_enrollments
    ADD CONSTRAINT student_enrollments_pkey PRIMARY KEY (id);


--
-- Name: student_fees student_fees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_fees
    ADD CONSTRAINT student_fees_pkey PRIMARY KEY (id);


--
-- Name: student_life_values_progress student_life_values_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_life_values_progress
    ADD CONSTRAINT student_life_values_progress_pkey PRIMARY KEY (id);


--
-- Name: student_life_values_progress student_life_values_progress_school_id_student_id_module_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_life_values_progress
    ADD CONSTRAINT student_life_values_progress_school_id_student_id_module_id_key UNIQUE (school_id, student_id, module_id, academic_year_id);


--
-- Name: student_money_science_progress student_money_science_progres_school_id_student_id_module_i_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_money_science_progress
    ADD CONSTRAINT student_money_science_progres_school_id_student_id_module_i_key UNIQUE (school_id, student_id, module_id);


--
-- Name: student_money_science_progress student_money_science_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_money_science_progress
    ADD CONSTRAINT student_money_science_progress_pkey PRIMARY KEY (id);


--
-- Name: student_parents student_parents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_parents
    ADD CONSTRAINT student_parents_pkey PRIMARY KEY (id);


--
-- Name: student_science_projects student_science_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_science_projects
    ADD CONSTRAINT student_science_projects_pkey PRIMARY KEY (id);


--
-- Name: student_science_projects student_science_projects_school_id_student_id_project_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_science_projects
    ADD CONSTRAINT student_science_projects_school_id_student_id_project_id_key UNIQUE (school_id, student_id, project_id);


--
-- Name: student_statuses student_statuses_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_statuses
    ADD CONSTRAINT student_statuses_code_key UNIQUE (code);


--
-- Name: student_statuses student_statuses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_statuses
    ADD CONSTRAINT student_statuses_pkey PRIMARY KEY (id);


--
-- Name: student_transport student_transport_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_transport
    ADD CONSTRAINT student_transport_pkey PRIMARY KEY (id);


--
-- Name: student_transport student_transport_student_id_academic_year_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_transport
    ADD CONSTRAINT student_transport_student_id_academic_year_id_key UNIQUE (student_id, academic_year_id);


--
-- Name: students students_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_pkey PRIMARY KEY (id);


--
-- Name: subjects subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_pkey PRIMARY KEY (id);


--
-- Name: super_admins super_admins_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.super_admins
    ADD CONSTRAINT super_admins_email_key UNIQUE (email);


--
-- Name: super_admins super_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.super_admins
    ADD CONSTRAINT super_admins_pkey PRIMARY KEY (id);


--
-- Name: support_message_notification_outbox support_message_notification_outbox_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_message_notification_outbox
    ADD CONSTRAINT support_message_notification_outbox_message_id_key UNIQUE (message_id);


--
-- Name: support_message_notification_outbox support_message_notification_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_message_notification_outbox
    ADD CONSTRAINT support_message_notification_outbox_pkey PRIMARY KEY (id);


--
-- Name: support_ticket_messages support_ticket_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_ticket_messages
    ADD CONSTRAINT support_ticket_messages_pkey PRIMARY KEY (id);


--
-- Name: support_ticket_notes support_ticket_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_ticket_notes
    ADD CONSTRAINT support_ticket_notes_pkey PRIMARY KEY (id);


--
-- Name: support_tickets support_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);


--
-- Name: temp_access_grants temp_access_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temp_access_grants
    ADD CONSTRAINT temp_access_grants_pkey PRIMARY KEY (id);


--
-- Name: tenant_student_deletion_audit tenant_student_deletion_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_student_deletion_audit
    ADD CONSTRAINT tenant_student_deletion_audit_pkey PRIMARY KEY (id);


--
-- Name: ticket_number_counters ticket_number_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_number_counters
    ADD CONSTRAINT ticket_number_counters_pkey PRIMARY KEY (school_id, year);


--
-- Name: timetable_entries timetable_entries_class_section_id_period_id_day_of_week_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_class_section_id_period_id_day_of_week_key UNIQUE (school_id, class_section_id, period_id, day_of_week);


--
-- Name: timetable_entries timetable_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_pkey PRIMARY KEY (id);


--
-- Name: timetable_slots timetable_slots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_slots
    ADD CONSTRAINT timetable_slots_pkey PRIMARY KEY (id);


--
-- Name: timetable_substitutions timetable_substitutions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_substitutions
    ADD CONSTRAINT timetable_substitutions_pkey PRIMARY KEY (id);


--
-- Name: transport_fee_payments transport_fee_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_fee_payments
    ADD CONSTRAINT transport_fee_payments_pkey PRIMARY KEY (id);


--
-- Name: transport_fee transport_fee_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_fee
    ADD CONSTRAINT transport_fee_pkey PRIMARY KEY (id);


--
-- Name: transport_import_batches transport_import_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_import_batches
    ADD CONSTRAINT transport_import_batches_pkey PRIMARY KEY (id);


--
-- Name: transport_import_rows transport_import_rows_batch_id_row_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_import_rows
    ADD CONSTRAINT transport_import_rows_batch_id_row_number_key UNIQUE (batch_id, row_number);


--
-- Name: transport_import_rows transport_import_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_import_rows
    ADD CONSTRAINT transport_import_rows_pkey PRIMARY KEY (id);


--
-- Name: transport_routes transport_routes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_routes
    ADD CONSTRAINT transport_routes_code_key UNIQUE (code);


--
-- Name: transport_routes transport_routes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_routes
    ADD CONSTRAINT transport_routes_pkey PRIMARY KEY (id);


--
-- Name: transport_safety_incidents transport_safety_incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_safety_incidents
    ADD CONSTRAINT transport_safety_incidents_pkey PRIMARY KEY (id);


--
-- Name: transport_stops transport_stops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_stops
    ADD CONSTRAINT transport_stops_pkey PRIMARY KEY (id);


--
-- Name: trip_stop_status trip_stop_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_stop_status
    ADD CONSTRAINT trip_stop_status_pkey PRIMARY KEY (id);


--
-- Name: trip_stop_status trip_stop_status_school_id_trip_id_stop_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_stop_status
    ADD CONSTRAINT trip_stop_status_school_id_trip_id_stop_id_key UNIQUE (school_id, trip_id, stop_id);


--
-- Name: trips trips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_pkey PRIMARY KEY (id);


--
-- Name: ui_route_permissions ui_route_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ui_route_permissions
    ADD CONSTRAINT ui_route_permissions_pkey PRIMARY KEY (id);


--
-- Name: notification_deliveries uniq_delivery_notification_channel; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT uniq_delivery_notification_channel UNIQUE (school_id, notification_id, channel);


--
-- Name: notifications uniq_notifications_event_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT uniq_notifications_event_user UNIQUE (school_id, event_id, user_id);


--
-- Name: student_parents uq_active_parent; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_parents
    ADD CONSTRAINT uq_active_parent UNIQUE (student_id, parent_id);


--
-- Name: attendance_interventions uq_attendance_interventions_student; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_interventions
    ADD CONSTRAINT uq_attendance_interventions_student UNIQUE (school_id, student_id);


--
-- Name: automation_execution_logs uq_automation_exec_idempotency; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_execution_logs
    ADD CONSTRAINT uq_automation_exec_idempotency UNIQUE (school_id, idempotency_key);


--
-- Name: defaulter_dues uq_defaulter_dues_student_year; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.defaulter_dues
    ADD CONSTRAINT uq_defaulter_dues_student_year UNIQUE (school_id, student_id, due_academic_year);


--
-- Name: defaulter_payments uq_defaulter_payments_tx_ref; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.defaulter_payments
    ADD CONSTRAINT uq_defaulter_payments_tx_ref UNIQUE (school_id, transaction_ref);


--
-- Name: fee_adjustments uq_fee_adjustments_receipt_no; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_adjustments
    ADD CONSTRAINT uq_fee_adjustments_receipt_no UNIQUE (school_id, receipt_no);


--
-- Name: school_automation_rules uq_school_automation_rule_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_automation_rules
    ADD CONSTRAINT uq_school_automation_rule_key UNIQUE (school_id, rule_key);


--
-- Name: school_onboarding_checklists uq_school_checklist_task; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_onboarding_checklists
    ADD CONSTRAINT uq_school_checklist_task UNIQUE (school_id, task_key);


--
-- Name: school_website_gallery uq_school_website_gallery_url; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_website_gallery
    ADD CONSTRAINT uq_school_website_gallery_url UNIQUE (school_id, image_url);


--
-- Name: staff_attendance uq_staff_attendance_active; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT uq_staff_attendance_active UNIQUE (staff_id, attendance_date);


--
-- Name: support_tickets uq_support_ticket_number; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT uq_support_ticket_number UNIQUE (school_id, ticket_number);


--
-- Name: transport_fee_payments uq_transport_fee_payments_tx_ref; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_fee_payments
    ADD CONSTRAINT uq_transport_fee_payments_tx_ref UNIQUE (school_id, transaction_ref);


--
-- Name: transport_fee uq_transport_fee_stop_year; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_fee
    ADD CONSTRAINT uq_transport_fee_stop_year UNIQUE (school_id, route_id, stop_id, academic_year);


--
-- Name: user_access_contexts uq_user_context_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_access_contexts
    ADD CONSTRAINT uq_user_context_key UNIQUE (user_id, context_key);


--
-- Name: user_active_sessions uq_user_device_session; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_active_sessions
    ADD CONSTRAINT uq_user_device_session UNIQUE (user_id, device_id);


--
-- Name: user_devices uq_user_device_token; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT uq_user_device_token UNIQUE (school_id, user_id, fcm_token);


--
-- Name: internal_user_schools uq_user_school; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_user_schools
    ADD CONSTRAINT uq_user_school UNIQUE (user_id, school_id);


--
-- Name: user_access_contexts user_access_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_access_contexts
    ADD CONSTRAINT user_access_contexts_pkey PRIMARY KEY (id);


--
-- Name: user_active_sessions user_active_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_active_sessions
    ADD CONSTRAINT user_active_sessions_pkey PRIMARY KEY (id);


--
-- Name: user_devices user_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id);


--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (user_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_academic_years_code_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_academic_years_code_active ON public.academic_years USING btree (school_id, code) WHERE (deleted_at IS NULL);


--
-- Name: idx_academic_years_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_academic_years_school_id ON public.academic_years USING btree (school_id);


--
-- Name: idx_active_enrollments; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_active_enrollments ON public.student_enrollments USING btree (student_id) WHERE (status = 'active'::public.enrollment_status_enum);


--
-- Name: idx_admin_quick_action_daily_usage_rank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_quick_action_daily_usage_rank ON public.admin_quick_action_daily_usage USING btree (school_id, usage_date, click_count DESC);


--
-- Name: idx_approval_fee_payment_deletion_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_approval_fee_payment_deletion_scope ON public.approval_requests USING btree (school_id, type, ((payload ->> 'scope_key'::text))) WHERE (((type)::text = 'fee_payment_deletion'::text) AND ((status)::text = ANY ((ARRAY['PENDING'::character varying, 'APPROVED'::character varying])::text[])) AND ((payload ->> 'consumed_at'::text) IS NULL));


--
-- Name: idx_approval_requests_pending_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_requests_pending_type ON public.approval_requests USING btree (school_id, type) WHERE ((status)::text = 'PENDING'::text);


--
-- Name: idx_approval_requests_school_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approval_requests_school_status ON public.approval_requests USING btree (school_id, status, created_at DESC);


--
-- Name: idx_att_interventions_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_att_interventions_school ON public.attendance_interventions USING btree (school_id, status);


--
-- Name: idx_attendance_composite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_composite ON public.daily_attendance USING btree (student_enrollment_id, status, attendance_date);


--
-- Name: idx_attendance_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_date ON public.daily_attendance USING btree (attendance_date);


--
-- Name: idx_attendance_enrollment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_enrollment ON public.daily_attendance USING btree (student_enrollment_id);


--
-- Name: idx_attendance_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_school ON public.daily_attendance USING btree (school_id);


--
-- Name: idx_attendance_school_student_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_school_student_date ON public.daily_attendance USING btree (school_id, student_enrollment_id, attendance_date);


--
-- Name: idx_audit_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_created_at ON public.audit_logs USING btree (created_at);


--
-- Name: idx_audit_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_entity ON public.audit_logs USING btree (entity, entity_id);


--
-- Name: idx_audit_logs_request_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_request_id ON public.audit_logs USING btree (request_id);


--
-- Name: idx_audit_logs_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_user_date ON public.audit_logs USING btree (user_id, created_at DESC);


--
-- Name: idx_audit_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_user_id ON public.audit_logs USING btree (user_id);


--
-- Name: idx_auto_exec_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auto_exec_entity ON public.automation_execution_logs USING btree (school_id, entity_type, entity_id);


--
-- Name: idx_auto_exec_rule_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auto_exec_rule_date ON public.automation_execution_logs USING btree (school_id, rule_key, created_at DESC);


--
-- Name: idx_auto_exec_school_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auto_exec_school_status ON public.automation_execution_logs USING btree (school_id, status);


--
-- Name: idx_automation_rules_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automation_rules_school ON public.school_automation_rules USING btree (school_id, is_enabled);


--
-- Name: idx_billing_documents_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_documents_client ON public.billing_documents USING btree (client_id);


--
-- Name: idx_billing_documents_fy_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_documents_fy_type ON public.billing_documents USING btree (financial_year, document_type);


--
-- Name: idx_billing_documents_portal_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_billing_documents_portal_client ON public.billing_documents USING btree (client_kind, client_cluster_id, client_id, created_at DESC);


--
-- Name: idx_bus_locations_bus_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bus_locations_bus_id ON public.bus_locations USING btree (bus_id);


--
-- Name: idx_bus_locations_bus_recorded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bus_locations_bus_recorded ON public.bus_locations USING btree (bus_id, recorded_at DESC);


--
-- Name: idx_bus_locations_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bus_locations_recent ON public.bus_locations USING btree (bus_id, recorded_at DESC);


--
-- Name: idx_bus_locations_recorded_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bus_locations_recorded_at ON public.bus_locations USING btree (recorded_at DESC);


--
-- Name: idx_bus_locations_school_bus_recorded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bus_locations_school_bus_recorded ON public.bus_locations USING btree (school_id, bus_id, recorded_at DESC);


--
-- Name: idx_bus_locations_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bus_locations_school_id ON public.bus_locations USING btree (school_id);


--
-- Name: idx_bus_stop_att_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bus_stop_att_date ON public.bus_stop_attendance USING btree (attendance_date);


--
-- Name: idx_bus_stop_att_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bus_stop_att_school ON public.bus_stop_attendance USING btree (school_id);


--
-- Name: idx_bus_stop_att_stop; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bus_stop_att_stop ON public.bus_stop_attendance USING btree (stop_id);


--
-- Name: idx_bus_stop_att_student; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bus_stop_att_student ON public.bus_stop_attendance USING btree (student_id);


--
-- Name: idx_bus_stop_att_trip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bus_stop_att_trip ON public.bus_stop_attendance USING btree (trip_id);


--
-- Name: idx_bus_trip_history_bus_id_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bus_trip_history_bus_id_time ON public.bus_trip_history USING btree (bus_id, recorded_at DESC);


--
-- Name: idx_bus_trip_history_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bus_trip_history_school_id ON public.bus_trip_history USING btree (school_id);


--
-- Name: idx_bus_trip_history_school_recorded_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bus_trip_history_school_recorded_at ON public.bus_trip_history USING btree (school_id, recorded_at);


--
-- Name: idx_buses_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_buses_driver ON public.buses USING btree (driver_id);


--
-- Name: idx_buses_route; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_buses_route ON public.buses USING btree (route_id);


--
-- Name: idx_buses_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_buses_school_id ON public.buses USING btree (school_id);


--
-- Name: idx_class_sections_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_class_sections_school_id ON public.class_sections USING btree (school_id);


--
-- Name: idx_class_subjects_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_class_subjects_school_id ON public.class_subjects USING btree (school_id);


--
-- Name: idx_class_subjects_subject_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_class_subjects_subject_id ON public.class_subjects USING btree (subject_id);


--
-- Name: idx_class_subjects_teacher; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_class_subjects_teacher ON public.class_subjects USING btree (teacher_id);


--
-- Name: idx_class_subjects_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_class_subjects_unique ON public.class_subjects USING btree (school_id, class_section_id, subject_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_classes_name_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_classes_name_active ON public.classes USING btree (school_id, name) WHERE (deleted_at IS NULL);


--
-- Name: idx_classes_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_classes_school ON public.classes USING btree (school_id);


--
-- Name: idx_classes_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_classes_school_id ON public.classes USING btree (school_id);


--
-- Name: idx_complaints_assigned_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_complaints_assigned_to ON public.complaints USING btree (assigned_to);


--
-- Name: idx_complaints_raised_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_complaints_raised_by ON public.complaints USING btree (raised_by);


--
-- Name: idx_complaints_raised_for; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_complaints_raised_for ON public.complaints USING btree (raised_for_student_id);


--
-- Name: idx_complaints_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_complaints_school ON public.complaints USING btree (school_id);


--
-- Name: idx_complaints_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_complaints_school_id ON public.complaints USING btree (school_id);


--
-- Name: idx_complaints_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_complaints_status ON public.complaints USING btree (status);


--
-- Name: idx_conv_high_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conv_high_user ON public.message_conversations USING btree (school_id, participant_high_user_id, last_message_at DESC NULLS LAST);


--
-- Name: idx_conv_low_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conv_low_user ON public.message_conversations USING btree (school_id, participant_low_user_id, last_message_at DESC NULLS LAST);


--
-- Name: idx_crm_accounts_lifecycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_accounts_lifecycle ON public.crm_accounts USING btree (lifecycle_stage, updated_at DESC);


--
-- Name: idx_crm_accounts_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_accounts_owner ON public.crm_accounts USING btree (owner_founder_id, lifecycle_stage);


--
-- Name: idx_crm_activities_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_activities_account ON public.crm_activities USING btree (account_id, occurred_at DESC);


--
-- Name: idx_crm_activities_enquiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_activities_enquiry ON public.crm_activities USING btree (enquiry_id, occurred_at DESC);


--
-- Name: idx_crm_automation_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_automation_queue ON public.crm_automation_runs USING btree (status, available_at) WHERE (status = ANY (ARRAY['PENDING'::text, 'FAILED'::text]));


--
-- Name: idx_crm_contacts_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_contacts_account ON public.crm_contacts USING btree (account_id, is_primary DESC);


--
-- Name: idx_crm_contacts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_contacts_email ON public.crm_contacts USING btree (lower(email)) WHERE (email IS NOT NULL);


--
-- Name: idx_crm_tasks_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_tasks_account ON public.crm_tasks USING btree (account_id, created_at DESC);


--
-- Name: idx_crm_tasks_enquiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_tasks_enquiry ON public.crm_tasks USING btree (enquiry_id, created_at DESC);


--
-- Name: idx_crm_tasks_owner_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_tasks_owner_queue ON public.crm_tasks USING btree (owner_founder_id, status, due_at);


--
-- Name: idx_csl_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_csl_user_date ON public.context_switch_logs USING btree (user_id, created_at DESC);


--
-- Name: idx_daily_attendance_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_attendance_school_id ON public.daily_attendance USING btree (school_id);


--
-- Name: idx_dcgd_programs_active_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dcgd_programs_active_order ON public.dcgd_programs USING btree (display_order) WHERE (is_active = true);


--
-- Name: idx_dcgd_programs_display_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dcgd_programs_display_order ON public.dcgd_programs USING btree (display_order);


--
-- Name: idx_dcgd_programs_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dcgd_programs_is_active ON public.dcgd_programs USING btree (is_active);


--
-- Name: idx_defaulter_dues_active_balance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_defaulter_dues_active_balance ON public.defaulter_dues USING btree (school_id, balance) WHERE ((deleted_at IS NULL) AND (balance > (0)::numeric));


--
-- Name: idx_defaulter_dues_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_defaulter_dues_school_id ON public.defaulter_dues USING btree (school_id);


--
-- Name: idx_defaulter_dues_student_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_defaulter_dues_student_id ON public.defaulter_dues USING btree (student_id);


--
-- Name: idx_defaulter_dues_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_defaulter_dues_year ON public.defaulter_dues USING btree (school_id, due_academic_year);


--
-- Name: idx_defaulter_payments_due_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_defaulter_payments_due_id ON public.defaulter_payments USING btree (defaulter_due_id);


--
-- Name: idx_defaulter_payments_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_defaulter_payments_school_id ON public.defaulter_payments USING btree (school_id);


--
-- Name: idx_deliveries_worker_fetch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deliveries_worker_fetch ON public.notification_deliveries USING btree (next_retry_at) WHERE ((status = 'FAILED'::public.notification_status) AND (retry_count < 5));


--
-- Name: idx_diary_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diary_class ON public.diary_entries USING btree (class_section_id);


--
-- Name: idx_diary_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diary_date ON public.diary_entries USING btree (entry_date);


--
-- Name: idx_diary_entries_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diary_entries_school_id ON public.diary_entries USING btree (school_id);


--
-- Name: idx_discipline_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discipline_school_id ON public.discipline_records USING btree (school_id);


--
-- Name: idx_discipline_student; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discipline_student ON public.discipline_records USING btree (student_id);


--
-- Name: idx_driver_route_assignments_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_route_assignments_driver ON public.driver_route_assignments USING btree (driver_id, school_id) WHERE ((deleted_at IS NULL) AND (is_active = true));


--
-- Name: idx_driver_route_assignments_route; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_route_assignments_route ON public.driver_route_assignments USING btree (route_id, school_id) WHERE ((deleted_at IS NULL) AND (is_active = true));


--
-- Name: idx_employee_documents_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employee_documents_employee ON public.employee_documents USING btree (employee_id, generated_at DESC);


--
-- Name: idx_employees_department; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_department ON public.employees USING btree (department, status);


--
-- Name: idx_employees_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_status ON public.employees USING btree (status, full_name);


--
-- Name: idx_enquiries_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enquiries_account ON public.enquiries USING btree (account_id, updated_at DESC);


--
-- Name: idx_enquiries_crm_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enquiries_crm_queue ON public.enquiries USING btree (status, assigned_to, next_follow_up_at, updated_at DESC);


--
-- Name: idx_enquiries_unassigned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enquiries_unassigned ON public.enquiries USING btree (created_at DESC) WHERE (assigned_to IS NULL);


--
-- Name: idx_events_dates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_dates ON public.events USING btree (start_date, end_date);


--
-- Name: idx_events_idempotency; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_idempotency ON public.notification_events USING btree (idempotency_key);


--
-- Name: idx_events_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_school ON public.events USING btree (school_id);


--
-- Name: idx_events_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_school_id ON public.events USING btree (school_id);


--
-- Name: idx_exam_room_alloc_exam; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exam_room_alloc_exam ON public.exam_room_allocations USING btree (exam_id, exam_date, session_start) WHERE (deleted_at IS NULL);


--
-- Name: idx_exam_room_alloc_invig; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exam_room_alloc_invig ON public.exam_room_allocations USING btree (invigilator_staff_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_exam_room_alloc_invig_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_exam_room_alloc_invig_unique ON public.exam_room_allocations USING btree (exam_id, exam_date, session_start, invigilator_staff_id) WHERE ((deleted_at IS NULL) AND (invigilator_staff_id IS NOT NULL));


--
-- Name: idx_exam_room_alloc_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_exam_room_alloc_unique ON public.exam_room_allocations USING btree (exam_id, exam_date, session_start, room_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_exam_rooms_name_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_exam_rooms_name_active ON public.exam_rooms USING btree (school_id, name) WHERE (deleted_at IS NULL);


--
-- Name: idx_exam_rooms_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exam_rooms_school ON public.exam_rooms USING btree (school_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_exam_seats_enrollment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exam_seats_enrollment ON public.exam_seat_assignments USING btree (student_enrollment_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_exam_seats_one_per_sitting; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_exam_seats_one_per_sitting ON public.exam_seat_assignments USING btree (exam_id, exam_date, session_start, student_enrollment_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_exam_seats_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exam_seats_room ON public.exam_seat_assignments USING btree (room_allocation_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_exam_subjects_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_exam_subjects_active ON public.exam_subjects USING btree (exam_id, subject_id, class_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_exam_subjects_class_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exam_subjects_class_id ON public.exam_subjects USING btree (class_id);


--
-- Name: idx_exam_subjects_exam_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exam_subjects_exam_date ON public.exam_subjects USING btree (exam_id, exam_date) WHERE (deleted_at IS NULL);


--
-- Name: idx_exam_subjects_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exam_subjects_school_id ON public.exam_subjects USING btree (school_id);


--
-- Name: idx_exam_subjects_subject_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exam_subjects_subject_id ON public.exam_subjects USING btree (subject_id);


--
-- Name: idx_exams_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exams_active ON public.exams USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: idx_exams_results_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exams_results_published ON public.exams USING btree (school_id, results_published) WHERE (deleted_at IS NULL);


--
-- Name: idx_exams_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_exams_school_id ON public.exams USING btree (school_id);


--
-- Name: idx_expenses_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_category ON public.expenses USING btree (category);


--
-- Name: idx_expenses_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_date ON public.expenses USING btree (expense_date DESC);


--
-- Name: idx_expenses_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_school ON public.expenses USING btree (school_id);


--
-- Name: idx_expenses_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_school_id ON public.expenses USING btree (school_id);


--
-- Name: idx_fee_adjustments_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fee_adjustments_school_id ON public.fee_adjustments USING btree (school_id);


--
-- Name: idx_fee_adjustments_student_fee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fee_adjustments_student_fee_id ON public.fee_adjustments USING btree (student_fee_id);


--
-- Name: idx_fee_adjustments_student_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fee_adjustments_student_id ON public.fee_adjustments USING btree (student_id);


--
-- Name: idx_fee_adjustments_transport_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fee_adjustments_transport_target ON public.fee_adjustments USING btree (school_id, student_id, transport_fee_id) WHERE (transport_fee_id IS NOT NULL);


--
-- Name: idx_fee_structures_class_level_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fee_structures_class_level_active ON public.fee_structures USING btree (school_id, academic_year_id, class_id, fee_type_id) WHERE ((deleted_at IS NULL) AND (section_id IS NULL));


--
-- Name: idx_fee_structures_mode_deactivated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fee_structures_mode_deactivated ON public.fee_structures USING btree (school_id) WHERE (mode_deactivated = true);


--
-- Name: idx_fee_structures_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fee_structures_school_id ON public.fee_structures USING btree (school_id);


--
-- Name: idx_fee_structures_section_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fee_structures_section_id ON public.fee_structures USING btree (section_id) WHERE (section_id IS NOT NULL);


--
-- Name: idx_fee_structures_section_level_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fee_structures_section_level_active ON public.fee_structures USING btree (school_id, academic_year_id, class_id, section_id, fee_type_id) WHERE ((deleted_at IS NULL) AND (section_id IS NOT NULL));


--
-- Name: idx_fee_transactions_refund_of; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fee_transactions_refund_of ON public.fee_transactions USING btree (school_id, refund_of) WHERE (refund_of IS NOT NULL);


--
-- Name: idx_fee_transactions_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fee_transactions_school_id ON public.fee_transactions USING btree (school_id);


--
-- Name: idx_fee_transactions_school_paid_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fee_transactions_school_paid_at ON public.fee_transactions USING btree (school_id, paid_at DESC);


--
-- Name: idx_fee_transactions_student_fee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fee_transactions_student_fee_id ON public.fee_transactions USING btree (student_fee_id);


--
-- Name: idx_fee_transactions_unique_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fee_transactions_unique_ref ON public.fee_transactions USING btree (transaction_ref) WHERE ((transaction_ref IS NOT NULL) AND ((transaction_ref)::text <> ''::text));


--
-- Name: idx_fee_txn_ref_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fee_txn_ref_unique ON public.fee_transactions USING btree (school_id, transaction_ref);


--
-- Name: idx_fee_types_code_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fee_types_code_active ON public.fee_types USING btree (school_id, code) WHERE (deleted_at IS NULL);


--
-- Name: idx_fee_types_name_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_fee_types_name_active ON public.fee_types USING btree (school_id, name) WHERE (deleted_at IS NULL);


--
-- Name: idx_fee_types_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fee_types_school_id ON public.fee_types USING btree (school_id);


--
-- Name: idx_fee_types_school_sort; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fee_types_school_sort ON public.fee_types USING btree (school_id, sort_order) WHERE (deleted_at IS NULL);


--
-- Name: idx_festival_posters_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_festival_posters_active ON public.festival_posters USING btree (is_active, starts_at, ends_at);


--
-- Name: idx_financial_audit_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_financial_audit_school_id ON public.financial_audit_logs USING btree (school_id);


--
-- Name: idx_financial_policy_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_financial_policy_school_id ON public.financial_policy_rules USING btree (school_id);


--
-- Name: idx_grading_scales_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grading_scales_school_id ON public.grading_scales USING btree (school_id);


--
-- Name: idx_hostel_alloc_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hostel_alloc_school_id ON public.hostel_allocations USING btree (school_id);


--
-- Name: idx_hostel_allocations_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hostel_allocations_room ON public.hostel_allocations USING btree (room_id);


--
-- Name: idx_hostel_blocks_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hostel_blocks_school_id ON public.hostel_blocks USING btree (school_id);


--
-- Name: idx_hostel_permission_requests_school_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hostel_permission_requests_school_status ON public.hostel_permission_requests USING btree (school_id, status, created_at DESC);


--
-- Name: idx_hostel_permission_requests_student; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hostel_permission_requests_student ON public.hostel_permission_requests USING btree (school_id, student_id, created_at DESC);


--
-- Name: idx_hostel_rooms_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hostel_rooms_school_id ON public.hostel_rooms USING btree (school_id);


--
-- Name: idx_internal_permission_overrides_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_internal_permission_overrides_user ON public.internal_user_permission_overrides USING btree (user_id);


--
-- Name: idx_internal_sessions_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_internal_sessions_active ON public.internal_user_sessions USING btree (id) WHERE (revoked_at IS NULL);


--
-- Name: idx_internal_sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_internal_sessions_user ON public.internal_user_sessions USING btree (user_id, expires_at DESC);


--
-- Name: idx_internal_user_schools_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_internal_user_schools_school ON public.internal_user_schools USING btree (school_id);


--
-- Name: idx_internal_user_schools_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_internal_user_schools_user ON public.internal_user_schools USING btree (user_id);


--
-- Name: idx_internal_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_internal_users_email ON public.internal_users USING btree (lower(email));


--
-- Name: idx_internal_users_employee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_internal_users_employee_id ON public.internal_users USING btree (upper(employee_id));


--
-- Name: idx_internal_users_manager_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_internal_users_manager_id ON public.internal_users USING btree (manager_id);


--
-- Name: idx_internal_users_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_internal_users_phone ON public.internal_users USING btree (phone);


--
-- Name: idx_internal_users_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_internal_users_role ON public.internal_users USING btree (role);


--
-- Name: idx_internal_users_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_internal_users_status ON public.internal_users USING btree (status);


--
-- Name: idx_issued_certificates_issued_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_issued_certificates_issued_at ON public.issued_certificates USING btree (school_id, issued_at DESC);


--
-- Name: idx_issued_certificates_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_issued_certificates_school_id ON public.issued_certificates USING btree (school_id);


--
-- Name: idx_issued_certificates_student_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_issued_certificates_student_id ON public.issued_certificates USING btree (student_id);


--
-- Name: idx_leave_app_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leave_app_school_id ON public.leave_applications USING btree (school_id);


--
-- Name: idx_leaves_applicant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leaves_applicant ON public.leave_applications USING btree (applicant_id);


--
-- Name: idx_leaves_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leaves_status ON public.leave_applications USING btree (status);


--
-- Name: idx_life_values_modules_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_life_values_modules_school_id ON public.life_values_modules USING btree (school_id);


--
-- Name: idx_lms_courses_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lms_courses_class ON public.lms_courses USING btree (class_id);


--
-- Name: idx_lms_courses_instructor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lms_courses_instructor ON public.lms_courses USING btree (instructor_id);


--
-- Name: idx_lms_courses_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lms_courses_school ON public.lms_courses USING btree (school_id);


--
-- Name: idx_lms_courses_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lms_courses_school_id ON public.lms_courses USING btree (school_id);


--
-- Name: idx_lms_courses_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lms_courses_subject ON public.lms_courses USING btree (subject_id);


--
-- Name: idx_lms_materials_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lms_materials_active ON public.lms_materials USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: idx_lms_materials_course; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lms_materials_course ON public.lms_materials USING btree (course_id);


--
-- Name: idx_lms_materials_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lms_materials_school_id ON public.lms_materials USING btree (school_id);


--
-- Name: idx_marks_enrollment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marks_enrollment ON public.marks USING btree (student_enrollment_id);


--
-- Name: idx_marks_exam_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marks_exam_subject ON public.marks USING btree (exam_subject_id);


--
-- Name: idx_marks_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marks_school_id ON public.marks USING btree (school_id);


--
-- Name: idx_messages_conv_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_conv_created ON public.messages USING btree (conversation_id, created_at DESC, id DESC);


--
-- Name: idx_messages_reply_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_reply_to ON public.messages USING btree (reply_to_message_id) WHERE (reply_to_message_id IS NOT NULL);


--
-- Name: idx_money_science_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_money_science_school_id ON public.money_science_modules USING btree (school_id);


--
-- Name: idx_notices_audience; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notices_audience ON public.notices USING btree (audience);


--
-- Name: idx_notices_audiences; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notices_audiences ON public.notices USING gin (audiences);


--
-- Name: idx_notices_publish; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notices_publish ON public.notices USING btree (publish_at);


--
-- Name: idx_notices_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notices_school ON public.notices USING btree (school_id);


--
-- Name: idx_notices_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notices_school_id ON public.notices USING btree (school_id);


--
-- Name: idx_notification_batches_parent_batch_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_batches_parent_batch_id ON public.notification_batches USING btree (parent_batch_id);


--
-- Name: idx_notification_batches_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_batches_school_id ON public.notification_batches USING btree (school_id);


--
-- Name: idx_notification_batches_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_batches_status ON public.notification_batches USING btree (status);


--
-- Name: idx_notification_batches_type_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_batches_type_created ON public.notification_batches USING btree (type, created_at);


--
-- Name: idx_notification_dispatch_recipients_batch_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_dispatch_recipients_batch_id ON public.notification_dispatch_recipients USING btree (batch_id);


--
-- Name: idx_notification_dispatch_recipients_batch_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_dispatch_recipients_batch_status ON public.notification_dispatch_recipients USING btree (batch_id, status);


--
-- Name: idx_notification_dispatch_recipients_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_dispatch_recipients_school_id ON public.notification_dispatch_recipients USING btree (school_id);


--
-- Name: idx_notification_dispatch_recipients_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_dispatch_recipients_user_id ON public.notification_dispatch_recipients USING btree (user_id);


--
-- Name: idx_notification_logs_batch_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_logs_batch_id ON public.notification_logs USING btree (batch_id);


--
-- Name: idx_notification_logs_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_logs_school_id ON public.notification_logs USING btree (school_id);


--
-- Name: idx_notification_logs_type_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_logs_type_date ON public.notification_logs USING btree (notification_type, created_at DESC);


--
-- Name: idx_notification_logs_user_type_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_logs_user_type_date ON public.notification_logs USING btree (user_id, notification_type, created_at);


--
-- Name: idx_notifications_unread_fetch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_unread_fetch ON public.notifications USING btree (user_id, created_at DESC) WHERE (status = ANY (ARRAY['PENDING'::public.notification_status, 'DELIVERED'::public.notification_status]));


--
-- Name: idx_parent_visits_school_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parent_visits_school_date ON public.parent_visits USING btree (school_id, visited_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_parent_visits_student_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parent_visits_student_date ON public.parent_visits USING btree (school_id, student_id, visited_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_parents_person_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_parents_person_active ON public.parents USING btree (school_id, person_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_parents_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parents_school_id ON public.parents USING btree (school_id);


--
-- Name: idx_participants_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_participants_conv ON public.message_participants USING btree (conversation_id);


--
-- Name: idx_participants_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_participants_user ON public.message_participants USING btree (user_id, school_id);


--
-- Name: idx_participants_user_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_participants_user_conv ON public.message_participants USING btree (user_id, school_id, conversation_id);


--
-- Name: idx_payroll_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_period ON public.staff_payroll USING btree (payroll_month, payroll_year);


--
-- Name: idx_payroll_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_staff ON public.staff_payroll USING btree (staff_id);


--
-- Name: idx_periods_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_periods_school_id ON public.periods USING btree (school_id);


--
-- Name: idx_permissions_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_permissions_school_id ON public.permissions USING btree (school_id);


--
-- Name: idx_person_contacts_person_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_person_contacts_person_id ON public.person_contacts USING btree (person_id);


--
-- Name: idx_person_contacts_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_person_contacts_school_id ON public.person_contacts USING btree (school_id);


--
-- Name: idx_persons_display_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_persons_display_name_trgm ON public.persons USING gin (display_name extensions.gin_trgm_ops);


--
-- Name: idx_persons_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_persons_name_trgm ON public.persons USING gin (first_name extensions.gin_trgm_ops, last_name extensions.gin_trgm_ops);


--
-- Name: idx_persons_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_persons_school_id ON public.persons USING btree (school_id);


--
-- Name: idx_receipt_items_receipt_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receipt_items_receipt_id ON public.receipt_items USING btree (receipt_id);


--
-- Name: idx_receipt_items_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receipt_items_school_id ON public.receipt_items USING btree (school_id);


--
-- Name: idx_receipt_items_transaction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receipt_items_transaction_id ON public.receipt_items USING btree (fee_transaction_id);


--
-- Name: idx_receipts_fee_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receipts_fee_type ON public.receipts USING btree (school_id, fee_type);


--
-- Name: idx_receipts_group_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_receipts_group_unique ON public.receipts USING btree (school_id, receipt_group) WHERE (receipt_group IS NOT NULL);


--
-- Name: idx_receipts_payment_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receipts_payment_type ON public.receipts USING btree (school_id, payment_type);


--
-- Name: idx_receipts_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_receipts_school_id ON public.receipts USING btree (school_id);


--
-- Name: idx_role_permissions_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_permissions_school_id ON public.role_permissions USING btree (school_id);


--
-- Name: idx_roles_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roles_school_id ON public.roles USING btree (school_id);


--
-- Name: idx_route_segment_time_route; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_route_segment_time_route ON public.route_segment_time USING btree (school_id, route_id, trip_direction);


--
-- Name: idx_route_segment_time_school_route_leg_endpoints; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_route_segment_time_school_route_leg_endpoints ON public.route_segment_time USING btree (school_id, route_id, trip_direction, from_stop_id, to_stop_id);


--
-- Name: idx_route_stop_geo_route; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_route_stop_geo_route ON public.route_stop_geo USING btree (school_id, route_id, trip_direction);


--
-- Name: idx_route_stop_geo_school_route_leg_stop; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_route_stop_geo_school_route_leg_stop ON public.route_stop_geo USING btree (school_id, route_id, trip_direction, stop_id);


--
-- Name: idx_routes_bus; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_routes_bus ON public.transport_routes USING btree (bus_id);


--
-- Name: idx_saas_subscription_payments_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_saas_subscription_payments_school ON public.saas_subscription_payments USING btree (school_id, created_at DESC);


--
-- Name: idx_saas_subscription_payments_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_saas_subscription_payments_status ON public.saas_subscription_payments USING btree (status, created_at DESC);


--
-- Name: idx_saas_subscription_receipts_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_saas_subscription_receipts_school ON public.saas_subscription_receipts USING btree (school_id, issued_at DESC, created_at DESC);


--
-- Name: idx_school_checklists_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_school_checklists_school ON public.school_onboarding_checklists USING btree (school_id);


--
-- Name: idx_school_checklists_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_school_checklists_task ON public.school_onboarding_checklists USING btree (school_id, task_key);


--
-- Name: idx_school_feature_flags_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_school_feature_flags_lookup ON public.school_feature_flags USING btree (school_id, role);


--
-- Name: idx_school_requirements_raised_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_school_requirements_raised_by ON public.school_requirements USING btree (raised_by);


--
-- Name: idx_school_requirements_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_school_requirements_school ON public.school_requirements USING btree (school_id);


--
-- Name: idx_school_requirements_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_school_requirements_status ON public.school_requirements USING btree (status);


--
-- Name: idx_school_website_gallery_school_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_school_website_gallery_school_order ON public.school_website_gallery USING btree (school_id, display_order, created_at, id);


--
-- Name: idx_science_projects_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_science_projects_school_id ON public.science_projects USING btree (school_id);


--
-- Name: idx_sections_name_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_sections_name_active ON public.sections USING btree (school_id, name) WHERE (deleted_at IS NULL);


--
-- Name: idx_sections_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sections_school_id ON public.sections USING btree (school_id);


--
-- Name: idx_staff_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_active ON public.staff USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: idx_staff_attendance_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_attendance_date ON public.staff_attendance USING btree (attendance_date);


--
-- Name: idx_staff_attendance_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_attendance_school_id ON public.staff_attendance USING btree (school_id);


--
-- Name: idx_staff_attendance_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_attendance_staff ON public.staff_attendance USING btree (staff_id);


--
-- Name: idx_staff_code_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_staff_code_active ON public.staff USING btree (school_id, staff_code) WHERE (deleted_at IS NULL);


--
-- Name: idx_staff_designations_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_designations_school_id ON public.staff_designations USING btree (school_id);


--
-- Name: idx_staff_payroll_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_payroll_school_id ON public.staff_payroll USING btree (school_id);


--
-- Name: idx_staff_person_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_staff_person_active ON public.staff USING btree (school_id, person_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_staff_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_school ON public.staff USING btree (school_id);


--
-- Name: idx_staff_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_school_id ON public.staff USING btree (school_id);


--
-- Name: idx_staff_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_status ON public.staff USING btree (status_id);


--
-- Name: idx_student_bulk_update_batches_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_bulk_update_batches_school ON public.student_bulk_update_batches USING btree (school_id, created_at DESC);


--
-- Name: idx_student_bulk_update_rows_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_bulk_update_rows_batch ON public.student_bulk_update_rows USING btree (batch_id, row_number);


--
-- Name: idx_student_bulk_update_rows_student; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_bulk_update_rows_student ON public.student_bulk_update_rows USING btree (school_id, student_id) WHERE (student_id IS NOT NULL);


--
-- Name: idx_student_enrollments_class_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_enrollments_class_section ON public.student_enrollments USING btree (class_section_id);


--
-- Name: idx_student_enrollments_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_enrollments_school_id ON public.student_enrollments USING btree (school_id);


--
-- Name: idx_student_fees_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_fees_school_id ON public.student_fees USING btree (school_id);


--
-- Name: idx_student_fees_school_status_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_fees_school_status_due ON public.student_fees USING btree (school_id, status, due_date) WHERE (deleted_at IS NULL);


--
-- Name: idx_student_fees_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_fees_status ON public.student_fees USING btree (status);


--
-- Name: idx_student_fees_structure_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_fees_structure_id ON public.student_fees USING btree (fee_structure_id);


--
-- Name: idx_student_fees_student; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_fees_student ON public.student_fees USING btree (student_id);


--
-- Name: idx_student_fees_unique_assignment; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_student_fees_unique_assignment ON public.student_fees USING btree (student_id, fee_structure_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_student_life_values_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_life_values_school_id ON public.student_life_values_progress USING btree (school_id);


--
-- Name: idx_student_money_science_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_money_science_school_id ON public.student_money_science_progress USING btree (school_id);


--
-- Name: idx_student_parents_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_parents_school_id ON public.student_parents USING btree (school_id);


--
-- Name: idx_student_science_projects_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_science_projects_school_id ON public.student_science_projects USING btree (school_id);


--
-- Name: idx_student_transport_bus; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_transport_bus ON public.student_transport USING btree (bus_id);


--
-- Name: idx_student_transport_route; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_transport_route ON public.student_transport USING btree (route_id);


--
-- Name: idx_student_transpschool_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_student_transpschool_id ON public.student_transport USING btree (school_id);


--
-- Name: idx_students_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_students_active ON public.students USING btree (id) WHERE (deleted_at IS NULL);


--
-- Name: idx_students_admission_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_students_admission_active ON public.students USING btree (school_id, admission_no) WHERE (deleted_at IS NULL);


--
-- Name: idx_students_admission_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_students_admission_trgm ON public.students USING gin (admission_no extensions.gin_trgm_ops);


--
-- Name: idx_students_exit_academic_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_students_exit_academic_year ON public.students USING btree (school_id, exit_academic_year_id) WHERE ((deleted_at IS NULL) AND (exit_academic_year_id IS NOT NULL));


--
-- Name: idx_students_pen_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_students_pen_active ON public.students USING btree (school_id, pen_number) WHERE ((deleted_at IS NULL) AND (pen_number IS NOT NULL));


--
-- Name: idx_students_person_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_students_person_active ON public.students USING btree (school_id, person_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_students_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_students_school ON public.students USING btree (school_id);


--
-- Name: idx_students_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_students_school_id ON public.students USING btree (school_id);


--
-- Name: idx_students_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_students_status ON public.students USING btree (status_id);


--
-- Name: idx_subjects_code_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_subjects_code_active ON public.subjects USING btree (school_id, code) WHERE (deleted_at IS NULL);


--
-- Name: idx_subjects_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subjects_school_id ON public.subjects USING btree (school_id);


--
-- Name: idx_substitutions_leave; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_substitutions_leave ON public.timetable_substitutions USING btree (school_id, leave_application_id) WHERE (leave_application_id IS NOT NULL);


--
-- Name: idx_support_notification_outbox_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_notification_outbox_queue ON public.support_message_notification_outbox USING btree (status, available_at) WHERE (status = ANY (ARRAY['PENDING'::text, 'FAILED'::text]));


--
-- Name: idx_support_ticket_messages_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_ticket_messages_ticket ON public.support_ticket_messages USING btree (ticket_id, created_at);


--
-- Name: idx_support_ticket_notes_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_ticket_notes_ticket ON public.support_ticket_notes USING btree (ticket_id);


--
-- Name: idx_support_tickets_assigned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_tickets_assigned ON public.support_tickets USING btree (school_id, assigned_to) WHERE (assigned_to IS NOT NULL);


--
-- Name: idx_support_tickets_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_tickets_category ON public.support_tickets USING btree (school_id, category);


--
-- Name: idx_support_tickets_school_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_tickets_school_parent ON public.support_tickets USING btree (school_id, parent_id);


--
-- Name: idx_support_tickets_school_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_tickets_school_status ON public.support_tickets USING btree (school_id, status);


--
-- Name: idx_temp_access_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_temp_access_lookup ON public.temp_access_grants USING btree (requested_by, department) WHERE (is_active = true);


--
-- Name: idx_timetable_class; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timetable_class ON public.timetable_slots USING btree (class_section_id);


--
-- Name: idx_timetable_slots_section_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timetable_slots_section_day ON public.timetable_slots USING btree (class_section_id, academic_year_id, day_of_week) WHERE (deleted_at IS NULL);


--
-- Name: idx_timetable_slots_time_check; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timetable_slots_time_check ON public.timetable_slots USING btree (teacher_id, start_time, end_time);


--
-- Name: idx_timetable_substitution_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timetable_substitution_date ON public.timetable_substitutions USING btree (school_id, substitution_date);


--
-- Name: idx_timetable_substitution_teacher_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timetable_substitution_teacher_date ON public.timetable_substitutions USING btree (substitute_teacher_id, substitution_date) WHERE (cancelled_at IS NULL);


--
-- Name: idx_timetable_teacher; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timetable_teacher ON public.timetable_slots USING btree (teacher_id);


--
-- Name: idx_trans_safety_school_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trans_safety_school_status ON public.transport_safety_incidents USING btree (school_id, status);


--
-- Name: idx_trans_safety_school_type_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trans_safety_school_type_date ON public.transport_safety_incidents USING btree (school_id, incident_type, started_at DESC);


--
-- Name: idx_trans_safety_student; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trans_safety_student ON public.transport_safety_incidents USING btree (school_id, student_id) WHERE (student_id IS NOT NULL);


--
-- Name: idx_transactions_paid_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transactions_paid_at ON public.fee_transactions USING btree (paid_at);


--
-- Name: idx_transport_fee_payments_collector_paid_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transport_fee_payments_collector_paid_at ON public.transport_fee_payments USING btree (school_id, received_by, paid_at DESC);


--
-- Name: idx_transport_fee_payments_refund_of; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transport_fee_payments_refund_of ON public.transport_fee_payments USING btree (school_id, refund_of) WHERE (refund_of IS NOT NULL);


--
-- Name: idx_transport_fee_payments_school_paid_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transport_fee_payments_school_paid_at ON public.transport_fee_payments USING btree (school_id, paid_at DESC);


--
-- Name: idx_transport_fee_payments_student_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transport_fee_payments_student_year ON public.transport_fee_payments USING btree (school_id, student_id, academic_year);


--
-- Name: idx_transport_fee_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transport_fee_school_id ON public.transport_fee USING btree (school_id);


--
-- Name: idx_transport_fee_stop_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transport_fee_stop_year ON public.transport_fee USING btree (school_id, stop_id, academic_year) WHERE (is_active = true);


--
-- Name: idx_transport_import_batches_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transport_import_batches_school ON public.transport_import_batches USING btree (school_id, created_at DESC);


--
-- Name: idx_transport_import_rows_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transport_import_rows_batch ON public.transport_import_rows USING btree (batch_id, row_number);


--
-- Name: idx_transport_routes_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transport_routes_active ON public.transport_routes USING btree (school_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_transport_routes_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transport_routes_school_id ON public.transport_routes USING btree (school_id);


--
-- Name: idx_transport_stops_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transport_stops_school_id ON public.transport_stops USING btree (school_id);


--
-- Name: idx_trip_stop_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trip_stop_status ON public.trip_stop_status USING btree (status);


--
-- Name: idx_trip_stop_status_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trip_stop_status_school_id ON public.trip_stop_status USING btree (school_id);


--
-- Name: idx_trip_stop_status_trip_school_order_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trip_stop_status_trip_school_order_status ON public.trip_stop_status USING btree (trip_id, school_id, stop_order, status);


--
-- Name: idx_trip_stop_trip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trip_stop_trip ON public.trip_stop_status USING btree (trip_id);


--
-- Name: idx_trips_active_like_bus; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_trips_active_like_bus ON public.trips USING btree (bus_id) WHERE ((status)::text = ANY ((ARRAY['active'::character varying, 'in_progress'::character varying])::text[]));


--
-- Name: idx_trips_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_driver ON public.trips USING btree (driver_id);


--
-- Name: idx_trips_route; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_route ON public.trips USING btree (route_id);


--
-- Name: idx_trips_route_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_route_date ON public.trips USING btree (school_id, route_id, trip_date);


--
-- Name: idx_trips_school_bus_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_school_bus_live ON public.trips USING btree (school_id, bus_id, created_at DESC) WHERE ((status)::text = ANY ((ARRAY['active'::character varying, 'in_progress'::character varying])::text[]));


--
-- Name: idx_trips_school_date_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_school_date_status ON public.trips USING btree (school_id, trip_date, status);


--
-- Name: idx_trips_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_school_id ON public.trips USING btree (school_id);


--
-- Name: idx_trips_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_status ON public.trips USING btree (status);


--
-- Name: idx_typing_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_typing_conv ON public.message_typing USING btree (conversation_id, updated_at DESC);


--
-- Name: idx_uac_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uac_school_id ON public.user_access_contexts USING btree (school_id);


--
-- Name: idx_uac_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uac_user_active ON public.user_access_contexts USING btree (user_id) WHERE ((deleted_at IS NULL) AND (revoked_at IS NULL) AND (is_switchable = true));


--
-- Name: idx_uas_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_uas_user_id ON public.user_active_sessions USING btree (user_id);


--
-- Name: idx_user_devices_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_devices_active ON public.user_devices USING btree (user_id, is_active);


--
-- Name: idx_user_devices_fcm_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_devices_fcm_token ON public.user_devices USING btree (fcm_token);


--
-- Name: idx_user_devices_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_devices_school_id ON public.user_devices USING btree (school_id);


--
-- Name: idx_user_devices_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_devices_user_id ON public.user_devices USING btree (user_id);


--
-- Name: idx_user_roles_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_roles_school_id ON public.user_roles USING btree (school_id);


--
-- Name: idx_user_settings_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_settings_school_id ON public.user_settings USING btree (school_id);


--
-- Name: idx_users_is_temporary_password; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_is_temporary_password ON public.users USING btree (is_temporary_password) WHERE (is_temporary_password = true);


--
-- Name: idx_users_last_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_last_active ON public.users USING btree (last_active_at);


--
-- Name: idx_users_person_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_users_person_active ON public.users USING btree (school_id, person_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_users_school_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_school_id ON public.users USING btree (school_id);


--
-- Name: idx_users_unrestricted_access; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_unrestricted_access ON public.users USING btree (school_id) WHERE (unrestricted_access = true);


--
-- Name: person_contacts_school_email_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX person_contacts_school_email_unique ON public.person_contacts USING btree (school_id, lower(contact_value)) WHERE ((contact_type = 'email'::public.contact_type_enum) AND (deleted_at IS NULL));


--
-- Name: timetable_entries_class_period_day_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX timetable_entries_class_period_day_key ON public.timetable_entries USING btree (class_section_id, period_id, day_of_week);


--
-- Name: unq_message_conversations_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX unq_message_conversations_pair ON public.message_conversations USING btree (school_id, participant_low_user_id, participant_high_user_id, COALESCE(student_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (is_group = false);


--
-- Name: unq_messages_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX unq_messages_client_id ON public.messages USING btree (conversation_id, sender_user_id, client_msg_id) WHERE (client_msg_id IS NOT NULL);


--
-- Name: unq_users_support_bot; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX unq_users_support_bot ON public.users USING btree (school_id) WHERE ((is_support_bot = true) AND (deleted_at IS NULL));


--
-- Name: uq_active_enrollment_roll_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_active_enrollment_roll_number ON public.student_enrollments USING btree (class_section_id, academic_year_id, roll_number) WHERE ((status = 'active'::public.enrollment_status_enum) AND (deleted_at IS NULL) AND (roll_number IS NOT NULL));


--
-- Name: uq_attendance_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_attendance_active ON public.daily_attendance USING btree (student_enrollment_id, attendance_date) WHERE (deleted_at IS NULL);


--
-- Name: uq_bus_trip_history_bus_recorded_at; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_bus_trip_history_bus_recorded_at ON public.bus_trip_history USING btree (bus_id, recorded_at);


--
-- Name: uq_crm_accounts_external_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_crm_accounts_external_ref ON public.crm_accounts USING btree (cluster_id, vertical, external_client_id) WHERE (external_client_id IS NOT NULL);


--
-- Name: uq_employee_documents_payslip; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_employee_documents_payslip ON public.employee_documents USING btree (payroll_run_id, document_type) WHERE (document_type = 'PAYSLIP'::text);


--
-- Name: uq_employee_documents_verification_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_employee_documents_verification_token ON public.employee_documents USING btree (verification_token);


--
-- Name: uq_hostel_active_bed; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_hostel_active_bed ON public.hostel_allocations USING btree (school_id, room_id, academic_year_id, bed_no) WHERE ((is_active = true) AND (bed_no IS NOT NULL));


--
-- Name: uq_internal_users_auth_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_internal_users_auth_user_id ON public.internal_users USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);


--
-- Name: uq_person_contact_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_person_contact_unique ON public.person_contacts USING btree (person_id, contact_type, lower(contact_value)) WHERE (deleted_at IS NULL);


--
-- Name: uq_primary_contact_only; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_primary_contact_only ON public.person_contacts USING btree (person_id, contact_type) WHERE (is_primary = true);


--
-- Name: uq_saas_subscription_payments_provider_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_saas_subscription_payments_provider_order ON public.saas_subscription_payments USING btree (provider_order_id) WHERE (provider_order_id IS NOT NULL);


--
-- Name: uq_student_primary_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_student_primary_parent ON public.student_parents USING btree (student_id) WHERE ((is_primary_contact = true) AND (deleted_at IS NULL));


--
-- Name: uq_timetable_slots_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_timetable_slots_active ON public.timetable_slots USING btree (class_section_id, academic_year_id, day_of_week, period_number) WHERE (deleted_at IS NULL);


--
-- Name: uq_timetable_substitute_period_date_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_timetable_substitute_period_date_active ON public.timetable_substitutions USING btree (school_id, substitution_date, substitute_teacher_id, period_number) WHERE (cancelled_at IS NULL);


--
-- Name: uq_timetable_substitution_slot_date_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_timetable_substitution_slot_date_active ON public.timetable_substitutions USING btree (school_id, substitution_date, timetable_slot_id) WHERE (cancelled_at IS NULL);


--
-- Name: uq_transport_stops_route_order_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_transport_stops_route_order_active ON public.transport_stops USING btree (school_id, route_id, stop_order) WHERE (deleted_at IS NULL);


--
-- Name: uq_trips_one_live_trip_per_bus; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_trips_one_live_trip_per_bus ON public.trips USING btree (school_id, bus_id) WHERE ((status)::text = ANY ((ARRAY['active'::character varying, 'in_progress'::character varying])::text[]));


--
-- Name: expenses audit_delete_expenses; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_delete_expenses BEFORE DELETE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.log_financial_destruction();


--
-- Name: staff_payroll audit_delete_payroll; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_delete_payroll BEFORE DELETE ON public.staff_payroll FOR EACH ROW EXECUTE FUNCTION public.log_financial_destruction();


--
-- Name: receipts audit_delete_receipts; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_delete_receipts BEFORE DELETE ON public.receipts FOR EACH ROW EXECUTE FUNCTION public.log_financial_destruction();


--
-- Name: student_fees audit_delete_student_fees; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_delete_student_fees BEFORE DELETE ON public.student_fees FOR EACH ROW EXECUTE FUNCTION public.log_financial_destruction();


--
-- Name: expenses enforce_expense_policy; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enforce_expense_policy BEFORE INSERT OR UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.trg_check_expense_policy();


--
-- Name: fee_transactions enforce_fee_cash_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enforce_fee_cash_limit BEFORE INSERT ON public.fee_transactions FOR EACH ROW EXECUTE FUNCTION public.trg_check_fee_cash_limit();


--
-- Name: daily_attendance trg_attendance_compute_status; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_attendance_compute_status BEFORE INSERT OR UPDATE ON public.daily_attendance FOR EACH ROW EXECUTE FUNCTION public.compute_attendance_day_status();


--
-- Name: daily_attendance trg_attendance_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_attendance_updated BEFORE UPDATE ON public.daily_attendance FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: student_enrollments trg_auto_assign_fees_enrollment; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_auto_assign_fees_enrollment AFTER INSERT OR UPDATE ON public.student_enrollments FOR EACH ROW EXECUTE FUNCTION public.auto_assign_fees_on_enrollment();


--
-- Name: fee_structures trg_auto_assign_fees_structure; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_auto_assign_fees_structure AFTER INSERT ON public.fee_structures FOR EACH ROW EXECUTE FUNCTION public.auto_assign_fees_on_structure_creation();


--
-- Name: student_fees trg_auto_fee_status; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_auto_fee_status BEFORE UPDATE ON public.student_fees FOR EACH ROW EXECUTE FUNCTION public.update_fee_status();


--
-- Name: fee_transactions trg_auto_receipt; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_auto_receipt AFTER INSERT ON public.fee_transactions FOR EACH ROW EXECUTE FUNCTION public.auto_generate_receipt();


--
-- Name: billing_documents trg_billing_documents_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_billing_documents_immutable BEFORE UPDATE ON public.billing_documents FOR EACH ROW EXECUTE FUNCTION public.billing_documents_guard_immutable();


--
-- Name: bus_stop_attendance trg_bus_stop_attendance_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bus_stop_attendance_updated BEFORE UPDATE ON public.bus_stop_attendance FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: class_subjects trg_class_subjects_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_class_subjects_updated BEFORE UPDATE ON public.class_subjects FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: complaints trg_complaints_ticket; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_complaints_ticket BEFORE INSERT ON public.complaints FOR EACH ROW EXECUTE FUNCTION public.generate_ticket_no();


--
-- Name: complaints trg_complaints_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_complaints_updated BEFORE UPDATE ON public.complaints FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: dcgd_programs trg_dcgd_programs_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_dcgd_programs_updated BEFORE UPDATE ON public.dcgd_programs FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: dcgd_settings trg_dcgd_settings_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_dcgd_settings_updated BEFORE UPDATE ON public.dcgd_settings FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: defaulter_dues trg_defaulter_due_balance; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_defaulter_due_balance BEFORE INSERT OR UPDATE OF original_amount, paid_amount ON public.defaulter_dues FOR EACH ROW EXECUTE FUNCTION public.refresh_defaulter_due_balance();


--
-- Name: diary_entries trg_diary_entries_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_diary_entries_updated BEFORE UPDATE ON public.diary_entries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: diary_entries trg_diary_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_diary_updated BEFORE UPDATE ON public.diary_entries FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: driver_route_assignments trg_driver_route_assignments_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_driver_route_assignments_updated BEFORE UPDATE ON public.driver_route_assignments FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: student_enrollments trg_enroll_active_student; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_enroll_active_student BEFORE INSERT OR UPDATE ON public.student_enrollments FOR EACH ROW EXECUTE FUNCTION public.ensure_active_student_enrollment();


--
-- Name: events trg_events_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_events_updated BEFORE UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: exam_room_allocations trg_exam_room_alloc_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_exam_room_alloc_updated BEFORE UPDATE ON public.exam_room_allocations FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: exam_rooms trg_exam_rooms_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_exam_rooms_updated BEFORE UPDATE ON public.exam_rooms FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: exam_seat_assignments trg_exam_seats_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_exam_seats_updated BEFORE UPDATE ON public.exam_seat_assignments FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: exam_subjects trg_exam_subjects_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_exam_subjects_updated BEFORE UPDATE ON public.exam_subjects FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: exams trg_exams_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_exams_updated BEFORE UPDATE ON public.exams FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: expenses trg_expenses_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_expenses_updated BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: feature_flags trg_feature_flags_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_feature_flags_updated BEFORE UPDATE ON public.feature_flags FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: fee_structures trg_fee_structures_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_fee_structures_updated BEFORE UPDATE ON public.fee_structures FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: fee_transactions trg_guard_fee_txn; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guard_fee_txn BEFORE DELETE OR UPDATE ON public.fee_transactions FOR EACH ROW EXECUTE FUNCTION public.prevent_fee_transaction_mutation();


--
-- Name: student_fees trg_guard_fee_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guard_fee_update BEFORE UPDATE ON public.student_fees FOR EACH ROW EXECUTE FUNCTION public.prevent_direct_fee_update();


--
-- Name: leave_applications trg_leave_payroll; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_leave_payroll AFTER INSERT OR UPDATE ON public.leave_applications FOR EACH ROW EXECUTE FUNCTION public.trg_recalc_payroll_on_leave();


--
-- Name: leave_applications trg_leaves_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_leaves_updated BEFORE UPDATE ON public.leave_applications FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: lms_courses trg_lms_courses_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_lms_courses_updated BEFORE UPDATE ON public.lms_courses FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: marks trg_lock_published_result_marks; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_lock_published_result_marks BEFORE INSERT OR DELETE OR UPDATE ON public.marks FOR EACH ROW EXECUTE FUNCTION public.prevent_published_result_mark_changes();


--
-- Name: exam_subjects trg_lock_published_result_papers; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_lock_published_result_papers BEFORE INSERT OR DELETE OR UPDATE ON public.exam_subjects FOR EACH ROW EXECUTE FUNCTION public.prevent_published_result_paper_changes();


--
-- Name: marks trg_marks_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_marks_updated BEFORE UPDATE ON public.marks FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: message_conversations trg_message_conversations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_message_conversations_updated_at BEFORE UPDATE ON public.message_conversations FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: messages trg_messages_update_conversation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_messages_update_conversation AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.update_conversation_on_message();


--
-- Name: persons trg_normalize_person_optional_names; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_normalize_person_optional_names BEFORE INSERT OR UPDATE ON public.persons FOR EACH ROW EXECUTE FUNCTION public.normalize_optional_name();


--
-- Name: notices trg_notices_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notices_updated BEFORE UPDATE ON public.notices FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: parent_visits trg_parent_visits_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_parent_visits_updated BEFORE UPDATE ON public.parent_visits FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: parents trg_parents_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_parents_updated BEFORE UPDATE ON public.parents FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: person_contacts trg_person_contacts_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_person_contacts_updated BEFORE UPDATE ON public.person_contacts FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: persons trg_persons_display_name; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_persons_display_name BEFORE INSERT OR UPDATE ON public.persons FOR EACH ROW EXECUTE FUNCTION public.update_person_display_name();


--
-- Name: persons trg_persons_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_persons_updated BEFORE UPDATE ON public.persons FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: complaints trg_prevent_complaint_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_prevent_complaint_delete BEFORE DELETE ON public.complaints FOR EACH ROW EXECUTE FUNCTION public.prevent_complaint_delete();


--
-- Name: fee_structures trg_propagate_fee_updates; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_propagate_fee_updates AFTER UPDATE ON public.fee_structures FOR EACH ROW EXECUTE FUNCTION public.propagate_fee_structure_updates();


--
-- Name: roles trg_protect_system_roles_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_protect_system_roles_delete BEFORE DELETE ON public.roles FOR EACH ROW EXECUTE FUNCTION public.prevent_system_role_change();


--
-- Name: roles trg_protect_system_roles_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_protect_system_roles_update BEFORE UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION public.prevent_system_role_change();


--
-- Name: student_enrollments trg_recalculate_rolls_after_enrollment_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_recalculate_rolls_after_enrollment_change AFTER INSERT OR DELETE OR UPDATE OF class_section_id, academic_year_id, status, deleted_at ON public.student_enrollments FOR EACH ROW EXECUTE FUNCTION public.recalculate_rolls_after_enrollment_change();


--
-- Name: students trg_recalculate_rolls_after_student_delete_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_recalculate_rolls_after_student_delete_change AFTER UPDATE OF deleted_at ON public.students FOR EACH ROW EXECUTE FUNCTION public.recalculate_rolls_after_student_delete_change();


--
-- Name: persons trg_recalculate_rolls_after_student_name_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_recalculate_rolls_after_student_name_change AFTER UPDATE OF first_name, middle_name, last_name ON public.persons FOR EACH ROW EXECUTE FUNCTION public.recalculate_rolls_after_student_name_change();


--
-- Name: schools trg_school_seed_defaults; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_school_seed_defaults AFTER INSERT ON public.schools FOR EACH ROW EXECUTE FUNCTION public.trg_seed_school_on_create();


--
-- Name: school_website_gallery trg_school_website_gallery_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_school_website_gallery_updated BEFORE UPDATE ON public.school_website_gallery FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: staff trg_staff_active_person; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_staff_active_person BEFORE INSERT OR UPDATE ON public.staff FOR EACH ROW EXECUTE FUNCTION public.ensure_active_person_staff();


--
-- Name: staff_attendance trg_staff_attendance_payroll; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_staff_attendance_payroll AFTER INSERT OR DELETE OR UPDATE ON public.staff_attendance FOR EACH ROW EXECUTE FUNCTION public.trg_recalc_payroll_on_attendance();


--
-- Name: staff_attendance trg_staff_attendance_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_staff_attendance_updated BEFORE UPDATE ON public.staff_attendance FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: staff_payroll trg_staff_payroll_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_staff_payroll_updated BEFORE UPDATE ON public.staff_payroll FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: staff trg_staff_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_staff_updated BEFORE UPDATE ON public.staff FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: student_enrollments trg_student_enrollments_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_student_enrollments_updated BEFORE UPDATE ON public.student_enrollments FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: student_fees trg_student_fees_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_student_fees_updated BEFORE UPDATE ON public.student_fees FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: student_parents trg_student_parents_active; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_student_parents_active BEFORE INSERT OR UPDATE ON public.student_parents FOR EACH ROW EXECUTE FUNCTION public.ensure_active_student_parent();


--
-- Name: students trg_students_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_students_updated BEFORE UPDATE ON public.students FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: timetable_slots trg_sync_class_teacher; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_class_teacher AFTER INSERT OR DELETE OR UPDATE ON public.timetable_slots FOR EACH ROW EXECUTE FUNCTION public.sync_class_teacher_from_timetable();


--
-- Name: timetable_substitutions trg_timetable_substitutions_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_timetable_substitutions_updated BEFORE UPDATE ON public.timetable_substitutions FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: timetable_entries trg_timetable_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_timetable_updated BEFORE UPDATE ON public.timetable_entries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: timetable_slots trg_timetable_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_timetable_updated BEFORE UPDATE ON public.timetable_slots FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: transport_fee trg_transport_fee_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_transport_fee_updated BEFORE UPDATE ON public.transport_fee FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: transport_routes trg_transport_routes_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_transport_routes_updated BEFORE UPDATE ON public.transport_routes FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: trips trg_trips_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_trips_updated BEFORE UPDATE ON public.trips FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: user_access_contexts trg_uac_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_uac_updated BEFORE UPDATE ON public.user_access_contexts FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: fee_transactions trg_update_paid_on_transaction; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_update_paid_on_transaction AFTER INSERT ON public.fee_transactions FOR EACH ROW EXECUTE FUNCTION public.update_fee_paid_amount();


--
-- Name: users trg_user_active_person; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_user_active_person BEFORE INSERT OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.ensure_active_person_ref();


--
-- Name: user_settings trg_user_settings_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_user_settings_updated BEFORE UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: users trg_users_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();


--
-- Name: daily_attendance trg_validate_attendance; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_attendance BEFORE INSERT OR UPDATE ON public.daily_attendance FOR EACH ROW EXECUTE FUNCTION public.validate_attendance_entry();


--
-- Name: diary_entries trg_validate_diary; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_diary BEFORE INSERT OR UPDATE ON public.diary_entries FOR EACH ROW EXECUTE FUNCTION public.validate_diary_entry();


--
-- Name: student_enrollments trg_validate_enrollment; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_enrollment BEFORE INSERT OR UPDATE ON public.student_enrollments FOR EACH ROW EXECUTE FUNCTION public.validate_enrollment_year();


--
-- Name: fee_structures trg_validate_fee_structure_mode; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_fee_structure_mode BEFORE INSERT OR UPDATE ON public.fee_structures FOR EACH ROW EXECUTE FUNCTION public.validate_fee_structure_mode();


--
-- Name: lms_courses trg_validate_lms_course; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_lms_course BEFORE UPDATE ON public.lms_courses FOR EACH ROW EXECUTE FUNCTION public.validate_lms_course_modify();


--
-- Name: marks trg_validate_marks; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_marks BEFORE INSERT OR UPDATE ON public.marks FOR EACH ROW EXECUTE FUNCTION public.validate_marks_entry();


--
-- Name: timetable_entries trg_validate_timetable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_timetable BEFORE INSERT ON public.timetable_entries FOR EACH ROW EXECUTE FUNCTION public.validate_timetable_entry();


--
-- Name: timetable_slots trg_validate_timetable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_timetable BEFORE INSERT OR UPDATE ON public.timetable_slots FOR EACH ROW EXECUTE FUNCTION public.validate_timetable_entry();


--
-- Name: schools zz_trg_school_hostel_rbac; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_trg_school_hostel_rbac AFTER INSERT ON public.schools FOR EACH ROW EXECUTE FUNCTION public.trg_seed_hostel_rbac_on_school_create();


--
-- Name: academic_years academic_years_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.academic_years
    ADD CONSTRAINT academic_years_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: access_requests access_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_requests
    ADD CONSTRAINT access_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: access_requests access_requests_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_requests
    ADD CONSTRAINT access_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: access_requests access_requests_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_requests
    ADD CONSTRAINT access_requests_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: admin_notifications admin_notifications_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notifications
    ADD CONSTRAINT admin_notifications_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: admin_quick_action_daily_usage admin_quick_action_daily_usage_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_quick_action_daily_usage
    ADD CONSTRAINT admin_quick_action_daily_usage_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: approval_requests approval_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: approval_requests approval_requests_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: approval_requests approval_requests_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: attendance_interventions attendance_interventions_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_interventions
    ADD CONSTRAINT attendance_interventions_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: attendance_interventions attendance_interventions_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_interventions
    ADD CONSTRAINT attendance_interventions_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: attendance_interventions attendance_interventions_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_interventions
    ADD CONSTRAINT attendance_interventions_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_logs audit_logs_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: automation_execution_logs automation_execution_logs_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_execution_logs
    ADD CONSTRAINT automation_execution_logs_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: bus_locations bus_locations_bus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_locations
    ADD CONSTRAINT bus_locations_bus_id_fkey FOREIGN KEY (bus_id) REFERENCES public.buses(id) ON DELETE CASCADE;


--
-- Name: bus_locations bus_locations_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_locations
    ADD CONSTRAINT bus_locations_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: bus_stop_attendance bus_stop_attendance_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_stop_attendance
    ADD CONSTRAINT bus_stop_attendance_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.staff(id) ON DELETE CASCADE;


--
-- Name: bus_stop_attendance bus_stop_attendance_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_stop_attendance
    ADD CONSTRAINT bus_stop_attendance_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.transport_routes(id) ON DELETE CASCADE;


--
-- Name: bus_stop_attendance bus_stop_attendance_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_stop_attendance
    ADD CONSTRAINT bus_stop_attendance_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: bus_stop_attendance bus_stop_attendance_stop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_stop_attendance
    ADD CONSTRAINT bus_stop_attendance_stop_id_fkey FOREIGN KEY (stop_id) REFERENCES public.transport_stops(id) ON DELETE CASCADE;


--
-- Name: bus_stop_attendance bus_stop_attendance_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_stop_attendance
    ADD CONSTRAINT bus_stop_attendance_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: bus_stop_attendance bus_stop_attendance_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_stop_attendance
    ADD CONSTRAINT bus_stop_attendance_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE CASCADE;


--
-- Name: bus_trip_history bus_trip_history_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bus_trip_history
    ADD CONSTRAINT bus_trip_history_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: buses buses_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buses
    ADD CONSTRAINT buses_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.staff(id);


--
-- Name: buses buses_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buses
    ADD CONSTRAINT buses_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.transport_routes(id) ON DELETE RESTRICT;


--
-- Name: buses buses_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buses
    ADD CONSTRAINT buses_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: class_sections class_sections_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_sections
    ADD CONSTRAINT class_sections_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE RESTRICT;


--
-- Name: class_sections class_sections_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_sections
    ADD CONSTRAINT class_sections_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.classes(id) ON DELETE RESTRICT;


--
-- Name: class_sections class_sections_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_sections
    ADD CONSTRAINT class_sections_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: class_sections class_sections_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_sections
    ADD CONSTRAINT class_sections_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE RESTRICT;


--
-- Name: class_subjects class_subjects_class_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_subjects
    ADD CONSTRAINT class_subjects_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES public.class_sections(id);


--
-- Name: class_subjects class_subjects_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_subjects
    ADD CONSTRAINT class_subjects_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: class_subjects class_subjects_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_subjects
    ADD CONSTRAINT class_subjects_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id);


--
-- Name: class_subjects class_subjects_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_subjects
    ADD CONSTRAINT class_subjects_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.staff(id);


--
-- Name: classes classes_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classes
    ADD CONSTRAINT classes_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: collections collections_approved_by_founder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_approved_by_founder_id_fkey FOREIGN KEY (approved_by_founder_id) REFERENCES public.founders(id);


--
-- Name: collections collections_business_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_business_unit_id_fkey FOREIGN KEY (business_unit_id) REFERENCES public.business_units(id);


--
-- Name: collections collections_created_by_founder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_created_by_founder_id_fkey FOREIGN KEY (created_by_founder_id) REFERENCES public.founders(id);


--
-- Name: complaints complaints_raised_for_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.complaints
    ADD CONSTRAINT complaints_raised_for_student_id_fkey FOREIGN KEY (raised_for_student_id) REFERENCES public.students(id);


--
-- Name: complaints complaints_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.complaints
    ADD CONSTRAINT complaints_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: context_switch_logs context_switch_logs_from_context_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_switch_logs
    ADD CONSTRAINT context_switch_logs_from_context_id_fkey FOREIGN KEY (from_context_id) REFERENCES public.user_access_contexts(id);


--
-- Name: context_switch_logs context_switch_logs_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_switch_logs
    ADD CONSTRAINT context_switch_logs_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: context_switch_logs context_switch_logs_to_context_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_switch_logs
    ADD CONSTRAINT context_switch_logs_to_context_id_fkey FOREIGN KEY (to_context_id) REFERENCES public.user_access_contexts(id);


--
-- Name: context_switch_logs context_switch_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_switch_logs
    ADD CONSTRAINT context_switch_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: crm_accounts crm_accounts_owner_founder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_accounts
    ADD CONSTRAINT crm_accounts_owner_founder_id_fkey FOREIGN KEY (owner_founder_id) REFERENCES public.founders(id) ON DELETE SET NULL;


--
-- Name: crm_activities crm_activities_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activities
    ADD CONSTRAINT crm_activities_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.crm_accounts(id) ON DELETE CASCADE;


--
-- Name: crm_activities crm_activities_enquiry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activities
    ADD CONSTRAINT crm_activities_enquiry_id_fkey FOREIGN KEY (enquiry_id) REFERENCES public.enquiries(id) ON DELETE CASCADE;


--
-- Name: crm_activities crm_activities_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_activities
    ADD CONSTRAINT crm_activities_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.crm_tasks(id) ON DELETE SET NULL;


--
-- Name: crm_automation_runs crm_automation_runs_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_automation_runs
    ADD CONSTRAINT crm_automation_runs_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.crm_automation_rules(id) ON DELETE SET NULL;


--
-- Name: crm_contacts crm_contacts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_contacts
    ADD CONSTRAINT crm_contacts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.crm_accounts(id) ON DELETE CASCADE;


--
-- Name: crm_tasks crm_tasks_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tasks
    ADD CONSTRAINT crm_tasks_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.crm_accounts(id) ON DELETE CASCADE;


--
-- Name: crm_tasks crm_tasks_automation_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tasks
    ADD CONSTRAINT crm_tasks_automation_rule_id_fkey FOREIGN KEY (automation_rule_id) REFERENCES public.crm_automation_rules(id) ON DELETE SET NULL;


--
-- Name: crm_tasks crm_tasks_enquiry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tasks
    ADD CONSTRAINT crm_tasks_enquiry_id_fkey FOREIGN KEY (enquiry_id) REFERENCES public.enquiries(id) ON DELETE CASCADE;


--
-- Name: crm_tasks crm_tasks_owner_founder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tasks
    ADD CONSTRAINT crm_tasks_owner_founder_id_fkey FOREIGN KEY (owner_founder_id) REFERENCES public.founders(id) ON DELETE SET NULL;


--
-- Name: daily_attendance daily_attendance_marked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_attendance
    ADD CONSTRAINT daily_attendance_marked_by_fkey FOREIGN KEY (marked_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: daily_attendance daily_attendance_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_attendance
    ADD CONSTRAINT daily_attendance_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: daily_attendance daily_attendance_student_enrollment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_attendance
    ADD CONSTRAINT daily_attendance_student_enrollment_id_fkey FOREIGN KEY (student_enrollment_id) REFERENCES public.student_enrollments(id) ON DELETE RESTRICT;


--
-- Name: defaulter_dues defaulter_dues_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.defaulter_dues
    ADD CONSTRAINT defaulter_dues_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: defaulter_dues defaulter_dues_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.defaulter_dues
    ADD CONSTRAINT defaulter_dues_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: defaulter_dues defaulter_dues_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.defaulter_dues
    ADD CONSTRAINT defaulter_dues_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE RESTRICT;


--
-- Name: defaulter_payments defaulter_payments_defaulter_due_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.defaulter_payments
    ADD CONSTRAINT defaulter_payments_defaulter_due_id_fkey FOREIGN KEY (defaulter_due_id) REFERENCES public.defaulter_dues(id) ON DELETE RESTRICT;


--
-- Name: defaulter_payments defaulter_payments_received_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.defaulter_payments
    ADD CONSTRAINT defaulter_payments_received_by_fkey FOREIGN KEY (received_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: defaulter_payments defaulter_payments_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.defaulter_payments
    ADD CONSTRAINT defaulter_payments_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: diary_entries diary_entries_class_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diary_entries
    ADD CONSTRAINT diary_entries_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES public.class_sections(id) ON DELETE RESTRICT;


--
-- Name: diary_entries diary_entries_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diary_entries
    ADD CONSTRAINT diary_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: diary_entries diary_entries_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diary_entries
    ADD CONSTRAINT diary_entries_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: diary_entries diary_entries_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diary_entries
    ADD CONSTRAINT diary_entries_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id) ON DELETE RESTRICT;


--
-- Name: discipline_records discipline_records_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discipline_records
    ADD CONSTRAINT discipline_records_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id);


--
-- Name: discipline_records discipline_records_reported_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discipline_records
    ADD CONSTRAINT discipline_records_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES public.users(id);


--
-- Name: discipline_records discipline_records_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discipline_records
    ADD CONSTRAINT discipline_records_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: discipline_records discipline_records_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discipline_records
    ADD CONSTRAINT discipline_records_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: driver_devices driver_devices_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_devices
    ADD CONSTRAINT driver_devices_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: driver_heartbeat driver_heartbeat_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_heartbeat
    ADD CONSTRAINT driver_heartbeat_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: driver_route_assignments driver_route_assignments_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_route_assignments
    ADD CONSTRAINT driver_route_assignments_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.staff(id) ON DELETE CASCADE;


--
-- Name: driver_route_assignments driver_route_assignments_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_route_assignments
    ADD CONSTRAINT driver_route_assignments_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.transport_routes(id) ON DELETE CASCADE;


--
-- Name: driver_route_assignments driver_route_assignments_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_route_assignments
    ADD CONSTRAINT driver_route_assignments_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: employee_documents employee_documents_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT;


--
-- Name: employee_documents employee_documents_payroll_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_documents
    ADD CONSTRAINT employee_documents_payroll_run_id_fkey FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id) ON DELETE SET NULL;


--
-- Name: enquiries enquiries_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enquiries
    ADD CONSTRAINT enquiries_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.crm_accounts(id) ON DELETE SET NULL;


--
-- Name: events events_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: events events_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: exam_room_allocations exam_room_allocations_exam_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_room_allocations
    ADD CONSTRAINT exam_room_allocations_exam_id_fkey FOREIGN KEY (exam_id) REFERENCES public.exams(id) ON DELETE CASCADE;


--
-- Name: exam_room_allocations exam_room_allocations_invigilator_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_room_allocations
    ADD CONSTRAINT exam_room_allocations_invigilator_staff_id_fkey FOREIGN KEY (invigilator_staff_id) REFERENCES public.staff(id);


--
-- Name: exam_room_allocations exam_room_allocations_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_room_allocations
    ADD CONSTRAINT exam_room_allocations_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.exam_rooms(id);


--
-- Name: exam_room_allocations exam_room_allocations_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_room_allocations
    ADD CONSTRAINT exam_room_allocations_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: exam_rooms exam_rooms_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_rooms
    ADD CONSTRAINT exam_rooms_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: exam_seat_assignments exam_seat_assignments_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_seat_assignments
    ADD CONSTRAINT exam_seat_assignments_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.classes(id);


--
-- Name: exam_seat_assignments exam_seat_assignments_exam_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_seat_assignments
    ADD CONSTRAINT exam_seat_assignments_exam_id_fkey FOREIGN KEY (exam_id) REFERENCES public.exams(id) ON DELETE CASCADE;


--
-- Name: exam_seat_assignments exam_seat_assignments_room_allocation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_seat_assignments
    ADD CONSTRAINT exam_seat_assignments_room_allocation_id_fkey FOREIGN KEY (room_allocation_id) REFERENCES public.exam_room_allocations(id) ON DELETE CASCADE;


--
-- Name: exam_seat_assignments exam_seat_assignments_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_seat_assignments
    ADD CONSTRAINT exam_seat_assignments_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: exam_seat_assignments exam_seat_assignments_student_enrollment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_seat_assignments
    ADD CONSTRAINT exam_seat_assignments_student_enrollment_id_fkey FOREIGN KEY (student_enrollment_id) REFERENCES public.student_enrollments(id) ON DELETE CASCADE;


--
-- Name: exam_subjects exam_subjects_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_subjects
    ADD CONSTRAINT exam_subjects_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.classes(id);


--
-- Name: exam_subjects exam_subjects_exam_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_subjects
    ADD CONSTRAINT exam_subjects_exam_id_fkey FOREIGN KEY (exam_id) REFERENCES public.exams(id) ON DELETE CASCADE;


--
-- Name: exam_subjects exam_subjects_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_subjects
    ADD CONSTRAINT exam_subjects_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: exam_subjects exam_subjects_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exam_subjects
    ADD CONSTRAINT exam_subjects_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id);


--
-- Name: exams exams_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id);


--
-- Name: exams exams_results_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_results_published_by_fkey FOREIGN KEY (results_published_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: exams exams_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exams
    ADD CONSTRAINT exams_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: expenses expenses_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: expenses expenses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: expenses expenses_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: feature_flags feature_flags_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: fee_adjustments fee_adjustments_adjusted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_adjustments
    ADD CONSTRAINT fee_adjustments_adjusted_by_fkey FOREIGN KEY (adjusted_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: fee_adjustments fee_adjustments_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_adjustments
    ADD CONSTRAINT fee_adjustments_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: fee_adjustments fee_adjustments_student_fee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_adjustments
    ADD CONSTRAINT fee_adjustments_student_fee_id_fkey FOREIGN KEY (student_fee_id) REFERENCES public.student_fees(id) ON DELETE RESTRICT;


--
-- Name: fee_adjustments fee_adjustments_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_adjustments
    ADD CONSTRAINT fee_adjustments_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE RESTRICT;


--
-- Name: fee_adjustments fee_adjustments_transport_fee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_adjustments
    ADD CONSTRAINT fee_adjustments_transport_fee_id_fkey FOREIGN KEY (transport_fee_id) REFERENCES public.transport_fee(id) ON DELETE RESTRICT;


--
-- Name: fee_structures fee_structures_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id);


--
-- Name: fee_structures fee_structures_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.classes(id);


--
-- Name: fee_structures fee_structures_fee_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_fee_type_id_fkey FOREIGN KEY (fee_type_id) REFERENCES public.fee_types(id);


--
-- Name: fee_structures fee_structures_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: fee_structures fee_structures_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_structures
    ADD CONSTRAINT fee_structures_section_id_fkey FOREIGN KEY (section_id) REFERENCES public.sections(id) ON DELETE RESTRICT;


--
-- Name: fee_transactions fee_transactions_received_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_transactions
    ADD CONSTRAINT fee_transactions_received_by_fkey FOREIGN KEY (received_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: fee_transactions fee_transactions_refund_of_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_transactions
    ADD CONSTRAINT fee_transactions_refund_of_fkey FOREIGN KEY (refund_of) REFERENCES public.fee_transactions(id) ON DELETE RESTRICT;


--
-- Name: fee_transactions fee_transactions_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_transactions
    ADD CONSTRAINT fee_transactions_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: fee_transactions fee_transactions_student_fee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_transactions
    ADD CONSTRAINT fee_transactions_student_fee_id_fkey FOREIGN KEY (student_fee_id) REFERENCES public.student_fees(id) ON DELETE RESTRICT;


--
-- Name: fee_types fee_types_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fee_types
    ADD CONSTRAINT fee_types_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: financial_audit_logs financial_audit_logs_performed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_audit_logs
    ADD CONSTRAINT financial_audit_logs_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES auth.users(id);


--
-- Name: financial_audit_logs financial_audit_logs_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_audit_logs
    ADD CONSTRAINT financial_audit_logs_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: financial_policy_rules financial_policy_rules_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_policy_rules
    ADD CONSTRAINT financial_policy_rules_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: financial_policy_rules financial_policy_rules_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_policy_rules
    ADD CONSTRAINT financial_policy_rules_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);


--
-- Name: messages fk_messages_forwarded_from; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT fk_messages_forwarded_from FOREIGN KEY (forwarded_from_message_id) REFERENCES public.messages(id) ON DELETE SET NULL;


--
-- Name: messages fk_messages_reply_to; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT fk_messages_reply_to FOREIGN KEY (reply_to_message_id) REFERENCES public.messages(id) ON DELETE SET NULL;


--
-- Name: generated_papers generated_papers_blueprint_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_papers
    ADD CONSTRAINT generated_papers_blueprint_id_fkey FOREIGN KEY (blueprint_id) REFERENCES public.blueprints(id) ON DELETE SET NULL;


--
-- Name: grading_scales grading_scales_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grading_scales
    ADD CONSTRAINT grading_scales_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: hostel_allocations hostel_allocations_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_allocations
    ADD CONSTRAINT hostel_allocations_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id);


--
-- Name: hostel_allocations hostel_allocations_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_allocations
    ADD CONSTRAINT hostel_allocations_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.hostel_rooms(id);


--
-- Name: hostel_allocations hostel_allocations_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_allocations
    ADD CONSTRAINT hostel_allocations_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: hostel_allocations hostel_allocations_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_allocations
    ADD CONSTRAINT hostel_allocations_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id);


--
-- Name: hostel_blocks hostel_blocks_gender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_blocks
    ADD CONSTRAINT hostel_blocks_gender_id_fkey FOREIGN KEY (gender_id) REFERENCES public.genders(id);


--
-- Name: hostel_blocks hostel_blocks_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_blocks
    ADD CONSTRAINT hostel_blocks_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: hostel_blocks hostel_blocks_warden_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_blocks
    ADD CONSTRAINT hostel_blocks_warden_id_fkey FOREIGN KEY (warden_id) REFERENCES public.staff(id);


--
-- Name: hostel_permission_requests hostel_permission_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_permission_requests
    ADD CONSTRAINT hostel_permission_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: hostel_permission_requests hostel_permission_requests_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_permission_requests
    ADD CONSTRAINT hostel_permission_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: hostel_permission_requests hostel_permission_requests_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_permission_requests
    ADD CONSTRAINT hostel_permission_requests_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: hostel_permission_requests hostel_permission_requests_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_permission_requests
    ADD CONSTRAINT hostel_permission_requests_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: hostel_rooms hostel_rooms_block_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_rooms
    ADD CONSTRAINT hostel_rooms_block_id_fkey FOREIGN KEY (block_id) REFERENCES public.hostel_blocks(id) ON DELETE CASCADE;


--
-- Name: hostel_rooms hostel_rooms_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hostel_rooms
    ADD CONSTRAINT hostel_rooms_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: internal_user_permission_overrides internal_user_permission_overrides_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_user_permission_overrides
    ADD CONSTRAINT internal_user_permission_overrides_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.internal_users(id) ON DELETE SET NULL;


--
-- Name: internal_user_permission_overrides internal_user_permission_overrides_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_user_permission_overrides
    ADD CONSTRAINT internal_user_permission_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.internal_users(id) ON DELETE CASCADE;


--
-- Name: internal_user_schools internal_user_schools_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_user_schools
    ADD CONSTRAINT internal_user_schools_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.internal_users(id) ON DELETE SET NULL;


--
-- Name: internal_user_schools internal_user_schools_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_user_schools
    ADD CONSTRAINT internal_user_schools_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.internal_users(id) ON DELETE CASCADE;


--
-- Name: internal_user_sessions internal_user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_user_sessions
    ADD CONSTRAINT internal_user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.internal_users(id) ON DELETE CASCADE;


--
-- Name: internal_users internal_users_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.internal_users
    ADD CONSTRAINT internal_users_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.internal_users(id) ON DELETE SET NULL;


--
-- Name: issued_certificates issued_certificates_issued_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: issued_certificates issued_certificates_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: issued_certificates issued_certificates_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.issued_certificates
    ADD CONSTRAINT issued_certificates_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id);


--
-- Name: leave_applications leave_applications_applicant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_applications
    ADD CONSTRAINT leave_applications_applicant_id_fkey FOREIGN KEY (applicant_id) REFERENCES public.users(id);


--
-- Name: leave_applications leave_applications_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_applications
    ADD CONSTRAINT leave_applications_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);


--
-- Name: leave_applications leave_applications_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_applications
    ADD CONSTRAINT leave_applications_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: life_values_modules life_values_modules_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.life_values_modules
    ADD CONSTRAINT life_values_modules_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id);


--
-- Name: life_values_modules life_values_modules_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.life_values_modules
    ADD CONSTRAINT life_values_modules_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: lms_courses lms_courses_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lms_courses
    ADD CONSTRAINT lms_courses_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.classes(id);


--
-- Name: lms_courses lms_courses_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lms_courses
    ADD CONSTRAINT lms_courses_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.staff(id);


--
-- Name: lms_courses lms_courses_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lms_courses
    ADD CONSTRAINT lms_courses_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: lms_courses lms_courses_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lms_courses
    ADD CONSTRAINT lms_courses_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id);


--
-- Name: lms_materials lms_materials_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lms_materials
    ADD CONSTRAINT lms_materials_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.lms_courses(id) ON DELETE CASCADE;


--
-- Name: lms_materials lms_materials_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lms_materials
    ADD CONSTRAINT lms_materials_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: marks marks_entered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_entered_by_fkey FOREIGN KEY (entered_by) REFERENCES public.users(id);


--
-- Name: marks marks_exam_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_exam_subject_id_fkey FOREIGN KEY (exam_subject_id) REFERENCES public.exam_subjects(id) ON DELETE CASCADE;


--
-- Name: marks marks_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: marks marks_student_enrollment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marks
    ADD CONSTRAINT marks_student_enrollment_id_fkey FOREIGN KEY (student_enrollment_id) REFERENCES public.student_enrollments(id);


--
-- Name: message_conversations message_conversations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_conversations
    ADD CONSTRAINT message_conversations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: message_conversations message_conversations_participant_high_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_conversations
    ADD CONSTRAINT message_conversations_participant_high_user_id_fkey FOREIGN KEY (participant_high_user_id) REFERENCES public.users(id);


--
-- Name: message_conversations message_conversations_participant_low_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_conversations
    ADD CONSTRAINT message_conversations_participant_low_user_id_fkey FOREIGN KEY (participant_low_user_id) REFERENCES public.users(id);


--
-- Name: message_conversations message_conversations_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_conversations
    ADD CONSTRAINT message_conversations_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: message_conversations message_conversations_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_conversations
    ADD CONSTRAINT message_conversations_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id);


--
-- Name: message_participants message_participants_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_participants
    ADD CONSTRAINT message_participants_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.message_conversations(id) ON DELETE CASCADE;


--
-- Name: message_participants message_participants_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_participants
    ADD CONSTRAINT message_participants_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: message_participants message_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_participants
    ADD CONSTRAINT message_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: message_typing message_typing_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_typing
    ADD CONSTRAINT message_typing_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.message_conversations(id) ON DELETE CASCADE;


--
-- Name: message_typing message_typing_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_typing
    ADD CONSTRAINT message_typing_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: message_typing message_typing_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_typing
    ADD CONSTRAINT message_typing_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.message_conversations(id) ON DELETE CASCADE;


--
-- Name: messages messages_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: messages messages_sender_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES public.users(id);


--
-- Name: money_science_modules money_science_modules_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.money_science_modules
    ADD CONSTRAINT money_science_modules_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: notices notices_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notices
    ADD CONSTRAINT notices_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: notices notices_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notices
    ADD CONSTRAINT notices_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: notices notices_target_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notices
    ADD CONSTRAINT notices_target_class_id_fkey FOREIGN KEY (target_class_id) REFERENCES public.classes(id);


--
-- Name: notification_audit_logs notification_audit_logs_delivery_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_audit_logs
    ADD CONSTRAINT notification_audit_logs_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES public.notification_deliveries(id);


--
-- Name: notification_audit_logs notification_audit_logs_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_audit_logs
    ADD CONSTRAINT notification_audit_logs_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notifications(id);


--
-- Name: notification_audit_logs notification_audit_logs_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_audit_logs
    ADD CONSTRAINT notification_audit_logs_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: notification_batches notification_batches_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_batches
    ADD CONSTRAINT notification_batches_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id);


--
-- Name: notification_batches notification_batches_parent_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_batches
    ADD CONSTRAINT notification_batches_parent_batch_id_fkey FOREIGN KEY (parent_batch_id) REFERENCES public.notification_batches(id) ON DELETE SET NULL;


--
-- Name: notification_batches notification_batches_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_batches
    ADD CONSTRAINT notification_batches_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: notification_deliveries notification_deliveries_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notifications(id) ON DELETE CASCADE;


--
-- Name: notification_deliveries notification_deliveries_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: notification_dispatch_recipients notification_dispatch_recipients_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_dispatch_recipients
    ADD CONSTRAINT notification_dispatch_recipients_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.notification_batches(id) ON DELETE CASCADE;


--
-- Name: notification_dispatch_recipients notification_dispatch_recipients_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_dispatch_recipients
    ADD CONSTRAINT notification_dispatch_recipients_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: notification_dispatch_recipients notification_dispatch_recipients_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_dispatch_recipients
    ADD CONSTRAINT notification_dispatch_recipients_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notification_events notification_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_events
    ADD CONSTRAINT notification_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: notification_events notification_events_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_events
    ADD CONSTRAINT notification_events_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: notification_events notification_events_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_events
    ADD CONSTRAINT notification_events_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notification_logs notification_logs_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_logs
    ADD CONSTRAINT notification_logs_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: notification_logs notification_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_logs
    ADD CONSTRAINT notification_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: notification_preferences notification_preferences_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: notification_preferences notification_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notification_templates notification_templates_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.notification_events(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: parent_visits parent_visits_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parent_visits
    ADD CONSTRAINT parent_visits_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parents(id) ON DELETE SET NULL;


--
-- Name: parent_visits parent_visits_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parent_visits
    ADD CONSTRAINT parent_visits_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: parent_visits parent_visits_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parent_visits
    ADD CONSTRAINT parent_visits_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: parent_visits parent_visits_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parent_visits
    ADD CONSTRAINT parent_visits_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE RESTRICT;


--
-- Name: parents parents_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parents
    ADD CONSTRAINT parents_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.persons(id) ON DELETE RESTRICT;


--
-- Name: parents parents_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parents
    ADD CONSTRAINT parents_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: payroll_runs payroll_runs_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT;


--
-- Name: periods periods_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.periods
    ADD CONSTRAINT periods_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: permissions permissions_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: person_contacts person_contacts_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.person_contacts
    ADD CONSTRAINT person_contacts_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.persons(id) ON DELETE RESTRICT;


--
-- Name: person_contacts person_contacts_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.person_contacts
    ADD CONSTRAINT person_contacts_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: persons persons_gender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persons
    ADD CONSTRAINT persons_gender_id_fkey FOREIGN KEY (gender_id) REFERENCES public.genders(id);


--
-- Name: persons persons_nationality_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persons
    ADD CONSTRAINT persons_nationality_code_fkey FOREIGN KEY (nationality_code) REFERENCES public.countries(code);


--
-- Name: persons persons_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.persons
    ADD CONSTRAINT persons_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: receipt_items receipt_items_fee_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_items
    ADD CONSTRAINT receipt_items_fee_transaction_id_fkey FOREIGN KEY (fee_transaction_id) REFERENCES public.fee_transactions(id);


--
-- Name: receipt_items receipt_items_receipt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_items
    ADD CONSTRAINT receipt_items_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES public.receipts(id) ON DELETE CASCADE;


--
-- Name: receipt_items receipt_items_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_items
    ADD CONSTRAINT receipt_items_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: receipt_number_counters receipt_number_counters_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipt_number_counters
    ADD CONSTRAINT receipt_number_counters_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: receipts receipts_defaulter_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_defaulter_payment_id_fkey FOREIGN KEY (defaulter_payment_id) REFERENCES public.defaulter_payments(id) ON DELETE SET NULL;


--
-- Name: receipts receipts_issued_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES public.users(id);


--
-- Name: receipts receipts_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: receipts receipts_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id);


--
-- Name: receipts receipts_transport_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_transport_payment_id_fkey FOREIGN KEY (transport_payment_id) REFERENCES public.transport_fee_payments(id) ON DELETE SET NULL;


--
-- Name: role_permissions role_permissions_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: roles roles_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: route_leg_calibration route_leg_calibration_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_leg_calibration
    ADD CONSTRAINT route_leg_calibration_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.transport_routes(id) ON DELETE CASCADE;


--
-- Name: route_leg_calibration route_leg_calibration_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_leg_calibration
    ADD CONSTRAINT route_leg_calibration_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: route_segment_time route_segment_time_from_stop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_segment_time
    ADD CONSTRAINT route_segment_time_from_stop_id_fkey FOREIGN KEY (from_stop_id) REFERENCES public.transport_stops(id) ON DELETE CASCADE;


--
-- Name: route_segment_time route_segment_time_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_segment_time
    ADD CONSTRAINT route_segment_time_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.transport_routes(id) ON DELETE CASCADE;


--
-- Name: route_segment_time route_segment_time_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_segment_time
    ADD CONSTRAINT route_segment_time_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: route_segment_time route_segment_time_to_stop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_segment_time
    ADD CONSTRAINT route_segment_time_to_stop_id_fkey FOREIGN KEY (to_stop_id) REFERENCES public.transport_stops(id) ON DELETE CASCADE;


--
-- Name: route_stop_geo route_stop_geo_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_stop_geo
    ADD CONSTRAINT route_stop_geo_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.transport_routes(id) ON DELETE CASCADE;


--
-- Name: route_stop_geo route_stop_geo_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_stop_geo
    ADD CONSTRAINT route_stop_geo_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: route_stop_geo route_stop_geo_stop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.route_stop_geo
    ADD CONSTRAINT route_stop_geo_stop_id_fkey FOREIGN KEY (stop_id) REFERENCES public.transport_stops(id) ON DELETE CASCADE;


--
-- Name: saas_subscription_payments saas_subscription_payments_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saas_subscription_payments
    ADD CONSTRAINT saas_subscription_payments_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: saas_subscription_receipts saas_subscription_receipts_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saas_subscription_receipts
    ADD CONSTRAINT saas_subscription_receipts_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: saas_subscriptions saas_subscriptions_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saas_subscriptions
    ADD CONSTRAINT saas_subscriptions_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: school_automation_rules school_automation_rules_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_automation_rules
    ADD CONSTRAINT school_automation_rules_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: school_feature_flags school_feature_flags_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_feature_flags
    ADD CONSTRAINT school_feature_flags_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: school_onboarding_checklists school_onboarding_checklists_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_onboarding_checklists
    ADD CONSTRAINT school_onboarding_checklists_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.internal_users(id) ON DELETE SET NULL;


--
-- Name: school_requirements school_requirements_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_requirements
    ADD CONSTRAINT school_requirements_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.internal_users(id) ON DELETE SET NULL;


--
-- Name: school_requirements school_requirements_raised_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_requirements
    ADD CONSTRAINT school_requirements_raised_by_fkey FOREIGN KEY (raised_by) REFERENCES public.internal_users(id) ON DELETE SET NULL;


--
-- Name: school_settings school_settings_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_settings
    ADD CONSTRAINT school_settings_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: school_website_gallery school_website_gallery_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_website_gallery
    ADD CONSTRAINT school_website_gallery_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: school_website_gallery school_website_gallery_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_website_gallery
    ADD CONSTRAINT school_website_gallery_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: science_projects science_projects_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.science_projects
    ADD CONSTRAINT science_projects_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: sections sections_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sections
    ADD CONSTRAINT sections_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: staff_attendance staff_attendance_marked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_marked_by_fkey FOREIGN KEY (marked_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: staff_attendance staff_attendance_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: staff_attendance staff_attendance_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;


--
-- Name: staff staff_designation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_designation_id_fkey FOREIGN KEY (designation_id) REFERENCES public.staff_designations(id);


--
-- Name: staff_designations staff_designations_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_designations
    ADD CONSTRAINT staff_designations_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: staff_payroll staff_payroll_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_payroll
    ADD CONSTRAINT staff_payroll_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: staff_payroll staff_payroll_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_payroll
    ADD CONSTRAINT staff_payroll_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE CASCADE;


--
-- Name: staff staff_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.persons(id) ON DELETE RESTRICT;


--
-- Name: staff staff_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: staff staff_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_status_id_fkey FOREIGN KEY (status_id) REFERENCES public.staff_statuses(id);


--
-- Name: student_bulk_update_batches student_bulk_update_batches_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_bulk_update_batches
    ADD CONSTRAINT student_bulk_update_batches_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: student_bulk_update_batches student_bulk_update_batches_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_bulk_update_batches
    ADD CONSTRAINT student_bulk_update_batches_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: student_bulk_update_rows student_bulk_update_rows_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_bulk_update_rows
    ADD CONSTRAINT student_bulk_update_rows_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.student_bulk_update_batches(id) ON DELETE CASCADE;


--
-- Name: student_bulk_update_rows student_bulk_update_rows_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_bulk_update_rows
    ADD CONSTRAINT student_bulk_update_rows_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.persons(id) ON DELETE SET NULL;


--
-- Name: student_bulk_update_rows student_bulk_update_rows_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_bulk_update_rows
    ADD CONSTRAINT student_bulk_update_rows_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: student_bulk_update_rows student_bulk_update_rows_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_bulk_update_rows
    ADD CONSTRAINT student_bulk_update_rows_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE SET NULL;


--
-- Name: student_enrollments student_enrollments_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_enrollments
    ADD CONSTRAINT student_enrollments_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE RESTRICT;


--
-- Name: student_enrollments student_enrollments_class_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_enrollments
    ADD CONSTRAINT student_enrollments_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES public.class_sections(id) ON DELETE RESTRICT;


--
-- Name: student_enrollments student_enrollments_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_enrollments
    ADD CONSTRAINT student_enrollments_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: student_enrollments student_enrollments_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_enrollments
    ADD CONSTRAINT student_enrollments_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE RESTRICT;


--
-- Name: student_fees student_fees_fee_structure_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_fees
    ADD CONSTRAINT student_fees_fee_structure_id_fkey FOREIGN KEY (fee_structure_id) REFERENCES public.fee_structures(id) ON DELETE RESTRICT;


--
-- Name: student_fees student_fees_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_fees
    ADD CONSTRAINT student_fees_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: student_fees student_fees_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_fees
    ADD CONSTRAINT student_fees_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE RESTRICT;


--
-- Name: student_life_values_progress student_life_values_progress_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_life_values_progress
    ADD CONSTRAINT student_life_values_progress_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id);


--
-- Name: student_life_values_progress student_life_values_progress_module_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_life_values_progress
    ADD CONSTRAINT student_life_values_progress_module_id_fkey FOREIGN KEY (module_id) REFERENCES public.life_values_modules(id) ON DELETE CASCADE;


--
-- Name: student_life_values_progress student_life_values_progress_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_life_values_progress
    ADD CONSTRAINT student_life_values_progress_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: student_life_values_progress student_life_values_progress_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_life_values_progress
    ADD CONSTRAINT student_life_values_progress_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: student_money_science_progress student_money_science_progress_module_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_money_science_progress
    ADD CONSTRAINT student_money_science_progress_module_id_fkey FOREIGN KEY (module_id) REFERENCES public.money_science_modules(id) ON DELETE CASCADE;


--
-- Name: student_money_science_progress student_money_science_progress_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_money_science_progress
    ADD CONSTRAINT student_money_science_progress_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: student_money_science_progress student_money_science_progress_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_money_science_progress
    ADD CONSTRAINT student_money_science_progress_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: student_parents student_parents_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_parents
    ADD CONSTRAINT student_parents_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parents(id) ON DELETE RESTRICT;


--
-- Name: student_parents student_parents_relationship_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_parents
    ADD CONSTRAINT student_parents_relationship_id_fkey FOREIGN KEY (relationship_id) REFERENCES public.relationship_types(id);


--
-- Name: student_parents student_parents_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_parents
    ADD CONSTRAINT student_parents_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: student_parents student_parents_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_parents
    ADD CONSTRAINT student_parents_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE RESTRICT;


--
-- Name: student_science_projects student_science_projects_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_science_projects
    ADD CONSTRAINT student_science_projects_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.science_projects(id) ON DELETE CASCADE;


--
-- Name: student_science_projects student_science_projects_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_science_projects
    ADD CONSTRAINT student_science_projects_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: student_science_projects student_science_projects_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_science_projects
    ADD CONSTRAINT student_science_projects_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: student_transport student_transport_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_transport
    ADD CONSTRAINT student_transport_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE RESTRICT;


--
-- Name: student_transport student_transport_bus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_transport
    ADD CONSTRAINT student_transport_bus_id_fkey FOREIGN KEY (bus_id) REFERENCES public.buses(id);


--
-- Name: student_transport student_transport_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_transport
    ADD CONSTRAINT student_transport_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.transport_routes(id) ON DELETE RESTRICT;


--
-- Name: student_transport student_transport_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_transport
    ADD CONSTRAINT student_transport_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: student_transport student_transport_stop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_transport
    ADD CONSTRAINT student_transport_stop_id_fkey FOREIGN KEY (stop_id) REFERENCES public.transport_stops(id) ON DELETE SET NULL;


--
-- Name: student_transport student_transport_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_transport
    ADD CONSTRAINT student_transport_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: students students_blood_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_blood_group_id_fkey FOREIGN KEY (blood_group_id) REFERENCES public.blood_groups(id);


--
-- Name: students students_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.student_categories(id);


--
-- Name: students students_exit_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_exit_academic_year_id_fkey FOREIGN KEY (exit_academic_year_id) REFERENCES public.academic_years(id) ON DELETE RESTRICT;


--
-- Name: students students_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.persons(id) ON DELETE RESTRICT;


--
-- Name: students students_religion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_religion_id_fkey FOREIGN KEY (religion_id) REFERENCES public.religions(id);


--
-- Name: students students_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: students students_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_status_id_fkey FOREIGN KEY (status_id) REFERENCES public.student_statuses(id);


--
-- Name: subjects subjects_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: super_admins super_admins_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.super_admins
    ADD CONSTRAINT super_admins_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.super_admins(id) ON DELETE SET NULL;


--
-- Name: super_admins super_admins_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.super_admins
    ADD CONSTRAINT super_admins_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: support_message_notification_outbox support_message_notification_outbox_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_message_notification_outbox
    ADD CONSTRAINT support_message_notification_outbox_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.message_conversations(id) ON DELETE CASCADE;


--
-- Name: support_message_notification_outbox support_message_notification_outbox_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_message_notification_outbox
    ADD CONSTRAINT support_message_notification_outbox_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: support_message_notification_outbox support_message_notification_outbox_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_message_notification_outbox
    ADD CONSTRAINT support_message_notification_outbox_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: support_message_notification_outbox support_message_notification_outbox_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_message_notification_outbox
    ADD CONSTRAINT support_message_notification_outbox_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: support_ticket_messages support_ticket_messages_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_ticket_messages
    ADD CONSTRAINT support_ticket_messages_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: support_ticket_messages support_ticket_messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_ticket_messages
    ADD CONSTRAINT support_ticket_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: support_ticket_messages support_ticket_messages_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_ticket_messages
    ADD CONSTRAINT support_ticket_messages_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.support_tickets(id) ON DELETE CASCADE;


--
-- Name: support_ticket_notes support_ticket_notes_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_ticket_notes
    ADD CONSTRAINT support_ticket_notes_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.internal_users(id) ON DELETE SET NULL;


--
-- Name: support_tickets support_tickets_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: support_tickets support_tickets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: support_tickets support_tickets_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parents(id) ON DELETE CASCADE;


--
-- Name: support_tickets support_tickets_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: support_tickets support_tickets_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE SET NULL;


--
-- Name: temp_access_grants temp_access_grants_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temp_access_grants
    ADD CONSTRAINT temp_access_grants_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: temp_access_grants temp_access_grants_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temp_access_grants
    ADD CONSTRAINT temp_access_grants_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: temp_access_grants temp_access_grants_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temp_access_grants
    ADD CONSTRAINT temp_access_grants_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: ticket_number_counters ticket_number_counters_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_number_counters
    ADD CONSTRAINT ticket_number_counters_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: timetable_entries timetable_entries_class_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES public.class_sections(id);


--
-- Name: timetable_entries timetable_entries_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.periods(id);


--
-- Name: timetable_entries timetable_entries_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: timetable_entries timetable_entries_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id);


--
-- Name: timetable_entries timetable_entries_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_entries
    ADD CONSTRAINT timetable_entries_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.staff(id);


--
-- Name: timetable_slots timetable_slots_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_slots
    ADD CONSTRAINT timetable_slots_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE RESTRICT;


--
-- Name: timetable_slots timetable_slots_class_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_slots
    ADD CONSTRAINT timetable_slots_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES public.class_sections(id) ON DELETE RESTRICT;


--
-- Name: timetable_slots timetable_slots_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_slots
    ADD CONSTRAINT timetable_slots_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id);


--
-- Name: timetable_slots timetable_slots_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_slots
    ADD CONSTRAINT timetable_slots_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id) ON DELETE RESTRICT;


--
-- Name: timetable_slots timetable_slots_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_slots
    ADD CONSTRAINT timetable_slots_teacher_id_fkey FOREIGN KEY (teacher_id) REFERENCES public.staff(id) ON DELETE RESTRICT;


--
-- Name: timetable_substitutions timetable_substitutions_absent_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_substitutions
    ADD CONSTRAINT timetable_substitutions_absent_teacher_id_fkey FOREIGN KEY (absent_teacher_id) REFERENCES public.staff(id) ON DELETE RESTRICT;


--
-- Name: timetable_substitutions timetable_substitutions_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_substitutions
    ADD CONSTRAINT timetable_substitutions_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE RESTRICT;


--
-- Name: timetable_substitutions timetable_substitutions_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_substitutions
    ADD CONSTRAINT timetable_substitutions_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: timetable_substitutions timetable_substitutions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_substitutions
    ADD CONSTRAINT timetable_substitutions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: timetable_substitutions timetable_substitutions_leave_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_substitutions
    ADD CONSTRAINT timetable_substitutions_leave_application_id_fkey FOREIGN KEY (leave_application_id) REFERENCES public.leave_applications(id) ON DELETE SET NULL;


--
-- Name: timetable_substitutions timetable_substitutions_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_substitutions
    ADD CONSTRAINT timetable_substitutions_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: timetable_substitutions timetable_substitutions_substitute_teacher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_substitutions
    ADD CONSTRAINT timetable_substitutions_substitute_teacher_id_fkey FOREIGN KEY (substitute_teacher_id) REFERENCES public.staff(id) ON DELETE RESTRICT;


--
-- Name: timetable_substitutions timetable_substitutions_timetable_slot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timetable_substitutions
    ADD CONSTRAINT timetable_substitutions_timetable_slot_id_fkey FOREIGN KEY (timetable_slot_id) REFERENCES public.timetable_slots(id) ON DELETE RESTRICT;


--
-- Name: transport_fee transport_fee_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_fee
    ADD CONSTRAINT transport_fee_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: transport_fee_payments transport_fee_payments_received_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_fee_payments
    ADD CONSTRAINT transport_fee_payments_received_by_fkey FOREIGN KEY (received_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: transport_fee_payments transport_fee_payments_refund_of_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_fee_payments
    ADD CONSTRAINT transport_fee_payments_refund_of_fkey FOREIGN KEY (refund_of) REFERENCES public.transport_fee_payments(id) ON DELETE RESTRICT;


--
-- Name: transport_fee_payments transport_fee_payments_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_fee_payments
    ADD CONSTRAINT transport_fee_payments_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: transport_fee_payments transport_fee_payments_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_fee_payments
    ADD CONSTRAINT transport_fee_payments_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE RESTRICT;


--
-- Name: transport_fee_payments transport_fee_payments_transport_fee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_fee_payments
    ADD CONSTRAINT transport_fee_payments_transport_fee_id_fkey FOREIGN KEY (transport_fee_id) REFERENCES public.transport_fee(id) ON DELETE SET NULL;


--
-- Name: transport_fee transport_fee_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_fee
    ADD CONSTRAINT transport_fee_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.transport_routes(id) ON DELETE RESTRICT;


--
-- Name: transport_fee transport_fee_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_fee
    ADD CONSTRAINT transport_fee_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: transport_fee transport_fee_stop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_fee
    ADD CONSTRAINT transport_fee_stop_id_fkey FOREIGN KEY (stop_id) REFERENCES public.transport_stops(id) ON DELETE RESTRICT;


--
-- Name: transport_import_batches transport_import_batches_academic_year_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_import_batches
    ADD CONSTRAINT transport_import_batches_academic_year_id_fkey FOREIGN KEY (academic_year_id) REFERENCES public.academic_years(id) ON DELETE RESTRICT;


--
-- Name: transport_import_batches transport_import_batches_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_import_batches
    ADD CONSTRAINT transport_import_batches_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: transport_import_batches transport_import_batches_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_import_batches
    ADD CONSTRAINT transport_import_batches_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: transport_import_rows transport_import_rows_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_import_rows
    ADD CONSTRAINT transport_import_rows_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.transport_import_batches(id) ON DELETE CASCADE;


--
-- Name: transport_import_rows transport_import_rows_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_import_rows
    ADD CONSTRAINT transport_import_rows_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.transport_routes(id) ON DELETE SET NULL;


--
-- Name: transport_import_rows transport_import_rows_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_import_rows
    ADD CONSTRAINT transport_import_rows_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: transport_import_rows transport_import_rows_stop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_import_rows
    ADD CONSTRAINT transport_import_rows_stop_id_fkey FOREIGN KEY (stop_id) REFERENCES public.transport_stops(id) ON DELETE SET NULL;


--
-- Name: transport_import_rows transport_import_rows_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_import_rows
    ADD CONSTRAINT transport_import_rows_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE SET NULL;


--
-- Name: transport_routes transport_routes_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_routes
    ADD CONSTRAINT transport_routes_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: transport_safety_incidents transport_safety_incidents_acknowledged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_safety_incidents
    ADD CONSTRAINT transport_safety_incidents_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: transport_safety_incidents transport_safety_incidents_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_safety_incidents
    ADD CONSTRAINT transport_safety_incidents_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.staff(id) ON DELETE SET NULL;


--
-- Name: transport_safety_incidents transport_safety_incidents_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_safety_incidents
    ADD CONSTRAINT transport_safety_incidents_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: transport_safety_incidents transport_safety_incidents_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_safety_incidents
    ADD CONSTRAINT transport_safety_incidents_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.transport_routes(id) ON DELETE SET NULL;


--
-- Name: transport_safety_incidents transport_safety_incidents_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_safety_incidents
    ADD CONSTRAINT transport_safety_incidents_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: transport_safety_incidents transport_safety_incidents_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_safety_incidents
    ADD CONSTRAINT transport_safety_incidents_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id) ON DELETE CASCADE;


--
-- Name: transport_safety_incidents transport_safety_incidents_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_safety_incidents
    ADD CONSTRAINT transport_safety_incidents_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE SET NULL;


--
-- Name: transport_safety_incidents transport_safety_incidents_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_safety_incidents
    ADD CONSTRAINT transport_safety_incidents_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.buses(id) ON DELETE SET NULL;


--
-- Name: transport_stops transport_stops_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_stops
    ADD CONSTRAINT transport_stops_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.transport_routes(id) ON DELETE CASCADE;


--
-- Name: transport_stops transport_stops_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transport_stops
    ADD CONSTRAINT transport_stops_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: trip_stop_status trip_stop_status_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_stop_status
    ADD CONSTRAINT trip_stop_status_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: trip_stop_status trip_stop_status_stop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_stop_status
    ADD CONSTRAINT trip_stop_status_stop_id_fkey FOREIGN KEY (stop_id) REFERENCES public.transport_stops(id);


--
-- Name: trip_stop_status trip_stop_status_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_stop_status
    ADD CONSTRAINT trip_stop_status_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE CASCADE;


--
-- Name: trips trips_bus_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_bus_id_fkey FOREIGN KEY (bus_id) REFERENCES public.buses(id);


--
-- Name: trips trips_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.staff(id);


--
-- Name: trips trips_route_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_route_id_fkey FOREIGN KEY (route_id) REFERENCES public.transport_routes(id);


--
-- Name: trips trips_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: ui_route_permissions ui_route_permissions_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ui_route_permissions
    ADD CONSTRAINT ui_route_permissions_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: user_access_contexts user_access_contexts_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_access_contexts
    ADD CONSTRAINT user_access_contexts_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parents(id);


--
-- Name: user_access_contexts user_access_contexts_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_access_contexts
    ADD CONSTRAINT user_access_contexts_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: user_access_contexts user_access_contexts_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_access_contexts
    ADD CONSTRAINT user_access_contexts_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id);


--
-- Name: user_access_contexts user_access_contexts_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_access_contexts
    ADD CONSTRAINT user_access_contexts_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id);


--
-- Name: user_access_contexts user_access_contexts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_access_contexts
    ADD CONSTRAINT user_access_contexts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_active_sessions user_active_sessions_active_context_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_active_sessions
    ADD CONSTRAINT user_active_sessions_active_context_id_fkey FOREIGN KEY (active_context_id) REFERENCES public.user_access_contexts(id) ON DELETE SET NULL;


--
-- Name: user_active_sessions user_active_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_active_sessions
    ADD CONSTRAINT user_active_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_devices user_devices_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: user_devices user_devices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id);


--
-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_settings user_settings_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: user_settings user_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.persons(id) ON DELETE RESTRICT;


--
-- Name: users users_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: users users_unrestricted_access_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_unrestricted_access_granted_by_fkey FOREIGN KEY (unrestricted_access_granted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: staff_payroll Admins and Accounts can manage payroll; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins and Accounts can manage payroll" ON public.staff_payroll USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (EXISTS ( SELECT 1
   FROM (public.user_roles ur
     JOIN public.roles r ON ((ur.role_id = r.id)))
  WHERE ((ur.user_id = auth.uid()) AND ((r.code)::text = ANY ((ARRAY['admin'::character varying, 'accounts'::character varying])::text[]))))))));


--
-- Name: temp_access_grants Admins can insert grants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert grants" ON public.temp_access_grants FOR INSERT WITH CHECK (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (EXISTS ( SELECT 1
   FROM (public.user_roles ur
     JOIN public.roles r ON ((ur.role_id = r.id)))
  WHERE ((ur.user_id = auth.uid()) AND ((r.code)::text = 'admin'::text)))))));


--
-- Name: trips Admins can manage trips; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage trips" ON public.trips USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (EXISTS ( SELECT 1
   FROM (public.user_roles ur
     JOIN public.roles r ON ((ur.role_id = r.id)))
  WHERE ((ur.user_id = auth.uid()) AND ((r.code)::text = ANY ((ARRAY['admin'::character varying, 'driver'::character varying])::text[]))))))));


--
-- Name: financial_policy_rules Admins can update financial policies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update financial policies" ON public.financial_policy_rules FOR UPDATE TO authenticated USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (EXISTS ( SELECT 1
   FROM (public.user_roles ur
     JOIN public.roles r ON ((ur.role_id = r.id)))
  WHERE ((ur.user_id = auth.uid()) AND ((r.code)::text = 'admin'::text))))))) WITH CHECK (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (EXISTS ( SELECT 1
   FROM (public.user_roles ur
     JOIN public.roles r ON ((ur.role_id = r.id)))
  WHERE ((ur.user_id = auth.uid()) AND ((r.code)::text = 'admin'::text)))))));


--
-- Name: temp_access_grants Admins can update grants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update grants" ON public.temp_access_grants FOR UPDATE USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (EXISTS ( SELECT 1
   FROM (public.user_roles ur
     JOIN public.roles r ON ((ur.role_id = r.id)))
  WHERE ((ur.user_id = auth.uid()) AND ((r.code)::text = 'admin'::text)))))));


--
-- Name: access_requests Admins can update requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update requests" ON public.access_requests FOR UPDATE USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (EXISTS ( SELECT 1
   FROM (public.user_roles ur
     JOIN public.roles r ON ((ur.role_id = r.id)))
  WHERE ((ur.user_id = auth.uid()) AND ((r.code)::text = 'admin'::text)))))));


--
-- Name: temp_access_grants Admins can view all grants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all grants" ON public.temp_access_grants FOR SELECT USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (EXISTS ( SELECT 1
   FROM (public.user_roles ur
     JOIN public.roles r ON ((ur.role_id = r.id)))
  WHERE ((ur.user_id = auth.uid()) AND ((r.code)::text = 'admin'::text)))))));


--
-- Name: access_requests Admins can view all requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all requests" ON public.access_requests FOR SELECT USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (EXISTS ( SELECT 1
   FROM (public.user_roles ur
     JOIN public.roles r ON ((ur.role_id = r.id)))
  WHERE ((ur.user_id = auth.uid()) AND ((r.code)::text = 'admin'::text)))))));


--
-- Name: financial_audit_logs Admins can view financial audit logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view financial audit logs" ON public.financial_audit_logs FOR SELECT TO authenticated USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (EXISTS ( SELECT 1
   FROM (public.user_roles ur
     JOIN public.roles r ON ((ur.role_id = r.id)))
  WHERE ((ur.user_id = auth.uid()) AND ((r.code)::text = 'admin'::text)))))));


--
-- Name: timetable_slots Admins full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins full access" ON public.timetable_slots USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.school_id = public.auth_school_id()) AND (EXISTS ( SELECT 1
           FROM (public.user_roles ur
             JOIN public.roles r ON ((ur.role_id = r.id)))
          WHERE ((ur.user_id = users.id) AND ((r.code)::text = 'admin'::text))))))))));


--
-- Name: student_life_values_progress Allow all authenticated check; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all authenticated check" ON public.student_life_values_progress FOR SELECT USING (((auth.role() = 'service_role'::text) OR (school_id = public.auth_school_id())));


--
-- Name: activity_logs Allow all on activity_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all on activity_logs" ON public.activity_logs USING (true) WITH CHECK (true);


--
-- Name: business_units Allow all on business_units; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all on business_units" ON public.business_units USING (true) WITH CHECK (true);


--
-- Name: collections Allow all on collections; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all on collections" ON public.collections USING (true) WITH CHECK (true);


--
-- Name: enquiries Allow all on enquiries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all on enquiries" ON public.enquiries USING (true) WITH CHECK (true);


--
-- Name: founders Allow all on founders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all on founders" ON public.founders USING (true) WITH CHECK (true);


--
-- Name: settings Allow all on settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all on settings" ON public.settings USING (true) WITH CHECK (true);


--
-- Name: trip_stop_status Authenticated can view trip stops; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated can view trip stops" ON public.trip_stop_status FOR SELECT TO authenticated USING ((school_id = public.auth_school_id()));


--
-- Name: bus_stop_attendance Authenticated users can read bus attendance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read bus attendance" ON public.bus_stop_attendance FOR SELECT TO authenticated USING ((school_id = public.auth_school_id()));


--
-- Name: financial_policy_rules Authenticated users can read financial policies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read financial policies" ON public.financial_policy_rules FOR SELECT TO authenticated USING (((auth.role() = 'service_role'::text) OR (school_id = public.auth_school_id())));


--
-- Name: expenses Create expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Create expenses" ON public.expenses FOR INSERT WITH CHECK (((auth.role() = 'service_role'::text) OR ((auth.role() = 'authenticated'::text) AND (school_id = public.auth_school_id()) AND (created_by = auth.uid()))));


--
-- Name: expenses Delete expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Delete expenses" ON public.expenses FOR DELETE USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (((created_by = auth.uid()) AND (status = 'pending'::text)) OR (EXISTS ( SELECT 1
   FROM (public.user_roles ur
     JOIN public.roles r ON ((ur.role_id = r.id)))
  WHERE ((ur.user_id = auth.uid()) AND ((r.code)::text = ANY ((ARRAY['admin'::character varying, 'principal'::character varying, 'accounts'::character varying])::text[])))))))));


--
-- Name: trips Drivers can view own trips; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can view own trips" ON public.trips FOR SELECT USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (driver_id IN ( SELECT s.id
   FROM (public.staff s
     JOIN public.users u ON ((s.person_id = u.person_id)))
  WHERE ((u.id = auth.uid()) AND (u.school_id = public.auth_school_id()) AND (s.school_id = public.auth_school_id())))))));


--
-- Name: bus_stop_attendance Drivers/Admins can manage bus attendance; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers/Admins can manage bus attendance" ON public.bus_stop_attendance TO authenticated USING (((school_id = public.auth_school_id()) AND (EXISTS ( SELECT 1
   FROM (public.user_roles ur
     JOIN public.roles r ON ((ur.role_id = r.id)))
  WHERE ((ur.user_id = auth.uid()) AND ((r.code)::text = ANY ((ARRAY['admin'::character varying, 'driver'::character varying])::text[])))))));


--
-- Name: life_values_modules Enable read access for all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable read access for all" ON public.life_values_modules FOR SELECT USING (((auth.role() = 'service_role'::text) OR (school_id = public.auth_school_id())));


--
-- Name: blood_groups Global read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Global read" ON public.blood_groups FOR SELECT USING (true);


--
-- Name: countries Global read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Global read" ON public.countries FOR SELECT USING (true);


--
-- Name: genders Global read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Global read" ON public.genders FOR SELECT USING (true);


--
-- Name: notification_config Global read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Global read" ON public.notification_config FOR SELECT USING (true);


--
-- Name: relationship_types Global read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Global read" ON public.relationship_types FOR SELECT USING (true);


--
-- Name: religions Global read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Global read" ON public.religions FOR SELECT USING (true);


--
-- Name: staff_statuses Global read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Global read" ON public.staff_statuses FOR SELECT USING (true);


--
-- Name: student_categories Global read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Global read" ON public.student_categories FOR SELECT USING (true);


--
-- Name: student_statuses Global read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Global read" ON public.student_statuses FOR SELECT USING (true);


--
-- Name: notices Manage Notices; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Manage Notices" ON public.notices USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (public.auth_has_role(ARRAY['admin'::text]) OR (EXISTS ( SELECT 1
   FROM ((public.user_roles ur
     JOIN public.role_permissions rp ON ((ur.role_id = rp.role_id)))
     JOIN public.permissions p ON ((rp.permission_id = p.id)))
  WHERE ((ur.user_id = auth.uid()) AND (ur.school_id = public.auth_school_id()) AND (rp.school_id = public.auth_school_id()) AND (p.school_id = public.auth_school_id()) AND (((p.code)::text = 'notices.create'::text) OR ((p.code)::text = 'notices.manage'::text)))))))));


--
-- Name: super_admins Service Role Only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service Role Only" ON public.super_admins USING ((current_setting('role'::text) = 'service_role'::text));


--
-- Name: schema_meta Service role only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role only" ON public.schema_meta USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));


--
-- Name: staff_payroll Staff can view own payroll; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Staff can view own payroll" ON public.staff_payroll FOR SELECT USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (staff_id IN ( SELECT staff.id
   FROM public.staff
  WHERE ((staff.person_id IN ( SELECT users.person_id
           FROM public.users
          WHERE ((users.id = auth.uid()) AND (users.school_id = public.auth_school_id())))) AND (staff.school_id = public.auth_school_id())))))));


--
-- Name: student_life_values_progress Students can view own progress; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students can view own progress" ON public.student_life_values_progress USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (student_id IN ( SELECT s.id
   FROM ((public.students s
     JOIN public.persons p ON ((s.person_id = p.id)))
     JOIN public.users u ON ((u.person_id = p.id)))
  WHERE ((u.id = auth.uid()) AND (u.school_id = public.auth_school_id()) AND (s.school_id = public.auth_school_id()) AND (p.school_id = public.auth_school_id())))))));


--
-- Name: timetable_slots Students view own class timetable; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Students view own class timetable" ON public.timetable_slots FOR SELECT USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (class_section_id IN ( SELECT student_enrollments.class_section_id
   FROM public.student_enrollments
  WHERE ((student_enrollments.student_id IN ( SELECT students.id
           FROM public.students
          WHERE ((students.person_id = ( SELECT users.person_id
                   FROM public.users
                  WHERE ((users.id = auth.uid()) AND (users.school_id = public.auth_school_id())))) AND (students.school_id = public.auth_school_id())))) AND (student_enrollments.status = 'active'::public.enrollment_status_enum)))))));


--
-- Name: timetable_substitutions Substitutions: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Substitutions: admin manage own school" ON public.timetable_substitutions USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text, 'principal'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text, 'principal'::text]))));


--
-- Name: timetable_substitutions Substitutions: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Substitutions: read own school" ON public.timetable_substitutions FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: schools Super admin and tenant school read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Super admin and tenant school read" ON public.schools FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (id = public.auth_school_id())));


--
-- Name: schools Super admin manages schools; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Super admin manages schools" ON public.schools USING (((auth.role() = 'service_role'::text) OR public.is_super_admin())) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin()));


--
-- Name: life_values_modules Superadmin full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Superadmin full access" ON public.life_values_modules USING ((((auth.jwt() ->> 'role'::text) = 'service_role'::text) OR ((auth.jwt() ->> 'role'::text) = 'superadmin'::text))) WITH CHECK ((((auth.jwt() ->> 'role'::text) = 'service_role'::text) OR ((auth.jwt() ->> 'role'::text) = 'superadmin'::text)));


--
-- Name: money_science_modules Superadmin full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Superadmin full access" ON public.money_science_modules USING ((((auth.jwt() ->> 'role'::text) = 'service_role'::text) OR ((auth.jwt() ->> 'role'::text) = 'superadmin'::text))) WITH CHECK ((((auth.jwt() ->> 'role'::text) = 'service_role'::text) OR ((auth.jwt() ->> 'role'::text) = 'superadmin'::text)));


--
-- Name: science_projects Superadmin full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Superadmin full access" ON public.science_projects USING ((((auth.jwt() ->> 'role'::text) = 'service_role'::text) OR ((auth.jwt() ->> 'role'::text) = 'superadmin'::text))) WITH CHECK ((((auth.jwt() ->> 'role'::text) = 'service_role'::text) OR ((auth.jwt() ->> 'role'::text) = 'superadmin'::text)));


--
-- Name: financial_audit_logs System can insert audit logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can insert audit logs" ON public.financial_audit_logs FOR INSERT TO service_role WITH CHECK (true);


--
-- Name: timetable_slots Teachers view own slots; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Teachers view own slots" ON public.timetable_slots FOR SELECT USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (teacher_id IN ( SELECT staff.id
   FROM public.staff
  WHERE ((staff.person_id = ( SELECT users.person_id
           FROM public.users
          WHERE ((users.id = auth.uid()) AND (users.school_id = public.auth_school_id())))) AND (staff.school_id = public.auth_school_id())))))));


--
-- Name: academic_years Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.academic_years USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: admin_notifications Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.admin_notifications USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: audit_logs Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.audit_logs USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: bus_locations Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.bus_locations USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: bus_trip_history Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.bus_trip_history USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: buses Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.buses USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: class_sections Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.class_sections USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: class_subjects Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.class_subjects USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: classes Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.classes USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: complaints Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.complaints USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: daily_attendance Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.daily_attendance USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: diary_entries Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.diary_entries USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: discipline_records Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.discipline_records USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: driver_devices Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.driver_devices USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: driver_heartbeat Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.driver_heartbeat USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: exam_subjects Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.exam_subjects USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: exams Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.exams USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: feature_flags Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.feature_flags USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: fee_structures Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.fee_structures USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: fee_transactions Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.fee_transactions USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: fee_types Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.fee_types USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: grading_scales Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.grading_scales USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: hostel_allocations Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.hostel_allocations USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: hostel_blocks Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.hostel_blocks USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: hostel_rooms Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.hostel_rooms USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: leave_applications Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.leave_applications USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: lms_courses Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.lms_courses USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: lms_materials Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.lms_materials USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: marks Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.marks USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: money_science_modules Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.money_science_modules USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: notification_audit_logs Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.notification_audit_logs USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: notification_batches Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.notification_batches USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: notification_deliveries Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.notification_deliveries USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: notification_events Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.notification_events USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: notification_logs Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.notification_logs USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: notification_preferences Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.notification_preferences USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: notification_templates Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.notification_templates USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: notifications Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.notifications USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: parents Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.parents USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: periods Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.periods USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: permissions Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.permissions USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: person_contacts Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.person_contacts USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: persons Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.persons USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: receipt_items Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.receipt_items USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: receipts Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.receipts USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: role_permissions Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.role_permissions USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: roles Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.roles USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: school_settings Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.school_settings USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: science_projects Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.science_projects USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: sections Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.sections USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: staff Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.staff USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: staff_designations Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.staff_designations USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: student_enrollments Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.student_enrollments USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: student_fees Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.student_fees USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: student_money_science_progress Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.student_money_science_progress USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: student_parents Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.student_parents USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: student_science_projects Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.student_science_projects USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: student_transport Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.student_transport USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: students Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.students USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: subjects Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.subjects USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: timetable_entries Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.timetable_entries USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: transport_routes Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.transport_routes USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: transport_stops Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.transport_stops USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: ui_route_permissions Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.ui_route_permissions USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: user_roles Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.user_roles USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: user_settings Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.user_settings USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: users Tenant isolation: admin manage own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: admin manage own school" ON public.users USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: academic_years Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.academic_years FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: admin_notifications Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.admin_notifications FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: audit_logs Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.audit_logs FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: bus_locations Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.bus_locations FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: bus_trip_history Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.bus_trip_history FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: buses Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.buses FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: class_sections Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.class_sections FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: class_subjects Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.class_subjects FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: classes Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.classes FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: complaints Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.complaints FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: daily_attendance Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.daily_attendance FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: diary_entries Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.diary_entries FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: discipline_records Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.discipline_records FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: driver_devices Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.driver_devices FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: driver_heartbeat Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.driver_heartbeat FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: exam_subjects Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.exam_subjects FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: exams Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.exams FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: feature_flags Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.feature_flags FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: fee_structures Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.fee_structures FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: fee_transactions Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.fee_transactions FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: fee_types Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.fee_types FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: grading_scales Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.grading_scales FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: hostel_allocations Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.hostel_allocations FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: hostel_blocks Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.hostel_blocks FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: hostel_rooms Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.hostel_rooms FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: leave_applications Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.leave_applications FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: lms_courses Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.lms_courses FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: lms_materials Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.lms_materials FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: marks Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.marks FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: money_science_modules Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.money_science_modules FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: notification_audit_logs Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.notification_audit_logs FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: notification_batches Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.notification_batches FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: notification_deliveries Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.notification_deliveries FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: notification_events Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.notification_events FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: notification_logs Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.notification_logs FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: notification_preferences Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.notification_preferences FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: notification_templates Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.notification_templates FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: notifications Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.notifications FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: parents Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.parents FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: periods Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.periods FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: permissions Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.permissions FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: person_contacts Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.person_contacts FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: persons Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.persons FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: receipt_items Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.receipt_items FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: receipts Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.receipts FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: role_permissions Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.role_permissions FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: roles Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.roles FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: school_settings Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.school_settings FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: science_projects Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.science_projects FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: sections Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.sections FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: staff Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.staff FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: staff_designations Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.staff_designations FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: student_enrollments Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.student_enrollments FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: student_fees Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.student_fees FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: student_money_science_progress Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.student_money_science_progress FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: student_parents Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.student_parents FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: student_science_projects Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.student_science_projects FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: student_transport Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.student_transport FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: students Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.students FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: subjects Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.subjects FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: timetable_entries Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.timetable_entries FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: transport_routes Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.transport_routes FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: transport_stops Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.transport_stops FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: ui_route_permissions Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.ui_route_permissions FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: user_roles Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.user_roles FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: user_settings Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.user_settings FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: users Tenant isolation: read own school; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Tenant isolation: read own school" ON public.users FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: expenses Update expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Update expenses" ON public.expenses FOR UPDATE USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (((created_by = auth.uid()) AND (status = 'pending'::text)) OR (EXISTS ( SELECT 1
   FROM (public.user_roles ur
     JOIN public.roles r ON ((ur.role_id = r.id)))
  WHERE ((ur.user_id = auth.uid()) AND ((r.code)::text = ANY ((ARRAY['admin'::character varying, 'principal'::character varying, 'accounts'::character varying])::text[])))))))));


--
-- Name: access_requests Users can insert their own requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own requests" ON public.access_requests FOR INSERT WITH CHECK (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (requested_by = auth.uid()))));


--
-- Name: persons Users can read own person; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read own person" ON public.persons FOR SELECT USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (id IN ( SELECT users.person_id
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.school_id = public.auth_school_id())))))));


--
-- Name: staff Users can read own staff record; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read own staff record" ON public.staff FOR SELECT USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (person_id IN ( SELECT users.person_id
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.school_id = public.auth_school_id())))))));


--
-- Name: temp_access_grants Users can view their own grants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own grants" ON public.temp_access_grants FOR SELECT USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (requested_by = auth.uid()))));


--
-- Name: access_requests Users can view their own requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own requests" ON public.access_requests FOR SELECT USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND (requested_by = auth.uid()))));


--
-- Name: events View Events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "View Events" ON public.events FOR SELECT USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND ((is_public = true) OR (created_by = auth.uid()) OR ((target_audience = 'all'::public.notice_audience_enum) AND (auth.role() = 'authenticated'::text)) OR ((target_audience = 'staff'::public.notice_audience_enum) AND public.auth_has_role(ARRAY['admin'::text, 'teacher'::text, 'staff'::text, 'accounts'::text]))))));


--
-- Name: notices View Notices; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "View Notices" ON public.notices FOR SELECT USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND ((created_by = auth.uid()) OR (((audience = 'all'::public.notice_audience_enum) OR ('all'::public.notice_audience_enum = ANY (audiences))) AND (auth.role() = 'authenticated'::text)) OR (((audience = 'staff'::public.notice_audience_enum) OR ('staff'::public.notice_audience_enum = ANY (audiences))) AND public.auth_has_role(ARRAY['admin'::text, 'teacher'::text, 'staff'::text, 'accounts'::text])) OR (((audience = 'students'::public.notice_audience_enum) OR ('students'::public.notice_audience_enum = ANY (audiences))) AND public.auth_has_role(ARRAY['admin'::text, 'student'::text])) OR (((audience = 'parents'::public.notice_audience_enum) OR ('parents'::public.notice_audience_enum = ANY (audiences))) AND public.auth_has_role(ARRAY['admin'::text, 'parent'::text])) OR (((audience = 'class'::public.notice_audience_enum) OR ('class'::public.notice_audience_enum = ANY (audiences))) AND (target_class_id IS NOT NULL))))));


--
-- Name: expenses View own school expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "View own school expenses" ON public.expenses FOR SELECT USING (((auth.role() = 'service_role'::text) OR ((school_id = public.auth_school_id()) AND ((created_by = auth.uid()) OR (EXISTS ( SELECT 1
   FROM (public.user_roles ur
     JOIN public.roles r ON ((ur.role_id = r.id)))
  WHERE ((ur.user_id = auth.uid()) AND ((r.code)::text = ANY ((ARRAY['admin'::character varying, 'principal'::character varying, 'accounts'::character varying])::text[])))))))));


--
-- Name: academic_years; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.academic_years ENABLE ROW LEVEL SECURITY;

--
-- Name: access_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.access_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: activity_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_quick_action_daily_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_quick_action_daily_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_quick_action_daily_usage admin_quick_action_usage_school_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_quick_action_usage_school_manage ON public.admin_quick_action_daily_usage TO authenticated USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: admin_quick_action_daily_usage admin_quick_action_usage_school_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_quick_action_usage_school_select ON public.admin_quick_action_daily_usage FOR SELECT TO authenticated USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: attendance_interventions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.attendance_interventions ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: automation_execution_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automation_execution_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: blood_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blood_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: bus_locations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bus_locations ENABLE ROW LEVEL SECURITY;

--
-- Name: bus_stop_attendance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bus_stop_attendance ENABLE ROW LEVEL SECURITY;

--
-- Name: bus_trip_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bus_trip_history ENABLE ROW LEVEL SECURITY;

--
-- Name: buses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.buses ENABLE ROW LEVEL SECURITY;

--
-- Name: business_units; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.business_units ENABLE ROW LEVEL SECURITY;

--
-- Name: class_sections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.class_sections ENABLE ROW LEVEL SECURITY;

--
-- Name: class_subjects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.class_subjects ENABLE ROW LEVEL SECURITY;

--
-- Name: classes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;

--
-- Name: collections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.collections ENABLE ROW LEVEL SECURITY;

--
-- Name: complaints; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.complaints ENABLE ROW LEVEL SECURITY;

--
-- Name: countries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.countries ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_activities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_activities ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_automation_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_automation_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_automation_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_automation_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: daily_attendance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daily_attendance ENABLE ROW LEVEL SECURITY;

--
-- Name: dcgd_programs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dcgd_programs ENABLE ROW LEVEL SECURITY;

--
-- Name: dcgd_programs dcgd_programs_student_read_active; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dcgd_programs_student_read_active ON public.dcgd_programs FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((is_active = true) AND public.auth_has_role(ARRAY['student'::text]))));


--
-- Name: dcgd_programs dcgd_programs_super_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dcgd_programs_super_admin_all ON public.dcgd_programs USING (((auth.role() = 'service_role'::text) OR public.is_super_admin())) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin()));


--
-- Name: dcgd_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dcgd_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: dcgd_settings dcgd_settings_student_read_visible; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dcgd_settings_student_read_visible ON public.dcgd_settings FOR SELECT USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((is_visible = true) AND public.auth_has_role(ARRAY['student'::text]))));


--
-- Name: dcgd_settings dcgd_settings_super_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY dcgd_settings_super_admin_all ON public.dcgd_settings USING (((auth.role() = 'service_role'::text) OR public.is_super_admin())) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin()));


--
-- Name: defaulter_dues; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.defaulter_dues ENABLE ROW LEVEL SECURITY;

--
-- Name: defaulter_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.defaulter_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: diary_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.diary_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: discipline_records; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.discipline_records ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_devices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_devices ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_heartbeat; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_heartbeat ENABLE ROW LEVEL SECURITY;

--
-- Name: enquiries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.enquiries ENABLE ROW LEVEL SECURITY;

--
-- Name: events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

--
-- Name: exam_subjects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.exam_subjects ENABLE ROW LEVEL SECURITY;

--
-- Name: exams; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.exams ENABLE ROW LEVEL SECURITY;

--
-- Name: expenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: fee_adjustments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fee_adjustments ENABLE ROW LEVEL SECURITY;

--
-- Name: fee_adjustments fee_adjustments_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fee_adjustments_select_own ON public.fee_adjustments FOR SELECT TO authenticated USING (((student_id = public.student_id_for_session()) AND (school_id = ( SELECT s.school_id
   FROM public.students s
  WHERE (s.id = public.student_id_for_session())
 LIMIT 1))));


--
-- Name: fee_structures; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fee_structures ENABLE ROW LEVEL SECURITY;

--
-- Name: fee_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fee_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: fee_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fee_types ENABLE ROW LEVEL SECURITY;

--
-- Name: financial_audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.financial_audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: financial_policy_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.financial_policy_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: founders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.founders ENABLE ROW LEVEL SECURITY;

--
-- Name: genders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.genders ENABLE ROW LEVEL SECURITY;

--
-- Name: grading_scales; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.grading_scales ENABLE ROW LEVEL SECURITY;

--
-- Name: hostel_allocations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hostel_allocations ENABLE ROW LEVEL SECURITY;

--
-- Name: hostel_blocks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hostel_blocks ENABLE ROW LEVEL SECURITY;

--
-- Name: hostel_permission_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hostel_permission_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: hostel_permission_requests hostel_permission_requests_school_scope; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hostel_permission_requests_school_scope ON public.hostel_permission_requests TO authenticated USING ((school_id = public.auth_school_id())) WITH CHECK ((school_id = public.auth_school_id()));


--
-- Name: hostel_rooms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hostel_rooms ENABLE ROW LEVEL SECURITY;

--
-- Name: issued_certificates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.issued_certificates ENABLE ROW LEVEL SECURITY;

--
-- Name: leave_applications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.leave_applications ENABLE ROW LEVEL SECURITY;

--
-- Name: life_values_modules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.life_values_modules ENABLE ROW LEVEL SECURITY;

--
-- Name: lms_courses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lms_courses ENABLE ROW LEVEL SECURITY;

--
-- Name: lms_materials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lms_materials ENABLE ROW LEVEL SECURITY;

--
-- Name: marks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.marks ENABLE ROW LEVEL SECURITY;

--
-- Name: money_science_modules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.money_science_modules ENABLE ROW LEVEL SECURITY;

--
-- Name: notices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notices ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_batches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_config ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_deliveries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_dispatch_recipients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_dispatch_recipients ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_events ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: parent_visits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.parent_visits ENABLE ROW LEVEL SECURITY;

--
-- Name: parent_visits parent_visits_school_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY parent_visits_school_admin_manage ON public.parent_visits TO authenticated USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text]))));


--
-- Name: parent_visits parent_visits_school_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY parent_visits_school_select ON public.parent_visits FOR SELECT TO authenticated USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: parents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.parents ENABLE ROW LEVEL SECURITY;

--
-- Name: periods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.periods ENABLE ROW LEVEL SECURITY;

--
-- Name: permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: person_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.person_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: persons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.persons ENABLE ROW LEVEL SECURITY;

--
-- Name: receipt_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.receipt_items ENABLE ROW LEVEL SECURITY;

--
-- Name: receipt_number_counters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.receipt_number_counters ENABLE ROW LEVEL SECURITY;

--
-- Name: receipts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: relationship_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.relationship_types ENABLE ROW LEVEL SECURITY;

--
-- Name: religions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.religions ENABLE ROW LEVEL SECURITY;

--
-- Name: role_permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: saas_subscription_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.saas_subscription_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: saas_subscription_receipts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.saas_subscription_receipts ENABLE ROW LEVEL SECURITY;

--
-- Name: saas_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.saas_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: schema_meta; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schema_meta ENABLE ROW LEVEL SECURITY;

--
-- Name: school_automation_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_automation_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: school_feature_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_feature_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: school_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: school_website_gallery; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_website_gallery ENABLE ROW LEVEL SECURITY;

--
-- Name: school_website_gallery school_website_gallery_admin_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY school_website_gallery_admin_manage ON public.school_website_gallery TO authenticated USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text, 'principal'::text])))) WITH CHECK (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR ((school_id = public.auth_school_id()) AND public.auth_has_role(ARRAY['admin'::text, 'principal'::text]))));


--
-- Name: school_website_gallery school_website_gallery_tenant_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY school_website_gallery_tenant_select ON public.school_website_gallery FOR SELECT TO authenticated USING (((auth.role() = 'service_role'::text) OR public.is_super_admin() OR (school_id = public.auth_school_id())));


--
-- Name: schools; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schools ENABLE ROW LEVEL SECURITY;

--
-- Name: science_projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.science_projects ENABLE ROW LEVEL SECURITY;

--
-- Name: sections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sections ENABLE ROW LEVEL SECURITY;

--
-- Name: settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

--
-- Name: staff; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_attendance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_attendance ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_designations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_designations ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_payroll; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_payroll ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_statuses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_statuses ENABLE ROW LEVEL SECURITY;

--
-- Name: student_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.student_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: student_enrollments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.student_enrollments ENABLE ROW LEVEL SECURITY;

--
-- Name: student_fees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.student_fees ENABLE ROW LEVEL SECURITY;

--
-- Name: student_life_values_progress; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.student_life_values_progress ENABLE ROW LEVEL SECURITY;

--
-- Name: student_money_science_progress; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.student_money_science_progress ENABLE ROW LEVEL SECURITY;

--
-- Name: student_parents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.student_parents ENABLE ROW LEVEL SECURITY;

--
-- Name: student_science_projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.student_science_projects ENABLE ROW LEVEL SECURITY;

--
-- Name: student_statuses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.student_statuses ENABLE ROW LEVEL SECURITY;

--
-- Name: student_transport; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.student_transport ENABLE ROW LEVEL SECURITY;

--
-- Name: students; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;

--
-- Name: subjects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subjects ENABLE ROW LEVEL SECURITY;

--
-- Name: super_admins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.super_admins ENABLE ROW LEVEL SECURITY;

--
-- Name: support_message_notification_outbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_message_notification_outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: support_ticket_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_ticket_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: support_tickets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

--
-- Name: temp_access_grants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.temp_access_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: school_feature_flags tenant_isolation_school_feature_flags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_school_feature_flags ON public.school_feature_flags USING ((school_id = public.current_school_id())) WITH CHECK ((school_id = public.current_school_id()));


--
-- Name: ticket_number_counters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_number_counters ENABLE ROW LEVEL SECURITY;

--
-- Name: timetable_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.timetable_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: timetable_slots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.timetable_slots ENABLE ROW LEVEL SECURITY;

--
-- Name: timetable_substitutions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.timetable_substitutions ENABLE ROW LEVEL SECURITY;

--
-- Name: transport_fee; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transport_fee ENABLE ROW LEVEL SECURITY;

--
-- Name: transport_fee_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transport_fee_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: transport_routes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transport_routes ENABLE ROW LEVEL SECURITY;

--
-- Name: transport_safety_incidents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transport_safety_incidents ENABLE ROW LEVEL SECURITY;

--
-- Name: transport_stops; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transport_stops ENABLE ROW LEVEL SECURITY;

--
-- Name: trip_stop_status; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trip_stop_status ENABLE ROW LEVEL SECURITY;

--
-- Name: trips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;

--
-- Name: ui_route_permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ui_route_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: user_devices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: user_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION academic_year_start_year(p_code text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.academic_year_start_year(p_code text) TO anon;
GRANT ALL ON FUNCTION public.academic_year_start_year(p_code text) TO authenticated;
GRANT ALL ON FUNCTION public.academic_year_start_year(p_code text) TO service_role;


--
-- Name: FUNCTION auth_has_role(role_codes text[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.auth_has_role(role_codes text[]) TO anon;
GRANT ALL ON FUNCTION public.auth_has_role(role_codes text[]) TO authenticated;
GRANT ALL ON FUNCTION public.auth_has_role(role_codes text[]) TO service_role;


--
-- Name: FUNCTION auth_school_id(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.auth_school_id() TO anon;
GRANT ALL ON FUNCTION public.auth_school_id() TO authenticated;
GRANT ALL ON FUNCTION public.auth_school_id() TO service_role;


--
-- Name: FUNCTION auto_assign_fees_on_enrollment(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.auto_assign_fees_on_enrollment() TO anon;
GRANT ALL ON FUNCTION public.auto_assign_fees_on_enrollment() TO authenticated;
GRANT ALL ON FUNCTION public.auto_assign_fees_on_enrollment() TO service_role;


--
-- Name: FUNCTION auto_assign_fees_on_structure_creation(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.auto_assign_fees_on_structure_creation() TO anon;
GRANT ALL ON FUNCTION public.auto_assign_fees_on_structure_creation() TO authenticated;
GRANT ALL ON FUNCTION public.auto_assign_fees_on_structure_creation() TO service_role;


--
-- Name: FUNCTION auto_generate_receipt(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.auto_generate_receipt() TO anon;
GRANT ALL ON FUNCTION public.auto_generate_receipt() TO authenticated;
GRANT ALL ON FUNCTION public.auto_generate_receipt() TO service_role;


--
-- Name: FUNCTION billing_documents_guard_immutable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.billing_documents_guard_immutable() TO anon;
GRANT ALL ON FUNCTION public.billing_documents_guard_immutable() TO authenticated;
GRANT ALL ON FUNCTION public.billing_documents_guard_immutable() TO service_role;


--
-- Name: FUNCTION check_financial_permission(p_action_code text, p_amount numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.check_financial_permission(p_action_code text, p_amount numeric) TO anon;
GRANT ALL ON FUNCTION public.check_financial_permission(p_action_code text, p_amount numeric) TO authenticated;
GRANT ALL ON FUNCTION public.check_financial_permission(p_action_code text, p_amount numeric) TO service_role;


--
-- Name: FUNCTION compute_attendance_day_status(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.compute_attendance_day_status() TO anon;
GRANT ALL ON FUNCTION public.compute_attendance_day_status() TO authenticated;
GRANT ALL ON FUNCTION public.compute_attendance_day_status() TO service_role;


--
-- Name: FUNCTION current_school_id(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.current_school_id() TO anon;
GRANT ALL ON FUNCTION public.current_school_id() TO authenticated;
GRANT ALL ON FUNCTION public.current_school_id() TO service_role;


--
-- Name: FUNCTION current_staff_id(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.current_staff_id() TO anon;
GRANT ALL ON FUNCTION public.current_staff_id() TO authenticated;
GRANT ALL ON FUNCTION public.current_staff_id() TO service_role;


--
-- Name: FUNCTION debug_teacher_profile(p_staff_code character varying); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.debug_teacher_profile(p_staff_code character varying) TO anon;
GRANT ALL ON FUNCTION public.debug_teacher_profile(p_staff_code character varying) TO authenticated;
GRANT ALL ON FUNCTION public.debug_teacher_profile(p_staff_code character varying) TO service_role;


--
-- Name: FUNCTION debug_user_permissions(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.debug_user_permissions(p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.debug_user_permissions(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.debug_user_permissions(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION delete_record_with_reason(p_table_name text, p_record_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.delete_record_with_reason(p_table_name text, p_record_id uuid, p_reason text) TO anon;
GRANT ALL ON FUNCTION public.delete_record_with_reason(p_table_name text, p_record_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.delete_record_with_reason(p_table_name text, p_record_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION derive_defaulter_status(p_balance numeric, p_paid numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.derive_defaulter_status(p_balance numeric, p_paid numeric) TO anon;
GRANT ALL ON FUNCTION public.derive_defaulter_status(p_balance numeric, p_paid numeric) TO authenticated;
GRANT ALL ON FUNCTION public.derive_defaulter_status(p_balance numeric, p_paid numeric) TO service_role;


--
-- Name: FUNCTION enforce_class_teacher_source_of_truth(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_class_teacher_source_of_truth() TO anon;
GRANT ALL ON FUNCTION public.enforce_class_teacher_source_of_truth() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_class_teacher_source_of_truth() TO service_role;


--
-- Name: FUNCTION enforce_financial_lock(p_date date, p_context text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_financial_lock(p_date date, p_context text) TO anon;
GRANT ALL ON FUNCTION public.enforce_financial_lock(p_date date, p_context text) TO authenticated;
GRANT ALL ON FUNCTION public.enforce_financial_lock(p_date date, p_context text) TO service_role;


--
-- Name: FUNCTION ensure_active_person_ref(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ensure_active_person_ref() TO anon;
GRANT ALL ON FUNCTION public.ensure_active_person_ref() TO authenticated;
GRANT ALL ON FUNCTION public.ensure_active_person_ref() TO service_role;


--
-- Name: FUNCTION ensure_active_person_staff(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ensure_active_person_staff() TO anon;
GRANT ALL ON FUNCTION public.ensure_active_person_staff() TO authenticated;
GRANT ALL ON FUNCTION public.ensure_active_person_staff() TO service_role;


--
-- Name: FUNCTION ensure_active_student_enrollment(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ensure_active_student_enrollment() TO anon;
GRANT ALL ON FUNCTION public.ensure_active_student_enrollment() TO authenticated;
GRANT ALL ON FUNCTION public.ensure_active_student_enrollment() TO service_role;


--
-- Name: FUNCTION ensure_active_student_parent(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ensure_active_student_parent() TO anon;
GRANT ALL ON FUNCTION public.ensure_active_student_parent() TO authenticated;
GRANT ALL ON FUNCTION public.ensure_active_student_parent() TO service_role;


--
-- Name: FUNCTION fn_check_academic_year_dates(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.fn_check_academic_year_dates() TO anon;
GRANT ALL ON FUNCTION public.fn_check_academic_year_dates() TO authenticated;
GRANT ALL ON FUNCTION public.fn_check_academic_year_dates() TO service_role;


--
-- Name: FUNCTION fn_check_invoice_amounts(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.fn_check_invoice_amounts() TO anon;
GRANT ALL ON FUNCTION public.fn_check_invoice_amounts() TO authenticated;
GRANT ALL ON FUNCTION public.fn_check_invoice_amounts() TO service_role;


--
-- Name: FUNCTION fn_check_no_future_attendance(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.fn_check_no_future_attendance() TO anon;
GRANT ALL ON FUNCTION public.fn_check_no_future_attendance() TO authenticated;
GRANT ALL ON FUNCTION public.fn_check_no_future_attendance() TO service_role;


--
-- Name: FUNCTION fn_lower_email(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.fn_lower_email() TO anon;
GRANT ALL ON FUNCTION public.fn_lower_email() TO authenticated;
GRANT ALL ON FUNCTION public.fn_lower_email() TO service_role;


--
-- Name: FUNCTION fn_prevent_immutable_changes(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.fn_prevent_immutable_changes() TO anon;
GRANT ALL ON FUNCTION public.fn_prevent_immutable_changes() TO authenticated;
GRANT ALL ON FUNCTION public.fn_prevent_immutable_changes() TO service_role;


--
-- Name: FUNCTION fn_prevent_overpayment(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.fn_prevent_overpayment() TO anon;
GRANT ALL ON FUNCTION public.fn_prevent_overpayment() TO authenticated;
GRANT ALL ON FUNCTION public.fn_prevent_overpayment() TO service_role;


--
-- Name: FUNCTION fn_transaction_immutability(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.fn_transaction_immutability() TO anon;
GRANT ALL ON FUNCTION public.fn_transaction_immutability() TO authenticated;
GRANT ALL ON FUNCTION public.fn_transaction_immutability() TO service_role;


--
-- Name: FUNCTION fn_update_fee_balance(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.fn_update_fee_balance() TO anon;
GRANT ALL ON FUNCTION public.fn_update_fee_balance() TO authenticated;
GRANT ALL ON FUNCTION public.fn_update_fee_balance() TO service_role;


--
-- Name: FUNCTION fn_update_timestamp(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.fn_update_timestamp() TO anon;
GRANT ALL ON FUNCTION public.fn_update_timestamp() TO authenticated;
GRANT ALL ON FUNCTION public.fn_update_timestamp() TO service_role;


--
-- Name: FUNCTION fn_verify_fee_integrity(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.fn_verify_fee_integrity() TO anon;
GRANT ALL ON FUNCTION public.fn_verify_fee_integrity() TO authenticated;
GRANT ALL ON FUNCTION public.fn_verify_fee_integrity() TO service_role;


--
-- Name: FUNCTION generate_monthly_payroll(p_month integer, p_year integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.generate_monthly_payroll(p_month integer, p_year integer) TO anon;
GRANT ALL ON FUNCTION public.generate_monthly_payroll(p_month integer, p_year integer) TO authenticated;
GRANT ALL ON FUNCTION public.generate_monthly_payroll(p_month integer, p_year integer) TO service_role;


--
-- Name: FUNCTION generate_ticket_no(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.generate_ticket_no() TO anon;
GRANT ALL ON FUNCTION public.generate_ticket_no() TO authenticated;
GRANT ALL ON FUNCTION public.generate_ticket_no() TO service_role;


--
-- Name: FUNCTION get_attendance_analytics(p_from_date date, p_to_date date); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_attendance_analytics(p_from_date date, p_to_date date) TO anon;
GRANT ALL ON FUNCTION public.get_attendance_analytics(p_from_date date, p_to_date date) TO authenticated;
GRANT ALL ON FUNCTION public.get_attendance_analytics(p_from_date date, p_to_date date) TO service_role;


--
-- Name: FUNCTION get_dashboard_insights(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_dashboard_insights() TO anon;
GRANT ALL ON FUNCTION public.get_dashboard_insights() TO authenticated;
GRANT ALL ON FUNCTION public.get_dashboard_insights() TO service_role;


--
-- Name: FUNCTION get_financial_analytics(p_from_date date, p_to_date date, p_group_by text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_financial_analytics(p_from_date date, p_to_date date, p_group_by text) TO anon;
GRANT ALL ON FUNCTION public.get_financial_analytics(p_from_date date, p_to_date date, p_group_by text) TO authenticated;
GRANT ALL ON FUNCTION public.get_financial_analytics(p_from_date date, p_to_date date, p_group_by text) TO service_role;


--
-- Name: FUNCTION get_financial_policy_value(code_input text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_financial_policy_value(code_input text) TO anon;
GRANT ALL ON FUNCTION public.get_financial_policy_value(code_input text) TO authenticated;
GRANT ALL ON FUNCTION public.get_financial_policy_value(code_input text) TO service_role;


--
-- Name: FUNCTION get_next_adj_receipt_no(p_school_id integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_next_adj_receipt_no(p_school_id integer) TO anon;
GRANT ALL ON FUNCTION public.get_next_adj_receipt_no(p_school_id integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_next_adj_receipt_no(p_school_id integer) TO service_role;


--
-- Name: FUNCTION get_next_certificate_serial(p_school_id integer, p_cert_type text, p_cert_year integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_next_certificate_serial(p_school_id integer, p_cert_type text, p_cert_year integer) TO anon;
GRANT ALL ON FUNCTION public.get_next_certificate_serial(p_school_id integer, p_cert_type text, p_cert_year integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_next_certificate_serial(p_school_id integer, p_cert_type text, p_cert_year integer) TO service_role;


--
-- Name: FUNCTION get_next_complaint_ticket(p_school_id integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_next_complaint_ticket(p_school_id integer) TO anon;
GRANT ALL ON FUNCTION public.get_next_complaint_ticket(p_school_id integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_next_complaint_ticket(p_school_id integer) TO service_role;


--
-- Name: FUNCTION get_next_receipt_no(p_school_id integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_next_receipt_no(p_school_id integer) TO anon;
GRANT ALL ON FUNCTION public.get_next_receipt_no(p_school_id integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_next_receipt_no(p_school_id integer) TO service_role;


--
-- Name: FUNCTION get_next_ticket_number(p_school_id integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_next_ticket_number(p_school_id integer) TO anon;
GRANT ALL ON FUNCTION public.get_next_ticket_number(p_school_id integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_next_ticket_number(p_school_id integer) TO service_role;


--
-- Name: FUNCTION is_accounts(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_accounts() TO anon;
GRANT ALL ON FUNCTION public.is_accounts() TO authenticated;
GRANT ALL ON FUNCTION public.is_accounts() TO service_role;


--
-- Name: FUNCTION is_admin(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_admin() TO anon;
GRANT ALL ON FUNCTION public.is_admin() TO authenticated;
GRANT ALL ON FUNCTION public.is_admin() TO service_role;


--
-- Name: FUNCTION is_management(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_management() TO anon;
GRANT ALL ON FUNCTION public.is_management() TO authenticated;
GRANT ALL ON FUNCTION public.is_management() TO service_role;


--
-- Name: FUNCTION is_principal(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_principal() TO anon;
GRANT ALL ON FUNCTION public.is_principal() TO authenticated;
GRANT ALL ON FUNCTION public.is_principal() TO service_role;


--
-- Name: FUNCTION is_staff(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_staff() TO anon;
GRANT ALL ON FUNCTION public.is_staff() TO authenticated;
GRANT ALL ON FUNCTION public.is_staff() TO service_role;


--
-- Name: FUNCTION is_super_admin(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_super_admin() TO anon;
GRANT ALL ON FUNCTION public.is_super_admin() TO authenticated;
GRANT ALL ON FUNCTION public.is_super_admin() TO service_role;


--
-- Name: FUNCTION log_financial_destruction(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.log_financial_destruction() TO anon;
GRANT ALL ON FUNCTION public.log_financial_destruction() TO authenticated;
GRANT ALL ON FUNCTION public.log_financial_destruction() TO service_role;


--
-- Name: FUNCTION next_certificate_serial(cert_type text, cert_year integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.next_certificate_serial(cert_type text, cert_year integer) TO anon;
GRANT ALL ON FUNCTION public.next_certificate_serial(cert_type text, cert_year integer) TO authenticated;
GRANT ALL ON FUNCTION public.next_certificate_serial(cert_type text, cert_year integer) TO service_role;


--
-- Name: FUNCTION normalize_optional_name(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.normalize_optional_name() TO anon;
GRANT ALL ON FUNCTION public.normalize_optional_name() TO authenticated;
GRANT ALL ON FUNCTION public.normalize_optional_name() TO service_role;


--
-- Name: FUNCTION perform_data_audit(p_school_id integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.perform_data_audit(p_school_id integer) TO anon;
GRANT ALL ON FUNCTION public.perform_data_audit(p_school_id integer) TO authenticated;
GRANT ALL ON FUNCTION public.perform_data_audit(p_school_id integer) TO service_role;


--
-- Name: FUNCTION prevent_complaint_delete(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.prevent_complaint_delete() TO anon;
GRANT ALL ON FUNCTION public.prevent_complaint_delete() TO authenticated;
GRANT ALL ON FUNCTION public.prevent_complaint_delete() TO service_role;


--
-- Name: FUNCTION prevent_direct_fee_update(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.prevent_direct_fee_update() TO anon;
GRANT ALL ON FUNCTION public.prevent_direct_fee_update() TO authenticated;
GRANT ALL ON FUNCTION public.prevent_direct_fee_update() TO service_role;


--
-- Name: FUNCTION prevent_fee_transaction_mutation(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.prevent_fee_transaction_mutation() TO anon;
GRANT ALL ON FUNCTION public.prevent_fee_transaction_mutation() TO authenticated;
GRANT ALL ON FUNCTION public.prevent_fee_transaction_mutation() TO service_role;


--
-- Name: FUNCTION prevent_published_result_mark_changes(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.prevent_published_result_mark_changes() TO anon;
GRANT ALL ON FUNCTION public.prevent_published_result_mark_changes() TO authenticated;
GRANT ALL ON FUNCTION public.prevent_published_result_mark_changes() TO service_role;


--
-- Name: FUNCTION prevent_published_result_paper_changes(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.prevent_published_result_paper_changes() TO anon;
GRANT ALL ON FUNCTION public.prevent_published_result_paper_changes() TO authenticated;
GRANT ALL ON FUNCTION public.prevent_published_result_paper_changes() TO service_role;


--
-- Name: FUNCTION prevent_system_role_change(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.prevent_system_role_change() TO anon;
GRANT ALL ON FUNCTION public.prevent_system_role_change() TO authenticated;
GRANT ALL ON FUNCTION public.prevent_system_role_change() TO service_role;


--
-- Name: FUNCTION promote_students_academic_year(p_current_ay_id uuid, p_next_ay_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.promote_students_academic_year(p_current_ay_id uuid, p_next_ay_id uuid) TO anon;
GRANT ALL ON FUNCTION public.promote_students_academic_year(p_current_ay_id uuid, p_next_ay_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.promote_students_academic_year(p_current_ay_id uuid, p_next_ay_id uuid) TO service_role;


--
-- Name: FUNCTION propagate_fee_structure_updates(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.propagate_fee_structure_updates() TO anon;
GRANT ALL ON FUNCTION public.propagate_fee_structure_updates() TO authenticated;
GRANT ALL ON FUNCTION public.propagate_fee_structure_updates() TO service_role;


--
-- Name: FUNCTION recalculate_fee_ledger(p_school_id integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.recalculate_fee_ledger(p_school_id integer) TO anon;
GRANT ALL ON FUNCTION public.recalculate_fee_ledger(p_school_id integer) TO authenticated;
GRANT ALL ON FUNCTION public.recalculate_fee_ledger(p_school_id integer) TO service_role;


--
-- Name: FUNCTION recalculate_rolls_after_enrollment_change(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.recalculate_rolls_after_enrollment_change() TO anon;
GRANT ALL ON FUNCTION public.recalculate_rolls_after_enrollment_change() TO authenticated;
GRANT ALL ON FUNCTION public.recalculate_rolls_after_enrollment_change() TO service_role;


--
-- Name: FUNCTION recalculate_rolls_after_student_delete_change(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.recalculate_rolls_after_student_delete_change() TO anon;
GRANT ALL ON FUNCTION public.recalculate_rolls_after_student_delete_change() TO authenticated;
GRANT ALL ON FUNCTION public.recalculate_rolls_after_student_delete_change() TO service_role;


--
-- Name: FUNCTION recalculate_rolls_after_student_name_change(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.recalculate_rolls_after_student_name_change() TO anon;
GRANT ALL ON FUNCTION public.recalculate_rolls_after_student_name_change() TO authenticated;
GRANT ALL ON FUNCTION public.recalculate_rolls_after_student_name_change() TO service_role;


--
-- Name: FUNCTION recalculate_section_rolls(p_class_section_id uuid, p_academic_year_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.recalculate_section_rolls(p_class_section_id uuid, p_academic_year_id uuid) TO anon;
GRANT ALL ON FUNCTION public.recalculate_section_rolls(p_class_section_id uuid, p_academic_year_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.recalculate_section_rolls(p_class_section_id uuid, p_academic_year_id uuid) TO service_role;


--
-- Name: FUNCTION recalculate_staff_payroll(p_staff_id uuid, p_month integer, p_year integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.recalculate_staff_payroll(p_staff_id uuid, p_month integer, p_year integer) TO anon;
GRANT ALL ON FUNCTION public.recalculate_staff_payroll(p_staff_id uuid, p_month integer, p_year integer) TO authenticated;
GRANT ALL ON FUNCTION public.recalculate_staff_payroll(p_staff_id uuid, p_month integer, p_year integer) TO service_role;


--
-- Name: FUNCTION refresh_defaulter_due_balance(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.refresh_defaulter_due_balance() TO anon;
GRANT ALL ON FUNCTION public.refresh_defaulter_due_balance() TO authenticated;
GRANT ALL ON FUNCTION public.refresh_defaulter_due_balance() TO service_role;


--
-- Name: FUNCTION repair_data_integrity(p_school_id integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.repair_data_integrity(p_school_id integer) TO anon;
GRANT ALL ON FUNCTION public.repair_data_integrity(p_school_id integer) TO authenticated;
GRANT ALL ON FUNCTION public.repair_data_integrity(p_school_id integer) TO service_role;


--
-- Name: FUNCTION run_integrity_check(p_school_id integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.run_integrity_check(p_school_id integer) TO anon;
GRANT ALL ON FUNCTION public.run_integrity_check(p_school_id integer) TO authenticated;
GRANT ALL ON FUNCTION public.run_integrity_check(p_school_id integer) TO service_role;


--
-- Name: FUNCTION safe_div(n numeric, d numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.safe_div(n numeric, d numeric) TO anon;
GRANT ALL ON FUNCTION public.safe_div(n numeric, d numeric) TO authenticated;
GRANT ALL ON FUNCTION public.safe_div(n numeric, d numeric) TO service_role;


--
-- Name: FUNCTION seed_school_defaults(p_school_id integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.seed_school_defaults(p_school_id integer) TO anon;
GRANT ALL ON FUNCTION public.seed_school_defaults(p_school_id integer) TO authenticated;
GRANT ALL ON FUNCTION public.seed_school_defaults(p_school_id integer) TO service_role;


--
-- Name: FUNCTION set_school_context(p_school_id integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_school_context(p_school_id integer) TO anon;
GRANT ALL ON FUNCTION public.set_school_context(p_school_id integer) TO service_role;
GRANT ALL ON FUNCTION public.set_school_context(p_school_id integer) TO authenticated;


--
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;


--
-- Name: FUNCTION student_id_for_session(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.student_id_for_session() TO anon;
GRANT ALL ON FUNCTION public.student_id_for_session() TO authenticated;
GRANT ALL ON FUNCTION public.student_id_for_session() TO service_role;


--
-- Name: FUNCTION sync_class_teacher_from_timetable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_class_teacher_from_timetable() TO anon;
GRANT ALL ON FUNCTION public.sync_class_teacher_from_timetable() TO authenticated;
GRANT ALL ON FUNCTION public.sync_class_teacher_from_timetable() TO service_role;


--
-- Name: FUNCTION trg_check_expense_policy(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.trg_check_expense_policy() TO anon;
GRANT ALL ON FUNCTION public.trg_check_expense_policy() TO authenticated;
GRANT ALL ON FUNCTION public.trg_check_expense_policy() TO service_role;


--
-- Name: FUNCTION trg_check_fee_cash_limit(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.trg_check_fee_cash_limit() TO anon;
GRANT ALL ON FUNCTION public.trg_check_fee_cash_limit() TO authenticated;
GRANT ALL ON FUNCTION public.trg_check_fee_cash_limit() TO service_role;


--
-- Name: FUNCTION trg_recalc_payroll_on_attendance(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.trg_recalc_payroll_on_attendance() TO anon;
GRANT ALL ON FUNCTION public.trg_recalc_payroll_on_attendance() TO authenticated;
GRANT ALL ON FUNCTION public.trg_recalc_payroll_on_attendance() TO service_role;


--
-- Name: FUNCTION trg_recalc_payroll_on_leave(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.trg_recalc_payroll_on_leave() TO anon;
GRANT ALL ON FUNCTION public.trg_recalc_payroll_on_leave() TO authenticated;
GRANT ALL ON FUNCTION public.trg_recalc_payroll_on_leave() TO service_role;


--
-- Name: FUNCTION trg_seed_hostel_rbac_on_school_create(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.trg_seed_hostel_rbac_on_school_create() TO anon;
GRANT ALL ON FUNCTION public.trg_seed_hostel_rbac_on_school_create() TO authenticated;
GRANT ALL ON FUNCTION public.trg_seed_hostel_rbac_on_school_create() TO service_role;


--
-- Name: FUNCTION trg_seed_school_on_create(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.trg_seed_school_on_create() TO anon;
GRANT ALL ON FUNCTION public.trg_seed_school_on_create() TO authenticated;
GRANT ALL ON FUNCTION public.trg_seed_school_on_create() TO service_role;


--
-- Name: FUNCTION update_conversation_on_message(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_conversation_on_message() TO anon;
GRANT ALL ON FUNCTION public.update_conversation_on_message() TO authenticated;
GRANT ALL ON FUNCTION public.update_conversation_on_message() TO service_role;


--
-- Name: FUNCTION update_fee_paid_amount(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_fee_paid_amount() TO anon;
GRANT ALL ON FUNCTION public.update_fee_paid_amount() TO authenticated;
GRANT ALL ON FUNCTION public.update_fee_paid_amount() TO service_role;


--
-- Name: FUNCTION update_fee_status(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_fee_status() TO anon;
GRANT ALL ON FUNCTION public.update_fee_status() TO authenticated;
GRANT ALL ON FUNCTION public.update_fee_status() TO service_role;


--
-- Name: FUNCTION update_person_display_name(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_person_display_name() TO anon;
GRANT ALL ON FUNCTION public.update_person_display_name() TO authenticated;
GRANT ALL ON FUNCTION public.update_person_display_name() TO service_role;


--
-- Name: FUNCTION update_super_admin_last_login(p_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_super_admin_last_login(p_id uuid) TO anon;
GRANT ALL ON FUNCTION public.update_super_admin_last_login(p_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.update_super_admin_last_login(p_id uuid) TO service_role;


--
-- Name: FUNCTION update_timestamp(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_timestamp() TO anon;
GRANT ALL ON FUNCTION public.update_timestamp() TO authenticated;
GRANT ALL ON FUNCTION public.update_timestamp() TO service_role;


--
-- Name: FUNCTION update_user_settings_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_user_settings_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_user_settings_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_user_settings_updated_at() TO service_role;


--
-- Name: FUNCTION validate_attendance_date(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_attendance_date() TO anon;
GRANT ALL ON FUNCTION public.validate_attendance_date() TO authenticated;
GRANT ALL ON FUNCTION public.validate_attendance_date() TO service_role;


--
-- Name: FUNCTION validate_attendance_entry(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_attendance_entry() TO anon;
GRANT ALL ON FUNCTION public.validate_attendance_entry() TO authenticated;
GRANT ALL ON FUNCTION public.validate_attendance_entry() TO service_role;


--
-- Name: FUNCTION validate_diary_entry(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_diary_entry() TO anon;
GRANT ALL ON FUNCTION public.validate_diary_entry() TO authenticated;
GRANT ALL ON FUNCTION public.validate_diary_entry() TO service_role;


--
-- Name: FUNCTION validate_enrollment_year(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_enrollment_year() TO anon;
GRANT ALL ON FUNCTION public.validate_enrollment_year() TO authenticated;
GRANT ALL ON FUNCTION public.validate_enrollment_year() TO service_role;


--
-- Name: FUNCTION validate_fee_structure_mode(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_fee_structure_mode() TO anon;
GRANT ALL ON FUNCTION public.validate_fee_structure_mode() TO authenticated;
GRANT ALL ON FUNCTION public.validate_fee_structure_mode() TO service_role;


--
-- Name: FUNCTION validate_lms_course_modify(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_lms_course_modify() TO anon;
GRANT ALL ON FUNCTION public.validate_lms_course_modify() TO authenticated;
GRANT ALL ON FUNCTION public.validate_lms_course_modify() TO service_role;


--
-- Name: FUNCTION validate_marks_entry(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_marks_entry() TO anon;
GRANT ALL ON FUNCTION public.validate_marks_entry() TO authenticated;
GRANT ALL ON FUNCTION public.validate_marks_entry() TO service_role;


--
-- Name: FUNCTION validate_timetable_entry(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_timetable_entry() TO anon;
GRANT ALL ON FUNCTION public.validate_timetable_entry() TO authenticated;
GRANT ALL ON FUNCTION public.validate_timetable_entry() TO service_role;


--
-- Name: TABLE academic_years; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.academic_years TO anon;
GRANT ALL ON TABLE public.academic_years TO authenticated;
GRANT ALL ON TABLE public.academic_years TO service_role;


--
-- Name: TABLE access_requests; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.access_requests TO anon;
GRANT ALL ON TABLE public.access_requests TO authenticated;
GRANT ALL ON TABLE public.access_requests TO service_role;


--
-- Name: TABLE persons; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.persons TO anon;
GRANT ALL ON TABLE public.persons TO authenticated;
GRANT ALL ON TABLE public.persons TO service_role;


--
-- Name: TABLE active_persons; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.active_persons TO anon;
GRANT ALL ON TABLE public.active_persons TO authenticated;
GRANT ALL ON TABLE public.active_persons TO service_role;


--
-- Name: TABLE student_statuses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.student_statuses TO anon;
GRANT ALL ON TABLE public.student_statuses TO authenticated;
GRANT ALL ON TABLE public.student_statuses TO service_role;


--
-- Name: TABLE students; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.students TO anon;
GRANT ALL ON TABLE public.students TO authenticated;
GRANT ALL ON TABLE public.students TO service_role;


--
-- Name: TABLE active_students; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.active_students TO anon;
GRANT ALL ON TABLE public.active_students TO authenticated;
GRANT ALL ON TABLE public.active_students TO service_role;


--
-- Name: TABLE activity_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.activity_logs TO anon;
GRANT ALL ON TABLE public.activity_logs TO authenticated;
GRANT ALL ON TABLE public.activity_logs TO service_role;


--
-- Name: SEQUENCE adj_receipt_no_seq_school_1; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_1 TO anon;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_1 TO authenticated;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_1 TO service_role;


--
-- Name: SEQUENCE adj_receipt_no_seq_school_12; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_12 TO anon;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_12 TO authenticated;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_12 TO service_role;


--
-- Name: SEQUENCE adj_receipt_no_seq_school_13; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_13 TO anon;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_13 TO authenticated;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_13 TO service_role;


--
-- Name: SEQUENCE adj_receipt_no_seq_school_14; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_14 TO anon;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_14 TO authenticated;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_14 TO service_role;


--
-- Name: SEQUENCE adj_receipt_no_seq_school_15; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_15 TO anon;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_15 TO authenticated;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_15 TO service_role;


--
-- Name: SEQUENCE adj_receipt_no_seq_school_16; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_16 TO anon;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_16 TO authenticated;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_16 TO service_role;


--
-- Name: SEQUENCE adj_receipt_no_seq_school_17; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_17 TO anon;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_17 TO authenticated;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_17 TO service_role;


--
-- Name: SEQUENCE adj_receipt_no_seq_school_18; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_18 TO anon;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_18 TO authenticated;
GRANT ALL ON SEQUENCE public.adj_receipt_no_seq_school_18 TO service_role;


--
-- Name: TABLE admin_notifications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_notifications TO anon;
GRANT ALL ON TABLE public.admin_notifications TO authenticated;
GRANT ALL ON TABLE public.admin_notifications TO service_role;


--
-- Name: SEQUENCE admin_notifications_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.admin_notifications_id_seq TO anon;
GRANT ALL ON SEQUENCE public.admin_notifications_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.admin_notifications_id_seq TO service_role;


--
-- Name: TABLE admin_quick_action_daily_usage; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_quick_action_daily_usage TO anon;
GRANT ALL ON TABLE public.admin_quick_action_daily_usage TO authenticated;
GRANT ALL ON TABLE public.admin_quick_action_daily_usage TO service_role;


--
-- Name: TABLE approval_requests; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.approval_requests TO anon;
GRANT ALL ON TABLE public.approval_requests TO authenticated;
GRANT ALL ON TABLE public.approval_requests TO service_role;


--
-- Name: TABLE attendance_interventions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.attendance_interventions TO anon;
GRANT ALL ON TABLE public.attendance_interventions TO authenticated;
GRANT ALL ON TABLE public.attendance_interventions TO service_role;


--
-- Name: TABLE audit_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.audit_logs TO anon;
GRANT ALL ON TABLE public.audit_logs TO authenticated;
GRANT ALL ON TABLE public.audit_logs TO service_role;


--
-- Name: TABLE automation_execution_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.automation_execution_logs TO anon;
GRANT ALL ON TABLE public.automation_execution_logs TO authenticated;
GRANT ALL ON TABLE public.automation_execution_logs TO service_role;


--
-- Name: TABLE billing_clients; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.billing_clients TO anon;
GRANT ALL ON TABLE public.billing_clients TO authenticated;
GRANT ALL ON TABLE public.billing_clients TO service_role;


--
-- Name: TABLE billing_config; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.billing_config TO anon;
GRANT ALL ON TABLE public.billing_config TO authenticated;
GRANT ALL ON TABLE public.billing_config TO service_role;


--
-- Name: TABLE billing_document_counters; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.billing_document_counters TO anon;
GRANT ALL ON TABLE public.billing_document_counters TO authenticated;
GRANT ALL ON TABLE public.billing_document_counters TO service_role;


--
-- Name: TABLE billing_documents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.billing_documents TO anon;
GRANT ALL ON TABLE public.billing_documents TO authenticated;
GRANT ALL ON TABLE public.billing_documents TO service_role;


--
-- Name: TABLE blood_groups; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.blood_groups TO anon;
GRANT ALL ON TABLE public.blood_groups TO authenticated;
GRANT ALL ON TABLE public.blood_groups TO service_role;


--
-- Name: TABLE blueprints; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.blueprints TO anon;
GRANT ALL ON TABLE public.blueprints TO authenticated;
GRANT ALL ON TABLE public.blueprints TO service_role;


--
-- Name: SEQUENCE bonafide_cert_seq_school_12_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_12_2026 TO anon;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_12_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_12_2026 TO service_role;


--
-- Name: SEQUENCE bonafide_cert_seq_school_13_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_13_2026 TO anon;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_13_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_13_2026 TO service_role;


--
-- Name: SEQUENCE bonafide_cert_seq_school_14_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_14_2026 TO anon;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_14_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_14_2026 TO service_role;


--
-- Name: SEQUENCE bonafide_cert_seq_school_15_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_15_2026 TO anon;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_15_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_15_2026 TO service_role;


--
-- Name: SEQUENCE bonafide_cert_seq_school_16_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_16_2026 TO anon;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_16_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_16_2026 TO service_role;


--
-- Name: SEQUENCE bonafide_cert_seq_school_17_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_17_2026 TO anon;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_17_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_17_2026 TO service_role;


--
-- Name: SEQUENCE bonafide_cert_seq_school_18_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_18_2026 TO anon;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_18_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_18_2026 TO service_role;


--
-- Name: SEQUENCE bonafide_cert_seq_school_19_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_19_2026 TO anon;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_19_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_19_2026 TO service_role;


--
-- Name: SEQUENCE bonafide_cert_seq_school_1_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_1_2026 TO anon;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_1_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_1_2026 TO service_role;


--
-- Name: SEQUENCE bonafide_cert_seq_school_1_2099; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_1_2099 TO anon;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_1_2099 TO authenticated;
GRANT ALL ON SEQUENCE public.bonafide_cert_seq_school_1_2099 TO service_role;


--
-- Name: SEQUENCE bonafide_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.bonafide_seq TO anon;
GRANT ALL ON SEQUENCE public.bonafide_seq TO authenticated;
GRANT ALL ON SEQUENCE public.bonafide_seq TO service_role;


--
-- Name: TABLE bus_locations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.bus_locations TO anon;
GRANT ALL ON TABLE public.bus_locations TO authenticated;
GRANT ALL ON TABLE public.bus_locations TO service_role;


--
-- Name: TABLE bus_stop_attendance; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.bus_stop_attendance TO anon;
GRANT ALL ON TABLE public.bus_stop_attendance TO authenticated;
GRANT ALL ON TABLE public.bus_stop_attendance TO service_role;


--
-- Name: TABLE bus_trip_history; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.bus_trip_history TO anon;
GRANT ALL ON TABLE public.bus_trip_history TO authenticated;
GRANT ALL ON TABLE public.bus_trip_history TO service_role;


--
-- Name: TABLE buses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.buses TO anon;
GRANT ALL ON TABLE public.buses TO authenticated;
GRANT ALL ON TABLE public.buses TO service_role;


--
-- Name: TABLE business_units; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.business_units TO anon;
GRANT ALL ON TABLE public.business_units TO authenticated;
GRANT ALL ON TABLE public.business_units TO service_role;


--
-- Name: TABLE class_sections; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.class_sections TO anon;
GRANT ALL ON TABLE public.class_sections TO authenticated;
GRANT ALL ON TABLE public.class_sections TO service_role;


--
-- Name: TABLE class_subjects; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.class_subjects TO anon;
GRANT ALL ON TABLE public.class_subjects TO authenticated;
GRANT ALL ON TABLE public.class_subjects TO service_role;


--
-- Name: TABLE classes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.classes TO anon;
GRANT ALL ON TABLE public.classes TO authenticated;
GRANT ALL ON TABLE public.classes TO service_role;


--
-- Name: TABLE clusters; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.clusters TO anon;
GRANT ALL ON TABLE public.clusters TO authenticated;
GRANT ALL ON TABLE public.clusters TO service_role;


--
-- Name: TABLE collections; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.collections TO anon;
GRANT ALL ON TABLE public.collections TO authenticated;
GRANT ALL ON TABLE public.collections TO service_role;


--
-- Name: SEQUENCE complaint_ticket_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.complaint_ticket_seq TO anon;
GRANT ALL ON SEQUENCE public.complaint_ticket_seq TO authenticated;
GRANT ALL ON SEQUENCE public.complaint_ticket_seq TO service_role;


--
-- Name: TABLE complaints; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.complaints TO anon;
GRANT ALL ON TABLE public.complaints TO authenticated;
GRANT ALL ON TABLE public.complaints TO service_role;


--
-- Name: TABLE context_switch_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.context_switch_logs TO anon;
GRANT ALL ON TABLE public.context_switch_logs TO authenticated;
GRANT ALL ON TABLE public.context_switch_logs TO service_role;


--
-- Name: TABLE enquiries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.enquiries TO anon;
GRANT ALL ON TABLE public.enquiries TO authenticated;
GRANT ALL ON TABLE public.enquiries TO service_role;


--
-- Name: TABLE conversion_rate; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.conversion_rate TO anon;
GRANT ALL ON TABLE public.conversion_rate TO authenticated;
GRANT ALL ON TABLE public.conversion_rate TO service_role;


--
-- Name: TABLE expenses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.expenses TO anon;
GRANT ALL ON TABLE public.expenses TO authenticated;
GRANT ALL ON TABLE public.expenses TO service_role;


--
-- Name: TABLE cost_per_lead; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cost_per_lead TO anon;
GRANT ALL ON TABLE public.cost_per_lead TO authenticated;
GRANT ALL ON TABLE public.cost_per_lead TO service_role;


--
-- Name: TABLE countries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.countries TO anon;
GRANT ALL ON TABLE public.countries TO authenticated;
GRANT ALL ON TABLE public.countries TO service_role;


--
-- Name: TABLE crm_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.crm_accounts TO anon;
GRANT ALL ON TABLE public.crm_accounts TO authenticated;
GRANT ALL ON TABLE public.crm_accounts TO service_role;


--
-- Name: TABLE crm_activities; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.crm_activities TO anon;
GRANT ALL ON TABLE public.crm_activities TO authenticated;
GRANT ALL ON TABLE public.crm_activities TO service_role;


--
-- Name: TABLE crm_automation_rules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.crm_automation_rules TO anon;
GRANT ALL ON TABLE public.crm_automation_rules TO authenticated;
GRANT ALL ON TABLE public.crm_automation_rules TO service_role;


--
-- Name: TABLE crm_automation_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.crm_automation_runs TO anon;
GRANT ALL ON TABLE public.crm_automation_runs TO authenticated;
GRANT ALL ON TABLE public.crm_automation_runs TO service_role;


--
-- Name: TABLE crm_contacts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.crm_contacts TO anon;
GRANT ALL ON TABLE public.crm_contacts TO authenticated;
GRANT ALL ON TABLE public.crm_contacts TO service_role;


--
-- Name: TABLE crm_tasks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.crm_tasks TO anon;
GRANT ALL ON TABLE public.crm_tasks TO authenticated;
GRANT ALL ON TABLE public.crm_tasks TO service_role;


--
-- Name: TABLE daily_attendance; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.daily_attendance TO anon;
GRANT ALL ON TABLE public.daily_attendance TO authenticated;
GRANT ALL ON TABLE public.daily_attendance TO service_role;


--
-- Name: TABLE dcgd_programs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.dcgd_programs TO anon;
GRANT ALL ON TABLE public.dcgd_programs TO authenticated;
GRANT ALL ON TABLE public.dcgd_programs TO service_role;


--
-- Name: SEQUENCE dcgd_programs_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.dcgd_programs_id_seq TO anon;
GRANT ALL ON SEQUENCE public.dcgd_programs_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.dcgd_programs_id_seq TO service_role;


--
-- Name: TABLE dcgd_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.dcgd_settings TO anon;
GRANT ALL ON TABLE public.dcgd_settings TO authenticated;
GRANT ALL ON TABLE public.dcgd_settings TO service_role;


--
-- Name: TABLE sections; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.sections TO anon;
GRANT ALL ON TABLE public.sections TO authenticated;
GRANT ALL ON TABLE public.sections TO service_role;


--
-- Name: TABLE staff; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.staff TO anon;
GRANT ALL ON TABLE public.staff TO authenticated;
GRANT ALL ON TABLE public.staff TO service_role;


--
-- Name: TABLE debug_class_teachers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.debug_class_teachers TO anon;
GRANT ALL ON TABLE public.debug_class_teachers TO authenticated;
GRANT ALL ON TABLE public.debug_class_teachers TO service_role;


--
-- Name: TABLE permissions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.permissions TO anon;
GRANT ALL ON TABLE public.permissions TO authenticated;
GRANT ALL ON TABLE public.permissions TO service_role;


--
-- Name: TABLE role_permissions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.role_permissions TO anon;
GRANT ALL ON TABLE public.role_permissions TO authenticated;
GRANT ALL ON TABLE public.role_permissions TO service_role;


--
-- Name: TABLE roles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.roles TO anon;
GRANT ALL ON TABLE public.roles TO authenticated;
GRANT ALL ON TABLE public.roles TO service_role;


--
-- Name: TABLE debug_role_permissions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.debug_role_permissions TO anon;
GRANT ALL ON TABLE public.debug_role_permissions TO authenticated;
GRANT ALL ON TABLE public.debug_role_permissions TO service_role;


--
-- Name: TABLE defaulter_dues; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.defaulter_dues TO anon;
GRANT ALL ON TABLE public.defaulter_dues TO authenticated;
GRANT ALL ON TABLE public.defaulter_dues TO service_role;


--
-- Name: TABLE defaulter_payments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.defaulter_payments TO anon;
GRANT ALL ON TABLE public.defaulter_payments TO authenticated;
GRANT ALL ON TABLE public.defaulter_payments TO service_role;


--
-- Name: TABLE diary_entries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.diary_entries TO anon;
GRANT ALL ON TABLE public.diary_entries TO authenticated;
GRANT ALL ON TABLE public.diary_entries TO service_role;


--
-- Name: TABLE discipline_records; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.discipline_records TO anon;
GRANT ALL ON TABLE public.discipline_records TO authenticated;
GRANT ALL ON TABLE public.discipline_records TO service_role;


--
-- Name: TABLE driver_devices; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_devices TO anon;
GRANT ALL ON TABLE public.driver_devices TO authenticated;
GRANT ALL ON TABLE public.driver_devices TO service_role;


--
-- Name: TABLE driver_heartbeat; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_heartbeat TO anon;
GRANT ALL ON TABLE public.driver_heartbeat TO authenticated;
GRANT ALL ON TABLE public.driver_heartbeat TO service_role;


--
-- Name: TABLE driver_route_assignments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_route_assignments TO anon;
GRANT ALL ON TABLE public.driver_route_assignments TO authenticated;
GRANT ALL ON TABLE public.driver_route_assignments TO service_role;


--
-- Name: SEQUENCE employee_code_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.employee_code_seq TO anon;
GRANT ALL ON SEQUENCE public.employee_code_seq TO authenticated;
GRANT ALL ON SEQUENCE public.employee_code_seq TO service_role;


--
-- Name: TABLE employee_documents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.employee_documents TO anon;
GRANT ALL ON TABLE public.employee_documents TO authenticated;
GRANT ALL ON TABLE public.employee_documents TO service_role;


--
-- Name: TABLE employees; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.employees TO anon;
GRANT ALL ON TABLE public.employees TO authenticated;
GRANT ALL ON TABLE public.employees TO service_role;


--
-- Name: TABLE events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.events TO anon;
GRANT ALL ON TABLE public.events TO authenticated;
GRANT ALL ON TABLE public.events TO service_role;


--
-- Name: TABLE exam_room_allocations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.exam_room_allocations TO anon;
GRANT ALL ON TABLE public.exam_room_allocations TO authenticated;
GRANT ALL ON TABLE public.exam_room_allocations TO service_role;


--
-- Name: TABLE exam_rooms; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.exam_rooms TO anon;
GRANT ALL ON TABLE public.exam_rooms TO authenticated;
GRANT ALL ON TABLE public.exam_rooms TO service_role;


--
-- Name: TABLE exam_seat_assignments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.exam_seat_assignments TO anon;
GRANT ALL ON TABLE public.exam_seat_assignments TO authenticated;
GRANT ALL ON TABLE public.exam_seat_assignments TO service_role;


--
-- Name: TABLE exam_subjects; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.exam_subjects TO anon;
GRANT ALL ON TABLE public.exam_subjects TO authenticated;
GRANT ALL ON TABLE public.exam_subjects TO service_role;


--
-- Name: TABLE exams; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.exams TO anon;
GRANT ALL ON TABLE public.exams TO authenticated;
GRANT ALL ON TABLE public.exams TO service_role;


--
-- Name: TABLE feature_flags; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.feature_flags TO anon;
GRANT ALL ON TABLE public.feature_flags TO authenticated;
GRANT ALL ON TABLE public.feature_flags TO service_role;


--
-- Name: TABLE fee_adjustments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.fee_adjustments TO anon;
GRANT ALL ON TABLE public.fee_adjustments TO authenticated;
GRANT ALL ON TABLE public.fee_adjustments TO service_role;


--
-- Name: TABLE student_fees; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.student_fees TO anon;
GRANT ALL ON TABLE public.student_fees TO authenticated;
GRANT ALL ON TABLE public.student_fees TO service_role;


--
-- Name: TABLE fee_installments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.fee_installments TO anon;
GRANT ALL ON TABLE public.fee_installments TO authenticated;
GRANT ALL ON TABLE public.fee_installments TO service_role;


--
-- Name: TABLE fee_structures; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.fee_structures TO anon;
GRANT ALL ON TABLE public.fee_structures TO authenticated;
GRANT ALL ON TABLE public.fee_structures TO service_role;


--
-- Name: TABLE fee_transactions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.fee_transactions TO anon;
GRANT ALL ON TABLE public.fee_transactions TO authenticated;
GRANT ALL ON TABLE public.fee_transactions TO service_role;


--
-- Name: TABLE fee_types; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.fee_types TO anon;
GRANT ALL ON TABLE public.fee_types TO authenticated;
GRANT ALL ON TABLE public.fee_types TO service_role;


--
-- Name: TABLE festival_posters; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.festival_posters TO anon;
GRANT ALL ON TABLE public.festival_posters TO authenticated;
GRANT ALL ON TABLE public.festival_posters TO service_role;


--
-- Name: TABLE financial_audit_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.financial_audit_logs TO anon;
GRANT ALL ON TABLE public.financial_audit_logs TO authenticated;
GRANT ALL ON TABLE public.financial_audit_logs TO service_role;


--
-- Name: TABLE financial_policy_rules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.financial_policy_rules TO anon;
GRANT ALL ON TABLE public.financial_policy_rules TO authenticated;
GRANT ALL ON TABLE public.financial_policy_rules TO service_role;


--
-- Name: TABLE founders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.founders TO anon;
GRANT ALL ON TABLE public.founders TO authenticated;
GRANT ALL ON TABLE public.founders TO service_role;


--
-- Name: TABLE founder_lead_performance; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.founder_lead_performance TO anon;
GRANT ALL ON TABLE public.founder_lead_performance TO authenticated;
GRANT ALL ON TABLE public.founder_lead_performance TO service_role;


--
-- Name: TABLE genders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.genders TO anon;
GRANT ALL ON TABLE public.genders TO authenticated;
GRANT ALL ON TABLE public.genders TO service_role;


--
-- Name: TABLE generated_papers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.generated_papers TO anon;
GRANT ALL ON TABLE public.generated_papers TO authenticated;
GRANT ALL ON TABLE public.generated_papers TO service_role;


--
-- Name: TABLE grading_scales; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.grading_scales TO anon;
GRANT ALL ON TABLE public.grading_scales TO authenticated;
GRANT ALL ON TABLE public.grading_scales TO service_role;


--
-- Name: TABLE hostel_allocations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.hostel_allocations TO anon;
GRANT ALL ON TABLE public.hostel_allocations TO authenticated;
GRANT ALL ON TABLE public.hostel_allocations TO service_role;


--
-- Name: TABLE hostel_blocks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.hostel_blocks TO anon;
GRANT ALL ON TABLE public.hostel_blocks TO authenticated;
GRANT ALL ON TABLE public.hostel_blocks TO service_role;


--
-- Name: TABLE hostel_permission_requests; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.hostel_permission_requests TO anon;
GRANT ALL ON TABLE public.hostel_permission_requests TO authenticated;
GRANT ALL ON TABLE public.hostel_permission_requests TO service_role;


--
-- Name: TABLE hostel_rooms; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.hostel_rooms TO anon;
GRANT ALL ON TABLE public.hostel_rooms TO authenticated;
GRANT ALL ON TABLE public.hostel_rooms TO service_role;


--
-- Name: TABLE internal_user_permission_overrides; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.internal_user_permission_overrides TO anon;
GRANT ALL ON TABLE public.internal_user_permission_overrides TO authenticated;
GRANT ALL ON TABLE public.internal_user_permission_overrides TO service_role;


--
-- Name: TABLE internal_user_schools; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.internal_user_schools TO anon;
GRANT ALL ON TABLE public.internal_user_schools TO authenticated;
GRANT ALL ON TABLE public.internal_user_schools TO service_role;


--
-- Name: TABLE internal_user_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.internal_user_sessions TO anon;
GRANT ALL ON TABLE public.internal_user_sessions TO authenticated;
GRANT ALL ON TABLE public.internal_user_sessions TO service_role;


--
-- Name: TABLE internal_users; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.internal_users TO anon;
GRANT ALL ON TABLE public.internal_users TO authenticated;
GRANT ALL ON TABLE public.internal_users TO service_role;


--
-- Name: TABLE issued_certificates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.issued_certificates TO anon;
GRANT ALL ON TABLE public.issued_certificates TO authenticated;
GRANT ALL ON TABLE public.issued_certificates TO service_role;


--
-- Name: TABLE leads_by_website; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.leads_by_website TO anon;
GRANT ALL ON TABLE public.leads_by_website TO authenticated;
GRANT ALL ON TABLE public.leads_by_website TO service_role;


--
-- Name: TABLE leave_applications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.leave_applications TO anon;
GRANT ALL ON TABLE public.leave_applications TO authenticated;
GRANT ALL ON TABLE public.leave_applications TO service_role;


--
-- Name: TABLE life_values_modules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.life_values_modules TO anon;
GRANT ALL ON TABLE public.life_values_modules TO authenticated;
GRANT ALL ON TABLE public.life_values_modules TO service_role;


--
-- Name: TABLE lms_courses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.lms_courses TO anon;
GRANT ALL ON TABLE public.lms_courses TO authenticated;
GRANT ALL ON TABLE public.lms_courses TO service_role;


--
-- Name: TABLE lms_materials; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.lms_materials TO anon;
GRANT ALL ON TABLE public.lms_materials TO authenticated;
GRANT ALL ON TABLE public.lms_materials TO service_role;


--
-- Name: TABLE marks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.marks TO anon;
GRANT ALL ON TABLE public.marks TO authenticated;
GRANT ALL ON TABLE public.marks TO service_role;


--
-- Name: TABLE message_conversations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.message_conversations TO anon;
GRANT ALL ON TABLE public.message_conversations TO authenticated;
GRANT ALL ON TABLE public.message_conversations TO service_role;


--
-- Name: TABLE message_participants; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.message_participants TO anon;
GRANT ALL ON TABLE public.message_participants TO authenticated;
GRANT ALL ON TABLE public.message_participants TO service_role;


--
-- Name: TABLE message_typing; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.message_typing TO anon;
GRANT ALL ON TABLE public.message_typing TO authenticated;
GRANT ALL ON TABLE public.message_typing TO service_role;


--
-- Name: TABLE messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.messages TO anon;
GRANT ALL ON TABLE public.messages TO authenticated;
GRANT ALL ON TABLE public.messages TO service_role;


--
-- Name: TABLE money_science_modules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.money_science_modules TO anon;
GRANT ALL ON TABLE public.money_science_modules TO authenticated;
GRANT ALL ON TABLE public.money_science_modules TO service_role;


--
-- Name: TABLE monthly_closed_deals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.monthly_closed_deals TO anon;
GRANT ALL ON TABLE public.monthly_closed_deals TO authenticated;
GRANT ALL ON TABLE public.monthly_closed_deals TO service_role;


--
-- Name: TABLE monthly_enquiry_summary; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.monthly_enquiry_summary TO anon;
GRANT ALL ON TABLE public.monthly_enquiry_summary TO authenticated;
GRANT ALL ON TABLE public.monthly_enquiry_summary TO service_role;


--
-- Name: TABLE monthly_expense_summary; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.monthly_expense_summary TO anon;
GRANT ALL ON TABLE public.monthly_expense_summary TO authenticated;
GRANT ALL ON TABLE public.monthly_expense_summary TO service_role;


--
-- Name: TABLE monthly_expense_summary_v2; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.monthly_expense_summary_v2 TO anon;
GRANT ALL ON TABLE public.monthly_expense_summary_v2 TO authenticated;
GRANT ALL ON TABLE public.monthly_expense_summary_v2 TO service_role;


--
-- Name: TABLE monthly_income_summary; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.monthly_income_summary TO anon;
GRANT ALL ON TABLE public.monthly_income_summary TO authenticated;
GRANT ALL ON TABLE public.monthly_income_summary TO service_role;


--
-- Name: TABLE notices; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notices TO anon;
GRANT ALL ON TABLE public.notices TO authenticated;
GRANT ALL ON TABLE public.notices TO service_role;


--
-- Name: TABLE notification_audit_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notification_audit_logs TO anon;
GRANT ALL ON TABLE public.notification_audit_logs TO authenticated;
GRANT ALL ON TABLE public.notification_audit_logs TO service_role;


--
-- Name: TABLE notification_batches; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notification_batches TO anon;
GRANT ALL ON TABLE public.notification_batches TO authenticated;
GRANT ALL ON TABLE public.notification_batches TO service_role;


--
-- Name: TABLE notification_config; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notification_config TO anon;
GRANT ALL ON TABLE public.notification_config TO authenticated;
GRANT ALL ON TABLE public.notification_config TO service_role;


--
-- Name: TABLE notification_deliveries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notification_deliveries TO anon;
GRANT ALL ON TABLE public.notification_deliveries TO authenticated;
GRANT ALL ON TABLE public.notification_deliveries TO service_role;


--
-- Name: TABLE notification_dispatch_recipients; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notification_dispatch_recipients TO anon;
GRANT ALL ON TABLE public.notification_dispatch_recipients TO authenticated;
GRANT ALL ON TABLE public.notification_dispatch_recipients TO service_role;


--
-- Name: TABLE notification_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notification_events TO anon;
GRANT ALL ON TABLE public.notification_events TO authenticated;
GRANT ALL ON TABLE public.notification_events TO service_role;


--
-- Name: TABLE notification_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notification_logs TO anon;
GRANT ALL ON TABLE public.notification_logs TO authenticated;
GRANT ALL ON TABLE public.notification_logs TO service_role;


--
-- Name: TABLE notification_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notification_preferences TO anon;
GRANT ALL ON TABLE public.notification_preferences TO authenticated;
GRANT ALL ON TABLE public.notification_preferences TO service_role;


--
-- Name: TABLE notification_templates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notification_templates TO anon;
GRANT ALL ON TABLE public.notification_templates TO authenticated;
GRANT ALL ON TABLE public.notification_templates TO service_role;


--
-- Name: TABLE notifications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notifications TO anon;
GRANT ALL ON TABLE public.notifications TO authenticated;
GRANT ALL ON TABLE public.notifications TO service_role;


--
-- Name: TABLE parent_visits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.parent_visits TO anon;
GRANT ALL ON TABLE public.parent_visits TO authenticated;
GRANT ALL ON TABLE public.parent_visits TO service_role;


--
-- Name: TABLE parents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.parents TO anon;
GRANT ALL ON TABLE public.parents TO authenticated;
GRANT ALL ON TABLE public.parents TO service_role;


--
-- Name: TABLE payroll_config; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payroll_config TO anon;
GRANT ALL ON TABLE public.payroll_config TO authenticated;
GRANT ALL ON TABLE public.payroll_config TO service_role;


--
-- Name: TABLE payroll_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.payroll_runs TO anon;
GRANT ALL ON TABLE public.payroll_runs TO authenticated;
GRANT ALL ON TABLE public.payroll_runs TO service_role;


--
-- Name: TABLE pending_metrics_summary; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pending_metrics_summary TO anon;
GRANT ALL ON TABLE public.pending_metrics_summary TO authenticated;
GRANT ALL ON TABLE public.pending_metrics_summary TO service_role;


--
-- Name: TABLE periods; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.periods TO anon;
GRANT ALL ON TABLE public.periods TO authenticated;
GRANT ALL ON TABLE public.periods TO service_role;


--
-- Name: TABLE person_contacts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.person_contacts TO anon;
GRANT ALL ON TABLE public.person_contacts TO authenticated;
GRANT ALL ON TABLE public.person_contacts TO service_role;


--
-- Name: TABLE question_bank; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.question_bank TO anon;
GRANT ALL ON TABLE public.question_bank TO authenticated;
GRANT ALL ON TABLE public.question_bank TO service_role;


--
-- Name: TABLE receipt_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.receipt_items TO anon;
GRANT ALL ON TABLE public.receipt_items TO authenticated;
GRANT ALL ON TABLE public.receipt_items TO service_role;


--
-- Name: SEQUENCE receipt_no_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.receipt_no_seq TO anon;
GRANT ALL ON SEQUENCE public.receipt_no_seq TO authenticated;
GRANT ALL ON SEQUENCE public.receipt_no_seq TO service_role;


--
-- Name: TABLE receipt_number_counters; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.receipt_number_counters TO anon;
GRANT ALL ON TABLE public.receipt_number_counters TO authenticated;
GRANT ALL ON TABLE public.receipt_number_counters TO service_role;


--
-- Name: TABLE receipts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.receipts TO anon;
GRANT ALL ON TABLE public.receipts TO authenticated;
GRANT ALL ON TABLE public.receipts TO service_role;


--
-- Name: TABLE relationship_types; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.relationship_types TO anon;
GRANT ALL ON TABLE public.relationship_types TO authenticated;
GRANT ALL ON TABLE public.relationship_types TO service_role;


--
-- Name: TABLE religions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.religions TO anon;
GRANT ALL ON TABLE public.religions TO authenticated;
GRANT ALL ON TABLE public.religions TO service_role;


--
-- Name: TABLE route_leg_calibration; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.route_leg_calibration TO anon;
GRANT ALL ON TABLE public.route_leg_calibration TO authenticated;
GRANT ALL ON TABLE public.route_leg_calibration TO service_role;


--
-- Name: TABLE route_segment_time; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.route_segment_time TO anon;
GRANT ALL ON TABLE public.route_segment_time TO authenticated;
GRANT ALL ON TABLE public.route_segment_time TO service_role;


--
-- Name: TABLE route_stop_geo; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.route_stop_geo TO anon;
GRANT ALL ON TABLE public.route_stop_geo TO authenticated;
GRANT ALL ON TABLE public.route_stop_geo TO service_role;


--
-- Name: TABLE saas_subscription_payments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.saas_subscription_payments TO anon;
GRANT ALL ON TABLE public.saas_subscription_payments TO authenticated;
GRANT ALL ON TABLE public.saas_subscription_payments TO service_role;


--
-- Name: TABLE saas_subscription_receipts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.saas_subscription_receipts TO anon;
GRANT ALL ON TABLE public.saas_subscription_receipts TO authenticated;
GRANT ALL ON TABLE public.saas_subscription_receipts TO service_role;


--
-- Name: TABLE saas_subscriptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.saas_subscriptions TO anon;
GRANT ALL ON TABLE public.saas_subscriptions TO authenticated;
GRANT ALL ON TABLE public.saas_subscriptions TO service_role;


--
-- Name: TABLE schema_meta; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.schema_meta TO anon;
GRANT ALL ON TABLE public.schema_meta TO authenticated;
GRANT ALL ON TABLE public.schema_meta TO service_role;


--
-- Name: TABLE schema_migrations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.schema_migrations TO anon;
GRANT ALL ON TABLE public.schema_migrations TO authenticated;
GRANT ALL ON TABLE public.schema_migrations TO service_role;


--
-- Name: TABLE school_automation_rules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.school_automation_rules TO anon;
GRANT ALL ON TABLE public.school_automation_rules TO authenticated;
GRANT ALL ON TABLE public.school_automation_rules TO service_role;


--
-- Name: TABLE school_feature_flags; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.school_feature_flags TO anon;
GRANT ALL ON TABLE public.school_feature_flags TO authenticated;
GRANT ALL ON TABLE public.school_feature_flags TO service_role;


--
-- Name: TABLE school_onboarding_checklists; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.school_onboarding_checklists TO anon;
GRANT ALL ON TABLE public.school_onboarding_checklists TO authenticated;
GRANT ALL ON TABLE public.school_onboarding_checklists TO service_role;


--
-- Name: TABLE school_requirements; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.school_requirements TO anon;
GRANT ALL ON TABLE public.school_requirements TO authenticated;
GRANT ALL ON TABLE public.school_requirements TO service_role;


--
-- Name: TABLE school_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.school_settings TO anon;
GRANT ALL ON TABLE public.school_settings TO authenticated;
GRANT ALL ON TABLE public.school_settings TO service_role;


--
-- Name: TABLE school_website_gallery; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.school_website_gallery TO anon;
GRANT ALL ON TABLE public.school_website_gallery TO authenticated;
GRANT ALL ON TABLE public.school_website_gallery TO service_role;


--
-- Name: TABLE schools; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.schools TO anon;
GRANT ALL ON TABLE public.schools TO authenticated;
GRANT ALL ON TABLE public.schools TO service_role;


--
-- Name: SEQUENCE schools_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.schools_id_seq TO anon;
GRANT ALL ON SEQUENCE public.schools_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.schools_id_seq TO service_role;


--
-- Name: TABLE science_projects; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.science_projects TO anon;
GRANT ALL ON TABLE public.science_projects TO authenticated;
GRANT ALL ON TABLE public.science_projects TO service_role;


--
-- Name: TABLE settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.settings TO anon;
GRANT ALL ON TABLE public.settings TO authenticated;
GRANT ALL ON TABLE public.settings TO service_role;


--
-- Name: TABLE staff_attendance; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.staff_attendance TO anon;
GRANT ALL ON TABLE public.staff_attendance TO authenticated;
GRANT ALL ON TABLE public.staff_attendance TO service_role;


--
-- Name: SEQUENCE staff_designations_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.staff_designations_id_seq TO anon;
GRANT ALL ON SEQUENCE public.staff_designations_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.staff_designations_id_seq TO service_role;


--
-- Name: TABLE staff_designations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.staff_designations TO anon;
GRANT ALL ON TABLE public.staff_designations TO authenticated;
GRANT ALL ON TABLE public.staff_designations TO service_role;


--
-- Name: TABLE staff_payroll; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.staff_payroll TO anon;
GRANT ALL ON TABLE public.staff_payroll TO authenticated;
GRANT ALL ON TABLE public.staff_payroll TO service_role;


--
-- Name: TABLE staff_statuses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.staff_statuses TO anon;
GRANT ALL ON TABLE public.staff_statuses TO authenticated;
GRANT ALL ON TABLE public.staff_statuses TO service_role;


--
-- Name: TABLE student_bulk_update_batches; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.student_bulk_update_batches TO anon;
GRANT ALL ON TABLE public.student_bulk_update_batches TO authenticated;
GRANT ALL ON TABLE public.student_bulk_update_batches TO service_role;


--
-- Name: TABLE student_bulk_update_rows; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.student_bulk_update_rows TO anon;
GRANT ALL ON TABLE public.student_bulk_update_rows TO authenticated;
GRANT ALL ON TABLE public.student_bulk_update_rows TO service_role;


--
-- Name: TABLE student_categories; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.student_categories TO anon;
GRANT ALL ON TABLE public.student_categories TO authenticated;
GRANT ALL ON TABLE public.student_categories TO service_role;


--
-- Name: TABLE student_enrollments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.student_enrollments TO anon;
GRANT ALL ON TABLE public.student_enrollments TO authenticated;
GRANT ALL ON TABLE public.student_enrollments TO service_role;


--
-- Name: TABLE student_life_values_progress; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.student_life_values_progress TO anon;
GRANT ALL ON TABLE public.student_life_values_progress TO authenticated;
GRANT ALL ON TABLE public.student_life_values_progress TO service_role;


--
-- Name: TABLE student_money_science_progress; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.student_money_science_progress TO anon;
GRANT ALL ON TABLE public.student_money_science_progress TO authenticated;
GRANT ALL ON TABLE public.student_money_science_progress TO service_role;


--
-- Name: TABLE student_parents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.student_parents TO anon;
GRANT ALL ON TABLE public.student_parents TO authenticated;
GRANT ALL ON TABLE public.student_parents TO service_role;


--
-- Name: TABLE student_science_projects; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.student_science_projects TO anon;
GRANT ALL ON TABLE public.student_science_projects TO authenticated;
GRANT ALL ON TABLE public.student_science_projects TO service_role;


--
-- Name: TABLE student_transport; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.student_transport TO anon;
GRANT ALL ON TABLE public.student_transport TO authenticated;
GRANT ALL ON TABLE public.student_transport TO service_role;


--
-- Name: TABLE subjects; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.subjects TO anon;
GRANT ALL ON TABLE public.subjects TO authenticated;
GRANT ALL ON TABLE public.subjects TO service_role;


--
-- Name: TABLE super_admins; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.super_admins TO anon;
GRANT ALL ON TABLE public.super_admins TO authenticated;
GRANT ALL ON TABLE public.super_admins TO service_role;


--
-- Name: TABLE support_message_notification_outbox; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.support_message_notification_outbox TO anon;
GRANT ALL ON TABLE public.support_message_notification_outbox TO authenticated;
GRANT ALL ON TABLE public.support_message_notification_outbox TO service_role;


--
-- Name: TABLE support_ticket_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.support_ticket_messages TO anon;
GRANT ALL ON TABLE public.support_ticket_messages TO authenticated;
GRANT ALL ON TABLE public.support_ticket_messages TO service_role;


--
-- Name: TABLE support_ticket_notes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.support_ticket_notes TO anon;
GRANT ALL ON TABLE public.support_ticket_notes TO authenticated;
GRANT ALL ON TABLE public.support_ticket_notes TO service_role;


--
-- Name: TABLE support_tickets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.support_tickets TO anon;
GRANT ALL ON TABLE public.support_tickets TO authenticated;
GRANT ALL ON TABLE public.support_tickets TO service_role;


--
-- Name: SEQUENCE tc_cert_seq_school_14_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.tc_cert_seq_school_14_2026 TO anon;
GRANT ALL ON SEQUENCE public.tc_cert_seq_school_14_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.tc_cert_seq_school_14_2026 TO service_role;


--
-- Name: SEQUENCE tc_cert_seq_school_15_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.tc_cert_seq_school_15_2026 TO anon;
GRANT ALL ON SEQUENCE public.tc_cert_seq_school_15_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.tc_cert_seq_school_15_2026 TO service_role;


--
-- Name: SEQUENCE tc_cert_seq_school_16_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.tc_cert_seq_school_16_2026 TO anon;
GRANT ALL ON SEQUENCE public.tc_cert_seq_school_16_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.tc_cert_seq_school_16_2026 TO service_role;


--
-- Name: SEQUENCE tc_cert_seq_school_17_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.tc_cert_seq_school_17_2026 TO anon;
GRANT ALL ON SEQUENCE public.tc_cert_seq_school_17_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.tc_cert_seq_school_17_2026 TO service_role;


--
-- Name: SEQUENCE tc_cert_seq_school_18_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.tc_cert_seq_school_18_2026 TO anon;
GRANT ALL ON SEQUENCE public.tc_cert_seq_school_18_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.tc_cert_seq_school_18_2026 TO service_role;


--
-- Name: SEQUENCE tc_cert_seq_school_19_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.tc_cert_seq_school_19_2026 TO anon;
GRANT ALL ON SEQUENCE public.tc_cert_seq_school_19_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.tc_cert_seq_school_19_2026 TO service_role;


--
-- Name: SEQUENCE tc_cert_seq_school_1_2026; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.tc_cert_seq_school_1_2026 TO anon;
GRANT ALL ON SEQUENCE public.tc_cert_seq_school_1_2026 TO authenticated;
GRANT ALL ON SEQUENCE public.tc_cert_seq_school_1_2026 TO service_role;


--
-- Name: SEQUENCE tc_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.tc_seq TO anon;
GRANT ALL ON SEQUENCE public.tc_seq TO authenticated;
GRANT ALL ON SEQUENCE public.tc_seq TO service_role;


--
-- Name: TABLE temp_access_grants; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.temp_access_grants TO anon;
GRANT ALL ON TABLE public.temp_access_grants TO authenticated;
GRANT ALL ON TABLE public.temp_access_grants TO service_role;


--
-- Name: TABLE tenant_student_deletion_audit; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.tenant_student_deletion_audit TO anon;
GRANT ALL ON TABLE public.tenant_student_deletion_audit TO authenticated;
GRANT ALL ON TABLE public.tenant_student_deletion_audit TO service_role;


--
-- Name: SEQUENCE tenant_student_deletion_audit_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.tenant_student_deletion_audit_id_seq TO anon;
GRANT ALL ON SEQUENCE public.tenant_student_deletion_audit_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.tenant_student_deletion_audit_id_seq TO service_role;


--
-- Name: TABLE ticket_number_counters; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ticket_number_counters TO anon;
GRANT ALL ON TABLE public.ticket_number_counters TO authenticated;
GRANT ALL ON TABLE public.ticket_number_counters TO service_role;


--
-- Name: TABLE timetable_entries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.timetable_entries TO anon;
GRANT ALL ON TABLE public.timetable_entries TO authenticated;
GRANT ALL ON TABLE public.timetable_entries TO service_role;


--
-- Name: TABLE timetable_slots; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.timetable_slots TO anon;
GRANT ALL ON TABLE public.timetable_slots TO authenticated;
GRANT ALL ON TABLE public.timetable_slots TO service_role;


--
-- Name: TABLE timetable_substitutions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.timetable_substitutions TO anon;
GRANT ALL ON TABLE public.timetable_substitutions TO authenticated;
GRANT ALL ON TABLE public.timetable_substitutions TO service_role;


--
-- Name: TABLE transport_fee; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.transport_fee TO anon;
GRANT ALL ON TABLE public.transport_fee TO authenticated;
GRANT ALL ON TABLE public.transport_fee TO service_role;


--
-- Name: TABLE transport_fee_payments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.transport_fee_payments TO anon;
GRANT ALL ON TABLE public.transport_fee_payments TO authenticated;
GRANT ALL ON TABLE public.transport_fee_payments TO service_role;


--
-- Name: TABLE transport_import_batches; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.transport_import_batches TO anon;
GRANT ALL ON TABLE public.transport_import_batches TO authenticated;
GRANT ALL ON TABLE public.transport_import_batches TO service_role;


--
-- Name: TABLE transport_import_rows; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.transport_import_rows TO anon;
GRANT ALL ON TABLE public.transport_import_rows TO authenticated;
GRANT ALL ON TABLE public.transport_import_rows TO service_role;


--
-- Name: TABLE transport_routes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.transport_routes TO anon;
GRANT ALL ON TABLE public.transport_routes TO authenticated;
GRANT ALL ON TABLE public.transport_routes TO service_role;


--
-- Name: TABLE transport_safety_incidents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.transport_safety_incidents TO anon;
GRANT ALL ON TABLE public.transport_safety_incidents TO authenticated;
GRANT ALL ON TABLE public.transport_safety_incidents TO service_role;


--
-- Name: TABLE transport_stops; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.transport_stops TO anon;
GRANT ALL ON TABLE public.transport_stops TO authenticated;
GRANT ALL ON TABLE public.transport_stops TO service_role;


--
-- Name: TABLE trip_stop_status; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.trip_stop_status TO anon;
GRANT ALL ON TABLE public.trip_stop_status TO authenticated;
GRANT ALL ON TABLE public.trip_stop_status TO service_role;


--
-- Name: TABLE trips; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.trips TO anon;
GRANT ALL ON TABLE public.trips TO authenticated;
GRANT ALL ON TABLE public.trips TO service_role;


--
-- Name: TABLE ui_route_permissions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ui_route_permissions TO anon;
GRANT ALL ON TABLE public.ui_route_permissions TO authenticated;
GRANT ALL ON TABLE public.ui_route_permissions TO service_role;


--
-- Name: TABLE user_access_contexts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_access_contexts TO anon;
GRANT ALL ON TABLE public.user_access_contexts TO authenticated;
GRANT ALL ON TABLE public.user_access_contexts TO service_role;


--
-- Name: TABLE user_active_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_active_sessions TO anon;
GRANT ALL ON TABLE public.user_active_sessions TO authenticated;
GRANT ALL ON TABLE public.user_active_sessions TO service_role;


--
-- Name: TABLE user_devices; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_devices TO anon;
GRANT ALL ON TABLE public.user_devices TO authenticated;
GRANT ALL ON TABLE public.user_devices TO service_role;


--
-- Name: TABLE user_roles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_roles TO anon;
GRANT ALL ON TABLE public.user_roles TO authenticated;
GRANT ALL ON TABLE public.user_roles TO service_role;


--
-- Name: TABLE user_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_settings TO anon;
GRANT ALL ON TABLE public.user_settings TO authenticated;
GRANT ALL ON TABLE public.user_settings TO service_role;


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.users TO anon;
GRANT ALL ON TABLE public.users TO authenticated;
GRANT ALL ON TABLE public.users TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--


