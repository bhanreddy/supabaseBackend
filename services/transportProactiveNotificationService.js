/**
 * Transport live tracking v2 — Phase D proactive parent notifications.
 *
 * The location-ingest route invokes running-late evaluation in a setImmediate
 * callback. Stop transition owners invoke next-stop evaluation after an atomic
 * reach claim, with completion as a fallback; departure evaluation runs only
 * after completion. All evaluators scope every read/write by school_id.
 */
import sql from '../db.js';
import { normalizeLeg } from './transportCalibrationService.js';

export const RUNNING_LATE_THRESHOLD_MINUTES = 8;

const segmentKey = (fromStopId, toStopId) => `${fromStopId}->${toStopId}`;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

const distanceMeters = (lat1, lon1, lat2, lon2) => {
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const radiusM = 6371000;
  const dLat = toRad(Number(lat2) - Number(lat1));
  const dLon = toRad(Number(lon2) - Number(lon1));
  const a =
    Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(Number(lat1))) * Math.cos(toRad(Number(lat2))) * Math.sin(dLon / 2) ** 2;
  return radiusM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const hasCoordinates = (value) => value?.latitude != null && value?.longitude != null;

/**
 * Pure delay calculation. A positive result means projected arrival is later
 * than the learned expected arrival.
 */
export function calculateProjectedDelayMinutes({
  startedAt,
  now,
  expectedArrivalOffsetSeconds,
  remainingTravelSeconds,
}) {
  if (startedAt == null || now == null) return null;
  const startMs = new Date(startedAt).getTime();
  const nowMs = new Date(now).getTime();
  const expectedOffset = Number(expectedArrivalOffsetSeconds);
  const remaining = Number(remainingTravelSeconds);
  if (![startMs, nowMs, expectedOffset, remaining].every(Number.isFinite)) return null;

  const expectedArrivalMs = startMs + expectedOffset * 1000;
  const projectedArrivalMs = nowMs + Math.max(0, remaining) * 1000;
  return (projectedArrivalMs - expectedArrivalMs) / 60000;
}

/** Strictly greater than eight minutes, as specified by the product rule. */
export const isRunningLate = (delayMinutes) =>
  Number.isFinite(delayMinutes) && delayMinutes > RUNNING_LATE_THRESHOLD_MINUTES;

/**
 * Pure schedule projection for one boarding stop.
 *
 * Expected arrival = trip.started_at + cumulative learned EWMA segments.
 * Remaining travel on the live segment is the learned segment time multiplied
 * by straight-line GPS progress. The calibrated-leg gate guarantees learned
 * stop coordinates; defensive fallbacks retain the full segment when a row is
 * missing or degenerate.
 */
export function projectDelayAtStop({ startedAt, now, fix, stops, segments, targetStopId }) {
  const targetIndex = stops.findIndex((stop) => String(stop.stop_id) === String(targetStopId));
  if (targetIndex < 0) return null;

  let expectedArrivalOffsetSeconds = 0;
  for (let index = 0; index < targetIndex; index += 1) {
    const segment = segments[segmentKey(stops[index].stop_id, stops[index + 1].stop_id)];
    const seconds = Number(segment?.ewma_seconds);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    expectedArrivalOffsetSeconds += seconds;
  }

  let remainingTravelSeconds = 0;
  if (targetIndex > 0) {
    const fromStop = stops[targetIndex - 1];
    const targetStop = stops[targetIndex];
    const segmentSeconds = Number(
      segments[segmentKey(fromStop.stop_id, targetStop.stop_id)]?.ewma_seconds,
    );
    if (!Number.isFinite(segmentSeconds) || segmentSeconds < 0) return null;

    let remainingFraction = 1;
    if (hasCoordinates(fix) && hasCoordinates(fromStop) && hasCoordinates(targetStop)) {
      const fullDistance = distanceMeters(
        fromStop.latitude,
        fromStop.longitude,
        targetStop.latitude,
        targetStop.longitude,
      );
      if (fullDistance > 0) {
        const distanceToTarget = distanceMeters(
          fix.latitude,
          fix.longitude,
          targetStop.latitude,
          targetStop.longitude,
        );
        remainingFraction = clamp(distanceToTarget / fullDistance, 0, 1);
      }
    }
    remainingTravelSeconds = segmentSeconds * remainingFraction;
  }

  const delayMinutes = calculateProjectedDelayMinutes({
    startedAt,
    now,
    expectedArrivalOffsetSeconds,
    remainingTravelSeconds,
  });
  if (delayMinutes == null) return null;

  return {
    delayMinutes,
    expectedArrivalOffsetSeconds,
    remainingTravelSeconds,
  };
}

