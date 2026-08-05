import assert from 'node:assert/strict';
import test from 'node:test';
import { requireSchoolId } from '../middleware/schoolId.js';
import { normalizeGalleryText } from '../routes/websiteGalleryRoutes.js';

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

test('public gallery reads use the explicitly configured website school', () => {
  const result = invoke('/api/v1/public/website-gallery', {
    query: { school_id: '17' },
  });
  assert.equal(result.continued, true);
  assert.equal(result.req.schoolId, '17');
});

test('admin gallery endpoints ignore client tenant input and use JWT school', () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    const result = invoke('/api/v1/admin/website-gallery/item-1', {
      method,
      user: { schoolId: 17 },
      query: { school_id: '999' },
      body: { school_id: '999' },
    });
    assert.equal(result.continued, true);
    assert.equal(result.req.schoolId, '17');
  }
});

test('admin gallery endpoints reject missing authenticated school context', () => {
  const result = invoke('/api/v1/admin/website-gallery', {
    query: { school_id: '17' },
  });
  assert.equal(result.continued, false);
  assert.equal(result.statusCode, 401);
});

test('gallery metadata is trimmed, compacted, bounded, and defaulted', () => {
  assert.equal(normalizeGalleryText('  Annual   Day  ', 20), 'Annual Day');
  assert.equal(normalizeGalleryText('', 20, 'School Life'), 'School Life');
  assert.equal(normalizeGalleryText('123456', 4), '1234');
});
