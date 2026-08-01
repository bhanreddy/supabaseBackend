-- Allow the shared adjustment ledger to target either a tuition fee line or a
-- student's stop-derived transport fee. Exactly one target must be present.

ALTER TABLE public.fee_adjustments
  ALTER COLUMN student_fee_id DROP NOT NULL;

ALTER TABLE public.fee_adjustments
  ADD COLUMN IF NOT EXISTS transport_fee_id UUID
  REFERENCES public.transport_fee(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_fee_adjustments_transport_target
  ON public.fee_adjustments(school_id, student_id, transport_fee_id)
  WHERE transport_fee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transport_fee_payments_school_paid_at
  ON public.transport_fee_payments(school_id, paid_at DESC);

CREATE INDEX IF NOT EXISTS idx_transport_fee_payments_collector_paid_at
  ON public.transport_fee_payments(school_id, received_by, paid_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_fee_adjustments_single_target'
      AND conrelid = 'public.fee_adjustments'::regclass
  ) THEN
    ALTER TABLE public.fee_adjustments
      ADD CONSTRAINT chk_fee_adjustments_single_target
      CHECK (num_nonnulls(student_fee_id, transport_fee_id) = 1);
  END IF;
END $$;
