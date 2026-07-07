import sql from '../db.js';
import { approvalHandlers } from './approvalHandlers.js';
import { enrichFeeTransaction } from './feePaymentService.js';

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
export async function listApprovalRequests(schoolId, { status = 'PENDING', type } = {}) {
  return sql`
    SELECT
      ar.*,
      req_p.display_name as requested_by_name,
      rev_p.display_name as reviewed_by_name
    FROM approval_requests ar
    JOIN users req_u ON ar.requested_by = req_u.id
    JOIN persons req_p ON req_u.person_id = req_p.id
    LEFT JOIN users rev_u ON ar.reviewed_by = rev_u.id
    LEFT JOIN persons rev_p ON rev_u.person_id = rev_p.id
    WHERE ar.school_id = ${schoolId}
      ${status ? sql`AND ar.status = ${status}` : sql``}
      ${type ? sql`AND ar.type = ${type}` : sql``}
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

    const handler = approvalHandlers[request.type];
    if (!handler) {
      const err = new Error(`No handler registered for approval type: ${request.type}`);
      err.status = 500;
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

  return outcome;
}

/**
 * Reject a pending request — nothing is posted to the ledger.
 */
export async function rejectApprovalRequest(id, { schoolId, reviewerId, reviewReason }) {
  const [request] = await sql`
    SELECT id, status
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

  const [updated] = await sql`
    UPDATE approval_requests
    SET status = 'REJECTED',
        reviewed_by = ${reviewerId},
        reviewed_at = NOW(),
        reason = COALESCE(${reviewReason || null}, reason)
    WHERE id = ${id}
    RETURNING *
  `;

  return updated;
}
