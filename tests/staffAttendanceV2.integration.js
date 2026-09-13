import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import postgres from 'postgres';
import express from 'express';

// Explicit local-only opt-in. Never read the application .env or a school DB.
const url = process.env.STAFF_ATTENDANCE_TEST_DATABASE_URL;
if (!url || !['localhost', '127.0.0.1'].includes(new URL(url).hostname)) {
  throw new Error('Set STAFF_ATTENDANCE_TEST_DATABASE_URL to an isolated local PostgreSQL admin connection');
}
const admin = postgres(url, { ssl: false, max: 1 });
const database = `staff_attendance_test_${process.pid}`;
await admin.unsafe(`CREATE DATABASE ${database}`);
const localUrl = new URL(url); localUrl.pathname = `/${database}`;
const db = postgres(localUrl.toString(), { ssl: false, max: 10, prepare: false, onnotice: () => {} });
mock.module('../db.js', { defaultExport: db, namedExports: { supabase: {}, supabaseAdmin: {} } });
// Authentication is the boundary stub; routes and SQL below are real.
mock.module('../middleware/auth.js', { namedExports: {
  requireAuth: (_req, _res, next) => next(),
  requirePermission: () => (_req, _res, next) => next(),
} });
const { default: router } = await import('../routes/staffAttendanceV2Routes.js');
const deviceService = await import('../services/staffDeviceService.js');
const service = await import('../services/staffAttendanceV2Service.js');
const { canonicalJsonStringify } = await import('../utils/canonicalPayload.js');
const { getCampusPolicy } = await import('../services/campusPolicyService.js');
const { readStaffDevicePublicKey } = await import('../utils/staffDeviceHeaders.js');
let adminId, staffId, personId, policyId, server, baseUrl;
const keys = () => {
  const key = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey: key.privateKey, publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim() };
};
const sign = (key, value) => crypto.sign('sha256', Buffer.from(value), key).toString('base64');
const request = (device, action = 'check_in') => ({ schoolId: 12, staffId, canonicalPersonId: personId,
  installationId: device.installationId, devicePublicKey: device.session.publicKey, action });
async function register(installationId = crypto.randomUUID()) {
  const attendance = keys(), session = keys();
  const proofNonce = crypto.randomUUID();
  const registration = await deviceService.registerDevice({ schoolId: 12, staffId, canonicalPersonId: personId,
    installationId, deviceSessionPublicKey: session.publicKey, attendancePublicKey: attendance.publicKey,
    proofNonce, proofSignature: sign(session.privateKey, proofNonce), osName: 'android' });
  return { attendance, session, registration, installationId };
}
function submission(device, challenge, overrides = {}) {
  const idempotencyKey = crypto.randomUUID();
  const payload = { action: challenge.action, campus_id: policyId, challenge_id: challenge.challengeId,
    idempotency_key: idempotencyKey, registration_id: device.registration.id,
    school_id: 12, staff_id: staffId, policy_version: challenge.policy.policyVersion,
    location: { latitude: 17.385044, longitude: 78.486671, accuracy: 10, timestamp: Date.now(), mocked: false }, ...overrides };
  return { schoolId: 12, staffId, canonicalPersonId: personId, challengeId: challenge.challengeId,
    payload, idempotencyKey, signature: sign(device.attendance.privateKey, canonicalJsonStringify(payload)) };
}

