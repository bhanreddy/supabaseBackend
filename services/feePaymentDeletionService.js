import { randomUUID } from 'crypto';
import sql from '../db.js';
import { createApprovalRequest } from './approvalService.js';
import { sendNotificationToUsers } from './notificationService.js';

const DELETION_TYPE = 'fee_payment_deletion';

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function scopeKeyFor(transaction) {
  return transaction.receipt_group
    ? `receipt_group:${transaction.receipt_group}`
    : `transaction:${transaction.id}`;
}

async function readOriginalTransaction(transactionId, schoolId, db = sql, lock = false) {
  const rows = lock
    ? await db`
        SELECT
          t.*, sf.student_id, s.admission_no, p.display_name AS student_name,
          ft.name AS fee_type, ay.code AS academic_year,
          r.receipt_no, enroll.class_name, enroll.section_name
        FROM fee_transactions t
        JOIN student_fees sf ON t.student_fee_id = sf.id AND sf.school_id = ${schoolId}
        JOIN students s ON sf.student_id = s.id AND s.school_id = ${schoolId}
        JOIN persons p ON s.person_id = p.id
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        JOIN fee_types ft ON fs.fee_type_id = ft.id
        LEFT JOIN academic_years ay ON fs.academic_year_id = ay.id
        LEFT JOIN receipt_items ri ON ri.fee_transaction_id = t.id AND ri.school_id = ${schoolId}
        LEFT JOIN receipts r ON r.id = ri.receipt_id AND r.school_id = ${schoolId}
        LEFT JOIN LATERAL (
          SELECT c.name AS class_name, sec.name AS section_name
          FROM student_enrollments se
          JOIN class_sections cs ON se.class_section_id = cs.id
          JOIN classes c ON cs.class_id = c.id
          JOIN sections sec ON cs.section_id = sec.id
          WHERE se.student_id = s.id AND se.status = 'active'
          ORDER BY se.created_at DESC
          LIMIT 1
        ) enroll ON true
        WHERE t.id = ${transactionId}
          AND t.school_id = ${schoolId}
          AND t.refund_of IS NULL
          AND t.amount > 0
        FOR UPDATE OF t
      `
    : await db`
        SELECT
          t.*, sf.student_id, s.admission_no, p.display_name AS student_name,
          ft.name AS fee_type, ay.code AS academic_year,
          r.receipt_no, enroll.class_name, enroll.section_name
        FROM fee_transactions t
        JOIN student_fees sf ON t.student_fee_id = sf.id AND sf.school_id = ${schoolId}
        JOIN students s ON sf.student_id = s.id AND s.school_id = ${schoolId}
        JOIN persons p ON s.person_id = p.id
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        JOIN fee_types ft ON fs.fee_type_id = ft.id
        LEFT JOIN academic_years ay ON fs.academic_year_id = ay.id
        LEFT JOIN receipt_items ri ON ri.fee_transaction_id = t.id AND ri.school_id = ${schoolId}
        LEFT JOIN receipts r ON r.id = ri.receipt_id AND r.school_id = ${schoolId}
        LEFT JOIN LATERAL (
          SELECT c.name AS class_name, sec.name AS section_name
          FROM student_enrollments se
          JOIN class_sections cs ON se.class_section_id = cs.id
          JOIN classes c ON cs.class_id = c.id
          JOIN sections sec ON cs.section_id = sec.id
          WHERE se.student_id = s.id AND se.status = 'active'
          ORDER BY se.created_at DESC
          LIMIT 1
        ) enroll ON true
        WHERE t.id = ${transactionId}
          AND t.school_id = ${schoolId}
          AND t.refund_of IS NULL
          AND t.amount > 0
      `;
  return rows[0] || null;
}

