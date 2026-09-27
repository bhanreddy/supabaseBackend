import assert from 'node:assert/strict';
import test from 'node:test';
import { canReadDiaryClass } from '../services/smartDiary/readerAccess.js';

const classSectionId = '11111111-1111-4111-8111-111111111111';

test('family diary reads require an authorized active enrollment', async () => {
  let query;
  const db = (strings, ...values) => {
    query = { text: strings.join('?'), values };
    return [{ allowed: false }];
  };
  const args = { schoolId: 17, personId: '22222222-2222-4222-8222-222222222222', classSectionId, roles: ['parent'], db };
  assert.equal(await canReadDiaryClass(args), false);
  assert.match(query.text, /student_enrollments/);
  assert.match(query.text, /student_parents/);
  assert.match(query.text, /sp\.valid_to/);
  assert.ok(query.values.includes(17));
  assert.ok(query.values.includes(classSectionId));
  assert.equal(await canReadDiaryClass({ ...args, db: () => [{ allowed: true }] }), true);
  assert.equal(await canReadDiaryClass({ ...args, classSectionId: null }), false);
  assert.equal(await canReadDiaryClass({ ...args, personId: null }), false);
});

test('staff keeps existing diary permission behavior', async () => {
  const db = () => { throw new Error('staff should not query family enrollment'); };
  assert.equal(await canReadDiaryClass({ schoolId: 17, roles: ['teacher'], db }), true);
});
