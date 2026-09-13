import express from 'express';
import sql from '../db.js';
import { requireAuth, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import {
  createVisitorRequest,
  checkInVisitor,
  checkOutVisitor,
  registerWalkInVisitor,
  getCurrentlyInsideCampus,
  getVisitorAnalytics,
} from '../services/visitorManagementService.js';
import { validateVisitorPassToken } from '../services/visitorQrService.js';
import { approveVisitorRequest, rejectVisitorRequest } from '../services/visitorApprovalService.js';
import {
  addAuthorizedGuardian,
  createPickupAuthorization,
  validatePickup,
  releaseStudentToGuardian,
} from '../services/studentPickupService.js';
import {
  reportSecurityIncident,
  addToWatchlist,
  activateEmergencyMode,
  resolveEmergencyMode,
} from '../services/visitorIncidentService.js';
import {
  isVisitorOperationsUser,
  resolveLinkedStudentIds,
  cancelVisitorRequest,
  getRevealablePassToken,
  syncOfflineGateEvent,
  searchCampusVisitors,
  listVehicles,
  recordVehicleEntry,
  createContractorPass,
  listContractorPasses,
  bookAppointment,
  listAppointmentSlots,
  upsertAppointmentSlot,
  listTodayOfflineCache,
  buildDigitalBadge,
} from '../services/visitorOpsService.js';
import { sendNotificationToUsers } from '../services/notificationService.js';
import { visitorScanLimiter, pickupOtpLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

function visitorStaff(req) {
  return isVisitorOperationsUser(req.user);
}

// ─── 1. GATES MANAGEMENT ─────────────────────────────────────────────

router.get('/gates', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const gates = await sql`
    SELECT * FROM public.school_gates
    WHERE school_id = ${schoolId} AND deleted_at IS NULL
    ORDER BY is_active DESC, name ASC
  `;
  return sendSuccess(res, schoolId, { gates });
}));

router.post('/gates', requirePermission('visitors.settings'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { name, code, description, gate_type, allow_visitors, allow_vehicles, allow_deliveries } = req.body;

  if (!name || !code) {
    return res.status(400).json({ error: 'Gate name and code are required' });
  }

  const [gate] = await sql`
    INSERT INTO public.school_gates (
      school_id, name, code, description, gate_type,
      allow_visitors, allow_vehicles, allow_deliveries
    ) VALUES (
      ${schoolId}, ${name.trim()}, ${code.trim().toUpperCase()}, ${description},
      ${gate_type || 'mixed'}, ${allow_visitors !== false},
      ${allow_vehicles !== false}, ${allow_deliveries !== false}
    )
    RETURNING *
  `;
  return sendSuccess(res, schoolId, { gate, message: 'Gate created successfully' });
}));

router.get('/gatekeeper/my-gate', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const userId = req.user.internal_id || req.user.id;

  const assigned = await sql`
    SELECT gg.is_default, sg.*
    FROM public.gatekeeper_gates gg
    JOIN public.school_gates sg ON sg.id = gg.gate_id
    WHERE gg.school_id = ${schoolId} AND gg.user_id = ${userId} AND sg.is_active = true AND sg.deleted_at IS NULL
    ORDER BY gg.is_default DESC, sg.name ASC
  `;

  if (assigned.length === 0) {
    // Fallback to the default Main Gate for the school
    const [mainGate] = await sql`
      SELECT * FROM public.school_gates
      WHERE school_id = ${schoolId} AND is_active = true AND deleted_at IS NULL
      ORDER BY created_at ASC LIMIT 1
    `;
    return sendSuccess(res, schoolId, { currentGate: mainGate || null, assignedGates: mainGate ? [mainGate] : [] });
  }

  return sendSuccess(res, schoolId, { currentGate: assigned[0], assignedGates: assigned });
}));

// ─── 2. SETTINGS & APPROVAL POLICIES ─────────────────────────────────

router.get('/settings', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const [settings] = await sql`SELECT * FROM public.school_visitor_settings WHERE school_id = ${schoolId} LIMIT 1`;
  const policies = await sql`SELECT * FROM public.visitor_approval_policies WHERE school_id = ${schoolId}`;
  return sendSuccess(res, schoolId, { settings: settings || {}, policies });
}));

