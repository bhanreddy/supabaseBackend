import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCalibrationLeg } from './transportCalibrationAdminService.js';
import { requirePermission } from '../middleware/auth.js';
import { requireSchoolId } from '../middleware/schoolId.js';

test('calibration leg parsing is explicit and never defaults invalid input to morning', () => {
  assert.equal(parseCalibrationLeg('morning'), 'morning');
  assert.equal(parseCalibrationLeg('evening'), 'evening');
  assert.equal(parseCalibrationLeg('afternoon'), 'evening');
  assert.equal(parseCalibrationLeg('garbage'), null);
  assert.equal(parseCalibrationLeg(undefined), null);
});

test('transport.manage is required for calibration mutations', () => {
  const middleware = requirePermission('transport.manage');
  let nextCalled = false;
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  middleware({
    user: { internal_id: 'user-1', roles: ['staff'], permissions: ['transport.view'] },
    method: 'PATCH', originalUrl: '/api/v1/transport/stops/stop-1/geo',
  }, response, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 403);
});

test('calibration endpoints ignore client tenant input and use the JWT school', () => {
  for (const request of [
    { method: 'GET', path: '/api/v1/transport/routes/route-1/calibration', query: { school_id: '999' } },
    { method: 'POST', path: '/api/v1/transport/routes/route-1/calibration/reset', body: { school_id: '999' } },
    { method: 'PATCH', path: '/api/v1/transport/stops/stop-1/geo', body: { school_id: '999' } },
  ]) {
    const req = { ...request, user: { schoolId: 7 } };
    let nextCalled = false;
    requireSchoolId(req, {}, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.schoolId, '7');
  }
});
