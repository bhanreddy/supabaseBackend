-- Migration: 20260912_v425_premium_visitor_management_system.sql
-- Description: Enterprise-grade Smart Campus Access + Visitor Security System for SchoolIMS.
-- Introduces GATE_KEEPER role, configurable school gates, visitor profiles, passes, check-ins,
-- student pickup authorizations, authorized guardians, vehicle logs, deliveries, material gate passes,
-- visitor security watchlist, emergency muster register, incidents, audit logs, and settings.

BEGIN;

-- 1. School Gates
CREATE TABLE IF NOT EXISTS public.school_gates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(50) NOT NULL,
    description TEXT,
    gate_type VARCHAR(50) NOT NULL DEFAULT 'pedestrian',
    is_active BOOLEAN NOT NULL DEFAULT true,
    allow_visitors BOOLEAN NOT NULL DEFAULT true,
    allow_students BOOLEAN NOT NULL DEFAULT true,
    allow_staff BOOLEAN NOT NULL DEFAULT true,
    allow_deliveries BOOLEAN NOT NULL DEFAULT true,
    allow_vehicles BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT uq_school_gate_code UNIQUE (school_id, code)
);

CREATE INDEX IF NOT EXISTS idx_school_gates_school_active
ON public.school_gates(school_id, is_active) WHERE deleted_at IS NULL;

-- 2. Gatekeeper Assigned Gates
CREATE TABLE IF NOT EXISTS public.gatekeeper_gates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    gate_id UUID NOT NULL REFERENCES public.school_gates(id) ON DELETE CASCADE,
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_gatekeeper_gate UNIQUE (user_id, gate_id)
);

CREATE INDEX IF NOT EXISTS idx_gatekeeper_gates_lookup
ON public.gatekeeper_gates(school_id, user_id);

-- 3. Visitor Profiles
CREATE TABLE IF NOT EXISTS public.visitor_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    full_name VARCHAR(150) NOT NULL,
    mobile_number VARCHAR(20) NOT NULL,
    email VARCHAR(255),
    visitor_type VARCHAR(50) NOT NULL DEFAULT 'PARENT',
    relationship VARCHAR(50),
    profile_photo_url TEXT,
    id_type VARCHAR(50),
    id_reference_masked VARCHAR(50),
    verification_status VARCHAR(50) NOT NULL DEFAULT 'VERIFIED',
    notes TEXT,
    is_watchlisted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_visitor_profiles_mobile
ON public.visitor_profiles(school_id, mobile_number) WHERE deleted_at IS NULL;

-- 4. School Visitor Settings
CREATE TABLE IF NOT EXISTS public.school_visitor_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE UNIQUE,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    allow_parent_requests BOOLEAN NOT NULL DEFAULT true,
    allow_walkins BOOLEAN NOT NULL DEFAULT true,
    require_visitor_photo BOOLEAN NOT NULL DEFAULT false,
    require_id_proof BOOLEAN NOT NULL DEFAULT false,
    require_vehicle_number BOOLEAN NOT NULL DEFAULT false,
    require_host_approval BOOLEAN NOT NULL DEFAULT true,
    parent_auto_approve BOOLEAN NOT NULL DEFAULT false,
    qr_validity_window_minutes INTEGER NOT NULL DEFAULT 120,
    allowed_early_entry_minutes INTEGER NOT NULL DEFAULT 30,
    allowed_late_entry_minutes INTEGER NOT NULL DEFAULT 60,
    default_visit_duration_minutes INTEGER NOT NULL DEFAULT 60,
    pickup_otp_enabled BOOLEAN NOT NULL DEFAULT true,
    enable_offline_mode BOOLEAN NOT NULL DEFAULT true,
    enable_overstay_alerts BOOLEAN NOT NULL DEFAULT true,
    overstay_threshold_minutes INTEGER NOT NULL DEFAULT 30,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Visitor Approval Policies
CREATE TABLE IF NOT EXISTS public.visitor_approval_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    category VARCHAR(50) NOT NULL,
    policy_type VARCHAR(50) NOT NULL DEFAULT 'HOST_APPROVAL',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_school_visitor_policy UNIQUE (school_id, category)
);

-- 6. Visitor Requests
CREATE TABLE IF NOT EXISTS public.visitor_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    visitor_profile_id UUID NOT NULL REFERENCES public.visitor_profiles(id) ON DELETE RESTRICT,
    requested_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    requested_by_role VARCHAR(50) NOT NULL DEFAULT 'PARENT',
    student_id UUID REFERENCES public.students(id) ON DELETE SET NULL,
    host_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    destination_department VARCHAR(100),
    visitor_type VARCHAR(50) NOT NULL DEFAULT 'PARENT',
    visit_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    purpose TEXT NOT NULL,
    visitor_count INTEGER NOT NULL DEFAULT 1,
    gate_id UUID REFERENCES public.school_gates(id) ON DELETE SET NULL,
    vehicle_number VARCHAR(50),
    notes TEXT,
    approval_status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    approval_policy VARCHAR(50) NOT NULL DEFAULT 'DEFAULT',
    approved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    rejected_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    rejected_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_visitor_requests_date
ON public.visitor_requests(school_id, visit_date, approval_status) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_visitor_requests_host
ON public.visitor_requests(school_id, host_user_id, approval_status) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_visitor_requests_student
ON public.visitor_requests(school_id, student_id) WHERE deleted_at IS NULL;

-- 7. Visitor Passes
CREATE TABLE IF NOT EXISTS public.visitor_passes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    visitor_request_id UUID NOT NULL REFERENCES public.visitor_requests(id) ON DELETE CASCADE,
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    pass_code VARCHAR(32) NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_until TIMESTAMPTZ NOT NULL,
    max_entries INTEGER NOT NULL DEFAULT 1,
    entry_count INTEGER NOT NULL DEFAULT 0,
    pass_type VARCHAR(50) NOT NULL DEFAULT 'ONE_TIME',
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoked_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    revocation_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visitor_passes_token_hash
ON public.visitor_passes(token_hash);

CREATE INDEX IF NOT EXISTS idx_visitor_passes_request
ON public.visitor_passes(school_id, visitor_request_id);

-- 8. Visitor Check-ins
CREATE TABLE IF NOT EXISTS public.visitor_checkins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    visitor_request_id UUID NOT NULL REFERENCES public.visitor_requests(id) ON DELETE RESTRICT,
    visitor_profile_id UUID NOT NULL REFERENCES public.visitor_profiles(id) ON DELETE RESTRICT,
    pass_id UUID REFERENCES public.visitor_passes(id) ON DELETE SET NULL,
    gate_id UUID REFERENCES public.school_gates(id) ON DELETE SET NULL,
    exit_gate_id UUID REFERENCES public.school_gates(id) ON DELETE SET NULL,
    gatekeeper_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    checked_out_at TIMESTAMPTZ,
    expected_checkout_at TIMESTAMPTZ NOT NULL,
    visit_duration_minutes INTEGER,
    verification_method VARCHAR(50) NOT NULL DEFAULT 'QR_SCAN',
    photo_url TEXT,
    vehicle_number VARCHAR(50),
    items_carried TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'INSIDE',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visitor_checkins_inside
ON public.visitor_checkins(school_id, status) WHERE checked_out_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_visitor_checkins_date
ON public.visitor_checkins(school_id, checked_in_at DESC);