async function readScope(anchor, schoolId, db = sql, lock = false) {
  if (!anchor.receipt_group) return [anchor];

  const rows = lock
    ? await db`
        SELECT t.*, ft.name AS fee_type, ay.code AS academic_year
        FROM fee_transactions t
        JOIN student_fees sf ON t.student_fee_id = sf.id AND sf.school_id = ${schoolId}
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        JOIN fee_types ft ON fs.fee_type_id = ft.id
        LEFT JOIN academic_years ay ON fs.academic_year_id = ay.id
        WHERE t.school_id = ${schoolId}
          AND t.receipt_group = ${anchor.receipt_group}
          AND t.refund_of IS NULL
          AND t.amount > 0
        ORDER BY t.created_at, t.id
        FOR UPDATE
      `
    : await db`
        SELECT t.*, ft.name AS fee_type, ay.code AS academic_year
        FROM fee_transactions t
        JOIN student_fees sf ON t.student_fee_id = sf.id AND sf.school_id = ${schoolId}
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        JOIN fee_types ft ON fs.fee_type_id = ft.id
        LEFT JOIN academic_years ay ON fs.academic_year_id = ay.id
        WHERE t.school_id = ${schoolId}
          AND t.receipt_group = ${anchor.receipt_group}
          AND t.refund_of IS NULL
          AND t.amount > 0
        ORDER BY t.created_at, t.id
      `;
  return rows;
}

async function assertNotReversed(transactionIds, schoolId, db = sql) {
  const [row] = await db`
    SELECT id
    FROM fee_transactions
    WHERE school_id = ${schoolId}
      AND refund_of = ANY(${transactionIds})
    LIMIT 1
  `;
  if (row) throw httpError('This payment has already been deleted or refunded', 409);
}

async function readOriginalTransportPayment(transactionId, schoolId, db = sql, lock = false) {
  const rows = lock
    ? await db`
        SELECT
          tfp.*,
          s.admission_no, p.display_name AS student_name,
          r.receipt_no, enroll.class_name, enroll.section_name
        FROM transport_fee_payments tfp
        JOIN students s ON tfp.student_id = s.id AND s.school_id = ${schoolId}
        JOIN persons p ON s.person_id = p.id
        LEFT JOIN receipts r ON r.transport_payment_id = tfp.id AND r.school_id = ${schoolId}
        LEFT JOIN LATERAL (
          SELECT c.name AS class_name, sec.name AS section_name
          FROM student_enrollments se
          JOIN class_sections cs ON se.class_section_id = cs.id
          JOIN classes c ON cs.class_id = c.id
          JOIN sections sec ON cs.section_id = sec.id
          WHERE se.student_id = s.id AND se.status = 'active'
          ORDER BY se.created_at DESC
          LIMIT 1
        ) enroll ON true
        WHERE tfp.id = ${transactionId}
          AND tfp.school_id = ${schoolId}
          AND tfp.refund_of IS NULL
          AND tfp.amount > 0
        FOR UPDATE OF tfp
      `
    : await db`
        SELECT
          tfp.*,
          s.admission_no, p.display_name AS student_name,
          r.receipt_no, enroll.class_name, enroll.section_name
        FROM transport_fee_payments tfp
        JOIN students s ON tfp.student_id = s.id AND s.school_id = ${schoolId}
        JOIN persons p ON s.person_id = p.id
        LEFT JOIN receipts r ON r.transport_payment_id = tfp.id AND r.school_id = ${schoolId}
        LEFT JOIN LATERAL (
          SELECT c.name AS class_name, sec.name AS section_name
          FROM student_enrollments se
          JOIN class_sections cs ON se.class_section_id = cs.id
          JOIN classes c ON cs.class_id = c.id
          JOIN sections sec ON cs.section_id = sec.id
          WHERE se.student_id = s.id AND se.status = 'active'
          ORDER BY se.created_at DESC
          LIMIT 1
        ) enroll ON true
        WHERE tfp.id = ${transactionId}
          AND tfp.school_id = ${schoolId}
          AND tfp.refund_of IS NULL
          AND tfp.amount > 0
      `;
  return rows[0] || null;
}

async function assertTransportNotReversed(transactionIds, schoolId, db = sql) {
  const [row] = await db`
    SELECT id
    FROM transport_fee_payments
    WHERE school_id = ${schoolId}
      AND refund_of = ANY(${transactionIds})
    LIMIT 1
  `;
  if (row) throw httpError('This payment has already been deleted or refunded', 409);
}

async function notifyAdminsOfDeletionRequest(schoolId, studentName, totalAmount) {
  try {
    const admins = await sql`
      SELECT DISTINCT ur.user_id
      FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id AND r.school_id = ${schoolId}
      JOIN users u ON ur.user_id = u.id AND u.school_id = ${schoolId}
      WHERE ur.school_id = ${schoolId}
        AND r.code = 'admin'
        AND u.account_status = 'active'
        AND u.deleted_at IS NULL
    `;
    await sendNotificationToUsers(
      admins.map((row) => row.user_id),
      'FEE_PAYMENT_DELETION_REQUESTED',
      { message: `${studentName}: ₹${Number(totalAmount).toLocaleString('en-IN')} deletion requested.` }
    );
  } catch {
    // Approval queue persistence is authoritative; push failure is non-blocking.
  }
}

