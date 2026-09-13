import sql from '../db.js';
import { validateVisitorPassToken, issueVisitorPass, hashPassToken } from './visitorQrService.js';
import { resolveApprovalPolicy, approveVisitorRequest } from './visitorApprovalService.js';
import { sendNotificationToUsers } from './notificationService.js';

/**
 * Finds or creates a reusable visitor profile within a school
 */
export async function getOrCreateVisitorProfile({
  schoolId,
  fullName,
  mobileNumber,
  email = null,
  visitorType = 'PARENT',
  relationship = null,
  profilePhotoUrl = null,
  idType = null,
  idReferenceMasked = null,
}) {
  const cleanMobile = String(mobileNumber).trim();
  const cleanName = String(fullName).trim();

  const [existing] = await sql`
    SELECT * FROM public.visitor_profiles
    WHERE school_id = ${schoolId} AND mobile_number = ${cleanMobile} AND deleted_at IS NULL
    LIMIT 1
  `;

  if (existing) {
    // Update photo or details if provided
    const [updated] = await sql`
      UPDATE public.visitor_profiles
      SET 
        full_name = ${cleanName || existing.full_name},
        email = ${email || existing.email},
        visitor_type = ${visitorType || existing.visitor_type},
        relationship = ${relationship || existing.relationship},
        profile_photo_url = ${profilePhotoUrl || existing.profile_photo_url},
        id_type = ${idType || existing.id_type},
        id_reference_masked = ${idReferenceMasked || existing.id_reference_masked},
        updated_at = NOW()
      WHERE id = ${existing.id} AND school_id = ${schoolId}
      RETURNING *
    `;
    return updated;
  }

  const [created] = await sql`
    INSERT INTO public.visitor_profiles (
      school_id, full_name, mobile_number, email, visitor_type,
      relationship, profile_photo_url, id_type, id_reference_masked
    ) VALUES (
      ${schoolId}, ${cleanName}, ${cleanMobile}, ${email}, ${visitorType},
      ${relationship}, ${profilePhotoUrl}, ${idType}, ${idReferenceMasked}
    )
    RETURNING *
  `;
  return created;
}

/**
 * Creates a visitor request and applies the approval policy
 */
export async function createVisitorRequest({
  schoolId,
  requestedByUserId = null,
  requestedByRole = 'PARENT',
  visitorFullName,
  visitorMobile,
  visitorEmail = null,
  visitorType = 'PARENT',
  relationship = null,
  studentId = null,
  hostUserId = null,
  destinationDepartment = null,
  visitDate,
  startTime,
  endTime,
  purpose,
  visitorCount = 1,
  gateId = null,
  vehicleNumber = null,
  notes = null,
}) {
  // 1. Get or create visitor profile
  const profile = await getOrCreateVisitorProfile({
    schoolId,
    fullName: visitorFullName,
    mobileNumber: visitorMobile,
    email: visitorEmail,
    visitorType,
    relationship,
  });

  // 2. Resolve approval policy
  const policy = await resolveApprovalPolicy(schoolId, visitorType, requestedByRole);

  // 3. Create request
  const [request] = await sql`
    INSERT INTO public.visitor_requests (
      school_id, visitor_profile_id, requested_by_user_id, requested_by_role,
      student_id, host_user_id, destination_department, visitor_type,
      visit_date, start_time, end_time, purpose, visitor_count,
      gate_id, vehicle_number, notes, approval_status, approval_policy
    ) VALUES (
      ${schoolId}, ${profile.id}, ${requestedByUserId}, ${requestedByRole},
      ${studentId}, ${hostUserId}, ${destinationDepartment}, ${visitorType},
      ${visitDate}, ${startTime}, ${endTime}, ${purpose.trim()}, ${Math.max(1, visitorCount)},
      ${gateId}, ${vehicleNumber ? vehicleNumber.trim().toUpperCase() : null}, ${notes},
      ${policy === 'AUTO_APPROVE' ? 'APPROVED' : 'PENDING'}, ${policy}
    )
    RETURNING *
  `;

  let pass = null;
  let qrToken = null;

  // 4. If auto-approved, issue QR pass immediately
  if (policy === 'AUTO_APPROVE') {
    const issued = await issueVisitorPass({
      schoolId,
      requestId: request.id,
      visitDate,
      startTime,
      endTime,
    });
    pass = issued.pass;
    qrToken = issued.qrToken;
  } else if (hostUserId) {
    try {
      await sendNotificationToUsers(
        [hostUserId],
        'VISITOR_REQUEST_PENDING',
        {
          title: 'Campus Visit Request Pending',
          body: `${profile.full_name} has requested to meet you on ${visitDate} at ${startTime}.`,
          visitorName: profile.full_name,
          visitDate,
          startTime,
          purpose,
          message: `${profile.full_name} has requested to meet you on ${visitDate} at ${startTime}.`,
        },
        { schoolId }
      );
    } catch (notifErr) {
      console.error('[VisitorManagementService] Host notification error:', notifErr.message);
    }
  }

  // Audit event
  await sql`
    INSERT INTO public.visitor_audit_events (
      school_id, user_id, user_role, gate_id, event_type, entity_type, entity_id, metadata
    ) VALUES (
      ${schoolId}, ${requestedByUserId}, ${requestedByRole}, ${gateId},
      'VISITOR_REQUEST_CREATED', 'visitor_requests', ${request.id},
      ${sql.json({ visitorName: profile.full_name, visitorMobile: profile.mobile_number, policy })}
    )
  `;

  return {
    request,
    profile,
    pass,
    qrToken,
    policy,
  };
}

