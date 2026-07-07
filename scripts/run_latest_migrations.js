/**
 * Apply only the latest dated migration batch (20260706_* RBAC epic).
 * Usage: node scripts/run_latest_migrations.js
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, '../migrations');

const LATEST_PREFIX = '20260706_';

function latestMigrationFiles() {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.startsWith(LATEST_PREFIX) && name.endsWith('.sql'))
    .sort()
    .map((name) => path.join(migrationsDir, name));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const files = latestMigrationFiles();
  if (files.length === 0) {
    console.log('No latest migrations found.');
    process.exit(0);
  }

  console.log(`Applying ${files.length} latest migration(s):\n`);

  const sql = postgres(process.env.DATABASE_URL, {
    ssl: process.env.NODE_ENV === 'production' ? 'require' : { rejectUnauthorized: false },
    prepare: false,
    max: 1,
  });

  let failed = 0;

  for (const filePath of files) {
    const name = path.basename(filePath);
    const body = fs.readFileSync(filePath, 'utf8').trim();
    try {
      await sql.unsafe(body);
      console.log(`✅ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`❌ ${name}: ${err.message}`);
    }
  }

  await sql.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
