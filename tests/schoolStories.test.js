import assert from 'node:assert/strict';
import test from 'node:test';
import { requireSchoolId } from '../middleware/schoolId.js';
import {
  groupStoriesByAuthor,
  isUuid,
  normalizePortalText,
  resolveStoryAuthorRole,
  schoolHeroSlideObjectPath,
  schoolStoryObjectPath,
} from '../utils/schoolPortalMedia.js';

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

test('school stories and hero slides ignore client tenant input and use JWT school', () => {
  for (const path of [
    '/api/v1/school-stories',
    '/api/v1/school-stories/manage',
    '/api/v1/school-hero-slides',
    '/api/v1/admin/school-hero-slides',
  ]) {
    const result = invoke(path, {
      method: 'POST',
      user: { schoolId: 17 },
      query: { school_id: '999' },
      body: { school_id: '999' },
    });
    assert.equal(result.continued, true, path);
    assert.equal(result.req.schoolId, '17', path);
  }
});

test('school stories reject missing authenticated school context', () => {
  const result = invoke('/api/v1/school-stories', {
    query: { school_id: '17' },
  });
  assert.equal(result.continued, false);
  assert.equal(result.statusCode, 401);
});

test('portal metadata is trimmed, compacted, bounded, and defaulted', () => {
  assert.equal(normalizePortalText('  Annual   Day  ', 20), 'Annual Day');
  assert.equal(normalizePortalText('', 20, 'School Life'), 'School Life');
  assert.equal(normalizePortalText('123456', 4), '1234');
});

test('story author role maps admin and principal to admin, everyone else to staff', () => {
  assert.equal(resolveStoryAuthorRole(['admin', 'staff']), 'admin');
  assert.equal(resolveStoryAuthorRole(['principal']), 'admin');
  assert.equal(resolveStoryAuthorRole(['staff', 'teacher']), 'staff');
  assert.equal(resolveStoryAuthorRole([]), 'staff');
});

test('uuid helper and storage paths stay school-scoped', () => {
  assert.equal(isUuid('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(schoolStoryObjectPath(17, 'abc'), '17/stories/abc.jpg');
  assert.equal(schoolHeroSlideObjectPath(17, 'abc'), '17/hero-slides/abc.jpg');
});

test('stories group by author, play oldest-first, and flag unseen rings', () => {
  const authors = groupStoriesByAuthor([
    {
      id: 's2', uploaded_by: 'u1', author_name: 'Asha', author_photo_url: 'a.jpg',
      author_role: 'staff', media_url: '2.jpg', caption: 'two', created_at: '2026-09-10T12:00:00Z',
      expires_at: '2026-09-11T12:00:00Z', seen: true,
    },
    {
      id: 's1', uploaded_by: 'u1', author_name: 'Asha', author_photo_url: 'a.jpg',
      author_role: 'staff', media_url: '1.jpg', caption: 'one', created_at: '2026-09-10T11:00:00Z',
      expires_at: '2026-09-11T11:00:00Z', seen: false,
    },
    {
      id: 's3', uploaded_by: 'u2', author_name: 'Principal', author_photo_url: null,
      author_role: 'admin', media_url: '3.jpg', caption: null, created_at: '2026-09-10T10:00:00Z',
      expires_at: '2026-09-11T10:00:00Z', seen: true,
    },
  ]);

  assert.equal(authors.length, 2);
  assert.equal(authors[0].author_name, 'Asha');
  assert.equal(authors[0].stories.map((s) => s.id).join(','), 's1,s2');
  assert.equal(authors[0].has_unseen, true);
  assert.equal(authors[1].author_role, 'admin');
  assert.equal(authors[1].has_unseen, false);
});
