-- Accountant-requested, admin-approved transport fee payment deletion.
-- Mirror tuition: keep the ledger append-only with a negative reversal whose
-- refund_of points at the original transport_fee_payments row.

BEGIN;

ALTER TABLE public.transport_fee_payments
  ADD COLUMN IF NOT EXISTS refund_of UUID REFERENCES public.transport_fee_payments(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_transport_fee_payments_refund_of
  ON public.transport_fee_payments (school_id, refund_of)
  WHERE refund_of IS NOT NULL;

ALTER TABLE public.transport_fee_payments
  DROP CONSTRAINT IF EXISTS chk_transport_payment_amount;

ALTER TABLE public.transport_fee_payments
  ADD CONSTRAINT chk_transport_payment_amount
  CHECK (
    (refund_of IS NULL AND amount > 0)
    OR (refund_of IS NOT NULL AND amount < 0)
  );

COMMIT;
