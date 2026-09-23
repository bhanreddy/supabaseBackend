import sql from '../db.js';
import { authorizeTrip, requireDriver, isLiveTrip, transportError, withTransportTransaction } from './transportAccessService.js';
import { recordArrivalCalibration, finalizeTripCalibration, normalizeLeg } from './transportCalibrationService.js';
import { enqueueStopNotification } from './transportOutboxService.js';
export const transportDate = (date = new Date(), timezone = 'Asia/Kolkata') => new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(date);
export function transportLeg(direction, requested, date = new Date()) {
  if (requested != null && !['morning', 'evening', 'afternoon'].includes(requested)) {
    throw transportError(400, 'INVALID_LEG', 'Choose morning or evening');
  }
  if (direction !== 'both') return normalizeLeg(direction);
  return requested ? normalizeLeg(requested) : Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    hourCycle: 'h23'
  }).format(date)) >= 12 ? 'evening' : 'morning';
}
export async function effectiveRouteStops(schoolId, routeId, leg, db = sql) {
  const rows = await db`SELECT s.id,s.name,s.stop_order,
    CASE WHEN g.locked THEN g.latitude WHEN s.latitude IS NOT NULL AND s.longitude IS NOT NULL THEN s.latitude ELSE g.latitude END AS latitude,
    CASE WHEN g.locked THEN g.longitude WHEN s.latitude IS NOT NULL AND s.longitude IS NOT NULL THEN s.longitude ELSE g.longitude END AS longitude,
    COALESCE(g.radius_m,100) AS radius_m,
    CASE WHEN g.locked THEN 'override' WHEN s.latitude IS NOT NULL AND s.longitude IS NOT NULL THEN 'surveyed'
      WHEN g.latitude IS NOT NULL THEN 'learned' ELSE 'unavailable' END AS coordinate_source
    FROM transport_stops s LEFT JOIN route_stop_geo g ON g.school_id=s.school_id AND g.stop_id=s.id
      AND g.route_id=s.route_id AND g.trip_direction=${normalizeLeg(leg)}
    WHERE s.school_id=${schoolId} AND s.route_id=${routeId} AND s.deleted_at IS NULL ORDER BY s.stop_order`;
  const ordered = normalizeLeg(leg) === 'evening' ? [...rows].reverse() : rows;
  return ordered.map((stop, i) => ({
    ...stop,
    exec_order: i + 1
  }));
}
export async function snapshotTrip(trip, db = sql) {
  const stops = await effectiveRouteStops(trip.school_id, trip.route_id, trip.trip_direction, db);
  if (!stops.length) throw transportError(400, 'NO_STOPS', 'Route has no stops');
  for (const stop of stops) {
    await db`INSERT INTO trip_stop_status(school_id,trip_id,stop_id,stop_order,status,snapshot_name,
      snapshot_latitude,snapshot_longitude,snapshot_radius_m,coordinate_source)
      VALUES(${trip.school_id},${trip.id},${stop.id},${stop.exec_order},'pending',${stop.name},
        ${stop.latitude},${stop.longitude},${stop.radius_m},${stop.coordinate_source})
      ON CONFLICT(school_id,trip_id,stop_id) DO UPDATE SET
        snapshot_name=EXCLUDED.snapshot_name,snapshot_latitude=EXCLUDED.snapshot_latitude,
        snapshot_longitude=EXCLUDED.snapshot_longitude,snapshot_radius_m=EXCLUDED.snapshot_radius_m,
        coordinate_source=EXCLUDED.coordinate_source
      WHERE trip_stop_status.snapshot_name IS NULL`;
  }
  await db`INSERT INTO transport_trip_roster(school_id,trip_id,stop_id,student_id)
    SELECT st.school_id,${trip.id},st.stop_id,st.student_id FROM student_transport st
    JOIN academic_years ay ON ay.id=st.academic_year_id AND ay.school_id=st.school_id
    JOIN trip_stop_status ss ON ss.trip_id=${trip.id} AND ss.school_id=st.school_id AND ss.stop_id=st.stop_id
    JOIN students s ON s.id=st.student_id AND s.school_id=st.school_id AND s.deleted_at IS NULL
    WHERE st.school_id=${trip.school_id} AND st.route_id=${trip.route_id} AND st.is_active=true
      AND ${trip.trip_date || transportDate()}::date BETWEEN ay.start_date AND ay.end_date
    ON CONFLICT DO NOTHING`;
  return stops;
}
export async function tripStops(trip, db = sql) {
  return db`SELECT s.*,s.stop_id AS id,s.stop_id,s.snapshot_name AS name,s.snapshot_name AS stop_name,
    s.snapshot_latitude AS latitude,s.snapshot_longitude AS longitude,s.stop_order AS exec_order,
    s.arrival_time AS reached_at,
    (SELECT count(*)::int FROM transport_trip_roster rr WHERE rr.trip_id=s.trip_id AND rr.school_id=s.school_id AND rr.stop_id=s.stop_id) AS assigned_students
    FROM trip_stop_status s WHERE s.trip_id=${trip.id} AND s.school_id=${trip.school_id} ORDER BY s.stop_order`;
}
export async function startTransportTrip(req, input, db = sql) {
  return withTransportTransaction(db, async tx => {
    const driverId = await requireDriver(req.schoolId, req.user, tx);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`transport-driver:${req.schoolId}:${driverId}`},0))`;
    if (input.request_id) {
      const [retry] = await tx`SELECT * FROM trips WHERE school_id=${req.schoolId} AND driver_id=${driverId}
        AND start_request_id=${input.request_id}`;
      if (retry) {
        if (retry.route_id !== input.route_id || input.bus_id && retry.bus_id !== input.bus_id || input.trip_direction && normalizeLeg(retry.trip_direction) !== normalizeLeg(input.trip_direction)) throw transportError(409, 'REQUEST_ID_REUSED', 'Request ID belongs to another trip selection');
        return retry;
      }
    }
    const [route] = await tx`SELECT * FROM transport_routes WHERE id=${input.route_id} AND school_id=${req.schoolId}
      AND deleted_at IS NULL AND is_active=true FOR SHARE`;
    if (!route || !route.bus_id || input.bus_id && input.bus_id !== route.bus_id) {
      throw transportError(400, 'INVALID_ASSIGNMENT', 'Route has no matching active bus');
    }
    const [bus] = await tx`SELECT * FROM buses WHERE id=${route.bus_id} AND school_id=${req.schoolId}
      AND driver_id=${driverId} AND is_active=true AND deleted_at IS NULL FOR UPDATE`;
    if (!bus) throw transportError(403, 'BUS_FORBIDDEN', 'Bus is not assigned to you');
    if (route.direction === 'both' && !input.trip_direction) throw transportError(400, 'LEG_REQUIRED', 'Choose morning or evening');
    const leg = transportLeg(route.direction, input.trip_direction);
    const [active] = await tx`SELECT * FROM trips WHERE school_id=${req.schoolId}
      AND (bus_id=${bus.id} OR driver_id=${driverId}) AND status IN ('active','in_progress') FOR UPDATE`;
    if (active) {
      if (active.driver_id !== driverId || active.bus_id !== bus.id || active.route_id !== route.id || normalizeLeg(active.trip_direction) !== leg) {
        throw transportError(409, 'LIVE_TRIP_EXISTS', 'Finish the current trip before starting another');
      }
      return active;
    }
    const [scheduled] = await tx`SELECT * FROM trips WHERE school_id=${req.schoolId} AND route_id=${route.id}
      AND driver_id=${driverId} AND trip_date=${transportDate()} AND trip_direction=${leg} AND status='scheduled'
      ORDER BY created_at LIMIT 1 FOR UPDATE`;
    const [cal] = await tx`SELECT is_calibrated FROM route_leg_calibration WHERE school_id=${req.schoolId}
      AND route_id=${route.id} AND trip_direction=${leg}`;
    let trip;
    if (scheduled) {
      [trip] = await tx`UPDATE trips SET status='in_progress',started_at=now(),bus_id=${bus.id},route_revision=${route.revision},
        auto_stops_enabled=${Boolean(cal?.is_calibrated)}, start_request_id=${input.request_id || null}
        WHERE id=${scheduled.id} AND school_id=${req.schoolId} RETURNING *`;
    } else {
      [trip] = await tx`INSERT INTO trips(school_id,bus_id,route_id,driver_id,status,started_at,trip_date,trip_direction,
        route_revision,auto_stops_enabled,start_request_id)
        VALUES(${req.schoolId},${bus.id},${route.id},${driverId},'in_progress',now(),${transportDate()},${leg},
          ${route.revision},${Boolean(cal?.is_calibrated)},${input.request_id || null}) RETURNING *`;
    }
    await snapshotTrip(trip, tx);
    await enqueueStopNotification(trip, null, 'TRANSPORT_TRIP_STARTED', {
      stopName: route.name
    }, tx);
    return trip;
  });
}
export async function transitionTransportStop(req, tripId, stopId, action, body = {}, db = sql) {
  return withTransportTransaction(db, async tx => {
    const trip = await authorizeTrip(req, tripId, tx, {
      write: true,
      lock: true
    });
    if (!isLiveTrip(trip.status)) throw transportError(409, 'TRIP_ENDED', 'Trip has ended');
    if (body.source === 'geofence') throw transportError(409, 'SERVER_AUTOMATION', 'Automatic stops are evaluated by the server');
    const [stop] = await tx`SELECT * FROM trip_stop_status WHERE trip_id=${trip.id} AND stop_id=${stopId} AND school_id=${req.schoolId} FOR UPDATE`;
    if (!stop) throw transportError(404, 'STOP_NOT_FOUND', 'Stop is not in this trip');
    const target = action === 'arrive' ? 'arrived' : action === 'skip' ? 'skipped' : 'completed';
    if (stop.status === target || action === 'arrive' && stop.status === 'completed') return stop;
    if (['completed', 'skipped'].includes(stop.status) || action === 'complete' && stop.status !== 'arrived') {
      throw transportError(409, 'STOP_CONFLICT', `Stop is ${stop.status}`);
    }
    const [earlier] = await tx`SELECT id FROM trip_stop_status WHERE trip_id=${trip.id} AND school_id=${req.schoolId}
      AND stop_order<${stop.stop_order} AND status NOT IN ('completed','skipped') LIMIT 1`;
    if (earlier) throw transportError(409, 'STOP_ORDER', 'Complete or explicitly skip the earlier stops first');
    const [updated] = await tx`UPDATE trip_stop_status SET status=${target},
      arrival_time=CASE WHEN ${target}<>'skipped' THEN COALESCE(arrival_time,now()) ELSE arrival_time END,
      arrival_source=CASE WHEN arrival_time IS NULL AND ${target}<>'skipped' THEN 'manual' ELSE arrival_source END,
      departure_time=CASE WHEN ${target} IN ('completed','skipped') THEN now() ELSE departure_time END
      WHERE id=${stop.id} AND school_id=${req.schoolId} AND status=${stop.status} RETURNING *`;
    if (stop.status === 'pending' && target !== 'skipped') await recordArrivalCalibration({
      schoolId: req.schoolId,
      tripId: trip.id,
      routeId: trip.route_id,
      tripDirection: trip.trip_direction,
      stopId,
      stopOrder: stop.stop_order,
      arrivalTime: updated.arrival_time,
      source: 'manual',
      latitude: body.latitude,
      longitude: body.longitude,
      accuracy: body.accuracy,
      recorded_at: body.recorded_at,
      isMocked: body.is_mocked === true
    }, tx);
    await enqueueTransitionNotifications(trip, updated, tx);
    await tx`INSERT INTO transport_audit_events(school_id,trip_id,actor_id,event_type,details)
      VALUES(${req.schoolId},${trip.id},${req.user.internal_id || req.user.id},'stop_transition',
        ${tx.json({
      stop_id: stopId,
      from: stop.status,
      to: target,
      reason: body.reason || 'driver_confirmation'
    })})`;
    return updated;
  });
}
export async function enqueueTransitionNotifications(trip, stop, db = sql) {
  if (stop.status === 'arrived') await enqueueStopNotification(trip, stop.stop_id, 'BUS_STOP_REACHED', {
    stopName: stop.snapshot_name || 'stop'
  }, db);
  if (stop.status === 'completed' && normalizeLeg(trip.trip_direction) === 'morning') {
    // Departure describes the vehicle only. Confirmed boarding is sent by the attendance workflow.
    await enqueueStopNotification(trip, stop.stop_id, 'TRANSPORT_BUS_DEPARTED', {
      stopName: stop.snapshot_name || 'stop',
      studentName: 'Your child',
      boardingStatus: '— check the attendance record for boarding confirmation',
      boardingStatus_te: 'బస్సు హాజరు వివరాలను చూడండి'
    }, db);
  }
  if (['arrived', 'completed', 'skipped'].includes(stop.status)) {
    const [next] = await db`SELECT * FROM trip_stop_status WHERE trip_id=${trip.id} AND school_id=${trip.school_id}
      AND stop_order>${stop.stop_order} AND status='pending' ORDER BY stop_order LIMIT 1`;
    if (next) await enqueueStopNotification(trip, next.stop_id, 'TRANSPORT_BUS_APPROACHING', {
      stopName: next.snapshot_name || 'stop'
    }, db);
  }
}
export async function finishTransportTrip(req, tripId, reason = 'driver_completed', db = sql) {
  return withTransportTransaction(db, async tx => {
    const trip = await authorizeTrip(req, tripId, tx, {
      write: true,
      lock: true
    });
    if (!isLiveTrip(trip.status)) return trip;
    await tx`UPDATE trip_stop_status SET status=CASE WHEN status='arrived' THEN 'completed' ELSE 'skipped' END,
      departure_time=COALESCE(departure_time,now()) WHERE trip_id=${trip.id} AND school_id=${req.schoolId}
      AND status IN ('pending','arrived')`;
    const [ended] = await tx`UPDATE trips SET status='completed',ended_at=now(),close_reason=${reason}
      WHERE id=${trip.id} AND school_id=${req.schoolId} RETURNING *`;
    const calibration = await finalizeTripCalibration(req.schoolId, trip.id, tx);
    await enqueueStopNotification(ended, null, 'BUS_TRIP_COMPLETED', {
      routeName: 'your route'
    }, tx);
    return {
      ...ended,
      calibration
    };
  });
}