async function requestTransportFeePaymentDeletion({ transactionId, reason, schoolId, requestedBy }) {
  const anchor = await readOriginalTransportPayment(transactionId, schoolId);
  if (!anchor) throw httpError('Payment not found', 404);
  if (anchor.received_by !== requestedBy) {
    throw httpError('You can only request deletion of payments you collected', 403);
  }

  const transactionIds = [anchor.id];
  await assertTransportNotReversed(transactionIds, schoolId);
  const scopeKey = `transaction:${anchor.id}`;

  const [activeRequest] = await sql`
    SELECT id, status
    FROM approval_requests
    WHERE school_id = ${schoolId}
      AND type = ${DELETION_TYPE}
      AND payload->>'scope_key' = ${scopeKey}
      AND status IN ('PENDING', 'APPROVED')
      AND payload->>'consumed_at' IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (activeRequest) {
    throw httpError(`A deletion request is already ${activeRequest.status.toLowerCase()}`, 409);
  }

  const lineItems = [{
    transaction_id: anchor.id,
    student_fee_id: null,
    transport_payment_id: anchor.id,
    amount: Number(anchor.amount),
    payment_method: anchor.payment_method,
    transaction_ref: anchor.transaction_ref,
    fee_type: 'Transport Fee',
    academic_year: anchor.academic_year || null,
  }];

  let request;
  try {
    request = await createApprovalRequest({
      schoolId,
      type: DELETION_TYPE,
      requestedBy,
      reason,
      payload: {
        transaction_source: 'transport',
        scope_key: scopeKey,
        anchor_transaction_id: anchor.id,
        transaction_ids: transactionIds,
        receipt_group: null,
        receipt_no: anchor.receipt_no || null,
        student_id: anchor.student_id,
        student_name: anchor.student_name,
        admission_no: anchor.admission_no,
        class_name: anchor.class_name || null,
        section_name: anchor.section_name || null,
        fee_type: 'Transport Fee',
        academic_year: anchor.academic_year || null,
        payment_method: anchor.payment_method,
        paid_at: anchor.paid_at,
        total_amount: Number(anchor.amount),
        line_items: lineItems,
      },
    });
  } catch (error) {
    if (error?.code === '23505') {
      throw httpError('A deletion request is already active for this payment', 409);
    }
    throw error;
  }

  void notifyAdminsOfDeletionRequest(schoolId, anchor.student_name, request.payload.total_amount);
  return request;
}

async function executeApprovedTransportFeePaymentDeletion({
  transactionId,
  approval,
  schoolId,
  accountantId,
  tx,
}) {
  const transactionIds = Array.isArray(approval.payload?.transaction_ids)
    ? approval.payload.transaction_ids.map(String)
    : [];
  if (!transactionIds.includes(String(transactionId))) {
    throw httpError('This approval is not valid for the selected payment', 403);
  }

  const anchor = await readOriginalTransportPayment(transactionId, schoolId, tx, true);
  if (!anchor) throw httpError('Payment not found', 404);
  if (`transaction:${anchor.id}` !== approval.payload?.scope_key) {
    throw httpError('Payment scope no longer matches the approved request', 409);
  }
  if (anchor.received_by !== accountantId) {
    throw httpError('Only the original accountant can delete this payment', 403);
  }
  await assertTransportNotReversed(transactionIds, schoolId, tx);

  const [reversal] = await tx`
    INSERT INTO transport_fee_payments (
      school_id, student_id, academic_year, transport_fee_id,
      amount, payment_method, transaction_ref, received_by, remarks, refund_of
    ) VALUES (
      ${schoolId},
      ${anchor.student_id},
      ${anchor.academic_year},
      ${anchor.transport_fee_id},
      ${-Number(anchor.amount)},
      ${anchor.payment_method},
      ${`VOID-${approval.id}-1`},
      ${accountantId},
      ${`Approved payment deletion: ${approval.reason}`},
      ${anchor.id}
    )
    RETURNING *
  `;

  await tx`
    UPDATE approval_requests
    SET payload = payload || jsonb_build_object(
          'consumed_at', NOW()::text,
          'consumed_by', ${accountantId}::text,
          'reversal_transaction_ids', ${sql.json([reversal.id])}
        )
    WHERE id = ${approval.id}
  `;

  await tx`
    INSERT INTO audit_logs (user_id, action, entity, entity_id, details, school_id)
    VALUES (
      ${accountantId},
      'FEE_PAYMENT_DELETED',
      'transport_fee_payment',
      ${String(transactionId)},
      ${sql.json({
        approval_request_id: approval.id,
        original_transaction_ids: transactionIds,
        reversal_transaction_ids: [reversal.id],
        reason: approval.reason,
      })},
      ${schoolId}
    )
  `;

  return {
    message: 'Payment deleted and ledger balance restored',
    approval_request_id: approval.id,
    original_transaction_ids: transactionIds,
    reversal_transaction_ids: [reversal.id],
  };
}

export async function requestFeePaymentDeletion({ transactionId, reason, schoolId, requestedBy }) {
  const normalizedReason = String(reason || '').trim();
  if (!normalizedReason) throw httpError('A deletion reason is required');

  const anchor = await readOriginalTransaction(transactionId, schoolId);
  if (!anchor) {
    return requestTransportFeePaymentDeletion({
      transactionId,
      reason: normalizedReason,
      schoolId,
      requestedBy,
    });
  }
  if (anchor.received_by !== requestedBy) {
    throw httpError('You can only request deletion of payments you collected', 403);
  }

  const scope = await readScope(anchor, schoolId);
  if (scope.some((row) => row.received_by !== requestedBy)) {
    throw httpError('The combined payment is not owned by the current accountant', 403);
  }

  const transactionIds = scope.map((row) => row.id);
  await assertNotReversed(transactionIds, schoolId);
  const scopeKey = scopeKeyFor(anchor);

  const [activeRequest] = await sql`
    SELECT id, status
    FROM approval_requests
    WHERE school_id = ${schoolId}
      AND type = ${DELETION_TYPE}
      AND payload->>'scope_key' = ${scopeKey}
      AND status IN ('PENDING', 'APPROVED')
      AND payload->>'consumed_at' IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (activeRequest) {
    throw httpError(`A deletion request is already ${activeRequest.status.toLowerCase()}`, 409);
  }

  const lineItems = scope.map((row) => ({
    transaction_id: row.id,
    student_fee_id: row.student_fee_id,
    amount: Number(row.amount),
    payment_method: row.payment_method,
    transaction_ref: row.transaction_ref,
    fee_type: row.fee_type || null,
    academic_year: row.academic_year || null,
  }));

  let request;
  try {
    request = await createApprovalRequest({
      schoolId,
      type: DELETION_TYPE,
      requestedBy,
      reason: normalizedReason,
      payload: {
        scope_key: scopeKey,
        anchor_transaction_id: anchor.id,
        transaction_ids: transactionIds,
        receipt_group: anchor.receipt_group || null,
        receipt_no: anchor.receipt_no || null,
        student_id: anchor.student_id,
        student_name: anchor.student_name,
        admission_no: anchor.admission_no,
        class_name: anchor.class_name || null,
        section_name: anchor.section_name || null,
        fee_type: anchor.fee_type,
        academic_year: anchor.academic_year || null,
        payment_method: anchor.payment_method,
        paid_at: anchor.paid_at,
        total_amount: lineItems.reduce((sum, item) => sum + item.amount, 0),
        line_items: lineItems,
      },
    });
  } catch (error) {
    if (error?.code === '23505') {
      throw httpError('A deletion request is already active for this payment', 409);
    }
    throw error;
  }

  (async () => {
    try {
      const admins = await sql`
        SELECT DISTINCT ur.user_id
        FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id AND r.school_id = ${schoolId}
        JOIN users u ON ur.user_id = u.id AND u.school_id = ${schoolId}
        WHERE ur.school_id = ${schoolId}
          AND r.code = 'admin'
          AND u.account_status = 'active'
          AND u.deleted_at IS NULL
      `;
      await sendNotificationToUsers(
        admins.map((row) => row.user_id),
        'FEE_PAYMENT_DELETION_REQUESTED',
        { message: `${anchor.student_name}: ₹${Number(request.payload.total_amount).toLocaleString('en-IN')} deletion requested.` }
      );
    } catch {
      // Approval queue persistence is authoritative; push failure is non-blocking.
    }
  })();

  return request;
}

