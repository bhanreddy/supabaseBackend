import sql from '../db.js';

// Canonicalize student person name fields across ALL schools:
//   - junk literals ('null','none','undefined'), empty, or whitespace-only -> SQL NULL
//   - trim leading/trailing whitespace on first/middle/last names
//   - collapse internal multiple spaces to single spaces
// display_name is recomputed by the existing BEFORE-UPDATE trigger.
const JUNK = ['null', 'none', 'undefined'];

try {
  const updated = await sql.begin(async (sql) => {
    const rows = await sql`
      UPDATE persons p
      SET
        first_name = regexp_replace(TRIM(p.first_name), '\\s+', ' ', 'g'),
        last_name = CASE
          WHEN p.last_name IS NULL THEN NULL
          WHEN TRIM(p.last_name) = '' THEN NULL
          WHEN LOWER(TRIM(p.last_name)) = ANY(${JUNK}) THEN NULL
          ELSE regexp_replace(TRIM(p.last_name), '\\s+', ' ', 'g')
        END,
        middle_name = CASE
          WHEN p.middle_name IS NULL THEN NULL
          WHEN TRIM(p.middle_name) = '' THEN NULL
          WHEN LOWER(TRIM(p.middle_name)) = ANY(${JUNK}) THEN NULL
          ELSE regexp_replace(TRIM(p.middle_name), '\\s+', ' ', 'g')
        END
      FROM students s
      WHERE s.person_id = p.id
        AND p.deleted_at IS NULL
        AND (
          p.first_name <> regexp_replace(TRIM(p.first_name), '\\s+', ' ', 'g')
          OR (p.last_name IS NOT NULL AND (TRIM(p.last_name) = '' OR LOWER(TRIM(p.last_name)) = ANY(${JUNK}) OR p.last_name <> regexp_replace(TRIM(p.last_name), '\\s+', ' ', 'g')))
          OR (p.middle_name IS NOT NULL AND (TRIM(p.middle_name) = '' OR LOWER(TRIM(p.middle_name)) = ANY(${JUNK}) OR p.middle_name <> regexp_replace(TRIM(p.middle_name), '\\s+', ' ', 'g')))
        )
      RETURNING p.school_id, p.id, p.first_name, p.middle_name, p.last_name, p.display_name
    `;
    return rows;
  });

  console.log(`Updated ${updated.length} student person row(s):\n`);
  for (const r of updated) {
    console.log(`  school=${r.school_id} | first=${JSON.stringify(r.first_name)} middle=${JSON.stringify(r.middle_name)} last=${JSON.stringify(r.last_name)} display=${JSON.stringify(r.display_name)}`);
  }

  // Post-verify: no junk/empty/untrimmed/double-space remains on student persons
  const [remaining] = await sql`
    SELECT COUNT(*)::int AS n
    FROM persons p
    JOIN students s ON s.person_id = p.id
    WHERE p.deleted_at IS NULL
      AND (
        p.first_name <> regexp_replace(TRIM(p.first_name), '\\s+', ' ', 'g')
        OR (p.last_name IS NOT NULL AND (TRIM(p.last_name) = '' OR LOWER(TRIM(p.last_name)) = ANY(${JUNK}) OR p.last_name <> regexp_replace(TRIM(p.last_name), '\\s+', ' ', 'g')))
        OR (p.middle_name IS NOT NULL AND (TRIM(p.middle_name) = '' OR LOWER(TRIM(p.middle_name)) = ANY(${JUNK}) OR p.middle_name <> regexp_replace(TRIM(p.middle_name), '\\s+', ' ', 'g')))
        OR p.display_name LIKE '%  %'
      )
  `;
  console.log(`\nRemaining junk/empty/untrimmed student name fields after cleanup: ${remaining.n}`);
} finally {
  await sql.end();
}
