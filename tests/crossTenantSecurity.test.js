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
  const res = {
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
  return res;
}

test('Cross-Tenant Security: School A user cannot read School B students via query param', () => {
  const req = {
    method: 'GET',
    path: '/api/v1/students',
    user: { schoolId: 101, roles: ['teacher'], permissions: ['students.view'] },
    query: { school_id: '102' },
    body: {},
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);

  assert.equal(continued, false, 'Middleware must not allow execution to continue');
  assert.equal(res.statusCode, 403, 'Cross-tenant query must return HTTP 403');
  assert.equal(res.payload?.code, 'CROSS_TENANT_FORBIDDEN');
});

test('Cross-Tenant Security: School A user cannot modify School B records via body param', () => {
  const req = {
    method: 'PUT',
    path: '/api/v1/students/student-999',
    user: { schoolId: 101, roles: ['admin'] },
    query: {},
    body: { school_id: '102', first_name: 'Hacked' },
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);

  assert.equal(continued, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload?.code, 'CROSS_TENANT_FORBIDDEN');
});

test('Cross-Tenant Security: School A user cannot access School B attendance via custom header', () => {
  const req = {
    method: 'GET',
    path: '/api/v1/attendance',
    user: { schoolId: 101, roles: ['teacher'], permissions: ['attendance.view'] },
    query: {},
    body: {},
    headers: { 'x-school-id': '102' },
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);

  assert.equal(continued, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload?.code, 'CROSS_TENANT_FORBIDDEN');
});

test('Cross-Tenant Security: School A user cannot access School B historical data (2022-23)', () => {
  const req = {
    method: 'GET',
    path: '/api/v1/academics/history',
    user: { schoolId: 101, roles: ['accounts'], permissions: ['fees.view'] },
    query: { school_id: '102', academic_year: '2022-23' },
    body: {},
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);

  assert.equal(continued, false);
  assert.equal(res.statusCode, 403);
});

test('Cross-Tenant Security: Legitimate user with matching school_id is allowed', () => {
  const req = {
    method: 'GET',
    path: '/api/v1/students',
    user: { schoolId: 101, roles: ['teacher'], permissions: ['students.view'] },
    query: { school_id: '101' },
    body: {},
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);

  assert.equal(continued, true);
  assert.equal(req.schoolId, '101');
});

test('Cross-Tenant Security: Legitimate user without school_id automatically inherits trusted schoolId', () => {
  const req = {
    method: 'GET',
    path: '/api/v1/students',
    user: { schoolId: 101, roles: ['teacher'], permissions: ['students.view'] },
    query: {},
    body: {},
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);

  assert.equal(continued, true);
  assert.equal(req.schoolId, '101');
});

test('Cross-Tenant Security: Platform Admin can target specific schools for migration/support', () => {
  const req = {
    method: 'POST',
    path: '/api/v1/students/bulk-update',
    user: { schoolId: 1, roles: ['platform_admin'] },
    query: { school_id: '105' },
    body: {},
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);

  assert.equal(continued, true);
  assert.equal(req.schoolId, '105');
});

test('Aadhaar Minimization: Masking logic masks 12-digit numbers as XXXX-XXXX-1234', () => {
  function maskAadhaar(aadhaar, canReveal) {
    if (!aadhaar) return null;
    if (canReveal) return aadhaar;
    const digits = String(aadhaar).replace(/\D/g, '');
    if (digits.length === 12) {
      return `XXXX-XXXX-${digits.slice(-4)}`;
    }
    return aadhaar;
  }

  const rawAadhaar = '987654321012';
  assert.equal(maskAadhaar(rawAadhaar, false), 'XXXX-XXXX-1012', 'Default view must mask Aadhaar');
  assert.equal(maskAadhaar(rawAadhaar, true), '987654321012', 'Privileged view can reveal Aadhaar');
  assert.equal(maskAadhaar(null, false), null);
});

