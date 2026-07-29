import express from 'express';
import sql from '../db.js';
import { requirePermission, requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { translateFields } from '../services/geminiTranslator.js';
import {
  notifyTransportParentsAtStop,
  sendNotificationToUsers,
  sendTransportNotification,
  getTransportStudentIdsAtStop,
} from '../services/notificationService.js';
import { resolveStudentId } from '../utils/studentPortal.js';
import {
  recordArrivalCalibration,
  finalizeTripCalibration,
  getLegCalibrationStatus,
} from '../services/transportCalibrationService.js';
import { evaluateGeofence } from '../services/transportGeofenceService.js';
import { normalizeLeg } from '../services/transportCalibrationService.js';
import { computeLearnedEta, segKey } from '../services/transportEtaService.js';
import {
  evaluateRunningLate,
  notifyBoardingStopDeparted,
} from '../services/transportProactiveNotificationService.js';
import {
  ingestLocationBatch,
  runNewestFixEffects,
} from '../services/transportLocationIngestService.js';
import {
  getRouteCalibrationReview,
  parseCalibrationLeg,
  resetRouteCalibration,
  updateStopGeoOverride,
} from '../services/transportCalibrationAdminService.js';
import logger from '../utils/logger.js';
import { validateRequest, transportSchemas } from '../middleware/validateRequest.js';

const router = express.Router();

// The global tenant middleware has already derived req.schoolId from the JWT.
// Remove client tenant selectors before any handler/service sees the payload.
router.use((req, _res, next) => {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    delete req.body.school_id;
    delete req.body.schoolId;
  }
  if (req.query && typeof req.query === 'object') {
    delete req.query.school_id;
    delete req.query.schoolId;
  }
  next();
});

// ============================================================
// HELPERS
// ============================================================

/**
 * Haversine distance in km between two lat/lon points
 */
const calculateDistanceKm = (lat1, lon1, lat2, lon2) => {
  const toRad = (deg) => deg * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
  Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};

/** Notify a stop's parents when the bus is within this straight-line distance. */
const APPROACH_RADIUS_KM = 0.8;
/** A GPS fix older than this is presented as stale to tracking clients. */
const LOCATION_FRESH_SECONDS = 120;

/** Calendar grouping is a school operation, not the server's UTC date. */
const kolkataDate = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

/**
 * Resolve staff_id from authenticated user
 */
const getStaffId = async (user) => {
  const uid = user?.internal_id ?? user?.id;
  const [staff] = await sql`
    SELECT s.id FROM staff s
    JOIN users u ON s.person_id = u.person_id
    WHERE u.id = ${uid}
  `;
  return staff?.id || null;
};

/** Maps DB trip.status to UI labels used by newer clients. */
const mapTripUiStatus = (status) => {
  if (status === 'scheduled') return 'scheduled';
  if (status === 'active' || status === 'in_progress') return 'in_progress';
  if (status === 'completed') return 'completed';
  return status ?? 'scheduled';
};

/** True if trip is ongoing (canonical `in_progress` or legacy `active`). */
const tripStatusIsLive = (s) => s === 'active' || s === 'in_progress';

const REVERSE_TRIP_DIRECTIONS = new Set(['afternoon', 'evening']);

/** Evening/afternoon trips visit stops in reverse of admin stop_order. */
const isReverseTripDirection = (tripDirection) => REVERSE_TRIP_DIRECTIONS.has(tripDirection);

/**
 * Resolve the leg direction for a trip.
 * Routes marked `both` require an explicit morning/evening choice at start time.
 */
const resolveTripDirection = (routeDirection, requestedDirection) => {
  if (routeDirection === 'both') {
    const d = requestedDirection || 'morning';
    if (d === 'afternoon' || d === 'evening' || d === 'morning') return d;
    return 'morning';
  }
  if (routeDirection === 'afternoon' || routeDirection === 'evening') return routeDirection;
  return routeDirection || 'morning';
};

/** Default leg for `both` routes when driver has not chosen yet (time-of-day hint). */
const inferDefaultTripDirection = (routeDirection) => {
  if (routeDirection !== 'both') return resolveTripDirection(routeDirection);
  const hour = new Date().getHours();
  return hour >= 12 ? 'evening' : 'morning';
};

/**
 * Load route stops in driver execution order.
 * trip_stop_status.stop_order stores exec_order (1 = first stop to visit).
 */
const getRouteStopExecutionSequence = async (schoolId, routeId, tripDirection) => {
  const stops = await sql`
    SELECT id, stop_order, name
    FROM transport_stops
    WHERE route_id = ${routeId}
      AND school_id = ${schoolId}
      AND deleted_at IS NULL
    ORDER BY stop_order ASC
  `;
  const ordered = isReverseTripDirection(tripDirection) ? [...stops].reverse() : stops;
  return ordered.map((stop, index) => ({
    ...stop,
    exec_order: index + 1,
  }));
};

const seedTripStopStatuses = async (schoolId, tripId, routeId, tripDirection) => {
  const sequence = await getRouteStopExecutionSequence(schoolId, routeId, tripDirection);
  if (sequence.length === 0) return sequence;

  await sql`
    INSERT INTO trip_stop_status (school_id, trip_id, stop_id, stop_order, status)
    SELECT ${schoolId}, ${tripId}, s.id, s.exec_order, 'pending'
    FROM unnest(
      ${sql.array(sequence.map((s) => s.id))}::uuid[],
      ${sql.array(sequence.map((s) => s.exec_order))}::int[]
    ) AS s(id, exec_order)
    ON CONFLICT (school_id, trip_id, stop_id) DO NOTHING
  `;

  return sequence;
};

/**
 * GPS-proximity "bus approaching" push. Runs off the location-ingest path
 * (fire-and-forget): when the bus is within APPROACH_RADIUS_KM of the next
 * pending stop, notify that stop's parents. approach_notified_at is claimed
 * atomically so the driver-checkpoint notify path can't double-send.
 */
const notifyApproachingStop = async (schoolId, busId, latitude, longitude, db = sql) => {
  try {
    const [trip] = await db`
      SELECT t.id, t.route_id FROM trips t
      JOIN route_leg_calibration cal
        ON cal.school_id = ${schoolId}
       AND cal.route_id = t.route_id
       AND cal.trip_direction = CASE
         WHEN t.trip_direction IN ('afternoon', 'evening') THEN 'evening'
         ELSE 'morning'
       END
       AND cal.is_calibrated = true
      WHERE t.bus_id = ${busId}
        AND t.school_id = ${schoolId}
        AND t.status IN ('active', 'in_progress')
      ORDER BY t.created_at DESC
      LIMIT 1
    `;
    if (!trip) return;

    const [nextStop] = await db`
      SELECT tss.id, tss.stop_id, ts.name, ts.latitude, ts.longitude
      FROM trip_stop_status tss
      JOIN transport_stops ts ON ts.id = tss.stop_id AND ts.school_id = ${schoolId}
      WHERE tss.trip_id = ${trip.id}
        AND tss.school_id = ${schoolId}
        AND tss.status = 'pending'
      ORDER BY tss.stop_order ASC
      LIMIT 1
    `;
    if (!nextStop || nextStop.latitude == null || nextStop.longitude == null) return;

    const distKm = calculateDistanceKm(
      Number(latitude), Number(longitude),
      Number(nextStop.latitude), Number(nextStop.longitude),
    );
    if (distKm > APPROACH_RADIUS_KM) return;

    const [claimed] = await db`
      UPDATE trip_stop_status SET approach_notified_at = NOW()
      WHERE id = ${nextStop.id}
        AND school_id = ${schoolId}
        AND approach_notified_at IS NULL
      RETURNING id
    `;
    if (!claimed) return;

    const studentIds = await getTransportStudentIdsAtStop(schoolId, trip.route_id, nextStop.stop_id, db);
    await sendTransportNotification(
      studentIds,
      'TRANSPORT_BUS_APPROACHING',
      { stopName: nextStop.name },
      schoolId,
      db,
    );
  } catch (err) {
    logger.error({ err, event: 'transport_approach_notification_failed', schoolId, busId }, 'Transport approach notification failed');
  }
};

/** All buses assigned to a driver (same driver may operate multiple buses). */
const getDriverBuses = async (schoolId, staffId) => sql`
  SELECT id, bus_no, registration_no, capacity
  FROM buses
  WHERE driver_id = ${staffId}
    AND is_active = true
    AND deleted_at IS NULL
    AND school_id = ${schoolId}
  ORDER BY bus_no
`;

/** GPS writes are driver-only and must target a bus assigned to that driver. */
const getOwnedDriverBus = async (schoolId, user, busId) => {
  if (!user?.roles?.includes('driver')) return null;
  const staffId = await getStaffId(user);
  if (!staffId) return null;
  const [bus] = await sql`
    SELECT id, driver_id
    FROM buses
    WHERE id = ${busId}
      AND school_id = ${schoolId}
      AND driver_id = ${staffId}
      AND is_active = true
      AND deleted_at IS NULL
  `;
  return bus || null;
};

const driverOwnsRoute = async (schoolId, user, routeId) => {
  if (!user?.roles?.includes('driver')) return false;
  const staffId = await getStaffId(user);
  if (!staffId) return false;
  const [route] = await sql`
    SELECT r.id
    FROM transport_routes r
    JOIN buses b ON b.id = r.bus_id
    WHERE r.id = ${routeId}
      AND r.school_id = ${schoolId}
      AND r.deleted_at IS NULL
      AND b.school_id = ${schoolId}
      AND b.driver_id = ${staffId}
      AND b.is_active = true
      AND b.deleted_at IS NULL
  `;
  return Boolean(route);
};

const validCoordinate = (value, low, high) =>
  Number.isFinite(Number(value)) && Number(value) >= low && Number(value) <= high;

// ============================================================
// ROUTES CRUD (Admin)
// ============================================================

/**
 * GET /transport/routes
 * List all transport routes
 */
router.get('/routes', requirePermission('transport.view'), asyncHandler(async (req, res) => {
  const { active_only } = req.query;

  const routes = await sql`
    SELECT
      r.id, r.name, r.name_te, r.code, r.description, r.start_point, r.end_point,
      r.total_stops, r.monthly_fee, r.is_active, r.direction, r.bus_id,
      b.bus_no,
      COUNT(DISTINCT ts.id) AS stop_count,
      COUNT(DISTINCT st.id) AS student_count,
      MAX(dp.display_name) AS route_driver_name,
      MAX(dra.driver_id::text) AS route_driver_id
    FROM transport_routes r
    LEFT JOIN buses b ON r.bus_id = b.id
    LEFT JOIN transport_stops ts ON ts.route_id = r.id AND ts.deleted_at IS NULL
    LEFT JOIN student_transport st ON st.route_id = r.id AND st.is_active = true
    LEFT JOIN driver_route_assignments dra ON dra.route_id = r.id
      AND dra.school_id = ${req.schoolId}
      AND dra.is_active = TRUE
      AND dra.deleted_at IS NULL
    LEFT JOIN staff drv ON drv.id = dra.driver_id AND drv.school_id = ${req.schoolId}
    LEFT JOIN persons dp ON dp.id = drv.person_id
    WHERE r.school_id = ${req.schoolId}
      AND r.deleted_at IS NULL
      ${active_only === 'true' ? sql`AND r.is_active = true` : sql``}
    GROUP BY r.id, b.bus_no
    ORDER BY r.name
  `;

  return sendSuccess(res, req.schoolId, routes);
}));

/**
 * POST /transport/routes
 * Create a transport route
 */
router.post('/routes', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { name, name_te, code, description, description_te, start_point, start_point_te, end_point, end_point_te, monthly_fee, direction, bus_id } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Route name is required' });
  }

  // Auto-translate name if name_te not provided
  let finalNameTe = name_te ?? null;
  if (!finalNameTe && name) {
    try { const te = await translateFields({ name }); finalNameTe = te.name || null; } catch (e) {}
  }

  // T1 FIX: Corrected VALUES — school_id now gets req.schoolId instead of name
  const [route] = await sql`
    INSERT INTO transport_routes (school_id, name, name_te, code, description, start_point, end_point, monthly_fee, direction, bus_id)
    VALUES (${req.schoolId}, ${name}, ${finalNameTe}, ${code || null}, ${description || null}, ${start_point || null}, ${end_point || null}, ${monthly_fee || null}, ${direction || 'morning'}, ${bus_id || null})
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Route created', route }, 201);
}));

/**
 * GET /transport/routes/:id
 * Get route with stops + assigned bus + students per stop
 */
router.get('/routes/:id', requirePermission('transport.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  // T2 FIX: Add school_id filter
  const [route] = await sql`
    SELECT id, school_id, name, code, description, start_point, end_point, total_stops, monthly_fee,
      direction, bus_id, is_active, created_at, updated_at
    FROM transport_routes
    WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!route) {
    return res.status(404).json({ error: 'Route not found' });
  }

  const stops = await sql`
    SELECT
      ts.id, ts.name, ts.name_te, ts.latitude, ts.longitude, ts.pickup_time, ts.drop_time, ts.stop_order,
      COALESCE(json_agg(
        json_build_object('student_id', st.student_id, 'student_name', p.display_name)
      ) FILTER (WHERE st.id IS NOT NULL), '[]') as students
    FROM transport_stops ts
    LEFT JOIN student_transport st ON st.stop_id = ts.id AND st.is_active = true
    LEFT JOIN students s ON st.student_id = s.id
    LEFT JOIN persons p ON s.person_id = p.id
    WHERE ts.route_id = ${id} AND ts.deleted_at IS NULL
    GROUP BY ts.id
    ORDER BY ts.stop_order
  `;

  // Get assigned bus info
  let bus = null;
  if (route.bus_id) {
    const [b] = await sql`
      SELECT b.id, b.bus_no, b.registration_no, b.capacity, b.driver_id,
        p.display_name as driver_name
      FROM buses b
      LEFT JOIN staff s ON b.driver_id = s.id
      LEFT JOIN persons p ON s.person_id = p.id
      WHERE b.id = ${route.bus_id} AND b.school_id = ${req.schoolId}
    `;
    bus = b;
  }

  const [activeDriver] = await sql`
    SELECT dra.driver_id, p.display_name as driver_name, p.photo_url
    FROM driver_route_assignments dra
    JOIN staff s ON dra.driver_id = s.id
    JOIN persons p ON s.person_id = p.id
    WHERE dra.route_id = ${id}
      AND dra.school_id = ${req.schoolId}
      AND dra.is_active = true
      AND dra.deleted_at IS NULL
    LIMIT 1
  `;

  return sendSuccess(res, req.schoolId, { ...route, stops, bus, driver: activeDriver || null });
}));

/**
 * PUT /transport/routes/:id
 * Update a route
 */
