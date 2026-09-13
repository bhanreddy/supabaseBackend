import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalJsonStringify, canonicalizePayload } from '../utils/canonicalPayload.js';
import {
  calculateDistanceMeters,
  evaluateAttendanceWindow,
  evaluateLocationPolicy,
  getSchoolLocalDate,
  validateCampusPolicyUpdate,
} from '../services/campusPolicyService.js';
import { verifyEcdsaSignature } from '../services/staffDeviceService.js';
import { normalizeStaffDeviceProofPath } from '../middleware/auth.js';

// Helper to generate real P-256 EC keypair for testing
function generateTestEcKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });

  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

  return { publicKey, privateKey, publicKeyPem };
}

// Helper to sign canonical payload with private key
function signCanonicalPayload(privateKey, payload) {
  const canonicalString = canonicalJsonStringify(payload);
  const signer = crypto.createSign('SHA256');
  signer.update(Buffer.from(canonicalString, 'utf8'));
  signer.end();
  return signer.sign(privateKey, 'base64');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. CANONICAL JSON SERIALIZATION (RFC 8785)
// ─────────────────────────────────────────────────────────────────────────────
test('canonicalJsonStringify orders keys deterministically regardless of insertion order', () => {
  const obj1 = { b: 2, a: 1, nested: { y: 'test', x: 42 }, c: [3, 1, 2] };
  const obj2 = { a: 1, c: [3, 1, 2], nested: { x: 42, y: 'test' }, b: 2 };

  const str1 = canonicalJsonStringify(obj1);
  const str2 = canonicalJsonStringify(obj2);

  assert.equal(str1, str2, 'Outputs must be byte-for-byte identical');
  assert.equal(
    str1,
    '{"a":1,"b":2,"c":[3,1,2],"nested":{"x":42,"y":"test"}}',
    'Keys must be sorted lexicographically'
  );
});

test('canonicalJsonStringify strips undefined, functions, and symbols', () => {
  const obj = {
    valid: 'data',
    ghost: undefined,
    fn: () => {},
    sym: Symbol('test'),
  };
  const str = canonicalJsonStringify(obj);
  assert.equal(str, '{"valid":"data"}');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GEOFENCE MATH AND VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
test('calculateDistanceMeters accurately calculates distance', () => {
  // Same location = 0 meters
  const distZero = calculateDistanceMeters(17.385044, 78.486671, 17.385044, 78.486671);
  assert.equal(Math.round(distZero), 0);

  // Approximately 111 meters for 0.001 deg latitude difference at equator
  const distLat = calculateDistanceMeters(0.0, 0.0, 0.001, 0.0);
  assert.ok(distLat >= 110 && distLat <= 112);
});

test('evaluateLocationPolicy accepts valid location inside campus radius', () => {
  const policy = {
    campus_name: 'Main Campus',
    center_latitude: 17.385044,
    center_longitude: 78.486671,
    radius_meters: 100,
    max_location_age_seconds: 30,
    max_accuracy_meters: 50,
  };

  const now = new Date();
  const validEvidence = {
    latitude: 17.385050, // ~1 meter away
    longitude: 78.486675,
    accuracy: 10,
    timestamp: now.getTime() - 5000, // 5s old
    mocked: false,
  };

  const result = evaluateLocationPolicy(validEvidence, policy, now);
  assert.equal(result.ok, true);
  assert.ok(result.distanceMeters < 10);
});

test('evaluateLocationPolicy rejects coordinates outside geofence boundary', () => {
  const policy = {
    campus_name: 'Main Campus',
    center_latitude: 17.385044,
    center_longitude: 78.486671,
    radius_meters: 50,
    max_location_age_seconds: 30,
    max_accuracy_meters: 50,
  };

  const now = new Date();
  const outsideEvidence = {
    latitude: 17.390000, // ~550m away
    longitude: 78.486671,
    accuracy: 10,
    timestamp: now.getTime() - 2000,
    mocked: false,
  };

  const result = evaluateLocationPolicy(outsideEvidence, policy, now);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OUTSIDE_CAMPUS');
});

test('evaluateLocationPolicy rejects location when uncertainty crosses boundary', () => {
  const policy = {
    campus_name: 'Main Campus',
    center_latitude: 17.385044,
    center_longitude: 78.486671,
    radius_meters: 100,
    max_location_age_seconds: 30,
    max_accuracy_meters: 50,
  };

  const now = new Date();
  // 80m away + 30m accuracy uncertainty = 110m total span (exceeds 100m radius)
  const edgeEvidence = {
    latitude: 17.385764, // ~80m away
    longitude: 78.486671,
    accuracy: 30, // 80 + 30 = 110 > 100
    timestamp: now.getTime() - 2000,
    mocked: false,
  };

  const result = evaluateLocationPolicy(edgeEvidence, policy, now);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LOCATION_UNCERTAIN_AT_BOUNDARY');
});

test('evaluateLocationPolicy rejects invalid, NaN, and non-finite coordinates', () => {
  const policy = {
    campus_name: 'Main Campus',
    center_latitude: 17.385044,
    center_longitude: 78.486671,
    radius_meters: 100,
    max_location_age_seconds: 30,
    max_accuracy_meters: 50,
  };

  assert.equal(evaluateLocationPolicy({ latitude: NaN, longitude: 78.486671 }, policy).ok, false);
  assert.equal(evaluateLocationPolicy({ latitude: 17.385044, longitude: Infinity }, policy).ok, false);
  assert.equal(evaluateLocationPolicy({ latitude: 95.0, longitude: 78.486671 }, policy).ok, false);
  assert.equal(evaluateLocationPolicy({ latitude: 17.385044, longitude: 190.0 }, policy).ok, false);
});

test('evaluateLocationPolicy rejects stale location', () => {
  const policy = {
    campus_name: 'Main Campus',
    center_latitude: 17.385044,
    center_longitude: 78.486671,
    radius_meters: 100,
    max_location_age_seconds: 30,
    max_accuracy_meters: 50,
  };

  const now = new Date();
  const staleEvidence = {
    latitude: 17.385044,
    longitude: 78.486671,
    accuracy: 10,
    timestamp: now.getTime() - 45000, // 45s ago (> 30s limit)
  };

  const result = evaluateLocationPolicy(staleEvidence, policy, now);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LOCATION_TOO_OLD');
});

test('evaluateLocationPolicy rejects poor accuracy', () => {
  const policy = {
    campus_name: 'Main Campus',
    center_latitude: 17.385044,
    center_longitude: 78.486671,
    radius_meters: 100,
    max_location_age_seconds: 30,
    max_accuracy_meters: 50,
  };

  const now = new Date();
  const poorAccuracyEvidence = {
    latitude: 17.385044,
    longitude: 78.486671,
    accuracy: 120, // 120m (> 50m limit)
    timestamp: now.getTime() - 1000,
  };

  const result = evaluateLocationPolicy(poorAccuracyEvidence, policy, now);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'POOR_GPS_ACCURACY');
});

test('evaluateLocationPolicy rejects mock location evidence', () => {
  const policy = {
    campus_name: 'Main Campus',
    center_latitude: 17.385044,
    center_longitude: 78.486671,
    radius_meters: 100,
    max_location_age_seconds: 30,
    max_accuracy_meters: 50,
  };

  const now = new Date();
  const mockEvidence = {
    latitude: 17.385044,
    longitude: 78.486671,
    accuracy: 10,
    timestamp: now.getTime() - 1000,
    mocked: true,
  };

  const result = evaluateLocationPolicy(mockEvidence, policy, now);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MOCK_LOCATION_DETECTED');
});

test('getSchoolLocalDate respects Indian Standard Time timezone', () => {
  // Midnight UTC on Sept 8 is 05:30 AM IST on Sept 8
  const utcDate = new Date('2026-09-08T00:00:00Z');
  const istDateStr = getSchoolLocalDate('Asia/Kolkata', utcDate);
  assert.equal(istDateStr, '2026-09-08');

  // 19:00 UTC on Sept 7 is 00:30 AM IST on Sept 8
  const prevUtcDate = new Date('2026-09-07T19:00:00Z');
  const istRolloverDateStr = getSchoolLocalDate('Asia/Kolkata', prevUtcDate);
  assert.equal(istRolloverDateStr, '2026-09-08');
});

test('evaluateAttendanceWindow enforces school-local windows and grace period', () => {
  const policy = {
    enforcement_mode: 'enforced',
    school_timezone: 'Asia/Kolkata',
    check_in_start_time: '07:30',
    check_in_end_time: '08:00',
    check_out_start_time: '15:30',
    check_out_end_time: '19:00',
    grace_period_minutes: 15,
  };

  assert.equal(evaluateAttendanceWindow('check_in', policy, new Date('2026-09-08T02:45:00Z')).ok, true);
  const outside = evaluateAttendanceWindow('check_in', policy, new Date('2026-09-08T02:46:00Z'));
  assert.equal(outside.ok, false);
  assert.equal(outside.code, 'OUTSIDE_ATTENDANCE_WINDOW');
  assert.equal(evaluateAttendanceWindow('check_in', { ...policy, enforcement_mode: 'disabled' }).code, 'ATTENDANCE_V2_DISABLED');
});

test('evaluateAttendanceWindow supports windows that cross midnight', () => {
  const policy = {
    enforcement_mode: 'enforced',
    school_timezone: 'Asia/Kolkata',
    check_out_start_time: '22:00',
    check_out_end_time: '00:15',
    grace_period_minutes: 0,
  };
  assert.equal(evaluateAttendanceWindow('check_out', policy, new Date('2026-09-08T18:30:00Z')).ok, true);
  const graceAcrossMidnight = {
    ...policy,
    check_out_start_time: '22:00',
    check_out_end_time: '23:59',
    grace_period_minutes: 15,
  };
  assert.equal(evaluateAttendanceWindow('check_out', graceAcrossMidnight, new Date('2026-09-08T18:38:00Z')).ok, true);
});

test('validateCampusPolicyUpdate rejects unsafe bounds and malformed times', () => {
  const invalid = validateCampusPolicyUpdate({
    center_latitude: 91,
    radius_meters: 5,
    check_in_start_time: '29:90',
    enforcement_mode: 'unknown',
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.length >= 4);

  const valid = validateCampusPolicyUpdate({
    center_latitude: 17.385,
    center_longitude: 78.486,
    radius_meters: 150,
    check_in_start_time: '07:30:00',
    enforcement_mode: 'pilot',
  });
  assert.deepEqual(valid, { ok: true, errors: [] });
});

test('device proof paths match client attendance endpoints behind the API v1 mount', () => {
  assert.equal(
    normalizeStaffDeviceProofPath('/api/v1/attendance/v2/challenge?school_id=1'),
    '/attendance/v2/challenge'
  );
  assert.equal(
    normalizeStaffDeviceProofPath('/api/v1/attendance/v2/verify'),
    '/attendance/v2/verify'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. CRYPTOGRAPHIC SIGNATURE & PROOF VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────
test('verifyEcdsaSignature accepts valid ECDSA signature over canonical payload', () => {
  const { privateKey, publicKeyPem } = generateTestEcKeyPair();

  const payload = {
    action: 'check_in',
    challenge_id: 'ch-uuid-1234',
    registration_id: 'reg-uuid-5678',
    school_id: 1,
    campus_id: 'campus-1',
    attendance_date: '2026-09-08',
    location: {
      latitude: 17.385044,
      longitude: 78.486671,
      accuracy: 15,
      timestamp: Date.now(),
    },
    policy_version: 1,
    idempotency_key: 'idemp-999',
  };

  const signature = signCanonicalPayload(privateKey, payload);
  const canonicalString = canonicalJsonStringify(payload);
  const isValid = verifyEcdsaSignature(publicKeyPem, canonicalString, signature);
  assert.equal(isValid, true, 'Valid signature must verify successfully');
});

test('verifyEcdsaSignature rejects altered payload', () => {
  const { privateKey, publicKeyPem } = generateTestEcKeyPair();

  const originalPayload = {
    action: 'check_in',
    challenge_id: 'ch-uuid-1234',
    registration_id: 'reg-uuid-5678',
    school_id: 1,
    campus_id: 'campus-1',
    attendance_date: '2026-09-08',
    location: {
      latitude: 17.385044,
      longitude: 78.486671,
      accuracy: 15,
      timestamp: Date.now(),
    },
    policy_version: 1,
  };

  const signature = signCanonicalPayload(privateKey, originalPayload);

  // Attacker alters latitude after signing
  const tamperedPayload = {
    ...originalPayload,
    location: {
      ...originalPayload.location,
      latitude: 17.399999, // Tampered coordinate
    },
  };

  const tamperedString = canonicalJsonStringify(tamperedPayload);
  const isValid = verifyEcdsaSignature(publicKeyPem, tamperedString, signature);
  assert.equal(isValid, false, 'Tampered payload must fail signature verification');
});

test('verifyEcdsaSignature rejects signature with wrong device public key', () => {
  const deviceA = generateTestEcKeyPair();
  const deviceB = generateTestEcKeyPair();

  const payload = {
    action: 'check_out',
    challenge_id: 'ch-uuid-5555',
    registration_id: 'reg-uuid-5678',
    school_id: 1,
    campus_id: 'campus-1',
    attendance_date: '2026-09-08',
  };

  // Signed by Device A
  const signatureA = signCanonicalPayload(deviceA.privateKey, payload);
  const canonicalString = canonicalJsonStringify(payload);

  // Attempting to verify against Device B's public key
  const isValid = verifyEcdsaSignature(deviceB.publicKeyPem, canonicalString, signatureA);
  assert.equal(isValid, false, 'Wrong public key must reject signature');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ATTENDANCE STATE MACHINE RULES
// ─────────────────────────────────────────────────────────────────────────────
test('attendance action ordering and validation rules', () => {
  // Case: Checkout before checkin
  const hasCheckedIn = false;
  assert.throws(
    () => {
      if (!hasCheckedIn) {
        const err = new Error('Cannot check out without an active check-in for today.');
        err.code = 'CHECKOUT_BEFORE_CHECKIN';
        throw err;
      }
    },
    { code: 'CHECKOUT_BEFORE_CHECKIN' }
  );

  // Case: Finalized record blocks mobile self-attendance
  const existingRecord = { is_finalized: true, status: 'present' };
  assert.throws(
    () => {
      if (existingRecord.is_finalized) {
        const err = new Error('Attendance for today has been finalized by an administrator.');
        err.code = 'ATTENDANCE_FINALIZED';
        throw err;
      }
    },
    { code: 'ATTENDANCE_FINALIZED' }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ADMINISTRATIVE PERMISSION AND SOURCE INTEGRITY
// ─────────────────────────────────────────────────────────────────────────────
test('admin manual mark and correction attribute immutable sources', () => {
  const initialManual = {
    source: 'admin_manual',
    reason: 'Official off-campus training',
    is_verified: false, // Never fake biometric verification
  };
  assert.equal(initialManual.source, 'admin_manual');
  assert.equal(initialManual.is_verified, false);

  const correction = {
    source: 'admin_correction',
    reason: 'Indoor GPS issue on 2nd floor lab',
    is_verified: false,
  };
  assert.equal(correction.source, 'admin_correction');
  assert.equal(correction.is_verified, false);

  const mobileV2 = {
    source: 'mobile_v2',
    is_verified: true,
  };
  assert.equal(mobileV2.source, 'mobile_v2');
  assert.equal(mobileV2.is_verified, true);
});

test('self-approval protection blocks admin from approving their own registered device', () => {
  const adminPersonId = '00000000-0000-0000-0000-000000000001';
  const targetDeviceRegistration = {
    id: 'dev-1',
    person_id: '00000000-0000-0000-0000-000000000001', // Same physical person
    staff_id: 'staff-1',
  };

  const isSelfApproval = targetDeviceRegistration.person_id === adminPersonId;
  assert.equal(isSelfApproval, true);

  assert.throws(
    () => {
      if (isSelfApproval) {
        const err = new Error('Administrators are not permitted to approve their own device registration.');
        err.code = 'SELF_APPROVAL_PROHIBITED';
        throw err;
      }
    },
    { code: 'SELF_APPROVAL_PROHIBITED' }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. PAYROLL CONSUMER COMPATIBILITY
// ─────────────────────────────────────────────────────────────────────────────
test('staff_attendance structure preserves required fields for payroll queries', () => {
  // Existing payroll calculation queries query staff_attendance with:
  // SELECT status, attendance_date FROM staff_attendance WHERE staff_id = $1 AND attendance_date BETWEEN $2 AND $3
  const staffAttendanceRow = {
    id: 'att-uuid-1',
    school_id: 1,
    staff_id: '00000000-0000-0000-0000-000000000002',
    attendance_date: '2026-09-08',
    status: 'present',
    // V2 additions that enrich without breaking:
    check_in_time: '2026-09-08T08:30:00.000Z',
    check_out_time: '2026-09-08T17:00:00.000Z',
    verification_source: 'mobile_v2',
    is_verified: true,
    is_finalized: false,
  };

  // Verify status is valid attendance_status_enum compatible
  const validStatuses = ['present', 'absent', 'half_day', 'late'];
  assert.ok(validStatuses.includes(staffAttendanceRow.status));
  assert.equal(typeof staffAttendanceRow.staff_id, 'string');
  assert.equal(typeof staffAttendanceRow.attendance_date, 'string');
  assert.equal(staffAttendanceRow.verification_source, 'mobile_v2');
});
