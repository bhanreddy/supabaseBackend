import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchFeeReminder, normalizeFeePaidRange } from './broadcastDispatchService.js';

test('fee paid range defaults to all unpaid students and validates custom percentages', () => {
  assert.deepEqual(normalizeFeePaidRange(), { min: 0, max: 100 });
  assert.deepEqual(normalizeFeePaidRange({ min: '25', max: '75.5' }), { min: 25, max: 75.5 });
  assert.throws(() => normalizeFeePaidRange({ min: 80, max: 20 }), /minimum not greater/);
  assert.throws(() => normalizeFeePaidRange({ min: -1, max: 50 }), /between 0 and 100/);
  assert.throws(() => normalizeFeePaidRange({ min: 0, max: 101 }), /between 0 and 100/);
});

test('fee reminders bound recipient concurrency and persist incremental progress', async () => {
  const recipients = Array.from({ length: 12 }, (_, index) => ({
    id: `user-${index + 1}`,
    balance: 1000 + index,
  }));
  let active = 0;
  let maxActive = 0;
  const persistedSizes = [];
  const progress = [];

  const result = await dispatchFeeReminder(
    12,
    recipients,
    'FEE_REMINDER',
    'admin-1',
    'batch-1',
    {
      chunkSize: 5,
      sendNotification: async ([userId]) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return {
          successCount: 1,
          failureCount: 0,
          noTokenCount: 0,
          recipientRows: [{
            user_id: userId,
            fcm_token: `token-${userId}`,
            status: 'sent',
            error_code: null,
          }],
        };
      },
      persistRows: async (_schoolId, _batchId, rows) => {
        persistedSizes.push(rows.length);
      },
      writeProgress: async (_batchId, _schoolId, summary) => {
        progress.push({ ...summary });
      },
    }
  );

  assert.equal(maxActive, 5);
  assert.deepEqual(persistedSizes, [5, 5, 2]);
  assert.deepEqual(progress.map((item) => item.sentCount), [5, 10, 12]);
  assert.deepEqual(result.summary, {
    sentCount: 12,
    failureCount: 0,
    noTokenCount: 0,
    tokensTargeted: 12,
  });
});

test('fee reminder progress accounts for a rejected recipient send', async () => {
  const result = await dispatchFeeReminder(
    12,
    [{ id: 'ok', balance: 100 }, { id: 'broken', balance: 200 }],
    'FEE_REMINDER',
    'admin-1',
    'batch-2',
    {
      chunkSize: 2,
      sendNotification: async ([userId]) => {
        if (userId === 'broken') throw new Error('provider unavailable');
        return {
          successCount: 0,
          failureCount: 0,
          noTokenCount: 1,
          recipientRows: [{
            user_id: userId,
            fcm_token: null,
            status: 'no_token',
            error_code: null,
          }],
        };
      },
      persistRows: async () => {},
      writeProgress: async () => {},
    }
  );

  assert.deepEqual(result.summary, {
    sentCount: 0,
    failureCount: 1,
    noTokenCount: 1,
    tokensTargeted: 0,
  });
});