router.patch('/settings', requirePermission('visitors.settings'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const {
    is_enabled, allow_parent_requests, allow_walkins, require_visitor_photo,
    require_id_proof, require_vehicle_number, require_host_approval,
    parent_auto_approve, qr_validity_window_minutes, default_visit_duration_minutes,
    pickup_otp_enabled, enable_offline_mode, enable_overstay_alerts, overstay_threshold_minutes
  } = req.body;

  const [updated] = await sql`
    UPDATE public.school_visitor_settings
    SET 
      is_enabled = COALESCE(${is_enabled}, is_enabled),
      allow_parent_requests = COALESCE(${allow_parent_requests}, allow_parent_requests),
      allow_walkins = COALESCE(${allow_walkins}, allow_walkins),
      require_visitor_photo = COALESCE(${require_visitor_photo}, require_visitor_photo),
      require_id_proof = COALESCE(${require_id_proof}, require_id_proof),
      require_vehicle_number = COALESCE(${require_vehicle_number}, require_vehicle_number),
      require_host_approval = COALESCE(${require_host_approval}, require_host_approval),
      parent_auto_approve = COALESCE(${parent_auto_approve}, parent_auto_approve),
      qr_validity_window_minutes = COALESCE(${qr_validity_window_minutes}, qr_validity_window_minutes),
      default_visit_duration_minutes = COALESCE(${default_visit_duration_minutes}, default_visit_duration_minutes),
      pickup_otp_enabled = COALESCE(${pickup_otp_enabled}, pickup_otp_enabled),
      enable_offline_mode = COALESCE(${enable_offline_mode}, enable_offline_mode),
      enable_overstay_alerts = COALESCE(${enable_overstay_alerts}, enable_overstay_alerts),
      overstay_threshold_minutes = COALESCE(${overstay_threshold_minutes}, overstay_threshold_minutes),
      updated_at = NOW()
    WHERE school_id = ${schoolId}
    RETURNING *
  `;
  return sendSuccess(res, schoolId, { settings: updated });
}));

// ─── 3. VISITOR REQUESTS & PASSES ────────────────────────────────────

router.post('/requests', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const userId = req.user.internal_id || req.user.id;
  const userRole = (req.user.roles || [])[0] || 'PARENT';

  const {
    visitorFullName, visitorMobile, visitorEmail, visitorType, relationship,
    studentId, hostUserId, destinationDepartment, visitDate, startTime, endTime,
    purpose, visitorCount, gateId, vehicleNumber, notes
  } = req.body;

  if (!visitorFullName || !visitorMobile || !visitDate || !startTime || !endTime || !purpose) {
    return res.status(400).json({ error: 'Missing required visit details' });
  }

  let resolvedStudentId = studentId || null;
  if (!resolvedStudentId && !visitorStaff(req)) {
    const linked = await resolveLinkedStudentIds(schoolId, req.user);
    resolvedStudentId = linked[0] || null;
  }

  const result = await createVisitorRequest({
    schoolId,
    requestedByUserId: userId,
    requestedByRole: userRole,
    visitorFullName,
    visitorMobile,
    visitorEmail,
    visitorType: visitorType || 'PARENT',
    relationship,
    studentId: resolvedStudentId,
    hostUserId,
    destinationDepartment,
    visitDate,
    startTime,
    endTime,
    purpose,
    visitorCount: Number(visitorCount) || 1,
    gateId,
    vehicleNumber,
    notes,
  });

  return sendSuccess(res, schoolId, result);
}));

