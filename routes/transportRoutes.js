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

const router = express.Router();

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

const SCHOOL_COORDINATES = { latitude: 28.6139, longitude: 77.2090 };

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

  return sendSuccess(res, req.schoolId, { ...route, stops, bus });
}));

/**
 * PUT /transport/routes/:id
 * Update a route
 */
router.put('/routes/:id', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, name_te, code, description, description_te, start_point, start_point_te, end_point, end_point_te, monthly_fee, direction, bus_id, is_active } = req.body;

  // T3 FIX: Ownership check first
  const [existing] = await sql`SELECT id FROM transport_routes WHERE id = ${id} AND school_id = ${req.schoolId}`;
  if (!existing) return res.status(404).json({ error: 'Route not found' });

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
      bus_id = COALESCE(${bus_id ?? null}, bus_id),
      is_active = COALESCE(${is_active ?? null}, is_active)
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
    WHERE CURRENT_DATE BETWEEN start_date AND end_date
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
      MAX(r.name) as route_name,
      COUNT(DISTINCT r.id) as route_count
    FROM buses b
    LEFT JOIN staff s ON b.driver_id = s.id AND s.school_id = ${req.schoolId}
    LEFT JOIN persons p ON s.person_id = p.id
    LEFT JOIN transport_routes r ON r.bus_id = b.id AND r.is_active = true
    WHERE b.deleted_at IS NULL AND b.school_id = ${req.schoolId}
    GROUP BY b.id, p.display_name, s.staff_code, b.driver_name
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

  // T5 FIX: Ownership check first
  const [existing] = await sql`SELECT id FROM buses WHERE id = ${id} AND school_id = ${req.schoolId}`;
  if (!existing) return res.status(404).json({ error: 'Bus not found' });

  const [bus] = await sql`
    UPDATE buses SET
      bus_no = COALESCE(${bus_no ?? null}, bus_no),
      registration_no = COALESCE(${registration_no ?? null}, registration_no),
      capacity = COALESCE(${capacity ?? null}, capacity),
      driver_id = COALESCE(${driver_id ?? null}, driver_id),
      is_active = COALESCE(${is_active ?? null}, is_active)
    WHERE id = ${id} AND school_id = ${req.schoolId}
    RETURNING *
  `;

  if (!bus) return res.status(404).json({ error: 'Bus not found' });
  return sendSuccess(res, req.schoolId, { message: 'Bus updated', bus });
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
            'section_name', sec.name
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

  const todayStart = new Date().toISOString().slice(0, 10);

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

  // Validate trip is active and belongs to this driver (B2: school_id scoped)
  const staffId = await getStaffId(req.user);
  const [trip] = await sql`
    SELECT id, driver_id, status FROM trips WHERE id = ${tripId} AND school_id = ${req.schoolId}
  `;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!tripStatusIsLive(trip.status)) return res.status(400).json({ error: 'Trip is not active' });
  if (trip.driver_id !== staffId) return res.status(403).json({ error: 'This is not your trip' });

  // Get the target stop status
  const [targetStop] = await sql`
    SELECT id, stop_order, status FROM trip_stop_status
    WHERE trip_id = ${tripId} AND stop_id = ${stopId}
  `;
  if (!targetStop) return res.status(404).json({ error: 'Stop not found in this trip' });
  if (targetStop.status !== 'pending') {
    return res.status(400).json({ error: `Stop is already ${targetStop.status}` });
  }

  // ORDER ENFORCEMENT: Check all previous stops are completed/skipped
  const incomplete = await sql`
    SELECT id, stop_order, status FROM trip_stop_status
    WHERE trip_id = ${tripId}
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
    UPDATE trip_stop_status SET status = 'arrived', arrival_time = now()
    WHERE id = ${targetStop.id}
      AND school_id = ${req.schoolId}
    RETURNING *
  `;

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
    SELECT id, status FROM trip_stop_status WHERE trip_id = ${tripId} AND stop_id = ${stopId}
  `;
  if (!targetStop) return res.status(404).json({ error: 'Stop not found in this trip' });
  if (targetStop.status !== 'arrived') {
    return res.status(400).json({ error: `Stop must be in 'arrived' status to complete. Current: ${targetStop.status}` });
  }

  const [updated] = await sql`
    UPDATE trip_stop_status SET status = 'completed', departure_time = now()
    WHERE id = ${targetStop.id}
      AND school_id = ${req.schoolId}
    RETURNING *
  `;

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
    SELECT id, stop_order, status FROM trip_stop_status WHERE trip_id = ${tripId} AND stop_id = ${stopId}
  `;
  if (!targetStop) return res.status(404).json({ error: 'Stop not found' });
  if (targetStop.status === 'completed') return res.status(400).json({ error: 'Cannot skip a completed stop' });

  // ORDER ENFORCEMENT
  const incomplete = await sql`
    SELECT id FROM trip_stop_status
    WHERE trip_id = ${tripId} AND stop_order < ${targetStop.stop_order}
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

  // Mark all remaining pending/arrived stops as skipped
  await sql`
    UPDATE trip_stop_status SET status = 'skipped', departure_time = now()
    WHERE trip_id = ${tripId}
      AND school_id = ${req.schoolId} AND status IN ('pending', 'arrived')
  `;

  // End trip
  const [ended] = await sql`
    UPDATE trips SET status = 'completed', ended_at = now()
    WHERE id = ${tripId}
      AND school_id = ${req.schoolId}
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Trip ended', trip: ended });
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
router.post('/buses/:id/location', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { latitude, longitude, speed, heading, is_mocked = false } = req.body;

  if (!latitude || !longitude) {
    return res.status(400).json({ error: 'latitude and longitude are required' });
  }

  // B2: Verify bus belongs to this school
  const [busCheck] = await sql`SELECT id FROM buses WHERE id = ${id} AND school_id = ${req.schoolId}`;
  if (!busCheck) return res.status(404).json({ error: 'Bus not found' });

  // Rate limit (drop if < 5s apart)
  const [lastLoc] = await sql`SELECT recorded_at FROM bus_locations WHERE bus_id = ${id}`;
  if (lastLoc?.recorded_at) {
    const secondsSinceLast = (new Date() - new Date(lastLoc.recorded_at)) / 1000;
    if (secondsSinceLast < 5) {
      return sendSuccess(res, req.schoolId, { status: 'rate_limited_ignored' });
    }
  }

  const is_suspicious = is_mocked;

  // Geofence check (100m from school)
  const distKm = calculateDistanceKm(latitude, longitude, SCHOOL_COORDINATES.latitude, SCHOOL_COORDINATES.longitude);
  const isAtSchool = distKm <= 0.1;

  if (isAtSchool) {

  }

  // Upsert single realtime row
  const [location] = await sql`
    INSERT INTO bus_locations (school_id, bus_id, latitude, longitude, speed, heading, recorded_at, is_mocked, is_suspicious)
    VALUES (${req.schoolId}, ${id}, ${latitude}, ${longitude}, ${speed}, ${heading}, NOW(), ${is_mocked}, ${is_suspicious})
    ON CONFLICT (bus_id) DO UPDATE SET
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      speed = EXCLUDED.speed,
      heading = EXCLUDED.heading,
      is_mocked = EXCLUDED.is_mocked,
      is_suspicious = EXCLUDED.is_suspicious,
      recorded_at = NOW()
    RETURNING *
  `;

  // Trip history (async, non-blocking)
  sql`
    INSERT INTO bus_trip_history (school_id, bus_id, latitude, longitude, speed, is_mocked, is_suspicious)
    VALUES (${req.schoolId}, ${id}, ${latitude}, ${longitude}, ${speed}, ${is_mocked}, ${is_suspicious})
  `.catch((e) => {});

  return sendSuccess(res, req.schoolId, { ...location, geofence_arrived: isAtSchool }, 201);
}));

