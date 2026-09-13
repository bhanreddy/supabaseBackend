-- Migration: 20260913_v431_premium_event_management_system.sql
-- Premium Paperless Event Management System
-- Multi-tenant, secure, production-grade schema

BEGIN;

-- 1. ENHANCE CORE events TABLE WITH OPERATIONAL COLUMNS
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'CUSTOM',
    ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN IF NOT EXISTS banner_url TEXT,
    ADD COLUMN IF NOT EXISTS registration_deadline TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS coordinator_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS configuration JSONB NOT NULL DEFAULT '{
      "modules": {
        "registration": true,
        "consent": false,
        "payments": false,
        "transport": false,
        "competition": false,
        "attendance": true,
        "qr_passes": true,
        "guests": false,
        "volunteers": false,
        "tasks": true,
        "vendors": false,
        "expenses": false,
        "certificates": false,
        "gallery": true,
        "feedback": true
      },
      "constraints": {
        "max_activities_per_student": 3,
        "capacity_limit": null,
        "fee_amount": 0
      }
    }'::jsonb,
    ADD COLUMN IF NOT EXISTS approval_status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN IF NOT EXISTS readiness_score NUMERIC(5,2) DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS closed_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_events_operational_status'
    ) THEN
        ALTER TABLE public.events
        ADD CONSTRAINT chk_events_operational_status
        CHECK (status IN (
            'DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'PUBLISHED',
            'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ONGOING',
            'COMPLETED', 'CLOSURE_PENDING', 'CLOSED', 'CANCELLED'
        ));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_events_approval_status'
    ) THEN
        ALTER TABLE public.events
        ADD CONSTRAINT chk_events_approval_status
        CHECK (approval_status IN ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_school_status ON public.events(school_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_school_category ON public.events(school_id, category) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_coordinator ON public.events(coordinator_id) WHERE coordinator_id IS NOT NULL;

-- 2. EVENT TEMPLATES TABLE
CREATE TABLE IF NOT EXISTS public.event_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    category VARCHAR(50) NOT NULL,
    description TEXT,
    icon VARCHAR(50) DEFAULT 'sparkles-outline',
    color VARCHAR(20) DEFAULT '#4F46E5',
    default_configuration JSONB NOT NULL,
    default_teams JSONB DEFAULT '[]'::jsonb,
    default_tasks JSONB DEFAULT '[]'::jsonb,
    default_budget_categories JSONB DEFAULT '[]'::jsonb,
    default_consent_disclaimers JSONB DEFAULT '[]'::jsonb,
    is_system BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_event_templates_school ON public.event_templates(school_id, category) WHERE deleted_at IS NULL;

-- 3. EVENT AUDIENCE TARGETS
CREATE TABLE IF NOT EXISTS public.event_audience_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    target_type VARCHAR(50) NOT NULL CHECK (target_type IN ('ENTIRE_SCHOOL', 'ROLE', 'CLASS', 'SECTION', 'USER', 'STUDENT', 'STAFF', 'EXTERNAL')),
    target_id VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_event_audience_target UNIQUE (event_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_event_audience_lookup ON public.event_audience_targets(school_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_event_audience_event ON public.event_audience_targets(event_id);

-- 4. EVENT APPROVAL WORKFLOW HISTORY
CREATE TABLE IF NOT EXISTS public.event_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    stage VARCHAR(50) NOT NULL DEFAULT 'COORDINATOR', -- COORDINATOR, PRINCIPAL, MANAGEMENT, ACCOUNTS
    approver_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    decision VARCHAR(30) NOT NULL CHECK (decision IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED')),
    comments TEXT,
    previous_state VARCHAR(30),
    changed_state VARCHAR(30),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_approvals_event ON public.event_approvals(event_id, created_at DESC);

-- 5. EVENT REGISTRATIONS & PARTICIPANTS
CREATE TABLE IF NOT EXISTS public.event_registrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    participant_type VARCHAR(30) NOT NULL CHECK (participant_type IN ('STUDENT', 'PARENT', 'STAFF', 'EXTERNAL', 'GUEST')),
    student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    parent_id UUID REFERENCES public.parents(id) ON DELETE SET NULL,
    external_name VARCHAR(150),
    external_contact VARCHAR(50),
    external_organization VARCHAR(150),
    selected_activities JSONB DEFAULT '[]'::jsonb,
    registration_status VARCHAR(30) NOT NULL DEFAULT 'REGISTERED' CHECK (registration_status IN ('REGISTERED', 'WAITLISTED', 'CONFIRMED', 'CANCELLED')),
    waitlist_position INTEGER,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_event_reg_event ON public.event_registrations(event_id, registration_status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_reg_student ON public.event_registrations(student_id, event_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_reg_user ON public.event_registrations(user_id, event_id) WHERE deleted_at IS NULL;

-- 6. DIGITAL PARENT CONSENT (TAMPER-EVIDENT EVIDENCE)
CREATE TABLE IF NOT EXISTS public.event_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    parent_id UUID NOT NULL REFERENCES public.parents(id) ON DELETE CASCADE,
    consent_version INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(20) NOT NULL CHECK (status IN ('CONSENTED', 'DECLINED', 'PENDING')),
    medical_declaration_ack BOOLEAN NOT NULL DEFAULT false,
    emergency_treatment_auth BOOLEAN NOT NULL DEFAULT false,
    transportation_consent BOOLEAN NOT NULL DEFAULT false,
    photography_media_consent BOOLEAN NOT NULL DEFAULT false,
    rules_instructions_ack BOOLEAN NOT NULL DEFAULT false,
    parent_remarks TEXT,
    ip_address VARCHAR(45),
    user_agent TEXT,
    responded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_event_student_consent UNIQUE (event_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_event_consents_lookup ON public.event_consents(school_id, event_id, status);
CREATE INDEX IF NOT EXISTS idx_event_consents_student ON public.event_consents(student_id);

-- 7. SECURE QR EVENT PASSES
CREATE TABLE IF NOT EXISTS public.event_passes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    registration_id UUID REFERENCES public.event_registrations(id) ON DELETE CASCADE,
    attendee_type VARCHAR(30) NOT NULL CHECK (attendee_type IN ('STUDENT', 'PARENT', 'STAFF', 'VOLUNTEER', 'JUDGE', 'GUEST', 'VENDOR', 'EXTERNAL')),
    student_id UUID REFERENCES public.students(id) ON DELETE SET NULL,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    guest_name VARCHAR(150),
    guest_phone VARCHAR(50),
    pass_code VARCHAR(20) NOT NULL, -- e.g. EV-942-831
    token_hash VARCHAR(64) NOT NULL, -- SHA-256 of raw secret token
    valid_from TIMESTAMPTZ NOT NULL,
    valid_until TIMESTAMPTZ NOT NULL,
    max_entries INTEGER NOT NULL DEFAULT 1,
    entry_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'USED', 'REVOKED', 'EXPIRED')),
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_event_pass_code UNIQUE (school_id, pass_code),
    CONSTRAINT uq_event_token_hash UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_event_passes_token ON public.event_passes(token_hash);
CREATE INDEX IF NOT EXISTS idx_event_passes_code ON public.event_passes(school_id, pass_code);
CREATE INDEX IF NOT EXISTS idx_event_passes_event ON public.event_passes(event_id, status);

-- 8. EVENT CHECK-IN & GATE SCAN HISTORY
CREATE TABLE IF NOT EXISTS public.event_checkins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    pass_id UUID REFERENCES public.event_passes(id) ON DELETE SET NULL,
    attendee_type VARCHAR(30) NOT NULL,
    attendee_id VARCHAR(100) NOT NULL, -- student UUID, user UUID, or guest identifier
    direction VARCHAR(10) NOT NULL DEFAULT 'ENTRY' CHECK (direction IN ('ENTRY', 'EXIT')),
    gate_id UUID REFERENCES public.school_gates(id) ON DELETE SET NULL,
    verified_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    verification_method VARCHAR(30) NOT NULL DEFAULT 'QR_SCAN' CHECK (verification_method IN ('QR_SCAN', 'MANUAL_CODE', 'TEACHER_ROSTER', 'WALK_IN')),
    notes TEXT,
    client_event_id VARCHAR(100), -- For offline sync idempotency
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_checkins_event ON public.event_checkins(event_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_checkins_pass ON public.event_checkins(pass_id);
CREATE INDEX IF NOT EXISTS idx_event_checkins_client_sync ON public.event_checkins(school_id, client_event_id) WHERE client_event_id IS NOT NULL;

-- 9. GRANULAR EVENT ATTENDANCE
CREATE TABLE IF NOT EXISTS public.event_attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    participant_type VARCHAR(30) NOT NULL DEFAULT 'STUDENT' CHECK (participant_type IN ('STUDENT', 'STAFF', 'VOLUNTEER', 'EXTERNAL')),
    student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'PRESENT' CHECK (status IN ('PRESENT', 'ABSENT', 'LATE', 'CHECKED_IN', 'CHECKED_OUT', 'ON_BUS', 'ARRIVED', 'LEFT_EVENT')),
    checkin_time TIMESTAMPTZ,
    checkout_time TIMESTAMPTZ,
    bus_assignment_id UUID,
    marked_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_event_student_attendance UNIQUE (event_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_event_attendance_event_status ON public.event_attendance(event_id, status);

-- 10. EVENT COMMITTEES & TEAMS
CREATE TABLE IF NOT EXISTS public.event_teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    lead_staff_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
    responsibilities TEXT,
    notes TEXT,
    color VARCHAR(20) DEFAULT '#4F46E5',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_teams_event ON public.event_teams(event_id);

CREATE TABLE IF NOT EXISTS public.event_team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    team_id UUID NOT NULL REFERENCES public.event_teams(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    member_type VARCHAR(20) NOT NULL DEFAULT 'STAFF' CHECK (member_type IN ('STAFF', 'VOLUNTEER', 'STUDENT')),
    staff_id UUID REFERENCES public.staff(id) ON DELETE CASCADE,
    student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    role_title VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_team_members_team ON public.event_team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_event_team_members_user ON public.event_team_members(user_id);

-- 11. EVENT TASK MANAGEMENT
CREATE TABLE IF NOT EXISTS public.event_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    team_id UUID REFERENCES public.event_teams(id) ON DELETE SET NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    assigned_to_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    due_date DATE,
    priority VARCHAR(20) NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
    status VARCHAR(30) NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO', 'IN_PROGRESS', 'BLOCKED', 'AWAITING_APPROVAL', 'COMPLETED', 'OVERDUE')),
    checklist JSONB DEFAULT '[]'::jsonb,
    attachments JSONB DEFAULT '[]'::jsonb,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_tasks_event_status ON public.event_tasks(event_id, status);
CREATE INDEX IF NOT EXISTS idx_event_tasks_assigned ON public.event_tasks(assigned_to_user_id, due_date);

-- 12. EVENT TRANSPORT ASSIGNMENTS & MANIFESTS
CREATE TABLE IF NOT EXISTS public.event_transport_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    bus_id UUID NOT NULL REFERENCES public.buses(id) ON DELETE RESTRICT,
    teacher_in_charge_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
    driver_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
    vehicle_capacity INTEGER NOT NULL DEFAULT 40,
    pickup_point VARCHAR(200),
    departure_time TIME,
    return_time TIME,
    route_description TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_transport_event ON public.event_transport_assignments(event_id);

CREATE TABLE IF NOT EXISTS public.event_bus_manifests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    assignment_id UUID NOT NULL REFERENCES public.event_transport_assignments(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    pickup_stop VARCHAR(150),
    boarding_status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (boarding_status IN ('PENDING', 'ON_BUS', 'ARRIVED', 'RETURN_ON_BUS', 'RETURNED', 'ABSENT')),
    marked_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    marked_at TIMESTAMPTZ,
    emergency_contact_override VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_event_student_bus UNIQUE (event_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_event_manifest_assignment ON public.event_bus_manifests(assignment_id, boarding_status);

-- 13. EVENT BUDGETS & EXPENSES
CREATE TABLE IF NOT EXISTS public.event_budgets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    category VARCHAR(50) NOT NULL, -- VENUE, STAGE, SOUND, LIGHTING, DECORATION, FOOD, TRANSPORT, PHOTOGRAPHY, AWARDS, PRINTING, MISC
    description TEXT,
    proposed_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (proposed_amount >= 0),
    approved_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (approved_amount >= 0),
    committed_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (committed_amount >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_event_budget_category UNIQUE (event_id, category)
);

CREATE INDEX IF NOT EXISTS idx_event_budgets_event ON public.event_budgets(event_id);

CREATE TABLE IF NOT EXISTS public.event_expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    budget_id UUID REFERENCES public.event_budgets(id) ON DELETE SET NULL,
    general_expense_id UUID REFERENCES public.expenses(id) ON DELETE SET NULL, -- Link to main expenses table
    category VARCHAR(50) NOT NULL,
    title VARCHAR(200) NOT NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    tax_amount NUMERIC(12,2) DEFAULT 0.00,
    vendor_name VARCHAR(150),
    invoice_number VARCHAR(100),
    payment_method VARCHAR(50) DEFAULT 'BANK_TRANSFER',
    receipt_url TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'PAID', 'REJECTED')),
    recorded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_expenses_event ON public.event_expenses(event_id, status);

-- 14. EVENT VENDORS & QUOTATION COMPARISONS
CREATE TABLE IF NOT EXISTS public.event_vendors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    vendor_name VARCHAR(150) NOT NULL,
    contact_person VARCHAR(100),
    phone VARCHAR(50),
    email VARCHAR(100),
    service_type VARCHAR(100) NOT NULL, -- Catering, Stage, Sound, Lighting, Photography, Uniforms/Trophies
    quotation_amount NUMERIC(12,2) NOT NULL CHECK (quotation_amount >= 0),
    quotation_document_url TEXT,
    rating NUMERIC(3,2) DEFAULT NULL,
    is_shortlisted BOOLEAN NOT NULL DEFAULT false,
    is_approved BOOLEAN NOT NULL DEFAULT false,
    final_contract_amount NUMERIC(12,2) DEFAULT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_vendors_event ON public.event_vendors(event_id, service_type);

-- 15. EVENT PAYMENTS & COLLECTIONS
CREATE TABLE IF NOT EXISTS public.event_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    registration_id UUID REFERENCES public.event_registrations(id) ON DELETE SET NULL,
    student_id UUID REFERENCES public.students(id) ON DELETE SET NULL,
    payer_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    payment_method VARCHAR(50) NOT NULL DEFAULT 'CASH' CHECK (payment_method IN ('UPI', 'ONLINE_GATEWAY', 'CASH', 'BANK_TRANSFER', 'WAIVED')),
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'PARTIAL', 'WAIVED', 'REFUNDED', 'FAILED')),
    receipt_no VARCHAR(100),
    gateway_reference VARCHAR(150),
    paid_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_payments_event ON public.event_payments(event_id, status);
CREATE INDEX IF NOT EXISTS idx_event_payments_student ON public.event_payments(student_id, event_id);

-- 16. COMPETITION ENGINE & HOUSE POINTS
CREATE TABLE IF NOT EXISTS public.event_competitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    category VARCHAR(100) NOT NULL, -- e.g. 'Athletics', 'Cultural', 'Academic', 'Coding'
    competition_type VARCHAR(30) NOT NULL DEFAULT 'INDIVIDUAL' CHECK (competition_type IN ('INDIVIDUAL', 'TEAM', 'HOUSE', 'CLASS', 'INTER_SCHOOL')),
    structure VARCHAR(30) NOT NULL DEFAULT 'SINGLE_ROUND' CHECK (structure IN ('SINGLE_ROUND', 'MULTI_ROUND', 'KNOCKOUT', 'POINTS_BASED')),
    rules TEXT,
    criteria JSONB NOT NULL DEFAULT '[{"name": "Execution", "max_score": 10}, {"name": "Technique", "max_score": 10}]'::jsonb,
    house_points_map JSONB NOT NULL DEFAULT '{"1st": 10, "2nd": 7, "3rd": 5, "participation": 1}'::jsonb,
    is_finalized BOOLEAN NOT NULL DEFAULT false,
    finalized_at TIMESTAMPTZ,
    finalized_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_competitions_event ON public.event_competitions(event_id);

CREATE TABLE IF NOT EXISTS public.event_competition_rounds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    competition_id UUID NOT NULL REFERENCES public.event_competitions(id) ON DELETE CASCADE,
    round_name VARCHAR(100) NOT NULL, -- Prelims, Quarter-Finals, Semi-Finals, Finals
    sequence INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(30) NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED')),
    scheduled_time TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_rounds_competition ON public.event_competition_rounds(competition_id, sequence);

CREATE TABLE IF NOT EXISTS public.event_competition_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    competition_id UUID NOT NULL REFERENCES public.event_competitions(id) ON DELETE CASCADE,
    round_id UUID REFERENCES public.event_competition_rounds(id) ON DELETE CASCADE,
    participant_id VARCHAR(100) NOT NULL, -- student UUID, team name, or external participant ID
    participant_name VARCHAR(150) NOT NULL,
    house_name VARCHAR(50),
    judge_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    criteria_scores JSONB NOT NULL, -- e.g. {"Execution": 9, "Technique": 8}
    total_score NUMERIC(7,2) NOT NULL,
    judge_remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_scores_comp ON public.event_competition_scores(competition_id, round_id);

CREATE TABLE IF NOT EXISTS public.event_competition_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    competition_id UUID NOT NULL REFERENCES public.event_competitions(id) ON DELETE CASCADE,
    participant_id VARCHAR(100) NOT NULL,
    participant_name VARCHAR(150) NOT NULL,
    student_id UUID REFERENCES public.students(id) ON DELETE SET NULL,
    house_name VARCHAR(50),
    rank_position INTEGER NOT NULL, -- 1 = 1st, 2 = 2nd, 3 = 3rd, 4 = Finalist/Participant
    rank_title VARCHAR(50) NOT NULL, -- Winner, Runner Up, 2nd Runner Up, Special Mention, Participant
    house_points_awarded INTEGER NOT NULL DEFAULT 0,
    certificate_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_event_comp_rank UNIQUE (competition_id, rank_position, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_event_results_comp ON public.event_competition_results(competition_id, rank_position);
CREATE INDEX IF NOT EXISTS idx_event_results_student ON public.event_competition_results(student_id);

-- 17. DIGITAL EVENT CERTIFICATES WITH VERIFICATION
CREATE TABLE IF NOT EXISTS public.event_certificates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    recipient_type VARCHAR(30) NOT NULL CHECK (recipient_type IN ('STUDENT', 'STAFF', 'VOLUNTEER', 'EXTERNAL')),
    student_id UUID REFERENCES public.students(id) ON DELETE SET NULL,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    recipient_name VARCHAR(150) NOT NULL,
    certificate_type VARCHAR(50) NOT NULL CHECK (certificate_type IN ('PARTICIPATION', 'WINNER', 'RUNNER_UP', 'VOLUNTEER', 'ORGANIZER', 'JUDGE', 'APPRECIATION')),
    competition_title VARCHAR(200),
    position_title VARCHAR(100), -- 1st Place, Runner Up, Volunteer
    serial_no VARCHAR(100) NOT NULL, -- EV-CERT-YYYY-XXXXX
    verification_token VARCHAR(64) NOT NULL, -- Opaque unique verification hash
    signatory_title VARCHAR(100) DEFAULT 'Principal',
    signatory_signature_url TEXT,
    template_config JSONB DEFAULT '{"theme": "gold", "border": "classic"}'::jsonb,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status VARCHAR(20) NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID', 'REVOKED')),
    revocation_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_event_cert_serial UNIQUE (school_id, serial_no),
    CONSTRAINT uq_event_cert_token UNIQUE (verification_token)
);

CREATE INDEX IF NOT EXISTS idx_event_certificates_token ON public.event_certificates(verification_token);
CREATE INDEX IF NOT EXISTS idx_event_certificates_student ON public.event_certificates(student_id, event_id);

-- 18. SAFETY & INCIDENT REPORTING
CREATE TABLE IF NOT EXISTS public.event_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    incident_type VARCHAR(50) NOT NULL, -- MEDICAL, INJURY, BEHAVIORAL, TRANSPORT_DELAY, LOST_PROPERTY, EMERGENCY, OTHER
    severity VARCHAR(20) NOT NULL DEFAULT 'LOW' CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    person_involved_type VARCHAR(30) NOT NULL DEFAULT 'STUDENT',
    student_id UUID REFERENCES public.students(id) ON DELETE SET NULL,
    person_name VARCHAR(150),
    incident_time TIMESTAMPTZ NOT NULL DEFAULT now(),
    location VARCHAR(200),
    description TEXT NOT NULL,
    action_taken TEXT,
    staff_present TEXT,
    attachments JSONB DEFAULT '[]'::jsonb,
    is_resolved BOOLEAN NOT NULL DEFAULT false,
    resolution_notes TEXT,
    resolved_at TIMESTAMPTZ,
    reported_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_incidents_event ON public.event_incidents(event_id, severity, is_resolved);

-- 19. DYNAMIC EVENT FEEDBACK
CREATE TABLE IF NOT EXISTS public.event_feedback_forms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    title VARCHAR(150) NOT NULL,
    target_audience VARCHAR(50) NOT NULL DEFAULT 'ALL', -- PARENT, STUDENT, STAFF, ALL
    questions JSONB NOT NULL DEFAULT '[
      {"id": "q1", "type": "RATING", "question": "Overall event experience (1-5 stars)", "required": true},
      {"id": "q2", "type": "CHOICE", "question": "How was the organization and timing?", "options": ["Excellent", "Good", "Needs Improvement"], "required": true},
      {"id": "q3", "type": "TEXT", "question": "Any suggestions or highlights?", "required": false}
    ]'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_feedback_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    form_id UUID REFERENCES public.event_feedback_forms(id) ON DELETE CASCADE,
    responder_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    responder_role VARCHAR(50) NOT NULL DEFAULT 'PARENT',
    answers JSONB NOT NULL,
    rating_score INTEGER CHECK (rating_score BETWEEN 1 AND 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_feedback_responses_event ON public.event_feedback_responses(event_id, rating_score);

-- 20. EVENT CLOSURE CHECKLIST & EXECUTIVE REPORTS
CREATE TABLE IF NOT EXISTS public.event_closure_checklists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    item_key VARCHAR(50) NOT NULL,
    label VARCHAR(150) NOT NULL,
    is_completed BOOLEAN NOT NULL DEFAULT false,
    verified_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ,
    notes TEXT,
    CONSTRAINT uq_event_closure_item UNIQUE (event_id, item_key)
);

CREATE TABLE IF NOT EXISTS public.event_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    generated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    report_title VARCHAR(200) NOT NULL,
    report_data JSONB NOT NULL, -- Complete serialized snapshot of event metrics, financial variance, attendance, results, incidents
    pdf_document_url TEXT,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_event_report UNIQUE (event_id)
);

CREATE INDEX IF NOT EXISTS idx_event_reports_event ON public.event_reports(event_id);

-- 21. IMMUTABLE EVENT AUDIT LOGS
CREATE TABLE IF NOT EXISTS public.event_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    event_id UUID REFERENCES public.events(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL, -- EVENT_CREATED, STATUS_CHANGED, CONSENT_SUBMITTED, PASS_SCANNED, RESULT_FINALIZED, CERTIFICATE_ISSUED, EVENT_CLOSED
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(100),
    previous_state JSONB,
    new_state JSONB,
    ip_address VARCHAR(45),
    details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_audit_event ON public.event_audit_logs(school_id, event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_audit_actor ON public.event_audit_logs(actor_user_id, created_at DESC);

-- 22. SEED SYSTEM EVENT TEMPLATES FOR EVERY ACTIVE SCHOOL
DO $$
DECLARE
    s_id INTEGER;
BEGIN
    FOR s_id IN SELECT id FROM public.schools LOOP
        IF NOT EXISTS (SELECT 1 FROM public.event_templates WHERE school_id = s_id AND is_system = true AND category = 'TRIP') THEN
            INSERT INTO public.event_templates (
                school_id, name, category, description, icon, color, is_system,
                default_configuration,
                default_teams,
                default_tasks,
                default_budget_categories,
                default_consent_disclaimers
            ) VALUES (
                s_id, 'Educational Field Trip', 'TRIP', 'Field visit and educational excursion with parent consent, bus manifests, and emergency readiness.', 'bus-outline', '#0284C7', true,
                '{
                  "modules": {
                    "registration": true, "consent": true, "payments": true, "transport": true,
                    "competition": false, "attendance": true, "qr_passes": true, "guests": false,
                    "volunteers": true, "tasks": true, "vendors": true, "expenses": true,
                    "certificates": true, "gallery": true, "feedback": true
                  },
                  "constraints": { "max_activities_per_student": 1, "capacity_limit": 100, "fee_amount": 350 }
                }'::jsonb,
                '[{"name": "Transport & Logistics", "lead_title": "Transport Head"}, {"name": "Safety & First Aid", "lead_title": "Medical Lead"}, {"name": "Student Care", "lead_title": "Head Teacher"}]'::jsonb,
                '[{"title": "Obtain parent consent slips", "priority": "URGENT"}, {"title": "Finalize bus roster and drivers", "priority": "HIGH"}, {"title": "Verify emergency first aid kits", "priority": "HIGH"}]'::jsonb,
                '["Transport", "Food", "Entry Tickets", "First Aid", "Misc"]'::jsonb,
                '["I acknowledge my child is medically fit to travel", "I authorize emergency medical assistance if needed", "I agree to school transport safety guidelines"]'::jsonb
            );
        END IF;

        IF NOT EXISTS (SELECT 1 FROM public.event_templates WHERE school_id = s_id AND is_system = true AND category = 'SPORTS_DAY') THEN
            INSERT INTO public.event_templates (
                school_id, name, category, description, icon, color, is_system,
                default_configuration,
                default_teams,
                default_tasks,
                default_budget_categories,
                default_consent_disclaimers
            ) VALUES (
                s_id, 'Annual Sports Meet', 'SPORTS_DAY', 'School-wide sports day with multi-activity registrations, house points, competitions, and medals.', 'trophy-outline', '#E11D48', true,
                '{
                  "modules": {
                    "registration": true, "consent": false, "payments": false, "transport": false,
                    "competition": true, "attendance": true, "qr_passes": true, "guests": true,
                    "volunteers": true, "tasks": true, "vendors": true, "expenses": true,
                    "certificates": true, "gallery": true, "feedback": true
                  },
                  "constraints": { "max_activities_per_student": 3, "capacity_limit": null, "fee_amount": 0 }
                }'::jsonb,
                '[{"name": "Ground & Equipment", "lead_title": "PET Head"}, {"name": "Scoring & House Points", "lead_title": "Scoring Chief"}, {"name": "Discipline & Crowd Control", "lead_title": "Discipline Lead"}]'::jsonb,
                '[{"title": "Track marking and ground preparation", "priority": "HIGH"}, {"title": "Medals and certificates procurement", "priority": "HIGH"}, {"title": "Scoreboard and sound system setup", "priority": "MEDIUM"}]'::jsonb,
                '["Medals & Trophies", "Ground Preparation", "Sound & Stage", "Refreshments", "Printing"]'::jsonb,
                '[]'::jsonb
            );
        END IF;

        IF NOT EXISTS (SELECT 1 FROM public.event_templates WHERE school_id = s_id AND is_system = true AND category = 'ANNUAL_DAY') THEN
            INSERT INTO public.event_templates (
                school_id, name, category, description, icon, color, is_system,
                default_configuration,
                default_teams,
                default_tasks,
                default_budget_categories,
                default_consent_disclaimers
            ) VALUES (
                s_id, 'Annual Day Celebration', 'ANNUAL_DAY', 'Grand annual cultural celebration with guest ticketing, performances, vendor stage setup, and awards.', 'sparkles-outline', '#7C3AED', true,
                '{
                  "modules": {
                    "registration": true, "consent": false, "payments": false, "transport": false,
                    "competition": false, "attendance": true, "qr_passes": true, "guests": true,
                    "volunteers": true, "tasks": true, "vendors": true, "expenses": true,
                    "certificates": true, "gallery": true, "feedback": true
                  },
                  "constraints": { "max_activities_per_student": 2, "capacity_limit": null, "fee_amount": 0 }
                }'::jsonb,
                '[{"name": "Stage & Lighting", "lead_title": "Stage Director"}, {"name": "Hospitality & VIP Guests", "lead_title": "Protocol Lead"}, {"name": "Cultural Choreography", "lead_title": "Dance & Music Head"}]'::jsonb,
                '[{"title": "Stage backdrop and sound system confirmation", "priority": "HIGH"}, {"title": "Costume fitting and rehearsal schedule", "priority": "HIGH"}, {"title": "VIP guest invitations and QR passes", "priority": "MEDIUM"}]'::jsonb,
                '["Stage & Lighting", "Sound System", "Costumes & Makeup", "Guest Hospitality", "Photography & Video", "Refreshments"]'::jsonb,
                '[]'::jsonb
            );
        END IF;

        IF NOT EXISTS (SELECT 1 FROM public.event_templates WHERE school_id = s_id AND is_system = true AND category = 'SCIENCE_FAIR') THEN
            INSERT INTO public.event_templates (
                school_id, name, category, description, icon, color, is_system,
                default_configuration,
                default_teams,
                default_tasks,
                default_budget_categories,
                default_consent_disclaimers
            ) VALUES (
                s_id, 'Science & Innovation Expo', 'SCIENCE_FAIR', 'Exhibition and competition with project teams, judge scoring, criteria evaluations, and winner certificates.', 'bulb-outline', '#10B981', true,
                '{
                  "modules": {
                    "registration": true, "consent": false, "payments": false, "transport": false,
                    "competition": true, "attendance": true, "qr_passes": true, "guests": true,
                    "volunteers": true, "tasks": true, "vendors": false, "expenses": true,
                    "certificates": true, "gallery": true, "feedback": true
                  },
                  "constraints": { "max_activities_per_student": 1, "capacity_limit": null, "fee_amount": 0 }
                }'::jsonb,
                '[{"name": "Judging & Evaluation", "lead_title": "Science HOD"}, {"name": "Floor Layout & Stalls", "lead_title": "Logistics Lead"}]'::jsonb,
                '[{"title": "Allocate project stall numbers", "priority": "HIGH"}, {"title": "Brief external judges on evaluation rubrics", "priority": "HIGH"}, {"title": "Print participation certificates", "priority": "MEDIUM"}]'::jsonb,
                '["Project Stalls", "Awards & Certificates", "Judge Honorarium", "Refreshments"]'::jsonb,
                '[]'::jsonb
            );
        END IF;
    END LOOP;
END $$;

COMMIT;
