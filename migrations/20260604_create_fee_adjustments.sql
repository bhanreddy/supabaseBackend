-- Migration: Create fee_adjustments table and associated sequences/RLS

ALTER TABLE public.students ADD COLUMN IF NOT EXISTS auth_user_id uuid;

CREATE OR REPLACE FUNCTION public.student_id_for_session()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id
  FROM public.students s
  WHERE s.auth_user_id = auth.uid()
    AND s.deleted_at IS NULL
  LIMIT 1;
$$;

CREATE TABLE IF NOT EXISTS public.fee_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE RESTRICT,
    student_fee_id UUID NOT NULL REFERENCES public.student_fees(id) ON DELETE RESTRICT,
    fee_component VARCHAR(255) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    reason TEXT NOT NULL,
    receipt_no VARCHAR(50) NOT NULL,
    adjusted_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    adjusted_by_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_adj_amount CHECK (amount >= 0),
    CONSTRAINT uq_fee_adjustments_receipt_no UNIQUE (school_id, receipt_no)
);

CREATE INDEX IF NOT EXISTS idx_fee_adjustments_school_id ON public.fee_adjustments(school_id);
CREATE INDEX IF NOT EXISTS idx_fee_adjustments_student_id ON public.fee_adjustments(student_id);
CREATE INDEX IF NOT EXISTS idx_fee_adjustments_student_fee_id ON public.fee_adjustments(student_fee_id);

CREATE OR REPLACE FUNCTION public.get_next_adj_receipt_no(p_school_id INTEGER) RETURNS TEXT AS $$
DECLARE
  v_seq_name TEXT := 'adj_receipt_no_seq_school_' || p_school_id;
BEGIN
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I START 1', v_seq_name);
  RETURN 'ADJ-' || LPAD(NEXTVAL(v_seq_name)::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

ALTER TABLE public.fee_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fee_adjustments_select_own ON public.fee_adjustments;
CREATE POLICY fee_adjustments_select_own
  ON public.fee_adjustments
  FOR SELECT
  TO authenticated
  USING (
    student_id = public.student_id_for_session()
    AND school_id = (SELECT s.school_id FROM public.students s WHERE s.id = public.student_id_for_session() LIMIT 1)
  );