-- 9. Authorized Guardians
CREATE TABLE IF NOT EXISTS public.authorized_guardians (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    parent_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    name VARCHAR(150) NOT NULL,
    relationship VARCHAR(50) NOT NULL,
    mobile VARCHAR(20) NOT NULL,
    photo_url TEXT,
    id_reference_masked VARCHAR(50),
    valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_until DATE,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_guardians_student
ON public.authorized_guardians(school_id, student_id, status) WHERE deleted_at IS NULL;

-- 10. Student Pickup Authorizations
CREATE TABLE IF NOT EXISTS public.student_pickup_authorizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    guardian_id UUID REFERENCES public.authorized_guardians(id) ON DELETE SET NULL,
    parent_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    pickup_name VARCHAR(150) NOT NULL,
    pickup_relationship VARCHAR(50) NOT NULL,
    pickup_mobile VARCHAR(20) NOT NULL,
    pickup_photo_url TEXT,
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    pass_code VARCHAR(32) NOT NULL,
    pickup_date DATE NOT NULL,
    valid_start_time TIME NOT NULL,
    valid_end_time TIME NOT NULL,
    vehicle_number VARCHAR(50),
    otp_hash VARCHAR(128),
    otp_expires_at TIMESTAMPTZ,
    otp_attempts INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(50) NOT NULL DEFAULT 'SCHEDULED',
    released_at TIMESTAMPTZ,
    released_by_gatekeeper_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    released_at_gate_id UUID REFERENCES public.school_gates(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pickup_token_hash
ON public.student_pickup_authorizations(token_hash);

CREATE INDEX IF NOT EXISTS idx_pickup_student_date
ON public.student_pickup_authorizations(school_id, student_id, pickup_date);

-- 11. Visitor Vehicles
CREATE TABLE IF NOT EXISTS public.visitor_vehicles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    visitor_profile_id UUID REFERENCES public.visitor_profiles(id) ON DELETE SET NULL,
    checkin_id UUID REFERENCES public.visitor_checkins(id) ON DELETE SET NULL,
    vehicle_type VARCHAR(50) NOT NULL DEFAULT 'CAR',
    registration_number VARCHAR(50) NOT NULL,
    entry_gate_id UUID REFERENCES public.school_gates(id) ON DELETE SET NULL,
    exit_gate_id UUID REFERENCES public.school_gates(id) ON DELETE SET NULL,
    entry_time TIMESTAMPTZ NOT NULL DEFAULT now(),
    exit_time TIMESTAMPTZ,
    parking_slot VARCHAR(50),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visitor_vehicles_number
ON public.visitor_vehicles(school_id, registration_number);

-- 12. Visitor Deliveries
CREATE TABLE IF NOT EXISTS public.visitor_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    gate_id UUID REFERENCES public.school_gates(id) ON DELETE SET NULL,
    gatekeeper_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    courier_name VARCHAR(100) NOT NULL,
    delivery_person VARCHAR(100) NOT NULL,
    mobile VARCHAR(20),
    package_count INTEGER NOT NULL DEFAULT 1,
    recipient_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    recipient_name VARCHAR(150) NOT NULL,
    recipient_department VARCHAR(100),
    tracking_reference VARCHAR(100),
    photo_url TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'RECEIVED',
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    collected_at TIMESTAMPTZ,
    collected_by_name VARCHAR(150),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visitor_deliveries_status
ON public.visitor_deliveries(school_id, status);

-- 13. Material Gate Passes
CREATE TABLE IF NOT EXISTS public.material_gate_passes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    pass_number VARCHAR(50) NOT NULL,
    direction VARCHAR(20) NOT NULL DEFAULT 'INWARD',
    category VARCHAR(50) NOT NULL DEFAULT 'NON_RETURNABLE',
    bearer_name VARCHAR(150) NOT NULL,
    bearer_mobile VARCHAR(20),
    bearer_company VARCHAR(150),
    vehicle_number VARCHAR(50),
    gate_id UUID REFERENCES public.school_gates(id) ON DELETE SET NULL,
    gatekeeper_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approver_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'APPROVED',
    expected_return_at TIMESTAMPTZ,
    actual_return_at TIMESTAMPTZ,
    remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_school_material_pass_number UNIQUE (school_id, pass_number)
);

CREATE TABLE IF NOT EXISTS public.material_gate_pass_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pass_id UUID NOT NULL REFERENCES public.material_gate_passes(id) ON DELETE CASCADE,
    item_name VARCHAR(150) NOT NULL,
    description TEXT,
    quantity NUMERIC NOT NULL DEFAULT 1,
    unit VARCHAR(20) DEFAULT 'PCS',
    serial_number VARCHAR(100),
    photo_url TEXT,
    return_status VARCHAR(50) DEFAULT 'PENDING'
);

