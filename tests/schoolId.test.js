import assert from 'node:assert/strict';
import test from 'node:test';

import { requireSchoolId } from '../middleware/schoolId.js';

function invoke(path, {
  method = 'PATCH',
  user = { schoolId: 12 },
  query = {},
  body = {},
} = {}) {
  const req = { path, method, user, query, body };
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

test('principal signature upload derives its tenant from the authenticated user', () => {
  const result = invoke('/api/v1/school-settings/principal-signature');

  assert.equal(result.continued, true);
  assert.equal(result.req.schoolId, '12');
  assert.equal(result.payload, undefined);
});

test('school settings subroutes do not accept a client-selected tenant', () => {
  const result = invoke('/api/v1/school-settings/principal-signature', {
    user: { schoolId: 12 },
    query: { school_id: '99' },
    body: { school_id: '99' },
  });

  assert.equal(result.continued, true);
  assert.equal(result.req.schoolId, '12');
});

test('school settings subroutes still require an authenticated school context', () => {
  const result = invoke('/api/v1/school-settings/principal-signature', {
    user: null,
  });

  assert.equal(result.continued, false);
  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.payload, { success: false, error: 'Unauthorized' });
});
