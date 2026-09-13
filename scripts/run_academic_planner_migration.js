import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sql from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  try {
    const schemaPath = path.resolve(__dirname, '../migrations/20260912_v429_premium_academic_planner.sql');
    const productionPath = path.resolve(__dirname, '../migrations/20260912_v430_academic_planner_production.sql');
    for (const migrationPath of [schemaPath, productionPath]) {
      let sqlContent = fs.readFileSync(migrationPath, 'utf8');
      sqlContent = sqlContent
        .replace(/^\s*BEGIN\s*;\s*/im, '')
        .replace(/^\s*COMMIT\s*;\s*/im, '');
      console.log(`Running ${path.basename(migrationPath)} via sql.begin...`);
      await sql.begin(async (tx) => {
        await tx.unsafe(sqlContent);
      });
    }
    console.log('Academic Planner migration completed successfully!');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

run();
