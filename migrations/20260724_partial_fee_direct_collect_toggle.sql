-- School-wide toggle: let the accounts department collect a partial term-fee
-- DIRECTLY, without raising an approval request to admin.
-- This is a sub-option of partial_fee_payment_enabled and defaults OFF, so
-- existing schools keep the "every partial needs admin approval" behaviour.

BEGIN;

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS partial_fee_direct_collect_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE schools
  ALTER COLUMN partial_fee_direct_collect_enabled SET DEFAULT false;

COMMIT;
