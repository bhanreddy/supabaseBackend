import sql from './db.js';
async function test() {
  try {
    const fn1 = await sql`SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'validate_timetable_entry'`;
    console.log("validate_timetable_entry:\n", fn1[0]?.pg_get_functiondef);

    const fn2 = await sql`SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'update_timestamp'`;
    console.log("\nupdate_timestamp:\n", fn2[0]?.pg_get_functiondef);

    const fn3 = await sql`SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'sync_class_teacher_from_timetable'`;
    console.log("\nsync_class_teacher_from_timetable:\n", fn3[0]?.pg_get_functiondef);
    
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
test();
