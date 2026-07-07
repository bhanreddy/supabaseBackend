import express from 'express';
import sql from '../db.js';
import { verifyToken, requirePermission } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { isPreviousAcademicYear } from '../utils/academicYearCompare.js';
import { getActiveAcademicYearCode } from '../services/defaulterCarryForward.js';
import { sendNotificationToUsers } from '../services/notificationService.js';

const router = express.Router();

const VALID_PAYMENT_METHODS = ['cash', 'card', 'upi', 'bank_transfer', 'cheque', 'online'];

const accountsGuard = [
  verifyToken,
  requireRole('accounts', 'admin', 'principal'),
];

function isUniqueViolation(err) {
  return err?.code === '23505';
}

function formatInr(amount) {
  return `₹${Number(amount || 0).toLocaleString('en-IN')}`;
}

async function resolveNotificationUserIds(studentIds, schoolId) {
  if (!studentIds.length) return [];

  const studentUsers = await sql`
    SELECT DISTINCT u.id AS user_id
    FROM users u
    JOIN students s ON u.person_id = s.person_id
    WHERE s.id IN ${sql(studentIds)}
      AND s.school_id = ${schoolId}
      AND u.school_id = ${schoolId}
      AND u.account_status = 'active'
  `;

  const parentUsers = await sql`
    SELECT DISTINCT u.id AS user_id
    FROM users u
    JOIN parents p ON u.person_id = p.person_id AND p.school_id = ${schoolId}
    JOIN student_parents sp ON p.id = sp.parent_id AND sp.school_id = ${schoolId}
    WHERE sp.student_id IN ${sql(studentIds)}
      AND u.school_id = ${schoolId}
      AND u.account_status = 'active'
  `;

  return [...new Set([
    ...studentUsers.map((r) => r.user_id),
    ...parentUsers.map((r) => r.user_id),
  ])];
}

function buildArrearsReminderMessage(student, customMessage) {
  if (customMessage?.trim()) return customMessage.trim();

  const years = (student.year_breakdown || [])
    .filter((y) => Number(y.balance) > 0)
    .map((y) => `${y.due_academic_year}: ${formatInr(y.balance)}`);

  const yearText = years.length > 0 ? years.join('; ') : 'previous academic year(s)';
  return `Outstanding previous-year fee balance of ${formatInr(student.total_balance)} (${yearText}). Please clear at the earliest.`;
}

async function generateReceiptNo(tx, schoolId) {
  const [row] = await tx`
    SELECT 'RCT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(NEXTVAL('receipt_no_seq')::TEXT, 4, '0') AS receipt_no
  `;
  return row?.receipt_no;
}

/**
 * GET /defaulters
 * List students with previous-year balance > 0, aggregated per student.
 */
