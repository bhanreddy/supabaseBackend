-- Migration: 20260913_v433_premium_admission_workflow_system.sql
-- Production-Grade Multi-Tenant Admission Enquiry & Automated Admission Workflow System

BEGIN;

-- 1. ADMISSION SETTINGS TABLE
CREATE TABLE IF NOT EXISTS public.admission_settings (
    school_id INTEGER PRIMARY KEY REFERENCES public.schools(id) ON DELETE CASCADE,
    is_admission_open BOOLEAN NOT NULL DEFAULT true,
    active_academic_year_id UUID REFERENCES public.academic_years(id) ON DELETE SET NULL,
    admission_number_prefix VARCHAR(20) NOT NULL DEFAULT 'ADM',
    admission_number_format VARCHAR(50) NOT NULL DEFAULT 'ADM/YY/NNNN',
    admission_number_seq INTEGER NOT NULL DEFAULT 1,
    application_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    allow_online_payment BOOLEAN NOT NULL DEFAULT false,
    duplicate_detection_rules JSONB NOT NULL DEFAULT '{
        "check_phone": true,
        "check_email": true,
        "check_name_dob": true,
        "check_previous_school": true
    }'::jsonb,
    sla_rules JSONB NOT NULL DEFAULT '{
        "document_verification_hours": 24,
        "review_hours": 48,
        "approval_hours": 24,
        "interview_lead_hours": 48
    }'::jsonb,
    scoring_weights JSONB NOT NULL DEFAULT '{
        "academic": 30,
        "interview": 30,
        "entrance_test": 25,
        "documents": 10,
        "other": 5
    }'::jsonb,
    custom_form_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. ADMISSION WORKFLOW STAGES TABLE (Configurable per school)
CREATE TABLE IF NOT EXISTS public.admission_workflow_stages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    sequence_order INTEGER NOT NULL DEFAULT 1,
    is_mandatory BOOLEAN NOT NULL DEFAULT true,
    is_active BOOLEAN NOT NULL DEFAULT true,
    requires_approval BOOLEAN NOT NULL DEFAULT false,
    requires_documents BOOLEAN NOT NULL DEFAULT false,
    requires_interview BOOLEAN NOT NULL DEFAULT false,
    requires_test BOOLEAN NOT NULL DEFAULT false,
    requires_fee BOOLEAN NOT NULL DEFAULT false,
    responsible_role VARCHAR(50) NOT NULL DEFAULT 'staff',
    sla_hours INTEGER NOT NULL DEFAULT 24,
    auto_transition BOOLEAN NOT NULL DEFAULT false,
    color VARCHAR(20) NOT NULL DEFAULT '#4F46E5',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_school_workflow_stage UNIQUE (school_id, code)
);

CREATE INDEX IF NOT EXISTS idx_admission_stages_school ON public.admission_workflow_stages(school_id, sequence_order);

-- 3. ADMISSION DOCUMENT REQUIREMENTS TABLE (Configurable per school and class)
CREATE TABLE IF NOT EXISTS public.admission_document_requirements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    document_type VARCHAR(50) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    is_mandatory BOOLEAN NOT NULL DEFAULT true,
    applicable_classes JSONB DEFAULT '[]'::jsonb, -- Empty array = all classes
    allowed_extensions VARCHAR(20)[] NOT NULL DEFAULT ARRAY['pdf', 'jpg', 'jpeg', 'png'],
    max_size_mb NUMERIC(4,1) NOT NULL DEFAULT 5.0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_school_admission_doc_req UNIQUE (school_id, document_type)
);

CREATE INDEX IF NOT EXISTS idx_admission_doc_reqs_school ON public.admission_document_requirements(school_id);

-- 4. ADMISSION CAPACITIES TABLE
CREATE TABLE IF NOT EXISTS public.admission_capacities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    academic_year_id UUID REFERENCES public.academic_years(id) ON DELETE SET NULL,
    total_capacity INTEGER NOT NULL DEFAULT 40,
    reserved_seats INTEGER NOT NULL DEFAULT 0,
    allow_waitlist BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_admission_capacity UNIQUE (school_id, class_id, academic_year_id)
);

