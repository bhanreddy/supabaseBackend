import sql from '../db.js';
import { sendNotificationToUsers } from './notificationService.js';

const VALID_METHODS = ['cash', 'card', 'upi', 'bank_transfer', 'cheque', 'online'];

/**
 * Post a term-fee payment inside an existing transaction.
 * Caller must hold a row lock on student_fees when invoked from approval flow.
 */
export async function postTermFeePayment(tx, {
  student_fee_id,
  amount,
  payment_method,
  transaction_ref,
  remarks,
  user,
  schoolId,
}) {
  const parsedAmount = Number(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    const err = new Error('Amount must be a positive number');
    err.status = 400;
    throw err;
  }
  if (!transaction_ref) {
    const err = new Error('transaction_ref is required. Generate a UUID for cash payments.');
    err.status = 400;
    throw err;
  }
  if (!payment_method || !VALID_METHODS.includes(payment_method)) {
    const err = new Error(`payment_method must be one of: ${VALID_METHODS.join(', ')}`);
    err.status = 400;
    throw err;
  }

  const [existing] = await tx`
    SELECT id FROM fee_transactions WHERE transaction_ref = ${transaction_ref}
  `;
  if (existing) {
    const err = new Error(`Transaction reference '${transaction_ref}' already exists`);
    err.status = 409;
    throw err;
  }

  const [fee] = await tx`
    SELECT id, amount_due, amount_paid, discount, student_id
    FROM student_fees
    WHERE id = ${student_fee_id}
      AND school_id = ${schoolId}
    FOR UPDATE
  `;

  if (!fee) {
    const err = new Error('Student fee not found');
    err.status = 404;
    throw err;
  }

  const remaining = fee.amount_due - fee.discount - fee.amount_paid;
  if (parsedAmount > remaining) {
    const err = new Error(`Amount exceeds remaining balance of ${remaining}`);
    err.status = 400;
    throw err;
  }

  const [transaction] = await tx`
    INSERT INTO fee_transactions (student_fee_id, amount, payment_method, transaction_ref, received_by, remarks, school_id)
    VALUES (
      ${student_fee_id},
      ${parsedAmount},
      ${payment_method},
      ${transaction_ref},
      ${user?.internal_id || null},
      ${remarks || null},
      ${schoolId}
    )
    RETURNING *
  `;

  const [updatedFee] = await tx`
    UPDATE student_fees
    SET updated_at = NOW()
    WHERE id = ${student_fee_id}
      AND school_id = ${schoolId}
    RETURNING *
  `;

  if (!updatedFee) {
    const err = new Error('Student fee not found');
    err.status = 404;
    throw err;
  }

  return { transaction, fee: updatedFee };
}

async function getStudentFeeDuesForReceipt(studentId, schoolId) {
  const tuitionDues = await sql`
    SELECT
      sf.id as student_fee_id,
      ft.name as fee_type,
      COALESCE(ay.code, '—') as academic_year,
      sf.amount_due,
      sf.amount_paid,
      sf.discount,
      GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0) as balance_due,
      sf.status
    FROM student_fees sf
    JOIN fee_structures fs ON sf.fee_structure_id = fs.id
    JOIN fee_types ft ON fs.fee_type_id = ft.id
    LEFT JOIN academic_years ay ON fs.academic_year_id = ay.id
    WHERE sf.student_id = ${studentId}
      AND sf.school_id = ${schoolId}
      AND sf.deleted_at IS NULL
      AND fs.deleted_at IS NULL
    ORDER BY ft.name, ay.code NULLS LAST
  `;
  return tuitionDues;
}

/**
 * Enrich a posted transaction and fire fee-collected notifications (async).
 */
