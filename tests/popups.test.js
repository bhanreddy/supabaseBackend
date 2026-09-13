import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionAllowedForRoles,
  isFrequencyEligible,
  isSafeExternalUrl,
  isWithinSchedule,
  mapRolesToGroups,
  normalizeButtons,
  normalizeTargeting,
  sortPopupQueue,
  targetingHasAudience,
  userMatchesTargeting,
  validateActionPayload,
} from '../services/popupConstants.js';
import { requireSchoolId } from '../middleware/schoolId.js';

function parentCtx(overrides = {}) {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    schoolId: 17,
    roles: ['parent'],
    roleGroups: ['parent'],
    studentIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    classIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    sectionIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
    staffId: null,
    routeIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
    departmentIds: [],
    ...overrides,
  };
}

test('popup targeting is school-scoped in the matcher context and ignores other-school users', () => {
  const targeting = normalizeTargeting({ roles: ['parent'], class_ids: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], section_ids: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'] });
  assert.equal(userMatchesTargeting(parentCtx(), targeting), true);
  assert.equal(userMatchesTargeting(parentCtx({ sectionIds: ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'] }), targeting), false);
  assert.equal(userMatchesTargeting(parentCtx({ schoolId: 99, classIds: [], sectionIds: [] }), targeting), false);
});

test('role targeting maps management/staff/parent/accounts/driver groups', () => {
  assert.deepEqual(mapRolesToGroups(['admin']), ['management']);
  assert.deepEqual(mapRolesToGroups(['teacher', 'staff']), ['staff']);
  assert.deepEqual(mapRolesToGroups(['student']), ['parent']);
  assert.deepEqual(mapRolesToGroups(['accountant']), ['accounts']);
  assert.deepEqual(mapRolesToGroups(['driver']), ['driver']);
  const everyone = normalizeTargeting({ everyone: true });
  assert.equal(userMatchesTargeting(parentCtx({ roles: ['driver'], roleGroups: ['driver'] }), everyone), true);
});

test('class 8A parent matches and class 8B parent does not', () => {
  const targeting = normalizeTargeting({
    roles: ['parent'],
    class_ids: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    section_ids: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
  });
  assert.equal(userMatchesTargeting(parentCtx(), targeting), true);
  assert.equal(userMatchesTargeting(parentCtx({
    sectionIds: ['ffffffff-ffff-4fff-8fff-ffffffffffff'],
  }), targeting), false);
});

test('route targeting matches assigned driver and parents', () => {
  const targeting = normalizeTargeting({
    roles: ['parent', 'driver'],
    route_ids: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
  });
  assert.equal(userMatchesTargeting(parentCtx(), targeting), true);
  assert.equal(userMatchesTargeting(parentCtx({
    roles: ['driver'],
    roleGroups: ['driver'],
    studentIds: [],
    classIds: [],
    sectionIds: [],
  }), targeting), true);
  assert.equal(userMatchesTargeting(parentCtx({ routeIds: [] }), targeting), false);
});

test('schedule eligibility uses server timestamps, not a missing end date as expiry', () => {
  const now = new Date('2026-09-11T10:00:00Z');
  assert.equal(isWithinSchedule({ start_at: '2026-09-08T00:00:00Z', end_at: '2026-09-30T18:29:59Z' }, now), true);
  assert.equal(isWithinSchedule({ start_at: '2026-09-12T00:00:00Z', end_at: null }, now), false);
  assert.equal(isWithinSchedule({ start_at: '2026-09-01T00:00:00Z', end_at: '2026-09-10T00:00:00Z' }, now), false);
  assert.equal(isWithinSchedule({ start_at: '2026-09-01T00:00:00Z', end_at: null }, now), true);
});

test('SHOW_ONCE still appears when the user never opened the app (no state row)', () => {
  const popup = { frequency: 'SHOW_ONCE' };
  assert.equal(isFrequencyEligible(popup, null), true);
  assert.equal(isFrequencyEligible(popup, { first_seen_at: '2026-09-10T00:00:00Z' }), false);
  assert.equal(isFrequencyEligible(popup, { dismissed_at: '2026-09-10T00:00:00Z' }), false);
});

test('UNTIL_ACKNOWLEDGED keeps showing until acknowledged, including missed days', () => {
  const popup = { frequency: 'UNTIL_ACKNOWLEDGED' };
  assert.equal(isFrequencyEligible(popup, null), true);
  assert.equal(isFrequencyEligible(popup, { first_seen_at: '2026-09-08T00:00:00Z' }), true);
  assert.equal(isFrequencyEligible(popup, { acknowledged_at: '2026-09-09T00:00:00Z' }), false);
});

test('EVERY_LOGIN is session-scoped and ONCE_PER_DAY is school-timezone day scoped', () => {
  const every = { frequency: 'EVERY_LOGIN' };
  assert.equal(isFrequencyEligible(every, { last_session_id: 's1' }, { sessionId: 's1' }), false);
  assert.equal(isFrequencyEligible(every, { last_session_id: 's1' }, { sessionId: 's2' }), true);
  const daily = { frequency: 'ONCE_PER_DAY' };
  const now = new Date('2026-09-11T10:00:00Z');
  assert.equal(isFrequencyEligible(daily, { last_displayed_at: '2026-09-11T04:00:00Z' }, { now, timeZone: 'Asia/Kolkata' }), false);
  assert.equal(isFrequencyEligible(daily, { last_displayed_at: '2026-09-10T04:00:00Z' }, { now, timeZone: 'Asia/Kolkata' }), true);
});

test('UNTIL_ACTION_COMPLETED hides when the live condition is resolved', () => {
  const popup = { frequency: 'UNTIL_ACTION_COMPLETED' };
  assert.equal(isFrequencyEligible(popup, null, { actionCompleted: false }), true);
  assert.equal(isFrequencyEligible(popup, null, { actionCompleted: true }), false);
  assert.equal(isFrequencyEligible(popup, { completed_at: '2026-09-11T00:00:00Z' }), false);
});

test('queue sorts CRITICAL then HIGH then NORMAL then LOW, then schedule time', () => {
  const ranked = sortPopupQueue([
    { id: 'n', priority: 'NORMAL', start_at: '2026-09-11T10:00:00Z' },
    { id: 'c', priority: 'CRITICAL', start_at: '2026-09-11T12:00:00Z' },
    { id: 'h', priority: 'HIGH', start_at: '2026-09-11T08:00:00Z' },
    { id: 'l', priority: 'LOW', start_at: '2026-09-11T07:00:00Z' },
  ]).map((p) => p.id);
  assert.deepEqual(ranked, ['c', 'h', 'n', 'l']);
});

test('CTA registry rejects raw paths, javascript URLs, and role-incompatible admin reports', () => {
  assert.throws(() => validateActionPayload('OPEN_MODULE', '../../AdminUsers', {}));
  assert.throws(() => validateActionPayload('EXTERNAL_URL', 'javascript:alert(1)', {}));
  assert.throws(() => validateActionPayload('EXTERNAL_URL', 'http://example.com', {}));
  assert.equal(isSafeExternalUrl('https://play.google.com/store'), true);
  assert.equal(actionAllowedForRoles('OPEN_MODULE', 'OPEN_REPORTS', ['parent']), false);
  assert.equal(actionAllowedForRoles('OPEN_MODULE', 'OPEN_FEES', ['parent']), true);
  assert.equal(actionAllowedForRoles('OPEN_MODULE', 'OPEN_FEES', ['driver']), false);
});

test('buttons are capped at two and require labels', () => {
  const buttons = normalizeButtons([
    { label: 'View Fees', actionType: 'OPEN_MODULE', target: 'OPEN_FEES' },
    { label: 'Later', actionType: 'DISMISS' },
  ]);
  assert.equal(buttons.length, 2);
  assert.throws(() => normalizeButtons([
    { label: 'A', actionType: 'DISMISS' },
    { label: 'B', actionType: 'DISMISS' },
    { label: 'C', actionType: 'DISMISS' },
  ]));
});

test('publish targeting requires an audience', () => {
  assert.equal(targetingHasAudience({ roles: ['parent'] }), true);
  assert.equal(targetingHasAudience({}), false);
});

function invoke(path, { method = 'GET', user = null, query = {}, body = {} } = {}) {
  const req = { path, method, user, query, body };
  let continued = false;
  let statusCode = 200;
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  requireSchoolId(req, res, () => { continued = true; });
  return { req, res, continued, statusCode };
}

test('popup APIs ignore client school_id and use the JWT tenant', () => {
  for (const path of [
    '/api/v1/popups/eligible',
    '/api/v1/popups/inbox',
    '/api/v1/popups/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/view',
    '/api/v1/admin/popups',
    '/api/v1/admin/popups/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/publish',
  ]) {
    const result = invoke(path, {
      method: 'POST',
      user: { schoolId: 17 },
      query: { school_id: '999' },
      body: { school_id: '999' },
    });
    assert.equal(result.continued, true, path);
    assert.equal(result.req.schoolId, '17', path);
  }
});

test('popup APIs reject missing authenticated school context even with a client school_id', () => {
  const result = invoke('/api/v1/popups/eligible', {
    query: { school_id: '17' },
  });
  assert.equal(result.continued, false);
  assert.equal(result.statusCode, 401);
});