CREATE INDEX IF NOT EXISTS idx_admission_capacities_school ON public.admission_capacities(school_id, class_id);

-- 5. ADMISSION ENQUIRIES TABLE (Initial lightweight prospective student leads)
CREATE TABLE IF NOT EXISTS public.admission_enquiries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    enquiry_no VARCHAR(30) NOT NULL,
    parent_name VARCHAR(100) NOT NULL,
    student_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(100),
    interested_class_id UUID REFERENCES public.classes(id) ON DELETE SET NULL,
    academic_year_id UUID REFERENCES public.academic_years(id) ON DELETE SET NULL,
    source VARCHAR(50) NOT NULL DEFAULT 'Website',
    status VARCHAR(30) NOT NULL DEFAULT 'NEW', -- NEW, CONTACTED, CONVERTED_TO_APPLICATION, CLOSED, EXPIRED
    assigned_to UUID REFERENCES public.users(id) ON DELETE SET NULL,
    notes TEXT,
    converted_application_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_admission_enquiry_no UNIQUE (school_id, enquiry_no)
);

CREATE INDEX IF NOT EXISTS idx_admission_enquiries_school_status ON public.admission_enquiries(school_id, status);
CREATE INDEX IF NOT EXISTS idx_admission_enquiries_phone ON public.admission_enquiries(school_id, phone);

-- 6. ADMISSION APPLICATIONS TABLE (Core applicant pipeline entity)
CREATE TABLE IF NOT EXISTS public.admission_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    application_no VARCHAR(30) NOT NULL,
    enquiry_id UUID REFERENCES public.admission_enquiries(id) ON DELETE SET NULL,
    applicant_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    status VARCHAR(40) NOT NULL DEFAULT 'APPLICATION_STARTED',
    current_stage_id UUID REFERENCES public.admission_workflow_stages(id) ON DELETE SET NULL,
    
    -- Student Details
    student_first_name VARCHAR(60) NOT NULL,
    student_middle_name VARCHAR(60),
    student_last_name VARCHAR(60),
    dob DATE,
    gender_id SMALLINT REFERENCES public.genders(id),
    blood_group_id SMALLINT REFERENCES public.blood_groups(id),
    religion_id SMALLINT REFERENCES public.religions(id),
    category_id SMALLINT REFERENCES public.student_categories(id),
    nationality_code CHAR(2) REFERENCES public.countries(code) DEFAULT 'IN',
    aadhaar_number VARCHAR(12),
    student_photo_url TEXT,
    
    -- Academic Placement
    applying_class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE RESTRICT,
    academic_year_id UUID NOT NULL REFERENCES public.academic_years(id) ON DELETE RESTRICT,
    assigned_section_id UUID REFERENCES public.sections(id) ON DELETE SET NULL,
    
    -- Parent / Guardian Details
    father_name VARCHAR(100),
    father_phone VARCHAR(20),
    father_email VARCHAR(100),
    father_occupation VARCHAR(100),
    mother_name VARCHAR(100),
    mother_phone VARCHAR(20),
    mother_email VARCHAR(100),
    mother_occupation VARCHAR(100),
    guardian_name VARCHAR(100),
    guardian_phone VARCHAR(20),
    guardian_email VARCHAR(100),
    guardian_relation VARCHAR(50),
    primary_contact VARCHAR(20) NOT NULL DEFAULT 'father', -- father, mother, guardian
    
    -- Address
    address_line1 TEXT,
    address_line2 TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    pincode VARCHAR(10),
    
    -- Previous School Details
    has_previous_school BOOLEAN DEFAULT false,
    previous_school_name VARCHAR(150),
    previous_board VARCHAR(50),
    previous_class VARCHAR(30),
    previous_academic_year VARCHAR(20),
    tc_number VARCHAR(50),
    
    -- Logistics & Special Needs
    transport_required BOOLEAN DEFAULT false,
    pickup_location VARCHAR(150),
    preferred_route VARCHAR(100),
    hostel_required BOOLEAN DEFAULT false,
    sibling_studying_here BOOLEAN DEFAULT false,
    sibling_name VARCHAR(100),
    sibling_class VARCHAR(50),
    sibling_admission_no VARCHAR(30),
    medical_conditions TEXT,
    emergency_contact_name VARCHAR(100),
    emergency_contact_phone VARCHAR(20),
    
    -- Custom Form Fields & Source
    custom_data JSONB DEFAULT '{}'::jsonb,
    source VARCHAR(50) NOT NULL DEFAULT 'Website',
    assigned_staff_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL', -- NORMAL, HIGH, URGENT
    
    -- Evaluation & Decision
    scoring_breakdown JSONB DEFAULT '{}'::jsonb,
    total_score NUMERIC(5,2) DEFAULT 0.00,
    decision VARCHAR(30) NOT NULL DEFAULT 'PENDING', -- PENDING, APPROVED, CONDITIONALLY_APPROVED, WAITLISTED, REJECTED
    decision_reason TEXT,
    conditional_requirements TEXT,
    decision_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    decision_at TIMESTAMPTZ,
    waitlist_rank INTEGER,
    
    -- SLA & Timestamps
    sla_due_at TIMESTAMPTZ,
    is_sla_breached BOOLEAN NOT NULL DEFAULT false,
    submitted_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    
    -- Conversion Record
    converted_student_id UUID REFERENCES public.students(id) ON DELETE SET NULL,
    converted_at TIMESTAMPTZ,
    converted_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT uq_admission_application_no UNIQUE (school_id, application_no)
);

