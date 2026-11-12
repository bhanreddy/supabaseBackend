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
  for (const remainingSeconds of [null, 45]) {
    test(`${send.name}: approaching alert has the bus sound and a bounded provider lifetime (${remainingSeconds})`, async () => {
      const expiresAt = remainingSeconds == null ? undefined : new Date(Date.now() + remainingSeconds * 1000);
      const before = Date.now();
      const result = await send(recipients.map(r => r.user_id), 'TRANSPORT_BUS_APPROACHING', { stopName: 'Stop 3' }, { schoolId: 12, expiresAt });
      assert.equal(result.successCount, 2);
      assert.equal(state.messages.length, 2);
      for (const message of state.messages) {
        assert.match(message.notification.body, /Stop 3/);
        assert.equal(message.android.notification.channelId, 'bus_confirmation_custom');
        assert.equal(message.android.notification.sound, 'busconfirmation');
        assert.equal(message.android.priority, 'high');
        assert.equal(message.apns.payload.aps.sound, 'busconfirmation.wav');
        assert.equal(message.data.channelId, 'bus_confirmation_custom');
        assert.equal(message.data.sound, 'busconfirmation');
        assert.equal(message.data.deepLink, '/Screen/busTracker');
        assert.ok(message.android.ttl > 0 && message.android.ttl <= (remainingSeconds ?? 600) * 1000);
        const expiry = Number(message.apns.headers['apns-expiration']);
        assert.ok(expiry > Math.floor(before / 1000));
        if (expiresAt) assert.equal(expiry, Math.floor(+expiresAt / 1000));
        else assert.ok(expiry <= Math.floor(Date.now() / 1000) + 600);
      }
    });
  }
}

for (const send of [sendNotificationToUsers, sendNotificationToUsersWithReport]) {
  test(`${send.name}: the previous parent app resolves the bus channel and sound without an update`, async () => {
    const context = { schoolId: 12, idempotencyKey: 'transport:one-stop-away' };
    await send(recipients.map(r => r.user_id), 'TRANSPORT_BUS_APPROACHING', { stopName: 'Stop 3' }, context);
    const first = [...state.messages];
    await send(recipients.map(r => r.user_id), 'TRANSPORT_BUS_APPROACHING', { stopName: 'Stop 3' }, context);
    const second = state.messages.slice(first.length);
    first.forEach((message, index) => {
      // Contract from the released 5795b97 receiver: it appends .wav itself
      // and recognizes the existing bus_confirmation_custom channel.
      assert.equal(`${message.data.sound}.wav`, 'busconfirmation.wav');
      assert.equal(message.data.channelId.replace('_custom', '').replace('_default', ''), 'bus_confirmation');
      assert.ok(message.notification, 'the OS can render the alert with JS stopped');
      assert.equal(message.data.messageId, second[index].data.messageId, 'old message-ID dedupe survives an outbox retry');
      assert.notEqual(message.data.messageId, first[1 - index].data.messageId, 'recipient scopes are independent');
    });
  });
}
