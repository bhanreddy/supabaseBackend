import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterEnabledNotificationRecipients,
  getSchoolNotificationSettings,
  notificationCategoryForEvent,
} from './schoolNotificationSettingsService.js';
import { NotificationEventConfig } from './notificationEventConfig.js';

test('every notification event family maps to the expected school control', () => {
  for (const eventType of Object.keys(NotificationEventConfig)) {
    assert.ok(notificationCategoryForEvent(eventType), `${eventType} is missing a school notification category`);
  }
  assert.equal(notificationCategoryForEvent('ATTENDANCE_ABSENT'), 'attendance');
  assert.equal(notificationCategoryForEvent('ATTENDANCE_PRESENT'), 'attendance');
  assert.equal(notificationCategoryForEvent('FEE_REMINDER'), 'fees');
  assert.equal(notificationCategoryForEvent('ARREARS_REMINDER'), 'fees');
  assert.equal(notificationCategoryForEvent('TRANSPORT_BUS_RUNNING_LATE'), 'transport');
  assert.equal(notificationCategoryForEvent('STUDENT_BUS_ABSENT'), 'transport');
  assert.equal(notificationCategoryForEvent('MESSAGE_RECEIVED'), 'messages');
});

test('school notification controls default to enabled', async () => {
  const settings = await getSchoolNotificationSettings(17, async () => []);
  assert.ok(settings.length > 0);
  assert.ok(settings.every((setting) => setting.enabled));
});

test('disabled school category recipients are filtered before delivery', async () => {
  const fakeDb = async () => [
    { id: 'enabled-user', value: 'true' },
    { id: 'disabled-user', value: 'false' },
  ];
  const result = await filterEnabledNotificationRecipients(
    ['enabled-user', 'disabled-user'],
    'ATTENDANCE_ABSENT',
    fakeDb
  );
  assert.deepEqual(result.enabledUserIds, ['enabled-user']);
  assert.deepEqual(result.disabledUserIds, ['disabled-user']);
  assert.equal(result.categoryId, 'attendance');
});