router.put('/routes/:id', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, name_te, code, description, description_te, start_point, start_point_te, end_point, end_point_te, monthly_fee, direction, bus_id, is_active } = req.body;
  const clearOrSetBus = Object.prototype.hasOwnProperty.call(req.body, 'bus_id');

  // T3 FIX: Ownership check first
  const [existing] = await sql`SELECT id FROM transport_routes WHERE id = ${id} AND school_id = ${req.schoolId}`;
  if (!existing) return res.status(404).json({ error: 'Route not found' });

  if (clearOrSetBus && bus_id) {
    const [bus] = await sql`
      SELECT id FROM buses
      WHERE id = ${bus_id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    `;
    if (!bus) return res.status(404).json({ error: 'Bus not found' });
  }

  // Auto-translate name if name_te not provided
  let finalNameTe = name_te ?? null;
  if (!finalNameTe && name) {
    try { const te = await translateFields({ name }); finalNameTe = te.name || null; } catch (e) {}
  }

  const [route] = await sql`
    UPDATE transport_routes SET
      name = COALESCE(${name ?? null}, name),
      name_te = COALESCE(${finalNameTe}, name_te),
      code = COALESCE(${code ?? null}, code),
      description = COALESCE(${description ?? null}, description),
      start_point = COALESCE(${start_point ?? null}, start_point),
      end_point = COALESCE(${end_point ?? null}, end_point),
      monthly_fee = COALESCE(${monthly_fee ?? null}, monthly_fee),
      direction = COALESCE(${direction ?? null}, direction),
      bus_id = CASE
        WHEN ${clearOrSetBus} THEN ${bus_id ?? null}
        ELSE bus_id
      END,
      is_active = COALESCE(${is_active ?? null}, is_active),
      updated_at = NOW()
    WHERE id = ${id} AND school_id = ${req.schoolId}
    RETURNING *
  `;

  if (!route) return res.status(404).json({ error: 'Route not found' });
  return sendSuccess(res, req.schoolId, { message: 'Route updated', route });
}));

/**
 * DELETE /transport/routes/:id
 * Delete a route
 */
router.delete('/routes/:id', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const [existing] = await sql`
    SELECT id FROM transport_routes
    WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!existing) return res.status(404).json({ error: 'Route not found' });

  // Soft delete the route
  await sql`
    UPDATE transport_routes
    SET deleted_at = NOW(), is_active = false, updated_at = NOW()
    WHERE id = ${id} AND school_id = ${req.schoolId}
  `;

  return sendSuccess(res, req.schoolId, { message: 'Route deleted successfully' });
}));

/**
 * GET /transport/drivers
 * Staff with driver role — for assigning drivers to routes (tenant-scoped).
 */
router.get('/drivers', requirePermission('transport.view'), asyncHandler(async (req, res) => {
  const drivers = await sql`
    SELECT st.id, p.display_name, p.photo_url,
           dra.route_id AS currently_assigned_route_id,
           rt.name AS current_route_name
    FROM staff st
    JOIN persons p ON st.person_id = p.id
    JOIN users u ON u.person_id = p.id AND u.school_id = ${req.schoolId} AND u.deleted_at IS NULL
    JOIN user_roles ur ON ur.user_id = u.id AND ur.school_id = ${req.schoolId} AND ur.deleted_at IS NULL
    JOIN roles rol ON rol.id = ur.role_id AND rol.school_id = ${req.schoolId}
    LEFT JOIN driver_route_assignments dra ON dra.driver_id = st.id
      AND dra.school_id = ${req.schoolId}
      AND dra.is_active = TRUE
      AND dra.deleted_at IS NULL
    LEFT JOIN transport_routes rt ON rt.id = dra.route_id AND rt.school_id = ${req.schoolId}
    WHERE st.school_id = ${req.schoolId}
      AND st.deleted_at IS NULL
      AND rol.code = 'driver'
    ORDER BY p.display_name
  `;
  return sendSuccess(res, req.schoolId, drivers);
}));

/**
 * GET /transport/academic-years/current
 * Active academic year for transport assignment flows (mobile convenience).
 */
router.get('/academic-years/current', requireAuth, asyncHandler(async (req, res) => {
  const [ay] = await sql`
    SELECT id, code, start_date, end_date
    FROM academic_years
    WHERE (now() AT TIME ZONE 'Asia/Kolkata')::date BETWEEN start_date AND end_date
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!ay) return res.status(404).json({ error: 'No active academic year found' });
  return sendSuccess(res, req.schoolId, ay);
}));

// ============================================================
// STOPS CRUD (Admin)
// ============================================================

/**
 * POST /transport/routes/:id/stops
 * Add stop to route (ordered)
 */
router.post('/routes/:id/stops', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, name_te, latitude, longitude, pickup_time, drop_time, stop_order } = req.body;

  if (!name || stop_order === undefined) {
    return res.status(400).json({ error: 'name and stop_order are required' });
  }

  // T6 FIX: Verify route ownership
  const [routeCheck] = await sql`SELECT id FROM transport_routes WHERE id = ${id} AND school_id = ${req.schoolId}`;
  if (!routeCheck) return res.status(404).json({ error: 'Route not found' });

  // Auto-translate stop name if name_te not provided
  let finalNameTe = name_te ?? null;
  if (!finalNameTe && name) {
    try { const te = await translateFields({ name }); finalNameTe = te.name || null; } catch (e) {}
  }

  // T6 FIX: Add school_id to transport_stops INSERT
  const [stop] = await sql`
    INSERT INTO transport_stops (school_id, route_id, name, name_te, latitude, longitude, pickup_time, drop_time, stop_order)
    VALUES (${req.schoolId}, ${id}, ${name}, ${finalNameTe}, ${latitude || null}, ${longitude || null}, ${pickup_time || null}, ${drop_time || null}, ${stop_order})
    RETURNING *
  `;

  // T6 FIX: Add school_id to transport_routes UPDATE
  await sql`UPDATE transport_routes SET total_stops = (
    SELECT COUNT(*) FROM transport_stops WHERE route_id = ${id} AND deleted_at IS NULL
  ) WHERE id = ${id} AND school_id = ${req.schoolId}`;

  return sendSuccess(res, req.schoolId, { message: 'Stop added', stop }, 201);
}));

/**
 * PUT /transport/stops/:stopId
 * Update a stop
 */
router.put('/stops/:stopId', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { stopId } = req.params;
  const { name, name_te, latitude, longitude, pickup_time, drop_time, stop_order } = req.body;

  // T7 FIX: Ownership check first
  const [existing] = await sql`SELECT id FROM transport_stops WHERE id = ${stopId} AND school_id = ${req.schoolId}`;
  if (!existing) return res.status(404).json({ error: 'Stop not found' });

  // Auto-translate stop name if name_te not provided
  let finalNameTe = name_te ?? null;
  if (!finalNameTe && name) {
    try { const te = await translateFields({ name }); finalNameTe = te.name || null; } catch (e) {}
  }

  const [stop] = await sql`
    UPDATE transport_stops SET
      name = COALESCE(${name ?? null}, name),
      name_te = COALESCE(${finalNameTe}, name_te),
      latitude = COALESCE(${latitude ?? null}, latitude),
      longitude = COALESCE(${longitude ?? null}, longitude),
      pickup_time = COALESCE(${pickup_time ?? null}, pickup_time),
      drop_time = COALESCE(${drop_time ?? null}, drop_time),
      stop_order = COALESCE(${stop_order ?? null}, stop_order)
    WHERE id = ${stopId} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    RETURNING *
  `;

  if (!stop) return res.status(404).json({ error: 'Stop not found' });
  return sendSuccess(res, req.schoolId, { message: 'Stop updated', stop });
}));

/**
 * DELETE /transport/stops/:stopId
 * Soft delete a stop
 */
router.delete('/stops/:stopId', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { stopId } = req.params;

  // T8 FIX: Add school_id filter to soft-delete
  const [stop] = await sql`
    UPDATE transport_stops SET deleted_at = now() WHERE id = ${stopId} AND school_id = ${req.schoolId} RETURNING route_id
  `;
  if (!stop) return res.status(404).json({ error: 'Stop not found' });

  // Update total_stops count
  await sql`UPDATE transport_routes SET total_stops = (
    SELECT COUNT(*) FROM transport_stops WHERE route_id = ${stop.route_id} AND deleted_at IS NULL
  ) WHERE id = ${stop.route_id} AND school_id = ${req.schoolId}`;

  return sendSuccess(res, req.schoolId, { message: 'Stop deleted' });
}));

// ============================================================
// BUSES CRUD (Admin)
// ============================================================

/**
 * GET /transport/buses
 * List all buses with driver info
 */
router.get('/buses', requirePermission('transport.view'), asyncHandler(async (req, res) => {
  const buses = await sql`
    SELECT
      b.id, b.bus_no, b.registration_no, b.capacity, b.is_active,
      b.driver_id, b.driver_phone,
      COALESCE(p.display_name, b.driver_name) as driver_name,
      p.display_name as assigned_driver_name,
      s.staff_code as driver_code,
      (
        SELECT r.id FROM transport_routes r
        WHERE r.bus_id = b.id
          AND r.school_id = ${req.schoolId}
          AND r.is_active = true
          AND r.deleted_at IS NULL
        ORDER BY r.updated_at DESC NULLS LAST, r.name
        LIMIT 1
      ) as route_id,
      (
        SELECT r.name FROM transport_routes r
        WHERE r.bus_id = b.id
          AND r.school_id = ${req.schoolId}
          AND r.is_active = true
          AND r.deleted_at IS NULL
        ORDER BY r.updated_at DESC NULLS LAST, r.name
        LIMIT 1
      ) as route_name,
      (
        SELECT COUNT(*)::int FROM transport_routes r
        WHERE r.bus_id = b.id
          AND r.school_id = ${req.schoolId}
          AND r.is_active = true
          AND r.deleted_at IS NULL
      ) as route_count
    FROM buses b
    LEFT JOIN staff s ON b.driver_id = s.id AND s.school_id = ${req.schoolId}
    LEFT JOIN persons p ON s.person_id = p.id
    WHERE b.deleted_at IS NULL AND b.school_id = ${req.schoolId}
    ORDER BY b.bus_no
  `;
  return sendSuccess(res, req.schoolId, buses);
}));

/**
 * POST /transport/buses
 * Add a bus (with optional driver_id)
 */
router.post('/buses', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { bus_no, registration_no, capacity, driver_id, driver_name, driver_phone, route_id } = req.body;

  if (!bus_no) {
    return res.status(400).json({ error: 'bus_no is required' });
  }

  // T4 FIX: Add school_id to buses INSERT
  const [bus] = await sql`
    INSERT INTO buses (school_id, bus_no, registration_no, capacity, driver_id, driver_name, driver_phone, route_id)
    VALUES (${req.schoolId}, ${bus_no}, ${registration_no || null}, ${capacity || 40}, ${driver_id || null}, ${driver_name || null}, ${driver_phone || null}, ${route_id || null})
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Bus added', bus }, 201);
}));

/**
 * PUT /transport/buses/:id
 * Update a bus
 */
router.put('/buses/:id', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { bus_no, registration_no, capacity, driver_id, is_active } = req.body;
  const clearOrSetDriver = Object.prototype.hasOwnProperty.call(req.body, 'driver_id');

  // T5 FIX: Ownership check first
  const [existing] = await sql`SELECT id FROM buses WHERE id = ${id} AND school_id = ${req.schoolId}`;
  if (!existing) return res.status(404).json({ error: 'Bus not found' });

  if (clearOrSetDriver && driver_id) {
    const [driver] = await sql`
      SELECT id FROM staff
      WHERE id = ${driver_id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    `;
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
  }

  const [bus] = await sql`
    UPDATE buses SET
      bus_no = COALESCE(${bus_no ?? null}, bus_no),
      registration_no = COALESCE(${registration_no ?? null}, registration_no),
      capacity = COALESCE(${capacity ?? null}, capacity),
      driver_id = CASE
        WHEN ${clearOrSetDriver} THEN ${driver_id ?? null}
        ELSE driver_id
      END,
      is_active = COALESCE(${is_active ?? null}, is_active)
    WHERE id = ${id} AND school_id = ${req.schoolId}
    RETURNING *
  `;

  if (!bus) return res.status(404).json({ error: 'Bus not found' });
  return sendSuccess(res, req.schoolId, { message: 'Bus updated', bus });
}));

/**
 * PUT /transport/buses/:id/assignment
 * Independently set or clear driver and/or route on a bus.
 * Omit a field to leave it unchanged; send null to clear it.
 */
router.put('/buses/:id/assignment', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const hasDriver = Object.prototype.hasOwnProperty.call(req.body, 'driver_id');
  const hasRoute = Object.prototype.hasOwnProperty.call(req.body, 'route_id');
  const { driver_id = null, route_id = null } = req.body || {};

  if (!hasDriver && !hasRoute) {
    return res.status(400).json({ error: 'Provide driver_id and/or route_id (null to clear)' });
  }

  const [bus] = await sql`
    SELECT id, driver_id FROM buses
    WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!bus) return res.status(404).json({ error: 'Bus not found' });

  if (hasDriver && driver_id) {
    const [driver] = await sql`
      SELECT id FROM staff
      WHERE id = ${driver_id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    `;
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
  }

  if (hasRoute && route_id) {
    const [route] = await sql`
      SELECT id FROM transport_routes
      WHERE id = ${route_id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    `;
    if (!route) return res.status(404).json({ error: 'Route not found' });
  }

  const linkedRoutes = await sql`
    SELECT id FROM transport_routes
    WHERE bus_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  const previousRouteIds = linkedRoutes.map((r) => r.id);
  const effectiveDriverId = hasDriver ? driver_id : bus.driver_id;
  let effectiveRouteId = hasRoute
    ? route_id
    : (previousRouteIds[0] || null);

  if (hasDriver) {
    await sql`
      UPDATE buses
      SET driver_id = ${driver_id}
      WHERE id = ${id} AND school_id = ${req.schoolId}
    `;
  }

  if (hasRoute) {
    // Detach this bus from any currently linked routes
    await sql`
      UPDATE transport_routes
      SET bus_id = NULL, updated_at = NOW()
      WHERE bus_id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    `;

    if (route_id) {
      // If another bus owned this route, take it over
      await sql`
        UPDATE transport_routes
        SET bus_id = ${id}, updated_at = NOW()
        WHERE id = ${route_id} AND school_id = ${req.schoolId}
      `;
      effectiveRouteId = route_id;
    } else {
      effectiveRouteId = null;
    }
  }

  // Keep driver_route_assignments in sync with the effective pairing
  if (hasDriver || hasRoute) {
    const routesToClear = hasRoute
      ? previousRouteIds.filter((rid) => rid !== effectiveRouteId)
      : [];

    if (hasRoute && !effectiveRouteId && previousRouteIds.length) {
      routesToClear.push(...previousRouteIds);
    }

    if (routesToClear.length) {
      await sql`
        UPDATE driver_route_assignments
        SET is_active = false, deleted_at = NOW()
        WHERE school_id = ${req.schoolId}
          AND route_id = ANY(${routesToClear})
          AND deleted_at IS NULL
      `;
    }

    if (effectiveRouteId && effectiveDriverId) {
      await sql`
        INSERT INTO driver_route_assignments (school_id, route_id, driver_id, is_active)
        VALUES (${req.schoolId}, ${effectiveRouteId}, ${effectiveDriverId}, true)
        ON CONFLICT (school_id, route_id, driver_id)
        DO UPDATE SET is_active = true, deleted_at = NULL, updated_at = NOW()
      `;
      // Deactivate other drivers on this route
      await sql`
        UPDATE driver_route_assignments
        SET is_active = false, deleted_at = NOW()
        WHERE school_id = ${req.schoolId}
          AND route_id = ${effectiveRouteId}
          AND driver_id <> ${effectiveDriverId}
          AND deleted_at IS NULL
      `;
    } else if (effectiveRouteId && hasDriver && !effectiveDriverId) {
      await sql`
        UPDATE driver_route_assignments
        SET is_active = false, deleted_at = NOW()
        WHERE school_id = ${req.schoolId}
          AND route_id = ${effectiveRouteId}
          AND deleted_at IS NULL
      `;
    }
  }

  const [updated] = await sql`
    SELECT
      b.id, b.bus_no, b.registration_no, b.capacity, b.is_active, b.driver_id,
      COALESCE(p.display_name, b.driver_name) as driver_name,
      (
        SELECT r.id FROM transport_routes r
        WHERE r.bus_id = b.id AND r.school_id = ${req.schoolId}
          AND r.is_active = true AND r.deleted_at IS NULL
        ORDER BY r.updated_at DESC NULLS LAST LIMIT 1
      ) as route_id,
      (
        SELECT r.name FROM transport_routes r
        WHERE r.bus_id = b.id AND r.school_id = ${req.schoolId}
          AND r.is_active = true AND r.deleted_at IS NULL
        ORDER BY r.updated_at DESC NULLS LAST LIMIT 1
      ) as route_name
    FROM buses b
    LEFT JOIN staff s ON b.driver_id = s.id AND s.school_id = ${req.schoolId}
    LEFT JOIN persons p ON s.person_id = p.id
    WHERE b.id = ${id} AND b.school_id = ${req.schoolId}
  `;

  return sendSuccess(res, req.schoolId, {
    message: 'Assignment updated',
    bus: updated,
  });
}));

/**
 * DELETE /transport/buses/:id
 * Soft-delete a bus and unlink it from routes
 */
router.delete('/buses/:id', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [existing] = await sql`
    SELECT id FROM buses
    WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!existing) return res.status(404).json({ error: 'Bus not found' });

  const [activeTrip] = await sql`
    SELECT id FROM trips
    WHERE bus_id = ${id} AND school_id = ${req.schoolId} AND status = 'active'
    LIMIT 1
  `;
  if (activeTrip) {
    return res.status(409).json({ error: 'Cannot delete bus while it has an active trip' });
  }

  await sql`
    UPDATE transport_routes
    SET bus_id = NULL, updated_at = NOW()
    WHERE bus_id = ${id} AND school_id = ${req.schoolId}
  `;

  await sql`
    UPDATE buses
    SET deleted_at = NOW(), is_active = false, driver_id = NULL, route_id = NULL
    WHERE id = ${id} AND school_id = ${req.schoolId}
  `;

  return sendSuccess(res, req.schoolId, { message: 'Bus deleted successfully' });
}));

