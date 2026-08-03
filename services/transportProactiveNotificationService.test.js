import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateProjectedDelayMinutes,
  isRunningLate,
  notifyParentsAtNextStop,
  projectDelayAtStop,
} from './transportProactiveNotificationService.js';
import { NotificationEventConfig } from './notificationEventConfig.js';

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

test('notifyParentsAtNextStop claims and alerts parents assigned to the following stop', async () => {
  const queries = [];
  const db = async (strings, ...values) => {
    const query = strings.join('?');
    queries.push({ query, values });
    if (query.includes('SELECT t.route_id')) {
      return [{
        route_id: 'route-1',
        trip_stop_status_id: 'trip-stop-2',
        stop_id: 'stop-2',
        stop_name: 'Market Road',
      }];
    }
    if (query.includes('UPDATE trip_stop_status')) return [{ id: 'trip-stop-2' }];
    throw new Error(`Unexpected query: ${query}`);
  };

  const pushes = [];
  const result = await notifyParentsAtNextStop(
    'school-1',
    'trip-1',
    'stop-1',
    db,
    {
      getStudentIdsAtStop: async (schoolId, routeId, stopId, receivedDb) => {
        assert.equal(schoolId, 'school-1');
        assert.equal(routeId, 'route-1');
        assert.equal(stopId, 'stop-2');
        assert.equal(receivedDb, db);
        return ['student-1'];
      },
      sendTransportNotification: async (...args) => pushes.push(args),
    },
  );

  assert.deepEqual(result, { notified: true, students: 1, stopId: 'stop-2' });
  assert.equal(queries.length, 2);
  assert.ok(queries[0].query.includes("preceding_tss.status IN ('arrived', 'completed')"));
  assert.ok(queries[0].query.includes('next_tss.stop_order = preceding_tss.stop_order + 1'));
  assert.ok(queries[1].query.includes('approach_notified_at IS NULL'));
  assert.deepEqual(pushes, [[
    ['student-1'],
    'TRANSPORT_BUS_APPROACHING',
    { stopName: 'Market Road' },
    'school-1',
    db,
  ]]);
});

test('bus approaching uses the dedicated confirmation sound and channel', () => {
  assert.equal(NotificationEventConfig.TRANSPORT_BUS_APPROACHING.sound, 'busconfirmation.wav');
  assert.equal(NotificationEventConfig.TRANSPORT_BUS_APPROACHING.channelId, 'bus_confirmation');
});

test('driver present attendance uses the dedicated bus-present sound and channel', () => {
  assert.equal(NotificationEventConfig.STUDENT_BUS_PRESENT.sound, 'bus_present.wav');
  assert.equal(NotificationEventConfig.STUDENT_BUS_PRESENT.channelId, 'bus_present');
});
