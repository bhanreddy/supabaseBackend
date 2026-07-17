import express from 'express';
import sql from '../db.js';
import { requirePermission, requireAuth, requireAnyPermission } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendNotificationToUsers } from '../services/notificationService.js';
import { translateFields } from '../services/geminiTranslator.js';
import { ACCOUNTS_STAT_KEYS, resolveAccountsDashboardConfig } from '../utils/constants.js';
import { getStudentTransportDue, resolveAcademicYearCode } from '../services/transportFeeService.js';
import {
  resolveStudentIdForSelfService,
} from '../utils/studentPortal.js';
import {
  getSchoolFeeMode,
  getMissingSectionFeeWarnings,
  activeStructureFilter,
  setSchoolFeeMode,
} from '../services/feeModeService.js';
import {
  executeTermFeePayment,
  executeCombinedTermFeePayment,
  getStudentFeeBalance,
  canBypassUnderpaymentApproval,
  isPartialFeePaymentEnabled,
} from '../services/feePaymentService.js';
import { createApprovalRequest } from '../services/approvalService.js';
import {
  requestFeePaymentDeletion,
  executeApprovedFeePaymentDeletion,
} from '../services/feePaymentDeletionService.js';

const router = express.Router();

const STRUCTURE_SELECT = sql`
  fs.id, fs.class_id, fs.section_id, fs.fee_type_id, fs.academic_year_id,
  fs.amount, fs.due_date, fs.frequency,
  ft.name as fee_type, ft.name_te as fee_type_te, ft.code as fee_code, ft.is_optional,
  c.name as class_name,
  sec.name as section_name,
  ay.code as academic_year
`;

// ============== FEE TYPES ==============

/**
 * GET /fees/types
 * List all fee types
 */
router.get('/types', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const types = await sql`
    SELECT id, name, name_te, code, description, description_te, is_recurring, is_optional, sort_order
    FROM fee_types
    WHERE school_id = ${req.schoolId} AND deleted_at IS NULL
    ORDER BY sort_order ASC, name ASC
  `;
  return sendSuccess(res, req.schoolId, types);
}));

/**
 * PUT /fees/types/reorder
 * Persist manual fee-type display order (collection flow / ledger).
 */
router.put('/types/reorder', requirePermission('fees.manage'), asyncHandler(async (req, res) => {
  const { type_ids: typeIds } = req.body;
  if (!Array.isArray(typeIds) || typeIds.length === 0) {
    return res.status(400).json({ error: 'type_ids must be a non-empty array' });
  }

  const existing = await sql`
    SELECT id FROM fee_types
    WHERE school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  const existingIds = new Set(existing.map((t) => t.id));

  if (typeIds.length !== existingIds.size) {
    return res.status(400).json({ error: 'type_ids must include every fee type for this school' });
  }

  for (const id of typeIds) {
    if (!existingIds.has(id)) {
      return res.status(400).json({ error: 'Invalid fee type id in reorder list' });
    }
  }

  await sql.begin(async (tx) => {
    for (let i = 0; i < typeIds.length; i++) {
      await tx`
        UPDATE fee_types
        SET sort_order = ${i + 1}
        WHERE id = ${typeIds[i]} AND school_id = ${req.schoolId}
      `;
    }
  });

  const types = await sql`
    SELECT id, name, name_te, code, description, description_te, is_recurring, is_optional, sort_order
    FROM fee_types
    WHERE school_id = ${req.schoolId} AND deleted_at IS NULL
    ORDER BY sort_order ASC, name ASC
  `;

  return sendSuccess(res, req.schoolId, types);
}));

/**
 * POST /fees/types
 * Create a new fee type
 */
router.post('/types', requirePermission('fees.manage'), asyncHandler(async (req, res) => {
  const { name, name_te, code, description, description_te, is_recurring, is_optional } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  // Check uniqueness within this school
  const [existing] = await sql`
    SELECT id FROM fee_types WHERE LOWER(name) = ${name.toLowerCase()} AND school_id = ${req.schoolId}
  `;
  if (existing) {
    return res.status(409).json({ error: `Fee type "${name}" already exists` });
  }

  const feeCode = code || name.toUpperCase().replace(/\s+/g, '_').slice(0, 20);

  const [maxOrderRow] = await sql`
    SELECT COALESCE(MAX(sort_order), 0) AS max_order
    FROM fee_types
    WHERE school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  const sortOrder = Number(maxOrderRow?.max_order ?? 0) + 1;

  // Auto-translate if not provided
  let finalNameTe = name_te ?? null;
  let finalDescTe = description_te ?? null;
  if (!finalNameTe || (!finalDescTe && description)) {
    try {
      const fields = {};
      if (!finalNameTe && name) fields.name = name;
      if (!finalDescTe && description) fields.description = description;
      const te = await translateFields(fields);
      if (!finalNameTe) finalNameTe = te.name || null;
      if (!finalDescTe) finalDescTe = te.description || null;
    } catch (e) {}
  }

  const [feeType] = await sql`
    INSERT INTO fee_types (school_id, name, name_te, code, description, description_te, is_recurring, is_optional, sort_order)
    VALUES (${req.schoolId}, ${name}, ${finalNameTe}, ${feeCode}, ${description || null}, ${finalDescTe}, ${is_recurring || false}, ${is_optional || false}, ${sortOrder})
    RETURNING id, name, name_te, code, description, description_te, is_recurring, is_optional, sort_order
  `;

  return sendSuccess(res, req.schoolId, feeType, 201);
}));

// ============== FEE STRUCTURE ==============

/**
 * GET /fees/fee-mode
 * Current fee structure mode for the authenticated school.
 */
router.get('/fee-mode', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const fee_mode = await getSchoolFeeMode(req.schoolId);
  return sendSuccess(res, req.schoolId, { fee_mode });
}));

/**
 * PATCH /fees/fee-mode
 * Toggle per-class vs per-section fee structure mode.
 * School is always derived from JWT (req.schoolId) — never from the client.
 */
router.patch('/fee-mode', requirePermission('fees.manage'), asyncHandler(async (req, res) => {
  if (req.schoolId == null || req.schoolId === '') {
    return res.status(403).json({ error: 'No school associated with this account' });
  }

  const { fee_mode } = req.body;
  if (!fee_mode || !['per_class', 'per_section'].includes(fee_mode)) {
    return res.status(400).json({ error: "fee_mode must be 'per_class' or 'per_section'" });
  }

  const result = await setSchoolFeeMode(req.schoolId, fee_mode);
  return sendSuccess(res, req.schoolId, result);
}));

/**
 * GET /fees/structure
 * Get fee structure (filter by class_id, academic_year_id, section_id).
 * Returns rows matching the school's fee_mode (class-level or section-level).
 */
router.get('/structure', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { class_id, academic_year_id, section_id } = req.query;
  const fee_mode = await getSchoolFeeMode(req.schoolId);
  const modeFilter = fee_mode === 'per_section'
    ? sql`AND fs.section_id IS NOT NULL`
    : sql`AND fs.section_id IS NULL`;
  const sectionFilter = section_id ? sql`AND fs.section_id = ${section_id}` : sql``;

  let structures;
  if (class_id && academic_year_id) {
    structures = await sql`
      SELECT ${STRUCTURE_SELECT}
      FROM fee_structures fs
      JOIN fee_types ft ON fs.fee_type_id = ft.id AND ft.deleted_at IS NULL
      JOIN classes c ON fs.class_id = c.id
      JOIN academic_years ay ON fs.academic_year_id = ay.id
      LEFT JOIN sections sec ON fs.section_id = sec.id
      WHERE fs.class_id = ${class_id} AND fs.academic_year_id = ${academic_year_id}
        AND fs.school_id = ${req.schoolId}
        AND fs.deleted_at IS NULL
        ${modeFilter}
        ${sectionFilter}
      ORDER BY sec.name NULLS FIRST, ft.name
    `;
  } else if (academic_year_id) {
    structures = await sql`
      SELECT ${STRUCTURE_SELECT}
      FROM fee_structures fs
      JOIN fee_types ft ON fs.fee_type_id = ft.id AND ft.deleted_at IS NULL
      JOIN classes c ON fs.class_id = c.id
      JOIN academic_years ay ON fs.academic_year_id = ay.id
      LEFT JOIN sections sec ON fs.section_id = sec.id
      WHERE fs.academic_year_id = ${academic_year_id}
        AND fs.school_id = ${req.schoolId}
        AND fs.deleted_at IS NULL
        ${modeFilter}
        ${sectionFilter}
      ORDER BY c.name, sec.name NULLS FIRST, ft.name
    `;
  } else {
    structures = await sql`
      SELECT ${STRUCTURE_SELECT}
      FROM fee_structures fs
      JOIN fee_types ft ON fs.fee_type_id = ft.id AND ft.deleted_at IS NULL
      JOIN classes c ON fs.class_id = c.id
      JOIN academic_years ay ON fs.academic_year_id = ay.id
      LEFT JOIN sections sec ON fs.section_id = sec.id
      WHERE fs.school_id = ${req.schoolId}
        AND fs.deleted_at IS NULL
        ${modeFilter}
        ${sectionFilter}
      ORDER BY ay.start_date DESC, c.name, sec.name NULLS FIRST, ft.name
    `;
  }

  const missing_sections = fee_mode === 'per_section'
    ? await getMissingSectionFeeWarnings(req.schoolId, academic_year_id || null)
    : [];

  return sendSuccess(res, req.schoolId, {
    fee_mode,
    structures,
    missing_sections,
  });
}));

/**
 * POST /fees/structure
 * Create fee structure for a class
 */
