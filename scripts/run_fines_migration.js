import sql from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  const connection = await sql.reserve();
  try {
    const migrationPath = path.resolve(__dirname, '../migrations/20260912_v422_fine_penalty_adjustments.sql');
    let sqlContent = fs.readFileSync(migrationPath, 'utf8');
    // Strip manual BEGIN; and COMMIT; for pool driver
    sqlContent = sqlContent.replace(/^BEGIN;|^COMMIT;/gm, '').trim();

    console.log('Applying migration 20260912_v422_fine_penalty_adjustments.sql...');
    await connection.unsafe('BEGIN');
    await connection.unsafe(sqlContent);
    await connection.unsafe('COMMIT');
    console.log('✅ Migration applied successfully.');

    // Quick verification
    const [cats] = await connection`SELECT count(*)::int as count FROM fine_categories`;
    const [policies] = await connection`SELECT count(*)::int as count FROM fine_policies`;
    console.log(`Verification: ${cats.count} categories, ${policies.count} policies created.`);
  } catch (err) {
    await connection.unsafe('ROLLBACK').catch(() => {});
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    connection.release();
    process.exit(0);
  }
}

run();
