import sql from '../db.js';
import fs from 'fs';
import path from 'path';

async function run() {
  const connection = await sql.reserve();
  let transactionOpen = false;
  try {
    await connection`SET lock_timeout = '10s'`;
    await connection`SET statement_timeout = '5min'`;
    await connection.unsafe('BEGIN');
    transactionOpen = true;
    await connection`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`;

    const files = [
      '20260912_v425_premium_visitor_management_system.sql',
      '20260912_v426_visitor_management_hardening.sql',
    ];
    for (const filename of files) {
      const migrationPath = path.resolve('migrations', filename);
      console.log(`Reading migration from: ${migrationPath}`);
      const sqlContent = fs.readFileSync(migrationPath, 'utf8');
      await connection.unsafe(sqlContent.replace(/^BEGIN;|^COMMIT;/gm, '').trim());
      await connection`INSERT INTO schema_migrations (filename)
        VALUES (${filename}) ON CONFLICT (filename) DO NOTHING`;
      console.log(`Applied ${filename}`);
    }

    await connection.unsafe('COMMIT');
    transactionOpen = false;
    console.log('✅ Premium Visitor Management System migration executed successfully.');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    if (transactionOpen) {
      try {
        await connection.unsafe('ROLLBACK');
      } catch (rbErr) {
        console.error('Rollback error:', rbErr);
      }
    }
    process.exit(1);
  } finally {
    connection.release();
    process.exit(0);
  }
}

run();
