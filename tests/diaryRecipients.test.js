import assert from 'node:assert/strict';
import test from 'node:test';

import { parentRecipientUserIds } from '../services/smartDiary/publishService.js';

test('diary recipient lookup includes student logins and linked guardians for active class enrollments', async () => {
  let query;
  let params;
  const db = async (strings, ...values) => {
    query = strings.join('?');
    params = values;
    return [{ id: 'student-login' }, { id: 'guardian-login' }, { id: 'guardian-login' }];
  };

  const recipients = await parentRecipientUserIds(17, ['class-a', 'class-a'], db);

  assert.deepEqual(recipients, ['student-login', 'guardian-login']);
  assert.ok(query.includes('SELECT person_id FROM enrolled_students'));
  assert.ok(query.includes('JOIN student_parents sp'));
  assert.ok(query.includes("se.status = 'active'"));
  assert.ok(query.includes('se.deleted_at IS NULL'));
  assert.ok(query.includes('se.start_date <= CURRENT_DATE'));
  assert.ok(query.includes('sp.valid_to >= CURRENT_DATE'));
  assert.ok(query.includes("u.account_status = 'active'"));
  assert.ok(query.includes('u.deleted_at IS NULL'));
  assert.deepEqual(params.filter(Array.isArray), [['class-a']]);
  assert.equal(params.filter((value) => value === 17).length, 5);
});

test('diary recipient lookup skips the database when no class is supplied', async () => {
  const recipients = await parentRecipientUserIds(17, [], async () => {
    throw new Error('unexpected database query');
  });
  assert.deepEqual(recipients, []);
});
