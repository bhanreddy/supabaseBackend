#!/usr/bin/env node
/**
 * Apply a single SQL migration file to the database in SchoolIMS-Backend/.env.
 *
 * Usage (from anywhere):
 *   node SchoolIMS-Backend/scripts/run-migration.mjs migrations/<file>.sql
 *   node scripts/run-migration.mjs migrations/<file>.sql            (from backend dir)
 *
 * Self-contained and cwd-independent: it resolves .env, node_modules, and the
 * migrations directory relative to this script's own location, then applies the
 * file inside a single connection and prints a short verification.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(backendRoot, '.env') });

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/run-migration.mjs <migration-file.sql>');
  process.exit(2);
}

const migrationPath = path.isAbsolute(arg)
  ? arg
  : fs.existsSync(path.resolve(process.cwd(), arg))
    ? path.resolve(process.cwd(), arg)
    : path.join(backendRoot, arg);

if (!fs.existsSync(migrationPath)) {
  console.error(`Migration file not found: ${migrationPath}`);
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set in SchoolIMS-Backend/.env');
  process.exit(2);
}

const isProduction = (process.env.NODE_ENV || 'development') === 'production';
const sql = postgres(databaseUrl, {
  ssl: isProduction ? 'require' : { rejectUnauthorized: false },
  prepare: false,
  max: 1,
  idle_timeout: 10,
});

async function main() {
  const ddl = fs.readFileSync(migrationPath, 'utf8');
  console.log(`Applying: ${path.basename(migrationPath)}`);
  await sql.unsafe(ddl);
  console.log('OK — migration applied.');
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });
