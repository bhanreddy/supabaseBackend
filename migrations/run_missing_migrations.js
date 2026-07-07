import postgres from 'postgres';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: '../.env' });

const sql = postgres(process.env.DATABASE_URL);

async function applyMigration() {
  try {
    const migrationPath = path.join(process.cwd(), '20260413_add_is_temporary_password.sql');
    const sqlContent = fs.readFileSync(migrationPath, 'utf8');
    
    console.log('Running migration...');
    const result = await sql.unsafe(sqlContent);
    console.log('Migration applied successfully:', result);
  } catch (err) {
    console.error('Error applying migration:', err);
  } finally {
    await sql.end();
  }
}

applyMigration();
