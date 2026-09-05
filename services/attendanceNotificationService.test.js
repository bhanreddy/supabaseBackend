import test from 'node:test';
import assert from 'node:assert/strict';

import { isAttendanceDateToday } from './attendanceNotificationService.js';

test('attendance notifications are allowed only for the school-local current date', () => {
  const now = new Date('2026-09-04T19:15:00.000Z');

  assert.equal(isAttendanceDateToday('2026-09-05', 'Asia/Kolkata', now), true);
  assert.equal(isAttendanceDateToday('2026-09-04', 'Asia/Kolkata', now), false);
  assert.equal(isAttendanceDateToday('2026-09-04', 'America/New_York', now), true);
});

test('invalid attendance dates never trigger a notification', () => {
  assert.equal(isAttendanceDateToday('', 'Asia/Kolkata'), false);
  assert.equal(isAttendanceDateToday('not-a-date', 'Asia/Kolkata'), false);
});
