-- Migration: 20260913_v436_premium_omr_engine.sql
-- Description: Production OMR Engine subsystem for SchoolIMS with templates, versioned answer keys,
--              batches, scans, answers, review items, audit logs, and granular RBAC.

-- 1. OMR TEMPLATES
CREATE TABLE IF NOT EXISTS omr_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(50) NOT NULL,
    layout_type VARCHAR(20) NOT NULL DEFAULT 'portrait',
    page_size VARCHAR(10) NOT NULL DEFAULT 'A4',
    total_questions INTEGER NOT NULL DEFAULT 50,
    options_per_question INTEGER NOT NULL DEFAULT 4,
    has_roll_number_grid BOOLEAN NOT NULL DEFAULT TRUE,
    roll_number_digits INTEGER NOT NULL DEFAULT 6,
    has_qr_header BOOLEAN NOT NULL DEFAULT TRUE,
    sections JSONB DEFAULT '[]'::jsonb,
    bubble_geometry JSONB NOT NULL DEFAULT '{}'::jsonb,
    markers_geometry JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_omr_templates_school ON omr_templates(school_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_omr_templates_school_code ON omr_templates(school_id, code) WHERE deleted_at IS NULL;

-- 2. OMR TEMPLATE VERSIONS
CREATE TABLE IF NOT EXISTS omr_template_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    template_id UUID NOT NULL REFERENCES omr_templates(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    geometry JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(template_id, version)
);

CREATE INDEX IF NOT EXISTS idx_omr_template_versions_school ON omr_template_versions(school_id);

-- 3. OMR EXAM CONFIGURATIONS
CREATE TABLE IF NOT EXISTS omr_exams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    exam_subject_id UUID NOT NULL REFERENCES exam_subjects(id) ON DELETE CASCADE,
    template_id UUID NOT NULL REFERENCES omr_templates(id) ON DELETE RESTRICT,
    title VARCHAR(150),
    instructions TEXT,
    positive_marks_per_question DECIMAL(5,2) NOT NULL DEFAULT 1.00,
    negative_marks_per_question DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    blank_marks_per_question DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    multiple_answer_behavior VARCHAR(30) NOT NULL DEFAULT 'invalid',
    confidence_threshold DECIMAL(5,2) NOT NULL DEFAULT 70.00,
    review_threshold DECIMAL(5,2) NOT NULL DEFAULT 50.00,
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_omr_exams_school ON omr_exams(school_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_omr_exams_subject ON omr_exams(exam_subject_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_omr_exams_school_subject ON omr_exams(school_id, exam_subject_id) WHERE deleted_at IS NULL;

-- 4. OMR ANSWER KEYS (VERSIONED)
CREATE TABLE IF NOT EXISTS omr_answer_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    omr_exam_id UUID NOT NULL REFERENCES omr_exams(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    published_at TIMESTAMPTZ,
    published_by UUID REFERENCES users(id) ON DELETE SET NULL,
    change_reason TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(omr_exam_id, version)
);

CREATE INDEX IF NOT EXISTS idx_omr_answer_keys_school_exam ON omr_answer_keys(school_id, omr_exam_id);

-- 5. OMR ANSWER KEY QUESTIONS
CREATE TABLE IF NOT EXISTS omr_answer_key_questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    answer_key_id UUID NOT NULL REFERENCES omr_answer_keys(id) ON DELETE CASCADE,
    question_number INTEGER NOT NULL,
    correct_option VARCHAR(10) NOT NULL,
    weightage DECIMAL(5,2) DEFAULT 1.00,
    negative_weightage DECIMAL(5,2) DEFAULT 0.00,
    UNIQUE(answer_key_id, question_number)
);

CREATE INDEX IF NOT EXISTS idx_omr_ak_questions ON omr_answer_key_questions(answer_key_id, question_number);

-- 6. OMR SCAN BATCHES
CREATE TABLE IF NOT EXISTS omr_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    omr_exam_id UUID NOT NULL REFERENCES omr_exams(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    batch_number VARCHAR(50),
    status VARCHAR(30) NOT NULL DEFAULT 'open',
    total_scanned INTEGER NOT NULL DEFAULT 0,
    processed_count INTEGER NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    device_id VARCHAR(100),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_omr_batches_school_exam ON omr_batches(school_id, omr_exam_id);

-- 7. OMR SCANS
CREATE TABLE IF NOT EXISTS omr_scans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    batch_id UUID REFERENCES omr_batches(id) ON DELETE SET NULL,
    omr_exam_id UUID NOT NULL REFERENCES omr_exams(id) ON DELETE CASCADE,
    sheet_id VARCHAR(64) NOT NULL,
    client_scan_id VARCHAR(64),
    student_enrollment_id UUID REFERENCES student_enrollments(id) ON DELETE SET NULL,
    detected_roll_number INTEGER,
    status VARCHAR(30) NOT NULL DEFAULT 'SCANNED',
    image_url TEXT,
    evidence_thumbnail TEXT,
    quality_score VARCHAR(20) NOT NULL DEFAULT 'GOOD',
    quality_metrics JSONB DEFAULT '{}'::jsonb,
    overall_confidence DECIMAL(5,2),
    correct_count INTEGER DEFAULT 0,
    wrong_count INTEGER DEFAULT 0,
    blank_count INTEGER DEFAULT 0,
    multiple_count INTEGER DEFAULT 0,
    total_score DECIMAL(5,2),
    max_possible_score DECIMAL(5,2),
    percentage DECIMAL(5,2),
    answers_hash VARCHAR(64),
    exception_type VARCHAR(50),
    exception_resolved BOOLEAN DEFAULT TRUE,
    scanned_by UUID REFERENCES users(id) ON DELETE SET NULL,
    verified_by UUID REFERENCES users(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_omr_scans_sheet ON omr_scans(school_id, sheet_id, omr_exam_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_omr_scans_client_id ON omr_scans(school_id, client_scan_id) WHERE client_scan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_omr_scans_school_exam ON omr_scans(school_id, omr_exam_id, status);
CREATE INDEX IF NOT EXISTS idx_omr_scans_batch ON omr_scans(batch_id);
CREATE INDEX IF NOT EXISTS idx_omr_scans_student ON omr_scans(student_enrollment_id);

-- 8. OMR SCAN ANSWERS (PER-QUESTION DETECTION)
CREATE TABLE IF NOT EXISTS omr_scan_answers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    scan_id UUID NOT NULL REFERENCES omr_scans(id) ON DELETE CASCADE,
    question_number INTEGER NOT NULL,
    detected_option VARCHAR(10),
    confidence DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    fill_ratio DECIMAL(5,4),
    darkness_delta DECIMAL(5,2),
    all_options_darkness JSONB DEFAULT '{}'::jsonb,
    is_multiple BOOLEAN NOT NULL DEFAULT FALSE,
    is_blank BOOLEAN NOT NULL DEFAULT FALSE,
    is_ambiguous BOOLEAN NOT NULL DEFAULT FALSE,
    is_correct BOOLEAN,
    marks_awarded DECIMAL(5,2),
    manual_override_option VARCHAR(10),
    override_by UUID REFERENCES users(id) ON DELETE SET NULL,
    override_reason TEXT,
    UNIQUE(scan_id, question_number)
);

CREATE INDEX IF NOT EXISTS idx_omr_scan_answers_scan ON omr_scan_answers(scan_id);

-- 9. OMR REVIEW ITEMS (EXCEPTION MANAGEMENT)
CREATE TABLE IF NOT EXISTS omr_review_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    scan_id UUID NOT NULL REFERENCES omr_scans(id) ON DELETE CASCADE,
    question_number INTEGER NOT NULL,
    issue_type VARCHAR(50) NOT NULL,
    detected_option VARCHAR(10),
    confidence DECIMAL(5,2),
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    resolved_option VARCHAR(10),
    reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    review_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_omr_review_items_school ON omr_review_items(school_id, status);
CREATE INDEX IF NOT EXISTS idx_omr_review_items_scan ON omr_review_items(scan_id);

-- 10. OMR AUDIT LOGS
CREATE TABLE IF NOT EXISTS omr_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    entity VARCHAR(50) NOT NULL,
    entity_id VARCHAR(64) NOT NULL,
    old_values JSONB,
    new_values JSONB,
    reason TEXT,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_omr_audit_logs_school ON omr_audit_logs(school_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_omr_audit_logs_entity ON omr_audit_logs(entity, entity_id);

-- 11. SEED RBAC PERMISSIONS FOR OMR ENGINE
INSERT INTO permissions (school_id, code, name)
SELECT s.id, v.code, v.name
FROM schools s
CROSS JOIN (VALUES
    ('omr.view',              'View OMR Templates, Exams, and Batches'),
    ('omr.create_exam',        'Configure OMR Exams & Marking Rules'),
    ('omr.manage_template',    'Create & Manage Physical OMR Templates'),
    ('omr.create_answer_key',  'Create OMR Answer Keys'),
    ('omr.edit_answer_key',    'Edit OMR Answer Keys (Triggers Versioning)'),
    ('omr.publish_answer_key', 'Publish OMR Answer Keys for Evaluation'),
    ('omr.scan',               'Access OMR Mobile Scanner & Intake Batches'),
    ('omr.review',             'Manual Verification of Ambiguous Bubbles'),
    ('omr.reprocess',          'Reprocess OMR Scans & Re-evaluate Batches'),
    ('omr.finalize',           'Finalize Evaluated OMR Results into Marks'),
    ('omr.publish_result',     'Publish Official OMR Exam Results'),
    ('omr.analytics',          'View Item Analysis & Question Performance'),
    ('omr.audit',              'Inspect Comprehensive OMR Audit Trail')
) AS v(code, name)
WHERE NOT EXISTS (
    SELECT 1 FROM permissions p
    WHERE p.school_id = s.id AND p.code = v.code
);

-- Grant all OMR permissions to admin and principal
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM permissions p
JOIN roles r ON r.school_id = p.school_id AND r.code IN ('admin', 'principal')
WHERE p.code LIKE 'omr.%'
ON CONFLICT DO NOTHING;

-- Grant standard evaluation & scanner permissions to staff and teachers
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM permissions p
JOIN roles r ON r.school_id = p.school_id AND r.code IN ('staff', 'teacher')
WHERE p.code IN (
    'omr.view',
    'omr.create_exam',
    'omr.create_answer_key',
    'omr.edit_answer_key',
    'omr.scan',
    'omr.review',
    'omr.analytics'
)
ON CONFLICT DO NOTHING;

-- Grant Answer Key Mapping permissions strictly to accountant / accounts role
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM permissions p
JOIN roles r ON r.school_id = p.school_id AND r.code IN ('accountant', 'accounts')
WHERE p.code IN (
    'omr.view',
    'omr.create_answer_key',
    'omr.edit_answer_key'
)
ON CONFLICT DO NOTHING;

-- 12. SEED DEFAULT SYSTEM TEMPLATES (A4 50-MCQ 4-Option & A4 100-MCQ 4-Option & 20-MCQ 4-Option)
INSERT INTO omr_templates (
    school_id, name, code, layout_type, page_size, total_questions, options_per_question,
    has_roll_number_grid, roll_number_digits, has_qr_header, is_system, bubble_geometry, markers_geometry
)
SELECT
    s.id,
    'Standard 50-Question MCQ (4 Options)',
    'A4_50Q_4OPT_V1',
    'portrait',
    'A4',
    50,
    4,
    TRUE,
    6,
    TRUE,
    TRUE,
    '{"bubble_radius": 14, "option_spacing": 42, "question_spacing": 34, "columns": 2, "questions_per_column": 25}'::jsonb,
    '{"marker_size": 48, "quiet_zone": 20, "positions": ["top_left", "top_right", "bottom_left", "bottom_right"]}'::jsonb
FROM schools s
WHERE NOT EXISTS (
    SELECT 1 FROM omr_templates t
    WHERE t.school_id = s.id AND t.code = 'A4_50Q_4OPT_V1'
);

INSERT INTO omr_templates (
    school_id, name, code, layout_type, page_size, total_questions, options_per_question,
    has_roll_number_grid, roll_number_digits, has_qr_header, is_system, bubble_geometry, markers_geometry
)
SELECT
    s.id,
    'Standard 100-Question MCQ (4 Options)',
    'A4_100Q_4OPT_V1',
    'portrait',
    'A4',
    100,
    4,
    TRUE,
    6,
    TRUE,
    TRUE,
    '{"bubble_radius": 11, "option_spacing": 34, "question_spacing": 26, "columns": 4, "questions_per_column": 25}'::jsonb,
    '{"marker_size": 48, "quiet_zone": 20, "positions": ["top_left", "top_right", "bottom_left", "bottom_right"]}'::jsonb
FROM schools s
WHERE NOT EXISTS (
    SELECT 1 FROM omr_templates t
    WHERE t.school_id = s.id AND t.code = 'A4_100Q_4OPT_V1'
);

INSERT INTO omr_templates (
    school_id, name, code, layout_type, page_size, total_questions, options_per_question,
    has_roll_number_grid, roll_number_digits, has_qr_header, is_system, bubble_geometry, markers_geometry
)
SELECT
    s.id,
    'Quick Assessment 20-Question MCQ',
    'A4_20Q_4OPT_V1',
    'portrait',
    'A4',
    20,
    4,
    TRUE,
    6,
    TRUE,
    TRUE,
    '{"bubble_radius": 18, "option_spacing": 50, "question_spacing": 45, "columns": 1, "questions_per_column": 20}'::jsonb,
    '{"marker_size": 48, "quiet_zone": 20, "positions": ["top_left", "top_right", "bottom_left", "bottom_right"]}'::jsonb
FROM schools s
WHERE NOT EXISTS (
    SELECT 1 FROM omr_templates t
    WHERE t.school_id = s.id AND t.code = 'A4_20Q_4OPT_V1'
);
