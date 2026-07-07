import sql from './db.js';
async function test() {
  try {
    const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'timetable_slots'`;
    console.log(cols);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
test();