test('RLS Policy Fail-Closed: Missing app.current_school_id evaluates to zero rows / denial', () => {
  // Simulates Postgres current_school_id() function: NULLIF(current_setting('app.current_school_id', true), '')::INTEGER
  function currentSchoolId(setting) {
    if (setting == null || setting === '') return null;
    const parsed = parseInt(setting, 10);
    return isNaN(parsed) ? null : parsed;
  }

  // Pure RLS predicate: school_id = current_school_id() (without any bypass OR IS NULL)
  function rlsPredicate(rowSchoolId, setting) {
    const currentId = currentSchoolId(setting);
    if (currentId === null) return false; // Fail-closed: NULL comparison in SQL evaluates to falsy
    return rowSchoolId === currentId;
  }

  const rows = [
    { id: 1, school_id: 101, student_name: 'Alice (Current)', academic_year: '2025-26' },
    { id: 2, school_id: 101, student_name: 'Bob (Historical Graduated)', academic_year: '2021-22' },
    { id: 3, school_id: 102, student_name: 'Eve (Other School)', academic_year: '2025-26' },
  ];

  // 1. Missing context: app.current_school_id is undefined/empty -> 0 rows returned
  const resultsMissingContext = rows.filter((r) => rlsPredicate(r.school_id, null));
  assert.equal(resultsMissingContext.length, 0, 'Missing tenant context MUST result in zero tenant rows');

  const resultsEmptyContext = rows.filter((r) => rlsPredicate(r.school_id, ''));
  assert.equal(resultsEmptyContext.length, 0, 'Empty tenant context MUST result in zero tenant rows');

  // 2. Authenticated School 101: returns current AND historical records for School 101
  const resultsSchool101 = rows.filter((r) => rlsPredicate(r.school_id, '101'));
  assert.equal(resultsSchool101.length, 2, 'School 101 context must return all School 101 rows');
  assert.equal(resultsSchool101[0].student_name, 'Alice (Current)');
  assert.equal(resultsSchool101[1].student_name, 'Bob (Historical Graduated)');

  // 3. School 102 rows are completely excluded
  assert.equal(resultsSchool101.some((r) => r.school_id === 102), false, 'School 102 rows must never be visible to School 101');
});

test('Cross-Tenant Security: Student login QR routes strictly use JWT schoolId even if query param differs', () => {
  const req = {
    method: 'POST',
    path: '/api/v1/student-login-qr/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/generate',
    user: { schoolId: 101, roles: ['admin'] },
    query: { school_id: '102' },
    body: { school_id: '102' },
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);

  assert.equal(continued, true, 'JWT-bound QR route continues execution');
  assert.equal(req.schoolId, '101', 'QR tenant must come from JWT, never from a School B student id in the URL or body');
});

test('Cross-Tenant Security: Action Center route strictly uses JWT schoolId even if query param differs', () => {
  const req = {
    method: 'GET',
    path: '/api/v1/admin/action-center',
    user: { schoolId: 101, roles: ['admin'] },
    query: { school_id: '102' },
    body: {},
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);

  assert.equal(continued, true, 'JWT-bound route continues execution');
  assert.equal(req.schoolId, '101', 'Tenant schoolId must be strictly derived from verified JWT (101), ignoring query param (102)');
});

test('Cross-Tenant Security: School stories and hero slides strictly use JWT schoolId even if query param differs', () => {
  for (const path of [
    '/api/v1/school-stories',
    '/api/v1/admin/school-hero-slides',
  ]) {
    const req = {
      method: 'POST',
      path,
      user: { schoolId: 101, roles: ['admin'] },
      query: { school_id: '102' },
      body: { school_id: '102' },
      headers: {},
    };
    const res = mockResponse();
    const continued = invokeMiddleware(req, res);

    assert.equal(continued, true, path);
    assert.equal(req.schoolId, '101', path);
  }
});