test.before(async () => {
  for (const role of ['anon', 'authenticated']) {
    await admin.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role}; END IF; END $$`);
  }
  // Real table DDL and FKs; unrelated application triggers are intentionally absent.
  const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const tables = new Map([...schema.matchAll(/^CREATE TABLE IF NOT EXISTS (?:public\.)?(\w+) \([\s\S]*?^\);/gm)].map(m => [m[1], m[0]]));
  for (const match of schema.matchAll(/CREATE TYPE \w+ AS ENUM\s*\([\s\S]*?\);/g)) await db.unsafe(match[0]);
  const made = new Set();
  async function make(name) {
    if (made.has(name)) return;
    const ddl = tables.get(name); assert.ok(ddl, name); made.add(name);
    for (const match of ddl.matchAll(/REFERENCES (\w+)\(/g)) if (match[1] !== name) await make(match[1]);
    await db.unsafe(ddl);
  }
  for (const name of ['staff_attendance', 'role_permissions', 'person_contacts']) await make(name);
  await db`INSERT INTO schools (id,name,code) VALUES (12,'Pilot fixture','PILOT'), (13,'Control fixture','CONTROL')`;
  await db`INSERT INTO genders (id,name) VALUES (1,'Test')`;
  await db`INSERT INTO staff_statuses (id,code,name) VALUES (1,'active','Active')`;
  [personId, adminId] = await Promise.all(['Staff','Admin'].map(async name => {
    const [person] = await db`INSERT INTO persons (school_id,first_name,display_name,gender_id) VALUES (12,${name},${name},1) RETURNING id`;
    if (name === 'Staff') return person.id;
    const [user] = await db`INSERT INTO users (school_id,person_id) VALUES (12,${person.id}) RETURNING id`;
    return user.id;
  }));
  const [staff] = await db`INSERT INTO staff (school_id,person_id,staff_code,joining_date) VALUES (12,${personId},'T1','2026-01-01') RETURNING id`;
  staffId = staff.id;
  await db`INSERT INTO roles (school_id,code,name) VALUES (12,'admin','Admin'),(12,'staff','Staff')`;
  const migration = fs.readFileSync(new URL('../migrations/20260908_v418_staff_attendance_v2.sql', import.meta.url), 'utf8');
  const connection = await db.reserve();
  try {
    await connection.unsafe(migration);
    await connection.unsafe(migration); // additive/re-runnable
  } finally { connection.release(); }
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.schoolId = Number(req.headers['x-test-school'] || 12); req.user = { id: adminId, person_id: personId }; next(); });
  app.use('/attendance/v2', router);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/attendance/v2`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.end();
  await admin.unsafe(`DROP DATABASE ${database}`);
  await admin.end();
});

test('migration and absent policy leave both schools disabled', async () => {
  assert.equal((await getCampusPolicy(12)).enforcement_mode, 'disabled');
  assert.equal((await getCampusPolicy(13)).enforcement_mode, 'disabled');
  await assert.rejects(service.createAttendanceChallenge({ schoolId: 12, action: 'check_in' }), { code: 'ATTENDANCE_V2_DISABLED' });
  const [policy] = await db`INSERT INTO campus_attendance_policies
    (school_id,campus_name,center_latitude,center_longitude,radius_meters,check_in_start_time,check_in_end_time,check_out_start_time,check_out_end_time,grace_period_minutes)
    VALUES (12,'Test campus',17.385044,78.486671,100,'00:00','23:59','00:00','23:59',0) RETURNING *`;
  assert.equal(policy.enforcement_mode, 'disabled'); policyId = policy.id;
  await db`UPDATE campus_attendance_policies SET enforcement_mode='pilot' WHERE id=${policyId}`;
  assert.equal((await getCampusPolicy(13)).enforcement_mode, 'disabled');
});

test('registration rejects invalid or non-P256 keys before creating a pending approval', async () => {
  const device = keys();
  const nonce = crypto.randomUUID();
  const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  for (const attendancePublicKey of ['invalid-pem', p384]) {
    await assert.rejects(deviceService.registerDevice({ schoolId: 12, staffId, canonicalPersonId: personId,
      installationId: crypto.randomUUID(), deviceSessionPublicKey: device.publicKey, attendancePublicKey,
      proofNonce: nonce, proofSignature: sign(device.privateKey, nonce) }), { code: 'INVALID_DEVICE_KEYS' });
  }
});

