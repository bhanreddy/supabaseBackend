import sql from '../db.js';
import { approvalHandlers } from './approvalHandlers.js';
import { enrichFeeTransaction } from './feePaymentService.js';
import { sendNotificationToUsers } from './notificationService.js';

const APPROVAL_TYPE_PERMISSIONS = Object.freeze({
  fee_underpayment: 'fee.underpayment.approve',
  leave: 'leaves.approve',
  concession: 'approvals.manage',
  expense: 'approvals.manage',
  marks_unlock: 'approvals.manage',
});

export function allowedApprovalTypes(user = {}) {
  const permissions = new Set(user.permissions || []);
  const types = Object.entries(APPROVAL_TYPE_PERMISSIONS)
    .filter(([, permission]) => permissions.has(permission))
    .map(([type]) => type);
  if (user.roles?.includes('admin')) types.push('fee_payment_deletion');
  return [...new Set(types)];
}

function assertCanReviewApprovalType(type, user) {
  if (!allowedApprovalTypes(user).includes(type)) {
    const error = new Error('You do not have permission to review this approval type');
    error.status = 403;
    error.code = 'APPROVAL_TYPE_FORBIDDEN';
    throw error;
  }
}

/**
 * Create a pending approval request. Does NOT execute the payload mutation.
 */
export async function createApprovalRequest({
  schoolId,
  type,
  payload,
  reason,
  requestedBy,
}) {
  const [row] = await sql`
    INSERT INTO approval_requests (school_id, type, requested_by, status, payload, reason)
    VALUES (
      ${schoolId},
      ${type},
      ${requestedBy},
      'PENDING',
      ${sql.json(payload)},
      ${reason || null}
    )
    RETURNING *
  `;
  return row;
}

/**
 * List approval requests for a school, optionally filtered by status/type.
 */
export async function listApprovalRequests(
  schoolId,
  { status = 'PENDING', type, types, includePaymentDeletion = true } = {}
) {
  const typeList = Array.isArray(types) && types.length > 0
    ? types
    : (type ? [type] : null);

  return sql`
    SELECT
      ar.*,
      req_p.display_name as requested_by_name,
      rev_p.display_name as reviewed_by_name,
      (SELECT req_email.contact_value
       FROM person_contacts req_email
       WHERE req_email.person_id = req_p.id
         AND req_email.school_id = ar.school_id
         AND req_email.contact_type = 'email'
         AND req_email.is_primary = true
         AND req_email.deleted_at IS NULL
       LIMIT 1) as requested_by_email,
      (SELECT rev_email.contact_value
       FROM person_contacts rev_email
       WHERE rev_email.person_id = rev_p.id
         AND rev_email.school_id = ar.school_id
         AND rev_email.contact_type = 'email'
         AND rev_email.is_primary = true
         AND rev_email.deleted_at IS NULL
       LIMIT 1) as reviewed_by_email
    FROM approval_requests ar
    JOIN users req_u ON ar.requested_by = req_u.id
    JOIN persons req_p ON req_u.person_id = req_p.id
    LEFT JOIN users rev_u ON ar.reviewed_by = rev_u.id
    LEFT JOIN persons rev_p ON rev_u.person_id = rev_p.id
    WHERE ar.school_id = ${schoolId}
      ${status ? sql`AND ar.status = ${status}` : sql``}
      ${typeList ? sql`AND ar.type IN ${sql(typeList)}` : sql``}
      ${includePaymentDeletion ? sql`` : sql`AND ar.type <> 'fee_payment_deletion'`}
    ORDER BY ar.created_at DESC
  `;
}

/**
 * Approve a pending request: runs the type handler inside one transaction.
 * Fee underpayment approval only grants a one-time collection authorization;
 * it does not post a ledger transaction.
 */
export async function approveApprovalRequest(id, { schoolId, reviewerId, user }) {
  const outcome = await sql.begin(async (trx) => {
    const [request] = await trx`
      SELECT *
      FROM approval_requests
      WHERE id = ${id}
        AND school_id = ${schoolId}
      FOR UPDATE
    `;

    if (!request) {
      const err = new Error('Approval request not found');
      err.status = 404;
      throw err;
    }
    if (request.status !== 'PENDING') {
      const err = new Error(`Request is already ${request.status.toLowerCase()}`);
      err.status = 409;
      throw err;
    }

    assertCanReviewApprovalType(request.type, user);

    // Self-approval restriction
    if (request.requested_by && reviewerId && String(request.requested_by) === String(reviewerId)) {
      const err = new Error('You cannot approve or reject your own request');
      err.status = 403;
      err.code = 'SELF_APPROVAL_PROHIBITED';
      throw err;
    }

    const handler = approvalHandlers[request.type];
    if (!handler) {
      const err = new Error('Unsupported approval request type');
      err.status = 409;
      err.code = 'UNSUPPORTED_APPROVAL_TYPE';
      throw err;
    }

    const result = await handler(request.payload, trx, { user, schoolId });

    const [updated] = await trx`
      UPDATE approval_requests
      SET status = 'APPROVED',
          reviewed_by = ${reviewerId},
          reviewed_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;

    return { request: updated, result };
  });

  if (outcome.result?.transaction) {
    outcome.result.transaction = await enrichFeeTransaction(outcome.result.transaction, schoolId);
  }

  if (outcome.request.type === 'fee_payment_deletion') {
    void sendNotificationToUsers(
      [outcome.request.requested_by],
      'FEE_PAYMENT_DELETION_APPROVED',
      { message: 'Admin approved your request. Open Receipts and delete the approved payment.' }
    ).catch(() => {});
  }

  return outcome;
}

/**
 * Reject a pending request — nothing is posted to the ledger.
 */
export async function rejectApprovalRequest(id, { schoolId, reviewerId, reviewReason, user }) {
  const updated = await sql.begin(async (trx) => {
    const [request] = await trx`
      SELECT id, status, type, requested_by
      FROM approval_requests
      WHERE id = ${id}
        AND school_id = ${schoolId}
      FOR UPDATE
    `;

    if (!request) {
      const err = new Error('Approval request not found');
      err.status = 404;
      throw err;
    }
    if (request.status !== 'PENDING') {
      const err = new Error(`Request is already ${request.status.toLowerCase()}`);
      err.status = 409;
      throw err;
    }

    assertCanReviewApprovalType(request.type, user);

    // Self-approval restriction
    if (request.requested_by && reviewerId && String(request.requested_by) === String(reviewerId)) {
      const err = new Error('You cannot approve or reject your own request');
      err.status = 403;
      err.code = 'SELF_APPROVAL_PROHIBITED';
      throw err;
    }

    const [row] = await trx`
      UPDATE approval_requests
      SET status = 'REJECTED',
          reviewed_by = ${reviewerId},
          reviewed_at = NOW(),
          reason = COALESCE(${reviewReason || null}, reason)
      WHERE id = ${id}
      RETURNING *
    `;
    return row;
  });

  if (updated.type === 'fee_payment_deletion') {
    void sendNotificationToUsers(
      [updated.requested_by],
      'FEE_PAYMENT_DELETION_REJECTED',
      { message: 'Admin rejected your payment deletion request. The ledger was not changed.' }
    ).catch(() => {});
  }

  return updated;
}
