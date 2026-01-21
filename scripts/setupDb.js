import 'dotenv/config';
import sql from '../db.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function setupDatabase() {
  try {
    console.log('🔄 Connecting to database...');

    console.log('🗑️  Resetting Schema...');
    // Full Reset
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await sql`GRANT ALL ON SCHEMA public TO postgres`;
    await sql`GRANT ALL ON SCHEMA public TO public`;
    console.log('✅ Schema reset.');

    console.log('🚀 Applying Schema from schema.sql...');
    const schemaPath = path.join(__dirname, '../schema.sql');
    await sql.file(schemaPath);
    console.log('✅ Schema and Seed Data applied.');

    process.exit(0);

  } catch (error) {
    console.error('❌ Error setting up database:', error);
    process.exit(1);
  }
}

setupDatabase();
