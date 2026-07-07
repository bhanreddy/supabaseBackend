import postgres from 'postgres';
import dotenv from 'dotenv';
dotenv.config();

const sql = postgres(process.env.DATABASE_URL);

async function alterUsersTable() {
  try {
    console.log('Adding is_super_admin column to users table...');
    await sql`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT FALSE;
    `;
    console.log('Successfully added is_super_admin column.');
  } catch (e) {
    console.error('Failed to alter users table:', e);
  } finally {
    await sql.end();
  }
}

alterUsersTable();
