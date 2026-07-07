/**
 * Backfill NULL / empty *_te columns using Gemini (services/geminiTranslator.js).
 *
 * Idempotent: rows with Telugu already set are skipped.
 * Safe to re-run; logs per row; one failure does not stop the batch.
 *
 * Usage (from repo root or SupabaseBackend):
 *   node scripts/backfillTranslations.js
 *
 * Requires: DATABASE_URL (via config), GEMINI_API_KEY
 */
import sql from '../db.js';
import { translateFields } from '../services/geminiTranslator.js';

/** Allowlisted identifiers only — never interpolate user input here. */
const TABLES = [
  {
    table: 'notices',
    pk: 'id',
    fields: ['title', 'content'],
  },
  {
    table: 'diary_entries',
    pk: 'id',
    fields: ['title', 'content'],
  },
  {
    table: 'complaints',
    pk: 'id',
    fields: ['title', 'description'],
  },
  /**
   * Timetable UI reads subject_name_te from `subjects.name_te` (joined from timetable_slots).
   * timetable_slots has no *_te text columns.
   */
  {
    table: 'subjects',
    pk: 'id',
    fields: ['name'],
  },
];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** English present and Telugu column empty or whitespace-only. */
function whereNeedsBackfill(fields) {
  const parts = fields.map((f) => {
    const te = `${f}_te`;
    return `(NULLIF(TRIM(BOTH FROM COALESCE(${f}::text, '')), '') IS NOT NULL
      AND (${te} IS NULL OR NULLIF(TRIM(BOTH FROM COALESCE(${te}::text, '')), '') IS NULL))`;
  });
  return parts.join(' OR ');
}

function buildPatch(row, fields, translated) {
  const patch = {};
  for (const f of fields) {
    const src = row[f];
    if (!src || String(src).trim() === '') continue;
    const existingTe = row[`${f}_te`];
    if (existingTe != null && String(existingTe).trim() !== '') continue;
    const te = translated[f];
    if (te != null && String(te).trim() !== '') {
      patch[`${f}_te`] = String(te).trim();
    }
  }
  return patch;
}

async function runUpdate(table, pk, row, patch) {
  const id = row[pk];
  if (table === 'notices') {
    await sql`UPDATE notices SET ${sql(patch)} WHERE id = ${id}`;
  } else if (table === 'diary_entries') {
    await sql`UPDATE diary_entries SET ${sql(patch)} WHERE id = ${id}`;
  } else if (table === 'complaints') {
    await sql`UPDATE complaints SET ${sql(patch)} WHERE id = ${id}`;
  } else if (table === 'subjects') {
    await sql`UPDATE subjects SET ${sql(patch)} WHERE id = ${id}`;
  } else {
    throw new Error(`Unknown table: ${table}`);
  }
}

async function backfillTable({ table, pk, fields }) {
  const cols = [pk, ...fields, ...fields.map((f) => `${f}_te`)];
  const where = whereNeedsBackfill(fields);
  const query = `SELECT ${cols.join(', ')} FROM ${table} WHERE ${where}`;
  let rows;
  try {
    rows = await sql.unsafe(query);
  } catch (err) {
    console.error(`[SKIP] ${table}: query failed (missing table/columns?) — ${err.message}`);
    return { ok: 0, fail: 0, skip: 1 };
  }

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const toTranslate = {};
    for (const f of fields) {
      const v = row[f];
      if (v != null && String(v).trim() !== '') {
        const te = row[`${f}_te`];
        if (te == null || String(te).trim() === '') {
          toTranslate[f] = String(v);
        }
      }
    }

    if (Object.keys(toTranslate).length === 0) {
      continue;
    }

    try {
      const translated = await translateFields(toTranslate);
      const patch = buildPatch(row, fields, translated);

      if (Object.keys(patch).length === 0) {
        console.error(
          `[FAIL] ${table} ${pk}=${row[pk]}: Gemini returned no usable translations (keys=${JSON.stringify(Object.keys(translated))})`
        );
        fail += 1;
      } else {
        await runUpdate(table, pk, row, patch);
        console.log(`[OK] ${table} ${pk}=${row[pk]} updated: ${Object.keys(patch).join(', ')}`);
        ok += 1;
      }
    } catch (err) {
      console.error(`[FAIL] ${table} ${pk}=${row[pk]}: ${err.message}`);
      fail += 1;
    }

    await delay(250);
  }

  return { ok, fail, skip: 0 };
}

async function backfill() {
  if (!process.env.GEMINI_API_KEY || !String(process.env.GEMINI_API_KEY).trim()) {
    console.error('GEMINI_API_KEY is missing or empty. Set it in .env before running.');
    await sql.end({ timeout: 10 }).catch(() => {});
    process.exit(1);
  }

  const totals = { ok: 0, fail: 0, skip: 0 };
  for (const spec of TABLES) {
    console.log(`\n--- ${spec.table} ---`);
    const r = await backfillTable(spec);
    totals.ok += r.ok;
    totals.fail += r.fail;
    totals.skip += r.skip;
  }

  console.log(`\nDone. ok=${totals.ok} fail=${totals.fail} skipped-blocks=${totals.skip}`);
  await sql.end({ timeout: 10 }).catch(() => {});
  process.exit(0);
}

backfill().catch(async (err) => {
  console.error('Fatal:', err);
  await sql.end({ timeout: 10 }).catch(() => {});
  process.exit(1);
});
