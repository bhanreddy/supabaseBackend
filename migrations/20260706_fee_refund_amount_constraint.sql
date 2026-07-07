-- ============================================================================
-- Allow refunds to actually post.
-- ----------------------------------------------------------------------------
-- Previously fee_transactions had two mutually-exclusive constraints for a
-- refund row (refund_of IS NOT NULL):
--   chk_transaction_amount       CHECK (amount > 0)
--   chk_refund_must_be_negative  CHECK (refund_of IS NULL OR amount < 0)
-- ...so a refund could never be inserted. This makes payments strictly positive
-- and refunds strictly negative, which the refund route (POST /api/v1/refunds)
-- and the analytics net-collection math both rely on.
--
-- Safe to run on existing data: all existing rows are payments (amount > 0,
-- refund_of NULL) and satisfy the new predicate.
-- ============================================================================

BEGIN;

ALTER TABLE fee_transactions DROP CONSTRAINT IF EXISTS chk_transaction_amount;
ALTER TABLE fee_transactions
  ADD CONSTRAINT chk_transaction_amount
  CHECK ( (refund_of IS NULL AND amount > 0) OR (refund_of IS NOT NULL AND amount < 0) );

ALTER TABLE fee_transactions DROP CONSTRAINT IF EXISTS chk_refund_must_be_negative;
ALTER TABLE fee_transactions
  ADD CONSTRAINT chk_refund_must_be_negative
  CHECK (refund_of IS NULL OR amount < 0);

COMMIT;
