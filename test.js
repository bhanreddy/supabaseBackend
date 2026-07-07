import sql from './db.js';
async function test() {
  try {
    const r = await sql`SELECT 1`;
    console.log("DB connected", r);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
test();