/**
 * Checks in a visitor with strict concurrency and double-scan protection
 */
export async function checkInVisitor({
  schoolId,
  passToken = null,
  requestId = null,
  gateId,
  gatekeeperUserId,
  photoUrl = null,
  vehicleNumber = null,
  itemsCarried = null,
  verificationMethod = 'QR_SCAN',
  notes = null,
}) {
  let passRecord = null;
  let requestRecord = null;

  // 1. Resolve via QR token or direct request ID
  if (passToken) {
    const validation = await validateVisitorPassToken({ schoolId, token: passToken, gateId });
    if (!validation.isValid) {
      const err = new Error(validation.message);
      err.code = validation.reason;
      err.status = 400;
      throw err;
    }
    passRecord = validation.pass;
    requestId = passRecord.request_id;
  }

  // Fetch full request details
  const [request] = await sql`
    SELECT vr.*, vprof.full_name, vprof.mobile_number, vprof.id AS profile_id
    FROM public.visitor_requests vr
    JOIN public.visitor_profiles vprof ON vprof.id = vr.visitor_profile_id
    WHERE vr.id = ${requestId} AND vr.school_id = ${schoolId}
    LIMIT 1
  `;

  if (!request) {
    const err = new Error('Visitor request not found');
    err.status = 404;
    throw err;
  }

  requestRecord = request;

  // 2. Prevent duplicate check-in (Row Lock & Atomic Verification)
  const result = await sql.begin(async (tx) => {
    // Check if visitor is currently inside
    const [alreadyInside] = await tx`
      SELECT id, checked_in_at FROM public.visitor_checkins
      WHERE school_id = ${schoolId}
        AND visitor_profile_id = ${requestRecord.profile_id}
        AND checked_out_at IS NULL
      LIMIT 1
      FOR UPDATE
    `;

    if (alreadyInside) {
      const err = new Error('Visitor is already checked in and inside campus');
      err.code = 'ALREADY_INSIDE';
      err.status = 400;
      throw err;
    }

    // If a pass exists, increment entry_count atomically
    if (passRecord) {
      const [updatedPass] = await tx`
        UPDATE public.visitor_passes
        SET 
          entry_count = entry_count + 1,
          used_at = NOW(),
          status = CASE WHEN entry_count + 1 >= max_entries THEN 'USED' ELSE 'ACTIVE' END
        WHERE id = ${passRecord.pass_id}
          AND school_id = ${schoolId}
          AND entry_count < max_entries
        RETURNING *
      `;

      if (!updatedPass) {
        const err = new Error('Pass entry limit exceeded or concurrent scan conflict');
        err.code = 'CONCURRENT_SCAN_CONFLICT';
        err.status = 409;
        throw err;
      }
    }

    // Calculate expected checkout time
    const [settings] = await tx`
      SELECT default_visit_duration_minutes FROM public.school_visitor_settings
      WHERE school_id = ${schoolId} LIMIT 1
    `;
    const durationMins = settings?.default_visit_duration_minutes ?? 60;
    const expectedCheckout = new Date(Date.now() + durationMins * 60 * 1000);

    // Insert Check-in
    const [checkin] = await tx`
      INSERT INTO public.visitor_checkins (
        school_id, visitor_request_id, visitor_profile_id, pass_id,
        gate_id, gatekeeper_user_id, checked_in_at, expected_checkout_at,
        verification_method, photo_url, vehicle_number, items_carried,
        status, notes
      ) VALUES (
        ${schoolId}, ${requestRecord.id}, ${requestRecord.profile_id}, ${passRecord?.pass_id || null}::uuid,
        ${gateId}::uuid, ${gatekeeperUserId || null}::uuid, NOW(), ${expectedCheckout},
        ${verificationMethod}, ${photoUrl || null}::text, ${vehicleNumber || requestRecord.vehicle_number || null}::text,
        ${itemsCarried || null}::text, 'INSIDE', ${notes || null}::text
      )
      RETURNING *
    `;

    // Update request status to CHECKED_IN
    await tx`
      UPDATE public.visitor_requests
      SET approval_status = 'CHECKED_IN'
      WHERE id = ${requestRecord.id}
    `;

    // Vehicle record if present
    const regNum = vehicleNumber || requestRecord.vehicle_number;
    if (regNum) {
      await tx`
        INSERT INTO public.visitor_vehicles (
          school_id, visitor_profile_id, checkin_id, registration_number,
          entry_gate_id, entry_time
        ) VALUES (
          ${schoolId}, ${requestRecord.profile_id}, ${checkin.id}, ${regNum.trim().toUpperCase()},
          ${gateId}, NOW()
        )
      `;
    }

    // Audit Log
    await tx`
      INSERT INTO public.visitor_audit_events (
        school_id, user_id, user_role, gate_id, event_type, entity_type, entity_id, metadata
      ) VALUES (
        ${schoolId}, ${gatekeeperUserId || null}::uuid, 'gate_keeper', ${gateId}::uuid,
        'VISITOR_CHECKED_IN', 'visitor_checkins', ${checkin.id},
        ${tx.json({
          visitorName: requestRecord.full_name,
          visitorMobile: requestRecord.mobile_number,
          method: verificationMethod,
          expectedCheckout: expectedCheckout.toISOString(),
        })}
      )
    `;

    return checkin;
  });

  // Notify Host
  if (requestRecord.host_user_id) {
    try {
      const [gate] = await sql`SELECT name FROM public.school_gates WHERE id = ${gateId} LIMIT 1`;
      const gateName = gate?.name || 'School Gate';
      await sendNotificationToUsers(
        [requestRecord.host_user_id],
        'VISITOR_ARRIVED',
        {
          title: 'Visitor Arrived at Gate',
          body: `${requestRecord.full_name} has checked in at ${gateName} to meet you.`,
          visitorName: requestRecord.full_name,
          gateName,
          checkinTime: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
          message: `${requestRecord.full_name} has checked in at ${gateName} to meet you.`,
        },
        { schoolId }
      );
    } catch (notifErr) {
      console.error('[VisitorManagementService] Host notification error:', notifErr.message);
    }
  }

  return result;
}

