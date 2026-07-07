-- ============================================================
-- Migration: Transport Fee (per stop, per academic year)
-- Date: 2026-06-06
-- Reuses existing transport_routes, transport_stops, student_transport.
-- Fee is derived from stop assignment — never stored per student.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE transport_billing_cycle AS ENUM ('monthly', 'quarterly', 'term', 'annual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 1. Stop-level fee schedule (one row per route+stop+year)
CREATE TABLE IF NOT EXISTS public.transport_fee (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    route_id UUID NOT NULL REFERENCES public.transport_routes(id) ON DELETE RESTRICT,
    stop_id UUID NOT NULL REFERENCES public.transport_stops(id) ON DELETE RESTRICT,
    academic_year TEXT NOT NULL,
    fee_amount DECIMAL(12,2) NOT NULL,
    billing_cycle transport_billing_cycle NOT NULL DEFAULT 'term',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_transport_fee_amount CHECK (fee_amount >= 0),
    CONSTRAINT uq_transport_fee_stop_year UNIQUE (school_id, route_id, stop_id, academic_year)
);

CREATE INDEX IF NOT EXISTS idx_transport_fee_school_id
  ON public.transport_fee(school_id);
CREATE INDEX IF NOT EXISTS idx_transport_fee_stop_year
  ON public.transport_fee(school_id, stop_id, academic_year)
  WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS trg_transport_fee_updated ON public.transport_fee;
CREATE TRIGGER trg_transport_fee_updated
  BEFORE UPDATE ON public.transport_fee
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

-- 2. Payment ledger (per student per year — fee amount itself is derived from stop)
CREATE TABLE IF NOT EXISTS public.transport_fee_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE RESTRICT,
    academic_year TEXT NOT NULL,
    transport_fee_id UUID REFERENCES public.transport_fee(id) ON DELETE SET NULL,
    amount DECIMAL(12,2) NOT NULL,
    payment_method payment_method_enum NOT NULL,
    transaction_ref VARCHAR(100) NOT NULL,
    received_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    remarks TEXT,
    paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_transport_payment_amount CHECK (amount > 0),
    CONSTRAINT uq_transport_fee_payments_tx_ref UNIQUE (school_id, transaction_ref)
);

CREATE INDEX IF NOT EXISTS idx_transport_fee_payments_student_year
  ON public.transport_fee_payments(school_id, student_id, academic_year);

-- 3. Receipt tagging for transport revenue reports
ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS fee_type VARCHAR(30) NOT NULL DEFAULT 'tuition';

ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS transport_payment_id UUID
  REFERENCES public.transport_fee_payments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_receipts_fee_type
  ON public.receipts(school_id, fee_type);

ALTER TABLE public.transport_fee ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transport_fee_payments ENABLE ROW LEVEL SECURITY;
