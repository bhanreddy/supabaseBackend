-- Migration: 20260912_v426_visitor_management_hardening.sql
-- Backwards-compatible hardening for Premium Visitor Management.
-- Adds encrypted pass tokens, unique open-checkin protection, overstay throttle,
-- contractor passes, appointment slots, parent-scoped permission correction,
-- and default approval policies. Does not drop existing tables or user data.

BEGIN;

ALTER TABLE public.visitor_passes
    ADD COLUMN IF NOT EXISTS token_encrypted TEXT;

ALTER TABLE public.student_pickup_authorizations
    ADD COLUMN IF NOT EXISTS token_encrypted TEXT;

ALTER TABLE public.school_visitor_settings
    ADD COLUMN IF NOT EXISTS allow_authorized_guardians BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS enable_visitor_badges BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS enable_delivery_management BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS enable_vehicle_tracking BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS enable_material_gate_pass BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS enable_contractor_passes BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS enable_watchlist BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS enable_appointments BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS require_mobile BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS offline_walkin_auto_approve BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_visitor_checkins_one_open
ON public.visitor_checkins(school_id, visitor_profile_id)
WHERE checked_out_at IS NULL;

CREATE TABLE IF NOT EXISTS public.visitor_overstay_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    checkin_id UUID NOT NULL REFERENCES public.visitor_checkins(id) ON DELETE CASCADE,
    last_notified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    notify_count INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_overstay_alert_checkin UNIQUE (checkin_id)
);

CREATE INDEX IF NOT EXISTS idx_overstay_alerts_school
ON public.visitor_overstay_alerts(school_id, last_notified_at DESC);

CREATE TABLE IF NOT EXISTS public.visitor_contractor_passes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    visitor_profile_id UUID NOT NULL REFERENCES public.visitor_profiles(id) ON DELETE RESTRICT,
    company_name VARCHAR(150) NOT NULL,
    contract_reference VARCHAR(100),
    visitor_pass_id UUID REFERENCES public.visitor_passes(id) ON DELETE SET NULL,
    allowed_gate_ids UUID[] NOT NULL DEFAULT '{}',
    valid_from DATE NOT NULL,
    valid_until DATE NOT NULL,
    allowed_start_time TIME NOT NULL DEFAULT '08:00',
    allowed_end_time TIME NOT NULL DEFAULT '18:00',
    visit_frequency VARCHAR(50) NOT NULL DEFAULT 'DAILY',
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_contractor_passes_school
ON public.visitor_contractor_passes(school_id, status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.visitor_appointment_slots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    host_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    department VARCHAR(100),
    day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    slot_duration_minutes INTEGER NOT NULL DEFAULT 30,
    max_appointments INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_host_slot UNIQUE (school_id, host_user_id, day_of_week, start_time)
);

CREATE TABLE IF NOT EXISTS public.visitor_appointments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    slot_id UUID REFERENCES public.visitor_appointment_slots(id) ON DELETE SET NULL,
    host_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    visitor_request_id UUID REFERENCES public.visitor_requests(id) ON DELETE SET NULL,
    requested_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    appointment_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'BOOKED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_no_double_book
ON public.visitor_appointments(school_id, host_user_id, appointment_date, start_time)
WHERE status IN ('BOOKED', 'CONFIRMED');

DROP TRIGGER IF EXISTS trg_visitor_contractor_passes_updated ON public.visitor_contractor_passes;
CREATE TRIGGER trg_visitor_contractor_passes_updated BEFORE UPDATE ON public.visitor_contractor_passes FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

INSERT INTO public.permissions (school_id, code, name)
SELECT s.id, v.code, v.name
FROM public.schools s
CROSS JOIN (VALUES
    ('visitors.request', 'Create and manage own visitor requests'),
    ('visitors.approve', 'Approve or reject visitor requests as host')
) AS v(code, name)
ON CONFLICT (school_id, code) DO UPDATE
SET name = EXCLUDED.name, deleted_at = NULL;

-- Parents/students may request visits and manage pickups, but must not see
-- campus live registers, watchlists, analytics, or other families' requests.
INSERT INTO public.role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM public.permissions p
JOIN public.roles r ON r.school_id = p.school_id AND r.code IN ('parent', 'student')
WHERE p.code IN ('visitors.request', 'visitors.pickup')
AND p.deleted_at IS NULL AND r.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) DO UPDATE
SET school_id = EXCLUDED.school_id, deleted_at = NULL;

UPDATE public.role_permissions rp
SET deleted_at = NOW()
FROM public.roles r, public.permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.code IN ('parent', 'student')
  AND p.code = 'visitors.view'
  AND rp.deleted_at IS NULL;

INSERT INTO public.role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM public.permissions p
JOIN public.roles r ON r.school_id = p.school_id AND r.code IN ('teacher', 'staff', 'principal', 'admin')
WHERE p.code = 'visitors.approve'
AND p.deleted_at IS NULL AND r.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) DO UPDATE
SET school_id = EXCLUDED.school_id, deleted_at = NULL;

INSERT INTO public.visitor_approval_policies (school_id, category, policy_type)
SELECT s.id, v.category, v.policy_type
FROM public.schools s
CROSS JOIN (VALUES
    ('PARENT', 'HOST_APPROVAL'),
    ('VENDOR', 'ADMIN_APPROVAL'),
    ('CONTRACTOR', 'ADMIN_APPROVAL'),
    ('DELIVERY', 'GATEKEEPER_APPROVAL'),
    ('GUEST', 'HOST_APPROVAL')
) AS v(category, policy_type)
ON CONFLICT (school_id, category) DO NOTHING;

COMMIT;
