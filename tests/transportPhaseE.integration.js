// Phase E rollback-transaction integration test.
// Run: node tests/transportPhaseE.integration.js
import assert from 'node:assert/strict';
import sql from '../db.js';
import {
  ingestLocationBatch,
  runNewestFixEffects,
} from '../services/transportLocationIngestService.js';

const ROLLBACK = Symbol('phase-e-rollback');

async function run() {
  let assertions = 0;
  try {
    await sql.begin(async (tx) => {
      // Exercise the migration contract without mutating the shared database.
      await tx`ALTER TABLE bus_trip_history ADD COLUMN IF NOT EXISTS heading DOUBLE PRECISION`;
      await tx`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_bus_trip_history_bus_recorded_at
        ON bus_trip_history (bus_id, recorded_at)
      `;

      const [bus] = await tx`
        SELECT id, school_id FROM buses
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC LIMIT 1
      `;
      assert.ok(bus, 'requires one bus fixture');
      assertions += 1;

      await tx`
        DELETE FROM bus_locations WHERE bus_id = ${bus.id} AND school_id = ${bus.school_id}
      `;
      const now = new Date();
      const timestamp = (secondsAgo) => new Date(now.getTime() - secondsAgo * 1000).toISOString();
      const oldestAt = timestamp(50);
      const middleAt = timestamp(30);
      const newestAt = timestamp(10);
      const fixes = [
        { latitude: 17.3, longitude: 78.3, speed: 30, heading: 90, recorded_at: newestAt, is_mocked: false },
        { latitude: 17.1, longitude: 78.1, speed: 10, heading: 70, recorded_at: oldestAt, is_mocked: false },
        { latitude: 17.2, longitude: 78.2, speed: 20, heading: 80, recorded_at: middleAt, is_mocked: false },
      ];

      const first = await ingestLocationBatch({
        schoolId: bus.school_id, busId: bus.id, fixes, now,
      }, tx);
      assert.equal(first.insertedCount, 3);
      assert.equal(first.realtimeUpdated, true);
      assert.equal(first.newestForEvaluation.recorded_at, newestAt);
      assertions += 3;

      const history = await tx`
        SELECT latitude, recorded_at FROM bus_trip_history
        WHERE school_id = ${bus.school_id} AND bus_id = ${bus.id}
          AND recorded_at = ANY(${tx.array([oldestAt, middleAt, newestAt])}::timestamptz[])
        ORDER BY recorded_at ASC
      `;
      assert.deepEqual(history.map((row) => Number(row.latitude)), [17.1, 17.2, 17.3]);
      assertions += 1;

      const calls = { geofence: [], approach: [], late: [] };
      if (first.newestForEvaluation) {
        await runNewestFixEffects({
          schoolId: bus.school_id,
          busId: bus.id,
          fix: first.newestForEvaluation,
        }, {
          db: tx,
          evaluateGeofence: async (...args) => calls.geofence.push(args),
          notifyApproachingStop: async (...args) => calls.approach.push(args),
          evaluateRunningLate: async (...args) => calls.late.push(args),
        });
      }
      assert.equal(calls.geofence.length, 1);
      assert.equal(calls.approach.length, 1);
      assert.equal(calls.late.length, 1);
      assert.equal(calls.geofence[0][2].recorded_at, newestAt);
      assertions += 4;

      const retry = await ingestLocationBatch({
        schoolId: bus.school_id, busId: bus.id, fixes, now,
      }, tx);
      assert.equal(retry.insertedCount, 0);
      assert.equal(retry.realtimeUpdated, false);
      assert.equal(retry.newestForEvaluation, null);
      assertions += 3;

      // Mocked locations are retained as audit history but cannot overwrite the
      // public live point or trigger any transport side effect.
      const mockedAt = timestamp(5);
      const mocked = await ingestLocationBatch({
        schoolId: bus.school_id,
        busId: bus.id,
        fixes: [{ latitude: 17.9, longitude: 78.9, recorded_at: mockedAt, is_mocked: true }],
        now,
      }, tx);
      assert.equal(mocked.insertedCount, 1);
      assert.equal(mocked.realtimeUpdated, false);
      assert.equal(mocked.newestForEvaluation, null);
      const [mockedHistory] = await tx`
        SELECT is_mocked, is_suspicious FROM bus_trip_history
        WHERE school_id = ${bus.school_id} AND bus_id = ${bus.id} AND recorded_at = ${mockedAt}
      `;
      assert.deepEqual(mockedHistory, { is_mocked: true, is_suspicious: true });
      assertions += 4;

      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  console.log(`PASS: ${assertions} Phase E integration assertions (transaction rolled back)`);
}

run().then(() => sql.end()).catch(async (error) => {
  console.error('FAIL: Phase E integration test');
  console.error(error);
  await sql.end();
  process.exitCode = 1;
});