router.get('/requests', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { status, date, studentId, search, page = 1, limit = 20, mine } = req.query;
  const offset = (Math.max(1, Number(page)) - 1) * Math.min(100, Math.max(1, Number(limit)));
  const searchPattern = search ? `%${search.trim()}%` : null;
  const userId = req.user.internal_id || req.user.id;
  const staff = visitorStaff(req);
  const linkedStudentIds = staff ? [] : await resolveLinkedStudentIds(schoolId, req.user);
  const restrictToOwner = !staff || mine === 'true';

  const requests = await sql`
    SELECT 
      vr.*,
      vprof.full_name AS visitor_name,
      vprof.mobile_number AS visitor_mobile,
      vprof.visitor_type,
      vprof.profile_photo_url,
      stud_p.display_name AS student_name,
      stud.admission_no AS student_admission_no,
      host_p.display_name AS host_name,
      vp.pass_code,
      vp.status AS pass_status,
      vp.valid_from,
      vp.valid_until
    FROM public.visitor_requests vr
    JOIN public.visitor_profiles vprof ON vprof.id = vr.visitor_profile_id
    LEFT JOIN public.visitor_passes vp ON vp.visitor_request_id = vr.id
    LEFT JOIN public.students stud ON stud.id = vr.student_id
    LEFT JOIN public.persons stud_p ON stud_p.id = stud.person_id
    LEFT JOIN public.users host_u ON host_u.id = vr.host_user_id
    LEFT JOIN public.persons host_p ON host_p.id = host_u.person_id
    WHERE vr.school_id = ${schoolId}
      AND vr.deleted_at IS NULL
      ${restrictToOwner ? sql`AND (
        vr.requested_by_user_id = ${userId}
        OR vr.host_user_id = ${userId}
        ${linkedStudentIds.length ? sql`OR vr.student_id = ANY(${linkedStudentIds}::uuid[])` : sql``}
      )` : sql``}
      ${status ? sql`AND vr.approval_status = ${status}` : sql``}
      ${date ? sql`AND vr.visit_date = ${date}` : sql``}
      ${studentId ? sql`AND vr.student_id = ${studentId}` : sql``}
      ${searchPattern ? sql`AND (
        vprof.full_name ILIKE ${searchPattern}
        OR vprof.mobile_number ILIKE ${searchPattern}
        OR vr.purpose ILIKE ${searchPattern}
        OR stud_p.display_name ILIKE ${searchPattern}
      )` : sql``}
    ORDER BY vr.visit_date DESC, vr.start_time DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return sendSuccess(res, schoolId, { requests });
}));

router.get('/requests/:id', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { id } = req.params;

  const [request] = await sql`
    SELECT 
      vr.*,
      vprof.full_name AS visitor_name,
      vprof.mobile_number AS visitor_mobile,
      vprof.email AS visitor_email,
      vprof.profile_photo_url,
      vprof.id_type,
      vprof.id_reference_masked,
      vprof.relationship,
      stud_p.display_name AS student_name,
      stud.admission_no AS student_admission_no,
      cls.name AS class_name,
      sec.name AS section_name,
      host_p.display_name AS host_name,
      sg.name AS gate_name,
      vp.id AS pass_id,
      vp.pass_code,
      vp.status AS pass_status,
      vp.valid_from,
      vp.valid_until,
      vp.max_entries,
      vp.entry_count
    FROM public.visitor_requests vr
    JOIN public.visitor_profiles vprof ON vprof.id = vr.visitor_profile_id
    LEFT JOIN public.visitor_passes vp ON vp.visitor_request_id = vr.id
    LEFT JOIN public.students stud ON stud.id = vr.student_id
    LEFT JOIN public.persons stud_p ON stud_p.id = stud.person_id
    LEFT JOIN public.student_enrollments se ON se.student_id = stud.id AND se.school_id = vr.school_id AND se.status = 'active' AND se.deleted_at IS NULL
    LEFT JOIN public.class_sections cs ON cs.id = se.class_section_id
    LEFT JOIN public.classes cls ON cls.id = cs.class_id
    LEFT JOIN public.sections sec ON sec.id = cs.section_id
    LEFT JOIN public.users host_u ON host_u.id = vr.host_user_id
    LEFT JOIN public.persons host_p ON host_p.id = host_u.person_id
    LEFT JOIN public.school_gates sg ON sg.id = vr.gate_id
    WHERE vr.id = ${id} AND vr.school_id = ${schoolId} AND vr.deleted_at IS NULL
    LIMIT 1
  `;

  if (!request) {
    return res.status(404).json({ error: 'Visitor request not found' });
  }

  const userId = req.user.internal_id || req.user.id;
  const staff = visitorStaff(req);
  const isOwner = String(request.requested_by_user_id) === String(userId);
  const isHost = String(request.host_user_id) === String(userId);
  if (!staff && !isOwner && !isHost) {
    return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
  }

  const qrToken = await getRevealablePassToken({
    schoolId,
    requestId: id,
    user: req.user,
    allowStaff: staff,
  });

  return sendSuccess(res, schoolId, { request: { ...request, qrToken: qrToken || undefined } });
}));

router.post('/requests/:id/approve', requireAnyPermission(['visitors.manage', 'visitors.approve']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const userId = req.user.internal_id || req.user.id;
  const { notes } = req.body;

  const result = await approveVisitorRequest({
    schoolId,
    requestId: req.params.id,
    approvedByUserId: userId,
    notes,
  });
  return sendSuccess(res, schoolId, result);
}));

router.post('/requests/:id/reject', requireAnyPermission(['visitors.manage', 'visitors.approve']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const userId = req.user.internal_id || req.user.id;
  const { reason } = req.body;

  const result = await rejectVisitorRequest({
    schoolId,
    requestId: req.params.id,
    rejectedByUserId: userId,
    rejectionReason: reason,
  });
  return sendSuccess(res, schoolId, { request: result, message: 'Visit request declined' });
}));

router.post('/requests/:id/cancel', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const userId = req.user.internal_id || req.user.id;
  const { reason } = req.body;
  const cancelled = await cancelVisitorRequest({
    schoolId,
    requestId: req.params.id,
    userId,
    reason,
    isStaff: visitorStaff(req),
  });
  return sendSuccess(res, schoolId, { request: cancelled, message: 'Visit cancelled' });
}));

// ─── 4. QR VALIDATION (GATEKEEPER SCANNER) ───────────────────────────

router.post('/passes/validate', visitorScanLimiter, requirePermission('visitors.scan'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { token, gateId } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'QR token is required' });
  }

  const result = await validateVisitorPassToken({ schoolId, token, gateId });
  return sendSuccess(res, schoolId, result);
}));

// ─── 5. CHECK-IN & CHECK-OUT ─────────────────────────────────────────

router.post('/check-in', requirePermission('visitors.checkin'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const gatekeeperUserId = req.user.internal_id || req.user.id;
  const { passToken, requestId, gateId, photoUrl, vehicleNumber, itemsCarried, verificationMethod, notes } = req.body;

  if (!gateId) {
    return res.status(400).json({ error: 'Gate ID is required for check-in' });
  }

  const checkin = await checkInVisitor({
    schoolId,
    passToken,
    requestId,
    gateId,
    gatekeeperUserId,
    photoUrl,
    vehicleNumber,
    itemsCarried,
    verificationMethod: verificationMethod || 'QR_SCAN',
    notes,
  });

  return sendSuccess(res, schoolId, { checkin, message: 'Visitor checked in successfully' });
}));

router.post('/check-out', requirePermission('visitors.checkout'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const gatekeeperUserId = req.user.internal_id || req.user.id;
  const { checkinId, passToken, exitGateId, notes } = req.body;

  const checkout = await checkOutVisitor({
    schoolId,
    checkinId,
    passToken,
    exitGateId,
    gatekeeperUserId,
    notes,
  });

  return sendSuccess(res, schoolId, { checkout, message: 'Visitor checked out successfully' });
}));

router.post('/walk-in', requirePermission('visitors.walkin'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const gatekeeperUserId = req.user.internal_id || req.user.id;
  const {
    fullName, mobileNumber, visitorType, hostUserId, studentId,
    destinationDepartment, purpose, visitorCount, idType, idReferenceMasked,
    vehicleNumber, itemsCarried, photoUrl, gateId, notes
  } = req.body;

  if (!fullName || !mobileNumber || !purpose || !gateId) {
    return res.status(400).json({ error: 'Full name, phone, purpose, and gate are required' });
  }

  const result = await registerWalkInVisitor({
    schoolId,
    gatekeeperUserId,
    gateId,
    fullName,
    mobileNumber,
    visitorType: visitorType || 'GUEST',
    hostUserId,
    studentId,
    destinationDepartment,
    purpose,
    visitorCount: Number(visitorCount) || 1,
    idType,
    idReferenceMasked,
    vehicleNumber,
    itemsCarried,
    photoUrl,
    notes,
  });

  return sendSuccess(res, schoolId, { ...result, message: 'Walk-in visitor registered and checked in' });
}));

// ─── 6. LIVE REGISTERS & ANALYTICS ───────────────────────────────────

router.get('/currently-inside', requireAnyPermission(['visitors.manage', 'visitors.scan', 'visitors.checkin']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { gateId, category } = req.query;
  const visitors = await getCurrentlyInsideCampus(schoolId, { gateId, category });
  return sendSuccess(res, schoolId, { visitors, count: visitors.length });
}));

router.get('/expected', requireAnyPermission(['visitors.manage', 'visitors.scan', 'visitors.checkin']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const expected = await sql`
    SELECT 
      vr.*,
      vprof.full_name AS visitor_name,
      vprof.mobile_number AS visitor_mobile,
      vprof.visitor_type,
      vprof.profile_photo_url,
      stud_p.display_name AS student_name,
      host_p.display_name AS host_name,
      vp.pass_code
    FROM public.visitor_requests vr
    JOIN public.visitor_profiles vprof ON vprof.id = vr.visitor_profile_id
    LEFT JOIN public.visitor_passes vp ON vp.visitor_request_id = vr.id
    LEFT JOIN public.students stud ON stud.id = vr.student_id
    LEFT JOIN public.persons stud_p ON stud_p.id = stud.person_id
    LEFT JOIN public.users host_u ON host_u.id = vr.host_user_id
    LEFT JOIN public.persons host_p ON host_p.id = host_u.person_id
    WHERE vr.school_id = ${schoolId}
      AND vr.visit_date = CURRENT_DATE
      AND vr.approval_status = 'APPROVED'
      AND vr.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.visitor_checkins vc WHERE vc.visitor_request_id = vr.id
      )
    ORDER BY vr.start_time ASC
  `;
  return sendSuccess(res, schoolId, { expected });
}));

router.get('/analytics', requireAnyPermission(['visitors.manage', 'visitors.scan', 'visitors.view']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const analytics = await getVisitorAnalytics(schoolId);
  return sendSuccess(res, schoolId, analytics);
}));

// ─── 7. STUDENT PICKUPS & GUARDIANS ──────────────────────────────────

router.get('/guardians', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { studentId } = req.query;

  if (!studentId) {
    return res.status(400).json({ error: 'studentId query param is required' });
  }

  const guardians = await sql`
    SELECT * FROM public.authorized_guardians
    WHERE school_id = ${schoolId} AND student_id = ${studentId} AND deleted_at IS NULL
    ORDER BY status ASC, name ASC
  `;
  return sendSuccess(res, schoolId, { guardians });
}));

router.post('/guardians', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const parentUserId = req.user.internal_id || req.user.id;
  const { studentId, name, relationship, mobile, photoUrl, idReferenceMasked, validFrom, validUntil, notes } = req.body;

  if (!studentId || !name || !relationship || !mobile) {
    return res.status(400).json({ error: 'Student ID, guardian name, relationship, and mobile are required' });
  }

  const guardian = await addAuthorizedGuardian({
    schoolId,
    studentId,
    parentUserId,
    name,
    relationship,
    mobile,
    photoUrl,
    idReferenceMasked,
    validFrom,
    validUntil,
    notes,
  });

  return sendSuccess(res, schoolId, { guardian, message: 'Authorized guardian added' });
}));

router.post('/pickups', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const parentUserId = req.user.internal_id || req.user.id;
  const {
    studentId, guardianId, pickupName, pickupRelationship, pickupMobile,
    pickupPhotoUrl, pickupDate, validStartTime, validEndTime, vehicleNumber,
    requireOtp = true, notes
  } = req.body;

  if (!studentId || !pickupName || !pickupRelationship || !pickupMobile || !pickupDate || !validStartTime || !validEndTime) {
    return res.status(400).json({ error: 'Missing required pickup details' });
  }

  const result = await createPickupAuthorization({
    schoolId,
    studentId,
    parentUserId,
    guardianId,
    pickupName,
    pickupRelationship,
    pickupMobile,
    pickupPhotoUrl,
    pickupDate,
    validStartTime,
    validEndTime,
    vehicleNumber,
    requireOtp,
    notes,
  });

  return sendSuccess(res, schoolId, result);
}));

router.post('/pickups/validate', pickupOtpLimiter, requirePermission('visitors.pickup'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { token, otp } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Pickup token is required' });
  }

  const result = await validatePickup({ schoolId, token, otp });
  return sendSuccess(res, schoolId, result);
}));

router.post('/pickups/release', requirePermission('visitors.pickup'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const gatekeeperUserId = req.user.internal_id || req.user.id;
  const { authorizationId, gateId, notes } = req.body;

  if (!authorizationId || !gateId) {
    return res.status(400).json({ error: 'authorizationId and gateId are required' });
  }

  const released = await releaseStudentToGuardian({
    schoolId,
    authorizationId,
    gatekeeperUserId,
    gateId,
    notes,
  });

  return sendSuccess(res, schoolId, { authorization: released, message: 'Student successfully released' });
}));

// ─── 8. DELIVERIES ───────────────────────────────────────────────────

router.post('/deliveries', requirePermission('visitors.delivery'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const gatekeeperUserId = req.user.internal_id || req.user.id;
  const { courierName, deliveryPerson, mobile, packageCount, recipientUserId, recipientName, recipientDepartment, trackingReference, photoUrl, gateId, notes } = req.body;

  if (!courierName || !deliveryPerson || !recipientName || !gateId) {
    return res.status(400).json({ error: 'Courier, delivery person, recipient, and gate are required' });
  }

  const [delivery] = await sql`
    INSERT INTO public.visitor_deliveries (
      school_id, gate_id, gatekeeper_user_id, courier_name, delivery_person,
      mobile, package_count, recipient_user_id, recipient_name, recipient_department,
      tracking_reference, photo_url, notes
    ) VALUES (
      ${schoolId}, ${gateId}, ${gatekeeperUserId}, ${courierName.trim()}, ${deliveryPerson.trim()},
      ${mobile}, ${Number(packageCount) || 1}, ${recipientUserId}, ${recipientName.trim()},
      ${recipientDepartment}, ${trackingReference}, ${photoUrl}, ${notes}
    )
    RETURNING *
  `;

  if (recipientUserId) {
    try {
      await sendNotificationToUsers(
        [recipientUserId],
        'DELIVERY_RECEIVED',
        {
          title: 'Package Received at Gate',
          body: `Package from ${courierName} received at the gate for you.`,
          courier: courierName,
          message: `Package from ${courierName} received at the gate for you.`,
        },
        { schoolId }
      );
    } catch (e) {}
  }

  return sendSuccess(res, schoolId, { delivery, message: 'Delivery logged successfully' });
}));

router.get('/deliveries', requireAnyPermission(['visitors.delivery', 'visitors.view']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { status = 'RECEIVED' } = req.query;

  const deliveries = await sql`
    SELECT vd.*, sg.name AS gate_name
    FROM public.visitor_deliveries vd
    LEFT JOIN public.school_gates sg ON sg.id = vd.gate_id
    WHERE vd.school_id = ${schoolId}
      ${status ? sql`AND vd.status = ${status}` : sql``}
    ORDER BY vd.received_at DESC
  `;
  return sendSuccess(res, schoolId, { deliveries });
}));

router.patch('/deliveries/:id/collect', requirePermission('visitors.delivery'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { id } = req.params;
  const { collectedByName } = req.body;

  const [updated] = await sql`
    UPDATE public.visitor_deliveries
    SET status = 'COLLECTED', collected_at = NOW(), collected_by_name = ${collectedByName || 'Recipient'}
    WHERE id = ${id} AND school_id = ${schoolId}
    RETURNING *
  `;
  return sendSuccess(res, schoolId, { delivery: updated });
}));

// ─── 9. MATERIAL GATE PASSES ─────────────────────────────────────────

router.post('/materials', requirePermission('visitors.material'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const gatekeeperUserId = req.user.internal_id || req.user.id;
  const { passNumber, direction, category, bearerName, bearerMobile, bearerCompany, vehicleNumber, gateId, expectedReturnAt, remarks, items = [] } = req.body;

  if (!passNumber || !bearerName || !gateId) {
    return res.status(400).json({ error: 'Pass number, bearer name, and gate are required' });
  }

  const [pass] = await sql.begin(async (tx) => {
    const [p] = await tx`
      INSERT INTO public.material_gate_passes (
        school_id, pass_number, direction, category, bearer_name,
        bearer_mobile, bearer_company, vehicle_number, gate_id,
        gatekeeper_user_id, expected_return_at, remarks
      ) VALUES (
        ${schoolId}, ${passNumber.trim().toUpperCase()}, ${direction || 'INWARD'},
        ${category || 'NON_RETURNABLE'}, ${bearerName.trim()}, ${bearerMobile},
        ${bearerCompany}, ${vehicleNumber}, ${gateId}, ${gatekeeperUserId},
        ${expectedReturnAt}, ${remarks}
      )
      RETURNING *
    `;

    for (const item of items) {
      await tx`
        INSERT INTO public.material_gate_pass_items (
          pass_id, item_name, description, quantity, unit, serial_number
        ) VALUES (
          ${p.id}, ${item.name || item.item_name}, ${item.description},
          ${Number(item.quantity) || 1}, ${item.unit || 'PCS'}, ${item.serial_number}
        )
      `;
    }
    return [p];
  });

  return sendSuccess(res, schoolId, { pass, message: 'Material gate pass logged' });
}));

router.get('/materials', requireAnyPermission(['visitors.material', 'visitors.view']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const passes = await sql`
    SELECT mgp.*, sg.name AS gate_name,
      COALESCE(json_agg(mgpi.*) FILTER (WHERE mgpi.id IS NOT NULL), '[]') AS items
    FROM public.material_gate_passes mgp
    LEFT JOIN public.school_gates sg ON sg.id = mgp.gate_id
    LEFT JOIN public.material_gate_pass_items mgpi ON mgpi.pass_id = mgp.id
    WHERE mgp.school_id = ${schoolId}
    GROUP BY mgp.id, sg.name
    ORDER BY mgp.created_at DESC
  `;
  return sendSuccess(res, schoolId, { passes });
}));

// ─── 10. SECURITY INCIDENTS & WATCHLIST ──────────────────────────────

router.post('/incidents', requirePermission('visitors.incident'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const reportedByUserId = req.user.internal_id || req.user.id;
  const { gateId, visitorProfileId, checkinId, incidentType, severity, description, attachments } = req.body;

  if (!incidentType || !description) {
    return res.status(400).json({ error: 'Incident type and description are required' });
  }

  const incident = await reportSecurityIncident({
    schoolId,
    reportedByUserId,
    gateId,
    visitorProfileId,
    checkinId,
    incidentType,
    severity: severity || 'MEDIUM',
    description,
    attachments,
  });

  return sendSuccess(res, schoolId, { incident, message: 'Incident reported' });
}));

router.get('/incidents', requireAnyPermission(['visitors.incident', 'visitors.view']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const incidents = await sql`
    SELECT vi.*, sg.name AS gate_name, vprof.full_name AS visitor_name
    FROM public.visitor_incidents vi
    LEFT JOIN public.school_gates sg ON sg.id = vi.gate_id
    LEFT JOIN public.visitor_profiles vprof ON vprof.id = vi.visitor_profile_id
    WHERE vi.school_id = ${schoolId}
    ORDER BY vi.occurred_at DESC
  `;
  return sendSuccess(res, schoolId, { incidents });
}));

router.get('/watchlist', requireAnyPermission(['visitors.settings', 'visitors.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const watchlist = await sql`
    SELECT * FROM public.visitor_watchlist
    WHERE school_id = ${schoolId} AND is_active = true
    ORDER BY created_at DESC
  `;
  return sendSuccess(res, schoolId, { watchlist });
}));

router.post('/watchlist', requirePermission('visitors.settings'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const addedByUserId = req.user.internal_id || req.user.id;
  const { name, mobile, vehicleNumber, restrictionLevel, reason } = req.body;

  if (!name || !reason) {
    return res.status(400).json({ error: 'Name and reason are required' });
  }

  const entry = await addToWatchlist({
    schoolId,
    name,
    mobile,
    vehicleNumber,
    restrictionLevel: restrictionLevel || 'WARNING',
    reason,
    addedByUserId,
  });

  return sendSuccess(res, schoolId, { entry, message: 'Watchlist entry added' });
}));

// ─── 11. EMERGENCY MUSTER REGISTER ───────────────────────────────────

router.get('/emergency', requirePermission('visitors.emergency'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const [activeEmergency] = await sql`
    SELECT * FROM public.emergency_registers
    WHERE school_id = ${schoolId} AND status = 'ACTIVE'
    ORDER BY activated_at DESC LIMIT 1
  `;

  if (!activeEmergency) {
    return sendSuccess(res, schoolId, { isActive: false, emergency: null, muster: [] });
  }

  const muster = await sql`
    SELECT * FROM public.emergency_register_entries
    WHERE emergency_id = ${activeEmergency.id}
    ORDER BY status ASC, person_name ASC
  `;

  return sendSuccess(res, schoolId, { isActive: true, emergency: activeEmergency, muster });
}));

router.post('/emergency/activate', requirePermission('visitors.settings'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const userId = req.user.internal_id || req.user.id;
  const { incidentType, notes } = req.body;

  const result = await activateEmergencyMode({
    schoolId,
    activatedByUserId: userId,
    incidentType: incidentType || 'GENERAL',
    notes,
  });
  return sendSuccess(res, schoolId, { ...result, message: 'Emergency Mode Activated' });
}));

router.post('/emergency/resolve', requirePermission('visitors.settings'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const userId = req.user.internal_id || req.user.id;
  const { emergencyId, notes } = req.body;

  const resolved = await resolveEmergencyMode({
    schoolId,
    emergencyId,
    resolvedByUserId: userId,
    notes,
  });
  return sendSuccess(res, schoolId, { emergency: resolved, message: 'Emergency Mode Resolved' });
}));

router.post('/emergency/mark-entry', requirePermission('visitors.emergency'), asyncHandler(async (req, res) => {
  const { entryId, status, remarks } = req.body;
  const userId = req.user.internal_id || req.user.id;

  const [updated] = await sql`
    UPDATE public.emergency_register_entries ere
    SET status = ${status}, marked_by = ${userId}, marked_at = NOW(), remarks = ${remarks}
    FROM public.emergency_registers er
    WHERE ere.id = ${entryId}
      AND ere.emergency_id = er.id
      AND er.school_id = ${req.schoolId}
    RETURNING ere.*
  `;
  return sendSuccess(res, req.schoolId, { entry: updated });
}));

router.get('/search', requireAnyPermission(['visitors.scan', 'visitors.manage', 'visitors.checkin']), asyncHandler(async (req, res) => {
  const visitors = await searchCampusVisitors(req.schoolId, { query: req.query.q, limit: req.query.limit });
  return sendSuccess(res, req.schoolId, { visitors });
}));

router.get('/history', requireAnyPermission(['visitors.manage', 'visitors.scan', 'visitors.checkin']), asyncHandler(async (req, res) => {
  req.query.status = req.query.status || undefined;
  const schoolId = req.schoolId;
  const history = await sql`
    SELECT vr.*, vprof.full_name AS visitor_name, vprof.visitor_type, vc.checked_in_at, vc.checked_out_at, vc.visit_duration_minutes
    FROM public.visitor_requests vr
    JOIN public.visitor_profiles vprof ON vprof.id = vr.visitor_profile_id
    LEFT JOIN public.visitor_checkins vc ON vc.visitor_request_id = vr.id
    WHERE vr.school_id = ${schoolId} AND vr.deleted_at IS NULL
    ORDER BY vr.created_at DESC
    LIMIT 100
  `;
  return sendSuccess(res, schoolId, { history });
}));

router.get('/vehicles', requireAnyPermission(['visitors.scan', 'visitors.manage']), asyncHandler(async (req, res) => {
  const vehicles = await listVehicles(req.schoolId, { insideOnly: req.query.insideOnly === 'true' });
  return sendSuccess(res, req.schoolId, { vehicles });
}));

router.post('/vehicles', requirePermission('visitors.checkin'), asyncHandler(async (req, res) => {
  const { visitorProfileId, vehicleType, registrationNumber, parkingSlot, notes } = req.body;
  const [gate] = await sql`
    SELECT gg.gate_id FROM public.gatekeeper_gates gg
    WHERE gg.school_id = ${req.schoolId} AND gg.user_id = ${req.user.internal_id || req.user.id}
    ORDER BY gg.is_default DESC LIMIT 1
  `;
  const vehicle = await recordVehicleEntry({
    schoolId: req.schoolId,
    visitorProfileId,
    vehicleType,
    registrationNumber,
    entryGateId: req.body.gateId || gate?.gate_id,
    parkingSlot,
    notes,
  });
  return sendSuccess(res, req.schoolId, { vehicle });
}));

router.get('/contractors', requireAnyPermission(['visitors.scan', 'visitors.manage']), asyncHandler(async (req, res) => {
  const contractors = await listContractorPasses(req.schoolId);
  return sendSuccess(res, req.schoolId, { contractors });
}));

router.post('/contractors', requirePermission('visitors.manage'), asyncHandler(async (req, res) => {
  const result = await createContractorPass({
    schoolId: req.schoolId,
    ...req.body,
    fullName: req.body.fullName,
    mobileNumber: req.body.mobileNumber,
    companyName: req.body.companyName,
    validFrom: req.body.validFrom,
    validUntil: req.body.validUntil,
  });
  return sendSuccess(res, req.schoolId, result);
}));

router.get('/appointments/slots', requireAuth, asyncHandler(async (req, res) => {
  const slots = await listAppointmentSlots(req.schoolId, { hostUserId: req.query.hostUserId });
  return sendSuccess(res, req.schoolId, { slots });
}));

router.post('/appointments/slots', requirePermission('visitors.settings'), asyncHandler(async (req, res) => {
  const slot = await upsertAppointmentSlot({
    schoolId: req.schoolId,
    hostUserId: req.body.hostUserId,
    department: req.body.department,
    dayOfWeek: req.body.dayOfWeek,
    startTime: req.body.startTime,
    endTime: req.body.endTime,
    slotDurationMinutes: req.body.slotDurationMinutes,
    maxAppointments: req.body.maxAppointments,
  });
  return sendSuccess(res, req.schoolId, { slot });
}));

router.post('/appointments', requireAuth, asyncHandler(async (req, res) => {
  const appointment = await bookAppointment({
    schoolId: req.schoolId,
    hostUserId: req.body.hostUserId,
    requestedByUserId: req.user.internal_id || req.user.id,
    appointmentDate: req.body.appointmentDate,
    startTime: req.body.startTime,
    endTime: req.body.endTime,
    visitorRequestId: req.body.visitorRequestId,
  });
  return sendSuccess(res, req.schoolId, { appointment });
}));

router.post('/offline/sync', requireAnyPermission(['visitors.checkin', 'visitors.checkout', 'visitors.walkin']), asyncHandler(async (req, res) => {
  const result = await syncOfflineGateEvent({
    schoolId: req.schoolId,
    gatekeeperUserId: req.user.internal_id || req.user.id,
    clientEventId: req.body.clientEventId,
    eventType: req.body.eventType,
    payload: req.body.payload || {},
  });
  return sendSuccess(res, req.schoolId, result);
}));

router.get('/offline/cache', requirePermission('visitors.scan'), asyncHandler(async (req, res) => {
  const passes = await listTodayOfflineCache(req.schoolId);
  return sendSuccess(res, req.schoolId, { passes });
}));

router.get('/requests/:id/badge', requireAnyPermission(['visitors.scan', 'visitors.manage']), asyncHandler(async (req, res) => {
  const [request] = await sql`
    SELECT vr.*, vprof.full_name AS visitor_name, vprof.visitor_type, vp.pass_code, vc.checked_in_at
    FROM public.visitor_requests vr
    JOIN public.visitor_profiles vprof ON vprof.id = vr.visitor_profile_id
    LEFT JOIN public.visitor_passes vp ON vp.visitor_request_id = vr.id
    LEFT JOIN public.visitor_checkins vc ON vc.visitor_request_id = vr.id
    WHERE vr.id = ${req.params.id} AND vr.school_id = ${req.schoolId}
    LIMIT 1
  `;
  if (!request) return res.status(404).json({ error: 'Not found' });
  return sendSuccess(res, req.schoolId, { badge: buildDigitalBadge(request) });
}));

router.patch('/guardians/:id', requireAuth, asyncHandler(async (req, res) => {
  const { status, validUntil, notes } = req.body;
  const userId = req.user.internal_id || req.user.id;
  const [updated] = await sql`
    UPDATE public.authorized_guardians
    SET
      status = COALESCE(${status || null}, status),
      valid_until = COALESCE(${validUntil || null}, valid_until),
      notes = COALESCE(${notes || null}, notes),
      updated_at = NOW()
    WHERE id = ${req.params.id} AND school_id = ${req.schoolId}
      AND (parent_user_id = ${userId} OR ${visitorStaff(req)})
    RETURNING *
  `;
  return sendSuccess(res, req.schoolId, { guardian: updated });
}));

router.patch('/policies/:category', requirePermission('visitors.settings'), asyncHandler(async (req, res) => {
  const { policyType, isActive } = req.body;
  const [row] = await sql`
    INSERT INTO public.visitor_approval_policies (school_id, category, policy_type, is_active)
    VALUES (${req.schoolId}, ${req.params.category}, ${policyType || 'HOST_APPROVAL'}, ${isActive !== false})
    ON CONFLICT (school_id, category)
    DO UPDATE SET policy_type = EXCLUDED.policy_type, is_active = EXCLUDED.is_active, updated_at = NOW()
    RETURNING *
  `;
  return sendSuccess(res, req.schoolId, { policy: row });
}));

router.post('/gatekeepers/assign', requirePermission('visitors.settings'), asyncHandler(async (req, res) => {
  const { userId, gateId, isDefault = false } = req.body;
  if (!userId || !gateId) return res.status(400).json({ error: 'userId and gateId are required' });
  const [row] = await sql`
    INSERT INTO public.gatekeeper_gates (school_id, user_id, gate_id, is_default)
    VALUES (${req.schoolId}, ${userId}, ${gateId}, ${isDefault})
    ON CONFLICT (user_id, gate_id)
    DO UPDATE SET is_default = EXCLUDED.is_default
    RETURNING *
  `;
  return sendSuccess(res, req.schoolId, { assignment: row });
}));

router.get('/pickups', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const userId = req.user.internal_id || req.user.id;
  const staff = visitorStaff(req);
  const pickups = await sql`
    SELECT spa.*, p.display_name AS student_name, s.admission_no
    FROM public.student_pickup_authorizations spa
    JOIN public.students s ON s.id = spa.student_id
    JOIN public.persons p ON p.id = s.person_id
    WHERE spa.school_id = ${schoolId}
      ${staff ? sql`` : sql`AND spa.parent_user_id = ${userId}`}
    ORDER BY spa.pickup_date DESC, spa.created_at DESC
    LIMIT 50
  `;
  return sendSuccess(res, schoolId, { pickups });
}));

export default router;