async function notificationDependencies(overrides = {}) {
  if (overrides.getStudentIdsAtStop && overrides.sendTransportNotification) return overrides;
  const notificationService = await import('./notificationService.js');
  return {
    getStudentIdsAtStop:
      overrides.getStudentIdsAtStop || notificationService.getTransportStudentIdsAtStop,
    sendTransportNotification:
      overrides.sendTransportNotification || notificationService.sendTransportNotification,
  };
}

/**
 * Notify parents assigned to the next stop when the bus reaches the stop
 * immediately before it. trip_stop_status.stop_order is already stored in the
 * actual execution order, including reverse/evening trips.
 *
 * approach_notified_at is shared with the GPS-proximity fallback, so whichever
 * path claims the next stop first sends the only approaching notification for
 * that stop during this trip.
 */
export async function notifyParentsAtNextStop(
  schoolId,
  tripId,
  precedingStopId,
  db = sql,
  dependencies = {},
) {
  try {
    if (!schoolId || !tripId || !precedingStopId) {
      return { notified: false, reason: 'invalid_input' };
    }

    const [nextStop] = await db`
      SELECT t.route_id, next_tss.id AS trip_stop_status_id,
             next_tss.stop_id, next_stop.name AS stop_name
      FROM trips t
      JOIN trip_stop_status preceding_tss
        ON preceding_tss.trip_id = t.id
        AND preceding_tss.school_id = ${schoolId}
        AND preceding_tss.stop_id = ${precedingStopId}
        AND preceding_tss.status IN ('arrived', 'completed')
      JOIN trip_stop_status next_tss
        ON next_tss.trip_id = t.id
        AND next_tss.school_id = ${schoolId}
        AND next_tss.stop_order = preceding_tss.stop_order + 1
        AND next_tss.status = 'pending'
      JOIN transport_stops next_stop
        ON next_stop.id = next_tss.stop_id
        AND next_stop.school_id = ${schoolId}
        AND next_stop.route_id = t.route_id
        AND next_stop.deleted_at IS NULL
      WHERE t.id = ${tripId}
        AND t.school_id = ${schoolId}
        AND t.status IN ('active', 'in_progress')
      LIMIT 1
    `;
    if (!nextStop) return { notified: false, reason: 'no_next_pending_stop' };

    const [claimed] = await db`
      UPDATE trip_stop_status
      SET approach_notified_at = NOW()
      WHERE id = ${nextStop.trip_stop_status_id}
        AND school_id = ${schoolId}
        AND trip_id = ${tripId}
        AND status = 'pending'
        AND approach_notified_at IS NULL
      RETURNING id
    `;
    if (!claimed) return { notified: false, reason: 'already_notified' };

    const notify = await notificationDependencies(dependencies);
    const studentIds = await notify.getStudentIdsAtStop(
      schoolId,
      nextStop.route_id,
      nextStop.stop_id,
      db,
    );
    if (!studentIds.length) return {
      notified: false,
      reason: 'no_students',
      stopId: nextStop.stop_id,
    };

    await notify.sendTransportNotification(
      studentIds,
      'TRANSPORT_BUS_APPROACHING',
      { stopName: nextStop.stop_name },
      schoolId,
      db,
    );
    return {
      notified: true,
      students: studentIds.length,
      stopId: nextStop.stop_id,
    };
  } catch (error) {
    console.error('[Transport Notify] next-stop evaluation error:', error);
    return { notified: false, reason: 'error' };
  }
}