// ============================================================
// DRIVER-FACING ENDPOINTS
// ============================================================

/**
 * GET /transport/driver/my-bus
 * Get all buses assigned to the driver, their routes, and any active trips.
 */
router.get('/driver/my-bus', requireAuth, asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const staffId = await getStaffId(req.user);
  if (!staffId) return res.status(404).json({ error: 'Staff profile not found' });

  const buses = await getDriverBuses(req.schoolId, staffId);

  if (buses.length === 0) {
    return sendSuccess(res, req.schoolId, {
      bus: null,
      buses: [],
      routes: [],
      activeTrips: [],
      message: 'No bus assigned',
    });
  }

  const busIds = buses.map((b) => b.id);

  const routes = await sql`
    SELECT r.id, r.name, r.name_te, r.direction, r.start_point, r.end_point, r.total_stops, r.bus_id
    FROM transport_routes r
    WHERE r.bus_id = ANY(${busIds})
      AND r.is_active = true
      AND r.school_id = ${req.schoolId}
      AND r.deleted_at IS NULL
    ORDER BY r.direction, r.name
  `;

  const activeTrips = await sql`
    SELECT t.id, t.route_id, t.bus_id, t.status, t.started_at, t.trip_direction
    FROM trips t
    WHERE t.bus_id = ANY(${busIds})
      AND t.status IN ('active', 'in_progress')
      AND t.school_id = ${req.schoolId}
  `;

  const activeTrip = activeTrips[0] || null;

  return sendSuccess(res, req.schoolId, {
    bus: buses[0],
    buses,
    routes,
    activeTrip,
    activeTrips,
  });
}));

/**
 * GET /transport/driver/route/:routeId/stops
 * Stops in driver execution order (forward for morning, reverse for evening).
 */
router.get('/driver/route/:routeId/stops', requireAuth, asyncHandler(async (req, res) => {
  const { routeId } = req.params;
  const { trip_direction: tripDirectionParam } = req.query;

  const [route] = await sql`
    SELECT id, direction FROM transport_routes
    WHERE id = ${routeId}
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
  `;
  if (!route) return res.status(404).json({ error: 'Route not found' });
  if (!await driverOwnsRoute(req.schoolId, req.user, routeId)) {
    return res.status(403).json({ error: 'This route is not assigned to you' });
  }

  const tripDirection = resolveTripDirection(
    route.direction,
    tripDirectionParam || inferDefaultTripDirection(route.direction),
  );

  const stops = await sql`
    SELECT
      ts.id, ts.name, ts.name_te, ts.latitude, ts.longitude, ts.stop_order,
      ts.pickup_time, ts.drop_time,
      COUNT(st.id) as student_count
    FROM transport_stops ts
    LEFT JOIN student_transport st ON st.stop_id = ts.id AND st.is_active = true
    WHERE ts.route_id = ${routeId}
      AND ts.school_id = ${req.schoolId}
      AND ts.deleted_at IS NULL
    GROUP BY ts.id
    ORDER BY ts.stop_order ASC
  `;

  const ordered = isReverseTripDirection(tripDirection) ? [...stops].reverse() : stops;
  const payload = ordered.map((stop, index) => ({
    ...stop,
    exec_order: index + 1,
    trip_direction: tripDirection,
    is_reverse: isReverseTripDirection(tripDirection),
  }));

  return sendSuccess(res, req.schoolId, payload);
}));

/**
 * GET /transport/driver/my-students
 * Returns all students on the driver's assigned routes, grouped by route & stop.
 */
/**
 * GET /transport/driver/route/:routeId/calibration?trip_direction=
 * Calibration status for the driver "Calibrating route" badge (Phase A).
 */
