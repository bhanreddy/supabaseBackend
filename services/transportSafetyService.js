import sql from '../db.js';
import logger from '../utils/logger.js';
import { getSchoolAutomationRule, RULE_KEYS } from './automationRuleService.js';
import { emitSchoolEvent as publishAutomationEvent, AUTOMATION_EVENTS } from './automationEventService.js';
import { sendNotificationToUsers } from './notificationService.js';

export const INCIDENT_TYPES = {
  OVERSPEED: 'overspeed',
  SOS: 'sos',
  SAFEGUARDING_ANOMALY: 'safeguarding_anomaly',
};

export const INCIDENT_STATUSES = {
  ACTIVE: 'active',
  RECOVERED: 'recovered',
  VERIFICATION_PENDING: 'verification_pending',
  ACKNOWLEDGED: 'acknowledged',
  RESOLVED: 'resolved',
  FALSE_POSITIVE: 'false_positive',
  OPEN: 'active', // backward-compatibility alias
};

/**
 * Pure function to test whether a sequence of GPS fixes constitutes sustained overspeed.
 * Avoids false alarms from temporary GPS multipath spikes.
 *
 * Requirements:
 * - At least `minPoints` consecutive points exceeding `speedLimit`.
 * - Time difference between first and last overspeed point >= `sustainedSeconds`.
 */
export function isSustainedOverspeed(fixes = [], speedLimit = 50, sustainedSeconds = 15, minPoints = 3) {
  if (!fixes || fixes.length < minPoints) {
    return { isOverspeed: false };
  }

  // Sort by timestamp ascending
  const sorted = [...fixes].sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());

  // Find consecutive overspeed sequences
  let consecutive = [];
  let longestConsecutive = [];

  for (const fix of sorted) {
    const speed = Number(fix.speed || 0);
    if (speed > speedLimit) {
      consecutive.push(fix);
      if (consecutive.length > longestConsecutive.length) {
        longestConsecutive = [...consecutive];
      }
    } else {
      consecutive = [];
    }
  }

  if (longestConsecutive.length < minPoints) {
    return { isOverspeed: false };
  }

  const firstTime = new Date(longestConsecutive[0].recorded_at).getTime();
  const lastTime = new Date(longestConsecutive[longestConsecutive.length - 1].recorded_at).getTime();
  const durationSeconds = Math.round((lastTime - firstTime) / 1000);

  if (durationSeconds < sustainedSeconds) {
    return { isOverspeed: false, durationSeconds, pointsCount: longestConsecutive.length };
  }

  const peakSpeed = Math.max(...longestConsecutive.map(f => Number(f.speed || 0)));
  const avgSpeed = Math.round(
    longestConsecutive.reduce((sum, f) => sum + Number(f.speed || 0), 0) / longestConsecutive.length
  );

  return {
    isOverspeed: true,
    durationSeconds,
    pointsCount: longestConsecutive.length,
    peakSpeed,
    avgSpeed,
    firstOverTime: longestConsecutive[0].recorded_at,
    lastOverTime: longestConsecutive[longestConsecutive.length - 1].recorded_at,
  };
}

/**
 * Resolve staff user IDs who hold transport manager / admin permissions.
 */
export async function resolveTransportManagerUserIds(schoolId, db = sql) {
  const rows = await db`
    SELECT DISTINCT u.id AS user_id
    FROM users u
    JOIN user_roles ur ON ur.user_id = u.id AND ur.school_id = ${schoolId}
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE u.school_id = ${schoolId}
      AND u.account_status = 'active'
      AND u.deleted_at IS NULL
      AND p.code IN ('transport.manage', 'school.manage')
  `;
  return rows.map(r => r.user_id);
}

/**
 * Asynchronous evaluation of overspeed condition on newest GPS fix.
 * Non-blocking: called inside setImmediate from GPS batch ingest.
 */