/**
 * Evaluate and atomically claim the one running-late alert allowed per trip.
 * Intended to run from the location route's existing setImmediate block.
 */
export async function evaluateRunningLate(schoolId, busId, fix, db = sql, dependencies = {}) {
  try {
    if (!schoolId || !busId || !hasCoordinates(fix)) return { notified: false, reason: 'invalid_input' };

    const [trip] = await db`
      SELECT t.id, t.route_id, t.trip_direction, t.started_at, t.late_notified_at,
             calibration.trip_direction AS learned_leg
      FROM trips t
      JOIN route_leg_calibration calibration
        ON calibration.school_id = ${schoolId}
        AND calibration.route_id = t.route_id
        AND calibration.trip_direction = CASE
          WHEN t.trip_direction IN ('afternoon', 'evening') THEN 'evening'
          ELSE 'morning'
        END
        AND calibration.is_calibrated = TRUE
      WHERE t.bus_id = ${busId}
        AND t.school_id = ${schoolId}
        AND t.status IN ('active', 'in_progress')
      ORDER BY t.created_at DESC
      LIMIT 1
    `;
    if (!trip || trip.late_notified_at || !trip.started_at) {
      return { notified: false, reason: trip?.late_notified_at ? 'already_notified' : 'no_live_trip' };
    }

    const leg = trip.learned_leg;
    const [stops, segmentRows] = await Promise.all([
      db`
        SELECT tss.stop_id, tss.stop_order, tss.status, ts.name,
               geo.latitude, geo.longitude
        FROM trip_stop_status tss
        JOIN transport_stops ts
          ON ts.id = tss.stop_id
          AND ts.school_id = ${schoolId}
        JOIN route_stop_geo geo
          ON geo.stop_id = tss.stop_id
          AND geo.school_id = ${schoolId}
          AND geo.route_id = ${trip.route_id}
          AND geo.trip_direction = ${leg}
        WHERE tss.trip_id = ${trip.id}
          AND tss.school_id = ${schoolId}
        ORDER BY tss.stop_order ASC
      `,
      db`
        SELECT from_stop_id, to_stop_id, ewma_seconds
        FROM route_segment_time
        WHERE school_id = ${schoolId}
          AND route_id = ${trip.route_id}
          AND trip_direction = ${leg}
      `,
    ]);
    const targetStop = stops.find((stop) => stop.status === 'pending');
    if (!targetStop) return { notified: false, reason: 'no_pending_stop' };

    const segments = Object.fromEntries(
      segmentRows.map((row) => [segmentKey(row.from_stop_id, row.to_stop_id), row]),
    );
    const projection = projectDelayAtStop({
      startedAt: trip.started_at,
      now: new Date(),
      fix,
      stops,
      segments,
      targetStopId: targetStop.stop_id,
    });
    if (!projection || !isRunningLate(projection.delayMinutes)) {
      return { notified: false, reason: 'on_time', delayMinutes: projection?.delayMinutes ?? null };
    }

    const notify = await notificationDependencies(dependencies);
    const studentIds = await notify.getStudentIdsAtStop(
      schoolId,
      trip.route_id,
      targetStop.stop_id,
      db,
    );
    if (!studentIds.length) return { notified: false, reason: 'no_students' };

    // This is the dedup claim. Concurrent GPS fixes can calculate in parallel,
    // but only one can cross this UPDATE ... IS NULL guard and send the push.
    const [claimed] = await db`
      UPDATE trips
      SET late_notified_at = NOW()
      WHERE id = ${trip.id}
        AND school_id = ${schoolId}
        AND status IN ('active', 'in_progress')
        AND late_notified_at IS NULL
      RETURNING id, late_notified_at
    `;
    if (!claimed) return { notified: false, reason: 'claim_lost' };

    const roundedDelayMinutes = Math.max(1, Math.round(projection.delayMinutes));
    await notify.sendTransportNotification(
      studentIds,
      'TRANSPORT_BUS_RUNNING_LATE',
      { delayMinutes: roundedDelayMinutes },
      schoolId,
      db,
    );
    return {
      notified: true,
      delayMinutes: roundedDelayMinutes,
      stopId: targetStop.stop_id,
    };
  } catch (error) {
    console.error('[Transport Notify] running-late evaluation error:', error);
    return { notified: false, reason: 'error' };
  }
}

