import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// ============== ROUTES ==============

/**
 * GET /transport/routes
 * List all transport routes
 */
router.get('/routes', requirePermission('transport.view'), asyncHandler(async (req, res) => {
    const { active_only } = req.query;

    const routes = await sql`
    SELECT 
      r.id, r.name, r.code, r.description, r.start_point, r.end_point,
      r.total_stops, r.monthly_fee, r.is_active,
      COUNT(DISTINCT b.id) as bus_count
    FROM transport_routes r
    LEFT JOIN buses b ON r.id = b.route_id AND b.is_active = true
    WHERE TRUE ${active_only === 'true' ? sql`AND r.is_active = true` : sql``}
    GROUP BY r.id
    ORDER BY r.name
  `;

    res.json(routes);
}));

/**
 * POST /transport/routes
 * Create a transport route
 */
router.post('/routes', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
    const { name, code, description, start_point, end_point, monthly_fee } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Route name is required' });
    }

    const [route] = await sql`
    INSERT INTO transport_routes (name, code, description, start_point, end_point, monthly_fee)
    VALUES (${name}, ${code}, ${description}, ${start_point}, ${end_point}, ${monthly_fee})
    RETURNING *
  `;

    res.status(201).json({ message: 'Route created', route });
}));

/**
 * GET /transport/routes/:id
 * Get route with stops
 */
router.get('/routes/:id', requirePermission('transport.view'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [route] = await sql`SELECT * FROM transport_routes WHERE id = ${id}`;
    if (!route) {
        return res.status(404).json({ error: 'Route not found' });
    }

    const stops = await sql`
    SELECT id, name, latitude, longitude, pickup_time, drop_time, stop_order
    FROM transport_stops
    WHERE route_id = ${id}
    ORDER BY stop_order
  `;

    const buses = await sql`
    SELECT id, bus_no, registration_no, capacity, driver_name, driver_phone, is_active
    FROM buses WHERE route_id = ${id}
  `;

    res.json({ ...route, stops, buses });
}));

// ============== STOPS ==============

/**
 * POST /transport/routes/:id/stops
 * Add stop to route
 */
router.post('/routes/:id/stops', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, latitude, longitude, pickup_time, drop_time, stop_order } = req.body;

    if (!name || stop_order === undefined) {
        return res.status(400).json({ error: 'name and stop_order are required' });
    }

    const [stop] = await sql`
    INSERT INTO transport_stops (route_id, name, latitude, longitude, pickup_time, drop_time, stop_order)
    VALUES (${id}, ${name}, ${latitude}, ${longitude}, ${pickup_time}, ${drop_time}, ${stop_order})
    RETURNING *
  `;

    // Update route total_stops
    await sql`UPDATE transport_routes SET total_stops = (SELECT COUNT(*) FROM transport_stops WHERE route_id = ${id}) WHERE id = ${id}`;

    res.status(201).json({ message: 'Stop added', stop });
}));

// ============== BUSES ==============

/**
 * GET /transport/buses
 * List all buses
 */
router.get('/buses', requirePermission('transport.view'), asyncHandler(async (req, res) => {
    const buses = await sql`
    SELECT 
      b.id, b.bus_no, b.registration_no, b.capacity, b.driver_name, b.driver_phone, b.is_active,
      r.name as route_name
    FROM buses b
    LEFT JOIN transport_routes r ON b.route_id = r.id
    ORDER BY b.bus_no
  `;
    res.json(buses);
}));

/**
 * POST /transport/buses
 * Add a bus
 */
router.post('/buses', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
    const { bus_no, registration_no, capacity, driver_name, driver_phone, route_id } = req.body;

    if (!bus_no) {
        return res.status(400).json({ error: 'bus_no is required' });
    }

    const [bus] = await sql`
    INSERT INTO buses (bus_no, registration_no, capacity, driver_name, driver_phone, route_id)
    VALUES (${bus_no}, ${registration_no}, ${capacity || 40}, ${driver_name}, ${driver_phone}, ${route_id})
    RETURNING *
  `;

    res.status(201).json({ message: 'Bus added', bus });
}));

// ============== LIVE TRACKING ==============

/**
 * POST /transport/buses/:id/location
 * Update bus location (from GPS device)
 */
router.post('/buses/:id/location', asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { latitude, longitude, speed, heading } = req.body;

    if (!latitude || !longitude) {
        return res.status(400).json({ error: 'latitude and longitude are required' });
    }

    const [location] = await sql`
    INSERT INTO bus_locations (bus_id, latitude, longitude, speed, heading)
    VALUES (${id}, ${latitude}, ${longitude}, ${speed}, ${heading})
    RETURNING *
  `;

    res.status(201).json(location);
}));

/**
 * GET /transport/buses/:id/location
 * Get current bus location
 */
router.get('/buses/:id/location', requirePermission('transport.view'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [location] = await sql`
    SELECT latitude, longitude, speed, heading, recorded_at
    FROM bus_locations
    WHERE bus_id = ${id}
    ORDER BY recorded_at DESC
    LIMIT 1
  `;

    if (!location) {
        return res.status(404).json({ error: 'No location data available' });
    }

    res.json(location);
}));

// ============== STUDENT ASSIGNMENTS ==============

/**
 * GET /transport/students/:studentId
 * Get student's transport assignment
 */
router.get('/students/:studentId', requirePermission('transport.view'), asyncHandler(async (req, res) => {
    const { studentId } = req.params;

    const [assignment] = await sql`
    SELECT 
      st.id, st.is_active, st.created_at,
      r.name as route_name, r.code as route_code, r.monthly_fee,
      s.name as stop_name, s.pickup_time, s.drop_time
    FROM student_transport st
    JOIN transport_routes r ON st.route_id = r.id
    LEFT JOIN transport_stops s ON st.stop_id = s.id
    WHERE st.student_id = ${studentId} AND st.is_active = true
  `;

    res.json(assignment || { message: 'No transport assigned' });
}));

/**
 * POST /transport/students
 * Assign transport to student
 */
router.post('/students', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
    const { student_id, route_id, stop_id, academic_year_id } = req.body;

    if (!student_id || !route_id || !academic_year_id) {
        return res.status(400).json({ error: 'student_id, route_id, and academic_year_id are required' });
    }

    const [assignment] = await sql`
    INSERT INTO student_transport (student_id, route_id, stop_id, academic_year_id)
    VALUES (${student_id}, ${route_id}, ${stop_id}, ${academic_year_id})
    ON CONFLICT (student_id, academic_year_id) 
    DO UPDATE SET route_id = EXCLUDED.route_id, stop_id = EXCLUDED.stop_id, is_active = true
    RETURNING *
  `;

    res.status(201).json({ message: 'Transport assigned', assignment });
}));

export default router;
