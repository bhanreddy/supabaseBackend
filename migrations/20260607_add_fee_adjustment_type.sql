-- Migration: Add adjustment_type to fee_adjustments (waive | add)
-- Non-breaking: existing rows default to 'waive' (historical waiver-only behavior)

ALTER TABLE public.fee_adjustments
  ADD COLUMN IF NOT EXISTS adjustment_type TEXT DEFAULT 'waive';

UPDATE public.fee_adjustments
SET adjustment_type = 'waive'
WHERE adjustment_type IS NULL;

ALTER TABLE public.fee_adjustments
  ALTER COLUMN adjustment_type SET DEFAULT 'waive',
  ALTER COLUMN adjustment_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_fee_adjustments_adjustment_type'
      AND conrelid = 'public.fee_adjustments'::regclass
  ) THEN
    ALTER TABLE public.fee_adjustments
      ADD CONSTRAINT chk_fee_adjustments_adjustment_type
      CHECK (adjustment_type IN ('waive', 'add'));
  END IF;
END $$;
