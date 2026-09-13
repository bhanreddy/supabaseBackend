import assert from 'node:assert/strict';
import test from 'node:test';

import { isStaffPortalIdentityPath } from '../utils/staffPortalAccessPath.js';

test('auth identity routes are not impersonated', () => {
  assert.equal(isStaffPortalIdentityPath('/api/v1/auth/validate-school-user'), true);
  assert.equal(isStaffPortalIdentityPath('/api/v1/auth/contexts?device_id=1'), true);
  assert.equal(isStaffPortalIdentityPath('/api/v1/auth/contexts/switch'), true);
  assert.equal(isStaffPortalIdentityPath('/api/v1/auth/me'), true);
});

test('staff portal operational routes remain impersonatable', () => {
  assert.equal(isStaffPortalIdentityPath('/api/v1/staff/me/profile'), false);
  assert.equal(isStaffPortalIdentityPath('/api/v1/attendance/my-class'), false);
  assert.equal(isStaffPortalIdentityPath('/api/v1/diary'), false);
});
