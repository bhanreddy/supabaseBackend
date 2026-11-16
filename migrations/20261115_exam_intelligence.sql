-- Additive pilot only. Never backfill historical state from marks/remarks.
ALTER TABLE marks ADD COLUMN IF NOT EXISTS analytics_result_state text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marks_analytics_state_check') THEN
    ALTER TABLE marks ADD CONSTRAINT marks_analytics_state_check CHECK (
      analytics_result_state IS NULL OR analytics_result_state IN
      ('assessed','absent','exempt','medical_absence','pending','withheld','invalid')) NOT VALID;
  END IF;
END $$;

-- Reuse existing intervention lifecycle/storage; no duplicate support system.
ALTER TABLE student_interventions ADD COLUMN IF NOT EXISTS academic_context jsonb;
ALTER TABLE student_interventions ADD COLUMN IF NOT EXISTS measurable_objective text;
ALTER TABLE student_interventions ADD COLUMN IF NOT EXISTS academic_progress_notes jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS exam_intelligence_saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id integer NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(100) NOT NULL,
  filters jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(school_id,user_id,name)
);
ALTER TABLE exam_intelligence_saved_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON exam_intelligence_saved_views FROM PUBLIC, anon, authenticated;
GRANT ALL ON exam_intelligence_saved_views TO service_role;
-- Server queries always include tenant and user ownership. Direct client access denied.

CREATE INDEX IF NOT EXISTS idx_intelligence_papers_scope
  ON exam_subjects(school_id,exam_id,class_id,class_section_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_intelligence_exams_year
  ON exams(school_id,academic_year_id,start_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_intelligence_enrollment_dates
  ON student_enrollments(school_id,class_section_id,academic_year_id,start_date,end_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_intelligence_action_context
  ON student_interventions(school_id,student_id,created_at DESC) WHERE academic_context IS NOT NULL;
-- Flags and policy use existing school_settings. Missing flag means disabled.
-- Do not enable any school or migrate existing marks automatically.

-- Academic plans are leadership-only even if existing intervention policies allow staff/family reads.
ALTER TABLE student_interventions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS academic_plans_leadership_only ON student_interventions;
CREATE POLICY academic_plans_leadership_only ON student_interventions
  AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (academic_context IS NULL) WITH CHECK (academic_context IS NULL);