router.get('/driver/route/:routeId/calibration', requireAuth, asyncHandler(async (req, res) => {
  const { routeId } = req.params;
  const [route] = await sql`
    SELECT id FROM transport_routes
    WHERE id = ${routeId} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!route) return res.status(404).json({ error: 'Route not found' });
  if (!await driverOwnsRoute(req.schoolId, req.user, routeId)) {
    return res.status(403).json({ error: 'This route is not assigned to you' });
  }

  const status = await getLegCalibrationStatus(req.schoolId, routeId, req.query.trip_direction);
  return sendSuccess(res, req.schoolId, status);
}));

router.get('/driver/my-students', requireAuth, asyncHandler(async (req, res) => {
  if (!req.user?.roles?.includes('driver')) {
    return res.status(403).json({ error: 'Driver role required' });
  }

  const staffId = await getStaffId(req.user);
  if (!staffId) return res.status(404).json({ error: 'Staff profile not found' });

  const buses = await getDriverBuses(req.schoolId, staffId);
  if (buses.length === 0) return sendSuccess(res, req.schoolId, { routes: [], buses: [] });

  const busIds = buses.map((b) => b.id);

  const routes = await sql`
    SELECT r.id, r.name, r.direction, r.bus_id
    FROM transport_routes r
    WHERE r.bus_id = ANY(${busIds})
      AND r.is_active = true
      AND r.school_id = ${req.schoolId}
      AND r.deleted_at IS NULL
    ORDER BY r.direction, r.name
  `;

  const result = [];
  for (const route of routes) {
    const tripDirection = inferDefaultTripDirection(route.direction);
    const sequence = await getRouteStopExecutionSequence(req.schoolId, route.id, tripDirection);
    const execOrderByStopId = new Map(sequence.map((s) => [s.id, s.exec_order]));

    const stops = await sql`
      SELECT
        ts.id as stop_id, ts.name as stop_name, ts.stop_order,
        COALESCE(json_agg(
          json_build_object(
            'student_id', stu.id,
            'student_name', p.display_name,
            'admission_no', stu.admission_no,
            'class_name', c.name,
            'section_name', sec.name,
            'phone_contacts', COALESCE((
              SELECT json_agg(contact ORDER BY contact.is_primary DESC, contact.contact_name, contact.phone)
              FROM (
                SELECT
                  'Student'::text AS relationship,
                  p.display_name AS contact_name,
                  pc.contact_value AS phone,
                  pc.is_primary
                FROM person_contacts pc
                WHERE pc.person_id = stu.person_id
                  AND pc.school_id = ${req.schoolId}
                  AND pc.contact_type = 'phone'
                  AND pc.deleted_at IS NULL

                UNION ALL

                SELECT
                  COALESCE(rt.name, 'Guardian') AS relationship,
                  parent_person.display_name AS contact_name,
                  parent_phone.contact_value AS phone,
                  (sp.is_primary_contact OR parent_phone.is_primary) AS is_primary
                FROM student_parents sp
                JOIN parents parent ON parent.id = sp.parent_id
                  AND parent.school_id = ${req.schoolId}
                  AND parent.deleted_at IS NULL
                JOIN persons parent_person ON parent_person.id = parent.person_id
                LEFT JOIN relationship_types rt ON rt.id = sp.relationship_id
                JOIN person_contacts parent_phone ON parent_phone.person_id = parent.person_id
                  AND parent_phone.school_id = ${req.schoolId}
                  AND parent_phone.contact_type = 'phone'
                  AND parent_phone.deleted_at IS NULL
                WHERE sp.student_id = stu.id
                  AND sp.school_id = ${req.schoolId}
                  AND sp.deleted_at IS NULL
              ) contact
              WHERE NULLIF(BTRIM(contact.phone), '') IS NOT NULL
            ), '[]'::json)
          )
        ) FILTER (WHERE st.id IS NOT NULL), '[]') as students
      FROM transport_stops ts
      LEFT JOIN student_transport st ON st.stop_id = ts.id AND st.route_id = ${route.id} AND st.is_active = true
      LEFT JOIN students stu ON st.student_id = stu.id AND stu.school_id = ${req.schoolId}
      LEFT JOIN persons p ON stu.person_id = p.id
      LEFT JOIN student_enrollments se ON se.student_id = stu.id AND se.status = 'active' AND se.deleted_at IS NULL
      LEFT JOIN class_sections csec ON se.class_section_id = csec.id
      LEFT JOIN classes c ON csec.class_id = c.id
      LEFT JOIN sections sec ON csec.section_id = sec.id
      WHERE ts.route_id = ${route.id}
        AND ts.school_id = ${req.schoolId}
        AND ts.deleted_at IS NULL
      GROUP BY ts.id, ts.name, ts.stop_order
      ORDER BY ts.stop_order
    `;

    const orderedStops = stops
      .map((stop) => ({
        ...stop,
        exec_order: execOrderByStopId.get(stop.stop_id) ?? stop.stop_order,
      }))
      .sort((a, b) => a.exec_order - b.exec_order);

    result.push({ ...route, stops: orderedStops });
  }

  return sendSuccess(res, req.schoolId, { routes: result, buses });
}));

// ============================================================
// TRIP LIFECYCLE (Driver)
// ============================================================

/**
 * POST /transport/trips/start
 * Start a trip — creates trip + initializes all stop statuses as pending
 *
 * HARD VALIDATIONS:
 * - Driver must own the bus
 * - No active trip on this bus
 * - Route must belong to bus
 */
router.post('/trips/start', requireAuth, asyncHandler(async (req, res) => {
  const { route_id, bus_id: requestedBusId, trip_direction: requestedTripDirection } = req.body;
  if (!route_id) return res.status(400).json({ error: 'route_id is required' });

  const staffId = await getStaffId(req.user);
  if (!staffId) return res.status(403).json({ error: 'Staff profile not found' });

  const driverBuses = await getDriverBuses(req.schoolId, staffId);
  if (driverBuses.length === 0) return res.status(403).json({ error: 'No bus assigned to you' });

  const bus = requestedBusId
    ? driverBuses.find((b) => b.id === requestedBusId)
    : driverBuses[0];
  if (!bus) return res.status(403).json({ error: 'That bus is not assigned to you' });

  const [route] = await sql`
    SELECT id, bus_id, direction FROM transport_routes
    WHERE id = ${route_id}
      AND is_active = true
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
  `;
  if (!route) return res.status(404).json({ error: 'Route not found' });
  if (route.bus_id !== bus.id) {
    return res.status(403).json({ error: 'This route does not belong to the selected bus' });
  }

  const tripDir = resolveTripDirection(route.direction, requestedTripDirection);
  if (route.direction === 'both' && !requestedTripDirection) {
    return res.status(400).json({ error: 'trip_direction is required for both-direction routes (morning or evening)' });
  }

  const todayStart = kolkataDate();

  const [existingTrip] = await sql`
    SELECT id FROM trips
    WHERE bus_id = ${bus.id}
      AND school_id = ${req.schoolId}
      AND status IN ('active', 'in_progress')
  `;
  if (existingTrip) {
    return res.status(409).json({ error: 'An active trip already exists for this bus', tripId: existingTrip.id });
  }

  const sequence = await getRouteStopExecutionSequence(req.schoolId, route_id, tripDir);
  if (sequence.length === 0) {
    return res.status(400).json({ error: 'Route has no stops — add stops first' });
  }

  const [trip] = await sql`
    INSERT INTO trips (school_id, bus_id, route_id, driver_id, status, started_at, trip_date, trip_direction)
    VALUES (${req.schoolId}, ${bus.id}, ${route_id}, ${staffId}, 'in_progress', now(), ${todayStart}, ${tripDir})
    RETURNING id, school_id, bus_id, route_id, driver_id, status, started_at, ended_at, created_at, trip_direction
  `;

  await sql`
    INSERT INTO trip_stop_status (school_id, trip_id, stop_id, stop_order, status)
    SELECT ${req.schoolId}, ${trip.id}, s.id, s.exec_order, 'pending'
    FROM unnest(
      ${sql.array(sequence.map((s) => s.id))}::uuid[],
      ${sql.array(sequence.map((s) => s.exec_order))}::int[]
    ) AS s(id, exec_order)
  `;

  const firstStop = sequence[0];
  const notifySchoolId = req.schoolId;
  notifyTransportParentsAtStop(
    notifySchoolId,
    route_id,
    firstStop.id,
    'TRANSPORT_TRIP_STARTED',
    firstStop.name,
  ).catch((err) => console.error('[Transport Notify] trip start error:', err));

  return sendSuccess(res, req.schoolId, {
    message: 'Trip started',
    trip,
    totalStops: sequence.length,
    trip_direction: tripDir,
    is_reverse: isReverseTripDirection(tripDir),
  }, 201);
}));

/**
 * GET /transport/trips/:tripId/status
 * Get full trip status with all stops
 */
router.get('/trips/:tripId/status', requireAuth, asyncHandler(async (req, res) => {
  const { tripId } = req.params;

  const [trip] = await sql`
    SELECT t.*, r.name as route_name, r.direction, b.bus_no
    FROM trips t
    JOIN transport_routes r ON t.route_id = r.id AND r.school_id = ${req.schoolId}
    JOIN buses b ON t.bus_id = b.id AND b.school_id = ${req.schoolId}
    WHERE t.id = ${tripId} AND t.school_id = ${req.schoolId}
  `;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const isManager = req.user.roles?.includes('admin') || req.user.permissions?.includes('transport.view');
  if (!isManager && trip.driver_id !== await getStaffId(req.user)) {
    return res.status(403).json({ error: 'This is not your trip' });
  }

  const stops = await sql`
    SELECT
      tss.id, tss.stop_id, tss.stop_order, tss.status,
      tss.arrival_time, tss.departure_time,
      ts.name as stop_name, ts.latitude, ts.longitude,
      COUNT(st.id) as student_count
    FROM trip_stop_status tss
    JOIN transport_stops ts ON tss.stop_id = ts.id
    LEFT JOIN student_transport st ON st.stop_id = ts.id AND st.is_active = true
    WHERE tss.trip_id = ${tripId}
      AND tss.school_id = ${req.schoolId}
    GROUP BY tss.id, ts.name, ts.latitude, ts.longitude
    ORDER BY tss.stop_order ASC
  `;

  // Determine current stop (first non-completed/skipped)
  const currentStop = stops.find((s) => s.status === 'pending' || s.status === 'arrived');
  const completedCount = stops.filter((s) => s.status === 'completed' || s.status === 'skipped').length;

  return sendSuccess(res, req.schoolId, {
    trip,
    stops,
    currentStop: currentStop || null,
    progress: { completed: completedCount, total: stops.length },
    trip_direction: trip.trip_direction,
    is_reverse: isReverseTripDirection(trip.trip_direction),
  });
}));

/**
 * POST /transport/trips/:tripId/stops/:stopId/arrive
 * Mark a stop as arrived
 *
 * HARD VALIDATION: All previous stops must be completed or skipped
 */
router.post('/trips/:tripId/stops/:stopId/arrive', requireAuth, asyncHandler(async (req, res) => {
  const { tripId, stopId } = req.params;
  // Optional GPS fix from the driver app (Phase A calibration capture).
  const { latitude, longitude, accuracy, is_mocked } = req.body || {};
  const arrivalSource = req.body?.source === 'geofence' ? 'geofence' : 'manual';

  // Validate trip is active and belongs to this driver (B2: school_id scoped)
  const staffId = await getStaffId(req.user);
  const [trip] = await sql`
    SELECT id, driver_id, status, route_id, trip_direction
    FROM trips WHERE id = ${tripId} AND school_id = ${req.schoolId}
  `;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!tripStatusIsLive(trip.status)) return res.status(400).json({ error: 'Trip is not active' });
  if (trip.driver_id !== staffId) return res.status(403).json({ error: 'This is not your trip' });

  // Get the target stop status
  const [targetStop] = await sql`
    SELECT id, stop_order, status FROM trip_stop_status
    WHERE trip_id = ${tripId} AND stop_id = ${stopId} AND school_id = ${req.schoolId}
  `;
  if (!targetStop) return res.status(404).json({ error: 'Stop not found in this trip' });
  if (targetStop.status !== 'pending') {
    return res.status(400).json({ error: `Stop is already ${targetStop.status}` });
  }

  // ORDER ENFORCEMENT: Check all previous stops are completed/skipped
  const incomplete = await sql`
    SELECT id, stop_order, status FROM trip_stop_status
    WHERE trip_id = ${tripId} AND school_id = ${req.schoolId}
      AND stop_order < ${targetStop.stop_order}
      AND status NOT IN ('completed', 'skipped')
  `;
  if (incomplete.length > 0) {
    return res.status(400).json({
      error: `Cannot arrive at stop ${targetStop.stop_order} — previous stops are incomplete`,
      incompleteStops: incomplete.map((s) => ({ stop_order: s.stop_order, status: s.status }))
    });
  }

  // Mark as arrived
  const [updated] = await sql`
    UPDATE trip_stop_status SET status = 'arrived', arrival_time = now(), arrival_source = ${arrivalSource}
    WHERE id = ${targetStop.id}
      AND school_id = ${req.schoolId}
    RETURNING *
  `;

  // Phase A calibration capture (fire-and-forget; never blocks the response)
  setImmediate(() => recordArrivalCalibration({
    schoolId: req.schoolId,
    tripId,
    routeId: trip.route_id,
    tripDirection: trip.trip_direction,
    stopId,
    stopOrder: targetStop.stop_order,
    arrivalTime: updated?.arrival_time || new Date(),
    source: arrivalSource,
    latitude,
    longitude,
    accuracy,
    isMocked: !!is_mocked,
  }));

  return sendSuccess(res, req.schoolId, { message: 'Arrived at stop', stop: updated });
}));

/**
 * POST /transport/trips/:tripId/stops/:stopId/complete
 * Mark a stop as completed
 *
 * HARD VALIDATION: Stop must be in 'arrived' status
 */
router.post('/trips/:tripId/stops/:stopId/complete', requireAuth, asyncHandler(async (req, res) => {
  const { tripId, stopId } = req.params;

  const staffId = await getStaffId(req.user);
  const [trip] = await sql`SELECT id, driver_id, status FROM trips WHERE id = ${tripId} AND school_id = ${req.schoolId}`;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!tripStatusIsLive(trip.status)) return res.status(400).json({ error: 'Trip is not active' });
  if (trip.driver_id !== staffId) return res.status(403).json({ error: 'This is not your trip' });

  const [targetStop] = await sql`
    SELECT id, status FROM trip_stop_status
    WHERE trip_id = ${tripId} AND stop_id = ${stopId} AND school_id = ${req.schoolId}
  `;
  if (!targetStop) return res.status(404).json({ error: 'Stop not found in this trip' });
  if (targetStop.status !== 'arrived') {
    return res.status(400).json({ error: `Stop must be in 'arrived' status to complete. Current: ${targetStop.status}` });
  }

  const [updated] = await sql`
    UPDATE trip_stop_status SET status = 'completed', departure_time = now()
    WHERE id = ${targetStop.id}
      AND school_id = ${req.schoolId}
      AND status = 'arrived'
    RETURNING *
  `;
  if (!updated) return res.status(409).json({ error: 'Stop was already completed' });

  setImmediate(() => notifyBoardingStopDeparted(req.schoolId, tripId, stopId));

  return sendSuccess(res, req.schoolId, { message: 'Stop completed', stop: updated });
}));

/**
 * POST /transport/trips/:tripId/stops/:stopId/skip
 * Mark a stop as skipped (explicit skip)
 *
 * HARD VALIDATION: All previous stops must be completed/skipped
 */
router.post('/trips/:tripId/stops/:stopId/skip', requireAuth, asyncHandler(async (req, res) => {
  const { tripId, stopId } = req.params;

  const staffId = await getStaffId(req.user);
  const [trip] = await sql`SELECT id, driver_id, status FROM trips WHERE id = ${tripId} AND school_id = ${req.schoolId}`;
  if (!trip || !tripStatusIsLive(trip.status) || trip.driver_id !== staffId) {
    return res.status(403).json({ error: 'Invalid or unauthorized trip' });
  }

  const [targetStop] = await sql`
    SELECT id, stop_order, status FROM trip_stop_status
    WHERE trip_id = ${tripId} AND stop_id = ${stopId} AND school_id = ${req.schoolId}
  `;
  if (!targetStop) return res.status(404).json({ error: 'Stop not found' });
  if (targetStop.status === 'completed') return res.status(400).json({ error: 'Cannot skip a completed stop' });

  // ORDER ENFORCEMENT
  const incomplete = await sql`
    SELECT id FROM trip_stop_status
    WHERE trip_id = ${tripId} AND school_id = ${req.schoolId} AND stop_order < ${targetStop.stop_order}
      AND status NOT IN ('completed', 'skipped')
  `;
  if (incomplete.length > 0) {
    return res.status(400).json({ error: 'Cannot skip — previous stops are incomplete' });
  }

  const [updated] = await sql`
    UPDATE trip_stop_status SET status = 'skipped', departure_time = now()
    WHERE id = ${targetStop.id}
      AND school_id = ${req.schoolId}
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Stop skipped', stop: updated });
}));

/**
 * POST /transport/trips/:tripId/end
 * End a trip — marks remaining pending stops as skipped
 */
router.post('/trips/:tripId/end', requireAuth, asyncHandler(async (req, res) => {
  const { tripId } = req.params;

  const staffId = await getStaffId(req.user);
  const [trip] = await sql`SELECT id, driver_id, status FROM trips WHERE id = ${tripId} AND school_id = ${req.schoolId}`;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!tripStatusIsLive(trip.status)) return res.status(400).json({ error: 'Trip is not active' });
  if (trip.driver_id !== staffId) return res.status(403).json({ error: 'This is not your trip' });

  // Reached-but-not-departed stops (e.g. the final stop, where the bus parks
  // and never crosses the exit radius) were genuinely serviced → complete them.
  // Stops never reached stay skipped.
  await sql`
    UPDATE trip_stop_status SET status = 'completed', departure_time = now()
    WHERE trip_id = ${tripId}
      AND school_id = ${req.schoolId} AND status = 'arrived'
  `;
  await sql`
    UPDATE trip_stop_status SET status = 'skipped', departure_time = now()
    WHERE trip_id = ${tripId}
      AND school_id = ${req.schoolId} AND status = 'pending'
  `;

  // End trip
  const [ended] = await sql`
    UPDATE trips SET status = 'completed', ended_at = now()
    WHERE id = ${tripId}
      AND school_id = ${req.schoolId}
    RETURNING *
  `;

  // Refresh before acknowledging completion so the driver's next render sees
  // this clean trip instead of remaining one trip behind.
  const calibration = await finalizeTripCalibration(req.schoolId, tripId);

  return sendSuccess(res, req.schoolId, { message: 'Trip ended', trip: ended, calibration });
}));

/**
 * GET /transport/trips/history
 * Get driver's trip history
 */
router.get('/trips/history', requireAuth, asyncHandler(async (req, res) => {
  const staffId = await getStaffId(req.user);
  if (!staffId) return res.status(403).json({ error: 'Staff profile not found' });

  const trips = await sql`
    SELECT t.id, t.status, t.started_at, t.ended_at,
      r.name as route_name, r.direction,
      b.bus_no,
      (SELECT COUNT(*) FROM trip_stop_status WHERE trip_id = t.id AND status = 'completed') as completed_stops,
      (SELECT COUNT(*) FROM trip_stop_status WHERE trip_id = t.id) as total_stops
    FROM trips t
    JOIN transport_routes r ON t.route_id = r.id AND r.school_id = ${req.schoolId}
    JOIN buses b ON t.bus_id = b.id AND b.school_id = ${req.schoolId}
    WHERE t.driver_id = ${staffId}
    ORDER BY t.started_at DESC
    LIMIT 20
  `;

  return sendSuccess(res, req.schoolId, trips);
}));

// ============================================================
// LIVE TRACKING (from driver GPS)
// ============================================================

/**
 * POST /transport/buses/:id/location
 * Update bus location (Phase 5 Hardened)
 */
router.post('/buses/:id/location', requireAuth,
  validateRequest({ params: transportSchemas.busParams, body: transportSchemas.location }),
  asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { latitude, longitude, speed, heading, is_mocked = false } = req.body;

  if (!validCoordinate(latitude, -90, 90) || !validCoordinate(longitude, -180, 180)
      || (speed != null && (!Number.isFinite(Number(speed)) || Number(speed) < 0 || Number(speed) > 250))
      || (heading != null && (!Number.isFinite(Number(heading)) || Number(heading) < 0 || Number(heading) >= 360))
      || typeof is_mocked !== 'boolean') {
    return res.status(400).json({ error: 'Invalid location payload' });
  }

  if (!await getOwnedDriverBus(req.schoolId, req.user, id)) {
    return res.status(403).json({ error: 'This bus is not assigned to you' });
  }

  const result = await ingestLocationBatch({
    schoolId: req.schoolId,
    busId: id,
    fixes: [{ latitude: Number(latitude), longitude: Number(longitude), speed, heading, is_mocked, recorded_at: new Date().toISOString() }],
  });
  if (is_mocked) {
    logger.warn({ event: 'transport_mocked_fix', requestId: req.id, schoolId: req.schoolId, busId: id }, 'Mocked transport location stored only in audit history');
  }
  if (result.newestForEvaluation) {
    const context = { schoolId: req.schoolId, busId: id, fix: result.newestForEvaluation };
    setImmediate(() => runNewestFixEffects(context, {
      db: sql, evaluateGeofence, notifyApproachingStop, evaluateRunningLate,
    }).catch((error) => logger.error({ err: error, event: 'transport_side_effect_failed', requestId: req.id, schoolId: req.schoolId, busId: id }, 'Transport side effect failed')));
  }

  return sendSuccess(res, req.schoolId, { status: result.realtimeUpdated ? 'accepted' : 'rate_limited_ignored', location: result.location }, 201);
}));

