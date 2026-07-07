// READ-ONLY AUDIT for school_id = 17. NO writes. NO DELETE. Safe to run.
// Discovers: school identity, every table with a school_id column, every table
// with a FK to students, the FK dependency graph, and per-table row counts.
import sql from '../db.js';

const SCHOOL_ID = 17;

function tbl(rows, cols) {
  if (!rows.length) return '  (none)';
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const line = cols.map((c, i) => c.padEnd(widths[i])).join(' | ');
  const sep = cols.map((c, i) => '-'.repeat(widths[i])).join('-+-');
  const body = rows.map(r => cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join(' | ')).join('\n');
  return [line, sep, body].join('\n');
}

async function main() {
  console.log('================ READ-ONLY AUDIT: school_id =', SCHOOL_ID, '================\n');

  // 1) School identity + flags ------------------------------------------------
  const schoolCols = (await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='schools' ORDER BY ordinal_position`
  ).map(r => r.column_name);
  const school = await sql`SELECT * FROM schools WHERE id = ${SCHOOL_ID}`;
  console.log('--- SCHOOL 17 IDENTITY ---');
  console.log('  schools columns present:', schoolCols.join(', '));
  if (!school.length) {
    console.log('  !!! NO school row with id = 17. ABORT — do not delete anything. !!!');
  } else {
    for (const [k, v] of Object.entries(school[0])) console.log('   ', k.padEnd(24), '=', v);
  }
  console.log();

  // 2) All public tables with a school_id column ------------------------------
  const schoolIdTables = await sql`
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'school_id'
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name`;
  const schoolIdSet = new Set(schoolIdTables.map(r => r.table_name));

  // 3) Every FK edge in public schema (full graph, for ordering & transitivity)
  const fks = await sql`
    SELECT
      con.conname             AS constraint_name,
      cl.relname              AS child_table,
      att.attname             AS child_column,
      clf.relname             AS parent_table,
      attf.attname            AS parent_column,
      con.confdeltype         AS on_delete
    FROM pg_constraint con
    JOIN pg_class cl   ON cl.oid  = con.conrelid
    JOIN pg_class clf  ON clf.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN unnest(con.conkey)  WITH ORDINALITY AS ck(attnum, ord)  ON true
    JOIN unnest(con.confkey) WITH ORDINALITY AS cfk(attnum, ord) ON cfk.ord = ck.ord
    JOIN pg_attribute att  ON att.attrelid  = con.conrelid  AND att.attnum  = ck.attnum
    JOIN pg_attribute attf ON attf.attrelid = con.confrelid AND attf.attnum = cfk.attnum
    WHERE con.contype = 'f' AND n.nspname = 'public'
    ORDER BY child_table, constraint_name`;

  // Direct children of students
  const studentChildren = fks.filter(f => f.parent_table === 'students');
  const studentChildTables = [...new Set(studentChildren.map(f => f.child_table))];

  console.log('--- TABLES WITH A school_id COLUMN (' + schoolIdSet.size + ') ---');
  console.log('  ' + [...schoolIdSet].join(', '));
  console.log();

  console.log('--- DIRECT FK CHILDREN OF students (' + studentChildTables.length + ') ---');
  console.log(tbl(studentChildren, ['child_table', 'child_column', 'parent_column', 'on_delete']));
  console.log('  (on_delete: a=NO ACTION, r=RESTRICT, c=CASCADE, n=SET NULL, d=SET DEFAULT)');
  console.log();

  // 4) FLAG: student-child tables WITHOUT their own school_id -> need JOIN delete
  const childNoSchoolId = studentChildTables.filter(t => !schoolIdSet.has(t));
  console.log('--- !!! student-children LACKING school_id (need JOIN-based scoping) !!! ---');
  console.log('  ' + (childNoSchoolId.length ? childNoSchoolId.join(', ') : '(none — all student children carry school_id)'));
  console.log();

  // 5) COUNTS -----------------------------------------------------------------
  // 5a) Direct school_id tables
  console.log('--- ROW COUNTS WHERE school_id = 17 (direct school_id tables) ---');
  const directCounts = [];
  for (const t of [...schoolIdSet].sort()) {
    try {
      const r = await sql`SELECT count(*)::int AS n FROM ${sql(t)} WHERE school_id = ${SCHOOL_ID}`;
      directCounts.push({ table_name: t, rows_school17: r[0].n });
    } catch (e) {
      directCounts.push({ table_name: t, rows_school17: 'ERR: ' + e.message });
    }
  }
  console.log(tbl(directCounts.filter(r => r.rows_school17 !== 0), ['table_name', 'rows_school17']));
  console.log('  (tables with 0 rows for school 17 omitted; total school_id tables scanned: ' + directCounts.length + ')');
  console.log();

  // 5b) student-child tables lacking school_id -> count via JOIN
  console.log('--- ROW COUNTS via JOIN to students.school_id = 17 (child tables w/o school_id) ---');
  const joinCounts = [];
  for (const t of childNoSchoolId) {
    const col = studentChildren.find(f => f.child_table === t).child_column;
    try {
      const r = await sql`
        SELECT count(*)::int AS n FROM ${sql(t)} ch
        WHERE ch.${sql(col)} IN (SELECT id FROM students WHERE school_id = ${SCHOOL_ID})`;
      joinCounts.push({ table_name: t, fk_column: col, rows_school17: r[0].n });
    } catch (e) {
      joinCounts.push({ table_name: t, fk_column: col, rows_school17: 'ERR: ' + e.message });
    }
  }
  console.log(tbl(joinCounts, ['table_name', 'fk_column', 'rows_school17']));
  console.log();

  // 6) Sanity: total students for 17, and the same name check
  const sc = await sql`SELECT count(*)::int AS n FROM students WHERE school_id = ${SCHOOL_ID}`;
  console.log('--- students count for school 17:', sc[0].n, '---');

  // 7) Dump full FK graph (for delete-ordering review)
  console.log('\n--- FULL public FK GRAPH (child -> parent) for dependency ordering ---');
  console.log(tbl(fks.map(f => ({ child: f.child_table, col: f.child_column, parent: f.parent_table, on_delete: f.on_delete })),
    ['child', 'col', 'parent', 'on_delete']));

  await sql.end();
}

main().catch(async (e) => { console.error('AUDIT FAILED:', e); try { await sql.end(); } catch {} process.exit(1); });