test('registration, admin approval, signed check-in/out, replay, replacement and revocation', async () => {
  const device = await register();
  assert.equal(device.registration.status, 'pending');
  await assert.rejects(service.createAttendanceChallenge(request(device)), { code: 'NO_APPROVED_DEVICE' });
  const [selfUser] = await db`INSERT INTO users (school_id,person_id) VALUES (12,${personId}) RETURNING id`;
  await assert.rejects(deviceService.approveDeviceRegistration(device.registration.id, selfUser.id, 12), { code: 'SELF_APPROVAL_FORBIDDEN' });
  await assert.rejects(deviceService.approveDeviceRegistration(device.registration.id, adminId, 13), { code: 'NOT_FOUND' });
  await deviceService.approveDeviceRegistration(device.registration.id, adminId, 12);
  const inventory = await deviceService.listSchoolDeviceRegistrations(12);
  assert.equal(inventory[0].status, 'approved');
  const today = await service.getAuthoritativeTodayAttendance(12, staffId, personId, device.session.publicKey);
  assert.equal(today.device_registration_status, 'approved');
  await assert.rejects(service.createAttendanceChallenge(request(device, 'check_out')), { code: 'CHECK_IN_REQUIRED' });

  // The single-line transport must round-trip the exact PEM used for possession verification.
  const headers = { 'x-device-session-key': device.session.publicKey.replace(/\n/g, '\\n') };
  assert.doesNotMatch(headers['x-device-session-key'], /[\r\n]/);
  const proofTimestamp = String(Date.now()), proofNonce = crypto.randomUUID();
  const proof = { schoolId: 12, userId: selfUser.id, personId, installationId: device.installationId,
    publicKey: readStaffDevicePublicKey(headers), proofTimestamp, proofNonce, method: 'POST', path: '/attendance/v2/challenge',
    proofSignature: sign(device.session.privateKey, `staff-device-session:v1:${proofTimestamp}:${proofNonce}:POST:/attendance/v2/challenge`) };
  assert.equal((await deviceService.enforceStaffDeviceProof(proof)).required, true);
  await assert.rejects(deviceService.enforceStaffDeviceProof(proof), { code: 'DEVICE_PROOF_REPLAYED' });

  const challenge = await service.createAttendanceChallenge(request(device));
  const body = submission(device, challenge);
  const checkIn = await service.verifyAndRecordAttendance(body);
  assert.equal(checkIn.success, true); assert.equal(checkIn.action, 'check_in');
  assert.ok(checkIn.summary.checkInTime);
  const replay = await service.verifyAndRecordAttendance(body);
  assert.equal(replay.isIdempotentReplay, true);
  await assert.rejects(service.verifyAndRecordAttendance(submission(device, challenge)), { code: 'CHALLENGE_ALREADY_USED' });
  await assert.rejects(service.createAttendanceChallenge(request(device)), { code: 'ALREADY_CHECKED_IN' });
  const out = await service.createAttendanceChallenge(request(device, 'check_out'));
  assert.ok((await service.verifyAndRecordAttendance(submission(device, out))).summary.checkOutTime);
  await assert.rejects(service.createAttendanceChallenge(request(device, 'check_out')), { code: 'ALREADY_CHECKED_OUT' });
  const [count] = await db`SELECT count(*)::int AS n FROM staff_attendance_events WHERE source='mobile_v2'`;
  assert.equal(count.n, 2);

  const replacement = await register();
  await deviceService.approveDeviceRegistration(replacement.registration.id, adminId, 12);
  const [old] = await db`SELECT status FROM staff_device_registrations WHERE id=${device.registration.id}`;
  assert.equal(old.status, 'replaced');
  await assert.rejects(service.createAttendanceChallenge(request(device)), { code: 'NO_APPROVED_DEVICE' });
  await deviceService.revokeDeviceRegistration(replacement.registration.id, adminId, 12, 'Pilot revocation exercise');
  const revoked = await service.getAuthoritativeTodayAttendance(12, staffId, personId, replacement.session.publicKey);
  assert.equal(revoked.device_registration_status, 'revoked');
  assert.equal(revoked.can_check_out, false);
  await assert.rejects(service.createAttendanceChallenge(request(replacement)), { code: 'NO_APPROVED_DEVICE' });
});

test('geofence failures, expiry, tampering, policy changes and in-flight revocation never append events', async () => {
  await db`DELETE FROM staff_attendance`;
  const device = await register();
  await deviceService.approveDeviceRegistration(device.registration.id, adminId, 12);
  const base = { latitude: 17.385044, longitude: 78.486671, accuracy: 10, timestamp: Date.now(), mocked: false };
  for (const [code, changes] of [
    ['OUTSIDE_CAMPUS', { latitude: 17.39 }],
    ['LOCATION_UNCERTAIN_AT_BOUNDARY', { latitude: 17.385764, accuracy: 30 }],
    ['POOR_GPS_ACCURACY', { accuracy: 51 }],
    ['LOCATION_TOO_OLD', { timestamp: Date.now() - 31000 }],
    ['LOCATION_IN_FUTURE', { timestamp: Date.now() + 60000 }],
    ['MOCK_LOCATION_DETECTED', { mocked: true }],
    ['INVALID_ACCURACY', { accuracy: 0 }],
    ['COORDINATES_OUT_OF_BOUNDS', { latitude: 91 }],
  ]) {
    const challenge = await service.createAttendanceChallenge(request(device));
    await assert.rejects(service.verifyAndRecordAttendance(submission(device, challenge, { location: { ...base, ...changes } })), { code });
    const [row] = await db`SELECT consumed_at FROM attendance_challenges WHERE id=${challenge.challengeId}`;
    assert.equal(row.consumed_at, null);
  }
  let challenge = await service.createAttendanceChallenge(request(device));
  const tampered = submission(device, challenge); tampered.payload.location.accuracy = 11;
  await assert.rejects(service.verifyAndRecordAttendance(tampered), { code: 'INVALID_SIGNATURE' });
  await db`UPDATE attendance_challenges SET expires_at=now()-interval '1 second' WHERE id=${challenge.challengeId}`;
  await assert.rejects(service.verifyAndRecordAttendance(submission(device, challenge)), { code: 'CHALLENGE_EXPIRED' });
  challenge = await service.createAttendanceChallenge(request(device));
  await db`UPDATE campus_attendance_policies SET policy_version='v2' WHERE id=${policyId}`;
  await assert.rejects(service.verifyAndRecordAttendance(submission(device, challenge)), { code: 'POLICY_CHANGED' });
  challenge = await service.createAttendanceChallenge(request(device));
  await deviceService.revokeDeviceRegistration(device.registration.id, adminId, 12, 'Revoke before verify');
  await assert.rejects(service.verifyAndRecordAttendance(submission(device, challenge)), { code: 'CHALLENGE_ALREADY_USED' });
  const [count] = await db`SELECT count(*)::int AS n FROM staff_attendance_events WHERE source='mobile_v2'`;
  assert.equal(count.n, 2);
  const [summaries] = await db`SELECT count(*)::int AS n FROM staff_attendance`;
  assert.equal(summaries.n, 0);
});


