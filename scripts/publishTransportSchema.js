/**
 * Applies the TRANSPORT SERVICE section from schema.sql via postgres (same pattern as run_migration.js).
 * Usage: node scripts/publishTransportSchema.js
 * Requires DATABASE_URL or loads db via config — uses ../db.js like the API server.
 */
import 'dotenv/config';
import sql from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const markerStart = '-- TRANSPORT SERVICE — Phase 1 Schema (SchoolIMS v2)';

async function run() {
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const startIdx = schema.indexOf(markerStart);
  if (startIdx === -1) {
    console.error('❌ Transport schema section not found in schema.sql');
    process.exit(1);
  }
  let transportDDL = schema.slice(startIdx).trim();
  transportDDL = transportDDL.replace(/\nCOMMIT;\s*$/i, '').trim();

  console.log('🚌 Applying transport DDL from schema.sql...');
  console.log('📋 Preview (first 400 chars):\n', transportDDL.slice(0, 400));

  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(transportDDL);
    });
    console.log('✅ Transport schema section applied successfully');
  } catch (e) {
    console.error('❌ Apply failed:', e.message);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

run();