-- 14. Visitor Watchlist
CREATE TABLE IF NOT EXISTS public.visitor_watchlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    visitor_profile_id UUID REFERENCES public.visitor_profiles(id) ON DELETE SET NULL,
    name VARCHAR(150) NOT NULL,
    mobile VARCHAR(20),
    vehicle_number VARCHAR(50),
    id_reference_masked VARCHAR(50),
    restriction_level VARCHAR(50) NOT NULL DEFAULT 'WARNING',
    reason TEXT NOT NULL,
    added_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visitor_watchlist_mobile
ON public.visitor_watchlist(school_id, mobile) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_visitor_watchlist_vehicle
ON public.visitor_watchlist(school_id, vehicle_number) WHERE is_active = true;

-- 15. Emergency Registers
CREATE TABLE IF NOT EXISTS public.emergency_registers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL,
    incident_type VARCHAR(50) NOT NULL DEFAULT 'GENERAL',
    activated_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.emergency_register_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    emergency_id UUID NOT NULL REFERENCES public.emergency_registers(id) ON DELETE CASCADE,
    visitor_checkin_id UUID REFERENCES public.visitor_checkins(id) ON DELETE SET NULL,
    person_name VARCHAR(150) NOT NULL,
    person_type VARCHAR(50) NOT NULL DEFAULT 'VISITOR',
    contact_number VARCHAR(20),
    host_name VARCHAR(150),
    gate_entered VARCHAR(100),
    entered_at TIMESTAMPTZ,
    status VARCHAR(50) NOT NULL DEFAULT 'INSIDE',
    marked_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    marked_at TIMESTAMPTZ,
    remarks TEXT
);

-- 16. Security Incidents
CREATE TABLE IF NOT EXISTS public.visitor_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    gate_id UUID REFERENCES public.school_gates(id) ON DELETE SET NULL,
    reported_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    visitor_profile_id UUID REFERENCES public.visitor_profiles(id) ON DELETE SET NULL,
    checkin_id UUID REFERENCES public.visitor_checkins(id) ON DELETE SET NULL,
    incident_type VARCHAR(50) NOT NULL,
    severity VARCHAR(50) NOT NULL DEFAULT 'MEDIUM',
    description TEXT NOT NULL,
    attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolution_status VARCHAR(50) NOT NULL DEFAULT 'OPEN',
    resolved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    resolution_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visitor_incidents_status
ON public.visitor_incidents(school_id, resolution_status, severity);

-- 17. Visitor Audit Events
CREATE TABLE IF NOT EXISTS public.visitor_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    user_role VARCHAR(50),
    gate_id UUID REFERENCES public.school_gates(id) ON DELETE SET NULL,
    event_type VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(100) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(50),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visitor_audit_events_lookup
ON public.visitor_audit_events(school_id, event_type, created_at DESC);

-- 18. Offline Event Sync Log
CREATE TABLE IF NOT EXISTS public.offline_event_sync_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    client_event_id VARCHAR(100) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    gatekeeper_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    payload JSONB NOT NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_offline_event UNIQUE (school_id, client_event_id)
);

-- 19. Triggers for updated_at
DROP TRIGGER IF EXISTS trg_school_gates_updated ON public.school_gates;
CREATE TRIGGER trg_school_gates_updated BEFORE UPDATE ON public.school_gates FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

DROP TRIGGER IF EXISTS trg_visitor_profiles_updated ON public.visitor_profiles;
CREATE TRIGGER trg_visitor_profiles_updated BEFORE UPDATE ON public.visitor_profiles FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

DROP TRIGGER IF EXISTS trg_school_visitor_settings_updated ON public.school_visitor_settings;
CREATE TRIGGER trg_school_visitor_settings_updated BEFORE UPDATE ON public.school_visitor_settings FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

DROP TRIGGER IF EXISTS trg_visitor_requests_updated ON public.visitor_requests;
CREATE TRIGGER trg_visitor_requests_updated BEFORE UPDATE ON public.visitor_requests FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

DROP TRIGGER IF EXISTS trg_visitor_passes_updated ON public.visitor_passes;
CREATE TRIGGER trg_visitor_passes_updated BEFORE UPDATE ON public.visitor_passes FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

DROP TRIGGER IF EXISTS trg_visitor_checkins_updated ON public.visitor_checkins;
CREATE TRIGGER trg_visitor_checkins_updated BEFORE UPDATE ON public.visitor_checkins FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

