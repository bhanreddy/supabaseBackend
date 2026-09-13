/**
 * Explicit Batch 2 upgrade only. Requires Batch 1 and SchoolIMS core schema.
 * Applies 20260905_v418_batch2_automations_and_support.sql idempotently and tracks in schema_migrations.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import 'dotenv/config';

export const batch2MigrationNames = [
  '20260905_v418_batch2_automations_and_support.sql',
  '20260907_v418_batch2_security_fixes.sql',
];

export async function applyBatch2Migrations(db) {
  const connection = await db.reserve();
  let transactionOpen = false;
  try {
    await connection`SELECT pg_advisory_lock(4180906)`;
    await connection`SET lock_timeout = '5s'`;
    await connection`SET statement_timeout = '5min'`;

    const migrations = batch2MigrationNames.map(name => ({
      name,
      body: fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8')
    }));

    await connection.unsafe('BEGIN');
    transactionOpen = true;

    for (const { body } of migrations) {
      const ddl = body.replace(/CREATE INDEX(?: CONCURRENTLY)? IF NOT EXISTS[\s\S]*?;/g, '')
        .replace(/^BEGIN;|^COMMIT;/gm, '').trim();
      if (ddl.replace(/--[^\n]*/g, '').trim()) {
        await connection.unsafe(ddl);
      }
    }

    await connection.unsafe('COMMIT');
    transactionOpen = false;

    // Apply indexes concurrently
    for (const { name, body } of migrations) {
      const indexes = [...body.matchAll(/CREATE INDEX(?: CONCURRENTLY)? IF NOT EXISTS[\s\S]*?;/g)].map(m => m[0]);
      for (const index of indexes) {
        const indexName = index.match(/IF NOT EXISTS\s+(\w+)/)[1];
        const [existing] = await connection`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = ${indexName} AND n.nspname = 'public'`;
        if (existing && !existing.indisvalid) {
          throw new Error(`Invalid index ${indexName}: inspect and drop it concurrently before retrying`);
        }
        await connection.unsafe(index.replace(/^CREATE INDEX(?: CONCURRENTLY)?(?:\s+IF\s+NOT\s+EXISTS)?/i, 'CREATE INDEX IF NOT EXISTS'));
      }

      await connection`CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      await connection`INSERT INTO schema_migrations (filename) VALUES (${name}) ON CONFLICT (filename) DO NOTHING`;
    }
  } finally {
    try {
      if (transactionOpen) await connection.unsafe('ROLLBACK');
      await connection`SELECT pg_advisory_unlock(4180906)`;
    } finally {
      connection.release();
    }
  }
}

export async function verifyBatch2Database(db) {
  const required = [
    'attendance_interventions',
    'transport_safety_incidents',
    'ticket_number_counters',
    'support_tickets',
    'support_ticket_messages',
  ];
  for (const name of required) {
    const [row] = await db`SELECT to_regclass(${`public.${name}`}) AS name`;
    if (!row.name) throw new Error(`Missing Batch 2 table ${name}`);
  }

  const columns = [
    { table: 'timetable_substitutions', column: 'is_auto_suggested' },
    { table: 'timetable_substitutions', column: 'leave_application_id' },
    { table: 'buses', column: 'speed_limit_override' },
    { table: 'transport_routes', column: 'speed_limit_override' },
    { table: 'timetable_substitutions', column: 'suggested_teacher_id' },
  ];
  for (const { table, column } of columns) {
    const [col] = await db`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=${table} AND column_name=${column}`;
    if (!col) throw new Error(`Missing Batch 2 column ${table}.${column}`);
  }

  const [fn] = await db`SELECT proname FROM pg_proc WHERE proname = 'get_next_ticket_number'`;
  if (!fn) throw new Error('Missing Batch 2 function get_next_ticket_number');

  for (const name of required) {
    const [access] = await db`SELECT c.relrowsecurity AS rls,
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS portal,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS anonymous
      FROM pg_class c WHERE c.oid=${`public.${name}`}::regclass`;
    if (!access.rls || access.portal || access.anonymous) throw new Error(`Unsafe Batch 2 table access: ${name}`);
  }
  const [functionAccess] = await db`SELECT
    has_function_privilege('authenticated','public.get_next_ticket_number(integer)','EXECUTE') AS portal,
    has_function_privilege('anon','public.get_next_ticket_number(integer)','EXECUTE') AS anonymous`;
  if (functionAccess?.portal || functionAccess?.anonymous) throw new Error('Unsafe Batch 2 ticket counter function access');
  for (const name of ['uq_transport_active_vehicle_incident', 'uq_transport_active_safeguarding_incident']) {
    const [index] = await db`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=${name}`;
    if (!index?.indisvalid) throw new Error(`Missing or invalid Batch 2 safety index ${name}`);
  }

  return { ready: true, migrationScope: 'Batch 2' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const migrationUrl = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  const endpoint = new URL(migrationUrl);
  if (endpoint.hostname.includes('pooler.supabase.com') && endpoint.port === '6543') {
    throw new Error('Batch 2 migration requires DATABASE_URL_DIRECT with a direct/session connection, not the transaction pooler');
  }
  const db = postgres(migrationUrl, {
    max: 1,
    prepare: false,
    ssl: process.env.BATCH1_LOCAL_DB === 'true' && endpoint.hostname === '127.0.0.1' ? false : 'require',
  });
  try {
    await applyBatch2Migrations(db);
    console.log(await verifyBatch2Database(db));
  } finally {
    await db.end({ timeout: 5 });
  }
}
