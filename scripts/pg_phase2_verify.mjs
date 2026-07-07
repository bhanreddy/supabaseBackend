/**
 * pg_phase2_verify.mjs — Phase 2 credential-save verification (DB-level).
 *
 * PREREQUISITES (this script does NOT apply migrations):
 *   1. Apply db/migrations/001_pg_foundation.sql
 *   2. Apply db/migrations/002_pg_state.sql
 *   3. Provide an encryption key for non-prod:  export PG_ENC_KEY_BASE64=$(openssl rand -base64 32)
 *   4. Pick a real test school:                 export TEST_SCHOOL_ID=<schools.id>
 *
 * RUN:  node scripts/pg_phase2_verify.mjs
 *
 * This script WRITES to the DB and then CLEANS UP (restores pg_enabled/pg_state and
 * deletes the test credential row). It exits non-zero on any failed assertion.
 *
 * NOTE: Tests 2 and 4 below are exercised at the SERVICE layer (saveCredentials/getStatus).
 *       The HTTP-level JWT tamper test (Test 3 in the Phase 2 spec) is an additional manual
 *       step using a real admin token — see the curl commands printed at the end.
 */

import assert from 'assert';
import sql from '../db.js';
import { saveCredentials, getStatus } from '../services/cashfreeService.js';
import { decrypt } from '../utils/encryption.js';

const TEST_SCHOOL_ID = parseInt(process.env.TEST_SCHOOL_ID || '', 10);

