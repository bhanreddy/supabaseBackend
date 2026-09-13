import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

export const SCHOOLIMS_LOGIN_QR_TYPE = 'SCHOOLIMS_LOGIN';
export const SCHOOLIMS_LOGIN_QR_VERSION = 1;
export const SCHOOLIMS_LOGIN_QR_MAX_LENGTH = 2048;
export const STUDENT_LOGIN_QR_ALLOWED_ROLES = Object.freeze([
  'admin', 'principal', 'management', 'accounts', 'accountant',
]);
export const STUDENT_LOGIN_QR_DENIED_ROLES = Object.freeze([
  'teacher', 'staff', 'student', 'parent', 'driver',
]);

export function hasStudentLoginQrRole(roleCodes) {
  if (!Array.isArray(roleCodes)) return false;
  return roleCodes.some((role) => STUDENT_LOGIN_QR_ALLOWED_ROLES.includes(role));
}

export function assertSameLoginQrSchool(parsedSchoolId, requestedSchoolId) {
  if (String(parsedSchoolId) !== String(requestedSchoolId)) {
    throw new LoginQrError('LOGIN_QR_SCHOOL_MISMATCH');
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class LoginQrError extends Error {
  constructor(code = 'INVALID_LOGIN_QR') {
    super(code);
    this.name = 'LoginQrError';
    this.code = code;
  }
}

export function hashLoginQrSecret(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function deriveLoginQrSecret({
  masterSecret,
  credentialId,
  schoolId,
  userId,
  issuedAt,
  version = SCHOOLIMS_LOGIN_QR_VERSION,
}) {
  if (typeof masterSecret !== 'string' || Buffer.byteLength(masterSecret, 'utf8') < 32) {
    throw new LoginQrError('LOGIN_QR_NOT_CONFIGURED');
  }
  const canonical = [
    SCHOOLIMS_LOGIN_QR_TYPE,
    version,
    String(schoolId),
    credentialId,
    userId,
    new Date(issuedAt).toISOString(),
  ].join(':');
  return createHmac('sha256', masterSecret).update(canonical, 'utf8').digest('base64url');
}

export function buildSchoolIMSLoginQr({
  credentialId,
  schoolId,
  secret,
  version = SCHOOLIMS_LOGIN_QR_VERSION,
}) {
  if (!UUID_PATTERN.test(String(credentialId)) || !SECRET_PATTERN.test(String(secret))) {
    throw new LoginQrError();
  }
  return JSON.stringify({
    type: SCHOOLIMS_LOGIN_QR_TYPE,
    version,
    schoolId: Number(schoolId),
    payload: `${credentialId}.${secret}`,
  });
}

export function parseSchoolIMSLoginQr(raw) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > SCHOOLIMS_LOGIN_QR_MAX_LENGTH) {
    throw new LoginQrError();
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new LoginQrError();
  }

  if (!value || value.type !== SCHOOLIMS_LOGIN_QR_TYPE) {
    throw new LoginQrError('NOT_SCHOOLIMS_LOGIN_QR');
  }
  if (value.version !== SCHOOLIMS_LOGIN_QR_VERSION) {
    throw new LoginQrError('UNSUPPORTED_LOGIN_QR_VERSION');
  }
  if (!Number.isInteger(value.schoolId) || value.schoolId <= 0 || typeof value.payload !== 'string') {
    throw new LoginQrError();
  }

  const separator = value.payload.indexOf('.');
  if (separator < 1 || value.payload.indexOf('.', separator + 1) !== -1) {
    throw new LoginQrError();
  }
  const credentialId = value.payload.slice(0, separator);
  const secret = value.payload.slice(separator + 1);
  if (!UUID_PATTERN.test(credentialId) || !SECRET_PATTERN.test(secret)) {
    throw new LoginQrError();
  }

  return {
    type: SCHOOLIMS_LOGIN_QR_TYPE,
    version: SCHOOLIMS_LOGIN_QR_VERSION,
    schoolId: value.schoolId,
    credentialId,
    secret,
  };
}

export function verifyLoginQrSecret(presentedSecret, expectedSecret, storedHash) {
  if (!SECRET_PATTERN.test(String(presentedSecret)) || !SECRET_PATTERN.test(String(expectedSecret))) {
    return false;
  }
  const presented = Buffer.from(presentedSecret, 'utf8');
  const expected = Buffer.from(expectedSecret, 'utf8');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return false;

  const calculatedHash = hashLoginQrSecret(presentedSecret);
  const calculated = Buffer.from(calculatedHash, 'hex');
  const stored = Buffer.from(String(storedHash || ''), 'hex');
  return calculated.length === stored.length && timingSafeEqual(calculated, stored);
}
