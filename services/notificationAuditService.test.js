import assert from 'node:assert/strict';
import test from 'node:test';
import {
  logNotificationSummary,
  resolveNotificationSchoolId,
} from './notificationAuditService.js';

function createDb(schoolRows = [{ school_id: 17 }]) {
  const calls = [];
  const db = async (strings, ...values) => {
    const query = strings.join('?');
    calls.push({ query, values });
    if (query.includes('SELECT DISTINCT school_id')) return schoolRows;
    if (query.includes('INSERT INTO notification_logs')) return [];
    throw new Error(`Unexpected query: ${query}`);
  };
  return { db, calls };
}

test('resolves one school from server-owned recipient records', async () => {
  const { db } = createDb();
  const schoolId = await resolveNotificationSchoolId(['user-1', 'user-1'], null, db);
  assert.equal(schoolId, 17);
});

test('rejects recipients from multiple schools', async () => {
  const { db } = createDb([{ school_id: 17 }, { school_id: 18 }]);
  await assert.rejects(
    resolveNotificationSchoolId(['user-1', 'user-2'], null, db),
    /multiple schools/,
  );
});

test('rejects a caller school that does not match the recipients', async () => {
  const { db } = createDb();
  await assert.rejects(
    resolveNotificationSchoolId(['user-1'], 18, db),
    /does not match/,
  );
});

test('notification log insert includes the resolved school_id', async () => {
  const { db, calls } = createDb();
  const written = await logNotificationSummary({
    recipientUserIds: ['user-1'],
    schoolId: 17,
    type: 'FEE_REMINDER',
    tokensTargeted: 2,
    tokensSent: 1,
    tokensFailed: 1,
    senderId: 'admin-1',
  }, db);

  assert.equal(written, true);
  const insert = calls.find((call) => call.query.includes('INSERT INTO notification_logs'));
  assert.ok(insert);
  assert.match(insert.query, /school_id, user_id/);
  assert.equal(insert.values[0], 17);
  assert.equal(insert.values.at(-1), 'partial');
});