/**
 * Notify each student's parents after that student's morning boarding stop has
 * atomically transitioned to completed. Attendance, when marked present, turns
 * the cautious "should be aboard" wording into confirmed "is aboard" wording.
 */
export async function notifyBoardingStopDeparted(
  schoolId,
  tripId,
  stopId,
  db = sql,
  dependencies = {},
) {
  try {
    const [context] = await db`
      SELECT t.id, t.route_id, t.trip_direction, ts.name AS stop_name
      FROM trips t
      JOIN route_leg_calibration cal
        ON cal.school_id = ${schoolId}
        AND cal.route_id = t.route_id
        AND cal.trip_direction = CASE
          WHEN t.trip_direction IN ('afternoon', 'evening') THEN 'evening'
          ELSE 'morning'
        END
        AND cal.is_calibrated = TRUE
      JOIN trip_stop_status tss
        ON tss.trip_id = t.id
        AND tss.school_id = ${schoolId}
        AND tss.stop_id = ${stopId}
        AND tss.status = 'completed'
      JOIN transport_stops ts
        ON ts.id = tss.stop_id
        AND ts.school_id = ${schoolId}
        AND ts.route_id = t.route_id
      WHERE t.id = ${tripId}
        AND t.school_id = ${schoolId}
        AND t.status IN ('active', 'in_progress')
      LIMIT 1
    `;
    if (!context) return { notified: false, reason: 'not_calibrated_live_completed' };

    // Assigned home stops are boarding stops only on the morning leg. Sending
    // "should be aboard" after the same stop on the evening drop leg is false.
    if (normalizeLeg(context.trip_direction) !== 'morning') {
      return { notified: false, reason: 'not_boarding_leg' };
    }

    const notify = await notificationDependencies(dependencies);
    const studentIds = await notify.getStudentIdsAtStop(
      schoolId,
      context.route_id,
      stopId,
      db,
    );
    if (!studentIds.length) return { notified: false, reason: 'no_students' };

    const students = await db`
      SELECT stu.id AS student_id,
             COALESCE(NULLIF(BTRIM(person.display_name), ''), 'Your child') AS student_name,
             attendance.status AS attendance_status
      FROM students stu
      JOIN persons person ON person.id = stu.person_id
      LEFT JOIN LATERAL (
        SELECT ba.status
        FROM bus_stop_attendance ba
        WHERE ba.school_id = ${schoolId}
          AND ba.trip_id = ${tripId}
          AND ba.stop_id = ${stopId}
          AND ba.student_id = stu.id
        ORDER BY ba.marked_at DESC
        LIMIT 1
      ) attendance ON TRUE
      WHERE stu.school_id = ${schoolId}
        AND stu.deleted_at IS NULL
        AND stu.id = ANY(${db.array(studentIds)}::uuid[])
      ORDER BY person.display_name ASC
    `;

    const results = await Promise.allSettled(students.map((student) => {
      const confirmedAboard = student.attendance_status === 'present';
      return notify.sendTransportNotification(
        [student.student_id],
        'TRANSPORT_BUS_DEPARTED',
        {
          stopName: context.stop_name,
          studentName: student.student_name,
          boardingStatus: confirmedAboard ? 'is aboard' : 'should be aboard',
          boardingStatus_te: confirmedAboard ? 'బస్సులో ఉన్నారు' : 'బస్సులో ఉండాలి',
        },
        schoolId,
        db,
      );
    }));

    return {
      notified: true,
      students: students.length,
      failed: results.filter((result) => result.status === 'rejected').length,
    };
  } catch (error) {
    console.error('[Transport Notify] departure evaluation error:', error);
    return { notified: false, reason: 'error' };
  }
}
