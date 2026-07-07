import sql from '../db.js';

// Read-only: report any junk literal name values across ALL persons (and display_name), per school.
const JUNK = ['null', 'none', 'undefined'];

try {
  // 1. Any person whose name fields OR display_name contain/equal a junk literal
  const rows = await sql`
    SELECT p.school_id, p.id, p.first_name, p.middle_name, p.last_name, p.display_name,
           EXISTS (SELECT 1 FROM students s WHERE s.person_id = p.id) AS is_student
    FROM persons p
    WHERE p.deleted_at IS NULL
      AND (
        LOWER(TRIM(COALESCE(p.first_name, '')))  = ANY(${JUNK})
        OR LOWER(TRIM(COALESCE(p.middle_name, ''))) = ANY(${JUNK})
        OR LOWER(TRIM(COALESCE(p.last_name, '')))   = ANY(${JUNK})
        OR p.display_name ILIKE '%null%'
        OR p.display_name ILIKE '%undefined%'
      )
    ORDER BY p.school_id
  `;

  console.log(`Persons with junk literal in name fields or display_name: ${rows.length}\n`);
  for (const r of rows) {
    console.log(
      `  school=${r.school_id} student=${r.is_student} | first=${JSON.stringify(r.first_name)} middle=${JSON.stringify(r.middle_name)} last=${JSON.stringify(r.last_name)} display=${JSON.stringify(r.display_name)}`
    );
  }

  // 2. Empty-string (non-NULL) name fields on STUDENT persons that should be NULL
  const [emptyCounts] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE p.last_name IS NOT NULL AND TRIM(p.last_name) = '')::int   AS empty_last,
      COUNT(*) FILTER (WHERE p.middle_name IS NOT NULL AND TRIM(p.middle_name) = '')::int AS empty_middle
    FROM persons p
    JOIN students s ON s.person_id = p.id
    WHERE p.deleted_at IS NULL
  `;
  console.log(`\nStudent persons with empty-string (should-be-NULL) fields: last_name=${emptyCounts.empty_last}, middle_name=${emptyCounts.empty_middle}`);
} finally {
  await sql.end();
}
