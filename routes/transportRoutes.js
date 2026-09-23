import { transportTripHealth } from '../services/transportHealthService.js';
import transportTrackingRoutes from './transportTrackingRoutes.js';
import { authorizeBusRead,resolveTransportStudent,transportError } from '../services/transportAccessService.js';
import { tripStops,effectiveRouteStops,transportLeg } from '../services/transportTripService.js';
import express from 'express';
import sql from '../db.js';
import { requirePermission, requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { translateFields } from '../services/geminiTranslator.js';
import { resolveStudentId } from '../utils/studentPortal.js';
import {
  getLegCalibrationStatus,
} from '../services/transportCalibrationService.js';
import { normalizeLeg } from '../services/transportCalibrationService.js';
import { computeLearnedEta, segKey } from '../services/transportEtaService.js';
import {
  getRouteCalibrationReview,
  parseCalibrationLeg,
  resetRouteCalibration,
  updateStopGeoOverride,
} from '../services/transportCalibrationAdminService.js';
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

router.use(transportTrackingRoutes);

// ============================================================
// HELPERS
// ============================================================

/**
 * Haversine distance in km between two lat/lon points
 */
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
    JOIN users u ON s.person_id = u.person_id AND s.school_id = u.school_id
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
  const hour = Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
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

  const stops = await effectiveRouteStops(req.schoolId, routeId, tripDirection);
  const counts = await sql`SELECT st.stop_id,count(*)::int AS student_count FROM student_transport st
    JOIN academic_years ay ON ay.id=st.academic_year_id AND ay.school_id=st.school_id
    WHERE st.school_id=${req.schoolId} AND st.route_id=${routeId} AND st.is_active=true
    AND (now() AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ay.start_date AND ay.end_date GROUP BY st.stop_id`;
  const payload = stops.map(stop=>({...stop,student_count:counts.find(c=>c.stop_id===stop.id)?.student_count || 0,
    trip_direction:tripDirection,is_reverse:isReverseTripDirection(tripDirection)}));

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


/**
 * GET /transport/trips/:tripId/status
 * Get full trip status with all stops
 */


/**
 * POST /transport/trips/:tripId/stops/:stopId/arrive
 * Mark a stop as arrived
 *
 * HARD VALIDATION: All previous stops must be completed or skipped
 */


/**
 * POST /transport/trips/:tripId/stops/:stopId/complete
 * Mark a stop as completed
 *
 * HARD VALIDATION: Stop must be in 'arrived' status
 */


/**
 * POST /transport/trips/:tripId/stops/:stopId/skip
 * Mark a stop as skipped (explicit skip)
 *
 * HARD VALIDATION: All previous stops must be completed/skipped
 */


/**
 * POST /transport/trips/:tripId/end
 * End a trip — marks remaining pending stops as skipped
 */


/**
 * GET /transport/trips/history
 * Get driver's trip history
 */
router.get('/trips/history', requireAuth, asyncHandler(async (req, res) => {
  const staffId = await getStaffId(req.user);
  if (!staffId) return res.status(403).json({ error: 'Staff profile not found' });

  const trips = await sql`
    SELECT t.id, t.school_id, t.status, t.started_at, t.ended_at,
      r.name as route_name, r.direction,
      b.bus_no,
      (SELECT COUNT(*) FROM trip_stop_status WHERE trip_id = t.id AND status = 'completed') as completed_stops,
      (SELECT COUNT(*) FROM trip_stop_status WHERE trip_id = t.id) as total_stops
    FROM trips t
    JOIN transport_routes r ON t.route_id = r.id AND r.school_id = ${req.schoolId}
    JOIN buses b ON t.bus_id = b.id AND b.school_id = ${req.schoolId}
    WHERE t.driver_id = ${staffId} AND t.school_id = ${req.schoolId}
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


/**
 * POST /transport/buses/:id/heartbeat
 */


/**
 * GET /transport/buses/:id/location
 * Get current bus location
 */


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

  await authorizeBusRead(req, busId);
  // T10 FIX: Add school_id filter to bus lookup
  const [busCheck] = await sql`SELECT id FROM buses WHERE id = ${busId} AND school_id = ${req.schoolId}`;
  if (!busCheck) return res.status(404).json({ error: 'Bus not found' });

  // Live location
  const [location] = await sql`
    SELECT latitude, longitude, speed, heading, recorded_at
    FROM bus_locations WHERE bus_id = ${busId} AND school_id = ${req.schoolId}
      AND trip_id IN (SELECT id FROM trips WHERE school_id=${req.schoolId} AND bus_id=${busId} AND status IN ('active','in_progress'))
    ORDER BY recorded_at DESC LIMIT 1
  `;

  // Active trip with stops
  const [activeTrip] = await sql`
    SELECT t.id, t.started_at, r.name as route_name
    FROM trips t
    JOIN transport_routes r ON t.route_id = r.id
    WHERE t.bus_id = ${busId} AND t.school_id=${req.schoolId} AND t.status IN ('active', 'in_progress')
    LIMIT 1
  `;

  let stops = [];
  let nextStop = null;

  if (activeTrip) {
    stops = await tripStops({ ...activeTrip, school_id: req.schoolId });
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
  const allValid = orderedStopIds.length === existingIds.size && new Set(orderedStopIds).size === existingIds.size && orderedStopIds.every((id) => existingIds.has(id));
  if (!allValid) return res.status(400).json({ error: 'One or more stop IDs are invalid for this route' });

  const orders = orderedStopIds.map((_, i) => i + 1);
  const orderOffset = orderedStopIds.length + 1000;

  // Two-phase update avoids UNIQUE (school_id, route_id, stop_order) violations
  // when swapping adjacent stops in a single UPDATE.
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM transport_routes WHERE id=${routeId} AND school_id=${req.schoolId} FOR UPDATE`;
    const current = await tx`SELECT id FROM transport_stops WHERE route_id=${routeId} AND school_id=${req.schoolId} AND deleted_at IS NULL FOR UPDATE`;
    if(current.length!==orderedStopIds.length || current.some(s=>!orderedStopIds.includes(s.id))) throw transportError(409,'ROUTE_CHANGED','Route stops changed. Refresh and reorder again.');
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





/**
 * POST .../reach — one-tap checkpoint for new driver UI.
 * trip_stop_status.status CHECK allows: pending | arrived | completed | skipped (schema.sql).
 * This endpoint writes 'completed' for a reached stop (same as legacy two-step arrive+complete).
 * Do not use a separate 'reached' status — it is not in the DB constraint.
 */




router.get('/my-bus', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;

  const studentId = await resolveTransportStudent(req);

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
    JOIN transport_stops tsp ON st.stop_id = tsp.id AND tsp.school_id = ${schoolId} AND tsp.route_id=r.id AND tsp.deleted_at IS NULL
    WHERE st.student_id = ${studentId}
      AND st.school_id = ${schoolId}
      AND st.academic_year_id = ${ay?.id ?? null}
      AND st.is_active = true AND r.deleted_at IS NULL AND r.is_active=true
    LIMIT 1
  `;

  if (!assignment) {
    return sendSuccess(res, schoolId, { assigned: false });
  }

  const today = kolkataDate();
  const [trip] = await sql`
    SELECT t.id, t.school_id, t.status, t.started_at, t.ended_at,
           p.display_name AS driver_name
    FROM trips t
    JOIN staff st ON t.driver_id = st.id AND st.school_id = ${schoolId}
    JOIN persons p ON st.person_id = p.id
    WHERE t.route_id = ${assignment.route_id}
      AND t.school_id = ${schoolId}
      AND (
        t.status IN ('active','in_progress') OR t.trip_date = ${today}
        OR (
          t.trip_date IS NULL
          AND COALESCE(t.started_at, t.created_at)::date = ${today}::date
        )
      )
    ORDER BY (t.status IN ('active','in_progress')) DESC, t.created_at DESC
    LIMIT 1
  `;

  let stops = [];
  let currentStop = null;
  let stopsUntilBoarding = null;

  if (trip) {
    stops = await tripStops({ ...trip, school_id: req.schoolId });

    // An arrived stop is where the bus is now. Once it departs, retain the
    // last completed stop so the timeline still reflects real trip progress.
    const arrivedStop = stops.find((s) => s.status === 'arrived');
    const reachedStops = stops.filter((s) => s.status === 'completed');
    currentStop = arrivedStop || null;

    const boardingStop = stops.find(s=>s.id===assignment.stop_id);
    const nextStop = stops.find(s=>['pending','arrived'].includes(s.status));
    stopsUntilBoarding = boardingStop && nextStop && boardingStop.status==='pending'
      ? Math.max(0,boardingStop.exec_order-nextStop.exec_order) : boardingStop?.status==='arrived' ? 0 : null;
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

  const studentId = await resolveTransportStudent(req);
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
      AND st.academic_year_id = ${ay?.id ?? null}
      AND st.is_active = true AND r.deleted_at IS NULL AND r.is_active=true
    LIMIT 1
  `;
  if (!assignment) {
    return sendSuccess(res, schoolId, { assigned: false, live: false });
  }

  const today = kolkataDate();
  const [trip] = await sql`
    SELECT t.id, t.bus_id, t.status, t.trip_direction, t.started_at
    FROM trips t
    WHERE t.route_id = ${assignment.route_id}
      AND t.school_id = ${schoolId}
      AND t.status IN ('active', 'in_progress')
      AND (
        t.status IN ('active','in_progress') OR t.trip_date = ${today}
        OR (
          t.trip_date IS NULL
          AND COALESCE(t.started_at, t.created_at)::date = ${today}::date
        )
      )
    ORDER BY (t.status IN ('active','in_progress')) DESC, t.created_at DESC
    LIMIT 1
  `;
  if (!trip || !trip.bus_id) {
    return sendSuccess(res, schoolId, { assigned: true, live: false });
  }

  const leg = normalizeLeg(trip.trip_direction);
  const [locations, stopRows, segmentRows] = await Promise.all([
    sql`
      SELECT latitude, longitude, speed, heading, recorded_at
      FROM bus_locations
      WHERE school_id = ${schoolId}
        AND bus_id = ${trip.bus_id}
        AND recorded_at >= ${trip.started_at} AND trip_id=${trip.id}
      ORDER BY recorded_at DESC LIMIT 1
    `,
    tripStops({ ...trip, school_id: schoolId }),
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
    SELECT id, name, direction FROM transport_routes
    WHERE id = ${routeId} AND school_id = ${req.schoolId}
  `;
  if (!route) return res.status(404).json({ error: 'Route not found' });

  const today = kolkataDate();
  const [trip] = await sql`
    SELECT t.id, t.school_id, t.driver_id, t.auto_stops_enabled, t.bus_id, t.status, t.started_at, t.ended_at, t.trip_direction,
           p.display_name AS driver_name
    FROM trips t
    JOIN staff st ON t.driver_id = st.id AND st.school_id = ${req.schoolId}
    JOIN persons p ON st.person_id = p.id
    WHERE t.route_id = ${routeId}
      AND t.school_id = ${req.schoolId}
      AND (
        t.status IN ('active','in_progress') OR t.trip_date = ${today}
        OR (
          t.trip_date IS NULL
          AND COALESCE(t.started_at, t.created_at)::date = ${today}::date
        )
      )
    ORDER BY (t.status IN ('active','in_progress')) DESC, t.created_at DESC
    LIMIT 1
  `;

  let stops;
  let location = null;
  if (trip) {
    stops = await tripStops({ ...trip, school_id: req.schoolId });
  } else {
    stops = await effectiveRouteStops(req.schoolId, routeId, transportLeg(route.direction, req.query.trip_direction));
  }

  // Admin tracking uses the exact same tenant-scoped live fix as parent
  // tracking. A fix from a previous trip is never displayed as current.
  if (trip?.bus_id) {
    const [latestLocation] = await sql`
      SELECT latitude, longitude, speed, heading, recorded_at
      FROM bus_locations
      WHERE school_id = ${req.schoolId}
        AND bus_id = ${trip.bus_id}
        AND recorded_at >= ${trip.started_at} AND trip_id=${trip.id}
      ORDER BY recorded_at DESC
      LIMIT 1
    `;
    if (latestLocation) {
      const ageSeconds = Math.max(0, (Date.now() - new Date(latestLocation.recorded_at).getTime()) / 1000);
      location = {
        latitude: Number(latestLocation.latitude),
        longitude: Number(latestLocation.longitude),
        speed: latestLocation.speed == null ? null : Number(latestLocation.speed),
        heading: latestLocation.heading == null ? null : Number(latestLocation.heading),
        recorded_at: latestLocation.recorded_at,
        age_seconds: ageSeconds,
        is_fresh: ageSeconds <= LOCATION_FRESH_SECONDS,
      };
    }
  }

  return sendSuccess(res, req.schoolId, {
    route: route.name,
    tracking_health: await transportTripHealth(req.schoolId, trip),
    trip: trip ? { ...trip, ui_status: mapTripUiStatus(trip.status) } : null,
    stops,
    location,
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
          tr.status IN ('active','in_progress') OR tr.trip_date = ${today}
          OR (
            tr.trip_date IS NULL
            AND COALESCE(tr.started_at, tr.created_at)::date = ${today}::date
          )
        )
      ORDER BY (tr.status IN ('active','in_progress')) DESC, tr.created_at DESC
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


// ── Driver Bus Attendance Mark (Bulk) ─────────────────────────────────────────


// ── Driver Bus Attendance Summary ─────────────────────────────────────────────


// ── Student/Parent Bus Attendance History ─────────────────────────────────────
router.get('/my-attendance', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const studentId = await resolveTransportStudent(req);

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
