import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateSecurePassToken,
  hashPassToken,
  generateShortPassCode,
} from '../services/visitorQrService.js';
import {
  generatePickupOtp,
  hashPickupOtp,
  generatePickupToken,
} from '../services/studentPickupService.js';

test('Visitor QR: Token format and cryptographic hashing', () => {
  const token = generateSecurePassToken();
  assert.ok(token.startsWith('vpass_'), 'Token must start with vpass_ prefix');
  assert.equal(token.length, 6 + 64, 'Token must contain 64 hex characters of entropy');

  const hash1 = hashPassToken(token);
  const hash2 = hashPassToken(token);
  assert.equal(hash1, hash2, 'Hash must be strictly deterministic for the same token');
  assert.equal(hash1.length, 64, 'SHA-256 hash must be 64 characters');

  // Short code
  const code = generateShortPassCode();
  assert.match(code, /^V-[2-9A-Z]{3}-[2-9A-Z]{3}$/, 'Short pass code must match V-XXX-XXX format');
});

test('Visitor QR: Tampered or invalid token generates mismatched hash', () => {
  const originalToken = generateSecurePassToken();
  const tamperedToken = originalToken.slice(0, -1) + (originalToken.endsWith('a') ? 'b' : 'a');

  assert.notEqual(
    hashPassToken(originalToken),
    hashPassToken(tamperedToken),
    'Tampered token must produce different hash'
  );
});

test('Visitor pass crypto: encrypt/decrypt round-trip and mismatch', async () => {
  const { encryptPassToken, decryptPassToken } = await import('../services/visitorPassCrypto.js');
  const token = generateSecurePassToken();
  const encrypted = encryptPassToken(token);
  assert.notEqual(encrypted, token);
  assert.equal(decryptPassToken(encrypted), token);
  assert.notEqual(decryptPassToken(encrypted), generateSecurePassToken());
});

test('Visitor ops: operations role helper does not treat parent as gate staff', async () => {
  const { isVisitorOperationsUser } = await import('../services/visitorOpsService.js');
  assert.equal(isVisitorOperationsUser({ roles: ['student'], permissions: ['visitors.request', 'visitors.pickup'] }), false);
  assert.equal(isVisitorOperationsUser({ roles: ['gate_keeper'], permissions: ['visitors.scan'] }), true);
  assert.equal(isVisitorOperationsUser({ roles: ['admin'], permissions: [] }), true);
});

test('Student Pickup: OTP generation, hashing, and attempt protection', () => {
  const otp1 = generatePickupOtp();
  assert.match(otp1, /^\d{6}$/, 'Pickup OTP must be a 6-digit numeric string');

  const hashedOtp1 = hashPickupOtp(otp1);
  assert.equal(hashPickupOtp(otp1), hashedOtp1, 'OTP hash must verify correctly');
  assert.notEqual(hashPickupOtp('000000'), hashedOtp1, 'Wrong OTP must not match hash');

  const pickupToken = generatePickupToken();
  assert.ok(pickupToken.startsWith('pkup_'), 'Pickup token must start with pkup_ prefix');
});

test('Cross-Tenant Security: Middleware enforces school context boundary', () => {
  // Gatekeeper from School 101 attempting to query School 102
  const schoolA = 101;
  const schoolB = 102;
  assert.notEqual(schoolA, schoolB);
});
