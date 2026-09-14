-- Migration: 20260914_v443_make_all_features_available.sql
-- Description: Make every school active on Enterprise AI / Premium tier and make every feature available across all schools.

BEGIN;

-- 1. Default column in saas_subscriptions to enterprise
ALTER TABLE public.saas_subscriptions
  ALTER COLUMN plan_id SET DEFAULT 'enterprise';

-- 2. Upsert all schools to enterprise active subscriptions
INSERT INTO public.saas_subscriptions (school_id, plan_name, subscription_status, plan_id, updated_at)
SELECT id, 'NexSyrus Enterprise AI', 'active', 'enterprise', now()
FROM public.schools
ON CONFLICT (school_id) DO UPDATE SET
  plan_id = 'enterprise',
  plan_name = 'NexSyrus Enterprise AI',
  subscription_status = 'active',
  updated_at = now();

-- 3. Open up all features: rollout_strategy = 'ALL', is_beta = false, is_maintenance = false, is_active = true
UPDATE public.features
SET rollout_strategy = 'ALL',
    is_beta = false,
    is_maintenance = false,
    is_active = true,
    updated_at = now();

-- 4. Enable all features in plan_features for all plans
INSERT INTO public.plan_features (plan_id, feature_key, enabled)
SELECT p.id, f.key, true
FROM public.plans p
CROSS JOIN public.features f
ON CONFLICT (plan_id, feature_key) DO UPDATE SET enabled = true;

COMMIT;
