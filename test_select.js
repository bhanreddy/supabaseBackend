import sql from './db.js';
async function test() {
  try {
    const data = await sql`SELECT created_at FROM timetable_slots LIMIT 1`;
    console.log("Success! Data:", data);
  } catch (err) {
    console.error("Error:", err.message);
  }
  process.exit(0);
}
test();
