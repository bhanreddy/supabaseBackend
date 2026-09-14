import sql from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function apply(filename) {
  const migrationPath = path.join(__dirname, '../migrations', filename);
  const body = fs.readFileSync(migrationPath, 'utf8')
    .replace(/^BEGIN;|^COMMIT;/gm, '')
    .trim();
  console.log(`Applying ${filename}...`);
  await sql.begin(async (tx) => {
    await tx.unsafe(body);
  });
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`
    INSERT INTO schema_migrations (filename)
    VALUES (${filename})
    ON CONFLICT (filename) DO NOTHING
  `;
  console.log(`Applied ${filename}`);
}

async function run() {
  try {
    const [items] = await sql`SELECT to_regclass('public.content_items') AS name`;
    if (!items?.name) {
      await apply('20260914_v438_content_engine.sql');
    } else {
      console.log('content_items already present');
    }
    const [col] = await sql`
      SELECT 1 AS ok
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'content_thoughts'
        AND column_name = 'occupies_slot'
    `;
    if (!col) {
      await apply('20260914_v439_content_engine_hardening.sql');
    } else {
      console.log('content hardening already present');
    }
    const [tables] = await sql`
      SELECT
        to_regclass('public.content_items') AS items,
        to_regclass('public.content_schedules') AS schedules
    `;
    console.log('Verified', tables);
  } catch (err) {
    console.error('Content engine migration failed:', err);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
    process.exit(process.exitCode || 0);
  }
}

run();
