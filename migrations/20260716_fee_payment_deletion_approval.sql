-- Accountant-requested, admin-approved fee payment deletion.
-- Financial transactions remain append-only: an approved "deletion" is
-- represented by an equal negative transaction whose refund_of points at the
-- original payment.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_fee_payment_deletion_scope
  ON approval_requests (school_id, type, ((payload->>'scope_key')))
  WHERE type = 'fee_payment_deletion'
    AND status IN ('PENDING', 'APPROVED')
    AND payload->>'consumed_at' IS NULL;

CREATE INDEX IF NOT EXISTS idx_fee_transactions_refund_of
  ON fee_transactions (school_id, refund_of)
  WHERE refund_of IS NOT NULL;

-- The previous function left a fully-reversed fee marked paid/partial when
-- amount_paid returned to zero. Recompute every state deterministically.
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

COMMIT;
