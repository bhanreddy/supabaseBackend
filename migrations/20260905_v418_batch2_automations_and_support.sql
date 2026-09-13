-- ============================================================
-- SchoolIMS v4.1.8 — Batch 2: Intelligence & Connected Workflows
-- ============================================================

-- 1. ATTENDANCE INTERVENTIONS
CREATE TABLE IF NOT EXISTS public.attendance_interventions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    status VARCHAR(30) NOT NULL DEFAULT 'not_reviewed' CHECK (status IN ('not_reviewed', 'parent_contacted', 'monitoring', 'resolved')),
    notes TEXT,
    updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_attendance_interventions_student UNIQUE (school_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_att_interventions_school ON public.attendance_interventions(school_id, status);

ALTER TABLE public.attendance_interventions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_tenant_rls_policy') THEN
    PERFORM create_tenant_rls_policy('attendance_interventions');
  END IF;
END $$;

-- 2. SUBSTITUTION AUTOMATION FIELDS
ALTER TABLE public.timetable_substitutions
  ADD COLUMN IF NOT EXISTS is_auto_suggested BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS leave_application_id UUID REFERENCES public.leave_applications(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_substitutions_leave ON public.timetable_substitutions(school_id, leave_application_id) WHERE leave_application_id IS NOT NULL;

-- 3. TRANSPORT SAFETY & SAFEGUARDING INCIDENTS
ALTER TABLE public.buses
  ADD COLUMN IF NOT EXISTS speed_limit_override INTEGER;

ALTER TABLE public.transport_routes
  ADD COLUMN IF NOT EXISTS speed_limit_override INTEGER;

CREATE TABLE IF NOT EXISTS public.transport_safety_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    incident_type VARCHAR(30) NOT NULL CHECK (incident_type IN ('overspeed', 'sos', 'safeguarding_anomaly')),
    vehicle_id UUID REFERENCES public.buses(id) ON DELETE SET NULL,
    driver_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
    route_id UUID REFERENCES public.transport_routes(id) ON DELETE SET NULL,
    trip_id UUID REFERENCES public.trips(id) ON DELETE SET NULL,
    student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
    threshold_value NUMERIC,
    max_value NUMERIC,
    avg_value NUMERIC,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    duration_seconds INTEGER,
    start_latitude DOUBLE PRECISION,
    start_longitude DOUBLE PRECISION,
    status VARCHAR(30) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'recovered', 'verification_pending', 'acknowledged', 'resolved', 'false_positive')),
    acknowledged_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    acknowledged_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    resolution_notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trans_safety_school_status ON public.transport_safety_incidents(school_id, status);
CREATE INDEX IF NOT EXISTS idx_trans_safety_school_type_date ON public.transport_safety_incidents(school_id, incident_type, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_trans_safety_student ON public.transport_safety_incidents(school_id, student_id) WHERE student_id IS NOT NULL;

ALTER TABLE public.transport_safety_incidents ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_tenant_rls_policy') THEN
    PERFORM create_tenant_rls_policy('transport_safety_incidents');
  END IF;
END $$;

-- 4. PARENT SUPPORT HELP DESK
CREATE TABLE IF NOT EXISTS public.ticket_number_counters (
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    year INTEGER NOT NULL,
    last_number BIGINT NOT NULL DEFAULT 0 CHECK (last_number >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (school_id, year)
);

ALTER TABLE public.ticket_number_counters ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.get_next_ticket_number(p_school_id INTEGER)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_year INTEGER := EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER;
    v_next_number BIGINT;
BEGIN
    IF p_school_id IS NULL THEN
        RAISE EXCEPTION 'school_id is required to generate a ticket number';
    END IF;

    INSERT INTO public.ticket_number_counters AS counters (
        school_id,
        year,
        last_number,
        updated_at
    )
    VALUES (
        p_school_id,
        v_year,
        1,
        NOW()
    )
    ON CONFLICT (school_id, year) DO UPDATE
    SET last_number = counters.last_number + 1,
        updated_at = NOW()
    RETURNING counters.last_number INTO v_next_number;

    RETURN 'TKT-' || v_year::TEXT || '-' || LPAD(v_next_number::TEXT, 5, '0');
END;
$$;

CREATE TABLE IF NOT EXISTS public.support_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    ticket_number VARCHAR(32) NOT NULL,
    created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    parent_id UUID NOT NULL REFERENCES public.parents(id) ON DELETE CASCADE,
    student_id UUID REFERENCES public.students(id) ON DELETE SET NULL,
    category VARCHAR(50) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    priority VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    status VARCHAR(30) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting_for_parent', 'resolved', 'closed')),
    assigned_to UUID REFERENCES public.users(id) ON DELETE SET NULL,
    assigned_department VARCHAR(50),
    response_due_at TIMESTAMPTZ,
    resolution_due_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT uq_support_ticket_number UNIQUE (school_id, ticket_number)
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_school_status ON public.support_tickets(school_id, status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_school_parent ON public.support_tickets(school_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned ON public.support_tickets(school_id, assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_tickets_category ON public.support_tickets(school_id, category);

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_tenant_rls_policy') THEN
    PERFORM create_tenant_rls_policy('support_tickets');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.support_ticket_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    sender_role VARCHAR(30) NOT NULL,
    message TEXT NOT NULL,
    attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_internal BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket ON public.support_ticket_messages(ticket_id, created_at ASC);

ALTER TABLE public.support_ticket_messages ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_tenant_rls_policy') THEN
    PERFORM create_tenant_rls_policy('support_ticket_messages');
  END IF;
END $$;

-- 5. PERMISSIONS FOR BATCH 2
INSERT INTO permissions (school_id, code, name)
SELECT s.id, v.code, v.name
FROM schools s
CROSS JOIN (VALUES
  ('attendance.intervene',       'Manage Attendance Interventions'),
  ('transport.safety.view',      'View Transport Safety & Incidents'),
  ('transport.safety.manage',    'Manage Transport Safety Incidents'),
  ('udise.view',                 'View UDISE Readiness'),
  ('udise.export',               'Export UDISE Compliance Data'),
  ('support.view',               'View Support Tickets'),
  ('support.manage',             'Manage & Assign Support Tickets'),
  ('support.reply',              'Reply to Support Tickets')
) AS v(code, name)
WHERE NOT EXISTS (
  SELECT 1 FROM permissions p
  WHERE p.school_id = s.id AND p.code = v.code
);

-- Grant to admin & principal roles
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM permissions p
JOIN roles r
  ON r.school_id = p.school_id
 AND r.code IN ('admin', 'principal')
WHERE p.code IN (
  'attendance.intervene',
  'transport.safety.view',
  'transport.safety.manage',
  'udise.view',
  'udise.export',
  'support.view',
  'support.manage',
  'support.reply'
)
AND NOT EXISTS (
  SELECT 1 FROM role_permissions rp
  WHERE rp.role_id = r.id
    AND rp.permission_id = p.id
    AND rp.school_id = p.school_id
);
