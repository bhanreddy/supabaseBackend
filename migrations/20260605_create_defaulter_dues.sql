-- ============================================================
-- Migration: Defaulter Dues (Previous-Year Pending Fees)
-- Date: 2026-06-05
-- Description: Tables for tracking arrears from prior academic years,
--              arrears payment ledger, and receipt payment_type tagging.
-- ============================================================

-- 1. Enums
DO $$ BEGIN
  CREATE TYPE defaulter_due_source AS ENUM ('manual_legacy', 'carried_forward');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE defaulter_due_status AS ENUM ('pending', 'partially_paid', 'cleared');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE receipt_payment_type AS ENUM ('fee', 'arrears');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Helper: parse academic year code start year (e.g. "2024-25" → 2024)
CREATE OR REPLACE FUNCTION academic_year_start_year(p_code TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(NULLIF(split_part(p_code, '-', 1), '')::INTEGER, 0);
$$;

-- 3. defaulter_dues — one row per student per prior academic year
CREATE TABLE IF NOT EXISTS public.defaulter_dues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE RESTRICT,
    due_academic_year TEXT NOT NULL,
    original_amount DECIMAL(12,2) NOT NULL,
    paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    balance DECIMAL(12,2) NOT NULL DEFAULT 0,
    source defaulter_due_source NOT NULL,
    status defaulter_due_status NOT NULL DEFAULT 'pending',
    remarks TEXT,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_defaulter_original_nonneg CHECK (original_amount >= 0),
    CONSTRAINT chk_defaulter_paid_nonneg CHECK (paid_amount >= 0),
    CONSTRAINT chk_defaulter_balance_nonneg CHECK (balance >= 0),
    CONSTRAINT uq_defaulter_dues_student_year UNIQUE (school_id, student_id, due_academic_year)
);

CREATE INDEX IF NOT EXISTS idx_defaulter_dues_school_id
  ON public.defaulter_dues(school_id);
CREATE INDEX IF NOT EXISTS idx_defaulter_dues_student_id
  ON public.defaulter_dues(student_id);
CREATE INDEX IF NOT EXISTS idx_defaulter_dues_year
  ON public.defaulter_dues(school_id, due_academic_year);
CREATE INDEX IF NOT EXISTS idx_defaulter_dues_active_balance
  ON public.defaulter_dues(school_id, balance)
  WHERE deleted_at IS NULL AND balance > 0;

-- 4. Derive balance + status before write
CREATE OR REPLACE FUNCTION derive_defaulter_status(p_balance DECIMAL, p_paid DECIMAL)
RETURNS defaulter_due_status
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_balance <= 0 THEN 'cleared'::defaulter_due_status
    WHEN p_paid > 0 THEN 'partially_paid'::defaulter_due_status
    ELSE 'pending'::defaulter_due_status
  END;
$$;

CREATE OR REPLACE FUNCTION refresh_defaulter_due_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.balance := GREATEST(NEW.original_amount - NEW.paid_amount, 0);
  NEW.status := derive_defaulter_status(NEW.balance, NEW.paid_amount);
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_defaulter_due_balance ON public.defaulter_dues;
CREATE TRIGGER trg_defaulter_due_balance
  BEFORE INSERT OR UPDATE OF original_amount, paid_amount
  ON public.defaulter_dues
  FOR EACH ROW
  EXECUTE FUNCTION refresh_defaulter_due_balance();

-- 5. defaulter_payments — arrears collection ledger
CREATE TABLE IF NOT EXISTS public.defaulter_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    defaulter_due_id UUID NOT NULL REFERENCES public.defaulter_dues(id) ON DELETE RESTRICT,
    amount DECIMAL(12,2) NOT NULL,
    payment_method payment_method_enum NOT NULL,
    transaction_ref VARCHAR(100) NOT NULL,
    received_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    remarks TEXT,
    paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_defaulter_payment_amount CHECK (amount > 0),
    CONSTRAINT uq_defaulter_payments_tx_ref UNIQUE (school_id, transaction_ref)
);

CREATE INDEX IF NOT EXISTS idx_defaulter_payments_school_id
  ON public.defaulter_payments(school_id);
CREATE INDEX IF NOT EXISTS idx_defaulter_payments_due_id
  ON public.defaulter_payments(defaulter_due_id);

-- 6. Tag receipts so arrears recovery is separable in reports
ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS payment_type receipt_payment_type NOT NULL DEFAULT 'fee';

ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS defaulter_payment_id UUID
  REFERENCES public.defaulter_payments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_receipts_payment_type
  ON public.receipts(school_id, payment_type);

-- 7. RLS (service_role bypasses; authenticated reads scoped via backend)
ALTER TABLE public.defaulter_dues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.defaulter_payments ENABLE ROW LEVEL SECURITY;