async function main() {
  if (!Number.isInteger(TEST_SCHOOL_ID) || TEST_SCHOOL_ID <= 0) {
    throw new Error('Set TEST_SCHOOL_ID to a real schools.id before running.');
  }

  const SAMPLE_APP_ID = 'CF_APP_TEST_1234567890';
  const SAMPLE_SECRET = 'CF_SECRET_TEST_abcdefXYZ';

  // --- snapshot original state so we can restore it ---
  const [orig] = await sql`SELECT pg_enabled, pg_state FROM schools WHERE id = ${TEST_SCHOOL_ID} LIMIT 1`;
  if (!orig) throw new Error(`School ${TEST_SCHOOL_ID} not found.`);

  let failures = 0;
  const ok = (m) => console.log(`  PASS  ${m}`);
  const bad = (m, e) => { failures++; console.log(`  FAIL  ${m}: ${e?.message || e}`); };

  try {
    // Put the school into a clean, enabled, NOT_CONFIGURED state for the test.
    await sql`UPDATE schools SET pg_enabled = true, pg_state = 'NOT_CONFIGURED' WHERE id = ${TEST_SCHOOL_ID}`;
    await sql`DELETE FROM school_pg_credentials WHERE school_id = ${TEST_SCHOOL_ID} AND pg_provider = 'cashfree'`;

    // === Test 2: save then inspect raw row — ciphertext must NOT be the plaintext ===
    const saved = await saveCredentials(TEST_SCHOOL_ID, {
      appId: SAMPLE_APP_ID, secretKey: SAMPLE_SECRET, environment: 'sandbox',
    });
    console.log('\nsaveCredentials returned:', saved);

    const [row] = await sql`
      SELECT school_id, pg_provider, cf_environment,
             cf_app_id_encrypted, cf_app_id_iv, cf_app_id_tag,
             cf_secret_encrypted, cf_secret_iv, cf_secret_tag
      FROM school_pg_credentials
      WHERE school_id = ${TEST_SCHOOL_ID} AND pg_provider = 'cashfree' LIMIT 1`;
    console.log('\nraw school_pg_credentials row:');
    console.log(row);

    try {
      assert.notStrictEqual(row.cf_app_id_encrypted, SAMPLE_APP_ID);
      assert.notStrictEqual(row.cf_secret_encrypted, SAMPLE_SECRET);
      assert.ok(!String(row.cf_app_id_encrypted).includes(SAMPLE_APP_ID));
      assert.ok(!String(row.cf_secret_encrypted).includes(SAMPLE_SECRET));
      ok('stored app_id/secret are opaque ciphertext, not plaintext');
    } catch (e) { bad('ciphertext-at-rest', e); }

    try {
      assert.strictEqual(await decrypt({ encrypted: row.cf_app_id_encrypted, iv: row.cf_app_id_iv, tag: row.cf_app_id_tag }), SAMPLE_APP_ID);
      assert.strictEqual(await decrypt({ encrypted: row.cf_secret_encrypted, iv: row.cf_secret_iv, tag: row.cf_secret_tag }), SAMPLE_SECRET);
      ok('ciphertext decrypts back to the originals');
    } catch (e) { bad('decrypt-round-trip', e); }

    // === Test 3 (service-level): an extra school_id in the payload is ignored ===
    // saveCredentials only accepts schoolId as its first arg; nothing reads a body school_id.
    const OTHER_SCHOOL_ID = TEST_SCHOOL_ID + 1;
    await saveCredentials(TEST_SCHOOL_ID, {
      appId: SAMPLE_APP_ID, secretKey: SAMPLE_SECRET, environment: 'sandbox',
      school_id: OTHER_SCHOOL_ID, // junk — must have no effect
    });
    const [afterRow] = await sql`
      SELECT school_id FROM school_pg_credentials WHERE school_id = ${TEST_SCHOOL_ID} AND pg_provider = 'cashfree' LIMIT 1`;
    const [leak] = await sql`SELECT COUNT(*)::int AS n FROM school_pg_credentials WHERE school_id = ${OTHER_SCHOOL_ID} AND pg_provider = 'cashfree'`;
    try {
      assert.strictEqual(afterRow.school_id, TEST_SCHOOL_ID);
      assert.strictEqual(leak.n, 0);
      ok(`row stays under school_id=${TEST_SCHOOL_ID}; junk school_id=${OTHER_SCHOOL_ID} wrote nothing`);
    } catch (e) { bad('payload-school_id-ignored', e); }

    // === Test 4: getStatus never returns ciphertext / iv / tag ===
    const status = await getStatus(TEST_SCHOOL_ID);
    console.log('\ngetStatus returned:', status);
    try {
      const keys = Object.keys(status).join(',').toLowerCase();
      assert.ok(!/encrypt|_iv|tag|secret|app_id/.test(keys), `status leaked a sensitive key: ${keys}`);
      ok('getStatus contains no credential / ciphertext fields');
    } catch (e) { bad('status-no-secrets', e); }

  } finally {
    // --- cleanup: restore original state, remove test row ---
    await sql`DELETE FROM school_pg_credentials WHERE school_id = ${TEST_SCHOOL_ID} AND pg_provider = 'cashfree'`;
    await sql`UPDATE schools SET pg_enabled = ${orig.pg_enabled}, pg_state = ${orig.pg_state} WHERE id = ${TEST_SCHOOL_ID}`;
    await sql.end({ timeout: 5 });
  }

  console.log('\n--- HTTP-level JWT tamper test (run manually with a real admin token) ---');
  console.log('  # School A admin token; body claims School B. Inserted row MUST use School A (from JWT).');
  console.log('  curl -s -X POST "$BASE/api/v1/admin/payments/credentials" \\');
  console.log('    -H "Authorization: Bearer $SCHOOL_A_ADMIN_JWT" -H "Content-Type: application/json" \\');
  console.log('    -d \'{"app_id":"X","secret_key":"Y","environment":"sandbox","school_id":<SCHOOL_B_ID>}\'');
  console.log('  # Then: SELECT school_id FROM school_pg_credentials ORDER BY created_at DESC LIMIT 1;  -- expect School A');

  console.log(failures === 0 ? '\nPHASE 2 DB VERIFY: ALL PASSED' : `\nPHASE 2 DB VERIFY: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('VERIFY ERROR:', e.message); process.exit(1); });
