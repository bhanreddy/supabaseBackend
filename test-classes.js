import sql from './db.js';
async function test() {
  const c = await sql`SELECT id, name, code FROM classes LIMIT 5`;
  console.log(c);
  process.exit(0);
}
test();
