import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateProjectedDelayMinutes,
  isRunningLate,
  projectDelayAtStop,
} from './transportProactiveNotificationService.js';

test('calculateProjectedDelayMinutes returns positive and negative schedule variance', () => {
  assert.equal(calculateProjectedDelayMinutes({
    startedAt: '2026-07-15T02:30:00.000Z',
    now: '2026-07-15T02:45:00.000Z',
    expectedArrivalOffsetSeconds: 10 * 60,
    remainingTravelSeconds: 5 * 60,
  }), 10);

  assert.equal(calculateProjectedDelayMinutes({
    startedAt: '2026-07-15T02:30:00.000Z',
    now: '2026-07-15T02:34:00.000Z',
    expectedArrivalOffsetSeconds: 10 * 60,
    remainingTravelSeconds: 5 * 60,
  }), -1);
});

test('running-late threshold is strictly greater than eight minutes', () => {
  assert.equal(isRunningLate(8), false);
  assert.equal(isRunningLate(8.01), true);
});

test('calculateProjectedDelayMinutes rejects missing or invalid timestamps', () => {
  assert.equal(calculateProjectedDelayMinutes({
    startedAt: null,
    now: '2026-07-15T02:45:00.000Z',
    expectedArrivalOffsetSeconds: 600,
    remainingTravelSeconds: 0,
  }), null);
  assert.equal(calculateProjectedDelayMinutes({
    startedAt: '2026-07-15T02:30:00.000Z',
    now: 'not-a-date',
    expectedArrivalOffsetSeconds: 600,
    remainingTravelSeconds: 0,
  }), null);
});

test('projectDelayAtStop combines cumulative learned schedule with live GPS progress', () => {
  const stops = [
    { stop_id: 'stop-a', latitude: 17, longitude: 78, status: 'completed' },
    { stop_id: 'stop-b', latitude: 17, longitude: 78.01, status: 'pending' },
  ];
  const segments = {
    'stop-a->stop-b': { ewma_seconds: 600 },
  };

  const halfway = projectDelayAtStop({
    startedAt: '2026-07-15T02:30:00.000Z',
    now: '2026-07-15T02:44:00.000Z',
    fix: { latitude: 17, longitude: 78.005 },
    stops,
    segments,
    targetStopId: 'stop-b',
  });
  assert.ok(Math.abs(halfway.remainingTravelSeconds - 300) < 1);
  assert.ok(Math.abs(halfway.delayMinutes - 9) < 0.02);

  const atTarget = projectDelayAtStop({
    startedAt: '2026-07-15T02:30:00.000Z',
    now: '2026-07-15T02:44:00.000Z',
    fix: { latitude: 17, longitude: 78.01 },
    stops,
    segments,
    targetStopId: 'stop-b',
  });
  assert.ok(atTarget.remainingTravelSeconds < 1);
  assert.ok(Math.abs(atTarget.delayMinutes - 4) < 0.02);
});

test('projectDelayAtStop refuses an incomplete learned schedule', () => {
  const stops = [
    { stop_id: 'stop-a', latitude: 17, longitude: 78 },
    { stop_id: 'stop-b', latitude: 17, longitude: 78.01 },
  ];

  assert.equal(projectDelayAtStop({
    startedAt: '2026-07-15T02:30:00.000Z',
    now: '2026-07-15T02:45:00.000Z',
    fix: { latitude: 17, longitude: 78.005 },
    stops,
    segments: {},
    targetStopId: 'stop-b',
  }), null);

  assert.equal(projectDelayAtStop({
    startedAt: '2026-07-15T02:30:00.000Z',
    now: '2026-07-15T02:45:00.000Z',
    fix: { latitude: 17, longitude: 78.005 },
    stops,
    segments: { 'stop-a->stop-b': { ewma_seconds: 600 } },
    targetStopId: 'not-on-trip',
  }), null);
});
