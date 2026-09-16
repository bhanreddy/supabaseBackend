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
    throw new LoginQrError('QR_SCHOOL_MISMATCH');
  }
}

export const QR_LOGIN_ERROR_HTTP = Object.freeze({
  INVALID_LOGIN_QR: { status: 400, code: 'QR_MALFORMED', message: 'This QR code is not a valid SchoolIMS login QR.' },
  QR_MALFORMED: { status: 400, code: 'QR_MALFORMED', message: 'This QR code is not a valid SchoolIMS login QR.' },
  NOT_SCHOOLIMS_LOGIN_QR: { status: 400, code: 'QR_INVALID', message: 'This QR code is not a valid SchoolIMS login QR.' },
  UNSUPPORTED_LOGIN_QR_VERSION: { status: 400, code: 'QR_INVALID', message: 'This QR code is not a valid SchoolIMS login QR.' },
  QR_INVALID: { status: 400, code: 'QR_INVALID', message: 'This QR code is not a valid SchoolIMS login QR.' },
  QR_TOKEN_NOT_FOUND: { status: 401, code: 'QR_TOKEN_NOT_FOUND', message: 'This QR code is not a valid SchoolIMS login QR.' },
  QR_TOKEN_EXPIRED: { status: 401, code: 'QR_TOKEN_EXPIRED', message: 'This QR code has expired. Please generate a new QR.' },
  QR_TOKEN_REVOKED: { status: 401, code: 'QR_TOKEN_REVOKED', message: 'This QR code has been revoked by your school administrator.' },
  QR_TOKEN_ALREADY_USED: { status: 401, code: 'QR_TOKEN_ALREADY_USED', message: 'This login QR is no longer valid. Please request a new QR from your school.' },
  LOGIN_QR_SCHOOL_MISMATCH: { status: 401, code: 'QR_SCHOOL_MISMATCH', message: 'This QR belongs to another school.' },
  QR_SCHOOL_MISMATCH: { status: 401, code: 'QR_SCHOOL_MISMATCH', message: 'This QR belongs to another school.' },
  QR_SCHOOL_NOT_FOUND: { status: 401, code: 'QR_SCHOOL_NOT_FOUND', message: 'This QR belongs to another school.' },
  QR_USER_NOT_FOUND: { status: 401, code: 'QR_USER_NOT_FOUND', message: 'Unable to sign in using this QR. Please contact your school administrator.' },
  QR_USER_INACTIVE: { status: 401, code: 'QR_USER_INACTIVE', message: 'This account is currently inactive.' },
  QR_LOGIN_NOT_ALLOWED: { status: 401, code: 'QR_LOGIN_NOT_ALLOWED', message: 'QR login is not allowed for this account.' },
  LOGIN_QR_KEY_ROTATED: { status: 401, code: 'QR_TOKEN_REVOKED', message: 'This QR code has been revoked by your school administrator.' },
  LOGIN_QR_NO_LONGER_VALID: { status: 401, code: 'QR_TOKEN_EXPIRED', message: 'This QR code has expired. Please generate a new QR.' },
  LOGIN_QR_NOT_CONFIGURED: { status: 503, code: 'QR_LOGIN_UNAVAILABLE', message: 'QR login is temporarily unavailable. Please wait and try again.' },
  QR_SESSION_CREATE_FAILED: { status: 503, code: 'QR_SESSION_CREATE_FAILED', message: "We couldn't complete the login. Please try again." },
  QR_LOGIN_UNAVAILABLE: { status: 503, code: 'QR_LOGIN_UNAVAILABLE', message: 'QR login is temporarily unavailable. Please wait and try again.' },
  QR_SERVER_ERROR: { status: 503, code: 'QR_SERVER_ERROR', message: "We couldn't complete QR login right now. Please try again." },
});

export function qrLoginErrorBody(code) {
  return QR_LOGIN_ERROR_HTTP[code] || QR_LOGIN_ERROR_HTTP.QR_SERVER_ERROR;
}

export function normalizeQrOtpType(verificationType) {
  if (!verificationType || verificationType === 'magiclink' || verificationType === 'signup') {
    return 'email';
  }
  return String(verificationType);
}

export function loginQrCredentialFingerprint(credentialId) {
  if (!credentialId) return null;
  return createHash('sha256').update(String(credentialId), 'utf8').digest('hex').slice(0, 12);
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

function coerceLoginQrSchoolId(value) {
  if (Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const schoolId = Number(value.trim());
    if (Number.isInteger(schoolId) && schoolId > 0) return schoolId;
  }
  return null;
}

export function parseSchoolIMSLoginQr(raw) {
  if (typeof raw !== 'string') throw new LoginQrError('QR_MALFORMED');
  const normalized = raw.replace(/^\uFEFF/, '').trim();
  if (normalized.length < 20 || normalized.length > SCHOOLIMS_LOGIN_QR_MAX_LENGTH) {
    throw new LoginQrError('QR_MALFORMED');
  }

  let value;
  try {
    value = JSON.parse(normalized);
    if (typeof value === 'string') value = JSON.parse(value);
  } catch {
    throw new LoginQrError('QR_MALFORMED');
  }

  if (!value || value.type !== SCHOOLIMS_LOGIN_QR_TYPE) {
    throw new LoginQrError('NOT_SCHOOLIMS_LOGIN_QR');
  }
  if (value.version !== SCHOOLIMS_LOGIN_QR_VERSION) {
    throw new LoginQrError('UNSUPPORTED_LOGIN_QR_VERSION');
  }
  const schoolId = coerceLoginQrSchoolId(value.schoolId);
  if (!schoolId || typeof value.payload !== 'string') {
    throw new LoginQrError('QR_MALFORMED');
  }
  value = { ...value, schoolId };

  const separator = value.payload.indexOf('.');
  if (separator < 1 || value.payload.indexOf('.', separator + 1) !== -1) {
    throw new LoginQrError('QR_MALFORMED');
  }
  const credentialId = value.payload.slice(0, separator);
  const secret = value.payload.slice(separator + 1);
  if (!UUID_PATTERN.test(credentialId) || !SECRET_PATTERN.test(secret)) {
    throw new LoginQrError('QR_MALFORMED');
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
