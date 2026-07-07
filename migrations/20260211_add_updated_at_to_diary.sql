-- Migration: Add updated_at to diary_entries
ALTER TABLE diary_entries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Attach trigger
DROP TRIGGER IF EXISTS trg_diary_entries_updated ON diary_entries;
CREATE TRIGGER trg_diary_entries_updated
BEFORE UPDATE ON diary_entries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
