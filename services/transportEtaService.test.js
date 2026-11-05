import assert from 'node:assert/strict';
import test from 'node:test';
import { computeLearnedEta, segKey } from './transportEtaService.js';
const now = Date.parse('2026-11-03T03:00:00Z');
const stops = [
  { id: 'a', latitude: 17, longitude: 78, status: 'completed', exec_order: 1 },
  { id: 'b', latitude: 17, longitude: 78.04, status: 'pending', exec_order: 2 },
  { id: 'c', latitude: 17, longitude: 78.08, status: 'pending', exec_order: 3 },
];
const location = { latitude: 17, longitude: 78.02, speed: 30, heading: 90, recorded_at: new Date(now).toISOString(), accuracy: 10 };
const segments = { [segKey('a', 'b')]: { ewma: 600, ewvar: 900, count: 8 }, [segKey('b', 'c')]: { ewma: 600, ewvar: 900, count: 8 } };
const eta = (overrides = {}) => computeLearnedEta({ location, stops, segments, boardingStopId: 'c', now, ...overrides });
test('learned partial leg keeps observed traffic time even at a high instantaneous speed', () => {
  const result = eta({ location: { ...location, speed: 85 } });
  assert.equal(result.eta_minutes, 15);
  assert.equal(result.source, 'learned');
  assert.equal(result.confidence, 'high');
  assert.ok(result.eta_low_minutes <= result.eta_minutes && result.eta_high_minutes >= result.eta_minutes);
});
test('off-route GPS falls back to live speed instead of unrelated segment progress', () => {
  const result = eta({ location: { ...location, latitude: 17.1 } });
  assert.ok(result.eta_minutes > 25);
});
test('stopped or invalid speeds widen uncertainty and never produce NaN or infinity', () => {
  for (const speed of [0, null, -1, Infinity, NaN, 240]) {
    const result = eta({ segments: {}, location: { ...location, speed } });
    assert.ok(Number.isFinite(result.eta_minutes));
    assert.equal(result.confidence, 'low');
  }
});
test('arrived intermediate stop contributes no fictitious approach leg', () => {
  const result = eta({ stops: stops.map(s => s.id === 'b' ? { ...s, status: 'arrived' } : s) });
  assert.equal(result.eta_minutes, 10);
});
test('zero ETA requires a confirmed arrival', () => {
  assert.equal(eta({ boardingStopId: 'b', location: { ...location, longitude: 78.0399 } }).eta_minutes, 1);
  assert.equal(eta({ boardingStopId: 'b', stops: stops.map(s => s.id === 'b' ? { ...s, status: 'arrived' } : s) }).eta_minutes, 0);
});
test('execution order wins over array order for reverse trips', () => {
  assert.deepEqual(eta({ stops: [...stops].reverse() }), eta());
});
test('stale, future, mocked, suspicious and poor accuracy fixes cannot supply ETA', () => {
  for (const patch of [{ recorded_at: new Date(now - 121000).toISOString() }, { recorded_at: new Date(now + 6000).toISOString() }, { is_mocked: true }, { is_suspicious: true }, { accuracy: 500 }]) {
    assert.equal(eta({ location: { ...location, ...patch } }).eta_minutes, null);
  }
});
test('delayed observations downgrade confidence without silently counting down travel', () => {
  const result = eta({ location: { ...location, recorded_at: new Date(now - 20000).toISOString() } });
  assert.equal(result.eta_minutes, eta().eta_minutes);
  assert.equal(result.confidence, 'low');
});
test('missing route geometry never silently contributes zero travel time', () => {
  assert.equal(eta({ segments: {}, stops: stops.map(s => s.id === 'c' ? { ...s, latitude: null } : s) }).eta_minutes, null);
});
test('completed and skipped boarding stops are not reported as arriving now', () => {
  for (const status of ['completed', 'skipped']) assert.equal(eta({ stops: stops.map(s => s.id === 'c' ? { ...s, status } : s) }).eta_minutes, null);
});
