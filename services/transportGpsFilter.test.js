import assert from 'node:assert/strict';
import test from 'node:test';
import { filterGpsFix, gpsDistance, GPS_FILTER } from './transportGpsFilter.js';
import { shouldAutoArrive } from './transportGeofenceService.js';
const epoch = Date.parse('2026-11-03T03:00:00Z');
const fix = (seconds = 0, patch = {}) => ({ latitude: 17, longitude: 78, accuracy: 5, speed: 0, heading: null, recorded_at: new Date(epoch + seconds * 1000).toISOString(), ...patch });
const start = () => filterGpsFix(null, fix()).state;
test('poor/unknown accuracy, malformed and mocked observations cannot replace a good fix', () => {
  for (const patch of [{ accuracy: 300 }, { accuracy: null }, { accuracy: -1 }, { accuracy: NaN }, { is_mocked: true }, { is_suspicious: true }, { latitude: Infinity }, { longitude: 181 }]) {
    const result = filterGpsFix(start(), fix(2, patch));
    assert.equal(result.accepted, false);
    assert.equal(result.state.anchor.recorded_at, fix().recorded_at);
  }
});
test('a single believable-accuracy GPS teleport is suppressed, then the real trajectory recovers', () => {
  const first = start();
  const spike = filterGpsFix(first, fix(2, { longitude: 78.02, speed: 20 }));
  assert.equal(spike.reason, 'implausible_jump');
  assert.equal(spike.position, null);
  const real = filterGpsFix(spike.state, fix(4, { longitude: 78.0002, speed: 20 }));
  assert.equal(real.accepted, true);
  assert.ok(gpsDistance(real.position, fix(4, { longitude: 78.0002 })) < 5);
});
test('stationary jitter is reduced without inventing sub-sensor accuracy or a compass course', () => {
  let state = start(), rawError = 0, filteredError = 0;
  const origin = fix();
  for (let i = 1; i <= 60; i++) {
    const sample = fix(i * 2, { latitude: 17 + (i % 2 ? 1 : -1) * 0.000025, longitude: 78 + (i % 3 - 1) * 0.00002, heading: 250 });
    const result = filterGpsFix(state, sample);
    assert.equal(result.accepted, true);
    assert.equal(result.position.heading, null);
    assert.equal(result.position.speed, 0);
    assert.ok(result.position.accuracy >= sample.accuracy);
    rawError += gpsDistance(origin, sample) ** 2;
    filteredError += gpsDistance(origin, result.position) ** 2;
    state = result.state;
  }
  assert.ok(filteredError < rawError * 0.25);
});
test('normal travel, an abrupt turn, and departure from a stationary fix remain responsive', () => {
  let state = start();
  const path = [fix(2, { longitude: 78.0003, speed: 60, heading: 90 }), fix(4, { longitude: 78.0006, speed: 60, heading: 90 }), fix(6, { longitude: 78.0006, latitude: 17.0003, speed: 60, heading: 0 })];
  for (const sample of path) {
    const result = filterGpsFix(state, sample);
    assert.equal(result.accepted, true);
    assert.ok(gpsDistance(result.position, sample) <= GPS_FILTER.MAX_SMOOTHING_OFFSET_M);
    assert.deepEqual(result.automationFix.latitude, sample.latitude);
    assert.deepEqual(result.automationFix.longitude, sample.longitude);
    state = result.state;
  }
});
test('unknown or false zero speed cannot claim an arrival while movement is measured', () => {
  for (const speed of [null, 0]) {
    const result = filterGpsFix(start(), fix(2, { longitude: 78.0004, speed, heading: null }));
    assert.equal(result.accepted, true);
    assert.ok(result.automationFix.speed > 50);
    assert.ok(Math.abs(result.position.heading - 90) < 1);
  }
});
test('recovery after a signal gap requires three coherent fixes spanning four seconds', () => {
  let state = start();
  for (const seconds of [40, 42, 44]) {
    const result = filterGpsFix(state, fix(seconds, { longitude: 78.01 }));
    assert.equal(result.accepted, seconds === 44);
    if (seconds === 44) { assert.equal(result.reason, 'reacquired'); assert.equal(result.automationFix, null); }
    state = result.state;
  }
  assert.ok(filterGpsFix(state, fix(46, { longitude: 78.01 })).automationFix);
});
test('poor fixes and incoherent candidates break reacquisition confirmation', () => {
  let result = filterGpsFix(start(), fix(40));
  result = filterGpsFix(result.state, fix(42, { accuracy: 500 }));
  result = filterGpsFix(result.state, fix(44));
  assert.equal(result.accepted, false);
  result = filterGpsFix(result.state, fix(46, { latitude: 20 }));
  assert.equal(result.accepted, false);
  assert.equal(result.state.pending.hits, 1);
});
test('equal-timestamp and delayed fixes cannot advance state or manufacture dwell evidence', () => {
  const state = start();
  for (const seconds of [0, -1]) {
    const result = filterGpsFix(state, fix(seconds));
    assert.equal(result.reason, 'out_of_order');
    assert.deepEqual(result.state, state);
  }
  assert.equal(shouldAutoArrive({ hits: 10, firstSeenMs: epoch, nowMs: epoch + 2000, speedKmh: 0, distM: 0, radiusM: 100 }), false);
  assert.equal(shouldAutoArrive({ hits: 3, firstSeenMs: epoch, nowMs: epoch + 4000, speedKmh: 0, distM: 0, radiusM: 100 }), true);
});
test('serialized filter state has the same result across process restarts', () => {
  const state = filterGpsFix(start(), fix(2, { longitude: 78.0001, speed: 20 })).state;
  assert.deepEqual(filterGpsFix(JSON.parse(JSON.stringify(state)), fix(4, { longitude: 78.0002, speed: 20 })), filterGpsFix(state, fix(4, { longitude: 78.0002, speed: 20 })));
});
test('longitude wrap and high latitudes remain finite', () => {
  const initial = filterGpsFix(null, fix(0, { latitude: 85, longitude: 179.9999, speed: 20 })).state;
  const result = filterGpsFix(initial, fix(2, { latitude: 85, longitude: -179.9999, speed: 20 }));
  assert.equal(result.accepted, true);
  assert.ok(Number.isFinite(result.position.longitude));
  assert.ok(gpsDistance(result.position, fix(2, { latitude: 85, longitude: -179.9999 })) < 5);
});

test('a biased first stationary fix converges toward repeated better observations', () => {
  const origin = fix();
  let state = filterGpsFix(null, fix(0, { latitude: 17.00008, accuracy: 15 })).state;
  const initialError = gpsDistance(origin, state.position);
  for (let i = 1; i <= 20; i++) state = filterGpsFix(state, fix(i * 2)).state;
  assert.ok(gpsDistance(origin, state.position) < initialError * 0.1);
});