/** GET /transport/routes/:routeId/calibration — compact two-leg admin review. */
router.get(
  '/routes/:routeId/calibration',
  requirePermission('transport.manage'),
  validateRequest({ params: transportSchemas.routeParams }),
  asyncHandler(async (req, res) => {
    const review = await getRouteCalibrationReview(req.schoolId, req.params.routeId);
    if (!review) return res.status(404).json({ error: 'Route not found' });
    return sendSuccess(res, req.schoolId, review);
  }),
);

/** POST /transport/routes/:routeId/calibration/reset?trip_direction=morning|evening */
router.post(
  '/routes/:routeId/calibration/reset',
  requirePermission('transport.manage'),
  validateRequest({ params: transportSchemas.routeParams, query: transportSchemas.calibrationLeg }),
  asyncHandler(async (req, res) => {
    const leg = parseCalibrationLeg(req.query.trip_direction);
    if (!leg) return res.status(400).json({ error: 'trip_direction must be morning or evening' });

    const result = await sql.begin((tx) => resetRouteCalibration(
      req.schoolId,
      req.params.routeId,
      leg,
      tx,
    ));
    if (!result) return res.status(404).json({ error: 'Route not found' });
    return sendSuccess(res, req.schoolId, result);
  }),
);

/** PATCH /transport/stops/:stopId/geo — explicit admin coordinate/lock override. */
router.patch(
  '/stops/:stopId/geo',
  requirePermission('transport.manage'),
  validateRequest({ params: transportSchemas.stopParams, body: transportSchemas.geoOverride }),
  asyncHandler(async (req, res) => {
    const leg = parseCalibrationLeg(req.body?.trip_direction);
    if (!leg) return res.status(400).json({ error: 'trip_direction must be morning or evening' });

    const hasLatitude = req.body?.latitude !== undefined;
    const hasLongitude = req.body?.longitude !== undefined;
    const hasLocked = req.body?.locked !== undefined;
    if (!hasLatitude && !hasLongitude && !hasLocked) {
      return res.status(400).json({ error: 'Provide latitude, longitude, or locked' });
    }

    const latitude = hasLatitude ? Number(req.body.latitude) : undefined;
    const longitude = hasLongitude ? Number(req.body.longitude) : undefined;
    if (hasLatitude && (req.body.latitude === '' || req.body.latitude == null
        || !Number.isFinite(latitude) || latitude < -90 || latitude > 90)) {
      return res.status(400).json({ error: 'latitude must be between -90 and 90' });
    }
    if (hasLongitude && (req.body.longitude === '' || req.body.longitude == null
        || !Number.isFinite(longitude) || longitude < -180 || longitude > 180)) {
      return res.status(400).json({ error: 'longitude must be between -180 and 180' });
    }
    if (hasLocked && typeof req.body.locked !== 'boolean') {
      return res.status(400).json({ error: 'locked must be boolean' });
    }

    const geo = await updateStopGeoOverride(
      req.schoolId,
      req.params.stopId,
      leg,
      { latitude, longitude, locked: hasLocked ? req.body.locked : undefined },
    );
    if (!geo) return res.status(404).json({ error: 'Learned stop coordinate not found' });
    return sendSuccess(res, req.schoolId, geo);
  }),
);

/**
 * POST /transport/buses/:id/locations/batch
 * Retry-safe offline store-and-forward ingestion. History is persisted in
 * client-time order; only the newest eligible fix may advance live state and
 * schedule geofence/notification work.
 */
router.post('/buses/:id/locations/batch', requireAuth,
  validateRequest({ params: transportSchemas.busParams, body: transportSchemas.locationBatch }),
  asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!await getOwnedDriverBus(req.schoolId, req.user, id)) {
    return res.status(403).json({ error: 'This bus is not assigned to you' });
  }

  let result;
  try {
    result = await ingestLocationBatch({
      schoolId: req.schoolId,
      busId: id,
      fixes: Array.isArray(req.body) ? req.body : req.body?.fixes,
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }

  if (result.newestForEvaluation) {
    const context = {
      schoolId: req.schoolId,
      busId: id,
      fix: result.newestForEvaluation,
    };
    setImmediate(() => runNewestFixEffects(context, {
      db: sql,
      evaluateGeofence,
      notifyApproachingStop,
      evaluateRunningLate,
    }).catch((error) => logger.error({ err: error, event: 'transport_side_effect_failed', requestId: req.id, schoolId: req.schoolId, busId: id }, 'Transport batch side effect failed')));
  }

  return sendSuccess(res, req.schoolId, {
    accepted: result.fixes.length,
    inserted: result.insertedCount,
    duplicates: result.duplicateCount,
    rejected_invalid: result.invalidCount,
    rejected_stale: result.staleCount,
    realtime_updated: result.realtimeUpdated,
    location: result.location,
  }, 201);
}));

/**
 * POST /transport/buses/:id/heartbeat
 */
router.post('/buses/:id/heartbeat', requireAuth,
  validateRequest({ params: transportSchemas.busParams, body: transportSchemas.emptyBody }),
  asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!await getOwnedDriverBus(req.schoolId, req.user, id)) {
    return res.status(403).json({ error: 'This bus is not assigned to you' });
  }
  const staffId = await getStaffId(req.user);
  await sql`
    INSERT INTO driver_heartbeat (school_id, driver_id, last_ping, status)
    VALUES (${req.schoolId}, ${staffId}, NOW(), 'online')
    ON CONFLICT (driver_id) DO UPDATE SET last_ping = NOW(), status = 'online'
  `;
  return sendSuccess(res, req.schoolId, { status: 'heartbeat_acknowledged' });
}));

/**
 * GET /transport/buses/:id/location
 * Get current bus location
 */
router.get('/buses/:id/location', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [busCheck] = await sql`SELECT id FROM buses WHERE id = ${id} AND school_id = ${req.schoolId}`;
  if (!busCheck) return res.status(404).json({ error: 'Bus not found' });
  const [location] = await sql`
    SELECT latitude, longitude, speed, heading, recorded_at
    FROM bus_locations WHERE bus_id = ${id}
    ORDER BY recorded_at DESC LIMIT 1
  `;
  if (!location) return res.status(404).json({ error: 'No location data' });
  return sendSuccess(res, req.schoolId, location);
}));

// ============================================================
// STUDENT ASSIGNMENTS (Admin)
// ============================================================

/**
 * GET /transport/students/:studentId
 * Get student's transport assignment
 */
router.get('/students/:studentId', requirePermission('transport.view'), asyncHandler(async (req, res) => {
  const { studentId } = req.params;

  const [assignment] = await sql`
    SELECT
      st.id, st.is_active, st.created_at, st.bus_id,
      r.name as route_name, r.code as route_code, r.monthly_fee,
      s.name as stop_name, s.pickup_time, s.drop_time, s.stop_order,
      b.bus_no
    FROM student_transport st
    JOIN transport_routes r ON st.route_id = r.id AND r.school_id = ${req.schoolId}
    LEFT JOIN transport_stops s ON st.stop_id = s.id
    LEFT JOIN buses b ON st.bus_id = b.id
    JOIN students sts ON st.student_id = sts.id AND sts.school_id = ${req.schoolId}
    WHERE st.student_id = ${studentId} AND st.is_active = true
  `;

  return sendSuccess(res, req.schoolId, assignment || { message: 'No transport assigned' });
}));

/**
 * POST /transport/students
 * Assign transport to student (bus_id auto-derived from route)
 */
router.post('/students', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { student_id, route_id, stop_id, academic_year_id } = req.body;

  if (!student_id || !route_id || !academic_year_id) {
    return res.status(400).json({ error: 'student_id, route_id, and academic_year_id are required' });
  }

  const [studentCheck] = await sql`
    SELECT id
    FROM students
    WHERE id = ${student_id}
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
  `;
  if (!studentCheck) {
    return res.status(404).json({ error: 'Student not found' });
  }

  // Auto-derive bus_id from route after verifying route ownership.
  const [route] = await sql`
    SELECT bus_id
    FROM transport_routes
    WHERE id = ${route_id}
      AND school_id = ${req.schoolId}
  `;
  if (!route) {
    return res.status(404).json({ error: 'Route not found' });
  }
  const bus_id = route?.bus_id || null;

  // Validate stop belongs to route
  if (stop_id) {
    const [stop] = await sql`
      SELECT id
      FROM transport_stops
      WHERE id = ${stop_id}
        AND route_id = ${route_id}
        AND school_id = ${req.schoolId}
        AND deleted_at IS NULL
    `;
    if (!stop) return res.status(404).json({ error: 'Stop not found' });
  }

  const [assignment] = await sql`
    INSERT INTO student_transport (school_id, student_id, route_id, stop_id, bus_id, academic_year_id)
    VALUES (${req.schoolId}, ${student_id}, ${route_id}, ${stop_id || null}, ${bus_id}, ${academic_year_id})
    ON CONFLICT (student_id, academic_year_id)
    DO UPDATE SET
      school_id = EXCLUDED.school_id,
      route_id = EXCLUDED.route_id,
      stop_id = EXCLUDED.stop_id,
      bus_id = EXCLUDED.bus_id,
      is_active = true
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Transport assigned', assignment }, 201);
}));

// ============================================================
// PARENT-FACING ENDPOINTS
// ============================================================

/**
 * GET /transport/parent/bus-status/:busId
 * Get live bus status for parent (filtered to their bus only)
 */
// T10 FIX: Add requireAuth middleware
router.get('/parent/bus-status/:busId', requireAuth, asyncHandler(async (req, res) => {
  const { busId } = req.params;

  // T10 FIX: Add school_id filter to bus lookup
  const [busCheck] = await sql`SELECT id FROM buses WHERE id = ${busId} AND school_id = ${req.schoolId}`;
  if (!busCheck) return res.status(404).json({ error: 'Bus not found' });

  // Live location
  const [location] = await sql`
    SELECT latitude, longitude, speed, heading, recorded_at
    FROM bus_locations WHERE bus_id = ${busId}
    ORDER BY recorded_at DESC LIMIT 1
  `;

  // Active trip with stops
  const [activeTrip] = await sql`
    SELECT t.id, t.started_at, r.name as route_name
    FROM trips t
    JOIN transport_routes r ON t.route_id = r.id
    WHERE t.bus_id = ${busId} AND t.status IN ('active', 'in_progress')
    LIMIT 1
  `;

  let stops = [];
  let nextStop = null;

  if (activeTrip) {
    stops = await sql`
      SELECT tss.stop_order, tss.status, tss.arrival_time, tss.departure_time,
        ts.name as stop_name, ts.latitude, ts.longitude
      FROM trip_stop_status tss
      JOIN transport_stops ts ON tss.stop_id = ts.id
      WHERE tss.trip_id = ${activeTrip.id}
      ORDER BY tss.stop_order ASC
    `;
    nextStop = stops.find((s) => s.status === 'pending' || s.status === 'arrived') || null;
  }

  return sendSuccess(res, req.schoolId, {
    location: location || null,
    activeTrip: activeTrip || null,
    stops,
    nextStop,
    busOnline: location ? (new Date() - new Date(location.recorded_at)) / 1000 < 120 : false
  });
}));

// ═══════════════════════════════════════════════════════════════════════════
// TRANSPORT SERVICE — Phase 3+: route–driver assignments, daily checkpoint
// trips, student tracker (extends existing tables; JWT + school_id scoped).
// ═══════════════════════════════════════════════════════════════════════════

/** Route stops list (nested path) — ordered; tenant-scoped. */
router.get('/routes/:routeId/stops', requirePermission('transport.view'), asyncHandler(async (req, res) => {
  const { routeId } = req.params;
  const limit = Math.min(Number(req.query.limit) || 200, 500);

  const [route] = await sql`
    SELECT id FROM transport_routes
    WHERE id = ${routeId} AND school_id = ${req.schoolId}
  `;
  if (!route) return res.status(404).json({ error: 'Route not found' });

  const stops = await sql`
    SELECT id, name, stop_order, latitude, longitude
    FROM transport_stops
    WHERE route_id = ${routeId}
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
    ORDER BY stop_order ASC
    LIMIT ${limit}
  `;
  return sendSuccess(res, req.schoolId, stops);
}));

/** Add stop with auto stop_order when body omits it — matches mobile admin flows. */
router.post('/routes/:routeId/stops/auto', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { routeId } = req.params;
  const { name, latitude, longitude } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });

  const [routeCheck] = await sql`
    SELECT id FROM transport_routes WHERE id = ${routeId} AND school_id = ${req.schoolId}
  `;
  if (!routeCheck) return res.status(404).json({ error: 'Route not found' });

  const [maxOrder] = await sql`
    SELECT COALESCE(MAX(stop_order), 0) AS max_order
    FROM transport_stops
    WHERE route_id = ${routeId} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  const nextOrder = Number(maxOrder.max_order) + 1;

  let finalNameTe = null;
  try {
    const te = await translateFields({ name });
    finalNameTe = te.name || null;
  } catch (e) { /* optional */ }

  const [stop] = await sql`
    INSERT INTO transport_stops (school_id, route_id, name, name_te, latitude, longitude, stop_order)
    VALUES (${req.schoolId}, ${routeId}, ${name}, ${finalNameTe}, ${latitude ?? null}, ${longitude ?? null}, ${nextOrder})
    RETURNING *
  `;

  await sql`
    UPDATE transport_routes SET total_stops = (
      SELECT COUNT(*) FROM transport_stops
      WHERE route_id = ${routeId} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    ), updated_at = NOW()
    WHERE id = ${routeId} AND school_id = ${req.schoolId}
  `;

  return sendSuccess(res, req.schoolId, stop, 201);
}));

/** Nested soft-delete stop (updates total_stops). */
router.delete('/routes/:routeId/stops/:stopId', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { routeId, stopId } = req.params;

  const [existing] = await sql`
    SELECT id FROM transport_stops
    WHERE id = ${stopId} AND route_id = ${routeId} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!existing) return res.status(404).json({ error: 'Stop not found' });

  await sql`
    UPDATE transport_stops SET deleted_at = NOW()
    WHERE id = ${stopId} AND school_id = ${req.schoolId}
  `;

  await sql`
    UPDATE transport_routes SET total_stops = (
      SELECT COUNT(*) FROM transport_stops
      WHERE route_id = ${routeId} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    ), updated_at = NOW()
    WHERE id = ${routeId} AND school_id = ${req.schoolId}
  `;

  return sendSuccess(res, req.schoolId, { message: 'Stop removed' });
}));

router.post('/routes/:routeId/stops/reorder', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { routeId } = req.params;
  const { orderedStopIds } = req.body;

  if (!Array.isArray(orderedStopIds) || orderedStopIds.length === 0) {
    return res.status(400).json({ error: 'orderedStopIds array is required' });
  }

  const existing = await sql`
    SELECT id FROM transport_stops
    WHERE route_id = ${routeId} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  const existingIds = new Set(existing.map((s) => s.id));
  const allValid = orderedStopIds.every((id) => existingIds.has(id));
  if (!allValid) return res.status(400).json({ error: 'One or more stop IDs are invalid for this route' });

  const orders = orderedStopIds.map((_, i) => i + 1);
  const orderOffset = orderedStopIds.length + 1000;

  // Two-phase update avoids UNIQUE (school_id, route_id, stop_order) violations
  // when swapping adjacent stops in a single UPDATE.
  await sql.begin(async (tx) => {
    await tx`
      UPDATE transport_stops
      SET stop_order = stop_order + ${orderOffset}
      WHERE route_id = ${routeId}
        AND school_id = ${req.schoolId}
        AND deleted_at IS NULL
    `;

    await tx`
      UPDATE transport_stops ts SET stop_order = u.stop_order
      FROM unnest(
        ${tx.array(orderedStopIds)}::uuid[],
        ${tx.array(orders)}::int[]
      ) AS u(id, stop_order)
      WHERE ts.id = u.id AND ts.school_id = ${req.schoolId}
    `;
  });

  await sql`
    UPDATE transport_routes SET updated_at = NOW()
    WHERE id = ${routeId} AND school_id = ${req.schoolId}
  `;

  return sendSuccess(res, req.schoolId, { message: 'Stops reordered' });
}));

