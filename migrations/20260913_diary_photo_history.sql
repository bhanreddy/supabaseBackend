-- Diary photo history: keep original images for 30 days, then delete storage + rows.
-- Additive. Does not change existing diary_entries.

CREATE TABLE IF NOT EXISTS diary_photo_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  diary_entry_id UUID REFERENCES diary_entries(id) ON DELETE SET NULL,
  class_section_id UUID,
  subject_id UUID,
  created_by UUID,
  entry_date DATE NOT NULL,
  image_url TEXT NOT NULL,
  storage_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  CONSTRAINT uq_diary_photo_history_url UNIQUE (school_id, image_url)
);

CREATE INDEX IF NOT EXISTS idx_diary_photo_history_expiry
  ON diary_photo_history(expires_at);

CREATE INDEX IF NOT EXISTS idx_diary_photo_history_school_date
  ON diary_photo_history(school_id, entry_date DESC);
