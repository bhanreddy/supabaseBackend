import sql from '../db.js';
import { checkInVisitor, checkOutVisitor, registerWalkInVisitor, getOrCreateVisitorProfile } from './visitorManagementService.js';
import { issueVisitorPass, revealPassToken } from './visitorQrService.js';
import { sendNotificationToUsers } from './notificationService.js';

export function isVisitorOperationsUser(user = {}) {
  const roles = user.roles || [];
  if (roles.includes('admin') || roles.includes('principal') || roles.includes('gate_keeper') || roles.includes('gatekeeper')) {
    return true;
  }
  const perms = user.permissions || [];
  return ['visitors.scan', 'visitors.checkin', 'visitors.manage', 'visitors.approve'].some((code) => perms.includes(code));
}

export async function resolveLinkedStudentIds(schoolId, user) {
  const userId = user.internal_id || user.id;
  const personId = user.person_id;
  const rows = await sql`
    SELECT s.id
    FROM public.students s
    WHERE s.school_id = ${schoolId}
      AND (
        (${personId || null}::uuid IS NOT NULL AND s.person_id = ${personId || null}::uuid)
        OR s.id IN (
          SELECT sp.student_id FROM public.student_parents sp
          JOIN public.persons p ON p.id = sp.parent_id
          JOIN public.users u ON u.person_id = p.id
          WHERE sp.school_id = ${schoolId} AND u.id = ${userId}
            AND sp.deleted_at IS NULL
        )
      )
  `;
  return rows.map((r) => r.id);
}