router.get(
  '/',
  [...accountsGuard, requirePermission('fees.view')],
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { search, class_filter, year_filter, student_id } = req.query;

    const activeYearCode = await getActiveAcademicYearCode(schoolId);
    if (!activeYearCode) {
      return sendError(res, 400, 'No active academic year configured for this school.');
    }

    const activeStartYear = parseInt(activeYearCode.split('-')[0], 10) || 0;

    const rows = await sql`
      SELECT
        s.id AS student_id,
        s.admission_no,
        p.display_name AS student_name,
        enroll.class_id,
        enroll.class_name,
        enroll.section_name,
        SUM(dd.balance)::numeric AS total_balance,
        json_agg(
          json_build_object(
            'id', dd.id,
            'due_academic_year', dd.due_academic_year,
            'original_amount', dd.original_amount,
            'paid_amount', dd.paid_amount,
            'balance', dd.balance,
            'status', dd.status,
            'source', dd.source,
            'remarks', dd.remarks,
            'created_at', dd.created_at,
            'updated_at', dd.updated_at
          )
          ORDER BY dd.due_academic_year ASC
        ) AS year_breakdown
      FROM defaulter_dues dd
      JOIN students s ON dd.student_id = s.id AND s.school_id = ${schoolId}
      JOIN persons p ON s.person_id = p.id
      LEFT JOIN LATERAL (
        SELECT
          c.id AS class_id,
          c.name AS class_name,
          sec.name AS section_name
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections sec ON cs.section_id = sec.id
        WHERE se.student_id = s.id
          AND se.school_id = ${schoolId}
          AND se.status = 'active'
          AND se.deleted_at IS NULL
        ORDER BY se.created_at DESC
        LIMIT 1
      ) enroll ON true
      WHERE dd.school_id = ${schoolId}
        AND dd.deleted_at IS NULL
        AND dd.balance > 0
        AND academic_year_start_year(dd.due_academic_year) < ${activeStartYear}
        ${search ? sql`AND (
          p.display_name ILIKE ${'%' + search + '%'}
          OR s.admission_no ILIKE ${'%' + search + '%'}
        )` : sql``}
        ${class_filter ? sql`AND enroll.class_id = ${class_filter}` : sql``}
        ${year_filter ? sql`AND dd.due_academic_year = ${year_filter}` : sql``}
        ${student_id ? sql`AND s.id = ${student_id}` : sql``}
      GROUP BY s.id, s.admission_no, p.display_name, enroll.class_id, enroll.class_name, enroll.section_name
      HAVING SUM(dd.balance) > 0
      ORDER BY p.display_name ASC
    `;

    return sendSuccess(res, schoolId, {
      active_academic_year: activeYearCode,
      defaulters: rows,
    });
  })
);

/**
 * POST /defaulters
 * Manually seed a previous-year due (source = manual_legacy).
 */
router.post(
  '/',
  [...accountsGuard, requirePermission('fees.manage')],
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { student_id, due_academic_year, amount, remarks } = req.body;

    if (!student_id || !due_academic_year || amount == null) {
      return sendError(res, 400, 'student_id, due_academic_year, and amount are required.');
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return sendError(res, 400, 'amount must be a positive number.');
    }

    const activeYearCode = await getActiveAcademicYearCode(schoolId);
    if (!activeYearCode) {
      return sendError(res, 400, 'No active academic year configured for this school.');
    }

    if (!isPreviousAcademicYear(due_academic_year, activeYearCode)) {
      return sendError(
        res,
        400,
        `due_academic_year must be before the current active year (${activeYearCode}). Current or future years belong in the fee module.`
      );
    }

    const [student] = await sql`
      SELECT id FROM students
      WHERE id = ${student_id}
        AND school_id = ${schoolId}
        AND deleted_at IS NULL
    `;

    if (!student) {
      return sendError(res, 404, 'Student not found in this school.');
    }

    try {
      const [due] = await sql`
        INSERT INTO defaulter_dues (
          school_id,
          student_id,
          due_academic_year,
          original_amount,
          paid_amount,
          source,
          remarks,
          created_by
        )
        VALUES (
          ${schoolId},
          ${student_id},
          ${due_academic_year},
          ${parsedAmount},
          0,
          'manual_legacy',
          ${remarks || null},
          ${req.user?.internal_id || null}
        )
        RETURNING *
      `;

      return sendSuccess(res, schoolId, due, 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return sendError(
          res,
          409,
          'A due for this student and year already exists; edit it instead.'
        );
      }
      throw err;
    }
  })
);

/**
 * POST /defaulters/remind
 * Send arrears reminders via push notification (student + parents).
 * Body: { student_id?, message?, search?, class_filter?, year_filter? }
 */
