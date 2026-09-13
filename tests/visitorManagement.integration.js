import assert from 'node:assert/strict';
import test from 'node:test';
import sql from '../db.js';
import {
  createVisitorRequest,
  checkInVisitor,
  checkOutVisitor,
  getCurrentlyInsideCampus,
} from '../services/visitorManagementService.js';
import { validateVisitorPassToken } from '../services/visitorQrService.js';
import { approveVisitorRequest } from '../services/visitorApprovalService.js';
import { reportSecurityIncident, addToWatchlist } from '../services/visitorIncidentService.js';

test('Visitor Management Integration Test Suite', async (t) => {
  const [school] = await sql`SELECT id FROM public.schools LIMIT 1`;
  if (!school) {
    console.log('Skipping integration test: No schools found in database');
    return;
  }
  const schoolId = school.id;

  // 1. Create a gate for the school
  const [gate] = await sql`
    INSERT INTO public.school_gates (school_id, name, code, gate_type)
    VALUES (${schoolId}, 'Integration Test Gate', ${'IT_GATE_' + Date.now()}, 'mixed')
    RETURNING *
  `;
  assert.ok(gate.id, 'Gate must be created');

  // 2. Create visitor request (pending approval)
  const randomMobile = '9' + Math.floor(100000000 + Math.random() * 900000000);
  const now = new Date();
  const visitDateStr = now.toISOString().split('T')[0];

  const reqResult = await createVisitorRequest({
    schoolId,
    visitorFullName: 'Ramesh Sharma',
    visitorMobile: randomMobile,
    visitorType: 'PARENT',
    visitDate: visitDateStr,
    startTime: '08:00',
    endTime: '20:00',
    purpose: 'Teacher Parent Meeting',
    gateId: gate.id,
  });

  assert.ok(reqResult.request.id, 'Visitor request must be created');
  assert.equal(reqResult.request.approval_status, 'PENDING', 'Request should start as PENDING');

  // 3. Approve visitor request -> issues QR pass
  const approval = await approveVisitorRequest({
    schoolId,
    requestId: reqResult.request.id,
    approvedByUserId: null,
  });
  assert.equal(approval.request.approval_status, 'APPROVED', 'Request must be APPROVED');
  assert.ok(approval.pass.id, 'Pass must be created');
  assert.ok(approval.qrToken, 'Opaque QR token must be generated');

  // 4. Validate pass token
  const validation = await validateVisitorPassToken({
    schoolId,
    token: approval.qrToken,
    gateId: gate.id,
  });
  assert.equal(validation.isValid, true, 'Valid pass token must return isValid: true');
  assert.equal(validation.pass.visitor_name, 'Ramesh Sharma');

  const wrongSchool = await validateVisitorPassToken({
    schoolId: Number(schoolId) + 99999,
    token: approval.qrToken,
    gateId: gate.id,
  });
  assert.equal(wrongSchool.reason === 'WRONG_SCHOOL' || wrongSchool.isValid === false, true);

  const tampered = await validateVisitorPassToken({
    schoolId,
    token: approval.qrToken.slice(0, -2) + 'ff',
    gateId: gate.id,
  });
  assert.equal(tampered.isValid, false);

  // 5. Check in visitor
  const checkin = await checkInVisitor({
    schoolId,
    passToken: approval.qrToken,
    gateId: gate.id,
    gatekeeperUserId: null,
    vehicleNumber: 'KA-01-AB-1234',
    verificationMethod: 'QR_SCAN',
  });
  assert.ok(checkin.id, 'Checkin record must be created');
  assert.equal(checkin.status, 'INSIDE', 'Status must be INSIDE');

  // 6. Double scan concurrency check: Scanning again while inside must fail
  await assert.rejects(
    async () => {
      await checkInVisitor({
        schoolId,
        passToken: approval.qrToken,
        gateId: gate.id,
        gatekeeperUserId: null,
      });
    },
    (err) => {
      assert.ok(
        err.message.includes('already checked in') || err.message.includes('already been used') || err.code === 'ALREADY_INSIDE',
        'Should reject duplicate check-in'
      );
      return true;
    }
  );

  // 7. Verify inside campus list includes visitor
  const inside = await getCurrentlyInsideCampus(schoolId);
  const found = inside.find((v) => v.checkin_id === checkin.id);
  assert.ok(found, 'Visitor must appear in currently inside register');
  assert.equal(found.visitor_name, 'Ramesh Sharma');

  // 8. Check out visitor
  const checkout = await checkOutVisitor({
    schoolId,
    checkinId: checkin.id,
    exitGateId: gate.id,
  });
  assert.equal(checkout.status, 'EXITED', 'Check-out status must be EXITED');
  assert.ok(checkout.checked_out_at, 'Check-out timestamp must be set');

  // 9. Security Incident reporting
  const incident = await reportSecurityIncident({
    schoolId,
    gateId: gate.id,
    reportedByUserId: null,
    visitorProfileId: reqResult.profile.id,
    incidentType: 'EXPIRED_PASS',
    severity: 'LOW',
    description: 'Test incident logging',
  });
  assert.ok(incident.id, 'Security incident must be recorded');

  // 10. Watchlist
  const watchlist = await addToWatchlist({
    schoolId,
    name: 'Suspicious Individual',
    mobile: '9888888888',
    restrictionLevel: 'BLOCKED',
    reason: 'Trespassing attempt',
  });
  assert.ok(watchlist.id, 'Watchlist entry must be created');

  // Clean up test gate
  await sql`DELETE FROM public.school_gates WHERE id = ${gate.id}`;
});
