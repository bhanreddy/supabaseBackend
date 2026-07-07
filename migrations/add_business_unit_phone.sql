-- Contact phone for payment follow-up (e.g. subscription overdue)
ALTER TABLE public.business_units
  ADD COLUMN IF NOT EXISTS phone text;

COMMENT ON COLUMN public.business_units.phone IS 'Contact number for calls when subscription or payment needs follow-up';