export async function cancelVisitorRequest({ schoolId, requestId, userId, reason = 'Cancelled by requester', isStaff = false }) {
  const [existing] = await sql`
    SELECT * FROM public.visitor_requests
    WHERE id = ${requestId} AND school_id = ${schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!existing) {
    const err = new Error('Visitor request not found');
    err.status = 404;
    throw err;
  }
  if (!isStaff && String(existing.requested_by_user_id) !== String(userId)) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  if (!['PENDING', 'APPROVED'].includes(existing.approval_status)) {
    const err = new Error('Request cannot be cancelled in its current state');
    err.status = 400;
    throw err;
  }

  const [updated] = await sql`
    UPDATE public.visitor_requests
    SET approval_status = 'CANCELLED', rejection_reason = ${reason}, updated_at = NOW()
    WHERE id = ${requestId} AND school_id = ${schoolId}
    RETURNING *
  `;

  await sql`
    UPDATE public.visitor_passes
    SET status = 'REVOKED', revoked_at = NOW(), revoked_by = ${userId}, revocation_reason = ${reason}
    WHERE visitor_request_id = ${requestId} AND school_id = ${schoolId} AND status IN ('ACTIVE', 'SCHEDULED')
  `;

  await sql`
    INSERT INTO public.visitor_audit_events (
      school_id, user_id, user_role, event_type, entity_type, entity_id, metadata
    ) VALUES (
      ${schoolId}, ${userId}, 'requester', 'VISITOR_REQUEST_CANCELLED',
      'visitor_requests', ${requestId}, ${sql.json({ reason })}
    )
  `;
  return updated;
}

export async function getRevealablePassToken({ schoolId, requestId, user, allowStaff }) {
  const [row] = await sql`
    SELECT vr.requested_by_user_id, vp.token_encrypted, vp.pass_code, vp.status
    FROM public.visitor_requests vr
    LEFT JOIN public.visitor_passes vp ON vp.visitor_request_id = vr.id
    WHERE vr.id = ${requestId} AND vr.school_id = ${schoolId} AND vr.deleted_at IS NULL
    LIMIT 1
  `;
  if (!row) return null;
  const userId = user.internal_id || user.id;
  const isOwner = String(row.requested_by_user_id) === String(userId);
  if (!isOwner && !allowStaff) return null;
  if (row.status && ['REVOKED', 'EXPIRED'].includes(row.status)) return null;
  return revealPassToken(row) || row.pass_code;
}

export async function syncOfflineGateEvent({
  schoolId,
  gatekeeperUserId,
  clientEventId,
  eventType,
  payload = {},
}) {
  if (!clientEventId) {
    const err = new Error('clientEventId is required');
    err.status = 400;
    throw err;
  }

  const [existing] = await sql`
    SELECT id FROM public.offline_event_sync_log
    WHERE school_id = ${schoolId} AND client_event_id = ${clientEventId}
    LIMIT 1
  `;
  if (existing) {
    return { duplicate: true, synced: true };
  }

  let result = null;
  if (eventType === 'CHECK_IN') {
    result = await checkInVisitor({ schoolId, gatekeeperUserId, ...payload });
  } else if (eventType === 'CHECK_OUT') {
    result = await checkOutVisitor({ schoolId, gatekeeperUserId, ...payload });
  } else if (eventType === 'WALK_IN') {
    const settings = await sql`SELECT offline_walkin_auto_approve FROM public.school_visitor_settings WHERE school_id = ${schoolId} LIMIT 1`;
    if (settings[0] && settings[0].offline_walkin_auto_approve === false) {
      payload = { ...payload };
    }
    result = await registerWalkInVisitor({ schoolId, gatekeeperUserId, ...payload });
  } else {
    const err = new Error('Unsupported offline event type');
    err.status = 400;
    throw err;
  }

  await sql`
    INSERT INTO public.offline_event_sync_log (
      school_id, client_event_id, event_type, gatekeeper_user_id, payload
    ) VALUES (
      ${schoolId}, ${clientEventId}, ${eventType}, ${gatekeeperUserId}, ${sql.json(payload || {})}
    )
    ON CONFLICT (school_id, client_event_id) DO NOTHING
  `;

  return { duplicate: false, synced: true, result };
}

export async function searchCampusVisitors(schoolId, { query, limit = 20 } = {}) {
  const pattern = `%${String(query || '').trim()}%`;
  if (pattern === '%%') return [];
  return sql`
    SELECT
      vprof.id AS profile_id,
      vprof.full_name AS visitor_name,
      vprof.mobile_number,
      vprof.visitor_type,
      vr.id AS request_id,
      vr.approval_status,
      vr.purpose,
      vr.visit_date,
      vc.id AS checkin_id,
      vc.checked_out_at
    FROM public.visitor_profiles vprof
    LEFT JOIN public.visitor_requests vr ON vr.visitor_profile_id = vprof.id AND vr.school_id = vprof.school_id
    LEFT JOIN public.visitor_checkins vc ON vc.visitor_request_id = vr.id
    WHERE vprof.school_id = ${schoolId}
      AND vprof.deleted_at IS NULL
      AND (
        vprof.full_name ILIKE ${pattern}
        OR vprof.mobile_number ILIKE ${pattern}
        OR vr.vehicle_number ILIKE ${pattern}
        OR vr.purpose ILIKE ${pattern}
      )
    ORDER BY vr.created_at DESC NULLS LAST
    LIMIT ${Math.min(50, Number(limit) || 20)}
  `;
}

export async function listVehicles(schoolId, { insideOnly = false } = {}) {
  return sql`
    SELECT vv.*, vprof.full_name AS visitor_name, sg.name AS entry_gate_name
    FROM public.visitor_vehicles vv
    LEFT JOIN public.visitor_profiles vprof ON vprof.id = vv.visitor_profile_id
    LEFT JOIN public.school_gates sg ON sg.id = vv.entry_gate_id
    WHERE vv.school_id = ${schoolId}
      ${insideOnly ? sql`AND vv.exit_time IS NULL` : sql``}
    ORDER BY vv.entry_time DESC
    LIMIT 200
  `;
}

export async function recordVehicleEntry({
  schoolId,
  visitorProfileId = null,
  vehicleType = 'CAR',
  registrationNumber,
  entryGateId,
  parkingSlot = null,
  notes = null,
}) {
  const [row] = await sql`
    INSERT INTO public.visitor_vehicles (
      school_id, visitor_profile_id, vehicle_type, registration_number,
      entry_gate_id, parking_slot, notes
    ) VALUES (
      ${schoolId}, ${visitorProfileId}, ${vehicleType}, ${String(registrationNumber).trim().toUpperCase()},
      ${entryGateId}, ${parkingSlot}, ${notes}
    )
    RETURNING *
  `;
  return row;
}

export async function createContractorPass({
  schoolId,
  fullName,
  mobileNumber,
  companyName,
  contractReference = null,
  validFrom,
  validUntil,
  allowedStartTime = '08:00',
  allowedEndTime = '18:00',
  allowedGateIds = [],
  visitFrequency = 'DAILY',
  notes = null,
}) {
  const visitorProfile = await getOrCreateVisitorProfile({
    schoolId,
    fullName,
    mobileNumber,
    visitorType: 'CONTRACTOR',
  });

  const dummyRequest = await sql`
    INSERT INTO public.visitor_requests (
      school_id, visitor_profile_id, requested_by_role, visitor_type,
      visit_date, start_time, end_time, purpose, approval_status, approval_policy
    ) VALUES (
      ${schoolId}, ${visitorProfile.id}, 'ADMIN', 'CONTRACTOR',
      ${validFrom}, ${allowedStartTime}, ${allowedEndTime}, 'Recurring contractor access',
      'APPROVED', 'ADMIN_APPROVAL'
    )
    RETURNING *
  `;

  const issued = await issueVisitorPass({
    schoolId,
    requestId: dummyRequest[0].id,
    visitDate: validFrom,
    startTime: allowedStartTime,
    endTime: allowedEndTime,
    passType: 'CONTRACTOR',
    maxEntries: 999,
  });

  await sql`
    UPDATE public.visitor_passes
    SET valid_until = ${new Date(`${validUntil}T${allowedEndTime}`)}
    WHERE id = ${issued.pass.id}
  `;

  const [contractor] = await sql`
    INSERT INTO public.visitor_contractor_passes (
      school_id, visitor_profile_id, company_name, contract_reference,
      visitor_pass_id, allowed_gate_ids, valid_from, valid_until,
      allowed_start_time, allowed_end_time, visit_frequency, notes
    ) VALUES (
      ${schoolId}, ${visitorProfile.id}, ${companyName.trim()}, ${contractReference},
      ${issued.pass.id}, ${allowedGateIds}, ${validFrom}, ${validUntil},
      ${allowedStartTime}, ${allowedEndTime}, ${visitFrequency}, ${notes}
    )
    RETURNING *
  `;

  return { contractor, qrToken: issued.qrToken, pass: issued.pass, profile: visitorProfile };
}

export async function listContractorPasses(schoolId) {
  return sql`
    SELECT cp.*, vprof.full_name, vprof.mobile_number, vp.pass_code, vp.status AS pass_status
    FROM public.visitor_contractor_passes cp
    JOIN public.visitor_profiles vprof ON vprof.id = cp.visitor_profile_id
    LEFT JOIN public.visitor_passes vp ON vp.id = cp.visitor_pass_id
    WHERE cp.school_id = ${schoolId} AND cp.deleted_at IS NULL
    ORDER BY cp.created_at DESC
  `;
}

export async function bookAppointment({
  schoolId,
  hostUserId,
  requestedByUserId,
  appointmentDate,
  startTime,
  endTime,
  visitorRequestId = null,
}) {
  try {
    const [row] = await sql`
      INSERT INTO public.visitor_appointments (
        school_id, host_user_id, requested_by_user_id, visitor_request_id,
        appointment_date, start_time, end_time, status
      ) VALUES (
        ${schoolId}, ${hostUserId}, ${requestedByUserId}, ${visitorRequestId},
        ${appointmentDate}, ${startTime}, ${endTime}, 'BOOKED'
      )
      RETURNING *
    `;
    return row;
  } catch (err) {
    if (String(err.message || '').includes('idx_appointment_no_double_book')) {
      const conflict = new Error('That appointment slot is already booked');
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }
}

export async function listAppointmentSlots(schoolId, { hostUserId } = {}) {
  return sql`
    SELECT * FROM public.visitor_appointment_slots
    WHERE school_id = ${schoolId}
      AND is_active = true
      ${hostUserId ? sql`AND host_user_id = ${hostUserId}` : sql``}
    ORDER BY day_of_week, start_time
  `;
}

export async function upsertAppointmentSlot({
  schoolId,
  hostUserId,
  department = null,
  dayOfWeek,
  startTime,
  endTime,
  slotDurationMinutes = 30,
  maxAppointments = 1,
}) {
  const [row] = await sql`
    INSERT INTO public.visitor_appointment_slots (
      school_id, host_user_id, department, day_of_week, start_time, end_time,
      slot_duration_minutes, max_appointments
    ) VALUES (
      ${schoolId}, ${hostUserId}, ${department}, ${dayOfWeek}, ${startTime}, ${endTime},
      ${slotDurationMinutes}, ${maxAppointments}
    )
    ON CONFLICT (school_id, host_user_id, day_of_week, start_time)
    DO UPDATE SET end_time = EXCLUDED.end_time, slot_duration_minutes = EXCLUDED.slot_duration_minutes,
      max_appointments = EXCLUDED.max_appointments, is_active = true, department = EXCLUDED.department
    RETURNING *
  `;
  return row;
}

export async function listTodayOfflineCache(schoolId) {
  return sql`
    SELECT vp.pass_code, vp.valid_from, vp.valid_until, vp.max_entries, vp.entry_count, vp.status,
      vr.id AS request_id, vprof.full_name AS visitor_name, vprof.mobile_number, vprof.visitor_type,
      vprof.profile_photo_url, vr.purpose, vr.gate_id
    FROM public.visitor_passes vp
    JOIN public.visitor_requests vr ON vr.id = vp.visitor_request_id
    JOIN public.visitor_profiles vprof ON vprof.id = vr.visitor_profile_id
    WHERE vp.school_id = ${schoolId}
      AND vr.visit_date = CURRENT_DATE
      AND vp.status = 'ACTIVE'
      AND vr.approval_status = 'APPROVED'
  `;
}

export function buildDigitalBadge(request) {
  return {
    visitorName: request.visitor_name,
    visitorType: request.visitor_type,
    destination: request.destination_department,
    checkInTime: request.checked_in_at || null,
    passNumber: request.pass_code,
    schoolBranding: true,
    printReady: {
      widthMm: 80,
      template: 'thermal_badge_v1',
    },
  };
}
