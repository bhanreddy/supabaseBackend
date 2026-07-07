/**
 * Apply all SQL migrations from migrations/ and db/migrations/ to the configured database.
 * Tracks applied files in schema_migrations (idempotent re-runs skip completed files).
 *
 * Usage: node scripts/run_all_migrations.js
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.NODE_ENV === 'production' ? 'require' : { rejectUnauthorized: false },
  prepare: false,
  max: 1,
});

const BENIGN_CODES = new Set([
  '42P07', // duplicate_table
  '42710', // duplicate_object
  '42701', // duplicate_column
  '42P06', // duplicate_schema
  '42723', // duplicate_function
  '23505', // unique_violation (seed inserts)
]);

function isBenignError(err) {
  if (BENIGN_CODES.has(err.code)) return true;
  const msg = String(err.message || '').toLowerCase();
  return (
    msg.includes('already exists')
    || msg.includes('duplicate key')
    || msg.includes('duplicate object')
  );
}

function collectMigrationFiles() {
  const dirs = [
    path.join(root, 'migrations'),
    path.join(root, 'db', 'migrations'),
  ];
  const files = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.sql')) {
        files.push(path.join(dir, name));
      }
    }
  }
  return files.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

async function ensureTrackingTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function isApplied(filename, client = sql) {
  const [row] = await client`
    SELECT 1 FROM schema_migrations WHERE filename = ${filename} LIMIT 1
  `;
  return !!row;
}

async function markApplied(filename, client = sql) {
  await client`
    INSERT INTO schema_migrations (filename)
    VALUES (${filename})
    ON CONFLICT (filename) DO NOTHING
  `;
}

async function bootstrapExistingMigrations(files, client) {
  const pending = [
    '20260706_approval_requests.sql',
    '20260706_partial_fee_payment_toggle.sql',
    '20260706_rbac_sod_permissions.sql',
    '20260706_fee_refund_amount_constraint.sql',
  ];
  let bootstrapped = 0;
  for (const filePath of files) {
    const filename = path.basename(filePath);
    if (pending.includes(filename)) continue;
    if (await isApplied(filename, client)) continue;
    await markApplied(filename, client);
    bootstrapped += 1;
  }
  if (bootstrapped > 0) {
    console.log(`📌 Bootstrapped ${bootstrapped} historical migration(s) as already applied on live DB\n`);
  }
}

async function runMigration(filePath, client) {
  const filename = path.basename(filePath);
  const body = fs.readFileSync(filePath, 'utf8').trim();
  if (!body) {
    console.log(`⏭  ${filename} (empty)`);
    await markApplied(filename, client);
    return { filename, status: 'skipped_empty' };
  }

  try {
    await client.unsafe(body);
    await markApplied(filename, client);
    console.log(`✅ ${filename}`);
    return { filename, status: 'applied' };
  } catch (err) {
    try { await client.unsafe('ROLLBACK'); } catch { /* no open txn */ }
    if (isBenignError(err)) {
      await markApplied(filename, client);
      console.log(`⚠️  ${filename} (already applied — ${err.code || err.message})`);
      return { filename, status: 'already_applied', error: err.message };
    }
    console.error(`❌ ${filename}:`, err.message);
    return { filename, status: 'failed', error: err.message };
  }
}

function createClient() {
  return postgres(process.env.DATABASE_URL, {
    ssl: process.env.NODE_ENV === 'production' ? 'require' : { rejectUnauthorized: false },
    prepare: false,
    max: 1,
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  await ensureTrackingTable();
  const files = collectMigrationFiles();
  console.log(`Found ${files.length} migration file(s)\n`);

  const bootstrap = process.argv.includes('--bootstrap-live');
  if (bootstrap) {
    await bootstrapExistingMigrations(files, sql);
  }

  const results = { applied: 0, already: 0, failed: 0, skipped: 0 };

  for (const filePath of files) {
    const filename = path.basename(filePath);
    const client = createClient();
    try {
      if (await isApplied(filename, client)) {
        console.log(`⏭  ${filename} (tracked)`);
        results.skipped += 1;
        continue;
      }

      const outcome = await runMigration(filePath, client);
      if (outcome.status === 'applied' || outcome.status === 'skipped_empty') results.applied += 1;
      else if (outcome.status === 'already_applied') results.already += 1;
      else results.failed += 1;
    } finally {
      await client.end({ timeout: 5 });
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Applied: ${results.applied}`);
  console.log(`Already present: ${results.already}`);
  console.log(`Skipped (tracked): ${results.skipped}`);
  console.log(`Failed: ${results.failed}`);

  await sql.end();
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Migration runner crashed:', err);
  try { await sql.end(); } catch { /* ignore */ }
  process.exit(1);
});