router.get('/routes/:routeId/students', requirePermission('transport.view'), asyncHandler(async (req, res) => {
  const { routeId } = req.params;
  const limit = Math.min(Number(req.query.limit) || 500, 1000);

  const [route] = await sql`
    SELECT id FROM transport_routes WHERE id = ${routeId} AND school_id = ${req.schoolId}
  `;
  if (!route) return res.status(404).json({ error: 'Route not found' });

  const students = await sql`
    SELECT
      st.id as assignment_id, st.student_id, st.stop_id, st.is_active,
      p.display_name as student_name, s.admission_no,
      c.name as class_name, sec.name as section_name,
      tsp.name as stop_name, tsp.stop_order
    FROM student_transport st
    JOIN students s ON st.student_id = s.id AND s.school_id = ${req.schoolId}
    JOIN persons p ON s.person_id = p.id
    LEFT JOIN transport_stops tsp ON st.stop_id = tsp.id AND tsp.school_id = ${req.schoolId}
    LEFT JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active' AND se.school_id = ${req.schoolId}
    LEFT JOIN class_sections cs ON se.class_section_id = cs.id
    LEFT JOIN classes c ON cs.class_id = c.id
    LEFT JOIN sections sec ON cs.section_id = sec.id
    WHERE st.route_id = ${routeId}
      AND st.school_id = ${req.schoolId}
      AND st.is_active = true
    ORDER BY tsp.stop_order NULLS LAST, p.display_name
    LIMIT ${limit}
  `;
  return sendSuccess(res, req.schoolId, students);
}));

router.post('/assign-student', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { student_id, route_id, stop_id, academic_year_id } = req.body;
  if (!student_id || !route_id || !stop_id || !academic_year_id) {
    return res.status(400).json({ error: 'student_id, route_id, stop_id, academic_year_id are required' });
  }

  const [student] = await sql`
    SELECT id FROM students WHERE id = ${student_id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const [route] = await sql`
    SELECT id, bus_id FROM transport_routes WHERE id = ${route_id} AND school_id = ${req.schoolId}
  `;
  if (!route) return res.status(404).json({ error: 'Route not found' });

  const [stop] = await sql`
    SELECT id FROM transport_stops
    WHERE id = ${stop_id} AND route_id = ${route_id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!stop) return res.status(404).json({ error: 'Stop not found on this route' });

  const bus_id = route.bus_id || null;

  const [assignment] = await sql`
    INSERT INTO student_transport (school_id, student_id, route_id, stop_id, bus_id, academic_year_id, is_active)
    VALUES (${req.schoolId}, ${student_id}, ${route_id}, ${stop_id}, ${bus_id}, ${academic_year_id}, true)
    ON CONFLICT (student_id, academic_year_id)
    DO UPDATE SET
      school_id = EXCLUDED.school_id,
      route_id = EXCLUDED.route_id,
      stop_id = EXCLUDED.stop_id,
      bus_id = EXCLUDED.bus_id,
      is_active = true
    RETURNING *
  `;
  return sendSuccess(res, req.schoolId, assignment, 201);
}));

router.post('/assign-students-bulk', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { student_ids, route_id, stop_id, academic_year_id } = req.body;
  if (!Array.isArray(student_ids) || !student_ids.length || !route_id || !stop_id || !academic_year_id) {
    return res.status(400).json({ error: 'student_ids (array), route_id, stop_id, academic_year_id are required' });
  }

  const [route] = await sql`
    SELECT id, bus_id FROM transport_routes WHERE id = ${route_id} AND school_id = ${req.schoolId}
  `;
  if (!route) return res.status(404).json({ error: 'Route not found' });

  const [stop] = await sql`
    SELECT id FROM transport_stops
    WHERE id = ${stop_id} AND route_id = ${route_id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!stop) return res.status(404).json({ error: 'Stop not found on this route' });

  const bus_id = route.bus_id || null;

  const students = await sql`
    SELECT id FROM students WHERE id IN ${sql(student_ids)} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  const validStudentIds = students.map(s => s.id);
  if (!validStudentIds.length) {
    return res.status(404).json({ error: 'No valid students found' });
  }

  const values = validStudentIds.map(student_id => ({
    school_id: req.schoolId,
    student_id,
    route_id,
    stop_id,
    bus_id,
    academic_year_id,
    is_active: true
  }));

  const assignments = await sql`
    INSERT INTO student_transport ${sql(values)}
    ON CONFLICT (student_id, academic_year_id)
    DO UPDATE SET
      school_id = EXCLUDED.school_id,
      route_id = EXCLUDED.route_id,
      stop_id = EXCLUDED.stop_id,
      bus_id = EXCLUDED.bus_id,
      is_active = true
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { count: assignments.length }, 201);
}));

router.delete('/assign-student/:studentId', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { academic_year_id } = req.query;

  const [updated] = await sql`
    UPDATE student_transport
    SET is_active = false
    WHERE student_id = ${studentId}
      AND school_id = ${req.schoolId}
      ${academic_year_id ? sql`AND academic_year_id = ${academic_year_id}` : sql``}
      AND is_active = true
    RETURNING id
  `;
  if (!updated) return res.status(404).json({ error: 'Assignment not found' });
  return sendSuccess(res, req.schoolId, { message: 'Student removed from route' });
}));

router.post('/routes/:routeId/assign-driver', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { routeId } = req.params;
  const { driver_id } = req.body;

  if (!driver_id) return res.status(400).json({ error: 'driver_id is required' });

  const [route] = await sql`
    SELECT id FROM transport_routes WHERE id = ${routeId} AND school_id = ${req.schoolId}
  `;
  if (!route) return res.status(404).json({ error: 'Route not found' });

  const [driver] = await sql`
    SELECT id FROM staff WHERE id = ${driver_id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!driver) return res.status(404).json({ error: 'Driver not found' });

  await sql`
    UPDATE driver_route_assignments
    SET is_active = false, updated_at = NOW()
    WHERE route_id = ${routeId} AND school_id = ${req.schoolId}
  `;

  const [assignment] = await sql`
    INSERT INTO driver_route_assignments (school_id, route_id, driver_id, is_active)
    VALUES (${req.schoolId}, ${routeId}, ${driver_id}, true)
    ON CONFLICT (school_id, route_id, driver_id)
    DO UPDATE SET is_active = true, updated_at = NOW(), deleted_at = NULL
    RETURNING *
  `;
  return sendSuccess(res, req.schoolId, assignment, 201);
}));

router.get('/driver/my-trip', requireAuth, asyncHandler(async (req, res) => {
  if (!req.user?.roles?.includes('driver')) {
    return res.status(403).json({ error: 'Driver role required' });
  }

  const staffId = await getStaffId(req.user);
  if (!staffId) return res.status(404).json({ error: 'Driver profile not found' });

  const { route_id: routeIdParam, trip_direction: tripDirectionParam } = req.query;

  const routeAssignments = await sql`
    SELECT dra.route_id, r.name as route_name, r.direction, r.bus_id
    FROM driver_route_assignments dra
    JOIN transport_routes r ON dra.route_id = r.id AND r.school_id = ${req.schoolId}
    WHERE dra.driver_id = ${staffId}
      AND dra.school_id = ${req.schoolId}
      AND dra.is_active = true
      AND dra.deleted_at IS NULL
    ORDER BY r.name
  `;

  const driverBuses = await getDriverBuses(req.schoolId, staffId);
  const busRouteRows = driverBuses.length > 0 ? await sql`
    SELECT r.id as route_id, r.name as route_name, r.direction, r.bus_id
    FROM transport_routes r
    WHERE r.bus_id = ANY(${driverBuses.map((b) => b.id)})
      AND r.is_active = true
      AND r.school_id = ${req.schoolId}
      AND r.deleted_at IS NULL
    ORDER BY r.name
  ` : [];

  const assignmentPool = routeAssignments.length > 0 ? routeAssignments : busRouteRows;
  if (assignmentPool.length === 0) {
    return res.status(404).json({ success: false, error: 'No route assigned to you' });
  }

  const routeAssignment = routeIdParam
    ? assignmentPool.find((r) => r.route_id === routeIdParam)
    : assignmentPool[0];
  if (!routeAssignment) {
    return res.status(404).json({ error: 'Route not found for this driver' });
  }

  if (!routeAssignment.bus_id) {
    return res.status(400).json({ error: 'Route has no bus assigned — admin must link a bus to this route' });
  }

  const today = kolkataDate();
  const tripDir = resolveTripDirection(
    routeAssignment.direction,
    tripDirectionParam || inferDefaultTripDirection(routeAssignment.direction),
  );

  let [trip] = await sql`
    SELECT id, route_id, status, started_at, ended_at, trip_date, trip_direction
    FROM trips
    WHERE route_id = ${routeAssignment.route_id}
      AND driver_id = ${staffId}
      AND school_id = ${req.schoolId}
      AND trip_direction = ${tripDir}
      AND (
        trip_date = ${today}
        OR (
          trip_date IS NULL
          AND COALESCE(started_at, created_at)::date = ${today}::date
        )
      )
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (!trip) {
    try {
      [trip] = await sql`
        INSERT INTO trips (
          school_id, bus_id, route_id, driver_id, status, trip_date, trip_direction, started_at
        )
        VALUES (
          ${req.schoolId},
          ${routeAssignment.bus_id},
          ${routeAssignment.route_id},
          ${staffId},
          'scheduled',
          ${today},
          ${tripDir},
          NULL
        )
        RETURNING id, route_id, status, started_at, ended_at, trip_date, trip_direction
      `;
    } catch (e) {
      [trip] = await sql`
        SELECT id, route_id, status, started_at, ended_at, trip_date, trip_direction FROM trips
        WHERE route_id = ${routeAssignment.route_id}
          AND driver_id = ${staffId}
          AND school_id = ${req.schoolId}
          AND trip_direction = ${tripDir}
          AND (
            trip_date = ${today}
            OR (
              trip_date IS NULL
              AND COALESCE(started_at, created_at)::date = ${today}::date
            )
          )
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (!trip) throw e;
    }

    await seedTripStopStatuses(
      req.schoolId,
      trip.id,
      routeAssignment.route_id,
      trip.trip_direction || tripDir,
    );
  }

  const stops = await sql`
    SELECT
      ts.id as stop_id,
      ts.name as stop_name,
      ts.stop_order,
      COALESCE(tss.stop_order, ts.stop_order) as exec_order,
      ts.latitude,
      ts.longitude,
      tss.id as status_id,
      tss.status,
      tss.arrival_time as reached_at,
      COUNT(stx.id)::int as assigned_students
    FROM transport_stops ts
    LEFT JOIN trip_stop_status tss ON tss.stop_id = ts.id AND tss.trip_id = ${trip.id} AND tss.school_id = ${req.schoolId}
    LEFT JOIN student_transport stx ON stx.stop_id = ts.id
      AND stx.school_id = ${req.schoolId}
      AND stx.is_active = true
    WHERE ts.route_id = ${routeAssignment.route_id}
      AND ts.school_id = ${req.schoolId}
      AND ts.deleted_at IS NULL
    GROUP BY ts.id, ts.name, ts.stop_order, ts.latitude, ts.longitude, tss.id, tss.status, tss.arrival_time, tss.stop_order
    ORDER BY COALESCE(tss.stop_order, ts.stop_order) ASC
  `;

  const uiStatus = mapTripUiStatus(trip.status);

  return sendSuccess(res, req.schoolId, {
    trip: {
      id: trip.id,
      route_id: trip.route_id,
      status: uiStatus,
      raw_status: trip.status,
      started_at: trip.started_at,
      completed_at: trip.ended_at,
      route_name: routeAssignment.route_name,
      direction: routeAssignment.direction,
      trip_direction: trip.trip_direction || tripDir,
      date: today,
      bus_id: routeAssignment.bus_id,
    },
    stops,
    available_routes: assignmentPool,
    is_reverse: isReverseTripDirection(trip.trip_direction || tripDir),
  });
}));

router.post('/driver/trip/:tripId/start', requireAuth, asyncHandler(async (req, res) => {
  if (!req.user?.roles?.includes('driver')) {
    return res.status(403).json({ error: 'Driver role required' });
  }

  const { tripId } = req.params;
  const staffId = await getStaffId(req.user);
  if (!staffId) return res.status(403).json({ error: 'Staff profile not found' });

  const [trip] = await sql`
    SELECT t.id, t.status, t.route_id, t.trip_direction
    FROM trips t
    WHERE t.id = ${tripId}
      AND t.school_id = ${req.schoolId}
      AND t.driver_id = ${staffId}
      AND t.status = 'scheduled'
    LIMIT 1
  `;
  if (!trip) return res.status(404).json({ error: 'Trip not found or already started' });

  const [updated] = await sql`
    UPDATE trips
    SET status = 'in_progress', started_at = NOW(), updated_at = NOW()
    WHERE id = ${tripId} AND school_id = ${req.schoolId}
    RETURNING id, status, started_at, trip_direction
  `;

  const sequence = await getRouteStopExecutionSequence(
    req.schoolId,
    trip.route_id,
    trip.trip_direction || 'morning',
  );
  const firstStop = sequence[0];
  if (firstStop) {
    notifyTransportParentsAtStop(
      req.schoolId,
      trip.route_id,
      firstStop.id,
      'TRANSPORT_TRIP_STARTED',
      firstStop.name,
    ).catch((err) => console.error('[Transport Notify] trip start error:', err));
  }

  return sendSuccess(res, req.schoolId, {
    ...updated,
    status: mapTripUiStatus(updated.status),
    raw_status: updated.status,
  });
}));