router.post(
  '/remind',
  [...accountsGuard, requirePermission('fees.manage')],
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { student_id, message, search, class_filter, year_filter } = req.body;

    const activeYearCode = await getActiveAcademicYearCode(schoolId);
    if (!activeYearCode) {
      return sendError(res, 400, 'No active academic year configured for this school.');
    }

    const activeStartYear = parseInt(activeYearCode.split('-')[0], 10) || 0;

    const rows = await sql`
      SELECT
        s.id AS student_id,
        p.display_name AS student_name,
        SUM(dd.balance)::numeric AS total_balance,
        json_agg(
          json_build_object(
            'due_academic_year', dd.due_academic_year,
            'balance', dd.balance
          )
          ORDER BY dd.due_academic_year ASC
        ) AS year_breakdown
      FROM defaulter_dues dd
      JOIN students s ON dd.student_id = s.id AND s.school_id = ${schoolId}
      JOIN persons p ON s.person_id = p.id
      LEFT JOIN LATERAL (
        SELECT c.id AS class_id
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        WHERE se.student_id = s.id
          AND se.school_id = ${schoolId}
          AND se.status = 'active'
          AND se.deleted_at IS NULL
        ORDER BY se.created_at DESC
        LIMIT 1
      ) enroll ON true
      WHERE dd.school_id = ${schoolId}
        AND dd.deleted_at IS NULL
        AND dd.balance > 0
        AND academic_year_start_year(dd.due_academic_year) < ${activeStartYear}
        ${student_id ? sql`AND s.id = ${student_id}` : sql``}
        ${search ? sql`AND (
          p.display_name ILIKE ${'%' + search + '%'}
          OR s.admission_no ILIKE ${'%' + search + '%'}
        )` : sql``}
        ${class_filter ? sql`AND enroll.class_id = ${class_filter}` : sql``}
        ${year_filter ? sql`AND dd.due_academic_year = ${year_filter}` : sql``}
      GROUP BY s.id, p.display_name
      HAVING SUM(dd.balance) > 0
    `;

    if (!rows.length) {
      return sendSuccess(res, schoolId, {
        message: 'No defaulters found to remind',
        student_count: 0,
        notifications_sent: 0,
      });
    }

    let notificationsSent = 0;

    for (const student of rows) {
      const userIds = await resolveNotificationUserIds([student.student_id], schoolId);
      if (userIds.length === 0) continue;

      const reminderMessage = buildArrearsReminderMessage(student, message);

      const result = await sendNotificationToUsers(
        userIds,
        'ARREARS_REMINDER',
        { message: reminderMessage },
        { senderId: req.user?.internal_id || null, role: 'accounts' }
      );

      notificationsSent += result.successCount || 0;
    }

    return sendSuccess(res, schoolId, {
      message: 'Arrears reminders queued',
      student_count: rows.length,
      notifications_sent: notificationsSent,
    });
  })
);

/**
 * PATCH /defaulters/:id
 * Edit original amount and/or remarks on an existing due.
 */
router.patch(
  '/:id',
  [...accountsGuard, requirePermission('fees.manage')],
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { id } = req.params;
    const { amount, remarks } = req.body;

    if (amount == null && remarks === undefined) {
      return sendError(res, 400, 'Provide amount and/or remarks to update.');
    }

    const [existing] = await sql`
      SELECT * FROM defaulter_dues
      WHERE id = ${id}
        AND school_id = ${schoolId}
        AND deleted_at IS NULL
    `;

    if (!existing) {
      return sendError(res, 404, 'Defaulter due not found.');
    }

    if (amount != null) {
      const parsedAmount = Number(amount);
      if (!Number.isFinite(parsedAmount) || parsedAmount < Number(existing.paid_amount)) {
        return sendError(
          res,
          400,
          `amount must be at least the already-paid amount (${existing.paid_amount}).`
        );
      }
    }

    const [updated] = await sql`
      UPDATE defaulter_dues
      SET
        original_amount = ${amount != null ? Number(amount) : existing.original_amount},
        remarks = ${remarks !== undefined ? remarks : existing.remarks},
        updated_at = NOW()
      WHERE id = ${id}
        AND school_id = ${schoolId}
        AND deleted_at IS NULL
      RETURNING *
    `;

    return sendSuccess(res, schoolId, updated);
  })
);

/**
 * POST /defaulters/:id/collect
 * Collect payment against a previous-year due; creates arrears-tagged receipt.
 */
