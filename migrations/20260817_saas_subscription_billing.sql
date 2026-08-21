-- NexSyrus SaaS subscription billing, stored in the SchoolIMS cluster database.
-- SchoolIMS Backend is the runtime owner; it does not call SuperAdmin Backend.

CREATE TABLE IF NOT EXISTS saas_subscriptions (
  school_id INTEGER PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
  plan_name TEXT NOT NULL DEFAULT 'NexSyrus School ERP',
  billing_cycle TEXT NOT NULL DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly', 'quarterly', 'annual', 'custom')),
  subscription_status TEXT NOT NULL DEFAULT 'active'
    CHECK (subscription_status IN ('trial', 'active', 'past_due', 'paused', 'cancelled')),
  monthly_fee NUMERIC(12,2),
  current_period_start DATE,
  current_period_end DATE,
  next_due_date DATE,
  amount_due NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount_due >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  reminder_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  reminder_message VARCHAR(280),
  last_paid_at TIMESTAMPTZ,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saas_subscription_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  merchant_order_id VARCHAR(63) UNIQUE NOT NULL,
  provider_order_id TEXT,
  initiated_by UUID,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  gateway TEXT NOT NULL DEFAULT 'phonepe' CHECK (gateway = 'phonepe'),
  status TEXT NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'pending', 'completed', 'failed', 'expired')),
  checkout_url TEXT,
  provider_state TEXT,
  provider_payload JSONB,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saas_subscription_payments_school
  ON saas_subscription_payments(school_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saas_subscription_payments_status
  ON saas_subscription_payments(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_saas_subscription_payments_provider_order
  ON saas_subscription_payments(provider_order_id)
  WHERE provider_order_id IS NOT NULL;

-- SuperAdmin mirrors an issued central receipt into this table through the
-- cluster service-role connection. The immutable snapshot renders locally.
CREATE TABLE IF NOT EXISTS saas_subscription_receipts (
  id UUID PRIMARY KEY,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  document_number TEXT UNIQUE NOT NULL,
  financial_year TEXT NOT NULL,
  total_amount NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'cancelled')),
  document_payload JSONB NOT NULL,
  issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saas_subscription_receipts_school
  ON saas_subscription_receipts(school_id, issued_at DESC, created_at DESC);

-- Only the backend's database role and SuperAdmin's cluster service role may
-- access these records. No browser/mobile Supabase client receives a policy.
ALTER TABLE saas_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_subscription_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_subscription_receipts ENABLE ROW LEVEL SECURITY;
