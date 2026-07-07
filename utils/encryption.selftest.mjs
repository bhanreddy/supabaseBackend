/**
 * encryption.selftest.mjs
 * Standalone round-trip + tamper-detection test for utils/encryption.js.
 * Runs WITHOUT a database and WITHOUT GCP Secret Manager: it injects an ephemeral
 * 32-byte key via the NON-PRODUCTION dev path (PG_ENC_KEY_BASE64) before importing
 * the module. Never run with NODE_ENV=production.
 *
 *   node utils/encryption.selftest.mjs
 */

import crypto from 'crypto';
import assert from 'assert';

// Force non-production and provide an ephemeral dev key BEFORE importing the module
// (env.js reads NODE_ENV at import time).
process.env.NODE_ENV = 'test';
process.env.PG_ENC_KEY_BASE64 = crypto.randomBytes(32).toString('base64');

const { encrypt, decrypt } = await import('./encryption.js');

let failures = 0;
const ok = (label) => console.log(`  PASS  ${label}`);
const bad = (label, err) => { failures++; console.log(`  FAIL  ${label}: ${err?.message || err}`); };

// 1. Round-trip
const sample = 'CF-APP-ID-1234567890::secret-αβγ-🔐';
const enc = await encrypt(sample);
console.log('  sample plaintext length:', sample.length);
console.log('  encrypted (base64):', enc.encrypted);
console.log('  iv  (base64):', enc.iv);
console.log('  tag (base64):', enc.tag);
try {
  assert.strictEqual(await decrypt(enc), sample);
  ok('round-trip decrypt === original');
} catch (e) { bad('round-trip', e); }

// 2. Ciphertext is not the plaintext
try {
  assert.ok(!enc.encrypted.includes(Buffer.from(sample).toString('base64')));
  assert.notStrictEqual(enc.encrypted, sample);
  ok('ciphertext does not contain plaintext');
} catch (e) { bad('ciphertext-opaque', e); }

// 3. Unique IV per call (no nonce reuse across fields)
const enc2 = await encrypt(sample);
try {
  assert.notStrictEqual(enc.iv, enc2.iv);
  assert.notStrictEqual(enc.encrypted, enc2.encrypted);
  ok('fresh IV + different ciphertext on second call');
} catch (e) { bad('iv-uniqueness', e); }

// 4. Tamper detection — flip the auth tag, decrypt must throw
try {
  const tampered = Buffer.from(enc.tag, 'base64');
  tampered[0] ^= 0xff;
  await decrypt({ ...enc, tag: tampered.toString('base64') });
  bad('tamper-detection', new Error('decrypt did NOT throw on tampered tag'));
} catch (e) {
  if (/unable to authenticate|auth/i.test(e.message) || e.message.includes('Unsupported state')) {
    ok('tampered tag rejected by GCM auth');
  } else {
    // Any throw is acceptable (GCM final() throws); record the message.
    ok(`tampered tag rejected (${e.message})`);
  }
}

console.log(failures === 0 ? '\nSELFTEST RESULT: ALL PASSED' : `\nSELFTEST RESULT: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
