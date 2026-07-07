-- Backfill class sort_order for schools where every class is still 0 (default).
-- Order: ascending by name (lowest class first). Adjust in Academics > Classes if needed.

UPDATE classes c
SET sort_order = ranked.rn
FROM (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY school_id ORDER BY name) AS rn
  FROM classes
  WHERE deleted_at IS NULL
) ranked
WHERE c.id = ranked.id
  AND c.deleted_at IS NULL
  AND COALESCE(c.sort_order, 0) = 0
  AND c.school_id IN (
    SELECT school_id
    FROM classes
    WHERE deleted_at IS NULL
    GROUP BY school_id
    HAVING MAX(COALESCE(sort_order, 0)) <= 0
  );
