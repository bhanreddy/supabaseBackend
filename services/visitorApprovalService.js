import sql from '../db.js';
import { issueVisitorPass } from './visitorQrService.js';
import { sendNotificationToUsers } from './notificationService.js';

/**
 * Resolves the applicable approval policy for a visitor request
 */
export async function resolveApprovalPolicy(schoolId, category, requestedByRole = 'PARENT') {
  const [settings] = await sql`
    SELECT parent_auto_approve, require_host_approval
    FROM public.school_visitor_settings
    WHERE school_id = ${schoolId}
    LIMIT 1
  `;

  if (requestedByRole === 'PARENT' && settings?.parent_auto_approve) {
    return 'AUTO_APPROVE';
  }

  const [policy] = await sql`
    SELECT policy_type FROM public.visitor_approval_policies
    WHERE school_id = ${schoolId} AND category = ${category} AND is_active = true
    LIMIT 1
  `;

  if (policy?.policy_type) {
    return policy.policy_type;
  }

  if (category === 'DELIVERY') return 'GATEKEEPER_APPROVAL';
  if (category === 'VENDOR' || category === 'CONTRACTOR') return 'ADMIN_APPROVAL';
  return settings?.require_host_approval === false ? 'AUTO_APPROVE' : 'HOST_APPROVAL';
}

/**
 * Approves a visitor request, issues the secure QR pass, and notifies parties
 */
export async function approveVisitorRequest({
  schoolId,
  requestId,
  approvedByUserId,
  notes = null,
}) {
  const [request] = await sql`
    SELECT vr.*, vprof.full_name AS visitor_name, vprof.mobile_number AS visitor_mobile
    FROM public.visitor_requests vr
    JOIN public.visitor_profiles vprof ON vprof.id = vr.visitor_profile_id
    WHERE vr.id = ${requestId} AND vr.school_id = ${schoolId}
    LIMIT 1
  `;

  if (!request) {
    throw new Error('Visitor request not found');
  }

  if (request.approval_status === 'APPROVED') {
    return { success: true, message: 'Already approved', requestId };
  }
  if (!['PENDING'].includes(request.approval_status)) {
    throw new Error('Only pending visitor requests can be approved');
  }

  const visitDateStr = new Date(request.visit_date).toISOString().split('T')[0];

  const [updatedReq, issued] = await sql.begin(async (tx) => {
    const [uReq] = await tx`
      UPDATE public.visitor_requests
      SET 
        approval_status = 'APPROVED',
        approved_by = ${approvedByUserId || null}::uuid,
        approved_at = NOW(),
        notes = COALESCE(notes, '') || CASE WHEN ${notes || null}::text IS NOT NULL THEN ' | ' || ${notes || null}::text ELSE '' END
      WHERE id = ${requestId} AND school_id = ${schoolId} AND approval_status = 'PENDING'
      RETURNING *
    `;

    if (!uReq) {
      throw new Error('Visitor request not found or already processed');
    }

    const issuedPass = await issueVisitorPass({
      schoolId,
      requestId,
      visitDate: request.visit_date,
      startTime: request.start_time,
      endTime: request.end_time,
      executor: tx,
    });

    await tx`
      INSERT INTO public.visitor_audit_events (
        school_id, user_id, user_role, event_type, entity_type, entity_id, metadata
      ) VALUES (
        ${schoolId}, ${approvedByUserId || null}::uuid, 'approver', 'VISITOR_REQUEST_APPROVED',
        'visitor_requests', ${requestId},
        ${tx.json({ visitorName: request.visitor_name, passCode: issuedPass.pass.pass_code })}
      )
    `;

    return [uReq, issuedPass];
  });

  // Notify visitor / parent
  if (request.requested_by_user_id) {
    try {
      await sendNotificationToUsers(
        [request.requested_by_user_id],
        'VISITOR_REQUEST_APPROVED',
        {
          title: 'Campus Visit Approved',
          body: `Your visit request for ${request.visitor_name} on ${visitDateStr} has been approved. Your pass code is ${issued.pass.pass_code}.`,
          visitorName: request.visitor_name,
          passCode: issued.pass.pass_code,
          visitDate: visitDateStr,
          message: `Your visit request for ${request.visitor_name} on ${visitDateStr} has been approved.`,
        },
        { schoolId }
      );
    } catch (notifErr) {
      console.error('[VisitorApprovalService] Notification error:', notifErr.message);
    }
  }

  return {
    request: updatedReq,
    pass: issued.pass,
    qrToken: issued.qrToken,
  };
}

/**
 * Rejects a visitor request
 */
export async function rejectVisitorRequest({
  schoolId,
  requestId,
  rejectedByUserId,
  rejectionReason = 'Administrative decision',
}) {
  const [updated] = await sql`
    UPDATE public.visitor_requests
    SET 
      approval_status = 'REJECTED',
      rejected_by = ${rejectedByUserId || null}::uuid,
      rejected_at = NOW(),
      rejection_reason = ${rejectionReason}
    WHERE id = ${requestId} AND school_id = ${schoolId} AND approval_status = 'PENDING'
    RETURNING *
  `;

  if (!updated) {
    throw new Error('Visitor request not found or already processed');
  }

  await sql`
    INSERT INTO public.visitor_audit_events (
      school_id, user_id, user_role, event_type, entity_type, entity_id, metadata
    ) VALUES (
      ${schoolId}, ${rejectedByUserId || null}::uuid, 'approver', 'VISITOR_REQUEST_REJECTED',
      'visitor_requests', ${requestId},
      ${sql.json({ rejectionReason })}
    )
  `;

  if (updated.requested_by_user_id) {
    try {
      await sendNotificationToUsers(
        [updated.requested_by_user_id],
        'VISITOR_REQUEST_REJECTED',
        {
          title: 'Campus Visit Request Declined',
          body: `Your visit request was declined: ${rejectionReason}`,
          reason: rejectionReason,
          message: `Your visit request was declined: ${rejectionReason}`,
        },
        { schoolId }
      );
    } catch (notifErr) {
      console.error('[VisitorApprovalService] Notification error:', notifErr.message);
    }
  }

  return updated;
}
