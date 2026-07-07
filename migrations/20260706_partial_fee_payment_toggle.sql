-- School-wide toggle: allow partial term-fee collection (with approval workflow).
-- Default ON for every school.

BEGIN;

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS partial_fee_payment_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE schools
  ALTER COLUMN partial_fee_payment_enabled SET DEFAULT true;

UPDATE schools
SET partial_fee_payment_enabled = true;

COMMIT;
