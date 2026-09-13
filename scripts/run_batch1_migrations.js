/** Explicit Batch 1 upgrade only. Requires an existing SchoolIMS core schema.
 * Never bootstraps unrelated migrations or treats a partial failure as applied.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import 'dotenv/config';

export const batch1MigrationNames = [
  '20260905_v418_automation_and_indexes.sql',
  '20260905_v418_recovery_safety.sql',
  '20260905_v418_recovery_indexes.sql',
];
export async function applyBatch1Migrations(db) {
  const connection = await db.reserve();
  let transactionOpen = false;
  try {
    await connection`SELECT pg_advisory_lock(4180905)`;
    await connection`SET lock_timeout = '5s'`;
    await connection`SET statement_timeout = '5min'`;
    const migrations = batch1MigrationNames.map(name => ({ name,
      body: fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8') }));
    // Commit table creation and restricted access together, before concurrent indexes.
    await connection.unsafe('BEGIN');
    transactionOpen = true;
    for (const { body } of migrations) {
      const ddl = body.replace(/CREATE INDEX(?: CONCURRENTLY)? IF NOT EXISTS[\s\S]*?;/g, '')
        .replace(/^BEGIN;|^COMMIT;/gm, '').trim();
      if (ddl.replace(/--[^\n]*/g, '').trim()) await connection.unsafe(ddl);
    }
    await connection.unsafe('COMMIT');
    transactionOpen = false;
    for (const { name, body } of migrations) {
      const indexes = [...body.matchAll(/CREATE INDEX(?: CONCURRENTLY)? IF NOT EXISTS[\s\S]*?;/g)].map(m => m[0]);
      for (const index of indexes) {
        const indexName = index.match(/IF NOT EXISTS\s+(\w+)/)[1];
        const [existing] = await connection`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = ${indexName} AND n.nspname = 'public'`;
        if (existing && !existing.indisvalid) throw new Error(`Invalid index ${indexName}: inspect and drop it concurrently before retrying`);
        await connection.unsafe(index.replace(/^CREATE INDEX(?: CONCURRENTLY)?/, 'CREATE INDEX CONCURRENTLY'));
      }
      await connection`CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      await connection`INSERT INTO schema_migrations (filename) VALUES (${name}) ON CONFLICT (filename) DO NOTHING`;
    }
  } finally {
    try {
      if (transactionOpen) await connection.unsafe('ROLLBACK');
      await connection`SELECT pg_advisory_unlock(4180905)`;
    } finally { connection.release(); }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const migrationUrl = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  const endpoint = new URL(migrationUrl);
  if (endpoint.hostname.includes('pooler.supabase.com') && endpoint.port === '6543') {
    throw new Error('Batch 1 migration requires DATABASE_URL_DIRECT with a direct/session connection, not the transaction pooler');
  }
  const db = postgres(migrationUrl, { max: 1, prepare: false,
    ssl: process.env.BATCH1_LOCAL_DB === 'true' && endpoint.hostname === '127.0.0.1' ? false : 'require' });
  try { await applyBatch1Migrations(db); console.log('Batch 1 migrations verified and applied'); }
  finally { await db.end({ timeout: 5 }); }
}
