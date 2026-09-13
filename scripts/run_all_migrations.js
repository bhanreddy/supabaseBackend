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

async function runMigration(filePath, client) {
  const filename = path.basename(filePath);
  if (filename.includes('_v418_')) {
    throw new Error('Apply Batch 1 with node scripts/run_batch1_migrations.js before using the historical runner');
  }
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
    throw new Error('Unsafe historical bootstrap is disabled. Use scripts/migrate_release.js --init for an empty database or an explicitly reviewed upgrade runner for an existing database.');
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