/**
 * Checks out a visitor, calculating visit duration and clearing campus inside state
 */
export async function checkOutVisitor({
  schoolId,
  checkinId = null,
  passToken = null,
  exitGateId = null,
  gatekeeperUserId = null,
  notes = null,
}) {
  let targetCheckinId = checkinId;

  if (!targetCheckinId && passToken) {
    const tokenHash = hashPassToken(passToken);
    const [pass] = await sql`
      SELECT vp.id FROM public.visitor_passes vp WHERE vp.token_hash = ${tokenHash} LIMIT 1
    `;
    if (pass) {
      const [active] = await sql`
        SELECT id FROM public.visitor_checkins
        WHERE pass_id = ${pass.id} AND school_id = ${schoolId} AND checked_out_at IS NULL
        LIMIT 1
      `;
      if (active) targetCheckinId = active.id;
    }
  }

  if (!targetCheckinId) {
    const err = new Error('No active check-in found for this visitor');
    err.status = 404;
    throw err;
  }

  const checkedOut = await sql.begin(async (tx) => {
    const [checkin] = await tx`
      SELECT vc.*, vr.host_user_id, vprof.full_name
      FROM public.visitor_checkins vc
      JOIN public.visitor_requests vr ON vr.id = vc.visitor_request_id
      JOIN public.visitor_profiles vprof ON vprof.id = vc.visitor_profile_id
      WHERE vc.id = ${targetCheckinId}
        AND vc.school_id = ${schoolId}
        AND vc.checked_out_at IS NULL
      LIMIT 1
      FOR UPDATE
    `;

    if (!checkin) {
      const err = new Error('Visitor is already checked out or does not exist');
      err.status = 400;
      throw err;
    }

    const durationMinutes = Math.max(1, Math.round((Date.now() - new Date(checkin.checked_in_at).getTime()) / (60 * 1000)));

    const [updated] = await tx`
      UPDATE public.visitor_checkins
      SET 
        checked_out_at = NOW(),
        exit_gate_id = ${exitGateId || null}::uuid,
        visit_duration_minutes = ${durationMinutes},
        status = 'EXITED',
        notes = COALESCE(notes, '') || CASE WHEN ${notes || null}::text IS NOT NULL THEN ' | ' || ${notes || null}::text ELSE '' END
      WHERE id = ${targetCheckinId}
      RETURNING *
    `;

    // Update request status to CHECKED_OUT
    await tx`
      UPDATE public.visitor_requests
      SET approval_status = 'CHECKED_OUT'
      WHERE id = ${checkin.visitor_request_id}
    `;

    // Update vehicle exit time if recorded
    if (checkin.vehicle_number) {
      await tx`
        UPDATE public.visitor_vehicles
        SET exit_gate_id = ${exitGateId || null}::uuid, exit_time = NOW()
        WHERE checkin_id = ${targetCheckinId} AND exit_time IS NULL
      `;
    }

    // Audit log
    await tx`
      INSERT INTO public.visitor_audit_events (
        school_id, user_id, user_role, gate_id, event_type, entity_type, entity_id, metadata
      ) VALUES (
        ${schoolId}, ${gatekeeperUserId || null}::uuid, 'gate_keeper', ${exitGateId || null}::uuid,
        'VISITOR_CHECKED_OUT', 'visitor_checkins', ${targetCheckinId},
        ${tx.json({
          visitorName: checkin.full_name,
          durationMinutes,
          checkedOutAt: new Date().toISOString(),
        })}
      )
    `;

    return updated;
  });

  return checkedOut;
}

