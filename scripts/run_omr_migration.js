import sql from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  try {
    const migrationPath = path.join(__dirname, '../migrations/20260913_v436_premium_omr_engine.sql');
    console.log(`Reading migration: ${migrationPath}`);
    const migration = fs.readFileSync(migrationPath, 'utf8');

    console.log('Executing OMR Engine migration...');
    await sql.unsafe(migration);
    console.log('OMR Engine migration executed successfully.');

    // Verify tables
    const tables = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name LIKE 'omr_%'
      ORDER BY table_name;
    `;
    console.log('Verified OMR tables in database:');
    tables.forEach(t => console.log(` - ${t.table_name}`));

    // Verify permissions seeded
    const perms = await sql`
      SELECT COUNT(*)::int as count 
      FROM permissions 
      WHERE code LIKE 'omr.%';
    `;
    console.log(`Verified OMR permissions seeded: ${perms[0].count}`);

  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode || 0);
  }
}

run();