export async function enrichFeeTransaction(transaction, schoolId) {
  const [enrichedTransaction] = await sql`
    SELECT
      t.*,
      r.receipt_no,
      sf.student_id,
      p.display_name as student_name,
      s.admission_no,
      enroll.class_name, enroll.section_name,
      father_info.father_name, father_info.father_mobile,
      ft.name as fee_type, ft.name_te as fee_type_te,
      ay.code as academic_year,
      sf.amount_due,
      sf.amount_paid as total_paid,
      sf.discount,
      GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0) as balance_due
    FROM fee_transactions t
    LEFT JOIN receipt_items ri ON ri.fee_transaction_id = t.id AND ri.school_id = ${schoolId}
    LEFT JOIN receipts r ON r.id = ri.receipt_id AND r.school_id = ${schoolId}
    JOIN student_fees sf ON t.student_fee_id = sf.id
    JOIN students s ON sf.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    JOIN fee_structures fs ON sf.fee_structure_id = fs.id
    JOIN fee_types ft ON fs.fee_type_id = ft.id
    JOIN academic_years ay ON fs.academic_year_id = ay.id
    LEFT JOIN LATERAL (
      SELECT c.name as class_name, sec.name as section_name
      FROM student_enrollments se
      JOIN class_sections cs ON se.class_section_id = cs.id
      JOIN classes c ON cs.class_id = c.id
      JOIN sections sec ON cs.section_id = sec.id
      WHERE se.student_id = s.id AND se.status = 'active'
      ORDER BY se.created_at DESC
      LIMIT 1
    ) enroll ON true
    LEFT JOIN LATERAL (
      SELECT
        pp.display_name as father_name,
        (
          SELECT pc.contact_value
          FROM person_contacts pc
          WHERE pc.person_id = pp.id
            AND pc.school_id = ${schoolId}
            AND pc.contact_type = 'phone'
            AND pc.deleted_at IS NULL
          ORDER BY pc.is_primary DESC, pc.created_at
          LIMIT 1
        ) as father_mobile
      FROM student_parents sp
      JOIN parents par ON sp.parent_id = par.id AND par.deleted_at IS NULL
      JOIN persons pp ON par.person_id = pp.id
      LEFT JOIN relationship_types rt ON sp.relationship_id = rt.id
      WHERE sp.student_id = s.id
        AND sp.school_id = ${schoolId}
        AND sp.deleted_at IS NULL
      ORDER BY
        CASE WHEN rt.name = 'Father' THEN 0 WHEN COALESCE(sp.is_primary_contact, true) THEN 1 ELSE 2 END,
        sp.created_at
      LIMIT 1
    ) father_info ON true
    WHERE t.id = ${transaction.id}
      AND s.school_id = ${schoolId}
  `;

  if (!enrichedTransaction) {
    return transaction;
  }

  const fee_dues = await getStudentFeeDuesForReceipt(enrichedTransaction.student_id, schoolId);

  (async () => {
    try {
      const recipients = await sql`
        SELECT u.id as user_id FROM users u
        JOIN students s ON u.person_id = s.person_id
        WHERE s.id = ${enrichedTransaction.student_id}
          AND s.school_id = ${schoolId}
          AND u.school_id = ${schoolId}
          AND u.account_status = 'active'
        UNION
        SELECT u.id as user_id FROM users u
        JOIN parents p ON u.person_id = p.person_id AND p.school_id = ${schoolId}
        JOIN student_parents sp ON p.id = sp.parent_id AND sp.school_id = ${schoolId}
        WHERE sp.student_id = ${enrichedTransaction.student_id}
          AND u.school_id = ${schoolId}
          AND u.account_status = 'active'
      `;

      if (recipients.length > 0) {
        await sendNotificationToUsers(
          recipients.map((r) => r.user_id),
          'FEE_COLLECTED',
          { message: 'Your fee payment has been successfully recorded.' }
        );
      }
    } catch {
      // notification failure must not block payment
    }
  })();

  return { ...enrichedTransaction, fee_dues };
}

/**
 * Full collect flow: validates, posts in a transaction, enriches response.
 */
export async function executeTermFeePayment(params) {
  const { transaction, fee } = await sql.begin(async (tx) => {
    const result = await postTermFeePayment(tx, params);

    if (params.partialApprovalRequestId) {
      const [consumed] = await tx`
        UPDATE approval_requests
        SET payload = jsonb_set(
          jsonb_set(payload, '{consumed_at}', to_jsonb(NOW()::text), true),
          '{consumed_transaction_id}', to_jsonb(${String(result.transaction.id)}::text), true
        )
        WHERE id = ${params.partialApprovalRequestId}
          AND school_id = ${params.schoolId}
          AND type = 'fee_underpayment'
          AND status = 'APPROVED'
          AND payload->>'student_fee_id' = ${params.student_fee_id}
          AND payload->>'consumed_at' IS NULL
          AND (payload->>'amount')::numeric >= ${Number(params.amount)}
        RETURNING id
      `;

      if (!consumed) {
        const err = new Error('Approved partial payment permission is no longer available');
        err.status = 409;
        throw err;
      }
    }

    return result;
  });
  const enriched = await enrichFeeTransaction(transaction, params.schoolId);
  return { transaction: enriched, fee };
}

export function canBypassUnderpaymentApproval(user) {
  if (!user) return false;
  if (user.roles?.includes('admin')) return true;
  return user.permissions?.includes('fee.underpayment.approve');
}

/**
 * Read fee row and compute remaining balance (no lock).
 */
export async function getStudentFeeBalance(student_fee_id, schoolId) {
  const [fee] = await sql`
    SELECT
      sf.id,
      sf.amount_due,
      sf.amount_paid,
      sf.discount,
      sf.student_id,
      s.admission_no,
      p.display_name as student_name,
      ft.name as fee_type,
      enroll.class_name,
      enroll.section_name
    FROM student_fees sf
    JOIN students s ON sf.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    JOIN fee_structures fs ON sf.fee_structure_id = fs.id
    JOIN fee_types ft ON fs.fee_type_id = ft.id
    LEFT JOIN LATERAL (
      SELECT c.name as class_name, sec.name as section_name
      FROM student_enrollments se
      JOIN class_sections cs ON se.class_section_id = cs.id
      JOIN classes c ON cs.class_id = c.id
      JOIN sections sec ON cs.section_id = sec.id
      WHERE se.student_id = s.id AND se.status = 'active'
      ORDER BY se.created_at DESC
      LIMIT 1
    ) enroll ON true
    WHERE sf.id = ${student_fee_id}
      AND sf.school_id = ${schoolId}
      AND sf.deleted_at IS NULL
      AND s.deleted_at IS NULL
  `;
  if (!fee) return null;
  const remaining = fee.amount_due - fee.discount - fee.amount_paid;
  return { ...fee, remaining };
}

let partialFeePaymentColumnReady = false;

async function ensurePartialFeePaymentColumn() {
  if (partialFeePaymentColumnReady) return;
  await sql`
    ALTER TABLE schools
    ADD COLUMN IF NOT EXISTS partial_fee_payment_enabled BOOLEAN NOT NULL DEFAULT true
  `;
  partialFeePaymentColumnReady = true;
}

/** Whether this school allows collecting less than the full remaining fee balance. */
export async function isPartialFeePaymentEnabled(schoolId) {
  await ensurePartialFeePaymentColumn();
  const [row] = await sql`
    SELECT partial_fee_payment_enabled
    FROM schools
    WHERE id = ${schoolId}
  `;
  return row?.partial_fee_payment_enabled === true;
}