/**
 * Registers an unplanned walk-in visitor and checks them in
 */
export async function registerWalkInVisitor({
  schoolId,
  gatekeeperUserId,
  gateId,
  fullName,
  mobileNumber,
  visitorType = 'GUEST',
  hostUserId = null,
  studentId = null,
  destinationDepartment = null,
  purpose,
  visitorCount = 1,
  idType = null,
  idReferenceMasked = null,
  vehicleNumber = null,
  itemsCarried = null,
  photoUrl = null,
  notes = null,
}) {
  const profile = await getOrCreateVisitorProfile({
    schoolId,
    fullName,
    mobileNumber,
    visitorType,
    photoUrl,
    idType,
    idReferenceMasked,
  });

  let policy = await resolveApprovalPolicy(schoolId, visitorType, 'GATE_KEEPER');
  if (policy === 'HOST_APPROVAL' && !hostUserId) {
    policy = 'GATEKEEPER_APPROVAL';
  }
  const autoAdmit = ['AUTO_APPROVE', 'GATEKEEPER_APPROVAL', 'WALK_IN_GATE_APPROVAL'].includes(policy);

  const now = new Date();
  const timeString = now.toTimeString().split(' ')[0].slice(0, 5);
  const endHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const endTimeString = endHours.toTimeString().split(' ')[0].slice(0, 5);

  const [request] = await sql`
    INSERT INTO public.visitor_requests (
      school_id, visitor_profile_id, requested_by_user_id, requested_by_role,
      host_user_id, student_id, destination_department, visitor_type,
      visit_date, start_time, end_time, purpose, visitor_count,
      gate_id, vehicle_number, approval_status, approval_policy,
      approved_by, approved_at, notes
    ) VALUES (
      ${schoolId}, ${profile.id}, ${gatekeeperUserId}, 'GATE_KEEPER',
      ${hostUserId}, ${studentId}, ${destinationDepartment}, ${visitorType},
      CURRENT_DATE, ${timeString}, ${endTimeString}, ${purpose.trim()},
      ${Math.max(1, visitorCount)}, ${gateId}, ${vehicleNumber},
      ${autoAdmit ? 'APPROVED' : 'PENDING'}, ${policy},
      ${autoAdmit ? gatekeeperUserId : null}, ${autoAdmit ? sql`NOW()` : null}, ${notes}
    )
    RETURNING *
  `;

  if (!autoAdmit) {
    if (hostUserId) {
      try {
        await sendNotificationToUsers(
          [hostUserId],
          'VISITOR_WAITING_AT_GATE',
          {
            title: 'Visitor waiting at gate',
            body: `${profile.full_name} is waiting for host approval.`,
            visitorName: profile.full_name,
            purpose,
            message: `${profile.full_name} is waiting at the gate for approval.`,
          },
          { schoolId }
        );
      } catch (notifErr) {
        console.error('[VisitorManagementService] Walk-in host notify error:', notifErr.message);
      }
    }
    return { request, profile, checkin: null, awaitingApproval: true };
  }

  const checkin = await checkInVisitor({
    schoolId,
    requestId: request.id,
    gateId,
    gatekeeperUserId,
    photoUrl,
    vehicleNumber,
    itemsCarried,
    verificationMethod: 'WALK_IN',
    notes,
  });

  return { request, profile, checkin, awaitingApproval: false };
}

