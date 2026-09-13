import express from 'express';
import sql from '../db.js';
import { requirePermission, requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  triggerDriverSOS,
  getSafetyDashboard,
  updateIncidentStatus,
  INCIDENT_STATUSES,
} from '../services/transportSafetyService.js';
import { reconcileSafeguardingAttendance } from '../services/transportSafeguardingService.js';

const router = express.Router();

/**
 * Global tenant check and body sanitize
 */
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

/**
 * Driver emergency SOS trigger.
 * Callable only by verified drivers assigned to the vehicle or transport managers/admins.
 */
const handleDriverSos = asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { bus_id, trip_id, lat, lng, reason, notes } = req.body || {};

  if (!bus_id) {
    return res.status(400).json({ error: 'bus_id is required' });
  }

  const userRoles = req.user?.roles || [];
  const userPermissions = req.user?.permissions || [];
  const isTransportManager = userPermissions.includes('transport.manage') || userRoles.includes('admin') || userRoles.includes('superadmin');
  const isDriver = userRoles.includes('driver');

  if (!isTransportManager && !isDriver) {
    return res.status(403).json({ error: 'Unauthorized. Only drivers or transport managers can trigger emergency SOS.' });
  }

  // Resolve driver staff profile if user is a driver
  let driverStaffId = null;
  if (isDriver) {
    const [driverStaff] = await sql`
      SELECT st.id
      FROM staff st
      JOIN users u ON u.person_id = st.person_id
      WHERE u.id = ${req.user.internal_id} AND u.school_id = ${schoolId}
      LIMIT 1
    `;
    driverStaffId = driverStaff?.id || null;

    // If caller is driver and not an admin/manager, ensure driver is assigned to this bus or school
    if (!isTransportManager) {
      const [assignedBus] = await sql`
        SELECT b.id
        FROM buses b
        LEFT JOIN driver_route_assignments dra ON dra.bus_id = b.id OR dra.route_id = b.route_id
        WHERE b.id = ${bus_id}
          AND b.school_id = ${schoolId}
          AND (b.driver_id = ${driverStaffId} OR dra.driver_id = ${driverStaffId})
        LIMIT 1
      `;
      if (!assignedBus) {
        return res.status(403).json({ error: 'Unauthorized. Driver is not assigned to this vehicle.' });
      }
    }
  }

  const result = await triggerDriverSOS({
    schoolId,
    busId: bus_id,
    driverId: driverStaffId,
    tripId: trip_id || null,
    lat: lat ? Number(lat) : null,
    lng: lng ? Number(lng) : null,
    reason: reason || 'EMERGENCY',
    notes: notes || null,
    db: sql,
  });

  return sendSuccess(res, schoolId, result, 201);
});

router.post('/sos', requireAuth, handleDriverSos);
router.post('/safety/sos', requireAuth, handleDriverSos);

/**
 * GET /transport/safety/dashboard
 * Safety center overview metrics and active alerts.
 */
router.get('/safety/dashboard', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const dashboard = await getSafetyDashboard(schoolId, sql);
  return sendSuccess(res, schoolId, dashboard);
}));

/**
 * GET /transport/safety/incidents
 * Search and filter safety incidents.
 */
router.get('/safety/incidents', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { status, incident_type, severity, limit = 50, page = 1 } = req.query;

  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeLimit;

  const [countRow] = await sql`
    SELECT COUNT(*)::int AS total
    FROM transport_safety_incidents tsi
    WHERE tsi.school_id = ${schoolId}
      ${status ? sql`AND tsi.status = ${status}` : sql``}
      ${incident_type ? sql`AND tsi.incident_type = ${incident_type}` : sql``}
      ${severity ? sql`AND COALESCE(tsi.metadata->>'severity', 'warning') = ${severity}` : sql``}
  `;

  const rows = await sql`
    SELECT
      tsi.id,
      tsi.incident_type,
      COALESCE(tsi.metadata->>'severity', 'warning') AS severity,
      tsi.max_value AS speed,
      tsi.threshold_value AS speed_limit,
      tsi.start_latitude AS location_lat,
      tsi.start_longitude AS location_lng,
      tsi.status,
      tsi.metadata,
      tsi.created_at,
      tsi.resolved_at,
      b.registration_no AS bus_no,
      r.name AS route_name,
      p.display_name AS resolved_by_name
    FROM transport_safety_incidents tsi
    LEFT JOIN buses b ON b.id = tsi.vehicle_id
    LEFT JOIN transport_routes r ON r.id = tsi.route_id
    LEFT JOIN users u ON u.id = tsi.resolved_by
    LEFT JOIN persons p ON p.id = u.person_id
    WHERE tsi.school_id = ${schoolId}
      ${status ? sql`AND tsi.status = ${status}` : sql``}
      ${incident_type ? sql`AND tsi.incident_type = ${incident_type}` : sql``}
      ${severity ? sql`AND COALESCE(tsi.metadata->>'severity', 'warning') = ${severity}` : sql``}
    ORDER BY tsi.created_at DESC
    LIMIT ${safeLimit} OFFSET ${offset}
  `;

  return sendSuccess(res, schoolId, {
    incidents: rows,
    pagination: {
      total: countRow?.total || 0,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil((countRow?.total || 0) / safeLimit),
    },
  });
}));

/**
 * PATCH /transport/safety/incidents/:id/acknowledge
 */
router.patch('/safety/incidents/:id/acknowledge', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const incidentId = req.params.id;

  const updated = await updateIncidentStatus(schoolId, incidentId, {
    status: INCIDENT_STATUSES.ACKNOWLEDGED,
    notes: req.body?.notes || null,
    acknowledgedBy: req.user.internal_id,
  }, sql);

  if (!updated) {
    return res.status(404).json({ error: 'Incident not found' });
  }

  return sendSuccess(res, schoolId, updated);
}));

/**
 * PATCH /transport/safety/incidents/:id/resolve
 */
router.patch('/safety/incidents/:id/resolve', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const incidentId = req.params.id;

  const updated = await updateIncidentStatus(schoolId, incidentId, {
    status: INCIDENT_STATUSES.RESOLVED,
    notes: req.body?.notes || null,
    resolvedBy: req.user.internal_id,
  }, sql);

  if (!updated) {
    return res.status(404).json({ error: 'Incident not found' });
  }

  return sendSuccess(res, schoolId, updated);
}));

/**
 * POST /transport/safety/reconcile
 * Trigger safeguarding reconciliation manually.
 */
router.post('/safety/reconcile', requirePermission('transport.manage'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const date = req.body?.date || new Date().toISOString().slice(0, 10);

  const result = await reconcileSafeguardingAttendance({
    schoolId,
    date,
    db: sql,
  });

  return sendSuccess(res, schoolId, result);
}));

export default router;
