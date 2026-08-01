-- Physical exam-room geometry used by the seat allocator. Existing rooms are
-- represented as one row with their current capacity so this migration never
-- invents extra seats; admins can edit the real row/column layout afterwards.

ALTER TABLE exam_rooms ADD COLUMN IF NOT EXISTS row_count INTEGER;
ALTER TABLE exam_rooms ADD COLUMN IF NOT EXISTS column_count INTEGER;

UPDATE exam_rooms
SET row_count = 1,
    column_count = capacity
WHERE row_count IS NULL OR column_count IS NULL;

ALTER TABLE exam_rooms ALTER COLUMN row_count SET DEFAULT 5;
ALTER TABLE exam_rooms ALTER COLUMN column_count SET DEFAULT 6;
ALTER TABLE exam_rooms ALTER COLUMN row_count SET NOT NULL;
ALTER TABLE exam_rooms ALTER COLUMN column_count SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_exam_room_rows'
  ) THEN
    ALTER TABLE exam_rooms
      ADD CONSTRAINT chk_exam_room_rows CHECK (row_count BETWEEN 1 AND 100);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_exam_room_columns'
  ) THEN
    ALTER TABLE exam_rooms
      ADD CONSTRAINT chk_exam_room_columns CHECK (column_count BETWEEN 1 AND 100);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_exam_room_geometry_capacity'
  ) THEN
    ALTER TABLE exam_rooms
      ADD CONSTRAINT chk_exam_room_geometry_capacity
      CHECK (capacity = row_count * column_count);
  END IF;
END $$;
