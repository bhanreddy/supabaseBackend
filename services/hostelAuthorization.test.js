import assert from 'node:assert/strict';
import test from 'node:test';

import { requirePermission } from '../middleware/auth.js';

function runPermission(permission, user) {
  let nextCalled = false;
  let statusCode = 200;
  let payload = null;
  const req = {
    user,
    method: 'POST',
    originalUrl: '/api/v1/hostel/test',
  };
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return body; },
  };
  requirePermission(permission)(req, res, () => { nextCalled = true; });
  return { nextCalled, statusCode, payload };
}

test('accounts can assign hostel students with hostel.allocate', () => {
  const result = runPermission('hostel.allocate', {
    internal_id: 'accounts-user',
    roles: ['accounts'],
    permissions: ['hostel.view', 'hostel.allocate'],
  });
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, 200);
});

test('accounts allocation authority does not allow hostel setup or fee management', () => {
  const result = runPermission('hostel.manage', {
    internal_id: 'accounts-user',
    roles: ['accounts'],
    permissions: ['hostel.view', 'hostel.allocate'],
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.payload.code, 'FORBIDDEN');
});

test('admin retains full hostel management authority', () => {
  const result = runPermission('hostel.manage', {
    internal_id: 'admin-user',
    roles: ['admin'],
    permissions: [],
  });
  assert.equal(result.nextCalled, true);
});
