-- Full Class Diary upload: one physical page → many subject diary rows.
-- Additive. Historical diary_entries remain valid.

CREATE TABLE IF NOT EXISTS class_diary_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  class_section_id UUID NOT NULL REFERENCES class_sections(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  entry_date DATE NOT NULL,
  image_url TEXT NOT NULL,
  source_image_url TEXT,
  processing_status VARCHAR(20) NOT NULL DEFAULT 'queued',
  submission_id UUID,
  overall_confidence NUMERIC(4, 3),
  extracted_json JSONB,
  notification_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_class_diary_status CHECK (
    processing_status IN ('queued', 'processing', 'ready', 'failed', 'published', 'original')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_class_diary_uploads_submission
  ON class_diary_uploads(school_id, submission_id)
  WHERE submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_class_diary_uploads_class_date
  ON class_diary_uploads(school_id, class_section_id, entry_date DESC);

DROP TRIGGER IF EXISTS trg_class_diary_uploads_updated ON class_diary_uploads;
CREATE TRIGGER trg_class_diary_uploads_updated
BEFORE UPDATE ON class_diary_uploads
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE diary_entries
  ADD COLUMN IF NOT EXISTS class_diary_upload_id UUID REFERENCES class_diary_uploads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_diary_entries_class_upload
  ON diary_entries(class_diary_upload_id)
  WHERE class_diary_upload_id IS NOT NULL;

ALTER TABLE diary_entries DROP CONSTRAINT IF EXISTS chk_diary_entry_source;
ALTER TABLE diary_entries
  ADD CONSTRAINT chk_diary_entry_source
  CHECK (
    entry_source IS NULL OR entry_source IN (
      'MANUAL', 'PHOTO', 'VOICE', 'TEMPLATE', 'REUSED', 'COPIED', 'CLASS_DIARY_AI'
    )
  );

-- Class teachers (and principal) may publish every subject for their homeroom.
CREATE OR REPLACE FUNCTION validate_diary_entry()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
    v_is_admin BOOLEAN;
    v_person_id UUID;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = NEW.created_by AND r.code IN ('admin', 'principal')
    ) INTO v_is_admin;

    IF NOT v_is_admin AND NEW.subject_id IS NOT NULL THEN
        SELECT person_id INTO v_person_id FROM users WHERE id = NEW.created_by;

        IF NOT EXISTS (
            SELECT 1 FROM class_subjects cs
            JOIN staff s ON cs.teacher_id = s.id
            WHERE cs.class_section_id = NEW.class_section_id
              AND cs.subject_id = NEW.subject_id
              AND cs.deleted_at IS NULL
              AND s.person_id = v_person_id
        )
        AND NOT EXISTS (
            SELECT 1 FROM timetable_slots ts
            JOIN staff s ON ts.teacher_id = s.id
            WHERE ts.class_section_id = NEW.class_section_id
              AND ts.subject_id = NEW.subject_id
              AND ts.deleted_at IS NULL
              AND s.person_id = v_person_id
        )
        AND NOT EXISTS (
            SELECT 1 FROM class_sections homeroom
            JOIN staff s ON homeroom.class_teacher_id = s.id
            WHERE homeroom.id = NEW.class_section_id
              AND homeroom.school_id = NEW.school_id
              AND homeroom.deleted_at IS NULL
              AND s.person_id = v_person_id
        ) THEN
            RAISE EXCEPTION 'Unauthorized: You are not assigned to teach this subject in this class';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