router.post('/structure', requirePermission('fees.manage'), asyncHandler(async (req, res) => {
  const { academic_year_id, class_id, fee_type_id, amount, due_date, frequency, section_id } = req.body;

  if (!academic_year_id || !class_id || !fee_type_id || !amount) {
    return res.status(400).json({ error: 'academic_year_id, class_id, fee_type_id, and amount are required' });
  }

  if (Number(amount) <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const fee_mode = await getSchoolFeeMode(req.schoolId);

  if (fee_mode === 'per_class' && section_id) {
    return res.status(400).json({ error: 'section_id is not allowed when fee_mode is per_class' });
  }
  if (fee_mode === 'per_section' && !section_id) {
    return res.status(400).json({ error: 'section_id is required when fee_mode is per_section' });
  }

  const resolvedSectionId = fee_mode === 'per_section' ? section_id : null;

  const [[classRow], [feeTypeRow], [yearRow]] = await Promise.all([
    sql`SELECT id FROM classes WHERE id = ${class_id} AND school_id = ${req.schoolId}`,
    sql`SELECT id FROM fee_types WHERE id = ${fee_type_id} AND school_id = ${req.schoolId} AND deleted_at IS NULL`,
    sql`SELECT id FROM academic_years WHERE id = ${academic_year_id} AND school_id = ${req.schoolId}`,
  ]);

  if (!classRow) {
    return res.status(400).json({ error: 'Invalid class_id for this school' });
  }
  if (!feeTypeRow) {
    return res.status(400).json({ error: 'Invalid fee_type_id for this school' });
  }
  if (!yearRow) {
    return res.status(400).json({ error: 'Invalid academic_year_id for this school' });
  }

  if (resolvedSectionId) {
    const [sectionRow] = await sql`
      SELECT cs.section_id
      FROM class_sections cs
      WHERE cs.school_id = ${req.schoolId}
        AND cs.class_id = ${class_id}
        AND cs.academic_year_id = ${academic_year_id}
        AND cs.section_id = ${resolvedSectionId}
        AND cs.deleted_at IS NULL
      LIMIT 1
    `;
    if (!sectionRow) {
      return res.status(400).json({ error: 'Invalid section_id for this class and academic year' });
    }
  }

  let structure;
  const [existing] = resolvedSectionId
    ? await sql`
        SELECT id FROM fee_structures
        WHERE school_id = ${req.schoolId}
          AND academic_year_id = ${academic_year_id}
          AND class_id = ${class_id}
          AND section_id = ${resolvedSectionId}
          AND fee_type_id = ${fee_type_id}
          AND deleted_at IS NULL
        LIMIT 1
      `
    : await sql`
        SELECT id FROM fee_structures
        WHERE school_id = ${req.schoolId}
          AND academic_year_id = ${academic_year_id}
          AND class_id = ${class_id}
          AND section_id IS NULL
          AND fee_type_id = ${fee_type_id}
          AND deleted_at IS NULL
        LIMIT 1
      `;

  if (existing) {
    [structure] = await sql`
      UPDATE fee_structures
      SET
        amount = ${amount},
        due_date = ${due_date || null},
        frequency = ${frequency || 'monthly'},
        updated_at = NOW()
      WHERE id = ${existing.id} AND school_id = ${req.schoolId}
      RETURNING *
    `;
  } else {
    try {
      [structure] = await sql`
        INSERT INTO fee_structures (
          school_id, academic_year_id, class_id, section_id, fee_type_id, amount, due_date, frequency
        )
        VALUES (
          ${req.schoolId}, ${academic_year_id}, ${class_id}, ${resolvedSectionId},
          ${fee_type_id}, ${amount}, ${due_date || null}, ${frequency || 'monthly'}
        )
        RETURNING *
      `;
    } catch (err) {
      if (err.code === '23505') {
        [structure] = resolvedSectionId
          ? await sql`
              UPDATE fee_structures
              SET
                amount = ${amount},
                due_date = ${due_date || null},
                frequency = ${frequency || 'monthly'},
                updated_at = NOW()
              WHERE school_id = ${req.schoolId}
                AND academic_year_id = ${academic_year_id}
                AND class_id = ${class_id}
                AND section_id = ${resolvedSectionId}
                AND fee_type_id = ${fee_type_id}
                AND deleted_at IS NULL
              RETURNING *
            `
          : await sql`
              UPDATE fee_structures
              SET
                amount = ${amount},
                due_date = ${due_date || null},
                frequency = ${frequency || 'monthly'},
                updated_at = NOW()
              WHERE school_id = ${req.schoolId}
                AND academic_year_id = ${academic_year_id}
                AND class_id = ${class_id}
                AND section_id IS NULL
                AND fee_type_id = ${fee_type_id}
                AND deleted_at IS NULL
              RETURNING *
            `;
      } else {
        throw err;
      }
    }
  }

  if (!structure) {
    return res.status(500).json({ error: 'Failed to save fee structure' });
  }

  return sendSuccess(res, req.schoolId, {
    message: existing ? 'Fee structure updated' : 'Fee structure created',
    structure,
  }, existing ? 200 : 201);
}));

/**
 * PUT /fees/structure/:id
 * Update fee structure
 */
router.put('/structure/:id', requirePermission('fees.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { amount, due_date, frequency } = req.body;

  // F2 FIX: Ownership check first
  const [existing] = await sql`SELECT id FROM fee_structures WHERE id = ${id} AND school_id = ${req.schoolId}`;
  if (!existing) {
    return res.status(404).json({ error: 'Fee structure not found' });
  }

  const [updated] = await sql`
    UPDATE fee_structures
    SET
      amount = COALESCE(${amount ?? null}, amount),
      due_date = COALESCE(${due_date ?? null}, due_date),
      frequency = COALESCE(${frequency ?? null}, frequency)
    WHERE id = ${id} AND school_id = ${req.schoolId}
    RETURNING *
  `;

  if (!updated) {
    return res.status(404).json({ error: 'Fee structure not found' });
  }

  return sendSuccess(res, req.schoolId, { message: 'Fee structure updated', structure: updated });
}));

/**
 * DELETE /fees/structure/:id
 * Soft-delete a fee structure (and its unpaid student fee rows).
 * Blocked when payments have already been collected against it, to preserve
 * financial records.
 */
router.delete('/structure/:id', requirePermission('fees.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Ownership check first
  const [existing] = await sql`
    SELECT id FROM fee_structures WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!existing) {
    return res.status(404).json({ error: 'Fee structure not found' });
  }

  // Refuse to delete if money has already been collected against this fee.
  const [{ paid_count }] = await sql`
    SELECT COUNT(*)::int AS paid_count
    FROM student_fees
    WHERE fee_structure_id = ${id}
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
      AND amount_paid > 0
  `;
  if (paid_count > 0) {
    return res.status(409).json({
      error: 'Cannot delete this fee — payments have already been collected against it.',
    });
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE student_fees
      SET deleted_at = now()
      WHERE fee_structure_id = ${id}
        AND school_id = ${req.schoolId}
        AND deleted_at IS NULL
    `;
    await tx`
      UPDATE fee_structures
      SET deleted_at = now()
      WHERE id = ${id} AND school_id = ${req.schoolId}
    `;
  });

  return sendSuccess(res, req.schoolId, { message: 'Fee structure deleted', id });
}));

// ============== STUDENT FEES ==============

/**
 * GET /fees/students/:studentId
 * Get fee details for a student
 */
router.get('/students/:studentId', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { academic_year_id, lastSyncedAt } = req.query;
  const feeMode = await getSchoolFeeMode(req.schoolId);
  const structureModeFilter = activeStructureFilter(feeMode);

  // Get student info
  const [student] = await sql`
    SELECT s.id, s.admission_no, p.display_name,
      enroll.class_name, enroll.section_name,
      father_info.father_name, father_info.father_mobile
    FROM students s
    JOIN persons p ON s.person_id = p.id
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
            AND pc.school_id = ${req.schoolId}
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
        AND sp.school_id = ${req.schoolId}
        AND sp.deleted_at IS NULL
      ORDER BY
        CASE WHEN rt.name = 'Father' THEN 0 WHEN COALESCE(sp.is_primary_contact, true) THEN 1 ELSE 2 END,
        sp.created_at
      LIMIT 1
    ) father_info ON true
    WHERE s.id = ${studentId} AND s.deleted_at IS NULL AND s.school_id = ${req.schoolId}
  `;

  if (!student) {
    return res.status(404).json({ error: 'Student not found' });
  }

  // Get fees
  let fees;
  if (academic_year_id) {
    fees = await sql`
      SELECT 
        sf.id, sf.amount_due, sf.amount_paid, sf.discount, sf.status,
        sf.due_date, sf.period_month, sf.period_year,
        fs.fee_type_id,
        ft.name as fee_type, ft.name_te as fee_type_te, ft.code as fee_code,
        ft.sort_order as fee_type_sort_order,
        (SELECT COUNT(*)::int FROM fee_adjustments fa WHERE fa.student_fee_id = sf.id) as adjustment_count
      FROM student_fees sf
      JOIN fee_structures fs ON sf.fee_structure_id = fs.id
      JOIN fee_types ft ON fs.fee_type_id = ft.id
      WHERE sf.student_id = ${studentId}
        AND sf.deleted_at IS NULL
        AND fs.deleted_at IS NULL
        AND fs.academic_year_id = ${academic_year_id}
        ${structureModeFilter}
        ${lastSyncedAt ? sql`AND (sf.updated_at >= ${lastSyncedAt} OR sf.created_at >= ${lastSyncedAt})` : sql``}
      ORDER BY ft.sort_order ASC, sf.due_date ASC NULLS LAST, ft.name ASC
    `;
  } else {
    fees = await sql`
      SELECT 
        sf.id, sf.amount_due, sf.amount_paid, sf.discount, sf.status,
        sf.due_date, sf.period_month, sf.period_year,
        fs.fee_type_id,
        ft.name as fee_type, ft.name_te as fee_type_te, ay.code as academic_year,
        ft.sort_order as fee_type_sort_order,
        (SELECT COUNT(*)::int FROM fee_adjustments fa WHERE fa.student_fee_id = sf.id) as adjustment_count
      FROM student_fees sf
      JOIN fee_structures fs ON sf.fee_structure_id = fs.id
      JOIN fee_types ft ON fs.fee_type_id = ft.id
      JOIN academic_years ay ON fs.academic_year_id = ay.id
      WHERE sf.student_id = ${studentId}
        AND sf.deleted_at IS NULL
        AND fs.deleted_at IS NULL
        ${structureModeFilter}
        ${lastSyncedAt ? sql`AND (sf.updated_at >= ${lastSyncedAt} OR sf.created_at >= ${lastSyncedAt})` : sql``}
      ORDER BY ft.sort_order ASC, sf.due_date ASC NULLS LAST, ft.name ASC
      LIMIT 50
    `;
  }

  const summary = await sql`
    SELECT 
      COALESCE(SUM(sf.amount_due - sf.discount), 0) as total_due,
      COALESCE(SUM(sf.amount_paid), 0) as total_paid,
      COALESCE(SUM(sf.amount_due - sf.discount - sf.amount_paid), 0) as balance
    FROM student_fees sf
    JOIN fee_structures fs ON sf.fee_structure_id = fs.id
    WHERE sf.student_id = ${studentId}
      AND sf.deleted_at IS NULL
      AND fs.deleted_at IS NULL
      ${structureModeFilter}
  `;

  const activeYearCode = academic_year_id
    ? (await sql`SELECT code FROM academic_years WHERE id = ${academic_year_id} AND school_id = ${req.schoolId}`)[0]?.code
    : await resolveAcademicYearCode(req.schoolId);

  const transportDue = activeYearCode
    ? await getStudentTransportDue(studentId, activeYearCode, req.schoolId)
    : null;

  const tuitionBalance = Number(summary[0]?.balance || 0);
  const transportBalance = transportDue && !transportDue.fee_not_set
    ? Number(transportDue.balance_due || 0)
    : 0;

  const parents = await sql`
    SELECT
      pp.first_name,
      pp.last_name,
      rt.name as relation,
      (
        SELECT pc.contact_value FROM person_contacts pc
        WHERE pc.person_id = pp.id
          AND pc.school_id = ${req.schoolId}
          AND pc.contact_type = 'phone'
          AND pc.deleted_at IS NULL
        ORDER BY pc.is_primary DESC, pc.created_at
        LIMIT 1
      ) as phone,
      par.occupation,
      sp.is_primary_contact as is_primary,
      sp.is_legal_guardian as is_guardian
    FROM student_parents sp
    JOIN parents par ON sp.parent_id = par.id AND par.deleted_at IS NULL
    JOIN persons pp ON par.person_id = pp.id
    LEFT JOIN relationship_types rt ON sp.relationship_id = rt.id
    WHERE sp.student_id = ${studentId}
      AND sp.school_id = ${req.schoolId}
      AND sp.deleted_at IS NULL
    ORDER BY
      CASE WHEN rt.name = 'Father' THEN 0 WHEN sp.is_primary_contact THEN 1 ELSE 2 END,
      sp.created_at
  `;

  return sendSuccess(res, req.schoolId, {
    student: { ...student, parents },
    summary: {
      ...summary[0],
      transport_due: transportDue,
      total_balance: tuitionBalance + transportBalance,
    },
    fees,
    transport_due: transportDue,
  });
}));

