import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DIARY_DIGEST_MESSAGE,
  getDailyDiaryDigestRecipients,
  sendDailyDiaryDigests,
} from './diaryDigestService.js';

test('daily diary digest deduplicates subjects and siblings into one parent notification', async () => {
  const db = async () => [
    { school_id: 17, user_id: 'parent-a' },
    { school_id: 17, user_id: 'parent-a' },
    { school_id: 17, user_id: 'parent-b' },
  ];
  const notifications = [];

  const summary = await sendDailyDiaryDigests({
    db,
    notify: async (...args) => {
      notifications.push(args);
      return { successCount: 2, failureCount: 0 };
    },
  });

  assert.deepEqual(notifications, [[
    ['parent-a', 'parent-b'],
    'DIARY_UPDATED',
    DIARY_DIGEST_MESSAGE,
    { role: 'parent' },
  ]]);
  assert.deepEqual(summary, {
    schoolsProcessed: 1,
    schoolsFailed: 0,
    parentsTargeted: 2,
    tokensSent: 2,
    tokensFailed: 0,
  });
});

test('daily diary recipient query targets active parents in the prior cutoff window', async () => {
  let captured;
  const db = async (strings, ...values) => {
    captured = { query: strings.join('?'), values };
    return [];
  };

  const rows = await getDailyDiaryDigestRecipients('Asia/Kolkata', 17, db);

  assert.deepEqual(rows, []);
  assert.ok(captured.query.includes('JOIN student_parents sp'));
  assert.ok(captured.query.includes('JOIN parents parent'));
  assert.ok(captured.query.includes("u.account_status = 'active'"));
  assert.ok(captured.query.includes("dw.window_end - INTERVAL '1 day'"));
  assert.ok(captured.query.includes('<= dw.window_end'));
  assert.equal(captured.query.includes('JOIN users u\n      ON u.person_id = student.person_id'), false);
  assert.deepEqual(captured.values, [
    'Asia/Kolkata',
    17,
    'Asia/Kolkata',
    'Asia/Kolkata',
    'Asia/Kolkata',
    'Asia/Kolkata',
    'Asia/Kolkata',
  ]);
});

test('daily diary digest sends nothing when no diary was posted', async () => {
  let notifyCalls = 0;
  const summary = await sendDailyDiaryDigests({
    db: async () => [],
    notify: async () => {
      notifyCalls += 1;
    },
  });

  assert.equal(notifyCalls, 0);
  assert.equal(summary.parentsTargeted, 0);
  assert.equal(summary.schoolsProcessed, 0);
});
