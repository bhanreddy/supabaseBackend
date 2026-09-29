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
    { role: 'parent', schoolId: 17, deepLink: '/Screen/diary' },
  ]]);
  assert.deepEqual(summary, {
    schoolsProcessed: 1,
    schoolsFailed: 0,
    parentsTargeted: 2,
    tokensSent: 2,
    tokensFailed: 0,
  });
});

test('daily diary recipient query includes family logins in the prior 5:30 PM IST cutoff window', async () => {
  let captured;
  const db = async (strings, ...values) => {
    captured = { query: strings.join('?'), values };
    return [];
  };

  const rows = await getDailyDiaryDigestRecipients('Asia/Kolkata', 17, 30, db);

  assert.deepEqual(rows, []);
  assert.ok(captured.query.includes('JOIN student_parents sp'));
  assert.ok(captured.query.includes('JOIN parents parent'));
  assert.ok(captured.query.includes("u.account_status = 'active'"));
  assert.ok(captured.query.includes("dw.window_end - INTERVAL '1 day'"));
  assert.ok(captured.query.includes('<= dw.window_end'));
  assert.ok(captured.query.includes('d.notification_sent_at IS NULL'));
  assert.ok(captured.query.includes("INTERVAL '1 minute'"));
  assert.ok(captured.query.includes('SELECT school_id, person_id FROM updated_students'));
  assert.ok(captured.query.includes('u.school_id = recipient.school_id'));
  assert.deepEqual(captured.values, [
    'Asia/Kolkata',
    17,
    30,
    'Asia/Kolkata',
    'Asia/Kolkata',
    'Asia/Kolkata',
    'Asia/Kolkata',
  ]);
});

test('daily diary digest uses the same 5:30 PM cutoff as the scheduler by default', async () => {
  let values;
  await sendDailyDiaryDigests({
    db: async (_strings, ...params) => { values = params; return []; },
    notify: async () => { throw new Error('No diary should be dispatched'); },
  });
  assert.deepEqual(values.slice(0, 4), ['Asia/Kolkata', 17, 30, 'Asia/Kolkata']);
});

test('daily diary digest keeps recipients from different schools in separate sends', async () => {
  const notifications = [];
  const summary = await sendDailyDiaryDigests({
    db: async () => [
      { school_id: 17, user_id: 'parent-a' },
      { school_id: 18, user_id: 'family-login-b' },
    ],
    notify: async (...args) => {
      notifications.push(args);
      return { successCount: 1, failureCount: 0 };
    },
  });
  assert.equal(summary.schoolsProcessed, 2);
  assert.deepEqual(notifications.map(([ids, , , context]) => [ids, context.schoolId]), [
    [['parent-a'], 17],
    [['family-login-b'], 18],
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
