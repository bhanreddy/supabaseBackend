import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLocationBatch } from './transportLocationIngestService.js';
import { adaptiveStopRadiusMeters } from './transportMaintenanceService.js';
import { requireSchoolId } from '../middleware/schoolId.js';

test('adaptive stop radius uses 40 percent and clamps both extremes', () => {
  assert.equal(adaptiveStopRadiusMeters(100), 60);
  assert.equal(adaptiveStopRadiusMeters(250), 100);
  assert.equal(adaptiveStopRadiusMeters(1000), 200);
  assert.equal(adaptiveStopRadiusMeters(null), 200);
});

test('location batches sort, deduplicate, and reject stale fixes', () => {
  const now = new Date('2026-07-15T12:00:00.000Z');
  const fix = (recorded_at, latitude = 17) => ({
    latitude, longitude: 78, speed: 20, heading: 90, recorded_at, is_mocked: false,
  });
  const result = normalizeLocationBatch([
    fix('2026-07-15T11:59:40.000Z'),
    fix('2026-07-15T11:59:20.000Z'),
    fix('2026-07-15T11:59:40.000Z', 18),
    fix('2026-07-15T05:00:00.000Z'),
  ], now);

  assert.deepEqual(result.fixes.map((item) => item.recorded_at), [
    '2026-07-15T11:59:20.000Z',
    '2026-07-15T11:59:40.000Z',
  ]);
  assert.equal(result.fixes[1].latitude, 18);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.staleCount, 1);
});

test('live tracking ignores client school_id and uses the verified JWT tenant', () => {
  for (const path of [
    '/api/v1/transport/buses/bus-1/location',
    '/api/v1/transport/buses/bus-1/locations/batch',
  ]) {
    const req = {
      method: 'POST', path, body: { school_id: '999' }, user: { schoolId: 7 },
    };
    let nextCalled = false;
    requireSchoolId(req, {}, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.schoolId, '7');
  }
});
