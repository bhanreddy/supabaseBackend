-- Was "budget_amount"; this column stores the subscription plan price (e.g. INR).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'business_units' AND column_name = 'budget_amount'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'business_units' AND column_name = 'subscription_price'
  ) THEN
    ALTER TABLE public.business_units RENAME COLUMN budget_amount TO subscription_price;
  END IF;
END $$;

-- If table was created without budget_amount, add subscription_price only
ALTER TABLE public.business_units
  ADD COLUMN IF NOT EXISTS subscription_price numeric;

COMMENT ON COLUMN public.business_units.subscription_price IS 'Optional subscription price for this unit (e.g. INR per billing period)';
