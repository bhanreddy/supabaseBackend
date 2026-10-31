import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';

const recipients = [
  { user_id: 'student-en', school_id: 12, language_code: 'en' },
  { user_id: 'parent-te', school_id: 12, language_code: 'te' },
];
const state = { messages: [], settingKeys: [] };

async function db(strings, ...values) {
  const query = strings.join('?');
  if (query.includes('LEFT JOIN school_settings')) {
    state.settingKeys.push(values[0]);
    return recipients.map(({ user_id }) => ({ id: user_id, value: 'true' }));
  }
  if (query.includes('FROM notification_config')) return [];
  if (query.includes('u.id AS user_id')) return recipients;
  if (query.includes('INSERT INTO notification_events')) {
    return [{ id: `inbox-${values[4]}`, user_id: values[4] }];
  }
  if (query.includes('FROM user_devices ud')) {
    return recipients.map((recipient) => ({ ...recipient, fcm_token: `token-${recipient.user_id}` }));
  }
  throw new Error(`Unexpected query: ${query}`);
}

mock.module('../db.js', { defaultExport: db });
mock.module('../config/firebase.js', {
  defaultExport: {
    messaging: () => ({
      sendEachForMulticast: async (message) => {
        state.messages.push(message);
        return {
          successCount: message.tokens.length,
          failureCount: 0,
          responses: message.tokens.map(() => ({ success: true })),
        };
      },
    }),
  },
});
mock.module('./notificationAuditService.js', {
  namedExports: { logNotificationSummary: async () => {} },
});
mock.module('../utils/logger.js', {
  defaultExport: {
    error: (error) => assert.fail(JSON.stringify(error)),
    warn: (error) => assert.fail(JSON.stringify(error)),
  },
});

const { sendNotificationToUsers, sendNotificationToUsersWithReport } = await import('./notificationService.js');

beforeEach(() => {
  state.messages = [];
  state.settingKeys = [];
});

for (const send of [sendNotificationToUsers, sendNotificationToUsersWithReport]) {
  for (const [type, sound, params] of [
    ['ATTENDANCE_PRESENT', 'notification_default', { message: 'Attendance marked for 2026-10-23.' }],
    ['ATTENDANCE_ABSENT', 'attendance_absent_alert', { date: '2026-10-23' }],
  ]) {
    test(`${send.name}: ${type} uses its sound for Android, iOS, and foreground payloads`, async () => {
      const result = await send(recipients.map(({ user_id }) => user_id), type, params, { schoolId: 12 });

      assert.equal(result.successCount, 2);
      assert.equal(result.failureCount, 0);
      assert.deepEqual(state.settingKeys, ['notification_enabled_attendance']);
      assert.equal(state.messages.length, 2);
      for (const [index, message] of state.messages.entries()) {
        assert.ok(message.notification.title);
        assert.ok(message.notification.body);
        assert.equal(message.android.notification.channelId, `${sound}_custom`);
        assert.equal(message.android.notification.sound, sound);
        assert.equal(message.android.notification.defaultSound, false);
        assert.equal(message.android.priority, 'high');
        assert.equal(message.android.notification.priority, 'max');
        assert.equal(Object.hasOwn(message.android.notification, 'notificationPriority'), false);
        assert.equal(message.apns.payload.aps.sound, `${sound}.wav`);
        assert.equal(message.data.channelId, `${sound}_custom`);
        assert.equal(message.data.sound, sound);
        assert.equal(message.data.type, type);
        assert.equal(message.data.deepLink, '/Screen/attendance');
        assert.equal(message.data.recipientUserId, recipients[index].user_id);
        assert.equal(message.data.notificationId, `inbox-${recipients[index].user_id}`);
      }
    });
  }
}
