import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sql from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FILES = [
  '20260913_v433_premium_admission_workflow_system.sql',
  '20260913_v434_admission_workflow_hardening.sql',
];

async function run() {
  try {
    for (const filename of FILES) {
      const migrationPath = path.resolve(__dirname, '../migrations', filename);
      let sqlContent = fs.readFileSync(migrationPath, 'utf8');
      sqlContent = sqlContent
        .replace(/^\s*BEGIN\s*;\s*/im, '')
        .replace(/^\s*COMMIT\s*;\s*/im, '');
      console.log(`Running ${filename} via sql.begin...`);
      await sql.begin(async (tx) => {
        await tx.unsafe(sqlContent);
      });
      console.log(`${filename} completed successfully!`);
    }
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

run();