export async function executeApprovedFeePaymentDeletion({
  transactionId,
  approvalRequestId,
  schoolId,
  accountantId,
}) {
  return sql.begin(async (tx) => {
    const [approval] = await tx`
      SELECT *
      FROM approval_requests
      WHERE id = ${approvalRequestId}
        AND school_id = ${schoolId}
        AND type = ${DELETION_TYPE}
      FOR UPDATE
    `;
    if (!approval) throw httpError('Deletion approval not found', 404);
    if (approval.requested_by !== accountantId) {
      throw httpError('Only the requesting accountant can delete this payment', 403);
    }
    if (approval.status !== 'APPROVED') {
      throw httpError('Admin approval is required before deleting this payment', 409);
    }
    if (approval.payload?.consumed_at) {
      throw httpError('This deletion approval has already been used', 409);
    }

    if (approval.payload?.transaction_source === 'transport') {
      return executeApprovedTransportFeePaymentDeletion({
        transactionId,
        approval,
        schoolId,
        accountantId,
        tx,
      });
    }

    const transactionIds = Array.isArray(approval.payload?.transaction_ids)
      ? approval.payload.transaction_ids.map(String)
      : [];
    if (!transactionIds.includes(String(transactionId))) {
      throw httpError('This approval is not valid for the selected payment', 403);
    }

    const anchor = await readOriginalTransaction(transactionId, schoolId, tx, true);
    if (!anchor) throw httpError('Payment not found', 404);
    if (scopeKeyFor(anchor) !== approval.payload?.scope_key) {
      throw httpError('Payment scope no longer matches the approved request', 409);
    }

    const scope = await readScope(anchor, schoolId, tx, true);
    const currentIds = scope.map((row) => String(row.id));
    if (
      currentIds.length !== transactionIds.length ||
      currentIds.some((id) => !transactionIds.includes(id))
    ) {
      throw httpError('Payment contents changed after approval', 409);
    }
    if (scope.some((row) => row.received_by !== accountantId)) {
      throw httpError('Only the original accountant can delete this payment', 403);
    }
    await assertNotReversed(transactionIds, schoolId, tx);

    const reversalGroup = randomUUID();
    const reversals = [];
    for (let index = 0; index < scope.length; index += 1) {
      const original = scope[index];
      const [reversal] = await tx`
        INSERT INTO fee_transactions (
          student_fee_id, amount, payment_method, transaction_ref,
          received_by, remarks, refund_of, receipt_group, school_id
        ) VALUES (
          ${original.student_fee_id},
          ${-Number(original.amount)},
          ${original.payment_method},
          ${`VOID-${approval.id}-${index + 1}`},
          ${accountantId},
          ${`Approved payment deletion: ${approval.reason}`},
          ${original.id},
          ${reversalGroup},
          ${schoolId}
        )
        RETURNING *
      `;
      reversals.push(reversal);
    }

    const reversalIds = reversals.map((row) => row.id);
    await tx`
      UPDATE approval_requests
      SET payload = payload || jsonb_build_object(
            'consumed_at', NOW()::text,
            'consumed_by', ${accountantId}::text,
            'reversal_transaction_ids', ${sql.json(reversalIds)},
            'reversal_receipt_group', ${reversalGroup}::text
          )
      WHERE id = ${approval.id}
    `;

    await tx`
      INSERT INTO audit_logs (user_id, action, entity, entity_id, details, school_id)
      VALUES (
        ${accountantId},
        'FEE_PAYMENT_DELETED',
        'fee_transaction',
        ${String(transactionId)},
        ${sql.json({
          approval_request_id: approval.id,
          original_transaction_ids: transactionIds,
          reversal_transaction_ids: reversalIds,
          reason: approval.reason,
        })},
        ${schoolId}
      )
    `;

    return {
      message: 'Payment deleted and ledger balance restored',
      approval_request_id: approval.id,
      original_transaction_ids: transactionIds,
      reversal_transaction_ids: reversalIds,
    };
  });
}

export { DELETION_TYPE as FEE_PAYMENT_DELETION_APPROVAL_TYPE };
