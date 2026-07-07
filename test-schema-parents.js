import sql from './db.js';
async function test() {
  try {
    const parentsCols = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'parents';
    `;
    console.log('parents cols', parentsCols);

    const studentParentsCols = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'student_parents';
    `;
    console.log('student_parents cols', studentParentsCols);

    process.exit(0);
  } catch(e) { console.error(e); process.exit(1); }
}
test();
