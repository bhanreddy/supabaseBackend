import assert from 'node:assert/strict';
import test from 'node:test';
import { isAfterDiaryNotificationCutoff } from './diaryNotificationPolicy.js';

test('late diary cutoff follows IST across the 4:30 PM boundary and midnight', () => {
  for (const [timestamp, expected] of [
    ['2026-09-28T10:59:59.999Z', false], // 4:29:59 PM IST
    ['2026-09-28T11:00:00.000Z', true],  // 4:30 PM IST
    ['2026-09-28T11:00:00.001Z', true],
    ['2026-09-28T18:29:59.999Z', true],  // 11:59:59 PM IST
    ['2026-09-28T18:30:00.000Z', false], // Next day, midnight IST
    ['2026-09-29T10:59:59.999Z', false],
  ]) {
    assert.equal(isAfterDiaryNotificationCutoff(new Date(timestamp)), expected, timestamp);
  }
});
