import sql from './db.js';
async function test() {
  try {
    const rolesCols = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'user_roles';
    `;
    console.log('user_roles cols', rolesCols);

    const usersCols = await sql`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'users';
    `;
    console.log('users cols', usersCols);

    process.exit(0);
  } catch(e) { console.error(e); process.exit(1); }
}
test();
