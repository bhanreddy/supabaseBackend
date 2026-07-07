import sql from './db.js';
async function test() {
  const indexes = await sql`
    SELECT indexname, indexdef 
    FROM pg_indexes 
    WHERE tablename = 'class_sections';
  `;
  console.log(indexes);
  process.exit(0);
}
test();
