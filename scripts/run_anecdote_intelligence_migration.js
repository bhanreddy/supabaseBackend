/**
 * Applies anecdote intelligence schema (v435) and hardening (v436).
 * Uses a direct/session Postgres connection (not the transaction pooler).
 */
import dns from 'node:dns';
import fs from 'node:fs';
import postgres from 'postgres';
import 'dotenv/config';

dns.setDefaultResultOrder('ipv4first');

const files = [
  ['20260913_v435_anecdote_intelligence_engine.sql', 4350913],
  ['20260913_v436_anecdote_intelligence_hardening.sql', 4360913],
];

function sessionConnectionUrl(source) {
  return String(source)
    .replace(/pooler\.supabase\.com:6543/i, 'pooler.supabase.com:5432')
    .replace(/[?&]pgbouncer=true/i, '');
}

async function applyNamedSqlMigration(db, filename, lockKey) {
  const body = fs.readFileSync(new URL(`../migrations/${filename}`, import.meta.url), 'utf8');
  const connection = await db.reserve();
  let transactionOpen = false;
  try {
    await connection`SELECT pg_advisory_lock(${lockKey})`;
    await connection`SET lock_timeout = '5s'`;
    await connection`SET statement_timeout = '5min'`;
    await connection.unsafe('BEGIN');
    transactionOpen = true;
    await connection.unsafe(body.replace(/^BEGIN;|^COMMIT;/gm, '').trim());
    await connection`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    await connection`REVOKE ALL ON schema_migrations FROM PUBLIC, anon, authenticated`;
    await connection`INSERT INTO schema_migrations (filename)
      VALUES (${filename}) ON CONFLICT (filename) DO NOTHING`;
    await connection.unsafe('COMMIT');
    transactionOpen = false;
    console.log(`Applied ${filename}`);
  } finally {
    try {
      if (transactionOpen) await connection.unsafe('ROLLBACK');
      await connection`SELECT pg_advisory_unlock(${lockKey})`;
    } finally {
      connection.release();
    }
  }
}

async function run() {
  const source = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!source) throw new Error('Set DATABASE_URL_DIRECT or DATABASE_URL');
  const connectionUrl = sessionConnectionUrl(source);
  const local = /localhost|127\.0\.0\.1/.test(connectionUrl);
  const db = postgres(connectionUrl, { max: 2, prepare: false, ssl: local ? false : 'require' });
  try {
    for (const [filename, lockKey] of files) {
      await applyNamedSqlMigration(db, filename, lockKey);
    }

    const tables = await db`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'anecdote_categories', 'anecdotes', 'intelligence_rules',
          'intelligence_signals', 'intelligence_insights', 'student_interventions'
        )
      ORDER BY table_name
    `;
    const rules = await db`
      SELECT rule_code
      FROM intelligence_rules
      WHERE school_id IS NULL
      ORDER BY rule_code
    `;
    const awards = await db`
      SELECT code FROM anecdote_subcategories WHERE code = 'AWARDS' LIMIT 1
    `;
    const recorded = await db`
      SELECT filename, applied_at
      FROM schema_migrations
      WHERE filename IN (
        '20260913_v435_anecdote_intelligence_engine.sql',
        '20260913_v436_anecdote_intelligence_hardening.sql'
      )
      ORDER BY filename
    `;
    console.log(JSON.stringify({
      tables: tables.map((row) => row.table_name),
      systemRules: rules.map((row) => row.rule_code),
      awardsSeeded: Boolean(awards[0]),
      schemaMigrations: recorded,
    }, null, 2));
  } finally {
    await db.end({ timeout: 5 });
  }
}

run().catch((err) => {
  console.error('Anecdote intelligence migration failed:', err);
  process.exit(1);
});
