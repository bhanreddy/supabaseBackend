import express from 'express';
import sql from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { authorizeBusRead, authorizeTrip, requireDriver, transportError, isLiveTrip } from '../services/transportAccessService.js';
import { startTransportTrip, finishTransportTrip, transitionTransportStop, tripStops, effectiveRouteStops, transportDate, transportLeg } from '../services/transportTripService.js';
import { ingestLocationBatch } from '../services/transportLocationIngestService.js';
import { getLegCalibrationStatus } from '../services/transportCalibrationService.js';
import { enqueueStopNotification, wakeTransportOutbox } from '../services/transportOutboxService.js';
const router = express.Router();
router.use(requireAuth);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const checkId = value => {
  if (!uuid(value)) throw transportError(400, 'INVALID_ID', 'Valid resource ID required');
  return value;
};
const reply = (res, req, data) => {
  wakeTransportOutbox();
  return sendSuccess(res, req.schoolId, data);
};
router.post('/trips/start', asyncHandler(async (req, res) => {
  checkId(req.body?.route_id);
  if (req.body.request_id && (typeof req.body.request_id !== 'string' || req.body.request_id.length > 160)) throw transportError(400, 'INVALID_REQUEST_ID', 'Invalid request ID');
  const trip = await startTransportTrip(req, req.body);
  return reply(res, req, {
    trip,
    stops: await tripStops(trip),
    calibration: await getLegCalibrationStatus(req.schoolId, trip.route_id, trip.trip_direction)
  });
}));
router.get('/driver/my-trip', asyncHandler(async (req, res) => {
  const driverId = await requireDriver(req.schoolId, req.user);
  const routes = await sql`SELECT r.id AS route_id,r.name AS route_name,r.direction,r.bus_id FROM transport_routes r
    JOIN buses b ON b.id=r.bus_id AND b.school_id=r.school_id WHERE r.school_id=${req.schoolId} AND b.driver_id=${driverId}
    AND b.deleted_at IS NULL AND b.is_active=true AND r.deleted_at IS NULL AND r.is_active=true ORDER BY r.name`;
  if (!routes.length) return sendSuccess(res, req.schoolId, {
    trip: null,
    stops: [],
    available_routes: []
  });
  const [active] = await sql`SELECT * FROM trips WHERE school_id=${req.schoolId} AND driver_id=${driverId}
    AND status IN ('active','in_progress') ORDER BY started_at DESC LIMIT 1`;
  const route = routes.find(r => r.route_id === (active?.route_id || req.query.route_id)) || (!req.query.route_id ? routes[0] : null);
  if (!route) throw transportError(403, 'ROUTE_FORBIDDEN', 'Route not assigned to you');
  const leg = transportLeg(route.direction, req.query.trip_direction);
  const [existing] = active ? [active] : await sql`SELECT * FROM trips WHERE school_id=${req.schoolId} AND driver_id=${driverId}
    AND route_id=${route.route_id} AND trip_date=${transportDate()} AND trip_direction=${leg}
    ORDER BY created_at DESC LIMIT 1`;
  const trip = existing || {
    id: route.route_id,
    route_id: route.route_id,
    bus_id: route.bus_id,
    status: 'scheduled',
    trip_direction: leg,
    virtual: true
  };
  const stops = existing ? await tripStops(existing) : (await effectiveRouteStops(req.schoolId, route.route_id, leg)).map(s => ({
    ...s,
    stop_id: s.id,
    stop_name: s.name,
    status: 'pending',
    assigned_students: 0
  }));
  return sendSuccess(res, req.schoolId, {
    trip: {
      ...trip,
      raw_status: trip.status,
      status: isLiveTrip(trip.status) ? 'in_progress' : trip.status,
      route_name: route.route_name,
      direction: route.direction,
      completed_at: trip.ended_at
    },
    stops,
    available_routes: routes,
    is_reverse: trip.trip_direction === 'evening'
  });
}));
router.post('/driver/trip/:tripId/start', asyncHandler(async (req, res) => {
  const id = checkId(req.params.tripId);
  const [existing] = await sql`SELECT route_id,trip_direction FROM trips WHERE id=${id} AND school_id=${req.schoolId}`;
  const trip = await startTransportTrip(req, {
    ...req.body,
    route_id: existing?.route_id || id,
    trip_direction: req.body?.trip_direction || existing?.trip_direction
  });
  return reply(res, req, trip);
}));
router.get('/trips/:tripId/status', asyncHandler(async (req, res) => {
  const trip = await authorizeTrip(req, checkId(req.params.tripId));
  return sendSuccess(res, req.schoolId, {
    trip,
    stops: await tripStops(trip),
    calibration: await getLegCalibrationStatus(req.schoolId, trip.route_id, trip.trip_direction)
  });
}));
for (const action of ['arrive', 'complete', 'skip']) router.post(`/trips/:tripId/stops/:stopId/${action}`, asyncHandler(async (req, res) => {
  const stop = await transitionTransportStop(req, checkId(req.params.tripId), checkId(req.params.stopId), action, req.body);
  return reply(res, req, {
    stop,
    message: 'Stop updated'
  });
}));
router.post('/driver/trip/:tripId/stop/:stopId/reach', asyncHandler(async (req, res) => {
  const stop = await transitionTransportStop(req, checkId(req.params.tripId), checkId(req.params.stopId), 'arrive', req.body);
  return reply(res, req, {
    stop,
    message: 'Arrival confirmed'
  });
}));
for (const path of ['/trips/:tripId/end', '/driver/trip/:tripId/complete']) router.post(path, asyncHandler(async (req, res) => {
  const trip = await finishTransportTrip(req, checkId(req.params.tripId));
  return reply(res, req, {
    trip,
    calibration: trip.calibration,
    message: 'Trip completed'
  });
}));
router.post('/trips/:tripId/tracking-session', asyncHandler(async (req, res) => {
  const device = req.get('X-Device-Id');
  if (!device || device.length > 200) throw transportError(400, 'DEVICE_REQUIRED', 'Device identity required');
  const trip = await sql.begin(async tx => {
    const t = await authorizeTrip(req, checkId(req.params.tripId), tx, {
      write: true,
      lock: true
    });
    const driver = await requireDriver(req.schoolId, req.user, tx);
    if (t.driver_id !== driver || !isLiveTrip(t.status)) throw transportError(409, 'TRIP_ENDED', 'No active trip assigned to this driver');
    if (t.tracking_device_id && t.tracking_device_id !== device) throw transportError(409, 'DEVICE_CONFLICT', 'Another device owns this trip. End the trip before changing devices.');
    const [updated] = await tx`UPDATE trips SET tracking_device_id=${device} WHERE id=${t.id} AND school_id=${req.schoolId} RETURNING *`;
    return updated;
  });
  return sendSuccess(res, req.schoolId, {
    trip_id: trip.id,
    session_id: trip.tracking_session_id,
    bus_id: trip.bus_id,
    device_id: device
  });
}));
for (const path of ['/buses/:id/locations/batch', '/buses/:id/location']) router.post(path, asyncHandler(async (req, res) => {
  const driverId = await requireDriver(req.schoolId, req.user);
  const input = req.body || {};
  if (!input.trip_id || !input.session_id) throw transportError(409, 'TRACKING_SESSION_REQUIRED', 'Update the driver app and start or resume tracking before uploading locations');
  checkId(input.trip_id);
  checkId(input.session_id);
  if (input.fixes !== undefined && !Array.isArray(input.fixes)) throw transportError(400, 'INVALID_BATCH', 'fixes must be an array');
  const result = await ingestLocationBatch({
    schoolId: req.schoolId,
    busId: checkId(req.params.id),
    driverId,
    tripId: input.trip_id,
    sessionId: input.session_id,
    deviceId: req.get('X-Device-Id'),
    fixes: input.fixes || [input]
  });
  return reply(res, req, {
    accepted: result.fixes.length,
    inserted: result.insertedCount,
    acknowledgements: result.acknowledgements,
    rejected_invalid: result.invalidCount,
    rejected_stale: result.staleCount,
    realtime_updated: result.realtimeUpdated,
    location: result.location
  });
}));
router.get('/buses/:id/location', asyncHandler(async (req, res) => {
  await authorizeBusRead(req, checkId(req.params.id));
  const [location] = await sql`SELECT l.* FROM bus_locations l JOIN trips t ON t.id=l.trip_id AND t.school_id=l.school_id
    WHERE l.bus_id=${req.params.id} AND l.school_id=${req.schoolId} AND t.status IN ('active','in_progress')`;
  return sendSuccess(res, req.schoolId, location || null);
}));
router.post('/buses/:id/heartbeat', asyncHandler(async (req, res) => {
  const driver = await requireDriver(req.schoolId, req.user);
  const [trip] = await sql`SELECT t.id FROM trips t JOIN buses b ON b.id=t.bus_id AND b.school_id=t.school_id
    WHERE t.school_id=${req.schoolId} AND t.bus_id=${checkId(req.params.id)} AND t.driver_id=${driver}
    AND b.driver_id=${driver} AND t.status IN ('active','in_progress') AND t.tracking_device_id=${req.get('X-Device-Id') || null}`;
  if (!trip) throw transportError(409, 'TRACKING_SESSION_REQUIRED', 'Active tracking session required');
  await sql`INSERT INTO driver_heartbeat(school_id,driver_id,last_ping,status) VALUES(${req.schoolId},${driver},now(),'online')
    ON CONFLICT(school_id,driver_id) DO UPDATE SET last_ping=now(),status='online' WHERE driver_heartbeat.school_id=${req.schoolId}`;
  return sendSuccess(res, req.schoolId, {
    status: 'heartbeat_acknowledged'
  });
}));
router.get('/driver/bus-attendance/stop/:stopId/students', asyncHandler(async (req, res) => {
  const trip = await authorizeTrip(req, checkId(req.query.trip_id));
  const rows = await sql`SELECT s.id AS student_id,s.admission_no,p.display_name AS student_name,p.photo_url,
    ba.id AS attendance_id,ba.status AS attendance_status,ba.marked_at
    FROM transport_trip_roster rr JOIN students s ON s.id=rr.student_id AND s.school_id=rr.school_id
    JOIN persons p ON p.id=s.person_id LEFT JOIN bus_stop_attendance ba ON ba.trip_id=rr.trip_id AND ba.stop_id=rr.stop_id
    AND ba.student_id=rr.student_id AND ba.school_id=rr.school_id
    WHERE rr.school_id=${req.schoolId} AND rr.trip_id=${trip.id} AND rr.stop_id=${checkId(req.params.stopId)} ORDER BY p.display_name`;
  return sendSuccess(res, req.schoolId, rows);
}));
router.post('/driver/bus-attendance/mark', asyncHandler(async (req, res) => {
  const {
    trip_id,
    stop_id,
    route_id,
    date,
    attendance
  } = req.body || {};
  checkId(trip_id);
  checkId(stop_id);
  if (!Array.isArray(attendance) || !attendance.length || attendance.length > 200 || new Set(attendance.map(r => r.student_id)).size !== attendance.length || attendance.some(r => !uuid(r.student_id) || !['present', 'absent'].includes(r.status))) throw transportError(400, 'INVALID_ATTENDANCE', 'Provide unique students with present or absent status');
  const records = await sql.begin(async tx => {
    const trip = await authorizeTrip(req, trip_id, tx, {
      write: true,
      lock: true
    });
    if (!isLiveTrip(trip.status) || route_id !== trip.route_id || date && date !== transportDate(new Date(trip.trip_date))) throw transportError(409, 'ATTENDANCE_CONTEXT', 'Attendance must match the active trip, route and date');
    const roster = await tx`SELECT student_id FROM transport_trip_roster WHERE school_id=${req.schoolId} AND trip_id=${trip.id} AND stop_id=${stop_id}`;
    if (attendance.some(r => !roster.some(s => s.student_id === r.student_id))) throw transportError(403, 'STUDENT_NOT_ASSIGNED', 'Student is not assigned to this trip stop');
    const saved = [];
    for (const row of attendance) {
      const [record] = await tx`INSERT INTO bus_stop_attendance(school_id,trip_id,stop_id,route_id,driver_id,student_id,attendance_date,status,marked_at)
        VALUES(${req.schoolId},${trip.id},${stop_id},${trip.route_id},${trip.driver_id},${row.student_id},${trip.trip_date},${row.status},now())
        ON CONFLICT(school_id,trip_id,stop_id,student_id,attendance_date) DO UPDATE SET status=EXCLUDED.status,marked_at=now(),updated_at=now()
        WHERE bus_stop_attendance.status IS DISTINCT FROM EXCLUDED.status RETURNING *`;
      if (record) {
        saved.push(record);
        await enqueueStopNotification(trip, stop_id, row.status === 'present' ? 'STUDENT_BUS_PRESENT' : 'STUDENT_BUS_ABSENT', {
          studentName: 'Your child',
          stopName: 'your stop'
        }, tx, {
          studentIds: [row.student_id],
          keySuffix: `attendance:${record.id}:${new Date(record.marked_at).toISOString()}`
        });
      }
    }
    return saved;
  });
  return reply(res, req, {
    message: 'Attendance saved',
    count: records.length,
    records
  });
}));
router.get('/driver/bus-attendance/summary', asyncHandler(async (req, res) => {
  const trip = await authorizeTrip(req, checkId(req.query.trip_id));
  const rows = await sql`SELECT ss.stop_id,ss.snapshot_name AS stop_name,
    count(ba.id) FILTER(WHERE ba.status='present') AS present_count,count(ba.id) FILTER(WHERE ba.status='absent') AS absent_count,
    (SELECT count(*) FROM transport_trip_roster rr WHERE rr.school_id=ss.school_id AND rr.trip_id=ss.trip_id AND rr.stop_id=ss.stop_id) AS total_assigned
    FROM trip_stop_status ss LEFT JOIN bus_stop_attendance ba ON ba.school_id=ss.school_id AND ba.trip_id=ss.trip_id AND ba.stop_id=ss.stop_id
    WHERE ss.school_id=${req.schoolId} AND ss.trip_id=${trip.id} GROUP BY ss.id ORDER BY ss.stop_order`;
  return sendSuccess(res, req.schoolId, rows);
}));
router.use((error, req, res, next) => {
  if (error.transportCode) return res.status(error.status || 400).json({
    success: false,
    error: error.message,
    code: error.transportCode
  });
  if (error instanceof RangeError) return res.status(400).json({
    success: false,
    error: error.message
  });
  return next(error);
});
export default router;
