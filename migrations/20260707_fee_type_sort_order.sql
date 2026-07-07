-- Manual display order for fee types (used in collection flow / fee ledger).
ALTER TABLE fee_types ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows per school (alphabetical baseline).
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY school_id ORDER BY name ASC, id ASC) AS rn
  FROM fee_types
  WHERE deleted_at IS NULL
)
UPDATE fee_types ft
SET sort_order = ranked.rn
FROM ranked
WHERE ft.id = ranked.id
  AND COALESCE(ft.sort_order, 0) = 0;

CREATE INDEX IF NOT EXISTS idx_fee_types_school_sort
  ON fee_types (school_id, sort_order)
  WHERE deleted_at IS NULL;
