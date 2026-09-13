import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LoginQrError,
  assertSameLoginQrSchool,
  buildSchoolIMSLoginQr,
  deriveLoginQrSecret,
  hashLoginQrSecret,
  hasStudentLoginQrRole,
  parseSchoolIMSLoginQr,
  STUDENT_LOGIN_QR_ALLOWED_ROLES,
  STUDENT_LOGIN_QR_DENIED_ROLES,
  verifyLoginQrSecret,
} from './studentLoginQr.js';

const seed = {
  masterSecret: 'a-secure-test-secret-that-is-at-least-thirty-two-bytes',
  credentialId: '123e4567-e89b-42d3-a456-426614174000',
  schoolId: 17,
  userId: '123e4567-e89b-42d3-a456-426614174001',
  issuedAt: '2026-09-10T10:00:00.000Z',
};

test('versioned SchoolIMS QR round-trips without readable credentials', () => {
  const secret = deriveLoginQrSecret(seed);
  const raw = buildSchoolIMSLoginQr({ credentialId: seed.credentialId, schoolId: seed.schoolId, secret });
  const parsed = parseSchoolIMSLoginQr(raw);
  assert.equal(parsed.schoolId, 17);
  assert.equal(parsed.credentialId, seed.credentialId);
  assert.equal(raw.includes('password'), false);
  assert.equal(raw.includes('@'), false);
  assert.equal(verifyLoginQrSecret(parsed.secret, secret, hashLoginQrSecret(secret)), true);
});

test('random, malformed, damaged, and unsupported QRs fail closed', () => {
  for (const raw of [
    'https://example.com',
    '{broken',
    JSON.stringify({ type: 'OTHER', version: 1, schoolId: 17, payload: 'x' }),
    JSON.stringify({ type: 'SCHOOLIMS_LOGIN', version: 2, schoolId: 17, payload: 'x' }),
  ]) {
    assert.throws(() => parseSchoolIMSLoginQr(raw), LoginQrError);
  }
});

test('tampered credential secret is rejected', () => {
  const secret = deriveLoginQrSecret(seed);
  const tampered = `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(verifyLoginQrSecret(tampered, secret, hashLoginQrSecret(secret)), false);
});

test('tenant and subject are cryptographically bound into the credential', () => {
  const secret = deriveLoginQrSecret(seed);
  assert.notEqual(secret, deriveLoginQrSecret({ ...seed, schoolId: 18 }));
  assert.notEqual(secret, deriveLoginQrSecret({ ...seed, userId: '123e4567-e89b-42d3-a456-426614174002' }));
});

test('QR management role policy allows management/accounts and denies student-facing roles', () => {
  for (const role of STUDENT_LOGIN_QR_ALLOWED_ROLES) {
    assert.equal(hasStudentLoginQrRole([role]), true);
  }
  for (const role of STUDENT_LOGIN_QR_DENIED_ROLES) {
    assert.equal(hasStudentLoginQrRole([role]), false);
    assert.equal(STUDENT_LOGIN_QR_ALLOWED_ROLES.includes(role), false);
  }
  assert.equal(hasStudentLoginQrRole(['teacher', 'admin']), true);
  assert.equal(hasStudentLoginQrRole([]), false);
});

test('cross-school QR payloads fail closed before credential lookup', () => {
  assert.throws(() => assertSameLoginQrSchool(17, 18), (error) => (
    error instanceof LoginQrError && error.code === 'LOGIN_QR_SCHOOL_MISMATCH'
  ));
  assert.doesNotThrow(() => assertSameLoginQrSchool(17, '17'));
});