/**
 * POST .../reach — one-tap checkpoint for new driver UI.
 * trip_stop_status.status CHECK allows: pending | arrived | completed | skipped (schema.sql).
 * This endpoint writes 'completed' for a reached stop (same as legacy two-step arrive+complete).
 * Do not use a separate 'reached' status — it is not in the DB constraint.
 */
router.post('/driver/trip/:tripId/stop/:stopId/reach', requireAuth, asyncHandler(async (req, res) => {
  if (!req.user?.roles?.includes('driver')) {
    return res.status(403).json({ error: 'Driver role required' });
  }

  const { tripId, stopId } = req.params;
  // Optional GPS fix from the driver app (Phase A calibration capture).
  const { latitude, longitude, accuracy, is_mocked } = req.body || {};
  const arrivalSource = req.body?.source === 'geofence' ? 'geofence' : 'manual';

  const staffId = await getStaffId(req.user);
  if (!staffId) return res.status(403).json({ error: 'Staff profile not found' });

  const [trip] = await sql`
    SELECT t.id, t.route_id, t.trip_direction
    FROM trips t
    WHERE t.id = ${tripId}
      AND t.school_id = ${req.schoolId}
      AND t.driver_id = ${staffId}
      AND t.status IN ('active', 'in_progress')
    LIMIT 1
  `;
  if (!trip) return res.status(404).json({ error: 'Active trip not found' });

  const [targetStop] = await sql`
    SELECT id, stop_order, status FROM trip_stop_status
    WHERE trip_id = ${tripId} AND stop_id = ${stopId} AND school_id = ${req.schoolId}
  `;
  if (!targetStop) return res.status(404).json({ error: 'Stop not found in this trip' });
  if (targetStop.status !== 'pending') {
    return res.status(409).json({ error: 'Stop already reached or skipped' });
  }

  const incomplete = await sql`
    SELECT id, stop_order, status FROM trip_stop_status
    WHERE trip_id = ${tripId}
      AND school_id = ${req.schoolId}
      AND stop_order < ${targetStop.stop_order}
      AND status NOT IN ('completed', 'skipped')
  `;
  if (incomplete.length > 0) {
    return res.status(400).json({
      error: 'Complete earlier stops first',
      incompleteStops: incomplete.map((s) => ({ stop_order: s.stop_order, status: s.status })),
    });
  }

  const [stopStatus] = await sql`
    UPDATE trip_stop_status
    SET status = 'completed', arrival_time = NOW(), departure_time = NOW(), arrival_source = ${arrivalSource}
    WHERE trip_id = ${tripId}
      AND stop_id = ${stopId}
      AND school_id = ${req.schoolId}
      AND status = 'pending'
    RETURNING id, stop_id, status, arrival_time
  `;
  if (!stopStatus) return res.status(409).json({ error: 'Stop already reached or not found' });

  // Phase A calibration capture (fire-and-forget; never blocks the response)
  setImmediate(() => recordArrivalCalibration({
    schoolId: req.schoolId,
    tripId,
    routeId: trip.route_id,
    tripDirection: trip.trip_direction,
    stopId,
    stopOrder: targetStop.stop_order,
    arrivalTime: stopStatus.arrival_time || new Date(),
    source: arrivalSource,
    latitude,
    longitude,
    accuracy,
    isMocked: !!is_mocked,
  }));

  setImmediate(() => notifyBoardingStopDeparted(req.schoolId, tripId, stopId));

  const [nextStopRow] = await sql`
    SELECT ts.id, ts.name
    FROM trip_stop_status tss
    JOIN transport_stops ts ON ts.id = tss.stop_id AND ts.school_id = ${req.schoolId}
    WHERE tss.trip_id = ${tripId}
      AND tss.school_id = ${req.schoolId}
      AND tss.stop_order = ${targetStop.stop_order + 1}
    LIMIT 1
  `;
  const nextStop = nextStopRow || null;

  if (nextStop) {
    const notifySchoolId = req.schoolId;
    const routeId = trip.route_id;
    // Claim approach_notified_at so the GPS-proximity path can't double-send.
    sql`
      UPDATE trip_stop_status SET approach_notified_at = NOW()
      WHERE trip_id = ${tripId}
        AND stop_id = ${nextStop.id}
        AND school_id = ${notifySchoolId}
        AND approach_notified_at IS NULL
      RETURNING id
    `
      .then(([claimed]) => {
        if (!claimed) return null;
        return getTransportStudentIdsAtStop(notifySchoolId, routeId, nextStop.id)
          .then((studentIds) => sendTransportNotification(
            studentIds,
            'TRANSPORT_BUS_APPROACHING',
            { stopName: nextStop.name },
            notifySchoolId,
          ));
      })
      .catch((err) => console.error('[Transport Notify] stop reach error:', err));
  }

  return sendSuccess(res, req.schoolId, {
    ...stopStatus,
    reached_at: stopStatus.arrival_time,
    status: 'reached',
  });
}));

router.post('/driver/trip/:tripId/complete', requireAuth, asyncHandler(async (req, res) => {
  if (!req.user?.roles?.includes('driver')) {
    return res.status(403).json({ error: 'Driver role required' });
  }

  const { tripId } = req.params;
  const staffId = await getStaffId(req.user);
  if (!staffId) return res.status(403).json({ error: 'Staff profile not found' });

  // TODO: Remove legacy 'active' from this IN list once all driver clients use POST /driver/trip/:id/start
  // and legacy POST /trips/start only emits in_progress (tracked: transport reconciliation v2).
  const [trip] = await sql`
    SELECT t.id, t.route_id
    FROM trips t
    WHERE t.id = ${tripId}
      AND t.school_id = ${req.schoolId}
      AND t.driver_id = ${staffId}
      AND t.status IN ('active', 'in_progress')
    LIMIT 1
  `;
  if (!trip) return res.status(404).json({ error: 'Active trip not found' });

  const [completed] = await sql`
    UPDATE trips
    SET status = 'completed', ended_at = NOW(), updated_at = NOW()
    WHERE id = ${tripId} AND school_id = ${req.schoolId}
    RETURNING id, status, ended_at
  `;

  // Keep the completed trip and calibration progress synchronized.
  const calibration = await finalizeTripCalibration(req.schoolId, tripId);

  setImmediate(async () => {
    try {
      const [routeInfo] = await sql`
        SELECT name FROM transport_routes WHERE id = ${trip.route_id} AND school_id = ${req.schoolId}
      `;

      const parents = await sql`
        SELECT DISTINCT u.id AS user_id
        FROM student_transport sra
        JOIN student_parents sp ON sp.student_id = sra.student_id AND sp.school_id = ${req.schoolId} AND sp.deleted_at IS NULL
        JOIN parents par ON par.id = sp.parent_id AND par.school_id = ${req.schoolId}
        JOIN users u ON u.person_id = par.person_id AND u.school_id = ${req.schoolId}
        WHERE sra.route_id = ${trip.route_id}
          AND sra.school_id = ${req.schoolId}
          AND sra.is_active = true
          AND u.account_status = 'active'
      `;

      const admins = await sql`
        SELECT DISTINCT u.id AS user_id
        FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id AND r.school_id = ${req.schoolId}
        JOIN users u ON ur.user_id = u.id AND u.school_id = ${req.schoolId}
        WHERE r.code = 'admin'
          AND u.account_status = 'active'
          AND ur.school_id = ${req.schoolId}
          AND ur.deleted_at IS NULL
      `;

      const allUserIds = [...new Set([
        ...parents.map((p) => p.user_id),
        ...admins.map((a) => a.user_id),
      ])];

      if (allUserIds.length > 0) {
        await sendNotificationToUsers(
          allUserIds,
          'BUS_TRIP_COMPLETED',
          { routeName: routeInfo?.name || 'route' },
        );
      }
    } catch (err) {
      /* non-blocking */
    }
  });

  return sendSuccess(res, req.schoolId, {
    ...completed,
    calibration,
    status: mapTripUiStatus(completed.status),
    raw_status: completed.status,
    completed_at: completed.ended_at,
  });
}));

router.get('/my-bus', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;

  const studentId = await resolveStudentId(req);

  if (!studentId) return res.status(404).json({ error: 'No student profile found' });

  const [ay] = await sql`
    SELECT id FROM academic_years
    WHERE (now() AT TIME ZONE 'Asia/Kolkata')::date BETWEEN start_date AND end_date AND school_id = ${schoolId}
    LIMIT 1
  `;

  const [assignment] = await sql`
    SELECT st.route_id, st.stop_id, tsp.name AS boarding_stop, tsp.stop_order AS boarding_stop_order,
           r.name AS route_name, r.direction
    FROM student_transport st
    JOIN transport_routes r ON st.route_id = r.id AND r.school_id = ${schoolId}
    JOIN transport_stops tsp ON st.stop_id = tsp.id AND tsp.school_id = ${schoolId}
    WHERE st.student_id = ${studentId}
      AND st.school_id = ${schoolId}
      AND st.academic_year_id = ${ay?.id}
      AND st.is_active = true
    LIMIT 1
  `;

  if (!assignment) {
    return sendSuccess(res, schoolId, { assigned: false });
  }

  const today = kolkataDate();
  const [trip] = await sql`
    SELECT t.id, t.status, t.started_at, t.ended_at,
           p.display_name AS driver_name
    FROM trips t
    JOIN staff st ON t.driver_id = st.id AND st.school_id = ${schoolId}
    JOIN persons p ON st.person_id = p.id
    WHERE t.route_id = ${assignment.route_id}
      AND t.school_id = ${schoolId}
      AND (
        t.trip_date = ${today}
        OR (
          t.trip_date IS NULL
          AND COALESCE(t.started_at, t.created_at)::date = ${today}::date
        )
      )
    ORDER BY t.created_at DESC
    LIMIT 1
  `;

  let stops = [];
  let currentStop = null;
  let stopsUntilBoarding = null;

  if (trip) {
    stops = await sql`
      SELECT ts.id, ts.name, ts.stop_order, tss.stop_order AS exec_order,
             ts.latitude, ts.longitude, tss.status, tss.arrival_time AS reached_at
      FROM trip_stop_status tss
      JOIN transport_stops ts ON tss.stop_id = ts.id AND ts.school_id = ${schoolId}
      WHERE tss.trip_id = ${trip.id}
        AND tss.school_id = ${schoolId}
        AND ts.route_id = ${assignment.route_id}
        AND ts.deleted_at IS NULL
      ORDER BY tss.stop_order ASC
    `;

    // An arrived stop is where the bus is now. Once it departs, retain the
    // last completed stop so the timeline still reflects real trip progress.
    const arrivedStop = stops.find((s) => s.status === 'arrived');
    const reachedStops = stops.filter((s) => s.status === 'completed');
    currentStop = arrivedStop || (reachedStops.length > 0 ? reachedStops[reachedStops.length - 1] : null);

    if (currentStop && assignment.boarding_stop_order != null) {
      const boardingExec = stops.find((s) => s.stop_order === assignment.boarding_stop_order)?.exec_order
        ?? assignment.boarding_stop_order;
      const currentExec = currentStop.exec_order ?? currentStop.stop_order;
      stopsUntilBoarding = Math.max(0, boardingExec - currentExec);
    }
  }

  const tripUi = trip ? {
    ...trip,
    ui_status: mapTripUiStatus(trip.status),
  } : null;

  return sendSuccess(res, schoolId, {
    assigned: true,
    route_name: assignment.route_name,
    boarding_stop: assignment.boarding_stop,
    boarding_stop_id: assignment.stop_id,
    boarding_stop_order: assignment.boarding_stop_order,
    trip: tripUi,
    stops,
    current_stop: currentStop,
    stops_until_boarding: stopsUntilBoarding,
  });
}));

/**
 * GET /transport/my-bus/live
 * Compact live-tracking payload for the student/parent bus screen — one small
 * call per poll tick: last GPS fix + freshness + server-side ETA to the
 * student's boarding stop + stop coordinates for the map polyline.
 * Timeline/attendance data stays on GET /my-bus.
 */
router.get('/my-bus/live', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;

  const studentId = await resolveStudentId(req);
  if (!studentId) return res.status(404).json({ error: 'No student profile found' });

  const [ay] = await sql`
    SELECT id FROM academic_years
    WHERE (now() AT TIME ZONE 'Asia/Kolkata')::date BETWEEN start_date AND end_date AND school_id = ${schoolId}
    LIMIT 1
  `;

  const [assignment] = await sql`
    SELECT st.route_id, st.stop_id
    FROM student_transport st
    JOIN transport_routes r ON st.route_id = r.id AND r.school_id = ${schoolId}
    WHERE st.student_id = ${studentId}
      AND st.school_id = ${schoolId}
      AND st.academic_year_id = ${ay?.id}
      AND st.is_active = true
    LIMIT 1
  `;
  if (!assignment) {
    return sendSuccess(res, schoolId, { assigned: false, live: false });
  }

  const today = kolkataDate();
  const [trip] = await sql`
    SELECT t.id, t.bus_id, t.status, t.trip_direction
    FROM trips t
    WHERE t.route_id = ${assignment.route_id}
      AND t.school_id = ${schoolId}
      AND t.status IN ('active', 'in_progress')
      AND (
        t.trip_date = ${today}
        OR (
          t.trip_date IS NULL
          AND COALESCE(t.started_at, t.created_at)::date = ${today}::date
        )
      )
    ORDER BY t.created_at DESC
    LIMIT 1
  `;
  if (!trip || !trip.bus_id) {
    return sendSuccess(res, schoolId, { assigned: true, live: false });
  }

  const leg = normalizeLeg(trip.trip_direction);
  const [locations, stopRows, segmentRows] = await Promise.all([
    sql`
      SELECT latitude, longitude, speed, heading, recorded_at
      FROM bus_locations WHERE bus_id = ${trip.bus_id}
      ORDER BY recorded_at DESC LIMIT 1
    `,
    sql`
      SELECT ts.id, ts.name, ts.latitude, ts.longitude, tss.stop_order AS exec_order, tss.status
      FROM trip_stop_status tss
      JOIN transport_stops ts ON tss.stop_id = ts.id AND ts.school_id = ${schoolId}
      WHERE tss.trip_id = ${trip.id}
        AND tss.school_id = ${schoolId}
      ORDER BY tss.stop_order ASC
    `,
    sql`
      SELECT from_stop_id, to_stop_id, ewma_seconds, ewvar_seconds, sample_count
      FROM route_segment_time
      WHERE school_id = ${schoolId} AND route_id = ${assignment.route_id} AND trip_direction = ${leg}
    `,
  ]);

  const rawLocation = locations[0] || null;
  const ageSeconds = rawLocation
    ? Math.max(0, Math.round((Date.now() - new Date(rawLocation.recorded_at).getTime()) / 1000))
    : null;

  const segments = {};
  for (const r of segmentRows) {
    segments[segKey(r.from_stop_id, r.to_stop_id)] = {
      ewma: Number(r.ewma_seconds),
      ewvar: Number(r.ewvar_seconds),
      count: r.sample_count,
    };
  }
  const eta = computeLearnedEta({
    location: rawLocation,
    stops: stopRows,
    boardingStopId: assignment.stop_id,
    segments,
  });

  return sendSuccess(res, schoolId, {
    assigned: true,
    live: true,
    trip: { id: trip.id, status: mapTripUiStatus(trip.status) },
    location: rawLocation ? {
      latitude: Number(rawLocation.latitude),
      longitude: Number(rawLocation.longitude),
      speed: rawLocation.speed != null ? Number(rawLocation.speed) : null,
      heading: rawLocation.heading != null ? Number(rawLocation.heading) : null,
      recorded_at: rawLocation.recorded_at,
      age_seconds: ageSeconds,
      is_fresh: ageSeconds != null && ageSeconds <= LOCATION_FRESH_SECONDS,
    } : null,
    eta_minutes: eta.eta_minutes,
    eta_low_minutes: eta.eta_low_minutes,
    eta_high_minutes: eta.eta_high_minutes,
    eta_confidence: eta.confidence,
    eta_source: eta.source,
    distance_km: eta.distance_km,
    boarding_stop_id: assignment.stop_id,
    stops: stopRows.map((s) => ({
      id: s.id,
      name: s.name,
      latitude: s.latitude != null ? Number(s.latitude) : null,
      longitude: s.longitude != null ? Number(s.longitude) : null,
      exec_order: s.exec_order,
      status: s.status,
    })),
  });
}));