test('administrator HTTP policy updates, rejection and exception inventory use real schema', async () => {
  const send = async (path, method, body, schoolId = 12) => {
    const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-school': String(schoolId) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  // Partial rollback must work without undefined PostgreSQL parameters.
  let result = await send('/admin/policy', 'PUT', { enforcement_mode: 'disabled' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.enforcement_mode, 'disabled');
  assert.equal(result.body.data.school_timezone, 'Asia/Kolkata');
  result = await send('/admin/policy', 'PUT', { enforcement_mode: 'pilot' }, 13);
  assert.equal(result.status, 400); // Never silently use example campus coordinates.
  result = await send('/admin/policy', 'PUT', { challenge_expiry_seconds: 45, school_timezone: 'Asia/Kolkata', enforcement_mode: 'pilot' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.challenge_expiry_seconds, 45);
  result = await send('/admin/policy', 'PUT', { school_timezone: 'Invalid/Timezone' });
  assert.equal(result.status, 400);
  const device = await register();
  result = await send(`/admin/registrations/${device.registration.id}/reject`, 'POST', { reason: 'Pilot test rejection' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.status, 'rejected');
  const today = (await service.getAuthoritativeTodayAttendance(12, staffId, personId, device.session.publicKey)).attendance_date;
  result = await send('/exceptions', 'POST', { attendance_date: today, action: 'check_in', reason: 'GPS unavailable during pilot' });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  result = await send('/admin/exceptions', 'GET');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.length, 1);
  const exceptionId = result.body.data[0].id;
  // A finalized date must be found as a DATE, not missed by timestamp comparison.
  await db`INSERT INTO staff_attendance (school_id,staff_id,attendance_date,status,is_finalized)
    VALUES (12,${staffId},${today}::date,'absent',true)`;
  result = await send(`/admin/exceptions/${exceptionId}/review`, 'POST', { decision: 'approved', mark_status: 'present', notes: 'Pilot review' });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  const [pending] = await db`SELECT status FROM staff_attendance_exceptions WHERE id=${exceptionId}`;
  assert.equal(pending.status, 'pending');
  await db`UPDATE staff_attendance SET is_finalized=false WHERE school_id=12 AND staff_id=${staffId}`;
  result = await send(`/admin/exceptions/${exceptionId}/review`, 'POST', { decision: 'approved', mark_status: 'present', notes: 'Pilot review' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.summary.is_verified, false);
  assert.equal(result.body.data.summary.verification_source, 'exception_approved');
  // Boundary errors retain their protocol code at the HTTP boundary.
  const approved = await register();
  await deviceService.approveDeviceRegistration(approved.registration.id, adminId, 12);
  const challenge = await service.createAttendanceChallenge(request(approved));
  const value = submission(approved, challenge, { location: { latitude: 91, longitude: 78, accuracy: 10, timestamp: Date.now(), mocked: false } });
  result = await send('/verify', 'POST', { challenge_id: value.challengeId, payload: value.payload, signature: value.signature, idempotency_key: value.idempotencyKey });
  assert.equal(result.status, 422, JSON.stringify(result.body));
  assert.equal(result.body.code, 'COORDINATES_OUT_OF_BOUNDS');
});