/**
 * POST /transport/buses/:id/heartbeat
 */
router.post('/buses/:id/heartbeat', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  await sql`
    INSERT INTO driver_heartbeat (school_id, driver_id, last_ping, status)
    VALUES (${req.schoolId}, ${id}, NOW(), 'online')
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

  const today = new Date().toISOString().slice(0, 10);
  const tripDir = resolveTripDirection(
    routeAssignment.direction,
    tripDirectionParam || inferDefaultTripDirection(routeAssignment.direction),
  );

  let [trip] = await sql`
    SELECT id, status, started_at, ended_at, trip_date, trip_direction
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
        RETURNING id, status, started_at, ended_at, trip_date, trip_direction
      `;
    } catch (e) {
      [trip] = await sql`
        SELECT id, status, started_at, ended_at, trip_date, trip_direction FROM trips
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
  const staffId = await getStaffId(req.user);
  if (!staffId) return res.status(403).json({ error: 'Staff profile not found' });

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
    SET status = 'completed', arrival_time = NOW(), departure_time = NOW()
    WHERE trip_id = ${tripId}
      AND stop_id = ${stopId}
      AND school_id = ${req.schoolId}
      AND status = 'pending'
    RETURNING id, stop_id, status, arrival_time
  `;
  if (!stopStatus) return res.status(409).json({ error: 'Stop already reached or not found' });

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
    getTransportStudentIdsAtStop(notifySchoolId, routeId, nextStop.id)
      .then((studentIds) => sendTransportNotification(
        studentIds,
        'TRANSPORT_BUS_APPROACHING',
        { stopName: nextStop.name },
        notifySchoolId,
      ))
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
    WHERE CURRENT_DATE BETWEEN start_date AND end_date AND school_id = ${schoolId}
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

  const today = new Date().toISOString().slice(0, 10);
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
      SELECT ts.id, ts.name, ts.stop_order, tss.stop_order AS exec_order, tss.status, tss.arrival_time AS reached_at
      FROM trip_stop_status tss
      JOIN transport_stops ts ON tss.stop_id = ts.id AND ts.school_id = ${schoolId}
      WHERE tss.trip_id = ${trip.id}
        AND tss.school_id = ${schoolId}
        AND ts.route_id = ${assignment.route_id}
        AND ts.deleted_at IS NULL
      ORDER BY tss.stop_order ASC
    `;

    const reachedStops = stops.filter((s) => s.status === 'completed');
    currentStop = reachedStops.length > 0 ? reachedStops[reachedStops.length - 1] : null;

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
    boarding_stop_order: assignment.boarding_stop_order,
    trip: tripUi,
    stops,
    current_stop: currentStop,
    stops_until_boarding: stopsUntilBoarding,
  });
}));

router.get('/routes/:routeId/live', requirePermission('transport.view'), asyncHandler(async (req, res) => {
  const { routeId } = req.params;

  const [route] = await sql`
    SELECT id, name FROM transport_routes
    WHERE id = ${routeId} AND school_id = ${req.schoolId}
  `;
  if (!route) return res.status(404).json({ error: 'Route not found' });

  const today = new Date().toISOString().slice(0, 10);
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
  const today = new Date().toISOString().slice(0, 10);
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

export default router;