router.post(
  '/:id/collect',
  [...accountsGuard, requirePermission('fees.collect')],
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { id } = req.params;
    const { amount, payment_method, transaction_ref, remarks } = req.body;

    if (!amount || !payment_method || !transaction_ref) {
      return sendError(res, 400, 'amount, payment_method, and transaction_ref are required.');
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return sendError(res, 400, 'amount must be a positive number.');
    }

    if (!VALID_PAYMENT_METHODS.includes(payment_method)) {
      return sendError(res, 400, `payment_method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`);
    }

    try {
      const result = await sql.begin(async (tx) => {
        const [due] = await tx`
          SELECT dd.*, s.id AS student_id
          FROM defaulter_dues dd
          JOIN students s ON dd.student_id = s.id AND s.school_id = ${schoolId}
          WHERE dd.id = ${id}
            AND dd.school_id = ${schoolId}
            AND dd.deleted_at IS NULL
          FOR UPDATE OF dd
        `;

        if (!due) {
          const err = new Error('Defaulter due not found.');
          err.status = 404;
          throw err;
        }

        const activeYearCode = await getActiveAcademicYearCode(schoolId, tx);
        if (!activeYearCode || !isPreviousAcademicYear(due.due_academic_year, activeYearCode)) {
          const err = new Error('This due does not belong to a previous academic year.');
          err.status = 400;
          throw err;
        }

        const balance = Number(due.balance);
        if (parsedAmount > balance) {
          const err = new Error(`Amount exceeds remaining balance of ${balance}.`);
          err.status = 400;
          throw err;
        }

        const [existingTx] = await tx`
          SELECT id FROM defaulter_payments
          WHERE school_id = ${schoolId} AND transaction_ref = ${transaction_ref}
        `;
        if (existingTx) {
          const err = new Error(`Transaction reference '${transaction_ref}' already exists.`);
          err.status = 409;
          throw err;
        }

        const [payment] = await tx`
          INSERT INTO defaulter_payments (
            school_id,
            defaulter_due_id,
            amount,
            payment_method,
            transaction_ref,
            received_by,
            remarks
          )
          VALUES (
            ${schoolId},
            ${id},
            ${parsedAmount},
            ${payment_method},
            ${transaction_ref},
            ${req.user?.internal_id || null},
            ${remarks || null}
          )
          RETURNING *
        `;

        const [updatedDue] = await tx`
          UPDATE defaulter_dues
          SET paid_amount = paid_amount + ${parsedAmount}
          WHERE id = ${id}
            AND school_id = ${schoolId}
          RETURNING *
        `;

        const receiptNo = await generateReceiptNo(tx, schoolId);
        const receiptRemarks = remarks
          || `Arrears recovery — ${due.due_academic_year}`;

        const [receipt] = await tx`
          INSERT INTO receipts (
            school_id,
            receipt_no,
            student_id,
            total_amount,
            issued_by,
            remarks,
            payment_type,
            defaulter_payment_id
          )
          VALUES (
            ${schoolId},
            ${receiptNo},
            ${due.student_id},
            ${parsedAmount},
            ${req.user?.internal_id || null},
            ${receiptRemarks},
            'arrears',
            ${payment.id}
          )
          RETURNING *
        `;

        return { payment, due: updatedDue, receipt };
      });

      return sendSuccess(res, schoolId, {
        message: 'Arrears payment recorded',
        ...result,
      }, 201);
    } catch (err) {
      if (err.status) {
        return sendError(res, err.status, err.message);
      }
      throw err;
    }
  })
);

/**
 * DELETE /defaulters/:id
 * Soft-delete a defaulter due (audit trail preserved).
 */
router.delete(
  '/:id',
  [...accountsGuard, requirePermission('fees.manage')],
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { id } = req.params;

    const [updated] = await sql`
      UPDATE defaulter_dues
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
        AND school_id = ${schoolId}
        AND deleted_at IS NULL
      RETURNING id, student_id, due_academic_year, deleted_at
    `;

    if (!updated) {
      return sendError(res, 404, 'Defaulter due not found.');
    }

    return sendSuccess(res, schoolId, { message: 'Defaulter due removed', due: updated });
  })
);

export default router;