/**
 * POST /fees/collect
 * Collect fee payment
 */
/**
 * POST /fees/collect
 * Collect fee payment
 */
/**
 * Collect fee payment — posts immediately unless the amount is less than the
 * remaining balance (underpayment), in which case a pending approval is created
 * and nothing is written to the fee ledger (RBAC epic #1).
 */
async function findApprovedPartialPaymentPermission({ schoolId, studentFeeId, amount }) {
  const [row] = await sql`
    SELECT id
    FROM approval_requests
    WHERE school_id = ${schoolId}
      AND type = 'fee_underpayment'
      AND status = 'APPROVED'
      AND payload->>'student_fee_id' = ${studentFeeId}
      AND payload->>'consumed_at' IS NULL
      AND (payload->>'amount')::numeric >= ${amount}
    ORDER BY reviewed_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `;
  return row || null;
}

async function handleFeeCollection(req, res, successMessage) {
  const { student_fee_id, amount, payment_method, transaction_ref, remarks, request_approval } = req.body;

  if (!student_fee_id || !amount || !payment_method) {
    return res.status(400).json({ error: 'student_fee_id, amount, and payment_method are required' });
  }

  const validMethods = ['cash', 'card', 'upi', 'bank_transfer', 'cheque', 'online'];
  if (!validMethods.includes(payment_method)) {
    return res.status(400).json({ error: `payment_method must be one of: ${validMethods.join(', ')}` });
  }

  const parsedAmount = Number(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }

  if (!transaction_ref) {
    return res.status(400).json({ error: 'transaction_ref is required. Generate a UUID for cash payments.' });
  }

  try {
    const feeBalance = await getStudentFeeBalance(student_fee_id, req.schoolId);
    if (!feeBalance) {
      return res.status(404).json({ error: 'Student fee not found' });
    }

    if (parsedAmount > feeBalance.remaining) {
      return res.status(400).json({ error: `Amount exceeds remaining balance of ${feeBalance.remaining}` });
    }

    const isUnderpayment = parsedAmount < feeBalance.remaining;
    const wantsApprovalRequest = request_approval === true;
    const canBypassApproval = canBypassUnderpaymentApproval(req.user);
    const partialPermission = isUnderpayment && !wantsApprovalRequest && !canBypassApproval
      ? await findApprovedPartialPaymentPermission({
        schoolId: req.schoolId,
        studentFeeId: student_fee_id,
        amount: parsedAmount,
      })
      : null;

    if (isUnderpayment) {
      const partialEnabled = await isPartialFeePaymentEnabled(req.schoolId);
      if (!partialEnabled && !wantsApprovalRequest && !partialPermission) {
        return res.status(400).json({
          error: 'Partial fee payments are disabled for this school. Collect the full remaining balance.',
          code: 'PARTIAL_FEE_PAYMENT_DISABLED',
        });
      }
    }

    if (isUnderpayment && (wantsApprovalRequest || (!canBypassApproval && !partialPermission))) {
      const approvalRequest = await createApprovalRequest({
        schoolId: req.schoolId,
        type: 'fee_underpayment',
        requestedBy: req.user.internal_id,
        reason: remarks || req.body.reason || null,
        payload: {
          student_fee_id,
          student_id: feeBalance.student_id,
          student_name: feeBalance.student_name || null,
          admission_no: feeBalance.admission_no || null,
          class_name: feeBalance.class_name || null,
          section_name: feeBalance.section_name || null,
          fee_type: feeBalance.fee_type || null,
          amount: parsedAmount,
          amount_due: feeBalance.remaining,
          payment_method,
          transaction_ref,
          remarks: remarks || null,
          requested_via: wantsApprovalRequest ? 'partial_payment_request' : 'collection',
        },
      });

      return sendSuccess(res, req.schoolId, {
        status: 'pending_approval',
        message: wantsApprovalRequest
          ? 'Partial payment request sent to admin for approval'
          : 'Partial payment requires admin approval before posting',
        approval_request: approvalRequest,
      }, 202);
    }

    const { transaction } = await executeTermFeePayment({
      student_fee_id,
      amount: parsedAmount,
      payment_method,
      transaction_ref,
      remarks,
      user: req.user,
      schoolId: req.schoolId,
      partialApprovalRequestId: partialPermission?.id,
    });

    return sendSuccess(res, req.schoolId, { message: successMessage, transaction }, 201);
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
}

router.post('/collect', requirePermission('fees.collect'), asyncHandler(async (req, res) => {
  return handleFeeCollection(req, res, 'Payment collected successfully');
}));

/**
 * POST /fees/collect-multi
 * Combined multi-fee-type collection — pay several fee types in one action and
 * generate a SINGLE receipt (one receipt_no, multiple line items). Each fee type
 * still posts its own ledger transaction (per-fee balances stay accurate); they
 * are grouped into one receipt.
 *
 * Body: { student_id?, payment_method, transaction_ref, remarks?,
 *         items: [{ student_fee_id, amount }] }
 *
 * Underpayment policy mirrors single collect: a line paid below its remaining
 * balance is only allowed when the school enables partial payments or the user
 * can bypass approval. There is no per-line approval-queue in combined mode —
 * blocked lines are reported so the collector can adjust and retry.
 */
router.post('/collect-multi', requirePermission('fees.collect'), asyncHandler(async (req, res) => {
  const { items, payment_method, transaction_ref, remarks } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array of { student_fee_id, amount }' });
  }
  if (items.length > 20) {
    return res.status(400).json({ error: 'Cannot collect more than 20 fee types in one receipt' });
  }
  const validMethods = ['cash', 'card', 'upi', 'bank_transfer', 'cheque', 'online'];
  if (!payment_method || !validMethods.includes(payment_method)) {
    return res.status(400).json({ error: `payment_method must be one of: ${validMethods.join(', ')}` });
  }
  if (!transaction_ref) {
    return res.status(400).json({ error: 'transaction_ref is required. Generate a UUID for the combined payment.' });
  }

  // Normalise + validate each line up front (fail before posting anything).
  const normalized = [];
  const seen = new Set();
  for (const raw of items) {
    const studentFeeId = raw?.student_fee_id;
    const amount = Number(raw?.amount);
    if (!studentFeeId) {
      return res.status(400).json({ error: 'Each item requires a student_fee_id' });
    }
    if (seen.has(studentFeeId)) {
      return res.status(400).json({ error: 'Duplicate fee type in the same combined payment' });
    }
    seen.add(studentFeeId);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Each item amount must be a positive number' });
    }
    normalized.push({ student_fee_id: studentFeeId, amount });
  }

  try {
    const canBypassApproval = canBypassUnderpaymentApproval(req.user);
    const partialEnabled = await isPartialFeePaymentEnabled(req.schoolId);
    const balances = [];

    for (const item of normalized) {
      const feeBalance = await getStudentFeeBalance(item.student_fee_id, req.schoolId);
      if (!feeBalance) {
        return res.status(404).json({ error: `Student fee not found: ${item.student_fee_id}` });
      }
      balances.push({ ...feeBalance, requested: item.amount });
      if (item.amount > feeBalance.remaining) {
        return res.status(400).json({
          error: `Amount ${item.amount} exceeds remaining balance of ${feeBalance.remaining} for ${feeBalance.fee_type || 'a fee'}`,
        });
      }
    }

    // All lines must belong to the same student — one receipt is per-student.
    const studentIds = new Set(balances.map((b) => b.student_id));
    if (studentIds.size > 1) {
      return res.status(400).json({ error: 'All fee types in a combined receipt must belong to the same student' });
    }

    // Underpayment guard (no per-line approval queue in combined mode).
    if (!partialEnabled && !canBypassApproval) {
      const underpaid = balances.filter((b) => b.requested < b.remaining);
      if (underpaid.length > 0) {
        return res.status(400).json({
          error: 'Partial fee payments are disabled for this school. Collect the full remaining balance for each selected fee type, or remove partial lines.',
          code: 'PARTIAL_FEE_PAYMENT_DISABLED',
          fee_types: underpaid.map((b) => b.fee_type).filter(Boolean),
        });
      }
    }

    const result = await executeCombinedTermFeePayment({
      items: normalized,
      payment_method,
      transaction_ref,
      remarks,
      user: req.user,
      schoolId: req.schoolId,
    });

    return sendSuccess(res, req.schoolId, {
      message: 'Combined payment collected successfully',
      receipt: result.receipt,
      transaction: result.transaction,
    }, 201);
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
}));

router.post('/transactions', requirePermission('fees.collect'), asyncHandler(async (req, res) => {
  return handleFeeCollection(req, res, 'Transaction recorded');
}));

/**
 * Request admin approval to delete a successfully posted payment. Only the
 * accountant who collected the payment may request or execute its deletion.
 */
