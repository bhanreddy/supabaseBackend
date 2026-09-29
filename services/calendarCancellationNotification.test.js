import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';
import { NotificationTemplateService } from './notificationTemplateService.js';

const schoolId = 12;
const recipients = [
  { user_id: 'parent-en', school_id: schoolId, language_code: 'en' },
  { user_id: 'parent-te', school_id: schoolId, language_code: 'te' },
];
const state = { messages: [], summaries: [], errors: [], settingKeys: [], hasAudience: true };

async function db(strings, ...values) {
  const query = strings.join('?');
  if (query.includes('FROM calendar_event_targets')) {
    assert.equal(values[0], schoolId);
    return [{ target_type: 'ENTIRE_SCHOOL' }];
  }
  if (query.includes('SELECT id FROM users')) {
    return state.hasAudience ? recipients.map(({ user_id }) => ({ id: user_id })) : [];
  }
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
  namedExports: { logNotificationSummary: async (summary) => state.summaries.push(summary) },
});
mock.module('../utils/logger.js', {
  defaultExport: {
    error: (...args) => state.errors.push(args),
    warn: (...args) => state.errors.push(args),
  },
});

const { notifyEventCancelled } = await import('./calendarNotificationService.js');
const { sendNotificationToUsers } = await import('./notificationService.js');

beforeEach(() => {
  state.messages = [];
  state.summaries = [];
  state.errors = [];
  state.settingKeys = [];
  state.hasAudience = true;
});

for (const eventType of ['SCHOOL_EVENT', 'EXAM', 'TEST']) {
  test(`${eventType} cancellation uses general alerts in Android, iOS, and foreground data`, async () => {
    const event = {
      id: `calendar-${eventType}`,
      event_type: eventType,
      title: eventType === 'SCHOOL_EVENT' ? 'Annual day' : 'Mathematics exam',
      start_date: '2026-10-01',
    };
    const reason = eventType === 'EXAM' ? 'School closed' : undefined;
    await notifyEventCancelled(schoolId, event, reason);

    assert.deepEqual(state.errors, []);
    assert.deepEqual(state.settingKeys, ['notification_enabled_calendar']);
    assert.equal(state.messages.length, 2);
    for (const [index, message] of state.messages.entries()) {
      const rendered = NotificationTemplateService.render('CALENDAR_EVENT_CANCELLED', {
        title: event.title,
        message: `The event scheduled for ${event.start_date} has been cancelled.${reason ? ` Reason: ${reason}` : ''}`,
      }, recipients[index].language_code);
      assert.deepEqual(message.notification, { title: rendered.title, body: rendered.body });
      assert.match(message.notification.body, /cancelled/);
      assert.equal(message.android.notification.channelId, 'voice_alert_custom');
      assert.equal(message.android.notification.sound, 'voice_alert');
      assert.equal(message.apns.payload.aps.sound, 'voice_alert.wav');
      assert.equal(message.data.channelId, 'voice_alert_custom');
      assert.equal(message.data.sound, 'voice_alert');
      assert.equal(message.data.type, 'CALENDAR_EVENT_CANCELLED');
      assert.equal(message.data.deepLink, `/Screen/calendar?eventId=${event.id}`);
      assert.equal(message.data.recipientUserId, recipients[index].user_id);
    }
    assert.equal(state.summaries[0].type, 'CALENDAR_EVENT_CANCELLED');
    assert.equal(state.summaries[0].channelId, 'voice_alert');
    assert.equal(state.summaries[0].tokensSent, 2);
  });
}

for (const type of ['COMPLAINT_CREATED', 'COMPLAINT_RESPONSE']) {
  test(`${type} retains its complaint alert sound and school control`, async () => {
    await sendNotificationToUsers(recipients.map(({ user_id }) => user_id), type, {
      message: 'Complaint details',
    }, { schoolId });

    assert.deepEqual(state.errors, []);
    assert.deepEqual(state.settingKeys, ['notification_enabled_complaints']);
    assert.equal(state.messages.length, 2);
    for (const message of state.messages) {
      assert.equal(message.android.notification.channelId, 'emergency_custom');
      assert.equal(message.android.notification.sound, 'emergency');
      assert.equal(message.apns.payload.aps.sound, 'emergency.wav');
      assert.equal(message.data.type, type);
      assert.equal(message.data.deepLink, '/Screen/complaints');
    }
  });
}

test('cancellation without recipients does not dispatch a notification', async () => {
  state.hasAudience = false;
  await notifyEventCancelled(schoolId, { id: 'empty-event', title: 'Annual day', start_date: '2026-10-01' });
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.errors, []);
});

test('diary notifications use only the dedicated sound in every delivery payload', async () => {
  await sendNotificationToUsers(recipients.map(({ user_id }) => user_id), 'DIARY_UPDATED', {
    message: 'The latest diary is ready.',
    message_te: 'తాజా డైరీ సిద్ధంగా ఉంది.',
  }, { schoolId });

  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.settingKeys, ['notification_enabled_diary']);
  assert.equal(state.messages.length, 2);
  for (const message of state.messages) {
    assert.equal(message.android.notification.channelId, 'diary_alert_custom');
    assert.equal(message.android.notification.sound, 'diary_alert');
    assert.equal(message.apns.payload.aps.sound, 'diary_alert.wav');
    assert.equal(message.data.channelId, 'diary_alert_custom');
    assert.equal(message.data.sound, 'diary_alert');
    assert.equal(message.data.type, 'DIARY_UPDATED');
    assert.equal(message.data.deepLink, '/Screen/diary');
  }
});
