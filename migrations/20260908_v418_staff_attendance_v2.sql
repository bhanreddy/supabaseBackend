-- Migration: Staff Attendance V2
-- Release: 4.1.8
-- Description: Server-verifiable biometric mobile attendance, device registrations, geofencing policies, and attributable administrative controls.

BEGIN;

-- 1. Campus Attendance Policies
CREATE TABLE IF NOT EXISTS campus_attendance_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    campus_name TEXT NOT NULL,
    center_latitude NUMERIC(10, 7) NOT NULL,
    center_longitude NUMERIC(10, 7) NOT NULL,
    radius_meters NUMERIC(8, 2) NOT NULL DEFAULT 100.0,
    max_location_age_seconds INT NOT NULL DEFAULT 30,
    max_accuracy_meters NUMERIC(8, 2) NOT NULL DEFAULT 50.0,
    challenge_expiry_seconds INT NOT NULL DEFAULT 60,
    policy_version TEXT NOT NULL DEFAULT '1.0',
    is_active BOOLEAN NOT NULL DEFAULT true,
    enforcement_mode TEXT NOT NULL DEFAULT 'disabled', -- 'disabled', 'pilot', 'optional', 'enforced'
    school_timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    check_in_start_time TIME DEFAULT '07:30',
    check_in_end_time TIME DEFAULT '10:00',
    check_out_start_time TIME DEFAULT '15:30',
    check_out_end_time TIME DEFAULT '19:00',
    grace_period_minutes INT DEFAULT 15,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campus_policies_school_active 
ON campus_attendance_policies(school_id, is_active);

-- 2. Staff Device Registrations
CREATE TABLE IF NOT EXISTS staff_device_registrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    canonical_person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    installation_id TEXT,
    device_session_public_key TEXT NOT NULL,
    attendance_public_key TEXT NOT NULL,
    device_model TEXT,
    os_name TEXT,
    os_version TEXT,
    app_version TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'revoked', 'replaced'
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    revoked_by UUID REFERENCES users(id),
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Invariants: One approved device per person, one person per device
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_registration_per_person 
ON staff_device_registrations (canonical_person_id) WHERE status = 'approved';

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_registration_per_device 
ON staff_device_registrations (device_session_public_key) WHERE status = 'approved';

-- Existing pre-release databases may already have the table. Keep the forward
-- migration additive, while requiring the API to populate this value for every
-- new registration. It is a stable SecureStore-backed app-install identifier.
ALTER TABLE staff_device_registrations
ADD COLUMN IF NOT EXISTS installation_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_registration_per_installation
ON staff_device_registrations (installation_id)
WHERE status = 'approved' AND installation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_device_person_status 
ON staff_device_registrations(canonical_person_id, status);

CREATE INDEX IF NOT EXISTS idx_staff_device_staff_status 
ON staff_device_registrations(staff_id, status);

CREATE INDEX IF NOT EXISTS idx_staff_device_installation_status
ON staff_device_registrations(installation_id, status)
WHERE installation_id IS NOT NULL;

-- 3. Device Bound Sessions
CREATE TABLE IF NOT EXISTS staff_device_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    registration_id UUID NOT NULL REFERENCES staff_device_registrations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    school_id INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    device_public_key TEXT NOT NULL,
    is_revoked BOOLEAN NOT NULL DEFAULT false,
    last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_sessions_lookup 
ON staff_device_sessions(registration_id, is_revoked);

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_staff_device_session
ON staff_device_sessions(registration_id, user_id, school_id) WHERE is_revoked = false;

