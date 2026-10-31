import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import express from 'express';
import { isTransientError } from '../utils/retry.js';

let authError = null;
let roles = ['staff'];
let getUserCalls = 0;
const signOutCalls = [];
const refreshCalls = [];
let refreshError = null;
let authClientCount = 0;
const sql = async () => [{
  id: 'user-1', school_id: 12, person_id: 'person-1', account_status: 'active',
  roles, permissions: [], unrestricted_access: true,
  last_login_at: '2020-01-01T00:00:00Z',
}];

mock.module('../db.js', {
  defaultExport: sql,
  namedExports: {
    supabase: { auth: { getUser: async () => {
      getUserCalls += 1;
      return { data: { user: authError ? null : { id: 'user-1' } }, error: authError };
    } } },
    supabaseAdmin: { auth: { admin: { signOut: async (...args) => {
      signOutCalls.push(args);
      return { error: null };
    } } } },
    createRequestAuthClient: () => {
      const clientId = ++authClientCount;
      return { auth: { refreshSession: async ({ refresh_token }) => {
        refreshCalls.push({ clientId, refresh_token });
        return {
          data: {
            user: { id: 'user-1' },
            session: { access_token: `access-${refresh_token}`, refresh_token: `new-${refresh_token}`, expires_at: 9999999999 },
          },
          error: refreshError,
        };
      } } };
    },
  },
});
mock.module('../config/env.js', { defaultExport: { nodeEnv: 'test' } });
mock.module('../utils/retry.js', { namedExports: { isTransientError, withRetry: async (fn) => fn() } });
mock.module('../services/staffDeviceService.js', { namedExports: {
  enforceStaffDeviceProof: async () => true,
  checkDeviceOwnershipConflict: async () => null,
} });
mock.module('../services/accessContextService.js', { namedExports: {
  refreshUserAccessContexts: async () => {}, buildContextsPayload: async () => ({}),
  registerDeviceSession: async () => ({}), switchActiveContext: async () => ({}),
} });
mock.module('../services/studentLoginQrService.js', { namedExports: {
  exchangeLoginQrForSession: async () => ({}), revokeLoginQrForUser: async () => {},
} });
mock.module('../middleware/rateLimiter.js', { namedExports: { qrLoginLimiter: (req, res, next) => next() } });
mock.module('../utils/logger.js', { defaultExport: { info() {}, warn() {}, error() {} } });

const { identifyUser } = await import('../middleware/auth.js');
const { default: authRoutes } = await import('../routes/authRoutes.js');
let tokenSequence = 0;
function token(exp = Math.floor(Date.now() / 1000) + 3600) {
  return `header.${Buffer.from(JSON.stringify({ exp, nonce: ++tokenSequence })).toString('base64url')}.signature`;
}
async function identify(accessToken, refreshToken) {
  const req = {
    headers: { authorization: `Bearer ${accessToken}`, ...(refreshToken ? { 'authorization-refresh': refreshToken } : {}) },
    originalUrl: '/api/v1/staff/me/profile',
  };
  const result = { next: false, status: 200, headers: {} };
  const res = {
    status(value) { result.status = value; return this; },
    json(body) { result.body = body; return this; },
    setHeader(key, value) { result.headers[key] = value; },
  };
  await identifyUser(req, res, () => { result.next = true; });
  return { ...result, user: req.user };
}

beforeEach(() => {
  authError = null;
  refreshError = null;
  roles = ['staff'];
  getUserCalls = 0;
  signOutCalls.length = 0;
  refreshCalls.length = 0;
});

for (const role of ['staff', 'teacher', 'principal', 'student', 'parent', 'accounts', 'accountant', 'admin']) {
  test(`${role} retains authentication regardless of login age`, async () => {
    roles = [role];
    const result = await identify(token());
    assert.equal(result.next, true);
    assert.equal(result.user.id, 'user-1');
    assert.equal(signOutCalls.length, 0);
  });
}

for (const error of [
  { code: 'ECONNRESET' }, { cause: { code: 'EAI_AGAIN' } },
  { name: 'AbortError' }, { status: 429 }, { status: 503 },
  { message: 'Network request failed' },
]) {
  test(`temporary auth failure ${JSON.stringify(error)} returns 503 without invalidating the session`, async () => {
    authError = error;
    const result = await identify(token());
    assert.equal(result.status, 503);
    assert.equal(result.next, false);
    assert.equal(signOutCalls.length, 0);
  });
}

test('a cached token stops authenticating when its JWT expires', async () => {
  const now = Date.now();
  const accessToken = token(Math.floor(now / 1000) + 60);
  assert.equal((await identify(accessToken)).user.id, 'user-1');
  const originalNow = Date.now;
  Date.now = () => now + 61_000;
  try {
    authError = { status: 401, code: 'jwt_expired', message: 'JWT expired' };
    assert.equal((await identify(accessToken)).user, null);
    assert.equal(getUserCalls, 2);
  } finally {
    Date.now = originalNow;
  }
});

test('a transient legacy token refresh failure stays retryable', async () => {
  authError = { status: 401, code: 'jwt_expired' };
  refreshError = { status: 503, message: 'auth temporarily unavailable' };
  const result = await identify(token(), 'legacy-refresh');
  assert.equal(result.status, 503);
  assert.equal(result.next, false);
});

let server;
let baseUrl;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.schoolId = 12;
    req.user = req.headers.authorization ? { id: 'user-1' } : null;
    next();
  });
  app.use('/auth', authRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });

test('logout revokes the request bearer session with local scope', async () => {
  const response = await fetch(`${baseUrl}/auth/logout`, {
    method: 'POST', headers: { Authorization: 'Bearer device-session' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(signOutCalls, [['device-session', 'local']]);
});

test('unauthenticated logout cannot revoke another session', async () => {
  const response = await fetch(`${baseUrl}/auth/logout`, { method: 'POST' });
  assert.equal(response.status, 401);
  assert.deepEqual(signOutCalls, []);
});

test('concurrent refresh requests use independent auth clients and tokens', async () => {
  const responses = await Promise.all(['staff', 'parent'].map(async (id) => {
    const response = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: id }),
    });
    return response.json();
  }));
  assert.equal(responses[0].data.token, 'access-staff');
  assert.equal(responses[1].data.token, 'access-parent');
  assert.notEqual(refreshCalls[0].clientId, refreshCalls[1].clientId);
});

test('refresh endpoint distinguishes temporary service failure from rejected tokens', async () => {
  for (const [status, expected] of [[503, 503], [429, 503], [400, 401]]) {
    refreshError = { status, message: 'refresh failed' };
    const response = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: 'refresh' }),
    });
    assert.equal(response.status, expected);
  }
});
