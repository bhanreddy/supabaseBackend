import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import express from 'express';

let contextRefreshes = 0;
let contextBuilds = 0;
let deviceConflict = null;
let dbUser;
const sql = async (strings) => {
  const query = strings.join('?');
  if (query.includes('FROM users u')) return dbUser ? [dbUser] : [];
  if (query.includes('FROM student_enrollments')) return [{ class_section_id: 'class-b' }];
  return [];
};
mock.module('../db.js', { defaultExport: sql, namedExports: { supabase: {}, supabaseAdmin: {}, createRequestAuthClient: () => ({}) } });
mock.module('../config/env.js', { defaultExport: { nodeEnv: 'test' } });

mock.module('../services/staffDeviceService.js', { namedExports: {
  enforceStaffDeviceProof: async () => true,
  checkDeviceOwnershipConflict: async () => deviceConflict,
} });
mock.module('../services/accessContextService.js', { namedExports: {
  refreshUserAccessContexts: async () => { contextRefreshes += 1; }, buildContextsPayload: async () => { contextBuilds += 1; return { total: 1 }; },
  registerDeviceSession: async () => ({}), switchActiveContext: async () => ({}),
} });
mock.module('../services/studentLoginQrService.js', { namedExports: {
  exchangeLoginQrForSession: async () => ({}), revokeLoginQrForUser: async () => {},
} });
mock.module('../middleware/rateLimiter.js', { namedExports: { qrLoginLimiter: (req, res, next) => next() } });
mock.module('../utils/logger.js', { defaultExport: { info() {}, warn() {}, error() {} } });

const { default: authRoutes } = await import('../routes/authRoutes.js');
let server;
let baseUrl;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.schoolId = 12;
    req.user = req.headers.authorization ? { id: 'user-1', roles: ['student'], permissions: ['diary:view'] } : null;
    next();
  });
  app.use('/auth', authRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });


beforeEach(() => {
  contextRefreshes = 0;
  contextBuilds = 0;
  deviceConflict = null;
  dbUser = {
    user_id: 'user-1', school_id: 12, person_id: 'person-1',
    account_status: 'active', role_code: 'student', role_name: 'Student',
    has_student_profile: true, has_staff_profile: false,
  };
});
async function validate(body = {}) {
  const response = await fetch(`${baseUrl}/auth/validate-school-user`, {
    method: 'POST',
    headers: { Authorization: 'Bearer target-session', 'Content-Type': 'application/json', 'x-device-id': 'install-1' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
test('saved-account validation returns fresh identity and class without rebuilding portal contexts', async () => {
  const result = await validate({ includePortalContexts: false });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.userId, 'user-1');
  assert.equal(result.body.data.classId, 'class-b');
  assert.deepEqual(result.body.data.permissions, ['diary:view']);
  assert.equal(result.body.data.portalContexts, null);
  assert.equal(contextRefreshes, 0);
  assert.equal(contextBuilds, 0);
});
for (const body of [{}, { includePortalContexts: true }, { includePortalContexts: 'false' }]) {
  test(`default validation retains full contexts: ${JSON.stringify(body)}`, async () => {
    const result = await validate(body);
    assert.equal(result.status, 200);
    assert.equal(contextRefreshes, 1);
    assert.equal(contextBuilds, 1);
    assert.deepEqual(result.body.data.portalContexts, { total: 1 });
  });
}
for (const [label, change, code] of [
  ['locked', { account_status: 'locked' }, 'ACCOUNT_LOCKED'],
  ['inactive', { account_status: 'inactive' }, 'ACCOUNT_NOT_ACTIVE'],
  ['wrong school', { school_id: 99 }, 'SCHOOL_MISMATCH'],
]) {
  test(`lightweight validation still rejects ${label} accounts`, async () => {
    Object.assign(dbUser, change);
    const result = await validate({ includePortalContexts: false });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, code);
    assert.equal(contextRefreshes, 0);
  });
}
test('lightweight validation rejects missing accounts', async () => {
  dbUser = null;
  const result = await validate({ includePortalContexts: false });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'ACCOUNT_NOT_IN_SCHOOL');
});
test('lightweight validation retains staff device ownership enforcement', async () => {
  dbUser.has_staff_profile = true;
  deviceConflict = { conflict: true };
  const result = await validate({ includePortalContexts: false });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'DEVICE_OWNED_BY_ANOTHER_STAFF');
  assert.equal(contextRefreshes, 0);
});