CREATE TABLE IF NOT EXISTS staff_device_request_nonces (
    registration_id UUID NOT NULL REFERENCES staff_device_registrations(id) ON DELETE CASCADE,
    nonce TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (registration_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_staff_device_nonce_expiry
ON staff_device_request_nonces(expires_at);

-- 4. Attendance Single-Use Challenges
CREATE TABLE IF NOT EXISTS attendance_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    challenge TEXT NOT NULL UNIQUE,
    school_id INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    registration_id UUID NOT NULL REFERENCES staff_device_registrations(id) ON DELETE CASCADE,
    action TEXT NOT NULL, -- 'check_in', 'check_out'
    attendance_date DATE NOT NULL,
    policy_version TEXT NOT NULL DEFAULT '1.0',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_attendance_challenges_search 
ON attendance_challenges(challenge, consumed_at, expires_at);

-- 5. Immutable Attendance Events
CREATE TABLE IF NOT EXISTS staff_attendance_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    campus_id UUID REFERENCES campus_attendance_policies(id),
    action TEXT NOT NULL, -- 'check_in', 'check_out'
    event_timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    client_location JSONB NOT NULL,
    device_registration_id UUID REFERENCES staff_device_registrations(id),
    challenge_id UUID REFERENCES attendance_challenges(id),
    idempotency_key TEXT NOT NULL UNIQUE,
    verification_status TEXT NOT NULL DEFAULT 'verified', -- 'verified', 'admin_override', 'rejected'
    source TEXT NOT NULL DEFAULT 'mobile_v2', -- 'mobile_v2', 'admin_manual', 'admin_correction', 'exception_approved'
    actor_id UUID REFERENCES users(id),
    policy_version TEXT NOT NULL DEFAULT '1.0',
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_att_events_staff_date 
ON staff_attendance_events(staff_id, event_timestamp);

CREATE INDEX IF NOT EXISTS idx_att_events_school_action 
ON staff_attendance_events(school_id, action, event_timestamp);

-- 6. Attendance Exception Requests
CREATE TABLE IF NOT EXISTS staff_attendance_exceptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    attendance_date DATE NOT NULL,
    action TEXT NOT NULL, -- 'check_in', 'check_out'
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    review_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_att_exceptions 
ON staff_attendance_exceptions(school_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_staff_att_exception
ON staff_attendance_exceptions(school_id, staff_id, attendance_date, action)
WHERE status = 'pending';

-- 7. Staff Attendance Audit Logs
CREATE TABLE IF NOT EXISTS staff_attendance_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id),
    target_staff_id UUID REFERENCES staff(id),
    action TEXT NOT NULL,
    reason TEXT,
    previous_state JSONB,
    new_state JSONB,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_att_audit_school 
ON staff_attendance_audit_logs(school_id, created_at);

-- These tables are backend-internal. The Express service role is the only
-- application path allowed to read or mutate device keys, challenges, precise
-- locations, exception records, and attendance audit evidence. Enabling RLS
-- as defense in depth and revoking portal grants prevents direct PostgREST
-- calls from bypassing the V2 permission and state-machine checks.
ALTER TABLE campus_attendance_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE campus_attendance_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_device_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_device_registrations FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_device_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_device_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_device_request_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_device_request_nonces FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_challenges FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_attendance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_attendance_events FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_attendance_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_attendance_exceptions FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_attendance_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_attendance_audit_logs FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE campus_attendance_policies FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE staff_device_registrations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE staff_device_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE staff_device_request_nonces FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE attendance_challenges FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE staff_attendance_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE staff_attendance_exceptions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE staff_attendance_audit_logs FROM PUBLIC, anon, authenticated;

-- 8. Extend staff_attendance daily summary for V2 compatibility
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS check_in_time TIMESTAMPTZ;
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS check_out_time TIMESTAMPTZ;
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS check_in_event_id UUID REFERENCES staff_attendance_events(id);
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS check_out_event_id UUID REFERENCES staff_attendance_events(id);
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS verification_source VARCHAR(30) DEFAULT 'manual';
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS is_finalized BOOLEAN DEFAULT false;
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS finalized_by UUID REFERENCES users(id);
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS reopened_by UUID REFERENCES users(id);
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;
ALTER TABLE staff_attendance ADD COLUMN IF NOT EXISTS reopen_reason TEXT;

-- Update check constraint on staff_attendance to be timezone aware
ALTER TABLE staff_attendance DROP CONSTRAINT IF EXISTS chk_staff_attendance_date_past;
ALTER TABLE staff_attendance ADD CONSTRAINT chk_staff_attendance_date_past 
CHECK (attendance_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE);

-- 9. Seed Permissions
INSERT INTO permissions (school_id, code, name)
SELECT s.id, v.code, v.name
FROM schools s
CROSS JOIN (VALUES
    ('staff_attendance.self', 'Mark Staff Self-Attendance'),
    ('staff_attendance.manage', 'Manage Staff Attendance'),
    ('staff_attendance.correct', 'Correct Staff Attendance')
) AS v(code, name)
ON CONFLICT (school_id, code) DO UPDATE
SET name = EXCLUDED.name, deleted_at = NULL;

-- Grant staff_attendance.self to staff, teacher, and principal roles
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM permissions p
JOIN roles r
  ON r.school_id = p.school_id
 AND r.code IN ('staff', 'teacher', 'principal')
WHERE p.code = 'staff_attendance.self'
  AND p.deleted_at IS NULL
  AND r.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) DO UPDATE
SET school_id = EXCLUDED.school_id, deleted_at = NULL;

-- Grant staff_attendance.manage and staff_attendance.correct to admin and principal roles
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM permissions p
JOIN roles r
  ON r.school_id = p.school_id
 AND r.code IN ('admin', 'principal')
WHERE p.code IN ('staff_attendance.manage', 'staff_attendance.correct')
  AND p.deleted_at IS NULL
  AND r.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) DO UPDATE
SET school_id = EXCLUDED.school_id, deleted_at = NULL;

COMMIT;
