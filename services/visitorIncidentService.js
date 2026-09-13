import sql from '../db.js';
import { sendNotificationToUsers } from './notificationService.js';

/**
 * Reports a security incident at a school gate
 */
export async function reportSecurityIncident({
  schoolId,
  reportedByUserId,
  gateId = null,
  visitorProfileId = null,
  checkinId = null,
  incidentType,
  severity = 'MEDIUM',
  description,
  attachments = [],
}) {
  const [incident] = await sql`
    INSERT INTO public.visitor_incidents (
      school_id, gate_id, reported_by, visitor_profile_id, checkin_id,
      incident_type, severity, description, attachments
    ) VALUES (
      ${schoolId}, ${gateId || null}::uuid, ${reportedByUserId || null}::uuid, ${visitorProfileId || null}::uuid, ${checkinId || null}::uuid,
      ${incidentType}, ${severity}, ${description}, ${sql.json(attachments)}
    )
    RETURNING *
  `;

  // Audit event
  await sql`
    INSERT INTO public.visitor_audit_events (
      school_id, user_id, user_role, gate_id, event_type, entity_type, entity_id, metadata
    ) VALUES (
      ${schoolId}, ${reportedByUserId || null}::uuid, 'security', ${gateId || null}::uuid,
      'SECURITY_INCIDENT_CREATED', 'visitor_incidents', ${incident.id},
      ${sql.json({ incidentType, severity, description })}
    )
  `;

  // If HIGH or CRITICAL, notify admin users
  if (severity === 'HIGH' || severity === 'CRITICAL') {
    try {
      const admins = await sql`
        SELECT u.id FROM public.users u
        JOIN public.user_roles ur ON ur.user_id = u.id AND ur.school_id = ${schoolId}
        JOIN public.roles r ON r.id = ur.role_id AND r.code IN ('admin', 'principal')
        WHERE u.school_id = ${schoolId} AND u.account_status = 'active'
      `;
      if (admins.length > 0) {
        await sendNotificationToUsers(
          admins.map((a) => a.id),
          'SECURITY_ALERT',
          {
            title: `CRITICAL SECURITY INCIDENT (${severity})`,
            body: `${incidentType}: ${description.slice(0, 100)}`,
            severity,
            incidentType,
            message: `${incidentType}: ${description.slice(0, 100)}`,
          },
          { schoolId }
        );
      }
    } catch (notifErr) {
      console.error('[VisitorIncidentService] Alert dispatch failed:', notifErr.message);
    }
  }

  return incident;
}

/**
 * Adds an entity (person, mobile, vehicle) to the campus security watchlist
 */
export async function addToWatchlist({
  schoolId,
  name,
  mobile = null,
  vehicleNumber = null,
  idReferenceMasked = null,
  visitorProfileId = null,
  restrictionLevel = 'WARNING',
  reason,
  addedByUserId = null,
}) {
  const [entry] = await sql`
    INSERT INTO public.visitor_watchlist (
      school_id, visitor_profile_id, name, mobile, vehicle_number,
      id_reference_masked, restriction_level, reason, added_by
    ) VALUES (
      ${schoolId}, ${visitorProfileId || null}::uuid, ${name.trim()}, ${mobile ? mobile.trim() : null},
      ${vehicleNumber ? vehicleNumber.trim().toUpperCase() : null},
      ${idReferenceMasked}, ${restrictionLevel}, ${reason.trim()}, ${addedByUserId || null}::uuid
    )
    RETURNING *
  `;

  await sql`
    INSERT INTO public.visitor_audit_events (
      school_id, user_id, user_role, event_type, entity_type, entity_id, metadata
    ) VALUES (
      ${schoolId}, ${addedByUserId || null}::uuid, 'admin', 'WATCHLIST_ENTRY_ADDED',
      'visitor_watchlist', ${entry.id},
      ${sql.json({ name, mobile, vehicleNumber, restrictionLevel, reason })}
    )
  `;

  return entry;
}

/**
 * Activates campus emergency mode and prepares the live muster register
 */
export async function activateEmergencyMode({
  schoolId,
  activatedByUserId,
  incidentType = 'GENERAL',
  notes = null,
}) {
  const emergencyCode = `EMG-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

  const [emergency] = await sql`
    INSERT INTO public.emergency_registers (
      school_id, code, incident_type, activated_by, notes, status
    ) VALUES (
      ${schoolId}, ${emergencyCode}, ${incidentType}, ${activatedByUserId}, ${notes}, 'ACTIVE'
    )
    RETURNING *
  `;

  // Snapshot all visitors currently inside into the emergency register entries
  const insideVisitors = await sql`
    SELECT 
      vc.id AS checkin_id,
      vprof.full_name AS person_name,
      vprof.mobile_number AS contact_number,
      vprof.visitor_type AS person_type,
      host_p.display_name AS host_name,
      sg.name AS gate_entered,
      vc.checked_in_at AS entered_at
    FROM public.visitor_checkins vc
    JOIN public.visitor_profiles vprof ON vprof.id = vc.visitor_profile_id
    JOIN public.visitor_requests vr ON vr.id = vc.visitor_request_id
    LEFT JOIN public.users host_u ON host_u.id = vr.host_user_id
    LEFT JOIN public.persons host_p ON host_p.id = host_u.person_id
    LEFT JOIN public.school_gates sg ON sg.id = vc.gate_id
    WHERE vc.school_id = ${schoolId}
      AND vc.status = 'INSIDE'
      AND vc.checked_out_at IS NULL
  `;

  for (const v of insideVisitors) {
    await sql`
      INSERT INTO public.emergency_register_entries (
        emergency_id, visitor_checkin_id, person_name, person_type,
        contact_number, host_name, gate_entered, entered_at, status
      ) VALUES (
        ${emergency.id}, ${v.checkin_id}, ${v.person_name}, ${v.person_type},
        ${v.contact_number}, ${v.host_name}, ${v.gate_entered}, ${v.entered_at}, 'INSIDE'
      )
    `;
  }

  await sql`
    INSERT INTO public.visitor_audit_events (
      school_id, user_id, user_role, event_type, entity_type, entity_id, metadata
    ) VALUES (
      ${schoolId}, ${activatedByUserId}, 'admin', 'EMERGENCY_MODE_ACTIVATED',
      'emergency_registers', ${emergency.id},
      ${sql.json({ code: emergencyCode, incidentType, snapshotCount: insideVisitors.length })}
    )
  `;

  return { emergency, snapshotCount: insideVisitors.length };
}

/**
 * Resolves an active emergency
 */
export async function resolveEmergencyMode({
  schoolId,
  emergencyId,
  resolvedByUserId,
  notes = null,
}) {
  const [resolved] = await sql`
    UPDATE public.emergency_registers
    SET 
      status = 'RESOLVED',
      resolved_by = ${resolvedByUserId},
      resolved_at = NOW(),
      notes = COALESCE(notes, '') || CASE WHEN ${notes} IS NOT NULL THEN ' | ' || ${notes} ELSE '' END
    WHERE id = ${emergencyId} AND school_id = ${schoolId} AND status = 'ACTIVE'
    RETURNING *
  `;

  return resolved;
}
