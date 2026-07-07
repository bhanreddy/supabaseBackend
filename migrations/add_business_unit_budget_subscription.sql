-- Subscription price (INR) and plan tier per business unit
ALTER TABLE public.business_units
  ADD COLUMN IF NOT EXISTS subscription_price numeric,
  ADD COLUMN IF NOT EXISTS subscription_plan text;

COMMENT ON COLUMN public.business_units.subscription_price IS 'Optional subscription price (e.g. INR)';
COMMENT ON COLUMN public.business_units.subscription_plan IS 'Optional plan label: FREE, STARTER, PRO, ENTERPRISE, etc.';
