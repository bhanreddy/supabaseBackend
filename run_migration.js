import sql from './db.js';
import fs from 'fs';

async function run() {
  try {
    const migration = fs.readFileSync('./migrations/20260605_add_accounts_dashboard_config.sql', 'utf8');
    await sql.unsafe(migration);
    console.log("Migration executed successfully.");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    process.exit(0);
  }
}
run();