export async function evaluateOverspeed(schoolId, busId, newestFix, db = sql) {
  if (!schoolId || !busId || !newestFix || newestFix.is_mocked) {
    return { checked: false };
  }

  // Fast path: if speed is 0 or null, bypass expensive DB queries
  const currentSpeed = Number(newestFix.speed || 0);
  if (currentSpeed <= 0) {
    return { checked: false, reason: 'SPEED_ZERO_OR_NULL' };
  }

  try {
    const rule = await getSchoolAutomationRule(schoolId, RULE_KEYS.TRANSPORT_OVERSPEED_ALERT);
    if (!rule.is_enabled) {
      return { checked: false, reason: 'RULE_DISABLED' };
    }

    // Resolve bus and route speed limits
    const [busInfo] = await db`
      SELECT
        b.id AS bus_id,
        b.registration_no,
        b.speed_limit_override AS bus_speed_limit,
        r.id AS route_id,
        r.name AS route_name,
        r.speed_limit_override AS route_speed_limit
      FROM buses b
      LEFT JOIN bus_routes br ON br.bus_id = b.id AND br.school_id = ${schoolId}
      LEFT JOIN transport_routes r ON r.id = br.route_id AND r.school_id = ${schoolId}
      WHERE b.id = ${busId} AND b.school_id = ${schoolId}
      LIMIT 1
    `;

    if (!busInfo) {
      return { checked: false, reason: 'BUS_NOT_FOUND' };
    }

    const defaultLimit = Number(rule.trigger_config?.speed_limit_kmh ?? rule.trigger_config?.default_speed_limit) || 50;
    const speedLimit = Number(busInfo.bus_speed_limit ?? busInfo.route_speed_limit ?? defaultLimit);
    const sustainedSeconds = Number(rule.trigger_config?.sustained_seconds ?? rule.trigger_config?.sustained_duration_seconds) || 15;
    const minPoints = Number(rule.trigger_config?.min_points ?? rule.trigger_config?.sustained_points) || 3;
    const cooldownMinutes = Number(rule.trigger_config?.cooldown_minutes) || 30;

    // If current speed is below limit, no overspeed
    if (currentSpeed <= speedLimit) {
      return { isOverspeed: false, speed: currentSpeed, speedLimit };
    }

    // Fetch recent fixes from last 2 minutes
    const recentFixes = await db`
      SELECT speed, recorded_at, latitude, longitude
      FROM bus_trip_history
      WHERE bus_id = ${busId}
        AND school_id = ${schoolId}
        AND recorded_at >= now() - INTERVAL '2 minutes'
        AND is_mocked = false
      ORDER BY recorded_at ASC
    `;

    // Ensure newestFix is present in the list
    const combinedFixes = [...recentFixes];
    if (!combinedFixes.some(f => new Date(f.recorded_at).getTime() === new Date(newestFix.recorded_at).getTime())) {
      combinedFixes.push(newestFix);
    }

    const assessment = isSustainedOverspeed(combinedFixes, speedLimit, sustainedSeconds, minPoints);
    if (!assessment.isOverspeed) {
      return { isOverspeed: false, candidatePoints: assessment.pointsCount };
    }

    // Check cooldown for this bus
    const [activeIncident] = await db`
      SELECT id, created_at, metadata, max_value
      FROM transport_safety_incidents
      WHERE school_id = ${schoolId}
        AND vehicle_id = ${busId}
        AND incident_type = ${INCIDENT_TYPES.OVERSPEED}
        AND status IN ('active', 'acknowledged')
        AND created_at >= now() - make_interval(mins => ${cooldownMinutes})
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (activeIncident) {
      // Cooldown active: update peak speed without creating duplicate incident
      const existingPeak = Number(activeIncident.max_value || activeIncident.metadata?.peak_speed || 0);
      if (assessment.peakSpeed > existingPeak) {
        await db`
          UPDATE transport_safety_incidents
          SET
            max_value = ${assessment.peakSpeed},
            metadata = metadata || ${db.json({
              peak_speed: assessment.peakSpeed,
              last_speed_reading: currentSpeed,
              last_reading_at: newestFix.recorded_at,
            })},
            updated_at = NOW()
          WHERE id = ${activeIncident.id} AND school_id = ${schoolId}
        `;
      }
      return { isOverspeed: true, incidentId: activeIncident.id, cooldownSuppressed: true };
    }

    // Create new incident conforming to transport_safety_incidents schema
    const startedAt = newestFix.recorded_at ? new Date(newestFix.recorded_at) : new Date();
    const [incident] = await db`
      INSERT INTO transport_safety_incidents (
        school_id, vehicle_id, route_id, incident_type,
        start_latitude, start_longitude, max_value, threshold_value, avg_value,
        started_at, duration_seconds, status,
        metadata
      ) VALUES (
        ${schoolId}, ${busId}, ${busInfo.route_id || null},
        ${INCIDENT_TYPES.OVERSPEED},
        ${newestFix.latitude}, ${newestFix.longitude},
        ${assessment.peakSpeed}, ${speedLimit}, ${assessment.avgSpeed},
        ${startedAt}, ${assessment.durationSeconds}, ${INCIDENT_STATUSES.ACTIVE},
        ${db.json({
          severity: 'warning',
          bus_registration_no: busInfo.registration_no,
          route_name: busInfo.route_name,
          peak_speed: assessment.peakSpeed,
          avg_speed: assessment.avgSpeed,
          duration_seconds: assessment.durationSeconds,
          points_count: assessment.pointsCount,
        })}
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    if (!incident) {
      const [winner] = await db`SELECT id FROM transport_safety_incidents
        WHERE school_id=${schoolId} AND vehicle_id=${busId} AND incident_type=${INCIDENT_TYPES.OVERSPEED}
          AND status IN ('active','acknowledged') ORDER BY created_at DESC LIMIT 1`;
      return { isOverspeed: true, incidentId: winner?.id || null, cooldownSuppressed: true };
    }

    // Publish event
    try {
      await publishAutomationEvent(AUTOMATION_EVENTS.TRANSPORT_OVERSPEED, {
        schoolId,
        incidentId: incident.id,
        busId,
        busNo: busInfo.registration_no,
        routeName: busInfo.route_name,
        speed: currentSpeed,
        speedLimit,
        location: { lat: newestFix.latitude, lng: newestFix.longitude },
      });
    } catch (evtErr) {
      logger.error({ err: evtErr.message, incidentId: incident.id }, 'Failed to publish overspeed event');
    }

    // Notify transport managers (resilient, non-blocking)
    try {
      const managers = await resolveTransportManagerUserIds(schoolId, db);
      if (managers.length > 0) {
        await sendNotificationToUsers(
          managers,
          'TRANSPORT_OVERSPEED_ALERT',
          {
            busNo: busInfo.registration_no,
            speed: String(Math.round(currentSpeed)),
            limit: String(speedLimit),
            location: `${newestFix.latitude.toFixed(4)}, ${newestFix.longitude.toFixed(4)}`,
          },
          {
            schoolId,
            deepLink: '/admin/transport',
          }
        );
      }
    } catch (notifyErr) {
      logger.error({ err: notifyErr.message, incidentId: incident.id }, 'Failed to send overspeed notification');
    }

    return {
      isOverspeed: true,
      incidentId: incident.id,
      peakSpeed: assessment.peakSpeed,
      speedLimit,
    };
  } catch (error) {
    logger.error({ err: error.message, schoolId, busId }, 'evaluateOverspeed execution failed');
    return { checked: false, error: error.message };
  }
}

/**
 * Driver emergency SOS trigger.
 */
export async function triggerDriverSOS({
  schoolId,
  busId,
  driverId,
  tripId = null,
  lat = null,
  lng = null,
  reason = 'EMERGENCY',
  notes = null,
  db = sql,
}) {
  if (lat != null && (!Number.isFinite(Number(lat)) || Number(lat) < -90 || Number(lat) > 90)) {
    const error = new Error('Invalid latitude'); error.status = 400; throw error;
  }
  if (lng != null && (!Number.isFinite(Number(lng)) || Number(lng) < -180 || Number(lng) > 180)) {
    const error = new Error('Invalid longitude'); error.status = 400; throw error;
  }
  // Rapid double-tap debounce: check if active SOS logged within 60s for this vehicle
  const [recentSos] = await db`
    SELECT id, created_at
    FROM transport_safety_incidents
    WHERE school_id = ${schoolId}
      AND vehicle_id = ${busId}
      AND incident_type = ${INCIDENT_TYPES.SOS}
      AND status IN ('active', 'acknowledged')
      AND created_at >= NOW() - INTERVAL '60 seconds'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (recentSos) {
    logger.warn({ schoolId, busId, incidentId: recentSos.id }, 'SOS debounced: active SOS already triggered within 60 seconds');
    const [school] = await db`
      SELECT name, contact_phone, emergency_phone FROM schools WHERE id = ${schoolId}
    `;
    return {
      success: true,
      incidentId: recentSos.id,
      debounced: true,
      emergencyContacts: [
        { role: 'School Office', phone: school?.contact_phone || '112' },
        { role: 'Emergency Helpline', phone: school?.emergency_phone || '108' },
        { role: 'Police', phone: '100' },
      ],
    };
  }

  const [bus] = await db`
    SELECT
      b.registration_no,
      r.id AS route_id,
      r.name AS route_name,
      p.display_name AS driver_name
    FROM buses b
    LEFT JOIN bus_routes br ON br.bus_id = b.id AND br.school_id = ${schoolId}
    LEFT JOIN transport_routes r ON r.id = br.route_id AND r.school_id = ${schoolId}
    LEFT JOIN staff st ON st.id = ${driverId} AND st.school_id = ${schoolId}
    LEFT JOIN persons p ON p.id = st.person_id
    WHERE b.id = ${busId} AND b.school_id = ${schoolId}
    LIMIT 1
  `;
  if (!bus) {
    const error = new Error('Bus not found in this school'); error.status = 404; throw error;
  }
  if (tripId) {
    const [trip] = await db`SELECT id FROM trips WHERE id=${tripId} AND school_id=${schoolId}
      AND bus_id=${busId} ${driverId ? db`AND driver_id=${driverId}` : db``} LIMIT 1`;
    if (!trip) {
      const error = new Error('Trip does not belong to this bus and school'); error.status = 404; throw error;
    }
  }

  const driverName = bus?.driver_name || 'Bus Driver';
  const busNo = bus?.registration_no || 'Unknown Bus';
  const routeName = bus?.route_name || 'Unassigned Route';

  const [incident] = await db`
    INSERT INTO transport_safety_incidents (
      school_id, vehicle_id, route_id, driver_id, trip_id, incident_type,
      start_latitude, start_longitude, threshold_value, max_value,
      started_at, status, metadata
    ) VALUES (
      ${schoolId}, ${busId}, ${bus?.route_id || null},
      ${driverId || null}, ${tripId || null},
      ${INCIDENT_TYPES.SOS},
      ${lat}, ${lng},
      null, 0,
      NOW(), ${INCIDENT_STATUSES.ACTIVE},
      ${db.json({
        severity: 'critical',
        driver_id: driverId,
        driver_name: driverName,
        bus_no: busNo,
        route_name: routeName,
        trip_id: tripId,
        reason,
        notes,
        triggered_at: new Date().toISOString(),
      })}
      )
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
  if (!incident) {
    const [winner] = await db`SELECT id FROM transport_safety_incidents
      WHERE school_id=${schoolId} AND vehicle_id=${busId} AND incident_type=${INCIDENT_TYPES.SOS}
        AND status IN ('active','acknowledged') ORDER BY created_at DESC LIMIT 1`;
    return { success: true, incidentId: winner?.id || null, debounced: true, emergencyContacts: [] };
  }

  // Publish event (resilient)
  try {
    await publishAutomationEvent(AUTOMATION_EVENTS.DRIVER_EMERGENCY_SOS, {
      schoolId,
      incidentId: incident.id,
      busId,
      driverId,
      driverName,
      busNo,
      routeName,
      reason,
      location: { lat, lng },
    });
  } catch (evtErr) {
    logger.error({ err: evtErr.message, incidentId: incident.id }, 'Failed to publish SOS event');
  }

  // Emergency push to managers & admins (resilient: database incident persists even if FCM fails)
  try {
    const managers = await resolveTransportManagerUserIds(schoolId, db);
    if (managers.length > 0) {
      await sendNotificationToUsers(
        managers,
        'TRANSPORT_SOS_ALERT',
        {
          driverName,
          busNo,
          routeName,
        },
        {
          schoolId,
          deepLink: '/admin/transport',
        }
      );
    }
  } catch (notifyErr) {
    logger.error({ err: notifyErr.message, incidentId: incident.id }, 'Failed to deliver SOS push notifications');
  }

  // Emergency contacts
  const [school] = await db`
    SELECT name, contact_phone, emergency_phone FROM schools WHERE id = ${schoolId}
  `;

  return {
    success: true,
    incidentId: incident.id,
    debounced: false,
    emergencyContacts: [
      { role: 'School Office', phone: school?.contact_phone || '112' },
      { role: 'Emergency Helpline', phone: school?.emergency_phone || '108' },
      { role: 'Police', phone: '100' },
    ],
  };
}

/**
 * Fetch safety dashboard metrics.
 */
export async function getSafetyDashboard(schoolId, db = sql) {
  const [counts] = await db`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('active', 'acknowledged', 'verification_pending'))::int AS active_incidents,
      COUNT(*) FILTER (WHERE incident_type = 'overspeed' AND created_at >= CURRENT_DATE)::int AS overspeed_today,
      COUNT(*) FILTER (WHERE incident_type = 'sos' AND created_at >= CURRENT_DATE)::int AS sos_today,
      COUNT(*) FILTER (WHERE incident_type = 'safeguarding_anomaly' AND created_at >= CURRENT_DATE)::int AS safeguarding_today
    FROM transport_safety_incidents
    WHERE school_id = ${schoolId}
  `;

  const recentIncidents = await db`
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
    ORDER BY tsi.created_at DESC
    LIMIT 25
  `;

  return {
    metrics: {
      activeIncidents: counts?.active_incidents || 0,
      overspeedToday: counts?.overspeed_today || 0,
      sosToday: counts?.sos_today || 0,
      safeguardingToday: counts?.safeguarding_today || 0,
    },
    recentIncidents,
  };
}

/**
 * Update incident status (acknowledge / resolve).
 */
export async function updateIncidentStatus(schoolId, incidentId, { status, notes = null, resolvedBy = null, acknowledgedBy = null }, db = sql) {
  const validStatuses = ['active', 'acknowledged', 'resolved', 'recovered', 'false_positive', 'verification_pending'];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid incident status: ${status}`);
  }

  const isResolved = ['resolved', 'recovered', 'false_positive'].includes(status);
  const isAcknowledged = status === 'acknowledged';
  const allowedPrevious = isAcknowledged
    ? ['active', 'verification_pending']
    : isResolved
      ? ['active', 'acknowledged', 'verification_pending', 'recovered']
      : [];
  if (!allowedPrevious.length) throw new Error(`Unsupported incident transition target: ${status}`);

  const [updated] = await db`
    UPDATE transport_safety_incidents
    SET
      status = ${status},
      acknowledged_at = CASE WHEN ${isAcknowledged} THEN NOW() ELSE acknowledged_at END,
      acknowledged_by = CASE WHEN ${isAcknowledged} THEN ${acknowledgedBy || resolvedBy} ELSE acknowledged_by END,
      resolved_at = CASE WHEN ${isResolved} THEN NOW() ELSE resolved_at END,
      resolved_by = CASE WHEN ${isResolved} THEN ${resolvedBy} ELSE resolved_by END,
      resolution_notes = CASE WHEN ${notes}::text IS NOT NULL THEN ${notes} ELSE resolution_notes END,
      metadata = CASE
        WHEN ${notes}::text IS NOT NULL THEN metadata || ${db.json({ resolution_notes: notes })}
        ELSE metadata
      END,
      updated_at = NOW()
    WHERE id = ${incidentId} AND school_id = ${schoolId}
      AND status IN ${db(allowedPrevious)}
    RETURNING *
  `;

  return updated;
}
