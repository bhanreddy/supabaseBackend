import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LoginQrError,
  assertSameLoginQrSchool,
  buildSchoolIMSLoginQr,
  deriveLoginQrSecret,
  hashLoginQrSecret,
  hasStudentLoginQrRole,
  normalizeQrOtpType,
  parseSchoolIMSLoginQr,
  qrLoginErrorBody,
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
    error instanceof LoginQrError && error.code === 'QR_SCHOOL_MISMATCH'
  ));
  assert.doesNotThrow(() => assertSameLoginQrSchool(17, '17'));
});

test('parser accepts trimmed BOM, numeric-string schoolId, and double-encoded JSON', () => {
  const secret = deriveLoginQrSecret(seed);
  const raw = buildSchoolIMSLoginQr({ credentialId: seed.credentialId, schoolId: seed.schoolId, secret });
  const padded = `\uFEFF ${raw} `;
  assert.equal(parseSchoolIMSLoginQr(padded).schoolId, 17);
  const stringSchool = raw.replace('"schoolId":17', '"schoolId":"17"');
  assert.equal(parseSchoolIMSLoginQr(stringSchool).schoolId, 17);
  assert.equal(parseSchoolIMSLoginQr(JSON.stringify(raw)).schoolId, 17);
});

test('OTP verification type is normalized away from deprecated magiclink/signup', () => {
  assert.equal(normalizeQrOtpType('magiclink'), 'email');
  assert.equal(normalizeQrOtpType('signup'), 'email');
  assert.equal(normalizeQrOtpType(undefined), 'email');
  assert.equal(normalizeQrOtpType('email'), 'email');
  assert.equal(normalizeQrOtpType('recovery'), 'recovery');
});

test('QR login errors keep specific codes without leaking internals', () => {
  assert.equal(qrLoginErrorBody('QR_TOKEN_EXPIRED').code, 'QR_TOKEN_EXPIRED');
  assert.equal(qrLoginErrorBody('QR_TOKEN_REVOKED').status, 401);
  assert.equal(qrLoginErrorBody('QR_SCHOOL_MISMATCH').message.includes('another school'), true);
  assert.equal(qrLoginErrorBody('QR_USER_INACTIVE').code, 'QR_USER_INACTIVE');
  assert.equal(qrLoginErrorBody('postgres_crash').code, 'QR_SERVER_ERROR');
  assert.equal(qrLoginErrorBody('QR_SERVER_ERROR').message.includes('relation'), false);
});
