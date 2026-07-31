// Phase D rollback-transaction integration test.
//
// Seeds a calibrated late trip, executes the real tenant-scoped claim queries,
// and injects only the external push boundary. The sentinel rollback guarantees
// that no fixture or late_notified_at mutation persists.
// Run: node tests/transportProactiveNotifications.integration.js
import assert from 'node:assert/strict';
import sql from '../db.js';
import {
  evaluateRunningLate,
  notifyBoardingStopDeparted,
  notifyParentsAtNextStop,
} from '../services/transportProactiveNotificationService.js';

const ROLLBACK = Symbol('phase-d-rollback');

async function run() {
  let assertions = 0;

  try {
    await sql.begin(async (tx) => {
      const [fixture] = await tx`
        SELECT st.school_id, st.route_id, st.stop_id, st.student_id,
               bus.id AS bus_id, driver.id AS driver_id
        FROM student_transport st
        JOIN transport_routes route
          ON route.id = st.route_id
          AND route.school_id = st.school_id
          AND route.deleted_at IS NULL
        JOIN transport_stops stop
          ON stop.id = st.stop_id
          AND stop.school_id = st.school_id
          AND stop.deleted_at IS NULL
        JOIN academic_years year
          ON year.id = st.academic_year_id
          AND year.school_id = st.school_id
          AND CURRENT_DATE BETWEEN year.start_date AND year.end_date
          AND year.deleted_at IS NULL
        JOIN LATERAL (
          SELECT b.id
          FROM buses b
          WHERE b.school_id = st.school_id AND b.deleted_at IS NULL
          ORDER BY b.created_at ASC
          LIMIT 1
        ) bus ON TRUE
        JOIN LATERAL (
          SELECT staff.id
          FROM staff
          WHERE staff.school_id = st.school_id AND staff.deleted_at IS NULL
          ORDER BY staff.created_at ASC
          LIMIT 1
        ) driver ON TRUE
        WHERE st.is_active = TRUE
        ORDER BY st.created_at ASC
        LIMIT 1
      `;
      assert.ok(fixture, 'requires one current transport assignment, bus, and staff row');
      assertions += 1;

      // Free the partial unique index for the isolated live trip. Rolled back.
      await tx`
        UPDATE trips
        SET status = 'completed', ended_at = COALESCE(ended_at, NOW())
        WHERE school_id = ${fixture.school_id}
          AND bus_id = ${fixture.bus_id}
          AND status IN ('active', 'in_progress')
      `;

      const [{ next_order: previousStopOrder }] = await tx`
        SELECT COALESCE(MAX(stop_order), 0) + 1000 AS next_order
        FROM transport_stops
        WHERE school_id = ${fixture.school_id} AND route_id = ${fixture.route_id}
      `;
      const [previousStop] = await tx`
        INSERT INTO transport_stops
          (school_id, route_id, name, latitude, longitude, stop_order)
        VALUES
          (${fixture.school_id}, ${fixture.route_id}, '__phase_d_previous_stop__',
           17.00000000, 78.00000000, ${previousStopOrder})
        RETURNING id
      `;

      const [trip] = await tx`
        INSERT INTO trips
          (school_id, bus_id, route_id, driver_id, status, started_at,
           trip_date, trip_direction, late_notified_at)
        VALUES
          (${fixture.school_id}, ${fixture.bus_id}, ${fixture.route_id}, ${fixture.driver_id},
           'in_progress', NOW() - INTERVAL '20 minutes', CURRENT_DATE, 'morning', NULL)
        RETURNING id
      `;

      await tx`
        INSERT INTO trip_stop_status
          (school_id, trip_id, stop_id, stop_order, status, arrival_time, departure_time)
        VALUES
          (${fixture.school_id}, ${trip.id}, ${previousStop.id}, 1, 'arrived',
           NOW() - INTERVAL '16 minutes', NULL),
          (${fixture.school_id}, ${trip.id}, ${fixture.stop_id}, 2, 'pending', NULL, NULL)
      `;

      await tx`
        INSERT INTO route_leg_calibration
          (school_id, route_id, trip_direction, is_calibrated,
           stops_total, stops_calibrated, segments_total, segments_learned, clean_trip_count)
        VALUES
          (${fixture.school_id}, ${fixture.route_id}, 'morning', TRUE, 2, 2, 1, 1, 2)
        ON CONFLICT (school_id, route_id, trip_direction) DO UPDATE SET
          is_calibrated = TRUE,
          stops_total = 2,
          stops_calibrated = 2,
          segments_total = 1,
          segments_learned = 1,
          clean_trip_count = GREATEST(route_leg_calibration.clean_trip_count, 2)
      `;

      await tx`
        INSERT INTO route_stop_geo
          (school_id, route_id, stop_id, trip_direction, latitude, longitude,
           sample_weight, sample_count, radius_m)
        VALUES
          (${fixture.school_id}, ${fixture.route_id}, ${previousStop.id}, 'morning',
           17.00000000, 78.00000000, 0.01, 2, 100),
          (${fixture.school_id}, ${fixture.route_id}, ${fixture.stop_id}, 'morning',
           17.01000000, 78.01000000, 0.01, 2, 100)
        ON CONFLICT (school_id, stop_id, trip_direction) DO UPDATE SET
          route_id = EXCLUDED.route_id,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude
      `;

      await tx`
        INSERT INTO route_segment_time
          (school_id, route_id, trip_direction, from_stop_id, to_stop_id,
           ewma_seconds, ewvar_seconds, sample_count, last_seconds)
        VALUES
          (${fixture.school_id}, ${fixture.route_id}, 'morning',
           ${previousStop.id}, ${fixture.stop_id}, 300, 0, 2, 300)
        ON CONFLICT (school_id, route_id, trip_direction, from_stop_id, to_stop_id)
        DO UPDATE SET ewma_seconds = 300, ewvar_seconds = 0, sample_count = 2, last_seconds = 300
      `;

      const pushes = [];
      const dependencies = {
        getStudentIdsAtStop: async (schoolId, routeId, stopId, db) => {
          const rows = await db`
            SELECT st.student_id
            FROM student_transport st
            JOIN academic_years year
              ON year.id = st.academic_year_id
              AND year.school_id = ${schoolId}
              AND CURRENT_DATE BETWEEN year.start_date AND year.end_date
              AND year.deleted_at IS NULL
            WHERE st.school_id = ${schoolId}
              AND st.route_id = ${routeId}
              AND st.stop_id = ${stopId}
              AND st.is_active = TRUE
          `;
          return rows.map((row) => row.student_id);
        },
        sendTransportNotification: async (studentIds, eventKey, templateVars, schoolId) => {
          pushes.push({ studentIds, eventKey, templateVars, schoolId });
        },
      };

      const fix = { latitude: 17.01000000, longitude: 78.01000000, speed: 20 };
      const first = await evaluateRunningLate(
        fixture.school_id,
        fixture.bus_id,
        fix,
        tx,
        dependencies,
      );
      assert.equal(first.notified, true);
      assert.ok(first.delayMinutes > 8);
      assert.equal(pushes.length, 1);
      assert.equal(pushes[0].eventKey, 'TRANSPORT_BUS_RUNNING_LATE');
      assert.ok(pushes[0].studentIds.includes(fixture.student_id));
      assert.equal(new Set(pushes[0].studentIds).size, pushes[0].studentIds.length);
      assert.equal(pushes[0].schoolId, fixture.school_id);
      assertions += 7;

      const second = await evaluateRunningLate(
        fixture.school_id,
        fixture.bus_id,
        fix,
        tx,
        dependencies,
      );
      assert.equal(second.notified, false);
      assert.equal(second.reason, 'already_notified');
      assert.equal(pushes.length, 1);
      assertions += 3;

      const [claimedTrip] = await tx`
        SELECT late_notified_at
        FROM trips
        WHERE id = ${trip.id} AND school_id = ${fixture.school_id}
      `;
      assert.ok(claimedTrip.late_notified_at);
      assertions += 1;

      const approachPushes = [];
      const approach = await notifyParentsAtNextStop(
        fixture.school_id,
        trip.id,
        previousStop.id,
        tx,
        {
          getStudentIdsAtStop: async () => [fixture.student_id],
          sendTransportNotification: async (
            studentIds,
            eventKey,
            templateVars,
            schoolId,
          ) => approachPushes.push({ studentIds, eventKey, templateVars, schoolId }),
        },
      );
      assert.equal(approach.notified, true);
      assert.equal(approach.stopId, fixture.stop_id);
      assert.equal(approachPushes.length, 1);
      assert.equal(approachPushes[0].eventKey, 'TRANSPORT_BUS_APPROACHING');
      assert.deepEqual(approachPushes[0].studentIds, [fixture.student_id]);
      assert.ok(approachPushes[0].templateVars.stopName);
      assert.equal(approachPushes[0].schoolId, fixture.school_id);
      assertions += 7;

      const [completedStop] = await tx`
        UPDATE trip_stop_status
        SET status = 'completed', arrival_time = NOW(), departure_time = NOW()
        WHERE school_id = ${fixture.school_id}
          AND trip_id = ${trip.id}
          AND stop_id = ${fixture.stop_id}
          AND status = 'pending'
        RETURNING stop_id
      `;
      assert.equal(completedStop.stop_id, fixture.stop_id);

      await tx`
        INSERT INTO bus_stop_attendance
          (school_id, trip_id, stop_id, student_id, route_id, driver_id, status)
        VALUES
          (${fixture.school_id}, ${trip.id}, ${fixture.stop_id}, ${fixture.student_id},
           ${fixture.route_id}, ${fixture.driver_id}, 'present')
      `;

      const departurePushes = [];
      const departure = await notifyBoardingStopDeparted(
        fixture.school_id,
        trip.id,
        fixture.stop_id,
        tx,
        {
          getStudentIdsAtStop: async () => [fixture.student_id],
          sendTransportNotification: async (
            studentIds,
            eventKey,
            templateVars,
            schoolId,
          ) => departurePushes.push({ studentIds, eventKey, templateVars, schoolId }),
        },
      );
      assert.equal(departure.notified, true);
      assert.equal(departurePushes.length, 1);
      assert.equal(departurePushes[0].eventKey, 'TRANSPORT_BUS_DEPARTED');
      assert.deepEqual(departurePushes[0].studentIds, [fixture.student_id]);
      assert.equal(departurePushes[0].templateVars.boardingStatus, 'is aboard');
      assert.equal(departurePushes[0].templateVars.boardingStatus_te, 'బస్సులో ఉన్నారు');
      assert.equal(departurePushes[0].schoolId, fixture.school_id);
      assertions += 8;

      const wrongTenant = await evaluateRunningLate(
        -1,
        fixture.bus_id,
        fix,
        tx,
        dependencies,
      );
      assert.equal(wrongTenant.notified, false);
      assert.equal(pushes.length, 1);
      assertions += 2;

      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }

  console.log(`PASS: ${assertions} Phase D integration assertions (transaction rolled back)`);
}

run()
  .then(() => sql.end())
  .catch(async (error) => {
    console.error('FAIL: Phase D integration test');
    console.error(error);
    await sql.end();
    process.exitCode = 1;
  });