DROP TRIGGER IF EXISTS trg_authorized_guardians_updated ON public.authorized_guardians;
CREATE TRIGGER trg_authorized_guardians_updated BEFORE UPDATE ON public.authorized_guardians FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

DROP TRIGGER IF EXISTS trg_student_pickup_authorizations_updated ON public.student_pickup_authorizations;
CREATE TRIGGER trg_student_pickup_authorizations_updated BEFORE UPDATE ON public.student_pickup_authorizations FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

-- 20. Seed System Role: GATE_KEEPER
INSERT INTO public.roles (school_id, code, name, is_system)
SELECT s.id, 'gate_keeper', 'Gate Keeper', true
FROM public.schools s
WHERE NOT EXISTS (
    SELECT 1 FROM public.roles r WHERE r.school_id = s.id AND r.code = 'gate_keeper' AND r.deleted_at IS NULL
);

-- 21. Seed Permissions
INSERT INTO public.permissions (school_id, code, name)
SELECT s.id, v.code, v.name
FROM public.schools s
CROSS JOIN (VALUES
    ('visitors.view', 'View Visitor Management'),
    ('visitors.scan', 'Scan & Verify Visitor QR'),
    ('visitors.manage', 'Manage Visitor Approvals & Passes'),
    ('visitors.checkin', 'Check-in Visitors at Gate'),
    ('visitors.checkout', 'Check-out Visitors at Gate'),
    ('visitors.walkin', 'Register Walk-in Visitors'),
    ('visitors.pickup', 'Authorize & Release Student Pickups'),
    ('visitors.delivery', 'Manage Delivery Entries'),
    ('visitors.material', 'Manage Material Gate Passes'),
    ('visitors.incident', 'Report & Manage Security Incidents'),
    ('visitors.emergency', 'Access Emergency Visitor Muster'),
    ('visitors.settings', 'Configure Visitor Settings & Gates')
) AS v(code, name)
ON CONFLICT (school_id, code) DO UPDATE
SET name = EXCLUDED.name, deleted_at = NULL;

-- 22. Grant Permissions to GATE_KEEPER Role
INSERT INTO public.role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM public.permissions p
JOIN public.roles r ON r.school_id = p.school_id AND r.code = 'gate_keeper'
WHERE p.code IN (
    'visitors.view',
    'visitors.scan',
    'visitors.checkin',
    'visitors.checkout',
    'visitors.walkin',
    'visitors.pickup',
    'visitors.delivery',
    'visitors.material',
    'visitors.incident',
    'visitors.emergency'
)
AND p.deleted_at IS NULL AND r.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) DO UPDATE
SET school_id = EXCLUDED.school_id, deleted_at = NULL;

-- 23. Grant Permissions to ADMIN and PRINCIPAL Roles
INSERT INTO public.role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM public.permissions p
JOIN public.roles r ON r.school_id = p.school_id AND r.code IN ('admin', 'principal')
WHERE p.code LIKE 'visitors.%'
AND p.deleted_at IS NULL AND r.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) DO UPDATE
SET school_id = EXCLUDED.school_id, deleted_at = NULL;

-- 24. Grant Visitor View and Request Permissions to PARENT and STUDENT Roles
INSERT INTO public.role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM public.permissions p
JOIN public.roles r ON r.school_id = p.school_id AND r.code IN ('parent', 'student')
WHERE p.code IN ('visitors.view', 'visitors.pickup')
AND p.deleted_at IS NULL AND r.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) DO UPDATE
SET school_id = EXCLUDED.school_id, deleted_at = NULL;

-- 25. Initialize Default Gates & Settings for Schools
INSERT INTO public.school_visitor_settings (school_id)
SELECT s.id FROM public.schools s
ON CONFLICT (school_id) DO NOTHING;

INSERT INTO public.school_gates (school_id, name, code, description, gate_type)
SELECT s.id, 'Main Gate', 'MAIN_GATE', 'Primary Campus Entrance & Security Post', 'mixed'
FROM public.schools s
ON CONFLICT (school_id, code) DO NOTHING;

COMMIT;
