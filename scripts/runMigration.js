
import sql from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const migrationFile = path.join(__dirname, '../migrations/20240217_notification_tables.sql');

async function runMigration() {
  try {

    const sqlContent = fs.readFileSync(migrationFile, 'utf8');

    // Split by semicolon? No, `postgres.js` `sql.file` or just passing the string should work if simple.
    // `postgres.js` typically takes a template literal.
    // Let's try passing the raw string. `postgres.js` might not support multiple statements in one call depending on config.
    // Best approach is strictly simple `sql(string)` or `sql.file(path)`.

    await sql.file(migrationFile);

    process.exit(0);
  } catch (err) {

    process.exit(1);
  }
}

runMigration();