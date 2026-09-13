import assert from 'node:assert/strict';
import test from 'node:test';

import { requireSchoolId } from '../middleware/schoolId.js';

function invoke(path, {
  method = 'PATCH',
  user = { schoolId: 12 },
  query = {},
  body = {},
} = {}) {
  const req = { path, method, user, query, body, headers: {} };
  let statusCode = 200;
  let payload;
  let continued = false;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };

  requireSchoolId(req, res, () => {
    continued = true;
  });

  return { req, statusCode, payload, continued };
}

test('authenticated user with no client school_id automatically receives trusted schoolId', () => {
  const result = invoke('/api/v1/students', {
    method: 'GET',
    user: { schoolId: 12 },
  });

  assert.equal(result.continued, true);
  assert.equal(result.req.schoolId, '12');
  assert.equal(result.payload, undefined);
});

test('authenticated user passing matching client school_id is accepted', () => {
  const result = invoke('/api/v1/students', {
    method: 'GET',
    user: { schoolId: 12 },
    query: { school_id: '12' },
  });

  assert.equal(result.continued, true);
  assert.equal(result.req.schoolId, '12');
});

test('authenticated user passing mismatching client school_id is rejected with 403', () => {
  const result = invoke('/api/v1/students', {
    method: 'GET',
    user: { schoolId: 12 },
    query: { school_id: '99' },
  });

  assert.equal(result.continued, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.payload?.code, 'CROSS_TENANT_FORBIDDEN');
});

test('platform admin passing target school_id is allowed', () => {
  const result = invoke('/api/v1/students', {
    method: 'GET',
    user: { schoolId: 1, roles: ['platform_admin'] },
    query: { school_id: '99' },
  });

  assert.equal(result.continued, true);
  assert.equal(result.req.schoolId, '99');
});

test('school settings subroutes require an authenticated school context', () => {
  const result = invoke('/api/v1/school-settings/principal-signature', {
    user: null,
  });

  assert.equal(result.continued, false);
  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.payload, { success: false, error: 'Unauthorized' });
});

test('student photo uploads derive the tenant from the authenticated operator', () => {
  for (const path of [
    '/api/v1/students/student-1/photo',
    '/students/student-1/photo',
  ]) {
    const result = invoke(path, {
      method: 'POST',
      user: { schoolId: 12 },
      query: { school_id: '12' },
    });

    assert.equal(result.continued, true);
    assert.equal(result.req.schoolId, '12');
  }
});

test('student photo removal requires an authenticated school context', () => {
  const result = invoke('/api/v1/students/student-1/photo', {
    method: 'DELETE',
    user: null,
    query: { school_id: '99' },
  });

  assert.equal(result.continued, false);
  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.payload, { success: false, error: 'Unauthorized' });
});

test('public certificate verification remains available without a school context', () => {
  const result = invoke('/api/v1/certificates/verify/TC-2026-00001', { method: 'GET', user: null });
  assert.equal(result.continued, true);
  assert.equal(result.req.schoolId, undefined);
});

test('student login QR routes ignore client school_id and use the JWT tenant', () => {
  const result = invoke('/api/v1/student-login-qr/students', {
    method: 'GET',
    user: { schoolId: 12 },
    query: { school_id: '99', classId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  });

  assert.equal(result.continued, true);
  assert.equal(result.req.schoolId, '12');
});

test('student login QR routes reject unauthenticated access even with a client school_id', () => {
  const result = invoke('/api/v1/student-login-qr/17/generate', {
    method: 'POST',
    user: null,
    body: { school_id: '12' },
  });

  assert.equal(result.continued, false);
  assert.equal(result.statusCode, 401);
});
