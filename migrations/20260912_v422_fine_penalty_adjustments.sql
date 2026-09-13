-- Migration: 20260912_v422_fine_penalty_adjustments.sql
-- Production-ready Fine, Penalty & Adjustment Management Subsystem for SchoolIMS

BEGIN;

-- 1. Sequence helper for School-scoped Fine Numbers
CREATE OR REPLACE FUNCTION public.get_next_fine_no(p_school_id INTEGER)
RETURNS TEXT AS $$
DECLARE
  v_seq_name TEXT := 'fine_no_seq_school_' || p_school_id;
  v_year TEXT := TO_CHAR(CURRENT_DATE, 'YYYY');
  v_val BIGINT;
BEGIN
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I START 1001', v_seq_name);
  EXECUTE format('SELECT nextval(%L)', v_seq_name) INTO v_val;
  RETURN 'FIN-' || v_year || '-' || LPAD(v_val::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- 2. Fine Categories
CREATE TABLE IF NOT EXISTS public.fine_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(50) NOT NULL,
    description TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fine_categories_school_active
    ON public.fine_categories(school_id, active, display_order ASC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fine_categories_school_code
    ON public.fine_categories(school_id, LOWER(code));
CREATE UNIQUE INDEX IF NOT EXISTS uq_fine_categories_school_name
    ON public.fine_categories(school_id, LOWER(name));

-- 3. Fine Policies
CREATE TABLE IF NOT EXISTS public.fine_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES public.fine_categories(id) ON DELETE RESTRICT,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    calculation_type VARCHAR(30) NOT NULL,
    fixed_amount DECIMAL(12,2),
    per_day_amount DECIMAL(12,2),
    percentage DECIMAL(5,2),
    minimum_amount DECIMAL(12,2),
    maximum_amount DECIMAL(12,2),
    grace_days INTEGER NOT NULL DEFAULT 0,
    auto_apply BOOLEAN NOT NULL DEFAULT FALSE,
    approval_required BOOLEAN NOT NULL DEFAULT FALSE,
    approval_threshold_amount DECIMAL(12,2),
    applicable_module VARCHAR(50) NOT NULL DEFAULT 'GENERAL',
    effective_from DATE,
    effective_until DATE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_fine_policies_calc_type CHECK (
        calculation_type IN ('FIXED', 'PER_DAY', 'PERCENTAGE', 'VARIABLE')
    ),
    CONSTRAINT chk_fine_policies_grace_days CHECK (grace_days >= 0),
    CONSTRAINT chk_fine_policies_amounts CHECK (
        (fixed_amount IS NULL OR fixed_amount >= 0) AND
        (per_day_amount IS NULL OR per_day_amount >= 0) AND
        (percentage IS NULL OR (percentage >= 0 AND percentage <= 100)) AND
        (minimum_amount IS NULL OR minimum_amount >= 0) AND
        (maximum_amount IS NULL OR maximum_amount >= 0) AND
        (minimum_amount IS NULL OR maximum_amount IS NULL OR maximum_amount >= minimum_amount)
    )
);

CREATE INDEX IF NOT EXISTS idx_fine_policies_school_category
    ON public.fine_policies(school_id, category_id, active);
CREATE INDEX IF NOT EXISTS idx_fine_policies_auto_apply
    ON public.fine_policies(school_id, auto_apply, active)
    WHERE auto_apply = TRUE AND active = TRUE;

-- 4. Fines (Core Financial Transaction)
CREATE TABLE IF NOT EXISTS public.fines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fine_no VARCHAR(50) NOT NULL,
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE RESTRICT,
    academic_year_id UUID REFERENCES public.academic_years(id) ON DELETE SET NULL,
    category_id UUID NOT NULL REFERENCES public.fine_categories(id) ON DELETE RESTRICT,
    policy_id UUID REFERENCES public.fine_policies(id) ON DELETE SET NULL,
    source_type VARCHAR(50) NOT NULL DEFAULT 'MANUAL',
    source_id VARCHAR(100),
    idempotency_key VARCHAR(255),
    reason TEXT NOT NULL,
    internal_note TEXT,
    calculation_details JSONB,
    requested_amount DECIMAL(12,2) NOT NULL,
    approved_amount DECIMAL(12,2) NOT NULL,
    original_amount DECIMAL(12,2) NOT NULL,
    adjustment_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    waived_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    outstanding_amount DECIMAL(12,2) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    requested_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    requested_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    posted_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT,
    cancelled_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_fines_status CHECK (
        status IN (
            'DRAFT',
            'PENDING_APPROVAL',
            'APPROVED',
            'POSTED',
            'PARTIALLY_PAID',
            'PAID',
            'WAIVED',
            'PARTIALLY_WAIVED',
            'CANCELLED',
            'REJECTED',
            'DISPUTED'
        )
    ),
    CONSTRAINT chk_fines_amounts CHECK (
        requested_amount >= 0 AND
        approved_amount >= 0 AND
        original_amount >= 0 AND
        waived_amount >= 0 AND
        paid_amount >= 0 AND
        outstanding_amount >= 0 AND
        (paid_amount + waived_amount <= original_amount + adjustment_amount + 0.01)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fines_school_fine_no
    ON public.fines(school_id, fine_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fines_school_idempotency_key
    ON public.fines(school_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fines_school_student
    ON public.fines(school_id, student_id, status);
CREATE INDEX IF NOT EXISTS idx_fines_school_status_created
    ON public.fines(school_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fines_school_category
    ON public.fines(school_id, category_id);
CREATE INDEX IF NOT EXISTS idx_fines_source
    ON public.fines(school_id, source_type, source_id);

-- 5. Fine Waivers
CREATE TABLE IF NOT EXISTS public.fine_waivers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    fine_id UUID NOT NULL REFERENCES public.fines(id) ON DELETE RESTRICT,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE RESTRICT,
    amount DECIMAL(12,2) NOT NULL,
    reason VARCHAR(100) NOT NULL,
    notes TEXT,
    receipt_no VARCHAR(50),
    waived_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_fine_waivers_amount CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_fine_waivers_school_fine
    ON public.fine_waivers(school_id, fine_id);
CREATE INDEX IF NOT EXISTS idx_fine_waivers_school_student
    ON public.fine_waivers(school_id, student_id);

-- 6. Fine Disputes
CREATE TABLE IF NOT EXISTS public.fine_disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    fine_id UUID NOT NULL REFERENCES public.fines(id) ON DELETE RESTRICT,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE RESTRICT,
    reason_type VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'OPEN',
    submitted_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    reviewed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    resolution_note TEXT,
    resolution_action VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    CONSTRAINT chk_fine_disputes_status CHECK (
        status IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED_ACCEPTED', 'RESOLVED_REJECTED')
    )
);

CREATE INDEX IF NOT EXISTS idx_fine_disputes_school_status
    ON public.fine_disputes(school_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fine_disputes_fine_id
    ON public.fine_disputes(fine_id);

-- 7. Fine Payments
CREATE TABLE IF NOT EXISTS public.fine_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    fine_id UUID NOT NULL REFERENCES public.fines(id) ON DELETE RESTRICT,
    receipt_id UUID REFERENCES public.receipts(id) ON DELETE SET NULL,
    amount DECIMAL(12,2) NOT NULL,
    payment_method VARCHAR(30) NOT NULL,
    transaction_ref VARCHAR(100) NOT NULL,
    receipt_no VARCHAR(50) NOT NULL,
    received_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    remarks TEXT,
    paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_fine_payments_amount CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS idx_fine_payments_school_fine
    ON public.fine_payments(school_id, fine_id);
CREATE INDEX IF NOT EXISTS idx_fine_payments_receipt
    ON public.fine_payments(school_id, receipt_id);
CREATE INDEX IF NOT EXISTS idx_fine_payments_paid_at
    ON public.fine_payments(school_id, paid_at DESC);

-- 8. Fine Attachments / Evidence
CREATE TABLE IF NOT EXISTS public.fine_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    fine_id UUID NOT NULL REFERENCES public.fines(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    file_url TEXT NOT NULL,
    file_type VARCHAR(100),
    file_size INTEGER,
    uploaded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fine_attachments_fine_id
    ON public.fine_attachments(school_id, fine_id);

-- 9. Seed Standard Categories & Default Policies for All Active Schools
DO $$
DECLARE
    r_school RECORD;
    v_late_fee_cat_id UUID;
    v_lib_cat_id UUID;
    v_id_cat_id UUID;
    v_prop_cat_id UUID;
    v_trans_cat_id UUID;
BEGIN
    FOR r_school IN SELECT id FROM public.schools WHERE is_active = TRUE LOOP
        -- Late Fee Category
        INSERT INTO public.fine_categories (school_id, name, code, description, display_order)
        VALUES (r_school.id, 'Late Fee', 'LATE_FEE', 'Automated and manual fees for delayed fee payments', 1)
        ON CONFLICT (school_id, LOWER(code)) DO UPDATE SET updated_at = now()
        RETURNING id INTO v_late_fee_cat_id;

        -- Library Fine Category
        INSERT INTO public.fine_categories (school_id, name, code, description, display_order)
        VALUES (r_school.id, 'Library', 'LIBRARY', 'Penalties for overdue or damaged library books', 2)
        ON CONFLICT (school_id, LOWER(code)) DO UPDATE SET updated_at = now()
        RETURNING id INTO v_lib_cat_id;

        -- ID Card Replacement
        INSERT INTO public.fine_categories (school_id, name, code, description, display_order)
        VALUES (r_school.id, 'ID Card Replacement', 'ID_CARD', 'Fee for issuing duplicate or replacement student ID card', 3)
        ON CONFLICT (school_id, LOWER(code)) DO UPDATE SET updated_at = now()
        RETURNING id INTO v_id_cat_id;

        -- Property Damage
        INSERT INTO public.fine_categories (school_id, name, code, description, display_order)
        VALUES (r_school.id, 'Property Damage', 'PROPERTY_DAMAGE', 'Charges for damage to classroom, campus, or lab infrastructure', 4)
        ON CONFLICT (school_id, LOWER(code)) DO UPDATE SET updated_at = now()
        RETURNING id INTO v_prop_cat_id;

        -- Transport Fine
        INSERT INTO public.fine_categories (school_id, name, code, description, display_order)
        VALUES (r_school.id, 'Transport', 'TRANSPORT', 'Penalties related to transport misconduct or unauthorized bus usage', 5)
        ON CONFLICT (school_id, LOWER(code)) DO UPDATE SET updated_at = now()
        RETURNING id INTO v_trans_cat_id;

        -- Additional standard categories
        INSERT INTO public.fine_categories (school_id, name, code, description, display_order)
        VALUES
            (r_school.id, 'Laboratory Damage', 'LAB_DAMAGE', 'Damage to science/computer lab equipment', 6),
            (r_school.id, 'Examination', 'EXAMINATION', 'Late examination form submission or exam misconduct penalty', 7),
            (r_school.id, 'Hostel', 'HOSTEL', 'Hostel curfew violations, room property damage or late hostel fee', 8),
            (r_school.id, 'Documents / Certificates', 'DOCUMENTS', 'Charge for re-issuance of lost certificates or marksheets', 9),
            (r_school.id, 'Uniform / Material', 'UNIFORM', 'Missing uniform or unreturned school materials', 10),
            (r_school.id, 'Discipline', 'DISCIPLINE', 'Disciplinary fine issued by school administration', 11),
            (r_school.id, 'Custom / Other', 'CUSTOM', 'Miscellaneous school penalty or adjustment', 12)
        ON CONFLICT (school_id, LOWER(code)) DO NOTHING;

        -- Default Standard Late Fee Policy (Rs 10/day, 5 grace days, Rs 300 max cap)
        IF v_late_fee_cat_id IS NOT NULL THEN
            INSERT INTO public.fine_policies (
                school_id, category_id, name, description,
                calculation_type, per_day_amount, maximum_amount, grace_days,
                auto_apply, approval_required, applicable_module, active
            ) VALUES (
                r_school.id, v_late_fee_cat_id, 'Standard Fee Late Charge',
                '₹10 per day charged after 5-day grace period, up to a maximum of ₹300',
                'PER_DAY', 10.00, 300.00, 5,
                TRUE, FALSE, 'FEE_INVOICE', TRUE
            )
            ON CONFLICT DO NOTHING;
        END IF;

        -- Default ID Card Replacement Policy (Fixed Rs 100)
        IF v_id_cat_id IS NOT NULL THEN
            INSERT INTO public.fine_policies (
                school_id, category_id, name, description,
                calculation_type, fixed_amount,
                auto_apply, approval_required, applicable_module, active
            ) VALUES (
                r_school.id, v_id_cat_id, 'ID Card Replacement Fee',
                'Fixed fee of ₹100 for re-issuing a lost student ID card',
                'FIXED', 100.00,
                FALSE, FALSE, 'ID_CARD', TRUE
            )
            ON CONFLICT DO NOTHING;
        END IF;

        -- Default Property Damage Policy (Variable, requires Admin approval)
        IF v_prop_cat_id IS NOT NULL THEN
            INSERT INTO public.fine_policies (
                school_id, category_id, name, description,
                calculation_type,
                auto_apply, approval_required, applicable_module, active
            ) VALUES (
                r_school.id, v_prop_cat_id, 'Property Damage Assessment',
                'Variable penalty assessed based on damage evidence, requires Admin approval',
                'VARIABLE',
                FALSE, TRUE, 'DISCIPLINE', TRUE
            )
            ON CONFLICT DO NOTHING;
        END IF;
    END LOOP;
END $$;

COMMIT;
