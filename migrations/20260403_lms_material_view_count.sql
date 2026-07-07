-- Run on existing databases (idempotent). Full schema.sql also includes this ALTER.
ALTER TABLE lms_materials ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;
