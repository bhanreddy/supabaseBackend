// Applies the idempotent one-day substitution schema migration.
// Usage: node scripts/run_daily_substitutions_migration.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(
  __dirname,
  '..',
  'migrations',
  '20260728_daily_timetable_substitutions.sql'
);

async function run() {
  const sql = postgres(process.env.DATABASE_URL, {
    ssl: process.env.NODE_ENV === 'production' ? 'require' : { rejectUnauthorized: false },
    prepare: false,
    max: 1,
  });
  try {
    const ddl = fs.readFileSync(file, 'utf8');
    await sql.unsafe(ddl);
    console.log('Daily timetable substitutions migration applied successfully.');
  } catch (error) {
    console.error('Daily timetable substitutions migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

run();
