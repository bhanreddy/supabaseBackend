/**
 * Explicit Batch 3 upgrade. Requires Batch 1 & Batch 2 and SchoolIMS core schema.
 * Applies 20260906_v418_batch3_paperforge_syllabus_governance.sql idempotently and tracks in schema_migrations.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import 'dotenv/config';

export const batch3MigrationNames = [
  '20260906_v418_batch3_paperforge_syllabus_governance.sql',
  '20260907_v418_phase5_12_audit_fixes.sql',
];

export async function applyBatch3Migrations(db) {
  const connection = await db.reserve();
  let transactionOpen = false;
  try {
    await connection`SELECT pg_advisory_lock(4180906)`;
    await connection`SET lock_timeout = '5s'`;
    await connection`SET statement_timeout = '5min'`;

    const migrations = batch3MigrationNames.map(name => ({
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

    // Apply indexes
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

export async function verifyBatch3Database(db) {
  const required = [
    'generated_papers',
    'syllabus_chapters',
    'syllabus_topics',
    'student_documents',
    'school_document_requirements',
  ];
  for (const name of required) {
    const [row] = await db`SELECT to_regclass(${`public.${name}`}) AS name`;
    if (!row.name) throw new Error(`Missing Batch 3 table ${name}`);
  }

  const columns = [
    { table: 'diary_entries', column: 'syllabus_chapter_id' },
    { table: 'diary_entries', column: 'syllabus_topic_id' },
    { table: 'generated_papers', column: 'created_by_user' },
    { table: 'generated_papers', column: 'questions' },
    { table: 'generated_papers', column: 'updated_at' },
  ];
  for (const { table, column } of columns) {
    const [col] = await db`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=${table} AND column_name=${column}`;
    if (!col) throw new Error(`Missing Batch 3 column ${table}.${column}`);
  }

  for (const name of [
    'uq_syllabus_chapter_number',
    'uq_syllabus_topic_number',
    'idx_audit_logs_school_created',
    'idx_generated_papers_typed_owner',
  ]) {
    const [index] = await db`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=${name}`;
    if (!index?.indisvalid) throw new Error(`Missing or invalid Batch 3 safety index ${name}`);
  }

  for (const name of required) {
    const [access] = await db`SELECT c.relrowsecurity AS rls,
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS portal,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AS anonymous
      FROM pg_class c WHERE c.oid=${`public.${name}`}::regclass`;
    if (!access.rls || access.portal || access.anonymous) throw new Error(`Unsafe Batch 3 table access: ${name}`);
  }

  return { ready: true, migrationScope: 'Batch 3' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const migrationUrl = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  const endpoint = new URL(migrationUrl);
  if (endpoint.hostname.includes('pooler.supabase.com') && endpoint.port === '6543') {
    throw new Error('Batch 3 migration requires DATABASE_URL_DIRECT with a direct/session connection, not the transaction pooler');
  }
  const db = postgres(migrationUrl, {
    max: 1,
    prepare: false,
    ssl: process.env.BATCH1_LOCAL_DB === 'true' && endpoint.hostname === '127.0.0.1' ? false : 'require',
  });
  try {
    await applyBatch3Migrations(db);
    console.log(await verifyBatch3Database(db));
  } finally {
    await db.end({ timeout: 5 });
  }
}
