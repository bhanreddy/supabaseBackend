// Phase F tenant-isolation + reset + locked-skip rollback integration test.
// Run: node tests/transportCalibrationPhaseF.integration.js
import assert from 'node:assert/strict';
import sql from '../db.js';
import { recordArrivalCalibration } from '../services/transportCalibrationService.js';
import { refreshAdaptiveStopRadii } from '../services/transportMaintenanceService.js';
import {
  getRouteCalibrationReview,
  resetRouteCalibration,
} from '../services/transportCalibrationAdminService.js';

const ROLLBACK = Symbol('phase-f-rollback');

async function run() {
  let assertions = 0;
  try {
    await sql.begin(async (tx) => {
      await tx`ALTER TABLE route_stop_geo ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT false`;

      const suffix = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
      const [schoolA] = await tx`
        INSERT INTO schools (name, code, is_active)
        VALUES (${`Phase F A ${suffix}`}, ${`f6a${suffix}`}, true)
        RETURNING id
      `;
      const [schoolB] = await tx`
        INSERT INTO schools (name, code, is_active)
        VALUES (${`Phase F B ${suffix}`}, ${`f6b${suffix}`}, true)
        RETURNING id
      `;
      const [routeA] = await tx`
        INSERT INTO transport_routes (school_id, name, code, direction, is_active)
        VALUES (${schoolA.id}, 'Phase F Route A', ${`r6a${suffix}`}, 'morning', true)
        RETURNING id
      `;
      const [stopA1] = await tx`
        INSERT INTO transport_stops (school_id, route_id, name, stop_order)
        VALUES (${schoolA.id}, ${routeA.id}, 'Locked Stop', 1)
        RETURNING id
      `;
      const [stopA2] = await tx`
        INSERT INTO transport_stops (school_id, route_id, name, stop_order)
        VALUES (${schoolA.id}, ${routeA.id}, 'Adaptive Stop', 2)
        RETURNING id
      `;

      await tx`
        INSERT INTO route_stop_geo
          (school_id, route_id, stop_id, trip_direction, latitude, longitude,
           sample_weight, sample_count, radius_m, locked)
        VALUES
          (${schoolA.id}, ${routeA.id}, ${stopA1.id}, 'morning', 17.10000000, 78.10000000, 0.01, 2, 100, true),
          (${schoolA.id}, ${routeA.id}, ${stopA2.id}, 'morning', 17.20000000, 78.20000000, 0.01, 2, 120, false)
      `;
      await tx`
        INSERT INTO route_segment_time
          (school_id, route_id, trip_direction, from_stop_id, to_stop_id,
           ewma_seconds, ewvar_seconds, sample_count, last_seconds)
        VALUES
          (${schoolA.id}, ${routeA.id}, 'morning', ${stopA1.id}, ${stopA2.id}, 300, 25, 2, 305)
      `;
      await tx`
        INSERT INTO route_leg_calibration
          (school_id, route_id, trip_direction, is_calibrated, stops_total,
           stops_calibrated, segments_total, segments_learned, clean_trip_count)
        VALUES (${schoolA.id}, ${routeA.id}, 'morning', true, 2, 2, 1, 1, 2)
      `;

      const ownReview = await getRouteCalibrationReview(schoolA.id, routeA.id, tx);
      assert.equal(ownReview.route.id, routeA.id);
      assert.equal(ownReview.legs.find((leg) => leg.trip_direction === 'morning').stops.length, 2);
      assertions += 2;

      const crossTenantRead = await getRouteCalibrationReview(schoolB.id, routeA.id, tx);
      assert.equal(crossTenantRead, null);
      assertions += 1;

      const crossTenantReset = await resetRouteCalibration(schoolB.id, routeA.id, 'morning', tx);
      assert.equal(crossTenantReset, null);
      const [{ count: rowsAfterDeniedReset }] = await tx`
        SELECT COUNT(*)::int AS count FROM route_stop_geo
        WHERE school_id = ${schoolA.id} AND route_id = ${routeA.id} AND trip_direction = 'morning'
      `;
      assert.equal(rowsAfterDeniedReset, 2);
      assertions += 2;

      await recordArrivalCalibration({
        schoolId: schoolA.id,
        routeId: routeA.id,
        tripId: '00000000-0000-0000-0000-000000000000',
        tripDirection: 'morning',
        stopId: stopA1.id,
        stopOrder: 1,
        arrivalTime: new Date(),
        source: 'manual',
        latitude: 18.5,
        longitude: 79.5,
        accuracy: 5,
        isMocked: false,
      }, tx);
      const [lockedRow] = await tx`
        SELECT latitude, longitude, sample_count FROM route_stop_geo
        WHERE school_id = ${schoolA.id} AND stop_id = ${stopA1.id} AND trip_direction = 'morning'
      `;
      assert.equal(Number(lockedRow.latitude), 17.1);
      assert.equal(Number(lockedRow.longitude), 78.1);
      assert.equal(lockedRow.sample_count, 2);
      assertions += 3;

      await recordArrivalCalibration({
        schoolId: schoolA.id,
        routeId: routeA.id,
        tripId: '00000000-0000-0000-0000-000000000000',
        tripDirection: 'morning',
        stopId: stopA2.id,
        stopOrder: 1,
        arrivalTime: new Date(),
        source: 'manual',
        latitude: 17.25,
        longitude: 78.25,
        accuracy: 10,
        isMocked: false,
      }, tx);
      const [adaptiveRow] = await tx`
        SELECT latitude, sample_count FROM route_stop_geo
        WHERE school_id = ${schoolA.id} AND stop_id = ${stopA2.id} AND trip_direction = 'morning'
      `;
      assert.notEqual(Number(adaptiveRow.latitude), 17.2);
      assert.equal(adaptiveRow.sample_count, 3);
      assertions += 2;

      await refreshAdaptiveStopRadii(schoolA.id, tx);
      const radiusRows = await tx`
        SELECT stop_id, radius_m FROM route_stop_geo
        WHERE school_id = ${schoolA.id} AND route_id = ${routeA.id}
        ORDER BY stop_id
      `;
      const radiusByStop = new Map(radiusRows.map((row) => [row.stop_id, Number(row.radius_m)]));
      assert.equal(radiusByStop.get(stopA1.id), 100);
      assert.equal(radiusByStop.get(stopA2.id), 200);
      assertions += 2;

      const reset = await resetRouteCalibration(schoolA.id, routeA.id, 'morning', tx);
      assert.deepEqual(reset, {
        trip_direction: 'morning',
        deleted_geo: 2,
        deleted_segments: 1,
        deleted_calibration: 1,
      });
      const [remaining] = await tx`
        SELECT
          (SELECT COUNT(*)::int FROM route_stop_geo WHERE school_id = ${schoolA.id} AND route_id = ${routeA.id}) AS geo,
          (SELECT COUNT(*)::int FROM route_segment_time WHERE school_id = ${schoolA.id} AND route_id = ${routeA.id}) AS segments,
          (SELECT COUNT(*)::int FROM route_leg_calibration WHERE school_id = ${schoolA.id} AND route_id = ${routeA.id}) AS calibration
      `;
      assert.deepEqual(remaining, { geo: 0, segments: 0, calibration: 0 });
      assertions += 2;

      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }

  console.log(`PASS: ${assertions} Phase F assertions (transaction rolled back)`);
}

run().then(() => sql.end()).catch(async (error) => {
  console.error('FAIL: Phase F integration test');
  console.error(error);
  await sql.end();
  process.exitCode = 1;
});