CREATE INDEX IF NOT EXISTS idx_admission_apps_school_status ON public.admission_applications(school_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admission_apps_applicant ON public.admission_applications(applicant_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admission_apps_class ON public.admission_applications(school_id, applying_class_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admission_apps_sla ON public.admission_applications(school_id, is_sla_breached, sla_due_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admission_apps_phone ON public.admission_applications(school_id, father_phone, mother_phone);

-- 7. ADMISSION APPLICATION STAGE HISTORY TABLE (Immutable audit transition trail)
CREATE TABLE IF NOT EXISTS public.admission_application_stage_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES public.admission_applications(id) ON DELETE CASCADE,
    from_stage_id UUID REFERENCES public.admission_workflow_stages(id) ON DELETE SET NULL,
    to_stage_id UUID REFERENCES public.admission_workflow_stages(id) ON DELETE SET NULL,
    from_status VARCHAR(40),
    to_status VARCHAR(40) NOT NULL,
    actor_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    remarks TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    entered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admission_stage_history ON public.admission_application_stage_history(application_id, entered_at DESC);

-- 8. ADMISSION DOCUMENTS TABLE
CREATE TABLE IF NOT EXISTS public.admission_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES public.admission_applications(id) ON DELETE CASCADE,
    document_type VARCHAR(50) NOT NULL,
    title VARCHAR(200) NOT NULL,
    file_url TEXT NOT NULL,
    file_size_bytes BIGINT,
    mime_type VARCHAR(100),
    status VARCHAR(30) NOT NULL DEFAULT 'UPLOADED', -- PENDING, UPLOADED, UNDER_REVIEW, VERIFIED, REJECTED, REUPLOAD_REQUIRED, EXPIRED
    verified_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ,
    rejection_reason TEXT,
    replacement_requested BOOLEAN NOT NULL DEFAULT false,
    version INTEGER NOT NULL DEFAULT 1,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admission_docs_app ON public.admission_documents(school_id, application_id, document_type);
CREATE INDEX IF NOT EXISTS idx_admission_docs_status ON public.admission_documents(school_id, status);

-- 9. ADMISSION TASKS TABLE (Operational staff workflow tasks)
CREATE TABLE IF NOT EXISTS public.admission_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES public.admission_applications(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    task_type VARCHAR(50) NOT NULL, -- VERIFY_DOCUMENTS, SCHEDULE_INTERVIEW, CONDUCT_INTERVIEW, ACADEMIC_REVIEW, PRINCIPAL_APPROVAL, COLLECT_FEE, CONVERT_STUDENT
    assigned_role VARCHAR(50) NOT NULL DEFAULT 'staff',
    assigned_to UUID REFERENCES public.users(id) ON DELETE SET NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING', -- PENDING, IN_PROGRESS, COMPLETED, CANCELLED, ESCALATED
    due_at TIMESTAMPTZ,
    is_sla_breached BOOLEAN NOT NULL DEFAULT false,
    completed_at TIMESTAMPTZ,
    completed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    escalated_to UUID REFERENCES public.users(id) ON DELETE SET NULL,
    escalated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admission_tasks_school_status ON public.admission_tasks(school_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_admission_tasks_assigned ON public.admission_tasks(school_id, assigned_to);

-- 10. ADMISSION INTERVIEWS & TESTS TABLE
CREATE TABLE IF NOT EXISTS public.admission_interviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES public.admission_applications(id) ON DELETE CASCADE,
    interview_type VARCHAR(30) NOT NULL DEFAULT 'INTERVIEW', -- INTERVIEW, ENTRANCE_TEST, INTERACTION
    title VARCHAR(150) NOT NULL,
    scheduled_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    location VARCHAR(150) NOT NULL DEFAULT 'Principal Office',
    mode VARCHAR(20) NOT NULL DEFAULT 'OFFLINE', -- OFFLINE, ONLINE
    online_meeting_url TEXT,
    interviewer_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'SCHEDULED', -- SCHEDULED, COMPLETED, CANCELLED, RESCHEDULED, ABSENT
    rubric_scores JSONB DEFAULT '{
        "communication": 0,
        "confidence": 0,
        "academic_readiness": 0,
        "behaviour": 0
    }'::jsonb,
    total_score NUMERIC(5,2) DEFAULT 0.00,
    recommendation VARCHAR(30) DEFAULT 'REVIEW_FURTHER', -- APPROVE, WAITLIST, REJECT, REVIEW_FURTHER
    feedback TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admission_interviews_app ON public.admission_interviews(school_id, application_id);
CREATE INDEX IF NOT EXISTS idx_admission_interviews_date ON public.admission_interviews(school_id, scheduled_date, status);

-- 11. ADMISSION INTERNAL NOTES TABLE (Staff-only, strictly private)
CREATE TABLE IF NOT EXISTS public.admission_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES public.admission_applications(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    note TEXT NOT NULL,
    priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL', -- NORMAL, HIGH, FLAG
    is_private BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admission_notes_app ON public.admission_notes(application_id, created_at DESC);

-- 12. ADMISSION COMMUNICATIONS TABLE (Unified applicant messaging)
CREATE TABLE IF NOT EXISTS public.admission_communications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES public.admission_applications(id) ON DELETE CASCADE,
    sender_type VARCHAR(20) NOT NULL DEFAULT 'STAFF', -- STAFF, SYSTEM, APPLICANT
    sender_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    message_type VARCHAR(30) NOT NULL DEFAULT 'STATUS_UPDATE', -- STATUS_UPDATE, DOCUMENT_REQUEST, INTERVIEW_INVITE, GENERAL_MESSAGE, DECISION_NOTICE
    subject VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    channels VARCHAR(20)[] NOT NULL DEFAULT ARRAY['IN_APP'],
    is_read BOOLEAN NOT NULL DEFAULT false,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admission_comms_app ON public.admission_communications(application_id, created_at DESC);

-- 13. ADMISSION AUDIT LOGS TABLE
CREATE TABLE IF NOT EXISTS public.admission_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    application_id UUID REFERENCES public.admission_applications(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    actor_role VARCHAR(50),
    action VARCHAR(100) NOT NULL,
    from_state VARCHAR(50),
    to_state VARCHAR(50),
    reason TEXT,
    details JSONB DEFAULT '{}'::jsonb,
    ip_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admission_audit_app ON public.admission_audit_logs(application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admission_audit_school ON public.admission_audit_logs(school_id, created_at DESC);

-- 14. SEED APPLICANT ROLE INTO ROLES TABLE
INSERT INTO public.roles (school_id, code, name, is_system)
SELECT s.id, 'applicant', 'Admission Applicant', true
FROM public.schools s
WHERE NOT EXISTS (
    SELECT 1 FROM public.roles r
    WHERE r.school_id = s.id AND r.code = 'applicant' AND r.deleted_at IS NULL
);

-- 15. SEED ADMISSION PERMISSIONS
INSERT INTO public.permissions (school_id, code, name)
SELECT s.id, p.code, p.name
FROM public.schools s
CROSS JOIN (VALUES
    ('admissions.view', 'View Admission Pipeline & Applications'),
    ('admissions.create', 'Create Admission Enquiries & Applications'),
    ('admissions.edit', 'Edit Admission Applications'),
    ('admissions.verify', 'Verify or Reject Admission Documents'),
    ('admissions.schedule', 'Schedule & Evaluate Interviews and Tests'),
    ('admissions.approve', 'Final Admission Decision & Approval'),
    ('admissions.convert', 'Convert Approved Applicant to Active Student'),
    ('admissions.settings', 'Manage Admission Workflow & Document Rules')
) AS p(code, name)
WHERE NOT EXISTS (
    SELECT 1 FROM public.permissions perm
    WHERE perm.school_id = s.id AND perm.code = p.code AND perm.deleted_at IS NULL
);

-- Grant all admission permissions to admin and principal roles
INSERT INTO public.role_permissions (school_id, role_id, permission_id)
SELECT r.school_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.school_id = r.school_id
WHERE r.code IN ('admin', 'principal', 'management')
  AND p.code LIKE 'admissions.%'
  AND r.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp
    WHERE rp.school_id = r.school_id AND rp.role_id = r.id AND rp.permission_id = p.id
  );

-- Grant operational permissions to staff role
INSERT INTO public.role_permissions (school_id, role_id, permission_id)
SELECT r.school_id, r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.school_id = r.school_id
WHERE r.code = 'staff'
  AND p.code IN ('admissions.view', 'admissions.create', 'admissions.edit', 'admissions.verify', 'admissions.schedule')
  AND r.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permissions rp
    WHERE rp.school_id = r.school_id AND rp.role_id = r.id AND rp.permission_id = p.id
  );

-- 16. SEED DEFAULT ADMISSION SETTINGS FOR EACH SCHOOL
INSERT INTO public.admission_settings (school_id, is_admission_open, admission_number_prefix, admission_number_format)
SELECT s.id, true, 'ADM', 'ADM/YY/NNNN'
FROM public.schools s
ON CONFLICT (school_id) DO NOTHING;

-- 17. SEED CANONICAL WORKFLOW STAGES FOR EACH SCHOOL
INSERT INTO public.admission_workflow_stages (
    school_id, code, name, description, sequence_order, is_mandatory, is_active,
    requires_approval, requires_documents, requires_interview, requires_test, requires_fee,
    responsible_role, sla_hours, color
)
SELECT s.id, stage.code, stage.name, stage.description, stage.sequence_order, stage.is_mandatory, true,
       stage.requires_approval, stage.requires_documents, stage.requires_interview, stage.requires_test, stage.requires_fee,
       stage.responsible_role, stage.sla_hours, stage.color
FROM public.schools s
CROSS JOIN (VALUES
    ('ENQUIRY', 'Enquiry Received', 'Initial prospective student enquiry lead', 1, false, false, false, false, false, false, 'staff', 24, '#64748B'),
    ('APPLICATION', 'Application Started', 'Digital application form completed & submitted', 2, true, false, false, false, false, false, 'applicant', 48, '#3B82F6'),
    ('DOCUMENTS', 'Document Collection', 'Upload mandatory certificates & photographs', 3, true, false, true, false, false, false, 'applicant', 48, '#8B5CF6'),
    ('VERIFICATION', 'Document Verification', 'Staff audit of uploaded certificates & records', 4, true, false, true, false, false, false, 'staff', 24, '#F59E0B'),
    ('INTERVIEW', 'Interaction / Interview', 'Student and parent interaction with management', 5, false, false, false, true, false, false, 'staff', 48, '#06B6D4'),
    ('REVIEW', 'Application Under Review', 'Comprehensive evaluation of academic and interview results', 6, true, false, false, false, false, false, 'principal', 24, '#6366F1'),
    ('APPROVAL', 'Management Decision', 'Final decision: Approve, Waitlist, or Conditional Approval', 7, true, true, false, false, false, false, 'principal', 24, '#10B981'),
    ('FEE_PENDING', 'Fee Confirmation', 'Payment of admission fee and seat reservation', 8, false, false, false, false, false, true, 'accounts', 48, '#D97706'),
    ('CONFIRMED', 'Admission Confirmed', 'Admission complete and eligible for student conversion', 9, true, false, false, false, false, false, 'admin', 24, '#059669')
) AS stage(code, name, description, sequence_order, is_mandatory, requires_approval, requires_documents, requires_interview, requires_test, requires_fee, responsible_role, sla_hours, color)
ON CONFLICT (school_id, code) DO NOTHING;

-- 18. SEED DEFAULT DOCUMENT REQUIREMENTS FOR EACH SCHOOL
INSERT INTO public.admission_document_requirements (
    school_id, document_type, display_name, description, is_mandatory, max_size_mb
)
SELECT s.id, d.document_type, d.display_name, d.description, d.is_mandatory, d.max_size_mb
FROM public.schools s
CROSS JOIN (VALUES
    ('BIRTH_CERTIFICATE', 'Birth Certificate', 'Government-issued birth certificate or municipal record', true, 5.0),
    ('TRANSFER_CERTIFICATE', 'Transfer Certificate (TC)', 'Original TC from previously attended recognized school', true, 5.0),
    ('PREVIOUS_MARKSHEET', 'Previous Marksheet / Progress Card', 'Report card or grade sheet of last completed grade', true, 5.0),
    ('PASSPORT_PHOTO', 'Passport Size Photograph', 'Recent color photo of applicant with light background', true, 2.0),
    ('AADHAAR_CARD', 'Aadhaar / National Identity Card', 'Student Aadhaar card copy for official UDISE registration', false, 5.0),
    ('CASTE_CERTIFICATE', 'Community / Caste Certificate', 'Official certificate if applicable for statutory categories', false, 5.0)
) AS d(document_type, display_name, description, is_mandatory, max_size_mb)
ON CONFLICT (school_id, document_type) DO NOTHING;

-- 19. ENABLE ROW LEVEL SECURITY
ALTER TABLE public.admission_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_workflow_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_document_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_capacities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_application_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admission_audit_logs ENABLE ROW LEVEL SECURITY;

-- 20. GRANT ACCESS TO SERVICE ROLE
GRANT ALL ON TABLE public.admission_settings TO service_role;
GRANT ALL ON TABLE public.admission_workflow_stages TO service_role;
GRANT ALL ON TABLE public.admission_document_requirements TO service_role;
GRANT ALL ON TABLE public.admission_capacities TO service_role;
GRANT ALL ON TABLE public.admission_enquiries TO service_role;
GRANT ALL ON TABLE public.admission_applications TO service_role;
GRANT ALL ON TABLE public.admission_application_stage_history TO service_role;
GRANT ALL ON TABLE public.admission_documents TO service_role;
GRANT ALL ON TABLE public.admission_tasks TO service_role;
GRANT ALL ON TABLE public.admission_interviews TO service_role;
GRANT ALL ON TABLE public.admission_notes TO service_role;
GRANT ALL ON TABLE public.admission_communications TO service_role;
GRANT ALL ON TABLE public.admission_audit_logs TO service_role;

COMMIT;
