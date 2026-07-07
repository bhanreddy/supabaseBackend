import 'dotenv/config';
import sql from '../db.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function setupDatabase() {
  try {

    // Full Reset
    await sql`DROP SCHEMA IF EXISTS public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await sql`GRANT ALL ON SCHEMA public TO postgres`;
    await sql`GRANT ALL ON SCHEMA public TO public`;

    const schemaPath = path.join(__dirname, '../schema.sql');
    await sql.file(schemaPath);

    process.exit(0);

  } catch (error) {

    process.exit(1);
  }
}

setupDatabase();