router.get('/routes/:routeId/live', requirePermission('transport.view'), asyncHandler(async (req, res) => {
  const { routeId } = req.params;

  const [route] = await sql`
    SELECT id, name FROM transport_routes
    WHERE id = ${routeId} AND school_id = ${req.schoolId}
  `;
  if (!route) return res.status(404).json({ error: 'Route not found' });

  const today = kolkataDate();
  const [trip] = await sql`
    SELECT t.id, t.status, t.started_at, t.ended_at, t.trip_direction,
           p.display_name AS driver_name
    FROM trips t
    JOIN staff st ON t.driver_id = st.id AND st.school_id = ${req.schoolId}
    JOIN persons p ON st.person_id = p.id
    WHERE t.route_id = ${routeId}
      AND t.school_id = ${req.schoolId}
      AND (
        t.trip_date = ${today}
        OR (
          t.trip_date IS NULL
          AND COALESCE(t.started_at, t.created_at)::date = ${today}::date
        )
      )
    ORDER BY t.created_at DESC
    LIMIT 1
  `;

  let stops;
  if (trip) {
    stops = await sql`
      SELECT ts.id, ts.name, ts.stop_order, COALESCE(tss.stop_order, ts.stop_order) AS exec_order,
             ts.latitude, ts.longitude,
             tss.status, tss.arrival_time AS reached_at,
             COUNT(stx.id)::int AS assigned_students
      FROM transport_stops ts
      LEFT JOIN trip_stop_status tss ON tss.stop_id = ts.id AND tss.trip_id = ${trip.id} AND tss.school_id = ${req.schoolId}
      LEFT JOIN student_transport stx ON stx.stop_id = ts.id AND stx.school_id = ${req.schoolId} AND stx.is_active = true
      WHERE ts.route_id = ${routeId}
        AND ts.school_id = ${req.schoolId}
        AND ts.deleted_at IS NULL
      GROUP BY ts.id, ts.name, ts.stop_order, ts.latitude, ts.longitude, tss.status, tss.arrival_time, tss.stop_order
      ORDER BY COALESCE(tss.stop_order, ts.stop_order) ASC
    `;
  } else {
    stops = await sql`
      SELECT ts.id, ts.name, ts.stop_order, ts.latitude, ts.longitude,
             NULL::varchar AS status, NULL::timestamptz AS reached_at,
             COUNT(stx.id)::int AS assigned_students
      FROM transport_stops ts
      LEFT JOIN student_transport stx ON stx.stop_id = ts.id AND stx.school_id = ${req.schoolId} AND stx.is_active = true
      WHERE ts.route_id = ${routeId}
        AND ts.school_id = ${req.schoolId}
        AND ts.deleted_at IS NULL
      GROUP BY ts.id, ts.name, ts.stop_order, ts.latitude, ts.longitude
      ORDER BY ts.stop_order ASC
    `;
  }

  return sendSuccess(res, req.schoolId, {
    route: route.name,
    trip: trip ? { ...trip, ui_status: mapTripUiStatus(trip.status) } : null,
    stops,
  });
}));

router.get('/live-today', requirePermission('transport.view'), asyncHandler(async (req, res) => {
  const today = kolkataDate();
  const limit = Math.min(Number(req.query.limit) || 80, 200);

  const rows = await sql`
    SELECT r.id AS route_id, r.name AS route_name,
           t.id AS trip_id, t.status, t.started_at, t.ended_at,
           p.display_name AS driver_name,
           (
             SELECT tsp.name FROM trip_stop_status tss
             JOIN transport_stops tsp ON tsp.id = tss.stop_id AND tsp.school_id = ${req.schoolId}
             WHERE tss.trip_id = t.id AND tss.status = 'completed' AND tss.school_id = ${req.schoolId}
             ORDER BY tss.stop_order DESC LIMIT 1
           ) AS last_stop_name
    FROM transport_routes r
    LEFT JOIN LATERAL (
      SELECT tr.*
      FROM trips tr
      WHERE tr.route_id = r.id
        AND tr.school_id = ${req.schoolId}
        AND (
          tr.trip_date = ${today}
          OR (
            tr.trip_date IS NULL
            AND COALESCE(tr.started_at, tr.created_at)::date = ${today}::date
          )
        )
      ORDER BY tr.created_at DESC
      LIMIT 1
    ) t ON TRUE
    LEFT JOIN staff st ON t.driver_id = st.id AND st.school_id = ${req.schoolId}
    LEFT JOIN persons p ON st.person_id = p.id
    WHERE r.school_id = ${req.schoolId}
      AND r.deleted_at IS NULL
    ORDER BY r.name
    LIMIT ${limit}
  `;

  return sendSuccess(res, req.schoolId, rows);
}));

// ── Driver Bus Attendance Settings ──────────────────────────────────────────
router.get('/driver/bus-attendance/settings', requireAuth, asyncHandler(async (req, res) => {
  const [row] = await sql`
    SELECT value FROM school_settings
    WHERE school_id = ${req.schoolId} AND key = 'enable_driver_bus_attendance'
    LIMIT 1
  `;
  return sendSuccess(res, req.schoolId, { enabled: row?.value === 'true' });
}));

// ── Driver Bus Attendance Stop Students ───────────────────────────────────────
router.get('/driver/bus-attendance/stop/:stopId/students', requireAuth, asyncHandler(async (req, res) => {
  const { stopId } = req.params;
  const { trip_id, date } = req.query;
  const attendanceDate = date || new Date().toISOString().split('T')[0];

  const students = await sql`
    SELECT
      stu.id as student_id,
      stu.admission_no,
      p.display_name as student_name,
      p.photo_url,
      c.name as class_name,
      sec.name as section_name,
      ba.id as attendance_id,
      ba.status as attendance_status,
      ba.marked_at
    FROM student_transport st
    JOIN students stu ON st.student_id = stu.id AND stu.school_id = ${req.schoolId}
    JOIN persons p ON stu.person_id = p.id
    LEFT JOIN student_enrollments se ON se.student_id = stu.id AND se.status = 'active' AND se.deleted_at IS NULL
    LEFT JOIN class_sections csec ON se.class_section_id = csec.id
    LEFT JOIN classes c ON csec.class_id = c.id
    LEFT JOIN sections sec ON csec.section_id = sec.id
    LEFT JOIN bus_stop_attendance ba ON ba.student_id = stu.id 
      AND ba.stop_id = ${stopId}
      AND ba.school_id = ${req.schoolId}
      AND ba.attendance_date = ${attendanceDate}
      ${trip_id ? sql`AND ba.trip_id = ${trip_id}` : sql``}
    WHERE st.stop_id = ${stopId}
      AND st.school_id = ${req.schoolId}
      AND st.is_active = true
    ORDER BY p.display_name ASC
  `;

  return sendSuccess(res, req.schoolId, students);
}));

// ── Driver Bus Attendance Mark (Bulk) ─────────────────────────────────────────
router.post('/driver/bus-attendance/mark', requireAuth, asyncHandler(async (req, res) => {
  const { trip_id, stop_id, route_id, date, attendance } = req.body;
  const attendanceDate = date || new Date().toISOString().split('T')[0];

  if (!trip_id || !stop_id || !route_id || !attendance || !Array.isArray(attendance)) {
    return res.status(400).json({ error: 'trip_id, stop_id, route_id, and attendance array are required' });
  }

  const staffId = await getStaffId(req.user);
  if (!staffId) return res.status(403).json({ error: 'Staff profile not found' });

  const [trip] = await sql`
    SELECT id, status FROM trips
    WHERE id = ${trip_id} AND school_id = ${req.schoolId} AND driver_id = ${staffId}
    LIMIT 1
  `;
  if (!trip) {
    return res.status(404).json({ error: 'Trip not found or does not belong to you' });
  }

  const rows = (attendance || []).filter((r) => r?.student_id && r?.status);
  
  if (rows.length === 0) {
    return res.status(400).json({ error: 'No valid attendance records provided' });
  }

  const studentIds = rows.map(r => String(r.student_id));
  const statuses = rows.map(r => String(r.status));

  const upserted = await sql`
    INSERT INTO bus_stop_attendance (
      school_id, trip_id, stop_id, route_id, driver_id, student_id, attendance_date, status, marked_at
    )
    SELECT
      ${req.schoolId},
      ${trip_id}::uuid,
      ${stop_id}::uuid,
      ${route_id}::uuid,
      ${staffId}::uuid,
      u.student_id::uuid,
      ${attendanceDate}::date,
      u.status,
      NOW()
    FROM unnest(
      ${sql.array(studentIds)}::uuid[],
      ${sql.array(statuses)}::text[]
    ) AS u(student_id, status)
    ON CONFLICT (school_id, trip_id, stop_id, student_id, attendance_date)
    DO UPDATE SET
      status = EXCLUDED.status,
      marked_at = NOW(),
      updated_at = NOW()
    RETURNING id, student_id, status
  `;

  // Trigger parent notifications in background — present → bus_present sound,
  // absent → absent-alert sound. Fire-and-forget; never blocks the response.
  const statusByStudent = new Map(upserted.map(r => [r.student_id, r.status]));
  const affectedStudentIds = [...statusByStudent.keys()];
  if (affectedStudentIds.length > 0) {
    (async () => {
      try {
        const [stop] = await sql`
          SELECT name FROM transport_stops
          WHERE id = ${stop_id} AND school_id = ${req.schoolId}
          LIMIT 1
        `;

        const parentNotifications = await sql`
          SELECT
            u.id as user_id,
            sp.student_id,
            p_student.display_name as student_name
          FROM student_parents sp
          JOIN parents p_parent ON sp.parent_id = p_parent.id AND p_parent.school_id = ${req.schoolId}
          JOIN users u ON p_parent.person_id = u.person_id AND u.school_id = ${req.schoolId}
          JOIN students s ON sp.student_id = s.id AND s.school_id = ${req.schoolId}
          JOIN persons p_student ON s.person_id = p_student.id
          WHERE sp.student_id = ANY(${sql.array(affectedStudentIds)}::uuid[])
            AND sp.school_id = ${req.schoolId}
            AND u.account_status = 'active'
        `;

        for (const pn of parentNotifications) {
          const eventKey = statusByStudent.get(pn.student_id) === 'present'
            ? 'STUDENT_BUS_PRESENT'
            : 'STUDENT_BUS_ABSENT';
          try {
            await sendNotificationToUsers(
              [pn.user_id],
              eventKey,
              {
                studentName: pn.student_name,
                stopName: stop?.name || 'stop'
              }
            );
          } catch (err) {
            console.warn(`Failed to send ${eventKey} notification:`, err);
          }
        }
      } catch (err) {
        console.error('Error sending bus attendance parent notifications:', err);
      }
    })();
  }

  return sendSuccess(res, req.schoolId, {
    message: 'Attendance saved successfully',
    count: upserted.length,
    records: upserted
  }, 201);
}));

// ── Driver Bus Attendance Summary ─────────────────────────────────────────────
router.get('/driver/bus-attendance/summary', requireAuth, asyncHandler(async (req, res) => {
  const { trip_id } = req.query;
  if (!trip_id) {
    return res.status(400).json({ error: 'trip_id is required' });
  }

  const summary = await sql`
    SELECT
      ts.id as stop_id,
      ts.name as stop_name,
      COUNT(ba.id) FILTER (WHERE ba.status = 'present') as present_count,
      COUNT(ba.id) FILTER (WHERE ba.status = 'absent') as absent_count,
      (
        SELECT COUNT(*)
        FROM student_transport st
        WHERE st.stop_id = ts.id AND st.school_id = ${req.schoolId} AND st.is_active = true
      ) as total_assigned
    FROM trip_stop_status tss
    JOIN transport_stops ts ON tss.stop_id = ts.id AND ts.school_id = ${req.schoolId}
    LEFT JOIN bus_stop_attendance ba ON ba.stop_id = ts.id AND ba.trip_id = ${trip_id} AND ba.school_id = ${req.schoolId}
    WHERE tss.trip_id = ${trip_id} AND tss.school_id = ${req.schoolId}
    GROUP BY ts.id, ts.name, tss.stop_order
    ORDER BY tss.stop_order ASC
  `;

  return sendSuccess(res, req.schoolId, summary);
}));

// ── Student/Parent Bus Attendance History ─────────────────────────────────────
router.get('/my-attendance', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const studentId = await resolveStudentId(req);

  if (!studentId) {
    return res.status(404).json({ error: 'No student profile found' });
  }

  const history = await sql`
    SELECT
      ba.id,
      ba.attendance_date,
      ba.status,
      ba.marked_at,
      ts.name as stop_name,
      tr.name as route_name
    FROM bus_stop_attendance ba
    JOIN transport_stops ts ON ba.stop_id = ts.id AND ts.school_id = ${schoolId}
    JOIN transport_routes tr ON ba.route_id = tr.id AND tr.school_id = ${schoolId}
    WHERE ba.student_id = ${studentId}
      AND ba.school_id = ${schoolId}
    ORDER BY ba.attendance_date DESC, ba.marked_at DESC
    LIMIT 50
  `;

  return sendSuccess(res, schoolId, history);
}));

export default router;