router.post(
  '/transactions/:id/deletion-request',
  requireRole('accounts'),
  requirePermission('fees.collect'),
  asyncHandler(async (req, res) => {
    try {
      const request = await requestFeePaymentDeletion({
        transactionId: req.params.id,
        reason: req.body?.reason,
        schoolId: req.schoolId,
        requestedBy: req.user.internal_id,
      });
      return sendSuccess(res, req.schoolId, {
        message: 'Payment deletion request sent to admin',
        approval_request: request,
      }, 202);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  })
);

/** Consume an approved one-time deletion authorization by posting reversals. */
router.post(
  '/transactions/:id/delete-approved',
  requireRole('accounts'),
  requirePermission('fees.collect'),
  asyncHandler(async (req, res) => {
    try {
      const result = await executeApprovedFeePaymentDeletion({
        transactionId: req.params.id,
        approvalRequestId: req.body?.approval_request_id,
        schoolId: req.schoolId,
        accountantId: req.user.internal_id,
      });
      return sendSuccess(res, req.schoolId, result);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  })
);

/**
 * All assigned student_fees with per-type balances (for receipt printing).
 */
async function getStudentFeeDuesForReceipt(studentId, schoolId, academicYearCode = null) {
  const feeMode = await getSchoolFeeMode(schoolId);
  const structureModeFilter = activeStructureFilter(feeMode);

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
      ${structureModeFilter}
    ORDER BY ft.sort_order ASC, ay.code NULLS LAST, ft.name ASC
  `;

  const yearCode = academicYearCode || await resolveAcademicYearCode(schoolId);
  const transportDue = yearCode
    ? await getStudentTransportDue(studentId, yearCode, schoolId)
    : null;

  if (!transportDue || transportDue.fee_not_set) {
    return tuitionDues;
  }

  return [
    ...tuitionDues,
    {
      student_fee_id: null,
      fee_type: 'Transport',
      academic_year: transportDue.academic_year,
      amount_due: transportDue.fee_amount,
      amount_paid: transportDue.paid_amount,
      discount: 0,
      balance_due: transportDue.balance_due,
      status: transportDue.balance_due <= 0 ? 'paid' : transportDue.paid_amount > 0 ? 'partial' : 'pending',
    },
  ];
}

/**
 * Shared helper to process fee transactions (used by other internal callers).
 */
async function processFeeTransaction(params) {
  const { transaction } = await executeTermFeePayment(params);
  return transaction;
}

/**
 * GET /fees/summaries
 * Get comprehensive fee summary for all students (or filtered)
 */
router.get('/summaries', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const {
    class_id,
    academic_year_id,
    search,
    status,
    page = 1,
    limit = 50,
    admission_no,
    father_name,
    mobile,
  } = req.query;
  const feeMode = await getSchoolFeeMode(req.schoolId);
  const structureModeFilter = activeStructureFilter(feeMode);
  const safeLimit = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 50));
  const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
  const offset = (pageNum - 1) * safeLimit;
  const searchText = typeof search === 'string' ? search.trim() : '';
  const statusText = typeof status === 'string' ? status.trim() : '';
  const selectedStatus = ['Paid', 'Partial', 'Pending'].includes(statusText) ? statusText : '';
  const admissionNoText = typeof admission_no === 'string' ? admission_no.trim() : '';
  const fatherNameText = typeof father_name === 'string' ? father_name.trim() : '';
  const mobileText = typeof mobile === 'string' ? mobile.trim().replace(/\D/g, '') : '';

  const baseWhere = sql`s.deleted_at IS NULL AND s.school_id = ${req.schoolId}`;
  const classFilter = class_id ? sql`AND c.id = ${class_id}` : sql``;
  const searchFilter = searchText
    ? sql`AND (p.display_name ILIKE ${'%' + searchText + '%'} OR s.admission_no ILIKE ${'%' + searchText + '%'} OR c.name ILIKE ${'%' + searchText + '%'})`
    : sql``;
  const admissionFilter = admissionNoText
    ? sql`AND s.admission_no ILIKE ${admissionNoText + '%'}`
    : sql``;
  const fatherNameFilter = fatherNameText
    ? sql`AND EXISTS (
        SELECT 1
        FROM student_parents sp
        JOIN parents par ON sp.parent_id = par.id AND par.deleted_at IS NULL
        JOIN persons pp ON par.person_id = pp.id
        LEFT JOIN relationship_types rt ON sp.relationship_id = rt.id
        WHERE sp.student_id = s.id
          AND sp.school_id = ${req.schoolId}
          AND sp.deleted_at IS NULL
          AND pp.display_name ILIKE ${'%' + fatherNameText + '%'}
          AND (rt.name = 'Father' OR sp.is_primary_contact = true)
      )`
    : sql``;
  const mobileFilter = mobileText
    ? sql`AND (
        EXISTS (
          SELECT 1
          FROM person_contacts pc
          WHERE pc.person_id = s.person_id
            AND pc.contact_type = 'phone'
            AND pc.school_id = ${req.schoolId}
            AND pc.deleted_at IS NULL
            AND regexp_replace(pc.contact_value, '[^0-9]', '', 'g') ILIKE ${'%' + mobileText + '%'}
        ) OR EXISTS (
          SELECT 1
          FROM student_parents sp
          JOIN parents par ON sp.parent_id = par.id AND par.deleted_at IS NULL
          JOIN person_contacts pc ON pc.person_id = par.person_id
            AND pc.contact_type = 'phone'
            AND pc.school_id = ${req.schoolId}
            AND pc.deleted_at IS NULL
          WHERE sp.student_id = s.id
            AND sp.school_id = ${req.schoolId}
            AND sp.deleted_at IS NULL
            AND regexp_replace(pc.contact_value, '[^0-9]', '', 'g') ILIKE ${'%' + mobileText + '%'}
        )
      )`
    : sql``;
  const extraFilters = sql`${admissionFilter} ${fatherNameFilter} ${mobileFilter}`;
  const statusFilter = selectedStatus ? sql`AND status = ${selectedStatus}` : sql``;
  const ayFilter = academic_year_id
    ? sql`AND sf.fee_structure_id IN (
        SELECT id FROM fee_structures
        WHERE academic_year_id = ${academic_year_id}
          AND deleted_at IS NULL
          AND school_id = ${req.schoolId}
          ${activeStructureFilter(feeMode, null)}
      )`
    : sql`AND sf.fee_structure_id IN (
        SELECT id FROM fee_structures
        WHERE deleted_at IS NULL
          AND school_id = ${req.schoolId}
          ${activeStructureFilter(feeMode, null)}
      )`;

  // Single pass: the per-student aggregation is computed once in a CTE, status
  // counts come from that same CTE (total is just the count matching the status
  // filter), and the father-name LATERAL runs only for the returned page rows.
  // counts always yields one row, so an empty page still returns the counts.
  const rows = await sql`
    WITH summaries AS (
      SELECT
        s.id as student_id,
        s.admission_no,
        p.display_name as student_name,
        p.photo_url,
        c.name as class_name,
        g.name as student_gender,
        COALESCE(SUM(sf.amount_due), 0) as total_amount,
        COALESCE(SUM(sf.amount_paid), 0) as paid_amount,
        COALESCE(SUM(sf.amount_due - sf.amount_paid - sf.discount), 0) as due_amount,
        CASE
          WHEN SUM(sf.amount_due - sf.amount_paid - sf.discount) <= 0 THEN 'Paid'
          WHEN SUM(sf.amount_paid) > 0 THEN 'Partial'
          ELSE 'Pending'
        END as status
      FROM students s
      JOIN persons p ON s.person_id = p.id
      LEFT JOIN genders g ON p.gender_id = g.id
      JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active'
      JOIN class_sections cs ON se.class_section_id = cs.id
      JOIN classes c ON cs.class_id = c.id
      LEFT JOIN student_fees sf ON s.id = sf.student_id
        AND sf.deleted_at IS NULL
        AND sf.school_id = ${req.schoolId}
        ${ayFilter}
      WHERE ${baseWhere}
      ${classFilter}
      ${searchFilter}
      ${extraFilters}
      GROUP BY s.id, s.admission_no, p.display_name, p.photo_url, c.name, g.name
    ),
    counts AS (
      SELECT
        COUNT(*)::int as all_count,
        COUNT(*) FILTER (WHERE status = 'Paid')::int as paid_count,
        COUNT(*) FILTER (WHERE status = 'Partial')::int as partial_count,
        COUNT(*) FILTER (WHERE status = 'Pending')::int as pending_count
      FROM summaries
    ),
    page AS (
      SELECT *
      FROM summaries
      WHERE TRUE
      ${statusFilter}
      ORDER BY student_name, student_id
      LIMIT ${safeLimit} OFFSET ${offset}
    )
    SELECT
      counts.all_count, counts.paid_count, counts.partial_count, counts.pending_count,
      page.student_id, page.admission_no, page.student_name, page.photo_url, page.class_name,
      page.student_gender, page.total_amount, page.paid_amount, page.due_amount,
      page.status,
      father_info.father_name, father_info.father_mobile
    FROM counts
    LEFT JOIN page ON true
    LEFT JOIN LATERAL (
      SELECT
        pp.display_name as father_name,
        (
          SELECT pc.contact_value
          FROM person_contacts pc
          WHERE pc.person_id = pp.id
            AND pc.school_id = ${req.schoolId}
            AND pc.contact_type = 'phone'
            AND pc.deleted_at IS NULL
          ORDER BY pc.is_primary DESC, pc.created_at
          LIMIT 1
        ) as father_mobile
      FROM student_parents sp
      JOIN parents par ON sp.parent_id = par.id AND par.deleted_at IS NULL
      JOIN persons pp ON par.person_id = pp.id
      LEFT JOIN relationship_types rt ON sp.relationship_id = rt.id
      WHERE sp.student_id = page.student_id
        AND sp.school_id = ${req.schoolId}
        AND sp.deleted_at IS NULL
      ORDER BY
        CASE WHEN rt.name = 'Father' THEN 0 WHEN sp.is_primary_contact THEN 1 ELSE 2 END,
        sp.created_at
      LIMIT 1
    ) father_info ON true
    ORDER BY page.student_name, page.student_id
  `;

  const counts = rows[0] ?? { all_count: 0, paid_count: 0, partial_count: 0, pending_count: 0 };
  const summaries = rows
    .filter((row) => row.student_id !== null)
    .map(({ all_count, paid_count, partial_count, pending_count, ...summary }) => summary);
  const totalByStatus = {
    Paid: counts.paid_count,
    Partial: counts.partial_count,
    Pending: counts.pending_count,
  };
  const total = selectedStatus ? totalByStatus[selectedStatus] : counts.all_count;

  return sendSuccess(res, req.schoolId, {
    data: summaries,
    meta: {
      total,
      page: pageNum,
      limit: safeLimit,
      total_pages: Math.ceil(total / safeLimit) || 1,
      counts: {
        All: counts.all_count,
        Paid: counts.paid_count,
        Partial: counts.partial_count,
        Pending: counts.pending_count,
      },
    },
  });
}));

/**
 * GET /fees/defaulters
 * Get list of fee defaulters
 */
router.get('/defaulters', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { class_id, academic_year_id, min_days_overdue = 0, page = 1, limit = 100 } = req.query;
  const safePage = Math.max(1, parseInt(String(page), 10) || 1);
  const safeLimit = Math.min(200, Math.max(1, parseInt(String(limit), 10) || 100));
  const offset = (safePage - 1) * safeLimit;

  let defaulters = await sql`
    SELECT 
      s.id as student_id, s.admission_no,
      p.display_name as student_name,
      c.name as class_name, sec.name as section_name,
      SUM(sf.amount_due - sf.discount - sf.amount_paid) as total_due,
      MIN(sf.due_date) as oldest_due_date,
      CURRENT_DATE - MIN(sf.due_date) as days_overdue
    FROM student_fees sf
    JOIN students s ON sf.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    JOIN fee_structures fs ON sf.fee_structure_id = fs.id
    JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active'
    JOIN class_sections cs ON se.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    WHERE sf.status IN ('pending', 'partial', 'overdue')
      AND sf.due_date < CURRENT_DATE
      AND s.deleted_at IS NULL
      AND s.school_id = ${req.schoolId}
      ${academic_year_id ? sql`AND fs.academic_year_id = ${academic_year_id}` : sql``}
      ${class_id ? sql`AND c.id = ${class_id}` : sql``}
    GROUP BY s.id, s.admission_no, p.display_name, c.name, sec.name
    HAVING CURRENT_DATE - MIN(sf.due_date) >= ${min_days_overdue}
    ORDER BY total_due DESC
    LIMIT ${safeLimit} OFFSET ${offset}
  `;

  return sendSuccess(res, req.schoolId, defaulters);
}));

/**
 * GET /fees/receipts
 * List receipts
 */
router.get('/receipts', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { student_id, from_date, to_date, page = 1, limit = 50 } = req.query;
  const safeLimit = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 50));
  const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
  const offset = (pageNum - 1) * safeLimit;

  let receipts;
  if (student_id) {
    receipts = await sql`
      SELECT 
        r.id, r.receipt_no, r.total_amount, r.issued_at, r.remarks,
        s.admission_no, p.display_name as student_name,
        enroll.class_name, enroll.section_name,
        issuer.display_name as issued_by_name
      FROM receipts r
      JOIN students s ON r.student_id = s.id AND s.school_id = ${req.schoolId}
      JOIN persons p ON s.person_id = p.id
      LEFT JOIN users u ON r.issued_by = u.id
      LEFT JOIN persons issuer ON u.person_id = issuer.id
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
      WHERE r.student_id = ${student_id}
        AND r.school_id = ${req.schoolId}
      ORDER BY r.issued_at DESC
      LIMIT ${safeLimit} OFFSET ${offset}
    `;
  } else {
    receipts = await sql`
      SELECT 
        r.id, r.receipt_no, r.total_amount, r.issued_at,
        r.payment_type,
        s.admission_no, p.display_name as student_name,
        x.payment_method,
        COALESCE(r.fee_type, x.fee_type, 'tuition') as fee_type
      FROM receipts r
      JOIN students s ON r.student_id = s.id AND s.school_id = ${req.schoolId}
      JOIN persons p ON s.person_id = p.id
      LEFT JOIN LATERAL (
        SELECT t.payment_method, ft.name as fee_type
        FROM receipt_items ri
        JOIN fee_transactions t ON ri.fee_transaction_id = t.id
        JOIN student_fees sf ON t.student_fee_id = sf.id AND sf.school_id = ${req.schoolId}
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        JOIN fee_types ft ON fs.fee_type_id = ft.id
        WHERE ri.receipt_id = r.id
        ORDER BY t.paid_at DESC NULLS LAST
        LIMIT 1
      ) x ON true
      WHERE r.school_id = ${req.schoolId}
        ${from_date ? sql`AND r.issued_at >= ${from_date}` : sql``}
        ${to_date ? sql`AND r.issued_at <= ${to_date}` : sql``}
      ORDER BY r.issued_at DESC
      LIMIT ${safeLimit} OFFSET ${offset}
    `;
  }

  return sendSuccess(res, req.schoolId, receipts);
}));

/**
 * GET /fees/receipts/:id
 * Get receipt details
 */
router.get('/receipts/:id', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [receipt] = await sql`
    SELECT 
      r.id, r.receipt_no, r.student_id, r.total_amount,
      r.issued_at, r.issued_by, r.remarks, r.created_at,
      s.admission_no, p.display_name as student_name,
      enroll.class_name, enroll.section_name,
      father_info.father_name, father_info.father_mobile,
      issuer.display_name as issued_by_name
    FROM receipts r
    JOIN students s ON r.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    LEFT JOIN users u ON r.issued_by = u.id
    LEFT JOIN persons issuer ON u.person_id = issuer.id
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
            AND pc.school_id = ${req.schoolId}
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
        AND sp.school_id = ${req.schoolId}
        AND sp.deleted_at IS NULL
      ORDER BY
        CASE WHEN rt.name = 'Father' THEN 0 WHEN COALESCE(sp.is_primary_contact, true) THEN 1 ELSE 2 END,
        sp.created_at
      LIMIT 1
    ) father_info ON true
    WHERE r.id = ${id} AND r.school_id = ${req.schoolId}
  `;

  if (!receipt) {
    return res.status(404).json({ error: 'Receipt not found' });
  }

  // Get receipt items
  const items = await sql`
    SELECT 
      ri.amount,
      ft.name as fee_type,
      t.payment_method, t.transaction_ref, t.paid_at
    FROM receipt_items ri
    JOIN fee_transactions t ON ri.fee_transaction_id = t.id
    JOIN student_fees sf ON t.student_fee_id = sf.id
    JOIN fee_structures fs ON sf.fee_structure_id = fs.id
    JOIN fee_types ft ON fs.fee_type_id = ft.id
    WHERE ri.receipt_id = ${id}
  `;

  return sendSuccess(res, req.schoolId, { ...receipt, items });
}));

/**
 * GET /fees/collectors
 * List fee collectors (users who have recorded collections or hold accounts/admin roles)
 */
router.get('/collectors', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const collectors = await sql`
    SELECT DISTINCT u.id, COALESCE(p.display_name, 'Staff') as name
    FROM (
      SELECT DISTINCT t.received_by as user_id
      FROM fee_transactions t
      WHERE t.school_id = ${req.schoolId}
        AND t.received_by IS NOT NULL
      UNION
      SELECT ur.user_id
      FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.school_id = ${req.schoolId}
        AND r.code IN ('accounts', 'accountant', 'admin')
    ) ids
    JOIN users u ON u.id = ids.user_id AND u.deleted_at IS NULL
    LEFT JOIN persons p ON u.person_id = p.id
    ORDER BY name
  `;
  return sendSuccess(res, req.schoolId, collectors);
}));

/**
 * GET /fees/transactions/:id/receipt-no
 * Serial receipt number for a posted fee transaction (for receipt printing).
 */
router.get('/transactions/:id/receipt-no', requireAnyPermission(['fees.view', 'fees.collect']), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [row] = await sql`
    SELECT r.receipt_no
    FROM receipt_items ri
    JOIN receipts r ON r.id = ri.receipt_id AND r.school_id = ${req.schoolId}
    WHERE ri.fee_transaction_id = ${id}
      AND ri.school_id = ${req.schoolId}
    LIMIT 1
  `;
  return sendSuccess(res, req.schoolId, { receipt_no: row?.receipt_no ?? null });
}));

/**
 * GET /fees/transactions
 * List fee transactions
 */
router.get('/transactions', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { from_date, to_date, payment_method, received_by, page = 1, limit = 50 } = req.query;
  const safeLimit = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 50));
  const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
  const offset = (pageNum - 1) * safeLimit;
  const receivedByFilter = received_by ? sql`AND t.received_by = ${received_by}` : sql``;

  const transactions = await sql`
    SELECT 
      t.id, t.amount, t.payment_method, t.transaction_ref, t.paid_at, t.remarks,
      t.received_by as received_by_id,
      t.student_fee_id,
      deletion_request.id as deletion_approval_id,
      CASE
        WHEN reversal.id IS NOT NULL THEN 'DELETED'
        ELSE deletion_request.status
      END as deletion_status,
      sf.student_id,
      s.admission_no, p.display_name as student_name,
      enroll.class_name, enroll.section_name,
      father_info.father_name, father_info.father_mobile,
      r.receipt_no,
      ft.name as fee_type, ft.name_te as fee_type_te, ay.code as academic_year,
      receiver.display_name as received_by,
      sf.amount_due, sf.amount_paid as total_paid, sf.discount,
      GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0) as balance_due
    FROM fee_transactions t
    LEFT JOIN receipt_items ri ON ri.fee_transaction_id = t.id AND ri.school_id = ${req.schoolId}
    LEFT JOIN receipts r ON r.id = ri.receipt_id AND r.school_id = ${req.schoolId}
    JOIN student_fees sf ON t.student_fee_id = sf.id AND sf.school_id = ${req.schoolId}
    JOIN students s ON sf.student_id = s.id AND s.school_id = ${req.schoolId}
    JOIN persons p ON s.person_id = p.id
    JOIN fee_structures fs ON sf.fee_structure_id = fs.id
    JOIN fee_types ft ON fs.fee_type_id = ft.id
    LEFT JOIN academic_years ay ON fs.academic_year_id = ay.id
    LEFT JOIN users u ON t.received_by = u.id
    LEFT JOIN persons receiver ON u.person_id = receiver.id
    LEFT JOIN LATERAL (
      SELECT ar.id, ar.status
      FROM approval_requests ar
      WHERE ar.school_id = ${req.schoolId}
        AND ar.type = 'fee_payment_deletion'
        AND ar.requested_by = t.received_by
        AND ar.payload->>'scope_key' = CASE
          WHEN t.receipt_group IS NOT NULL THEN 'receipt_group:' || t.receipt_group::text
          ELSE 'transaction:' || t.id::text
        END
      ORDER BY ar.created_at DESC
      LIMIT 1
    ) deletion_request ON true
    LEFT JOIN LATERAL (
      SELECT rev.id
      FROM fee_transactions rev
      WHERE rev.school_id = ${req.schoolId}
        AND rev.refund_of = t.id
        AND rev.transaction_ref LIKE 'VOID-%'
      LIMIT 1
    ) reversal ON true
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
            AND pc.school_id = ${req.schoolId}
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
        AND sp.school_id = ${req.schoolId}
        AND sp.deleted_at IS NULL
      ORDER BY
        CASE WHEN rt.name = 'Father' THEN 0 WHEN COALESCE(sp.is_primary_contact, true) THEN 1 ELSE 2 END,
        sp.created_at
      LIMIT 1
    ) father_info ON true
    WHERE t.school_id = ${req.schoolId}
      AND t.refund_of IS NULL
      ${from_date ? sql`AND t.paid_at >= ${from_date}` : sql``}
      ${to_date ? sql`AND t.paid_at <= ${to_date}` : sql``}
      ${payment_method ? sql`AND t.payment_method = ${payment_method}` : sql``}
      ${receivedByFilter}
    ORDER BY t.paid_at DESC
    LIMIT ${safeLimit} OFFSET ${offset}
  `;

  return sendSuccess(res, req.schoolId, transactions);
}));

/**
 * GET /fees/today-collection
 * Per-accountant today's collections — always scoped to the logged-in user.
 * Ignores any client-supplied received_by; accountants never see each other's data here.
 */
router.get('/today-collection', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const collectorId = req.user?.internal_id;
  if (!collectorId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const transactions = await sql`
    SELECT 
      t.id, t.amount, t.payment_method, t.transaction_ref, t.paid_at, t.remarks,
      t.received_by as received_by_id,
      t.student_fee_id,
      deletion_request.id as deletion_approval_id,
      CASE
        WHEN reversal.id IS NOT NULL THEN 'DELETED'
        ELSE deletion_request.status
      END as deletion_status,
      sf.student_id,
      s.admission_no, p.display_name as student_name,
      enroll.class_name, enroll.section_name,
      father_info.father_name, father_info.father_mobile,
      r.receipt_no,
      ft.name as fee_type, ft.name_te as fee_type_te, ay.code as academic_year,
      receiver.display_name as received_by,
      sf.amount_due, sf.amount_paid as total_paid, sf.discount,
      GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0) as balance_due
    FROM fee_transactions t
    LEFT JOIN receipt_items ri ON ri.fee_transaction_id = t.id AND ri.school_id = ${req.schoolId}
    LEFT JOIN receipts r ON r.id = ri.receipt_id AND r.school_id = ${req.schoolId}
    JOIN student_fees sf ON t.student_fee_id = sf.id AND sf.school_id = ${req.schoolId}
    JOIN students s ON sf.student_id = s.id AND s.school_id = ${req.schoolId}
    JOIN persons p ON s.person_id = p.id
    JOIN fee_structures fs ON sf.fee_structure_id = fs.id
    JOIN fee_types ft ON fs.fee_type_id = ft.id
    LEFT JOIN academic_years ay ON fs.academic_year_id = ay.id
    LEFT JOIN users u ON t.received_by = u.id
    LEFT JOIN persons receiver ON u.person_id = receiver.id
    LEFT JOIN LATERAL (
      SELECT ar.id, ar.status
      FROM approval_requests ar
      WHERE ar.school_id = ${req.schoolId}
        AND ar.type = 'fee_payment_deletion'
        AND ar.requested_by = t.received_by
        AND ar.payload->>'scope_key' = CASE
          WHEN t.receipt_group IS NOT NULL THEN 'receipt_group:' || t.receipt_group::text
          ELSE 'transaction:' || t.id::text
        END
      ORDER BY ar.created_at DESC
      LIMIT 1
    ) deletion_request ON true
    LEFT JOIN LATERAL (
      SELECT rev.id
      FROM fee_transactions rev
      WHERE rev.school_id = ${req.schoolId}
        AND rev.refund_of = t.id
        AND rev.transaction_ref LIKE 'VOID-%'
      LIMIT 1
    ) reversal ON true
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
            AND pc.school_id = ${req.schoolId}
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
        AND sp.school_id = ${req.schoolId}
        AND sp.deleted_at IS NULL
      ORDER BY
        CASE WHEN rt.name = 'Father' THEN 0 WHEN COALESCE(sp.is_primary_contact, true) THEN 1 ELSE 2 END,
        sp.created_at
      LIMIT 1
    ) father_info ON true
    WHERE t.school_id = ${req.schoolId}
      AND t.received_by = ${collectorId}
      AND t.refund_of IS NULL
      AND t.paid_at >= CURRENT_DATE
      AND t.paid_at < CURRENT_DATE + INTERVAL '1 day'
    ORDER BY t.paid_at DESC
  `;

  const byPaymentMethod = await sql`
    SELECT
      t.payment_method,
      COUNT(*)::int as transaction_count,
      COALESCE(SUM(t.amount), 0) as total_amount
    FROM fee_transactions t
    WHERE t.school_id = ${req.schoolId}
      AND t.received_by = ${collectorId}
      AND (t.refund_of IS NULL OR t.transaction_ref NOT LIKE 'VOID-%')
      AND NOT EXISTS (
        SELECT 1 FROM fee_transactions rev
        WHERE rev.school_id = t.school_id AND rev.refund_of = t.id AND rev.transaction_ref LIKE 'VOID-%'
      )
      AND t.paid_at >= CURRENT_DATE
      AND t.paid_at < CURRENT_DATE + INTERVAL '1 day'
    GROUP BY t.payment_method
  `;

  const [totals] = await sql`
    SELECT
      COUNT(*)::int as total_transactions,
      COALESCE(SUM(amount), 0) as total_collected
    FROM fee_transactions t
    WHERE t.school_id = ${req.schoolId}
      AND t.received_by = ${collectorId}
      AND (t.refund_of IS NULL OR t.transaction_ref NOT LIKE 'VOID-%')
      AND NOT EXISTS (
        SELECT 1 FROM fee_transactions rev
        WHERE rev.school_id = t.school_id AND rev.refund_of = t.id AND rev.transaction_ref LIKE 'VOID-%'
      )
      AND t.paid_at >= CURRENT_DATE
      AND t.paid_at < CURRENT_DATE + INTERVAL '1 day'
  `;

  const [todayRow] = await sql`SELECT CURRENT_DATE::text as today`;

  return sendSuccess(res, req.schoolId, {
    date: todayRow?.today,
    collector_id: collectorId,
    transactions,
    total_transactions: totals?.total_transactions ?? 0,
    total_collected: totals?.total_collected ?? 0,
    by_payment_method: byPaymentMethod,
  });
}));

// (Fix 7: Duplicate POST /transactions route removed — single handler at L236)

/**
 * GET /fees/collection-summary
 * Get daily/monthly collection summary
 */
router.get('/collection-summary', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { date, from_date, to_date, group_by = 'day', received_by } = req.query;
  const receivedByFilter = received_by ? sql`AND t.received_by = ${received_by}` : sql``;

  if (date) {
    // Single day summary — F7 FIX: Add school_id filter
    const summary = await sql`
      SELECT
        t.payment_method,
        COUNT(*) as transaction_count,
        SUM(t.amount) as total_amount
      FROM fee_transactions t
      WHERE DATE(t.paid_at) = ${date}
        AND t.school_id = ${req.schoolId}
        AND (t.refund_of IS NULL OR t.transaction_ref NOT LIKE 'VOID-%')
        AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = t.school_id AND rev.refund_of = t.id AND rev.transaction_ref LIKE 'VOID-%')
        ${receivedByFilter}
      GROUP BY t.payment_method
    `;

    const total = await sql`
      SELECT
        COUNT(*) as total_transactions,
        COALESCE(SUM(t.amount), 0) as total_collected
      FROM fee_transactions t
      WHERE DATE(t.paid_at) = ${date}
        AND t.school_id = ${req.schoolId}
        AND (t.refund_of IS NULL OR t.transaction_ref NOT LIKE 'VOID-%')
        AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = t.school_id AND rev.refund_of = t.id AND rev.transaction_ref LIKE 'VOID-%')
        ${receivedByFilter}
    `;

    return sendSuccess(res, req.schoolId, {
      date,
      by_payment_method: summary,
      ...total[0]
    });
  } else if (from_date && to_date) {
    // Range summary
    let summary;
    if (group_by === 'month') {
      summary = await sql`
        SELECT
          DATE_TRUNC('month', t.paid_at) as period,
          COUNT(*) as transaction_count,
          SUM(t.amount) as total_amount
        FROM fee_transactions t
        WHERE t.paid_at BETWEEN ${from_date} AND ${to_date}
          AND t.school_id = ${req.schoolId}
          AND (t.refund_of IS NULL OR t.transaction_ref NOT LIKE 'VOID-%')
          AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = t.school_id AND rev.refund_of = t.id AND rev.transaction_ref LIKE 'VOID-%')
          ${receivedByFilter}
        GROUP BY DATE_TRUNC('month', t.paid_at)
        ORDER BY period
      `;
    } else {
      summary = await sql`
        SELECT
          DATE(t.paid_at) as period,
          COUNT(*) as transaction_count,
          SUM(t.amount) as total_amount
        FROM fee_transactions t
        WHERE t.paid_at BETWEEN ${from_date} AND ${to_date}
          AND t.school_id = ${req.schoolId}
          AND (t.refund_of IS NULL OR t.transaction_ref NOT LIKE 'VOID-%')
          AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = t.school_id AND rev.refund_of = t.id AND rev.transaction_ref LIKE 'VOID-%')
          ${receivedByFilter}
        GROUP BY DATE(t.paid_at)
        ORDER BY period
      `;
    }

    const [rangeTotal] = await sql`
      SELECT
        COUNT(*)::int as total_transactions,
        COALESCE(SUM(t.amount), 0) as total_collected
      FROM fee_transactions t
      WHERE t.paid_at BETWEEN ${from_date} AND ${to_date}
        AND t.school_id = ${req.schoolId}
        AND (t.refund_of IS NULL OR t.transaction_ref NOT LIKE 'VOID-%')
        AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = t.school_id AND rev.refund_of = t.id AND rev.transaction_ref LIKE 'VOID-%')
        ${receivedByFilter}
    `;

    return sendSuccess(res, req.schoolId, {
      periods: summary,
      ...rangeTotal,
    });
  } else {
    // Today's summary by default — F7 FIX: Add school_id filter
    const today = new Date().toISOString().split('T')[0];
    const summary = await sql`
      SELECT
        COUNT(*) as total_transactions,
        COALESCE(SUM(t.amount), 0) as total_collected
      FROM fee_transactions t
      WHERE DATE(t.paid_at) = ${today}
        AND t.school_id = ${req.schoolId}
        AND (t.refund_of IS NULL OR t.transaction_ref NOT LIKE 'VOID-%')
        AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = t.school_id AND rev.refund_of = t.id AND rev.transaction_ref LIKE 'VOID-%')
        ${receivedByFilter}
    `;

    return sendSuccess(res, req.schoolId, { date: today, ...summary[0] });
  }
}));

/**
 * GET /fees/dashboard-stats
 * Get consolidated stats for dashboard
 */
// Fix 4: Protected with requirePermission
/** All stats visible — default for any caller that is not the accounts dashboard. */
function allVisibleConfig() {
  return ACCOUNTS_STAT_KEYS.reduce((acc, key) => {
    acc[key] = true;
    return acc;
  }, {});
}

/** Visibility toggles apply only when the accounts dashboard explicitly opts in (?for_accounts=1). */
function shouldApplyVisibilityConfig(req) {
  const flag = req.query.for_accounts;
  return flag === '1' || flag === 'true';
}

function getDateRange(range) {
  const now = new Date();
  let startDate;
  switch (range) {
    case 'quarter':
      startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
      break;
    case 'year':
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    case 'month':
    default:
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
  }
  return startDate;
}

// Helper for generating insights locally
async function getSystemInsights(schoolId, statsRef) {
  const insights = [];
  let id = 1;

  // 1. Finance alerts
  const outstanding = statsRef.pending_dues !== undefined ? statsRef.pending_dues : null;
  const efficiency = statsRef.collection_efficiency !== undefined ? statsRef.collection_efficiency : null;

  if (outstanding !== null && outstanding > 50000) {
    insights.push({
      id: String(id++),
      severity: 'high',
      category: 'finance',
      message: `Outstanding dues at ₹${(outstanding / 1000).toFixed(1)}K — needs immediate attention.`,
      created_at: new Date().toISOString()
    });
  }
  if (efficiency !== null) {
    if (efficiency < 70) {
      insights.push({
        id: String(id++),
        severity: 'high',
        category: 'finance',
        message: `Collection efficiency is only ${efficiency}% — significantly below target.`,
        created_at: new Date().toISOString()
      });
    } else if (efficiency < 85) {
      insights.push({
        id: String(id++),
        severity: 'medium',
        category: 'finance',
        message: `Collection efficiency at ${efficiency}% — room for improvement.`,
        created_at: new Date().toISOString()
      });
    }
  }

  // 2. Attendance alerts
  const avgAttVal = statsRef.avg_attendance?.avg_attendance !== undefined ? statsRef.avg_attendance.avg_attendance : null;
  if (avgAttVal !== null) {
    if (avgAttVal < 75) {
      insights.push({
        id: String(id++),
        severity: 'high',
        category: 'attendance',
        message: `Average attendance critically low at ${avgAttVal}%.`,
        created_at: new Date().toISOString()
      });
    } else if (avgAttVal < 85) {
      insights.push({
        id: String(id++),
        severity: 'medium',
        category: 'attendance',
        message: `Average attendance at ${avgAttVal}% — below target of 85%.`,
        created_at: new Date().toISOString()
      });
    }
  }

  // 3. Academic alerts
  const avgScoreVal = statsRef.academic_score?.avg_score !== undefined ? statsRef.academic_score.avg_score : null;
  if (avgScoreVal !== null) {
    if (avgScoreVal < 70) {
      insights.push({
        id: String(id++),
        severity: 'high',
        category: 'academic',
        message: `Average score is only ${avgScoreVal}% — academic support programs recommended.`,
        created_at: new Date().toISOString()
      });
    } else if (avgScoreVal < 85) {
      insights.push({
        id: String(id++),
        severity: 'medium',
        category: 'academic',
        message: `Average score at ${avgScoreVal}% — consider additional tutoring sessions.`,
        created_at: new Date().toISOString()
      });
    }
  }

  return insights.slice(0, 5);
}

// Fix 4: Protected with requirePermission
router.get('/dashboard-stats', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const feeMode = await getSchoolFeeMode(schoolId);
  const structureModeFilter = activeStructureFilter(feeMode);

  // 1. Get resolved config for the school
  const schoolRows = await sql`
    SELECT accounts_dashboard_config
    FROM schools
    WHERE id = ${schoolId}
  `;
  const savedConfig = resolveAccountsDashboardConfig(schoolRows[0]?.accounts_dashboard_config);
  const config = shouldApplyVisibilityConfig(req) ? savedConfig : allVisibleConfig();

  const stats = {};
  const start = getDateRange('month');

  // Helper variables for shared calculations
  let invoiced = null;
  let collected = null;
  let outstanding = null;

  // Always calculate these non-toggleable items
  const [totalCollected, defaulterCount, recentTransactions] = await Promise.all([
    sql`
      SELECT COALESCE(SUM(ft.amount), 0) as total
      FROM fee_transactions ft
      WHERE ft.school_id = ${schoolId}
        AND (ft.refund_of IS NULL OR ft.transaction_ref NOT LIKE 'VOID-%')
        AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = ft.school_id AND rev.refund_of = ft.id AND rev.transaction_ref LIKE 'VOID-%')
    `,
    sql`
      SELECT COUNT(DISTINCT sf.student_id) as count
      FROM student_fees sf
      JOIN fee_structures fs ON sf.fee_structure_id = fs.id
      WHERE sf.status IN ('pending', 'partial', 'overdue')
        AND sf.due_date < CURRENT_DATE
        AND sf.deleted_at IS NULL
        AND fs.deleted_at IS NULL
        AND sf.school_id = ${schoolId}
        ${structureModeFilter}
    `,
    sql`
      SELECT
          ft.id,
          ft.amount,
          ft.paid_at as collected_at,
          ft.payment_method,
          p.display_name as student_name,
          c.name as class_name,
          ftype.name as fee_type, ftype.name_te as fee_type_te
      FROM fee_transactions ft
      JOIN student_fees sf ON ft.student_fee_id = sf.id
      JOIN students s ON sf.student_id = s.id
      JOIN persons p ON s.person_id = p.id
      LEFT JOIN fee_structures fs ON sf.fee_structure_id = fs.id
      LEFT JOIN classes c ON fs.class_id = c.id
      LEFT JOIN fee_types ftype ON fs.fee_type_id = ftype.id
      WHERE ft.school_id = ${schoolId}
        AND (ft.refund_of IS NULL OR ft.transaction_ref NOT LIKE 'VOID-%')
        AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = ft.school_id AND rev.refund_of = ft.id AND rev.transaction_ref LIKE 'VOID-%')
      ORDER BY ft.paid_at DESC
      LIMIT 5
    `
  ]);

  stats.collected_total = Number(totalCollected[0]?.total || 0);
  stats.defaulter_count = Number(defaulterCount[0]?.count || 0);
  stats.recent_transactions = recentTransactions || [];

  // Conditional stats computation
  if (config.total_collection_month) {
    const monthlyStats = await sql`
      SELECT COALESCE(SUM(ft.amount), 0) as total
      FROM fee_transactions ft
      WHERE date_trunc('month', ft.paid_at) = date_trunc('month', CURRENT_DATE)
        AND ft.school_id = ${schoolId}
        AND (ft.refund_of IS NULL OR ft.transaction_ref NOT LIKE 'VOID-%')
        AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = ft.school_id AND rev.refund_of = ft.id AND rev.transaction_ref LIKE 'VOID-%')
    `;
    stats.total_collection_month = Number(monthlyStats[0]?.total || 0);
  }

  if (config.todays_collection) {
    const todayStats = await sql`
      SELECT COALESCE(SUM(ft.amount), 0) as total
      FROM fee_transactions ft
      WHERE ft.paid_at::date = CURRENT_DATE
        AND ft.school_id = ${schoolId}
        AND (ft.refund_of IS NULL OR ft.transaction_ref NOT LIKE 'VOID-%')
        AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = ft.school_id AND rev.refund_of = ft.id AND rev.transaction_ref LIKE 'VOID-%')
    `;
    stats.todays_collection = Number(todayStats[0]?.total || 0);
  }

  if (config.pending_dues) {
    const pendingStats = await sql`
      SELECT COALESCE(SUM(sf.amount_due - sf.amount_paid - sf.discount), 0) as total
      FROM student_fees sf
      JOIN fee_structures fs ON sf.fee_structure_id = fs.id
      WHERE sf.status IN ('pending', 'partial', 'overdue')
        AND sf.deleted_at IS NULL
        AND fs.deleted_at IS NULL
        AND sf.school_id = ${schoolId}
        ${structureModeFilter}
    `;
    stats.pending_dues = Number(pendingStats[0]?.total || 0);
  }

  if (config.revenue_trend || config.collection_efficiency) {
    const [invoicedRes, collectedRes, outstandingRes] = await Promise.all([
      sql`
        SELECT COALESCE(SUM(sf.amount_due), 0) as total
        FROM student_fees sf
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        WHERE sf.created_at >= ${start}
          AND sf.deleted_at IS NULL
          AND fs.deleted_at IS NULL
          AND sf.school_id = ${schoolId}
          ${structureModeFilter}
      `,
      sql`
        SELECT COALESCE(SUM(ft.amount), 0) as total
        FROM fee_transactions ft
        JOIN student_fees sf ON ft.student_fee_id = sf.id
        WHERE ft.paid_at >= ${start}
          AND sf.school_id = ${schoolId}
          AND (ft.refund_of IS NULL OR ft.transaction_ref NOT LIKE 'VOID-%')
          AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = ft.school_id AND rev.refund_of = ft.id AND rev.transaction_ref LIKE 'VOID-%')
      `,
      sql`
        SELECT COALESCE(SUM(sf.amount_due - sf.discount - sf.amount_paid), 0) as total
        FROM student_fees sf
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        WHERE sf.status != 'paid'
          AND sf.deleted_at IS NULL
          AND fs.deleted_at IS NULL
          AND sf.school_id = ${schoolId}
          ${structureModeFilter}
      `
    ]);
    invoiced = invoicedRes[0];
    collected = collectedRes[0];
    outstanding = outstandingRes[0];
  }

  if (config.revenue_trend) {
    const trend = await sql`
      SELECT
          TO_CHAR(ft.paid_at, 'Mon') as label,
          SUM(ft.amount) as value
      FROM fee_transactions ft
      JOIN student_fees sf ON ft.student_fee_id = sf.id
      WHERE ft.paid_at > CURRENT_DATE - INTERVAL '6 months'
        AND sf.school_id = ${schoolId}
        AND (ft.refund_of IS NULL OR ft.transaction_ref NOT LIKE 'VOID-%')
        AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = ft.school_id AND rev.refund_of = ft.id AND rev.transaction_ref LIKE 'VOID-%')
      GROUP BY TO_CHAR(ft.paid_at, 'Mon'), DATE_TRUNC('month', ft.paid_at)
      ORDER BY DATE_TRUNC('month', ft.paid_at)
    `;
    stats.revenue_trend = {
      trend: trend.map(t => ({ label: t.label, value: parseFloat(t.value) || 0 })),
      total_invoiced: parseFloat(invoiced?.total) || 0,
      total_collected: parseFloat(collected?.total) || 0,
      outstanding_dues: parseFloat(outstanding?.total) || 0
    };
  }

  if (config.collection_efficiency) {
    const totalCollectedVal = parseFloat(collected?.total) || 0;
    const totalInvoicedVal = parseFloat(invoiced?.total) || 0;
    stats.collection_efficiency = totalInvoicedVal > 0 ? Math.round((totalCollectedVal / totalInvoicedVal) * 100) : 0;
  }

  if (config.avg_attendance) {
    const [avgAtt, presentDays, workingDays] = await Promise.all([
      sql`
        SELECT
            (COUNT(*) FILTER (WHERE da.status IN ('present', 'late', 'half_day')))::FLOAT
            / NULLIF(COUNT(*), 0) * 100 as pct
        FROM daily_attendance da
        JOIN student_enrollments se ON da.student_enrollment_id = se.id
        JOIN students s ON se.student_id = s.id
        WHERE da.attendance_date >= ${start}
          AND s.school_id = ${schoolId}
      `,
      sql`
        SELECT COUNT(*) as count
        FROM daily_attendance da
        JOIN student_enrollments se ON da.student_enrollment_id = se.id
        JOIN students s ON se.student_id = s.id
        WHERE da.attendance_date >= ${start}
          AND da.status IN ('present', 'late', 'half_day')
          AND s.school_id = ${schoolId}
      `,
      sql`
        SELECT COUNT(DISTINCT da.attendance_date) as count
        FROM daily_attendance da
        JOIN student_enrollments se ON da.student_enrollment_id = se.id
        JOIN students s ON se.student_id = s.id
        WHERE da.attendance_date >= ${start}
          AND s.school_id = ${schoolId}
      `
    ]);
    stats.avg_attendance = {
      avg_attendance: Math.round(avgAtt[0]?.pct || 0),
      total_present_days: parseInt(presentDays[0]?.count) || 0,
      total_working_days: parseInt(workingDays[0]?.count) || 0
    };
  }

  if (config.academic_score) {
    const [avgScore, examsCount] = await Promise.all([
      sql`
        SELECT COALESCE(AVG(m.marks_obtained::FLOAT / NULLIF(es.max_marks, 0) * 100), 0)::FLOAT as avg
        FROM marks m
        JOIN exam_subjects es ON m.exam_subject_id = es.id
        JOIN student_enrollments se ON m.student_enrollment_id = se.id
        JOIN students s ON se.student_id = s.id
        WHERE s.school_id = ${schoolId}
          AND m.created_at >= ${start}
      `,
      sql`
        SELECT COUNT(DISTINCT e.id) as count
        FROM exams e
        JOIN exam_subjects es ON e.id = es.exam_id
        JOIN marks m ON es.id = m.exam_subject_id
        JOIN student_enrollments se ON m.student_enrollment_id = se.id
        JOIN students s ON se.student_id = s.id
        WHERE s.school_id = ${schoolId}
          AND m.created_at >= ${start}
      `
    ]);
    stats.academic_score = {
      avg_score: Math.round(parseFloat(avgScore[0]?.avg) || 0),
      exams_conducted: parseInt(examsCount[0]?.count) || 0
    };
  }

  if (config.system_insights) {
    stats.system_insights = await getSystemInsights(schoolId, stats);
  }

  // Always echo savedConfig so the accounts dashboard UI knows which sections are hidden.
  return sendSuccess(res, schoolId, { config: savedConfig, stats });
}));

/**
 * POST /fees/adjust
 * Apply a direction-aware fee adjustment (waive = credit, add = debit)
 */
router.post('/adjust', requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
  const { student_fee_id, amount, reason, adjustment_type } = req.body;

  if (!student_fee_id || amount === undefined || !reason) {
    return res.status(400).json({ error: 'student_fee_id, amount, and reason are required' });
  }

  if (!['waive', 'add'].includes(adjustment_type)) {
    return res.status(400).json({ error: "adjustment_type must be 'waive' or 'add'" });
  }

  const parsedAmount = Number(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const isWaive = adjustment_type === 'waive';

  // Get admin display name
  const [adminPerson] = await sql`
    SELECT p.display_name
    FROM users u
    JOIN persons p ON u.person_id = p.id
    WHERE u.id = ${req.user.internal_id}
      AND u.school_id = ${req.schoolId}
  `;
  const adminName = adminPerson?.display_name || 'Admin';

  const { updatedFee, adjustment } = await sql.begin(async (tx) => {
    // Lock student fee and get student + fee component information
    const [fee] = await tx`
      SELECT sf.id, sf.amount_due, sf.amount_paid, sf.discount, sf.student_id, sf.due_date, ft.name as fee_type
      FROM student_fees sf
      JOIN fee_structures fs ON sf.fee_structure_id = fs.id
      JOIN fee_types ft ON fs.fee_type_id = ft.id
      WHERE sf.id = ${student_fee_id}
        AND sf.school_id = ${req.schoolId}
        AND sf.deleted_at IS NULL
      FOR UPDATE
    `;

    if (!fee) {
      const err = new Error('Student fee not found');
      err.status = 404;
      throw err;
    }

    const remaining = Number(fee.amount_due) - Number(fee.discount) - Number(fee.amount_paid);
    if (isWaive && parsedAmount > remaining) {
      const err = new Error(`Cannot waive more than the outstanding amount (₹${remaining})`);
      err.status = 422;
      throw err;
    }

    // Generate unique receipt number per school
    const [receiptData] = await tx`
      SELECT public.get_next_adj_receipt_no(${req.schoolId}) as receipt_no
    `;
    const receiptNo = receiptData.receipt_no;

    // Log the adjustment
    const [adjustment] = await tx`
      INSERT INTO fee_adjustments (
        school_id, student_id, student_fee_id, fee_component,
        amount, reason, receipt_no, adjusted_by, adjusted_by_name, adjustment_type
      ) VALUES (
        ${req.schoolId}, ${fee.student_id}, ${student_fee_id}, ${fee.fee_type},
        ${parsedAmount}, ${reason}, ${receiptNo}, ${req.user.internal_id}, ${adminName}, ${adjustment_type}
      )
      RETURNING *
    `;

    let updatedFee;
    if (isWaive) {
      [updatedFee] = await tx`
        UPDATE student_fees
        SET discount = discount + ${parsedAmount},
            updated_at = NOW()
        WHERE id = ${student_fee_id}
          AND school_id = ${req.schoolId}
        RETURNING id, amount_due, amount_paid, discount, status, updated_at
      `;
    } else {
      [updatedFee] = await tx`
        UPDATE student_fees
        SET amount_due = amount_due + ${parsedAmount},
            updated_at = NOW(),
            status = CASE
              WHEN amount_paid >= (amount_due + ${parsedAmount} - discount) THEN 'paid'::fee_status_enum
              WHEN amount_paid > 0 THEN 'partial'::fee_status_enum
              WHEN due_date < CURRENT_DATE THEN 'overdue'::fee_status_enum
              ELSE 'pending'::fee_status_enum
            END
        WHERE id = ${student_fee_id}
          AND school_id = ${req.schoolId}
        RETURNING id, amount_due, amount_paid, discount, status, updated_at
      `;
    }

    return { updatedFee, adjustment };
  });

  const signPrefix = isWaive ? '-' : '+';

  // Send Notification to Student + Parents (Async)
  (async () => {
    try {
      const recipients = await sql`
        SELECT u.id as user_id FROM users u
        JOIN students s ON u.person_id = s.person_id
        WHERE s.id = ${adjustment.student_id}
          AND s.school_id = ${req.schoolId}
          AND u.school_id = ${req.schoolId}
          AND u.account_status = 'active'
        UNION
        SELECT u.id as user_id FROM users u
        JOIN parents p ON u.person_id = p.person_id AND p.school_id = ${req.schoolId}
        JOIN student_parents sp ON p.id = sp.parent_id AND sp.school_id = ${req.schoolId}
        WHERE sp.student_id = ${adjustment.student_id}
          AND u.school_id = ${req.schoolId}
          AND u.account_status = 'active'
      `;

      if (recipients.length > 0) {
        await sendNotificationToUsers(
          recipients.map((r) => r.user_id),
          'FEE_ADJUSTED',
          { message: `A fee adjustment of ${signPrefix}₹${parsedAmount} has been applied to ${adjustment.fee_component} for your student.` }
        );
      }
    } catch (err) {
      // suppress async notify error
    }
  })();

  return sendSuccess(res, req.schoolId, {
    message: 'Adjustment applied successfully',
    fee: updatedFee,
    adjustment
  });
}));

/**
 * GET /fees/adjustments
 * List all adjustments (guarded, scoped by role)
 */
router.get('/adjustments', requireAuth, asyncHandler(async (req, res) => {
  const { student_id, student_fee_id, page = 1, limit = 50 } = req.query;
  const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 50));
  const offset = (pageNum - 1) * safeLimit;

  const isAdmin = req.user.roles?.includes('admin') || req.user.roles?.includes('principal');
  let targetStudentId = student_id;

  if (!isAdmin) {
    const studentId = await resolveStudentIdForSelfService(req);
    if (!studentId) {
      return res.status(403).json({ error: 'Access denied. Student profile not found.' });
    }
    targetStudentId = studentId;
  }

  const baseWhere = sql`fa.school_id = ${req.schoolId}`;
  const studentFilter = targetStudentId ? sql`AND fa.student_id = ${targetStudentId}` : sql``;
  const feeFilter = student_fee_id ? sql`AND fa.student_fee_id = ${student_fee_id}` : sql``;

  const adjustments = await sql`
    SELECT 
      fa.id, fa.amount, fa.reason, fa.receipt_no, fa.fee_component, fa.created_at, fa.adjusted_by_name,
      fa.adjustment_type,
      p.display_name as student_name, s.admission_no
    FROM fee_adjustments fa
    JOIN students s ON fa.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    WHERE ${baseWhere}
      ${studentFilter}
      ${feeFilter}
    ORDER BY fa.created_at DESC
    LIMIT ${safeLimit} OFFSET ${offset}
  `;

  const [countResult] = await sql`
    SELECT COUNT(*)::int as total
    FROM fee_adjustments fa
    WHERE ${baseWhere}
      ${studentFilter}
      ${feeFilter}
  `;

  return sendSuccess(res, req.schoolId, {
    data: adjustments,
    meta: {
      total: countResult.total,
      page: pageNum,
      limit: safeLimit,
      total_pages: Math.ceil(countResult.total / safeLimit) || 1,
    }
  });
}));

/**
 * GET /fees/adjustments/:id
 * Get specific adjustment details (for receipt printing)
 */
router.get('/adjustments/:id', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [adjustment] = await sql`
    SELECT 
      fa.id, fa.amount, fa.reason, fa.receipt_no, fa.fee_component, fa.created_at, fa.adjusted_by_name,
      fa.adjustment_type,
      fa.student_id, p.display_name as student_name, s.admission_no,
      enroll.class_name, enroll.section_name
    FROM fee_adjustments fa
    JOIN students s ON fa.student_id = s.id
    JOIN persons p ON s.person_id = p.id
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
    WHERE fa.id = ${id}
      AND fa.school_id = ${req.schoolId}
  `;

  if (!adjustment) {
    return res.status(404).json({ error: 'Adjustment record not found' });
  }

  // Authorization check
  const isAdmin = req.user.roles?.includes('admin') || req.user.roles?.includes('principal');
  if (!isAdmin) {
    const studentId = await resolveStudentIdForSelfService(req);
    if (!studentId || studentId !== adjustment.student_id) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }

  return sendSuccess(res, req.schoolId, adjustment);
}));


// ============== FEE REMINDERS ==============

/**
 * POST /fees/remind
 * Send fee reminders to students with pending fees
 */
router.post('/remind', requirePermission('fees.manage'), asyncHandler(async (req, res) => {
  const { target_group, class_id, message } = req.body;

  if (!target_group || target_group === 'class' && !class_id) {
    return res.status(400).json({ error: 'Valid target_group and class_id (if target is class) are required' });
  }

  // 1. Find students with pending fees
  let students;
  if (target_group === 'class') {
    students = await sql`
      SELECT DISTINCT s.id, s.person_id, p.display_name, u.id as user_id
      FROM student_fees sf
      JOIN students s ON sf.student_id = s.id
      JOIN persons p ON s.person_id = p.id
      JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active' AND se.school_id = ${req.schoolId}
      JOIN class_sections cs ON se.class_section_id = cs.id
      JOIN users u ON u.person_id = p.id AND u.school_id = ${req.schoolId}
      WHERE sf.status IN ('pending', 'partial', 'overdue')
        AND cs.class_id = ${class_id}
        AND s.deleted_at IS NULL
        AND s.school_id = ${req.schoolId}
    `;
  } else {
    // All Pending
    students = await sql`
      SELECT DISTINCT s.id, s.person_id, p.display_name, u.id as user_id
      FROM student_fees sf
      JOIN students s ON sf.student_id = s.id
      JOIN persons p ON s.person_id = p.id
      JOIN users u ON u.person_id = p.id AND u.school_id = ${req.schoolId}
      WHERE sf.status IN ('pending', 'partial', 'overdue')
        AND s.deleted_at IS NULL
        AND s.school_id = ${req.schoolId}
    `;
  }

  if (!students || students.length === 0) {
    return sendSuccess(res, req.schoolId, { message: 'No students found with pending fees', count: 0 });
  }

  // 2. Also fetch parent user IDs for the same students
  const studentIds = [...new Set(students.map((s) => s.id))];
  let parentUserIds = [];
  if (studentIds.length > 0) {
    const parentUsers = await sql`
      SELECT DISTINCT u.id as user_id
      FROM users u
      JOIN parents p ON u.person_id = p.person_id AND p.school_id = ${req.schoolId}
      JOIN student_parents sp ON p.id = sp.parent_id AND sp.school_id = ${req.schoolId}
      WHERE sp.student_id IN ${sql(studentIds)}
        AND u.school_id = ${req.schoolId}
        AND u.account_status = 'active'
    `;
    parentUserIds = parentUsers.map((p) => p.user_id);
  }

  // 3. Send Notifications (Students + Parents)
  try {
    const studentUserIds = students.map((s) => s.user_id);
    const userIds = [...new Set([...studentUserIds, ...parentUserIds])];
    const notificationMessage = message || "Your fee is pending. Please pay before the due date to avoid late fees.";

    if (userIds.length > 0) {
      await sendNotificationToUsers(
        userIds,
        'FEE_REMINDER',
        { message: notificationMessage }
      );
    }

    return sendSuccess(res, req.schoolId, { message: 'Fee reminders queued', student_count: students.length });

  } catch (err) {

    // Return success to client as process was initiated, but log the error
    return sendSuccess(res, req.schoolId, { message: 'Identified students but failed to send notifications', error: err.message });
  }
}));

export default router;