/**
 * Returns list of visitors currently inside the school campus with overstay indicators
 */
export async function getCurrentlyInsideCampus(schoolId, { gateId = null, category = null } = {}) {
  const visitors = await sql`
    SELECT 
      vc.id AS checkin_id,
      vc.checked_in_at,
      vc.expected_checkout_at,
      vc.verification_method,
      vc.photo_url,
      vc.vehicle_number,
      vc.items_carried,
      vprof.id AS profile_id,
      vprof.full_name AS visitor_name,
      vprof.mobile_number AS visitor_mobile,
      vprof.visitor_type,
      vprof.relationship,
      vr.id AS request_id,
      vr.purpose,
      vr.destination_department,
      sg.name AS gate_name,
      host_p.display_name AS host_name,
      stud_p.display_name AS student_name,
      stud.admission_no AS student_admission_no
    FROM public.visitor_checkins vc
    JOIN public.visitor_profiles vprof ON vprof.id = vc.visitor_profile_id
    JOIN public.visitor_requests vr ON vr.id = vc.visitor_request_id
    LEFT JOIN public.school_gates sg ON sg.id = vc.gate_id
    LEFT JOIN public.users host_u ON host_u.id = vr.host_user_id
    LEFT JOIN public.persons host_p ON host_p.id = host_u.person_id
    LEFT JOIN public.students stud ON stud.id = vr.student_id
    LEFT JOIN public.persons stud_p ON stud_p.id = stud.person_id
    WHERE vc.school_id = ${schoolId}
      AND vc.checked_out_at IS NULL
      ${gateId ? sql`AND vc.gate_id = ${gateId}` : sql``}
      ${category ? sql`AND vprof.visitor_type = ${category}` : sql``}
    ORDER BY vc.checked_in_at DESC
  `;

  const now = Date.now();
  return visitors.map((v) => {
    const elapsedMinutes = Math.max(0, Math.round((now - new Date(v.checked_in_at).getTime()) / (60 * 1000)));
    const expectedCheckoutMs = new Date(v.expected_checkout_at).getTime();
    const isOverstayed = now > expectedCheckoutMs;
    const overstayMinutes = isOverstayed ? Math.round((now - expectedCheckoutMs) / (60 * 1000)) : 0;

    return {
      ...v,
      elapsedMinutes,
      isOverstayed,
      overstayMinutes,
      statusLabel: isOverstayed ? `OVERSTAYED +${overstayMinutes}m` : `${elapsedMinutes}m on campus`,
    };
  });
}

