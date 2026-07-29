-- One-day timetable substitutions. These rows never rewrite timetable_slots:
-- applicability is always constrained by substitution_date, so access expires
-- automatically when the calendar day changes while the audit trail remains.

BEGIN;

CREATE TABLE IF NOT EXISTS timetable_substitutions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  academic_year_id      UUID NOT NULL REFERENCES academic_years(id) ON DELETE RESTRICT,
  substitution_date     DATE NOT NULL,
  timetable_slot_id     UUID NOT NULL REFERENCES timetable_slots(id) ON DELETE RESTRICT,
  period_number         SMALLINT NOT NULL CHECK (period_number > 0),
  absent_teacher_id     UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  substitute_teacher_id UUID NOT NULL REFERENCES staff(id) ON DELETE RESTRICT,
  reason                VARCHAR(500),
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_substitution_different_teachers
    CHECK (absent_teacher_id <> substitute_teacher_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_timetable_substitution_slot_date_active
  ON timetable_substitutions(school_id, substitution_date, timetable_slot_id)
  WHERE cancelled_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_timetable_substitute_period_date_active
  ON timetable_substitutions(school_id, substitution_date, substitute_teacher_id, period_number)
  WHERE cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_timetable_substitution_date
  ON timetable_substitutions(school_id, substitution_date);

CREATE INDEX IF NOT EXISTS idx_timetable_substitution_teacher_date
  ON timetable_substitutions(substitute_teacher_id, substitution_date)
  WHERE cancelled_at IS NULL;

DROP TRIGGER IF EXISTS trg_timetable_substitutions_updated ON timetable_substitutions;
CREATE TRIGGER trg_timetable_substitutions_updated
  BEFORE UPDATE ON timetable_substitutions
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

ALTER TABLE timetable_substitutions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Substitutions: read own school" ON timetable_substitutions;
CREATE POLICY "Substitutions: read own school"
  ON timetable_substitutions FOR SELECT
  USING (
    auth.role() = 'service_role'
    OR is_super_admin()
    OR school_id = auth_school_id()
  );

DROP POLICY IF EXISTS "Substitutions: admin manage own school" ON timetable_substitutions;
CREATE POLICY "Substitutions: admin manage own school"
  ON timetable_substitutions FOR ALL
  USING (
    auth.role() = 'service_role'
    OR is_super_admin()
    OR (school_id = auth_school_id() AND auth_has_role(ARRAY['admin', 'principal']))
  )
  WITH CHECK (
    auth.role() = 'service_role'
    OR is_super_admin()
    OR (school_id = auth_school_id() AND auth_has_role(ARRAY['admin', 'principal']))
  );

GRANT ALL ON timetable_substitutions TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE ON timetable_substitutions TO authenticated;

COMMIT;
