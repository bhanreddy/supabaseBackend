import express from 'express';
import crypto from 'crypto';
import sql from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

const VALID_METHODS = ['cash', 'card', 'upi', 'bank_transfer', 'cheque', 'online'];

/**
 * POST /api/v1/refunds
 * Execute a fee refund. Management-only — gated by requirePermission('refund.create'),
 * which only admin/principal hold (accounts and staff do not). See RBAC epic #11.
 *
 * A refund is stored as a NEGATIVE fee_transactions row linked to the original
 * payment via refund_of; the fee_transactions insert trigger decrements
 * student_fees.amount_paid (refunds are negative-amount inserts). school_id is
 * ALWAYS derived from the JWT (req.schoolId, allowlisted in middleware/schoolId.js),
 * never from the client body/query.
 */
router.post('/', requireAuth, requirePermission('refund.create'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId; // JWT-derived
  const { student_fee_id, amount, payment_method, original_transaction_id, reason } = req.body;

  const refundAmount = Number(amount);
  if (!student_fee_id || !Number.isFinite(refundAmount) || refundAmount <= 0) {
    return res.status(400).json({ error: 'student_fee_id and a positive amount are required' });
  }
  if (!payment_method || !VALID_METHODS.includes(payment_method)) {
    return res.status(400).json({ error: `payment_method must be one of: ${VALID_METHODS.join(', ')}` });
  }

  try {
    const refund = await sql.begin(async (tx) => {
      // Lock the fee row, scoped to this tenant.
      const [fee] = await tx`
        SELECT id FROM student_fees
        WHERE id = ${student_fee_id} AND school_id = ${schoolId} AND deleted_at IS NULL
        FOR UPDATE
      `;
      if (!fee) {
        const e = new Error('Student fee not found');
        e.status = 404;
        throw e;
      }

      // Net already collected on this fee = payments minus prior refunds.
      const [{ net_paid }] = await tx`
        SELECT COALESCE(SUM(amount), 0)::numeric AS net_paid
        FROM fee_transactions
        WHERE student_fee_id = ${student_fee_id} AND school_id = ${schoolId}
      `;
      const netPaid = Number(net_paid);
      if (refundAmount > netPaid) {
        const e = new Error(`Refund exceeds the collected amount (${netPaid})`);
        e.status = 400;
        throw e;
      }

      // Every refund links to a real prior payment (chk_refund_must_be_negative model).
      let linkedTxnId = original_transaction_id || null;
      if (linkedTxnId) {
        const [orig] = await tx`
          SELECT id FROM fee_transactions
          WHERE id = ${linkedTxnId}
            AND student_fee_id = ${student_fee_id}
            AND school_id = ${schoolId}
            AND refund_of IS NULL
            AND amount > 0
        `;
        if (!orig) {
          const e = new Error('Original payment transaction not found for this fee');
          e.status = 404;
          throw e;
        }
      } else {
        const [latest] = await tx`
          SELECT id FROM fee_transactions
          WHERE student_fee_id = ${student_fee_id}
            AND school_id = ${schoolId}
            AND refund_of IS NULL
            AND amount > 0
          ORDER BY paid_at DESC
          LIMIT 1
        `;
        if (!latest) {
          const e = new Error('No payment exists to refund against');
          e.status = 400;
          throw e;
        }
        linkedTxnId = latest.id;
      }

      const [row] = await tx`
        INSERT INTO fee_transactions (
          student_fee_id, amount, payment_method, transaction_ref,
          received_by, remarks, refund_of, school_id
        ) VALUES (
          ${student_fee_id},
          ${-Math.abs(refundAmount)},
          ${payment_method},
          ${crypto.randomUUID()},
          ${req.user?.internal_id || null},
          ${reason ? `Refund: ${String(reason).slice(0, 480)}` : 'Refund'},
          ${linkedTxnId},
          ${schoolId}
        )
        RETURNING *
      `;
      return row;
    });

    return sendSuccess(res, schoolId, { message: 'Refund processed', refund }, 201);
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
}));

export default router;