/**
 * Returns visitor analytics KPI metrics and aggregations
 */
export async function getVisitorAnalytics(schoolId) {
  const [[visits], [inside], [expected], [pending], [rejected], [overstay], [deliveries], [incidents]] = await Promise.all([
    sql`SELECT COUNT(*)::int AS n FROM public.visitor_requests WHERE school_id = ${schoolId} AND visit_date = CURRENT_DATE AND deleted_at IS NULL`,
    sql`SELECT COUNT(*)::int AS n FROM public.visitor_checkins WHERE school_id = ${schoolId} AND checked_out_at IS NULL`,
    sql`
      SELECT COUNT(*)::int AS n FROM public.visitor_requests vr
      WHERE vr.school_id = ${schoolId} AND vr.visit_date = CURRENT_DATE AND vr.approval_status = 'APPROVED' AND vr.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.visitor_checkins vc2 WHERE vc2.visitor_request_id = vr.id)
    `,
    sql`SELECT COUNT(*)::int AS n FROM public.visitor_requests WHERE school_id = ${schoolId} AND approval_status = 'PENDING' AND deleted_at IS NULL`,
    sql`SELECT COUNT(*)::int AS n FROM public.visitor_requests WHERE school_id = ${schoolId} AND visit_date = CURRENT_DATE AND approval_status = 'REJECTED' AND deleted_at IS NULL`,
    sql`SELECT COUNT(*)::int AS n FROM public.visitor_checkins WHERE school_id = ${schoolId} AND checked_out_at IS NULL AND NOW() > expected_checkout_at`,
    sql`SELECT COUNT(*)::int AS n FROM public.visitor_deliveries WHERE school_id = ${schoolId} AND received_at >= CURRENT_DATE`,
    sql`SELECT COUNT(*)::int AS n FROM public.visitor_incidents WHERE school_id = ${schoolId} AND occurred_at >= CURRENT_DATE`,
  ]);

  const counts = {
    visits_today: visits?.n || 0,
    currently_inside: inside?.n || 0,
    expected_today: expected?.n || 0,
    pending_approvals: pending?.n || 0,
    rejected_today: rejected?.n || 0,
    overstayed_now: overstay?.n || 0,
    deliveries_today: deliveries?.n || 0,
    incidents_today: incidents?.n || 0,
  };

  // Categories distribution
  const categories = await sql`
    SELECT vprof.visitor_type AS category, COUNT(*)::int AS count
    FROM public.visitor_requests vr
    JOIN public.visitor_profiles vprof ON vprof.id = vr.visitor_profile_id
    WHERE vr.school_id = ${schoolId} AND vr.visit_date >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY vprof.visitor_type
    ORDER BY count DESC
  `;

  // Gate breakdown
  const gates = await sql`
    SELECT sg.name AS gate_name, COUNT(vc.id)::int AS entries
    FROM public.school_gates sg
    LEFT JOIN public.visitor_checkins vc ON vc.gate_id = sg.id AND vc.checked_in_at >= CURRENT_DATE - INTERVAL '7 days'
    WHERE sg.school_id = ${schoolId} AND sg.deleted_at IS NULL
    GROUP BY sg.id, sg.name
    ORDER BY entries DESC
  `;

  return {
    summary: {
      visitsToday: Number(counts?.visits_today || 0),
      currentlyInside: Number(counts?.currently_inside || 0),
      expectedToday: Number(counts?.expected_today || 0),
      pendingApprovals: Number(counts?.pending_approvals || 0),
      rejectedToday: Number(counts?.rejected_today || 0),
      overstayedNow: Number(counts?.overstayed_now || 0),
      deliveriesToday: Number(counts?.deliveries_today || 0),
      incidentsToday: Number(counts?.incidents_today || 0),
    },
    categories,
    gates,
  };
}
