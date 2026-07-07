// Applies migrations/20260614_fee_mode_exclusive.sql atomically.
// Idempotent — safe to re-run. Usage: node scripts/run_fee_mode_exclusive_migration.js
import sql from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '..', 'migrations', '20260614_fee_mode_exclusive.sql');

async function run() {
  try {
    const ddl = fs.readFileSync(file, 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl);
    });
    console.log('✅ 20260614_fee_mode_exclusive.sql applied successfully.');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode || 0);
  }
}
run();
