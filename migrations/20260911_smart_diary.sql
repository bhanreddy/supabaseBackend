-- Smart Diary: extend existing diary_entries, add templates + AI usage tracking.
-- Additive and nullable so historical diary rows continue to render unchanged.

ALTER TABLE diary_entries
  ADD COLUMN IF NOT EXISTS entry_source VARCHAR(20),
  ADD COLUMN IF NOT EXISTS original_text TEXT,
  ADD COLUMN IF NOT EXISTS processed_text TEXT,
  ADD COLUMN IF NOT EXISTS ocr_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS ai_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS detected_language VARCHAR(20),
  ADD COLUMN IF NOT EXISTS source_diary_id UUID REFERENCES diary_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_id UUID,
  ADD COLUMN IF NOT EXISTS submission_id UUID,
  ADD COLUMN IF NOT EXISTS processing_metadata JSONB,
  ADD COLUMN IF NOT EXISTS notification_sent_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_diary_entry_source'
  ) THEN
    ALTER TABLE diary_entries
      ADD CONSTRAINT chk_diary_entry_source
      CHECK (
        entry_source IS NULL OR entry_source IN (
          'MANUAL', 'PHOTO', 'VOICE', 'TEMPLATE', 'REUSED', 'COPIED'
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_diary_entries_submission
  ON diary_entries(school_id, submission_id)
  WHERE submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_diary_entries_source_date
  ON diary_entries(school_id, created_by, entry_date DESC);

CREATE TABLE IF NOT EXISTS diary_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  scope VARCHAR(16) NOT NULL,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(40) NOT NULL DEFAULT 'general',
  content TEXT NOT NULL,
  variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_favourite BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_diary_template_scope CHECK (scope IN ('SYSTEM', 'SCHOOL', 'TEACHER')),
  CONSTRAINT chk_diary_template_tenant CHECK (
    (scope = 'SYSTEM' AND school_id IS NULL)
    OR (scope IN ('SCHOOL', 'TEACHER') AND school_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_diary_templates_school_scope
  ON diary_templates(school_id, scope, sort_order);

CREATE UNIQUE INDEX IF NOT EXISTS uq_diary_templates_system_name
  ON diary_templates(name)
  WHERE scope = 'SYSTEM';

DROP TRIGGER IF EXISTS trg_diary_templates_updated ON diary_templates;
CREATE TRIGGER trg_diary_templates_updated
BEFORE UPDATE ON diary_templates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
  feature VARCHAR(40) NOT NULL,
  provider VARCHAR(40),
  model VARCHAR(80),
  input_type VARCHAR(40),
  tokens_in INTEGER,
  tokens_out INTEGER,
  processing_ms INTEGER,
  estimated_cost_usd NUMERIC(12, 6),
  success BOOLEAN NOT NULL DEFAULT TRUE,
  error_code VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_school_feature_day
  ON ai_usage_logs(school_id, feature, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_teacher_day
  ON ai_usage_logs(teacher_id, created_at DESC);

CREATE TABLE IF NOT EXISTS diary_analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_name VARCHAR(60) NOT NULL,
  properties JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_diary_analytics_school_event
  ON diary_analytics_events(school_id, event_name, created_at DESC);

-- System templates (shared, no tenant). Idempotent on name.
INSERT INTO diary_templates (scope, name, category, content, variables, sort_order)
VALUES
  ('SYSTEM', 'Homework', 'homework', 'Complete {homework}.', '[{"key":"homework","label":"Homework","type":"text"}]'::jsonb, 10),
  ('SYSTEM', 'Complete Exercise', 'homework', 'Complete Exercise {exercise}, Questions {questions}.', '[{"key":"exercise","label":"Exercise","type":"text"},{"key":"questions","label":"Questions","type":"text"}]'::jsonb, 20),
  ('SYSTEM', 'Test Tomorrow', 'test', '{subject} test tomorrow. Prepare {portion}.', '[{"key":"subject","label":"Subject","type":"text"},{"key":"portion","label":"Portion","type":"text"}]'::jsonb, 30),
  ('SYSTEM', 'Revision', 'classwork', 'Revise {chapter} thoroughly.', '[{"key":"chapter","label":"Chapter","type":"text"}]'::jsonb, 40),
  ('SYSTEM', 'Bring Textbook', 'materials', 'Bring {item} tomorrow.', '[{"key":"item","label":"Item","type":"text","default":"the textbook"}]'::jsonb, 50),
  ('SYSTEM', 'Bring Notebook', 'materials', 'Bring your notebook tomorrow.', '[]'::jsonb, 60),
  ('SYSTEM', 'Bring Geometry Box', 'materials', 'Bring geometry box tomorrow.', '[]'::jsonb, 70),
  ('SYSTEM', 'Bring Lab Record', 'materials', 'Bring lab record tomorrow.', '[]'::jsonb, 80),
  ('SYSTEM', 'Complete Pending Work', 'homework', 'Complete all pending classwork and homework.', '[]'::jsonb, 90),
  ('SYSTEM', 'Read Chapter', 'homework', 'Read {chapter} and come prepared.', '[{"key":"chapter","label":"Chapter","type":"text"}]'::jsonb, 100),
  ('SYSTEM', 'Learn Questions & Answers', 'homework', 'Learn Questions & Answers from {chapter}.', '[{"key":"chapter","label":"Chapter","type":"text"}]'::jsonb, 110),
  ('SYSTEM', 'Practice Problems', 'homework', 'Practice problems from {chapter}.', '[{"key":"chapter","label":"Chapter","type":"text"}]'::jsonb, 120),
  ('SYSTEM', 'Worksheet Attached', 'homework', 'Complete the attached worksheet.', '[]'::jsonb, 130),
  ('SYSTEM', 'Project Work', 'homework', 'Work on the {subject} project. {instructions}', '[{"key":"subject","label":"Subject","type":"text"},{"key":"instructions","label":"Instructions","type":"text"}]'::jsonb, 140),
  ('SYSTEM', 'Assignment', 'homework', 'Complete the {subject} assignment: {details}', '[{"key":"subject","label":"Subject","type":"text"},{"key":"details","label":"Details","type":"text"}]'::jsonb, 150),
  ('SYSTEM', 'Holiday Homework', 'homework', 'Holiday homework: {details}', '[{"key":"details","label":"Details","type":"text"}]'::jsonb, 160),
  ('SYSTEM', 'Classwork Completed', 'classwork', 'Classwork completed. {notes}', '[{"key":"notes","label":"Notes","type":"text"}]'::jsonb, 170),
  ('SYSTEM', 'No Homework Today', 'homework', 'No homework today.', '[]'::jsonb, 180),
  ('SYSTEM', 'Prepare for Weekly Test', 'test', 'Prepare {portion} for the weekly test on {date}.', '[{"key":"portion","label":"Portion","type":"text"},{"key":"date","label":"Date","type":"text","default":"this week"}]'::jsonb, 190),
  ('SYSTEM', 'Bring Drawing Material', 'materials', 'Bring drawing material tomorrow.', '[]'::jsonb, 200),
  ('SYSTEM', 'Bring Sports Uniform', 'materials', 'Bring sports uniform tomorrow.', '[]'::jsonb, 210),
  ('SYSTEM', 'Parent Signature Required', 'reminder', 'Complete classwork corrections and get parent signature.', '[]'::jsonb, 220)
ON CONFLICT (name) WHERE scope = 'SYSTEM' DO NOTHING;
