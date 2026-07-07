-- ============================================================
-- Migration: Create founder-console base tables & analytics views
-- Fixes: "Could not find the table in the schema cache" warnings
-- ============================================================

-- ── 1. founders ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.founders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  email       text,
  full_name   text,
  role        text NOT NULL DEFAULT 'FOUNDER',   -- FOUNDER | APPROVER
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 2. business_units ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.business_units (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  code        text,
  subscription_price numeric,
  subscription_plan  text,
  phone       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 3. collections ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.collections (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id        uuid REFERENCES public.business_units(id),
  amount                  numeric NOT NULL DEFAULT 0,
  month                   integer NOT NULL,
  year                    integer NOT NULL,
  payment_mode            text NOT NULL DEFAULT 'CASH',  -- CASH|UPI|BANK|CHEQUE|OTHER
  status                  text NOT NULL DEFAULT 'PENDING', -- PENDING|APPROVED|REJECTED
  notes                   text,
  created_by_founder_id   uuid REFERENCES public.founders(id),
  approved_by_founder_id  uuid REFERENCES public.founders(id),
  rejection_reason        text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- ── 4. enquiries ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.enquiries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text,
  email       text,
  phone       text,
  status      text NOT NULL DEFAULT 'NEW',  -- NEW|CONTACTED|QUALIFIED|CLOSED|REJECTED
  source      text,
  category    text,
  assigned_to uuid,
  deal_value  numeric,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 5. activity_logs ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  action      text NOT NULL,
  actor_id    uuid,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 6. settings ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.settings (
  key   text PRIMARY KEY,
  value jsonb
);

-- ── Add missing columns to expenses if they don't exist ──────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='expenses' AND column_name='created_by_founder_id') THEN
    ALTER TABLE public.expenses ADD COLUMN created_by_founder_id uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='expenses' AND column_name='approved_by_founder_id') THEN
    ALTER TABLE public.expenses ADD COLUMN approved_by_founder_id uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='expenses' AND column_name='rejection_reason') THEN
    ALTER TABLE public.expenses ADD COLUMN rejection_reason text;
  END IF;
END $$;

-- ============================================================
-- ANALYTICS VIEWS
-- ============================================================

-- ── monthly_expense_summary_v2 ───────────────────────────────
CREATE OR REPLACE VIEW public.monthly_expense_summary_v2 AS
SELECT
  EXTRACT(YEAR  FROM created_at)::int  AS year,
  EXTRACT(MONTH FROM created_at)::int  AS month,
  COALESCE(SUM(amount), 0)             AS total_amount,
  COUNT(*)                              AS count
FROM public.expenses
WHERE status = 'APPROVED'
GROUP BY year, month
ORDER BY year, month;

-- ── monthly_income_summary ───────────────────────────────────
CREATE OR REPLACE VIEW public.monthly_income_summary AS
SELECT
  year,
  month,
  COALESCE(SUM(amount), 0) AS total_amount,
  COUNT(*)                  AS count
FROM public.collections
WHERE status = 'APPROVED'
GROUP BY year, month
ORDER BY year, month;

-- ── monthly_enquiry_summary ──────────────────────────────────
CREATE OR REPLACE VIEW public.monthly_enquiry_summary AS
SELECT
  EXTRACT(YEAR  FROM created_at)::int  AS year,
  EXTRACT(MONTH FROM created_at)::int  AS month,
  COUNT(*)                              AS total_enquiries,
  COUNT(*) FILTER (WHERE status = 'CLOSED') AS closed_count
FROM public.enquiries
GROUP BY year, month
ORDER BY year, month;

-- ── monthly_closed_deals ─────────────────────────────────────
CREATE OR REPLACE VIEW public.monthly_closed_deals AS
SELECT
  EXTRACT(YEAR  FROM updated_at)::int  AS year,
  EXTRACT(MONTH FROM updated_at)::int  AS month,
  COUNT(*)                              AS count,
  COALESCE(SUM(deal_value), 0)          AS total_deal_value
FROM public.enquiries
WHERE status = 'CLOSED'
GROUP BY year, month
ORDER BY year, month;

-- ── conversion_rate ──────────────────────────────────────────
CREATE OR REPLACE VIEW public.conversion_rate AS
SELECT
  CASE
    WHEN COUNT(*) = 0 THEN 0
    ELSE ROUND(
      (COUNT(*) FILTER (WHERE status = 'CLOSED'))::numeric
      / COUNT(*)::numeric * 100, 2
    )
  END AS conversion_rate
FROM public.enquiries;

-- ── cost_per_lead ────────────────────────────────────────────
CREATE OR REPLACE VIEW public.cost_per_lead AS
SELECT
  CASE
    WHEN (SELECT COUNT(*) FROM public.enquiries) = 0 THEN 0
    ELSE ROUND(
      (SELECT COALESCE(SUM(amount), 0) FROM public.expenses WHERE status = 'APPROVED' AND category = 'MARKETING')
      / GREATEST((SELECT COUNT(*) FROM public.enquiries), 1)::numeric,
      2
    )
  END AS cost_per_lead;

-- ── pending_metrics_summary ──────────────────────────────────
CREATE OR REPLACE VIEW public.pending_metrics_summary AS
SELECT
  (SELECT COALESCE(SUM(amount), 0) FROM public.collections WHERE status = 'APPROVED')  AS approved_income,
  (SELECT COALESCE(SUM(amount), 0) FROM public.collections WHERE status = 'PENDING')   AS pending_collections,
  (SELECT COALESCE(SUM(amount), 0) FROM public.expenses    WHERE status = 'APPROVED')  AS approved_expenses,
  (SELECT COALESCE(SUM(amount), 0) FROM public.collections WHERE status = 'APPROVED')
    - (SELECT COALESCE(SUM(amount), 0) FROM public.expenses WHERE status = 'APPROVED') AS net_profit;

-- ── Disable RLS on new tables (superAdmin uses service role / anon key) ──
ALTER TABLE public.founders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collections   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enquiries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings      ENABLE ROW LEVEL SECURITY;

-- Allow anon/authenticated full access (the superAdmin app uses anon key)
CREATE POLICY "Allow all on founders"       ON public.founders       FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on business_units" ON public.business_units FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on collections"    ON public.collections    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on enquiries"      ON public.enquiries      FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on activity_logs"  ON public.activity_logs  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on settings"       ON public.settings       FOR ALL USING (true) WITH CHECK (true);
