-- ============================================================
-- Migration: 20260914_v440_universal_feature_access_gateway.sql
-- Description: Universal Feature Access Platform schema
-- Author: SchoolIMS Core Platform Architecture
-- ============================================================

BEGIN;

-- 1. SaaS Subscription Plans
CREATE TABLE IF NOT EXISTS public.plans (
  id             VARCHAR(32) PRIMARY KEY,
  name           TEXT        NOT NULL,
  tier_rank      INTEGER     NOT NULL UNIQUE,
  description    TEXT,
  price_monthly  NUMERIC(12, 2) NOT NULL DEFAULT 0,
  badge          TEXT,
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed Default Plans
INSERT INTO public.plans (id, name, tier_rank, description, price_monthly, badge, is_active)
VALUES 
  ('starter', 'NexSyrus Core', 1, 'Essential foundation: attendance, classes, basic notices', 0, 'Core', true),
  ('standard', 'NexSyrus Operations', 2, 'Full school operations: fees, transport, exams, staff payroll', 4999, 'Operations', true),
  ('premium', 'NexSyrus Intelligence', 3, 'Advanced analytics, OMR scanner, visitor security, academic planning', 8999, 'Intelligence', true),
  ('enterprise', 'NexSyrus Enterprise AI', 4, 'Full AI anecdote engine, custom reports, priority compute', 14999, 'Enterprise', true)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  tier_rank = EXCLUDED.tier_rank,
  description = EXCLUDED.description,
  badge = EXCLUDED.badge;

-- 2. Master Feature Registry
CREATE TABLE IF NOT EXISTS public.features (
  key              VARCHAR(64) PRIMARY KEY,
  name             TEXT        NOT NULL,
  description      TEXT,
  category         VARCHAR(32) NOT NULL DEFAULT 'operations',
  min_plan_tier    VARCHAR(32) REFERENCES public.plans(id) ON DELETE SET NULL,
  hero_archetype   VARCHAR(32) NOT NULL DEFAULT 'ORBIT',
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  is_beta          BOOLEAN     NOT NULL DEFAULT false,
  is_maintenance   BOOLEAN     NOT NULL DEFAULT false,
  rollout_strategy VARCHAR(32) NOT NULL DEFAULT 'ALL',
  metadata         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed Foundational Features across plans
INSERT INTO public.features (key, name, description, category, min_plan_tier, hero_archetype, is_active, is_beta, is_maintenance, rollout_strategy, metadata)
VALUES
  -- Core / Starter Features
  ('dashboard', 'School Dashboard', 'Unified administrative hub and daily telemetry overview', 'core', 'starter', 'ORBIT', true, false, false, 'ALL', '{"benefits":["Daily attendance summary","Pending actions list","Quick system navigation"]}'),
  ('student_management', 'Student Records', 'Comprehensive student profiles, enrollments, and documents', 'academics', 'starter', 'GRID', true, false, false, 'ALL', '{"benefits":["Digital student profiles","Section and class allocations","Parent emergency contact info"]}'),
  ('attendance', 'Daily Attendance', 'Real-time morning and afternoon roll call tracking', 'operations', 'starter', 'PULSE', true, false, false, 'ALL', '{"benefits":["Twice-daily session tracking","Instant absentee alerts","Monthly attendance registers"]}'),
  ('timetable', 'Class Timetable', 'Dynamic scheduling and daily teacher substitutions', 'academics', 'starter', 'GRID', true, false, false, 'ALL', '{"benefits":["Automated schedule collision checking","Daily teacher substitution engine","Printable room schedules"]}'),
  ('diary', 'Smart Class Diary', 'Daily home assignments, parent notes, and remarks', 'academics', 'starter', 'ORBIT', true, false, false, 'ALL', '{"benefits":["Voice-assisted diary entries","Multilingual parent translation","Photo verification attachments"]}'),

  -- Standard Operations Features
  ('fees', 'Fee Management & Collections', 'Multi-mode student fee schedules, receipting, and dues tracking', 'finance', 'standard', 'NEXUS', true, false, false, 'ALL', '{"benefits":["School-scoped receipt counter","Automated payment reminders","Split installments & concessions"]}'),
  ('transport', 'Fleet & Transport', 'Bus routes, student stop assignments, and live location alerts', 'operations', 'standard', 'SIGNAL', true, false, false, 'ALL', '{"benefits":["Live GPS bus telemetry","Emergency stop geo-fencing","Driver trip check-in verification"]}'),
  ('examinations', 'Examination Management', 'Hall tickets, grading schemas, mark entry, and report cards', 'academics', 'standard', 'GRID', true, false, false, 'ALL', '{"benefits":["Automated hall ticket generation","Dynamic grading and ranking policy","One-click progress report cards"]}'),
  ('lms', 'Learning Materials (LMS)', 'Course syllabus, digital handouts, and video lesson distribution', 'academics', 'standard', 'LENS', true, false, false, 'ALL', '{"benefits":["Central study material repository","Video lesson embedding","Teacher file distribution"]}'),

  -- Premium Features (High-value modules)
  ('analytics', 'Executive Analytics', 'Real-time school performance analytics, fee realization, and trends', 'intelligence', 'premium', 'LENS', true, false, false, 'ALL', '{"benefits":["Multi-year academic trending","Fee collection forecasting","Comparative class attendance insights"]}'),
  ('advanced_reports', 'Advanced Intelligence Reports', 'Deep-dive cohort analysis, student retention, and board audit reports', 'intelligence', 'premium', 'GRID', true, false, false, 'ALL', '{"benefits":["Executive board-ready PDF exports","Defaulter risk projection","Cohort progression metrics"]}'),
  ('omr_scanner', 'OMR Optical Evaluation', 'High-speed mobile camera evaluation of standard test answer sheets', 'intelligence', 'premium', 'LENS', true, false, false, 'ALL', '{"benefits":["100-question instant optical scanning","Auto-grading against answer keys","Item analysis and difficulty curve"]}'),
  ('visitor_management', 'Campus Visitor Security', 'Digital badge printing, gatekeeper verification, and watchlist screening', 'security', 'premium', 'NEXUS', true, false, false, 'ALL', '{"benefits":["Instant QR badge check-in","Real-time on-campus headcount","Emergency lockdown blacklist alerts"]}'),
  ('academic_planning', 'Academic Curriculum Planner', 'Syllabus pacing, chapter health monitoring, and recovery planning', 'academics', 'premium', 'GRID', true, false, false, 'ALL', '{"benefits":["Curriculum delay alert triggers","Automated revision buffer scheduling","Principal syllabus audit ledger"]}'),
  ('academic_calendar', 'Smart Academic Calendar', 'Institution events, holidays, exam windows, and planner synchronization', 'operations', 'premium', 'ORBIT', true, false, false, 'ALL', '{"benefits":["Interactive timeline views","Academic milestone countdowns","Calendar reminders and push sync"]}'),
  ('event_management', 'Institutional Event Suite', 'Ceremony scheduling, volunteer rosters, and parent ticketing', 'operations', 'premium', 'PULSE', true, false, false, 'ALL', '{"benefits":["Live event RSVP and attendance","Volunteer duty allocations","Digital event gallery publication"]}'),
  ('content_engine', 'Daily Content Engine', 'Curated thoughts, news, and school stories distribution platform', 'communication', 'premium', 'SIGNAL', true, false, false, 'ALL', '{"benefits":["Daily morning assembly feeds","Verified educational news","Scheduled school story broadcast"]}'),
  ('admission_workflow', 'Admission CRM & Pipeline', 'Inquiry scoring, digital forms, and entrance evaluation workflow', 'operations', 'premium', 'NEXUS', true, false, false, 'ALL', '{"benefits":["Stage-by-stage inquiry tracker","Document verification pipeline","Instant fee generation on admit"]}'),

  -- Enterprise AI Features (Rollout & Future Capabilities)
  ('ai_anecdote', 'AI Anecdote Intelligence', 'Extracts behavioral and learning signals from daily teacher remarks', 'intelligence', 'enterprise', 'SIGNAL', true, true, false, 'SELECTED_SCHOOLS', '{"benefits":["Natural language behavioral signal detection","Proactive academic intervention alerts","Longitudinal student temperament profile"]}'),
  ('custom_reports', 'Custom Report Builder', 'Ad-hoc data queries and custom visual report generator', 'intelligence', 'enterprise', 'GRID', true, false, false, 'ALL', '{"benefits":["Drag-and-drop report layout builder","Custom SQL field aggregations","Automated weekly email dispatch"]}'),
  ('automation', 'Autonomous Workflow Engine', 'Rule-based event triggers, webhooks, and auto-corrective actions', 'intelligence', 'enterprise', 'NEXUS', true, false, false, 'ALL', '{"benefits":["Trigger-action automation builder","Auto-escalation of long leaves","Integration webhooks"]}'),
  ('ai_predictive_enrollment', 'Predictive Enrollment Intelligence', 'Forecasting upcoming academic year class sizes and capacity risk', 'intelligence', 'enterprise', 'SIGNAL', true, false, false, 'INTERNAL_ONLY', '{"benefits":["Capacity shortfall warnings","Demographic enrollment projections","Budgetary tuition forecasting"]}')
ON CONFLICT (key) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  min_plan_tier = EXCLUDED.min_plan_tier,
  hero_archetype = EXCLUDED.hero_archetype,
  metadata = EXCLUDED.metadata;

-- 3. Plan-Feature Link Table
CREATE TABLE IF NOT EXISTS public.plan_features (
  plan_id     VARCHAR(32) NOT NULL REFERENCES public.plans(id) ON DELETE CASCADE,
  feature_key VARCHAR(64) NOT NULL REFERENCES public.features(key) ON DELETE CASCADE,
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  PRIMARY KEY (plan_id, feature_key)
);

-- Seed Plan Feature Matrix
-- Starter includes core
INSERT INTO public.plan_features (plan_id, feature_key, enabled)
SELECT 'starter', key, true FROM public.features WHERE min_plan_tier = 'starter'
ON CONFLICT DO NOTHING;

-- Standard includes starter + standard
INSERT INTO public.plan_features (plan_id, feature_key, enabled)
SELECT 'standard', key, true FROM public.features WHERE min_plan_tier IN ('starter', 'standard')
ON CONFLICT DO NOTHING;

-- Premium includes starter + standard + premium
INSERT INTO public.plan_features (plan_id, feature_key, enabled)
SELECT 'premium', key, true FROM public.features WHERE min_plan_tier IN ('starter', 'standard', 'premium')
ON CONFLICT DO NOTHING;

-- Enterprise includes all
INSERT INTO public.plan_features (plan_id, feature_key, enabled)
SELECT 'enterprise', key, true FROM public.features
ON CONFLICT DO NOTHING;

-- 4. School-Level Feature Overrides (Tenant Scoped)
CREATE TABLE IF NOT EXISTS public.school_feature_overrides (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   INTEGER     NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  feature_key VARCHAR(64) NOT NULL REFERENCES public.features(key) ON DELETE CASCADE,
  enabled     BOOLEAN     NOT NULL,
  reason      TEXT,
  expires_at  TIMESTAMPTZ,
  updated_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_school_feature_overrides_lookup
  ON public.school_feature_overrides (school_id, feature_key);

-- 5. User-Level Feature Overrides (Individual Exception / Pilot Access)
CREATE TABLE IF NOT EXISTS public.user_feature_overrides (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   INTEGER     NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL,
  feature_key VARCHAR(64) NOT NULL REFERENCES public.features(key) ON DELETE CASCADE,
  enabled     BOOLEAN     NOT NULL,
  reason      TEXT,
  expires_at  TIMESTAMPTZ,
  granted_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, user_id, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_user_feature_overrides_lookup
  ON public.user_feature_overrides (school_id, user_id, feature_key);

-- 6. Feature Access Requests (Ask Administrator Workflow)
CREATE TABLE IF NOT EXISTS public.feature_access_requests (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       INTEGER     NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  feature_key     VARCHAR(64) NOT NULL REFERENCES public.features(key) ON DELETE CASCADE,
  requested_by    UUID        NOT NULL,
  user_role       TEXT        NOT NULL,
  user_name       TEXT,
  status          TEXT        NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED')),
  request_message TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     UUID
);

CREATE INDEX IF NOT EXISTS idx_feature_access_requests_school_status
  ON public.feature_access_requests (school_id, feature_key, status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_feature_access_pending_request
  ON public.feature_access_requests (school_id, feature_key, requested_by)
  WHERE status = 'PENDING';

-- 7. Feature Notification Subscriptions (Notify Me for Coming Soon)
CREATE TABLE IF NOT EXISTS public.feature_notification_subscriptions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   INTEGER     NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL,
  feature_key VARCHAR(64) NOT NULL REFERENCES public.features(key) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ,
  UNIQUE (school_id, user_id, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_feature_notif_sub_lookup
  ON public.feature_notification_subscriptions (school_id, feature_key);

-- 8. Feature Rollout Configuration (Gradual & Targeted Feature Releases)
CREATE TABLE IF NOT EXISTS public.feature_rollouts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_key     VARCHAR(64) NOT NULL REFERENCES public.features(key) ON DELETE CASCADE,
  rollout_type    TEXT        NOT NULL
                  CHECK (rollout_type IN ('ALL', 'SELECTED_SCHOOLS', 'PERCENTAGE', 'BETA_USERS', 'INTERNAL_ONLY')),
  rollout_payload JSONB       NOT NULL DEFAULT '{}'::jsonb,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feature_rollouts_feature
  ON public.feature_rollouts (feature_key)
  WHERE is_active IS TRUE;

-- 9. Feature Access & Audit Logs
CREATE TABLE IF NOT EXISTS public.feature_access_audit_logs (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      INTEGER     NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  user_id        UUID,
  feature_key    VARCHAR(64) NOT NULL,
  previous_state TEXT,
  new_state      TEXT,
  action         TEXT        NOT NULL,
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feature_access_audit_school
  ON public.feature_access_audit_logs (school_id, created_at DESC);

-- 10. Backward-Compatible link with existing saas_subscriptions
ALTER TABLE public.saas_subscriptions
  ADD COLUMN IF NOT EXISTS plan_id VARCHAR(32) REFERENCES public.plans(id) DEFAULT 'standard';

-- Default existing subscriptions to standard if unassigned
UPDATE public.saas_subscriptions
SET plan_id = 'standard'
WHERE plan_id IS NULL;

-- 11. Row Level Security
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_feature_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_feature_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_notification_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_rollouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_access_audit_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_tenant_rls_policy') THEN
    PERFORM create_tenant_rls_policy('school_feature_overrides');
    PERFORM create_tenant_rls_policy('user_feature_overrides');
    PERFORM create_tenant_rls_policy('feature_access_requests');
    PERFORM create_tenant_rls_policy('feature_notification_subscriptions');
    PERFORM create_tenant_rls_policy('feature_access_audit_logs');
  END IF;
END $$;

COMMIT;
