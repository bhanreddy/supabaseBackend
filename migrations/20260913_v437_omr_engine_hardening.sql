-- Migration: 20260913_v437_omr_engine_hardening.sql
-- Description: Hardens the OMR engine with retention settings, review uniqueness,
--              answer-key change tracking, extra templates, and scan evidence fields.

-- 1. School-level OMR settings (thresholds + evidence retention)
CREATE TABLE IF NOT EXISTS omr_settings (
    school_id INTEGER PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
    evidence_retention_days INTEGER NOT NULL DEFAULT 30,
    high_confidence_min DECIMAL(5,2) NOT NULL DEFAULT 90.00,
    review_recommended_min DECIMAL(5,2) NOT NULL DEFAULT 70.00,
    auto_capture_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_omr_settings_retention CHECK (evidence_retention_days BETWEEN 1 AND 3650),
    CONSTRAINT chk_omr_settings_thresholds CHECK (
        high_confidence_min >= review_recommended_min
        AND review_recommended_min >= 0
        AND high_confidence_min <= 100
    )
);

INSERT INTO omr_settings (school_id)
SELECT s.id FROM schools s
WHERE NOT EXISTS (SELECT 1 FROM omr_settings os WHERE os.school_id = s.id);

-- 2. Answer-key question change tracking (never silent overwrite of published keys)
CREATE TABLE IF NOT EXISTS omr_answer_key_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    answer_key_id UUID NOT NULL REFERENCES omr_answer_keys(id) ON DELETE CASCADE,
    question_number INTEGER NOT NULL,
    previous_answer VARCHAR(10),
    new_answer VARCHAR(10) NOT NULL,
    changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_omr_ak_changes_key ON omr_answer_key_changes(answer_key_id, question_number);

-- 3. Scan evidence + duplicate detection columns
ALTER TABLE omr_scans
    ADD COLUMN IF NOT EXISTS image_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS qr_payload JSONB,
    ADD COLUMN IF NOT EXISTS device_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS evidence_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS replaced_scan_id UUID REFERENCES omr_scans(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_omr_scans_image_hash
    ON omr_scans(school_id, omr_exam_id, image_hash)
    WHERE image_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_omr_scans_status_created
    ON omr_scans(school_id, status, created_at DESC);

-- 4. Unique pending review items so reprocessing is idempotent
CREATE UNIQUE INDEX IF NOT EXISTS uq_omr_review_items_pending
    ON omr_review_items(scan_id, question_number, issue_type)
    WHERE status = 'pending';

-- 5. Exam-level review threshold already exists; add retention override + answer type
ALTER TABLE omr_exams
    ADD COLUMN IF NOT EXISTS answer_type VARCHAR(30) NOT NULL DEFAULT 'mcq_single',
    ADD COLUMN IF NOT EXISTS evidence_retention_days INTEGER;

ALTER TABLE omr_templates
    ADD COLUMN IF NOT EXISTS answer_type VARCHAR(30) NOT NULL DEFAULT 'mcq_single';

-- 6. Seed 5-option and True/False system templates
INSERT INTO omr_templates (
    school_id, name, code, layout_type, page_size, total_questions, options_per_question,
    has_roll_number_grid, roll_number_digits, has_qr_header, is_system, answer_type,
    bubble_geometry, markers_geometry
)
SELECT
    s.id,
    'Competitive Exam 50-Question MCQ (5 Options)',
    'A4_50Q_5OPT_V1',
    'portrait',
    'A4',
    50,
    5,
    TRUE,
    6,
    TRUE,
    TRUE,
    'mcq_single',
    '{"bubble_radius": 13, "option_spacing": 42, "question_spacing": 38, "columns": 2, "questions_per_column": 25}'::jsonb,
    '{"marker_size": 48, "quiet_zone": 20, "positions": ["top_left", "top_right", "bottom_left", "bottom_right"]}'::jsonb
FROM schools s
WHERE NOT EXISTS (
    SELECT 1 FROM omr_templates t
    WHERE t.school_id = s.id AND t.code = 'A4_50Q_5OPT_V1'
);

INSERT INTO omr_templates (
    school_id, name, code, layout_type, page_size, total_questions, options_per_question,
    has_roll_number_grid, roll_number_digits, has_qr_header, is_system, answer_type,
    bubble_geometry, markers_geometry
)
SELECT
    s.id,
    'True/False 25-Question Sheet',
    'A4_25Q_TF_V1',
    'portrait',
    'A4',
    25,
    2,
    TRUE,
    6,
    TRUE,
    TRUE,
    'true_false',
    '{"bubble_radius": 16, "option_spacing": 64, "question_spacing": 42, "columns": 1, "questions_per_column": 25}'::jsonb,
    '{"marker_size": 48, "quiet_zone": 20, "positions": ["top_left", "top_right", "bottom_left", "bottom_right"]}'::jsonb
FROM schools s
WHERE NOT EXISTS (
    SELECT 1 FROM omr_templates t
    WHERE t.school_id = s.id AND t.code = 'A4_25Q_TF_V1'
);

-- 7. Seed template versions for any template missing v1
INSERT INTO omr_template_versions (school_id, template_id, version, geometry)
SELECT t.school_id, t.id, 1,
       jsonb_build_object(
         'bubble_geometry', t.bubble_geometry,
         'markers_geometry', t.markers_geometry,
         'total_questions', t.total_questions,
         'options_per_question', t.options_per_question,
         'answer_type', t.answer_type
       )
FROM omr_templates t
WHERE t.deleted_at IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM omr_template_versions v
      WHERE v.template_id = t.id AND v.version = 1
  );

-- 8. Grant staff publish-answer-key when they already have edit (assigned mapping workflow)
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM permissions p
JOIN roles r ON r.school_id = p.school_id AND r.code IN ('staff', 'teacher')
WHERE p.code = 'omr.publish_answer_key'
ON CONFLICT DO NOTHING;
