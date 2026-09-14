import assert from 'node:assert/strict';
import test from 'node:test';
import { requireSchoolId } from '../middleware/schoolId.js';

function invokeMiddleware(req, res) {
  let continued = false;
  requireSchoolId(req, res, () => {
    continued = true;
  });
  return continued;
}

function mockResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    },
  };
}

test('Anecdote Tenant Security: School A user cannot query School B anecdotes via query param', () => {
  const req = {
    method: 'GET',
    path: '/api/v1/anecdotes',
    user: { schoolId: 101, roles: ['teacher'] },
    query: { school_id: '102' },
    body: {},
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);

  assert.equal(continued, true, 'Middleware must continue because /api/v1/anecdotes is in JWT_SCHOOL_ID_PATHS');
  assert.equal(req.schoolId, '101', 'req.schoolId must strictly be derived from JWT schoolId, ignoring client query');
});

test('Anecdote Tenant Security: School A user cannot post to School B anecdotes via body param', () => {
  const req = {
    method: 'POST',
    path: '/api/v1/anecdotes',
    user: { schoolId: 101, roles: ['teacher'] },
    query: {},
    body: { school_id: '102', observation_text: 'Test note' },
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);

  assert.equal(continued, true);
  assert.equal(req.schoolId, '101', 'req.schoolId must be 101, never trusting body school_id 102');
});

test('Intelligence Tenant Security: School A user cannot query School B intelligence cockpit', () => {
  const req = {
    method: 'GET',
    path: '/api/v1/intelligence/school',
    user: { schoolId: 101, roles: ['admin'] },
    query: { school_id: '102' },
    body: {},
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);

  assert.equal(continued, true);
  assert.equal(req.schoolId, '101', 'Tenant is strictly bound to JWT schoolId');
});

test('Intervention Tenant Security: School A user cannot create intervention for School B', () => {
  const req = {
    method: 'POST',
    path: '/api/v1/interventions',
    user: { schoolId: 101, roles: ['teacher'] },
    query: {},
    body: { school_id: '102', title: 'Action Plan' },
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);

  assert.equal(continued, true);
  assert.equal(req.schoolId, '101', 'Interventions strictly use JWT schoolId');
});

test('Anecdote Tenant Security: Unauthenticated request to /api/v1/anecdotes is rejected with 401', () => {
  const req = {
    method: 'GET',
    path: '/api/v1/anecdotes',
    user: null,
    query: { school_id: '101' },
    body: {},
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);

  assert.equal(continued, false, 'Unauthenticated request must be blocked');
  assert.equal(res.statusCode, 401, 'Must return HTTP 401');
});
