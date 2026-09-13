import sql from '../db.js';
import { randomUUID } from 'crypto';
import * as XLSX from 'xlsx';
import { calculateFineAmount, validateFinePolicy } from './finePolicyEngine.js';
import {
  FINE_STATUSES,
  assertCanTransition,
  determineStatusAfterPayment,
  determineStatusAfterWaiver,
} from './fineStateMachine.js';
import { logFineEvent } from './fineAuditService.js';
import { sendNotificationToUsers } from './notificationService.js';
import { canAccessStudentData, isStudentPortalRequest } from '../utils/studentPortal.js';
import logger from '../utils/logger.js';

const VIEW_ALL_PERMS = ['fine.view', 'fees.view', 'admin.manage', 'approvals.manage', 'fine.report_view'];
const STAFF_REQUEST_ROLES = ['teacher', 'staff', 'admin', 'principal', 'accountant', 'accounts', 'management'];

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function hasAnyPermission(user, codes) {
  const roles = user?.roles || [];
  if (roles.includes('admin') || roles.includes('principal')) return true;
  const perms = user?.permissions || [];
  return codes.some((code) => perms.includes(code));
}

export function canCreatePostedFines(user) {
  return hasAnyPermission(user, ['fine.create', 'fees.manage', 'admin.manage']);
}

export function canRequestFines(user) {
  const roles = user?.roles || [];
  if (roles.some((r) => STAFF_REQUEST_ROLES.includes(r))) return true;
  return hasAnyPermission(user, ['fine.request', 'fine.create', 'fees.manage']);
}

export async function assertFineReadable(req, fine) {
  if (!fine) throw httpError('Fine not found', 404);
  const user = req.user;
  if (hasAnyPermission(user, VIEW_ALL_PERMS)) return true;
  if (fine.requested_by && fine.requested_by === user?.internal_id) return true;
  if (isStudentPortalRequest(req)) {
    const allowed = await canAccessStudentData(req, fine.student_id);
    if (allowed) return true;
  }
  throw httpError('Access denied', 403);
}

// ============== 1. FINE CATEGORIES ==============

export async function listFineCategories(schoolId, { activeOnly = false } = {}) {
  return sql`
    SELECT id, school_id, name, code, description, active, display_order, created_at, updated_at
    FROM public.fine_categories
    WHERE school_id = ${Number(schoolId)}
      ${activeOnly ? sql`AND active = TRUE` : sql``}
    ORDER BY display_order ASC, name ASC
  `;
}

export async function createFineCategory(schoolId, data, user = null) {
  const { name, code, description, display_order = 0 } = data;
  if (!name || !code) {
    const error = new Error('Category name and code are required');
    error.status = 400;
    throw error;
  }

  const cleanCode = String(code).trim().toUpperCase().replace(/\s+/g, '_');
  const [category] = await sql`
    INSERT INTO public.fine_categories (
      school_id, name, code, description, display_order, created_by
    ) VALUES (
      ${Number(schoolId)}, ${name.trim()}, ${cleanCode}, ${description || null},
      ${Number(display_order) || 0}, ${user?.internal_id || null}
    )
    RETURNING *
  `;
  return category;
}

export async function updateFineCategory(schoolId, categoryId, data) {
  const { name, description, display_order, active } = data;
  const [updated] = await sql`
    UPDATE public.fine_categories
    SET
      name = COALESCE(${name ? name.trim() : null}, name),
      description = COALESCE(${description}, description),
      display_order = COALESCE(${display_order != null ? Number(display_order) : null}, display_order),
      active = COALESCE(${active != null ? Boolean(active) : null}, active),
      updated_at = NOW()
    WHERE id = ${categoryId} AND school_id = ${Number(schoolId)}
    RETURNING *
  `;
  if (!updated) {
    const error = new Error('Fine category not found');
    error.status = 404;
    throw error;
  }
  return updated;
}

// ============== 2. FINE POLICIES ==============

export async function listFinePolicies(schoolId, { categoryId, activeOnly = false, autoApplyOnly = false } = {}) {
  return sql`
    SELECT
      fp.*,
      fc.name as category_name,
      fc.code as category_code
    FROM public.fine_policies fp
    JOIN public.fine_categories fc ON fp.category_id = fc.id
    WHERE fp.school_id = ${Number(schoolId)}
      ${categoryId ? sql`AND fp.category_id = ${categoryId}` : sql``}
      ${activeOnly ? sql`AND fp.active = TRUE` : sql``}
      ${autoApplyOnly ? sql`AND fp.auto_apply = TRUE` : sql``}
    ORDER BY fc.display_order ASC, fp.name ASC
  `;
}

export async function createFinePolicy(schoolId, data, user = null) {
  const validation = validateFinePolicy(data);
  if (!validation.isValid) {
    const error = new Error(validation.errors.join('; '));
    error.status = 400;
    throw error;
  }

  const {
    category_id,
    name,
    description,
    calculation_type,
    fixed_amount,
    per_day_amount,
    percentage,
    minimum_amount,
    maximum_amount,
    grace_days = 0,
    auto_apply = false,
    approval_required = false,
    approval_threshold_amount,
    applicable_module = 'GENERAL',
    effective_from,
    effective_until,
  } = data;

  const [policy] = await sql`
    INSERT INTO public.fine_policies (
      school_id, category_id, name, description, calculation_type,
      fixed_amount, per_day_amount, percentage, minimum_amount, maximum_amount,
      grace_days, auto_apply, approval_required, approval_threshold_amount,
      applicable_module, effective_from, effective_until, created_by
    ) VALUES (
      ${Number(schoolId)}, ${category_id}, ${name.trim()}, ${description || null}, ${calculation_type.toUpperCase()},
      ${fixed_amount != null ? Number(fixed_amount) : null},
      ${per_day_amount != null ? Number(per_day_amount) : null},
      ${percentage != null ? Number(percentage) : null},
      ${minimum_amount != null ? Number(minimum_amount) : null},
      ${maximum_amount != null ? Number(maximum_amount) : null},
      ${Number(grace_days) || 0}, ${Boolean(auto_apply)}, ${Boolean(approval_required)},
      ${approval_threshold_amount != null ? Number(approval_threshold_amount) : null},
      ${applicable_module}, ${effective_from || null}, ${effective_until || null},
      ${user?.internal_id || null}
    )
    RETURNING *
  `;
  return policy;
}

export async function updateFinePolicy(schoolId, policyId, data) {
  const [existing] = await sql`
    SELECT * FROM public.fine_policies WHERE id = ${policyId} AND school_id = ${Number(schoolId)}
  `;
  if (!existing) {
    const error = new Error('Fine policy not found');
    error.status = 404;
    throw error;
  }

  const merged = { ...existing, ...data };
  const validation = validateFinePolicy(merged);
  if (!validation.isValid) {
    const error = new Error(validation.errors.join('; '));
    error.status = 400;
    throw error;
  }

  const [updated] = await sql`
    UPDATE public.fine_policies
    SET
      name = COALESCE(${data.name ? data.name.trim() : null}, name),
      description = COALESCE(${data.description}, description),
      calculation_type = COALESCE(${data.calculation_type ? data.calculation_type.toUpperCase() : null}, calculation_type),
      fixed_amount = ${data.fixed_amount !== undefined ? (data.fixed_amount != null ? Number(data.fixed_amount) : null) : existing.fixed_amount},
      per_day_amount = ${data.per_day_amount !== undefined ? (data.per_day_amount != null ? Number(data.per_day_amount) : null) : existing.per_day_amount},
      percentage = ${data.percentage !== undefined ? (data.percentage != null ? Number(data.percentage) : null) : existing.percentage},
      minimum_amount = ${data.minimum_amount !== undefined ? (data.minimum_amount != null ? Number(data.minimum_amount) : null) : existing.minimum_amount},
      maximum_amount = ${data.maximum_amount !== undefined ? (data.maximum_amount != null ? Number(data.maximum_amount) : null) : existing.maximum_amount},
      grace_days = COALESCE(${data.grace_days != null ? Number(data.grace_days) : null}, grace_days),
      auto_apply = COALESCE(${data.auto_apply != null ? Boolean(data.auto_apply) : null}, auto_apply),
      approval_required = COALESCE(${data.approval_required != null ? Boolean(data.approval_required) : null}, approval_required),
      approval_threshold_amount = ${data.approval_threshold_amount !== undefined ? (data.approval_threshold_amount != null ? Number(data.approval_threshold_amount) : null) : existing.approval_threshold_amount},
      applicable_module = COALESCE(${data.applicable_module}, applicable_module),
      effective_from = ${data.effective_from !== undefined ? data.effective_from : existing.effective_from},
      effective_until = ${data.effective_until !== undefined ? data.effective_until : existing.effective_until},
      active = COALESCE(${data.active != null ? Boolean(data.active) : null}, active),
      updated_at = NOW()
    WHERE id = ${policyId} AND school_id = ${Number(schoolId)}
    RETURNING *
  `;
  return updated;
}

// ============== 3. FINE TRANSACTIONS & LIFECYCLE ==============

/**
 * Creates a fine manually (by Accounts / Admin).
 */
export async function createManualFine(schoolId, data, user, req = null) {
  const {
    student_id,
    academic_year_id,
    category_id,
    policy_id,
    source_type = 'MANUAL',
    source_id,
    reason,
    internal_note,
    amount: manualAmount,
    send_notification = true,
  } = data;

  if (!student_id || !category_id || !reason) {
    throw httpError('student_id, category_id, and reason are required');
  }

  // 1. Verify student belongs to this school
  const [student] = await sql`
    SELECT s.id, p.display_name, s.admission_no
    FROM public.students s
    JOIN public.persons p ON s.person_id = p.id
    WHERE s.id = ${student_id} AND s.school_id = ${Number(schoolId)} AND s.deleted_at IS NULL
  `;
  if (!student) {
    throw httpError('Student not found in this school', 404);
  }

  // 2. Resolve Category & Policy
  const [category] = await sql`
    SELECT * FROM public.fine_categories WHERE id = ${category_id} AND school_id = ${Number(schoolId)} AND active = TRUE
  `;
  if (!category) {
    const error = new Error('Active fine category not found');
    error.status = 404;
    throw error;
  }

  let policy = null;
  if (policy_id) {
    [policy] = await sql`
      SELECT * FROM public.fine_policies WHERE id = ${policy_id} AND school_id = ${Number(schoolId)} AND active = TRUE
    `;
  }

  // 3. Calculate Fine Amount
  let finalAmount = 0;
  let calcDetails = null;

  if (policy) {
    const calc = calculateFineAmount(policy, { variable_amount: manualAmount });
    finalAmount = calc.amount;
    calcDetails = calc.details;
  } else {
    finalAmount = Number(manualAmount || 0);
    calcDetails = { calculation_type: 'MANUAL', rate: finalAmount, formula: `Manual entry: ₹${finalAmount}` };
  }

  if (finalAmount <= 0) {
    throw httpError('Fine amount must be greater than 0');
  }

  if (!data.confirm_duplicate) {
    const duplicates = await findDuplicateManualFines(schoolId, {
      student_id,
      category_id,
      source_id,
      amount: finalAmount,
    });
    if (duplicates.length > 0) {
      const error = httpError(
        'A similar fine already exists for this student today. Confirm to create another.',
        409
      );
      error.code = 'DUPLICATE_FINE';
      error.details = { existing: duplicates };
      throw error;
    }
  }

  // 4. Determine status: Check if approval required by policy or threshold
  const requiresApproval = Boolean(
    policy?.approval_required ||
    (policy?.approval_threshold_amount && finalAmount > Number(policy.approval_threshold_amount))
  );

  const initialStatus = requiresApproval ? FINE_STATUSES.PENDING_APPROVAL : FINE_STATUSES.POSTED;

  // 5. Generate fine number and insert fine in transaction
  const fine = await sql.begin(async (tx) => {
    const [noRow] = await tx`SELECT public.get_next_fine_no(${Number(schoolId)}) as fine_no`;
    const fineNo = noRow.fine_no;

    const [inserted] = await tx`
      INSERT INTO public.fines (
        fine_no, school_id, student_id, academic_year_id, category_id, policy_id,
        source_type, source_id, reason, internal_note, calculation_details,
        requested_amount, approved_amount, original_amount, adjustment_amount,
        waived_amount, paid_amount, outstanding_amount, status,
        requested_by, approved_by, created_by,
        requested_at, approved_at, posted_at
      ) VALUES (
        ${fineNo}, ${Number(schoolId)}, ${student_id}, ${academic_year_id || null}, ${category_id}, ${policy_id || null},
        ${source_type}, ${source_id || null}, ${reason.trim()}, ${internal_note || null}, ${sql.json(calcDetails)},
        ${finalAmount}, ${finalAmount}, ${finalAmount}, 0,
        0, 0, ${finalAmount}, ${initialStatus},
        ${user?.internal_id || null},
        ${requiresApproval ? null : user?.internal_id || null},
        ${user?.internal_id || null},
        ${requiresApproval ? sql`NOW()` : null},
        ${requiresApproval ? null : sql`NOW()`},
        ${requiresApproval ? null : sql`NOW()`}
      )
      RETURNING *
    `;

    await logFineEvent({
      schoolId,
      userId: user?.internal_id,
      action: requiresApproval ? 'FINE_REQUESTED' : 'FINE_CREATED_AND_POSTED',
      entityId: inserted.id,
      details: { fine_no: fineNo, student_id, amount: finalAmount, reason, initialStatus },
      req,
      trx: tx,
    });

    return inserted;
  });

  // 6. Notify parent/student if posted immediately
  if (initialStatus === FINE_STATUSES.POSTED && send_notification) {
    dispatchFineNotification({
      schoolId,
      studentId: student_id,
      event: 'FINE_CREATED',
      params: {
        message: `A fine of ₹${finalAmount.toLocaleString('en-IN')} for "${category.name}" (${reason}) has been issued.`,
        message_te: `"${category.name}" (${reason}) కోసం ₹${finalAmount.toLocaleString('en-IN')} జరిమానా విధించబడింది.`,
      },
    }).catch(() => {});
  }

  return fine;
}

/**
 * Submits a fine request (e.g. from Teacher or Staff).
 */
export async function requestFine(schoolId, data, user, req = null) {
  const {
    student_id,
    academic_year_id,
    category_id,
    policy_id,
    reason,
    internal_note,
    amount,
    attachments = [],
  } = data;

  if (!student_id || !category_id || !reason || !amount) {
    throw httpError('student_id, category_id, reason, and amount are required');
  }

  const parsedAmount = Number(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    throw httpError('Amount must be greater than 0');
  }

  const [student] = await sql`
    SELECT s.id FROM public.students s
    WHERE s.id = ${student_id} AND s.school_id = ${Number(schoolId)} AND s.deleted_at IS NULL
  `;
  if (!student) {
    throw httpError('Student not found in this school', 404);
  }

  const [category] = await sql`
    SELECT id FROM public.fine_categories
    WHERE id = ${category_id} AND school_id = ${Number(schoolId)} AND active = TRUE
  `;
  if (!category) {
    throw httpError('Active fine category not found', 404);
  }

  const fine = await sql.begin(async (tx) => {
    const [noRow] = await tx`SELECT public.get_next_fine_no(${Number(schoolId)}) as fine_no`;
    const fineNo = noRow.fine_no;

    const [inserted] = await tx`
      INSERT INTO public.fines (
        fine_no, school_id, student_id, academic_year_id, category_id, policy_id,
        source_type, source_id, reason, internal_note, calculation_details,
        requested_amount, approved_amount, original_amount, adjustment_amount,
        waived_amount, paid_amount, outstanding_amount, status,
        requested_by, created_by, requested_at
      ) VALUES (
        ${fineNo}, ${Number(schoolId)}, ${student_id}, ${academic_year_id || null}, ${category_id}, ${policy_id || null},
        'MANUAL', null, ${reason.trim()}, ${internal_note || null}, ${sql.json({ requested_amount: parsedAmount })},
        ${parsedAmount}, ${parsedAmount}, ${parsedAmount}, 0,
        0, 0, ${parsedAmount}, ${FINE_STATUSES.PENDING_APPROVAL},
        ${user?.internal_id || null}, ${user?.internal_id || null}, NOW()
      )
      RETURNING *
    `;

    // Save attachments
    if (Array.isArray(attachments) && attachments.length > 0) {
      for (const att of attachments) {
        if (att.file_url) {
          await tx`
            INSERT INTO public.fine_attachments (
              school_id, fine_id, file_name, file_url, file_type, file_size, uploaded_by
            ) VALUES (
              ${Number(schoolId)}, ${inserted.id}, ${att.file_name || 'Evidence'},
              ${att.file_url}, ${att.file_type || null}, ${att.file_size || null},
              ${user?.internal_id || null}
            )
          `;
        }
      }
    }

    await logFineEvent({
      schoolId,
      userId: user?.internal_id,
      action: 'TEACHER_FINE_REQUEST_SUBMITTED',
      entityId: inserted.id,
      details: { fine_no: fineNo, student_id, requested_amount: parsedAmount, reason },
      req,
      trx: tx,
    });

    return inserted;
  });

  return fine;
}

/**
 * Approves a fine request (with optional modified amount).
 */
export async function approveFineRequest(schoolId, fineId, options = {}, user, req = null) {
  const { approved_amount, modified_amount, review_note, remarks } = options;
  const approvedAmount = approved_amount ?? modified_amount;
  const reviewNote = review_note || remarks;

  const result = await sql.begin(async (tx) => {
    const [fine] = await tx`
      SELECT * FROM public.fines
      WHERE id = ${fineId} AND school_id = ${Number(schoolId)}
      FOR UPDATE
    `;
    if (!fine) {
      const error = new Error('Fine not found');
      error.status = 404;
      throw error;
    }

    assertCanTransition(fine.status, FINE_STATUSES.APPROVED);

    const effectiveAmount = approvedAmount != null ? Number(approvedAmount) : Number(fine.requested_amount);
    if (isNaN(effectiveAmount) || effectiveAmount <= 0) {
      const error = new Error('Approved amount must be greater than 0');
      error.status = 400;
      throw error;
    }

    const [updated] = await tx`
      UPDATE public.fines
      SET
        approved_amount = ${effectiveAmount},
        original_amount = ${effectiveAmount},
        outstanding_amount = ${effectiveAmount},
        status = ${FINE_STATUSES.POSTED},
        approved_by = ${user?.internal_id || null},
        approved_at = NOW(),
        posted_at = NOW(),
        internal_note = CASE
          WHEN ${reviewNote ? String(reviewNote) : null} IS NOT NULL
          THEN COALESCE(internal_note || E'\n[Approval Note]: ', '') || ${reviewNote}
          ELSE internal_note
        END,
        updated_at = NOW()
      WHERE id = ${fineId} AND school_id = ${Number(schoolId)}
      RETURNING *
    `;

    await logFineEvent({
      schoolId,
      userId: user?.internal_id,
      action: 'FINE_APPROVED_AND_POSTED',
      entityId: fineId,
      details: {
        fine_no: fine.fine_no,
        requested_amount: fine.requested_amount,
        approved_amount: effectiveAmount,
        review_note: reviewNote,
      },
      req,
      trx: tx,
    });

    return updated;
  });

  // Notify student/parent of approved fine
  dispatchFineNotification({
    schoolId,
    studentId: result.student_id,
    event: 'FINE_APPROVED',
    params: {
      message: `Fine ${result.fine_no} for ₹${Number(result.approved_amount).toLocaleString('en-IN')} has been approved and added to your account.`,
      message_te: `₹${Number(result.approved_amount).toLocaleString('en-IN')} మొత్తం గల జరిమానా ${result.fine_no} ఆమోదించబడింది.`,
    },
  }).catch(() => {});

  return result;
}

/**
 * Rejects a fine request.
 */
export async function rejectFineRequest(schoolId, fineId, options = {}, user, req = null) {
  const { rejection_reason } = options;

  const result = await sql.begin(async (tx) => {
    const [fine] = await tx`
      SELECT * FROM public.fines
      WHERE id = ${fineId} AND school_id = ${Number(schoolId)}
      FOR UPDATE
    `;
    if (!fine) {
      const error = new Error('Fine not found');
      error.status = 404;
      throw error;
    }

    assertCanTransition(fine.status, FINE_STATUSES.REJECTED);

    const [updated] = await tx`
      UPDATE public.fines
      SET
        status = ${FINE_STATUSES.REJECTED},
        cancellation_reason = ${rejection_reason || 'Rejected by approver'},
        cancelled_by = ${user?.internal_id || null},
        cancelled_at = NOW(),
        updated_at = NOW()
      WHERE id = ${fineId} AND school_id = ${Number(schoolId)}
      RETURNING *
    `;

    await logFineEvent({
      schoolId,
      userId: user?.internal_id,
      action: 'FINE_REQUEST_REJECTED',
      entityId: fineId,
      details: { fine_no: fine.fine_no, rejection_reason },
      req,
      trx: tx,
    });

    return updated;
  });

  return result;
}

/**
 * Applies a full or partial waiver to an active fine.
 */
export async function waiveFine(schoolId, fineId, options, user, req = null) {
  const { amount, reason, notes } = options;
  if (!amount || !reason) {
    const error = new Error('Waiver amount and reason are required');
    error.status = 400;
    throw error;
  }

  const waiveAmount = Number(amount);
  if (isNaN(waiveAmount) || waiveAmount <= 0) {
    const error = new Error('Waiver amount must be greater than 0');
    error.status = 400;
    throw error;
  }

  const result = await sql.begin(async (tx) => {
    const [fine] = await tx`
      SELECT * FROM public.fines
      WHERE id = ${fineId} AND school_id = ${Number(schoolId)}
      FOR UPDATE
    `;
    if (!fine) {
      const error = new Error('Fine not found');
      error.status = 404;
      throw error;
    }

    if (!['POSTED', 'PARTIALLY_PAID', 'PARTIALLY_WAIVED', 'DISPUTED'].includes(fine.status)) {
      const error = new Error(`Cannot waive fine in '${fine.status}' status`);
      error.status = 400;
      throw error;
    }

    const currentRemaining = Number(fine.outstanding_amount);
    if (waiveAmount > currentRemaining + 0.01) {
      const error = new Error(`Waiver amount (₹${waiveAmount}) exceeds remaining balance of ₹${currentRemaining}`);
      error.status = 422;
      throw error;
    }

    // Generate receipt number using existing adjustment counter
    const [adjReceipt] = await tx`
      SELECT public.get_next_adj_receipt_no(${Number(schoolId)}) as receipt_no
    `;

    // Record waiver record
    const [waiver] = await tx`
      INSERT INTO public.fine_waivers (
        school_id, fine_id, student_id, amount, reason, notes, receipt_no, waived_by
      ) VALUES (
        ${Number(schoolId)}, ${fineId}, ${fine.student_id}, ${waiveAmount},
        ${reason}, ${notes || null}, ${adjReceipt.receipt_no}, ${user.internal_id}
      )
      RETURNING *
    `;

    const newWaivedTotal = Number(fine.waived_amount) + waiveAmount;
    const newOutstanding = Math.max(0, currentRemaining - waiveAmount);
    const newStatus = determineStatusAfterWaiver(newOutstanding);

    // Update fine
    const [updatedFine] = await tx`
      UPDATE public.fines
      SET
        waived_amount = ${newWaivedTotal},
        outstanding_amount = ${newOutstanding},
        status = ${newStatus},
        updated_at = NOW()
      WHERE id = ${fineId} AND school_id = ${Number(schoolId)}
      RETURNING *
    `;

    // If fine had an active dispute, automatically mark accepted & resolved
    await tx`
      UPDATE public.fine_disputes
      SET
        status = 'RESOLVED_ACCEPTED',
        resolution_action = 'WAIVED',
        resolution_note = ${'Resolved via waiver: ' + reason},
        reviewed_by = ${user.internal_id},
        resolved_at = NOW()
      WHERE fine_id = ${fineId} AND status IN ('OPEN', 'UNDER_REVIEW')
    `;

    await logFineEvent({
      schoolId,
      userId: user.internal_id,
      action: 'FINE_WAIVED',
      entityId: fineId,
      details: {
        fine_no: fine.fine_no,
        waive_amount: waiveAmount,
        receipt_no: adjReceipt.receipt_no,
        reason,
        remaining_balance: newOutstanding,
      },
      req,
      trx: tx,
    });

    return { fine: updatedFine, waiver };
  });

  // Notify student/parent of waiver
  dispatchFineNotification({
    schoolId,
    studentId: result.fine.student_id,
    event: 'FINE_WAIVED',
    params: {
      message: `Fine waiver of ₹${waiveAmount.toLocaleString('en-IN')} approved for ${result.fine.fine_no}.`,
      message_te: `జరిమానా ${result.fine.fine_no} పై ₹${waiveAmount.toLocaleString('en-IN')} మాఫీ ఆమోదించబడింది.`,
    },
  }).catch(() => {});

  return result;
}

/**
 * Cancels an invalid or mistakenly issued fine.
 */
export async function cancelFine(schoolId, fineId, options, user, req = null) {
  const reason = options?.reason || options?.cancellation_reason;
  if (!reason) {
    throw httpError('Cancellation reason is required');
  }

  const result = await sql.begin(async (tx) => {
    const [fine] = await tx`
      SELECT * FROM public.fines
      WHERE id = ${fineId} AND school_id = ${Number(schoolId)}
      FOR UPDATE
    `;
    if (!fine) {
      const error = new Error('Fine not found');
      error.status = 404;
      throw error;
    }

    if (Number(fine.paid_amount) > 0) {
      const error = new Error('Cannot cancel fine with recorded payments. Process a refund instead.');
      error.status = 400;
      throw error;
    }

    assertCanTransition(fine.status, FINE_STATUSES.CANCELLED);

    const [updated] = await tx`
      UPDATE public.fines
      SET
        status = ${FINE_STATUSES.CANCELLED},
        outstanding_amount = 0,
        cancellation_reason = ${reason.trim()},
        cancelled_by = ${user.internal_id},
        cancelled_at = NOW(),
        updated_at = NOW()
      WHERE id = ${fineId} AND school_id = ${Number(schoolId)}
      RETURNING *
    `;

    // Resolve any open disputes
    await tx`
      UPDATE public.fine_disputes
      SET
        status = 'RESOLVED_ACCEPTED',
        resolution_action = 'CANCELLED',
        resolution_note = ${'Fine cancelled: ' + reason},
        reviewed_by = ${user.internal_id},
        resolved_at = NOW()
      WHERE fine_id = ${fineId} AND status IN ('OPEN', 'UNDER_REVIEW')
    `;

    await logFineEvent({
      schoolId,
      userId: user.internal_id,
      action: 'FINE_CANCELLED',
      entityId: fineId,
      details: { fine_no: fine.fine_no, cancellation_reason: reason },
      req,
      trx: tx,
    });

    return updated;
  });

  dispatchFineNotification({
    schoolId,
    studentId: result.student_id,
    event: 'FINE_CANCELLED',
    params: {
      message: `Fine ${result.fine_no} has been cancelled (${reason}).`,
      message_te: `జరిమానా ${result.fine_no} రద్దు చేయబడింది (${reason}).`,
    },
  }).catch(() => {});

  return result;
}

/**
 * Records a payment against a fine, generating a unified receipt.
 */
export async function recordFinePayment(schoolId, fineId, options, user, req = null) {
  const {
    amount,
    payment_method,
    transaction_ref = randomUUID(),
    remarks,
    existing_receipt = null,
  } = options;

  if (!amount || !payment_method) {
    const error = new Error('amount and payment_method are required');
    error.status = 400;
    throw error;
  }

  const payAmount = Number(amount);
  if (isNaN(payAmount) || payAmount <= 0) {
    const error = new Error('Payment amount must be greater than 0');
    error.status = 400;
    throw error;
  }

  const result = await sql.begin(async (tx) => {
    const [fine] = await tx`
      SELECT f.*, fc.name as category_name
      FROM public.fines f
      JOIN public.fine_categories fc ON f.category_id = fc.id
      WHERE f.id = ${fineId} AND f.school_id = ${Number(schoolId)}
      FOR UPDATE OF f
    `;
    if (!fine) {
      const error = new Error('Fine not found');
      error.status = 404;
      throw error;
    }

    if (!['POSTED', 'PARTIALLY_PAID', 'PARTIALLY_WAIVED', 'DISPUTED'].includes(fine.status)) {
      const error = new Error(`Cannot pay fine in '${fine.status}' status`);
      error.status = 400;
      throw error;
    }

    const currentOutstanding = Number(fine.outstanding_amount);
    if (payAmount > currentOutstanding + 0.01) {
      const error = new Error(`Payment amount (₹${payAmount}) exceeds outstanding balance of ₹${currentOutstanding}`);
      error.status = 400;
      throw error;
    }

    // 1. Use existing combined receipt or generate a standalone one
    let receipt = existing_receipt;
    let receiptNo = existing_receipt?.receipt_no;
    if (!receipt) {
      const [receiptRow] = await tx`
        SELECT public.get_next_receipt_no(${Number(schoolId)}) as receipt_no
      `;
      receiptNo = receiptRow.receipt_no;
      [receipt] = await tx`
        INSERT INTO public.receipts (
          school_id, receipt_no, student_id, total_amount, issued_at, issued_by, remarks, fee_type
        ) VALUES (
          ${Number(schoolId)}, ${receiptNo}, ${fine.student_id}, ${payAmount},
          NOW(), ${user?.internal_id || null}, ${remarks || `Payment for fine ${fine.fine_no} (${fine.category_name})`},
          'fine'
        )
        RETURNING *
      `;
    } else {
      await tx`
        UPDATE public.receipts
        SET total_amount = total_amount + ${payAmount},
            remarks = COALESCE(remarks, '') || ${` | Fine ${fine.fine_no}`}
        WHERE id = ${receipt.id} AND school_id = ${Number(schoolId)}
      `;
    }

    // 3. Insert fine_payment
    const [payment] = await tx`
      INSERT INTO public.fine_payments (
        school_id, fine_id, receipt_id, amount, payment_method,
        transaction_ref, receipt_no, received_by, remarks, paid_at
      ) VALUES (
        ${Number(schoolId)}, ${fineId}, ${receipt.id}, ${payAmount}, ${payment_method},
        ${transaction_ref}, ${receiptNo}, ${user?.internal_id || null}, ${remarks || null}, NOW()
      )
      RETURNING *
    `;

    // 4. Update fine amounts and status
    const newPaidTotal = Number(fine.paid_amount) + payAmount;
    const newOutstanding = Math.max(0, currentOutstanding - payAmount);
    const newStatus = determineStatusAfterPayment(newOutstanding);

    const [updatedFine] = await tx`
      UPDATE public.fines
      SET
        paid_amount = ${newPaidTotal},
        outstanding_amount = ${newOutstanding},
        status = ${newStatus},
        paid_at = CASE WHEN ${newOutstanding === 0} THEN NOW() ELSE paid_at END,
        updated_at = NOW()
      WHERE id = ${fineId} AND school_id = ${Number(schoolId)}
      RETURNING *
    `;

    await logFineEvent({
      schoolId,
      userId: user?.internal_id,
      action: 'FINE_PAYMENT_COLLECTED',
      entityId: fineId,
      details: {
        fine_no: fine.fine_no,
        paid_amount: payAmount,
        receipt_no: receiptNo,
        payment_method,
        transaction_ref,
        remaining_balance: newOutstanding,
      },
      req,
      trx: tx,
    });

    return { fine: updatedFine, receipt, payment, receipt_no: receiptNo };
  });

  // Notify student/parent of payment
  dispatchFineNotification({
    schoolId,
    studentId: result.fine.student_id,
    event: 'FINE_PAID',
    params: {
      message: `Payment of ₹${payAmount.toLocaleString('en-IN')} received for fine ${result.fine.fine_no}. Receipt: ${result.receipt.receipt_no}`,
      message_te: `జరిమానా ${result.fine.fine_no} కోసం ₹${payAmount.toLocaleString('en-IN')} చెల్లింపు అందింది. రసీదు: ${result.receipt.receipt_no}`,
    },
  }).catch(() => {});

  return result;
}

// ============== 4. PARENT FINE DISPUTES / REVIEWS ==============

export async function submitFineDispute(schoolId, fineId, studentId, data, user, req = null) {
  const reason_type = data.reason_type || data.reason || 'Other';
  const message = data.message || data.reason;
  if (!reason_type || !message) {
    throw httpError('reason_type and message are required');
  }

  const dispute = await sql.begin(async (tx) => {
    const [fine] = await tx`
      SELECT * FROM public.fines
      WHERE id = ${fineId} AND school_id = ${Number(schoolId)}
      FOR UPDATE
    `;
    if (!fine) {
      const error = new Error('Fine not found');
      error.status = 404;
      throw error;
    }

    if (studentId && fine.student_id !== studentId) {
      const error = new Error('Unauthorized to dispute this fine');
      error.status = 403;
      throw error;
    }

    // Check existing open dispute
    const [existing] = await tx`
      SELECT id FROM public.fine_disputes
      WHERE fine_id = ${fineId} AND status IN ('OPEN', 'UNDER_REVIEW')
    `;
    if (existing) {
      const error = new Error('An active review request is already under evaluation for this fine');
      error.status = 409;
      throw error;
    }

    // Set fine status to DISPUTED
    await tx`
      UPDATE public.fines
      SET status = ${FINE_STATUSES.DISPUTED}, updated_at = NOW()
      WHERE id = ${fineId}
    `;

    const [inserted] = await tx`
      INSERT INTO public.fine_disputes (
        school_id, fine_id, student_id, reason_type, message, status, submitted_by
      ) VALUES (
        ${Number(schoolId)}, ${fineId}, ${fine.student_id}, ${reason_type}, ${message.trim()},
        'OPEN', ${user.internal_id}
      )
      RETURNING *
    `;

    await logFineEvent({
      schoolId,
      userId: user.internal_id,
      action: 'FINE_DISPUTE_SUBMITTED',
      entityId: fineId,
      details: { dispute_id: inserted.id, reason_type, message },
      req,
      trx: tx,
    });

    return inserted;
  });

  return dispute;
}

export async function resolveFineDispute(schoolId, disputeId, data, user, req = null) {
  const mappedAction = {
    WAIVED: 'WAIVED',
    CANCELLED: 'CANCELLED',
    DISMISSED: 'DISMISSED',
    RESOLVE_WAIVED: 'WAIVED',
    RESOLVE_REDUCED: 'WAIVED',
    RESOLVE_UPHELD: 'DISMISSED',
    REJECT: 'DISMISSED',
  };
  const resolution_action = mappedAction[data.resolution_action || data.action];
  const resolution_note = data.resolution_note || data.admin_response;
  const waiver_amount = data.waiver_amount ?? data.reduction_amount;
  const waiver_reason = data.waiver_reason;
  if (!resolution_action) {
    throw httpError('resolution_action must be one of: WAIVED, CANCELLED, DISMISSED');
  }

  const [dispute] = await sql`
    SELECT * FROM public.fine_disputes
    WHERE id = ${disputeId} AND school_id = ${Number(schoolId)}
  `;
  if (!dispute) {
    const error = new Error('Dispute not found');
    error.status = 404;
    throw error;
  }

  if (['RESOLVED_ACCEPTED', 'RESOLVED_REJECTED'].includes(dispute.status)) {
    const error = new Error('Dispute is already resolved');
    error.status = 400;
    throw error;
  }

  let resolutionResult;
  if (resolution_action === 'WAIVED') {
    resolutionResult = await waiveFine(
      schoolId,
      dispute.fine_id,
      {
        amount: waiver_amount,
        reason: waiver_reason || 'Dispute Review Approval',
        notes: resolution_note,
      },
      user,
      req
    );
  } else if (resolution_action === 'CANCELLED') {
    resolutionResult = await cancelFine(
      schoolId,
      dispute.fine_id,
      { reason: resolution_note || 'Dispute Accepted - Fine Invalidated' },
      user,
      req
    );
  } else {
    // DISMISSED: Restore fine status to previous post/payment status
    await sql.begin(async (tx) => {
      const [fine] = await tx`SELECT * FROM public.fines WHERE id = ${dispute.fine_id} FOR UPDATE`;
      const restoredStatus = Number(fine.paid_amount) > 0
        ? (Number(fine.outstanding_amount) === 0 ? FINE_STATUSES.PAID : FINE_STATUSES.PARTIALLY_PAID)
        : FINE_STATUSES.POSTED;

      await tx`
        UPDATE public.fines
        SET status = ${restoredStatus}, updated_at = NOW()
        WHERE id = ${dispute.fine_id}
      `;

      await tx`
        UPDATE public.fine_disputes
        SET
          status = 'RESOLVED_REJECTED',
          resolution_action = 'DISMISSED',
          resolution_note = ${resolution_note || 'Dispute dismissed after administrative review'},
          reviewed_by = ${user.internal_id},
          resolved_at = NOW()
        WHERE id = ${disputeId}
      `;

      await logFineEvent({
        schoolId,
        userId: user.internal_id,
        action: 'FINE_DISPUTE_DISMISSED',
        entityId: dispute.fine_id,
        details: { dispute_id: disputeId, resolution_note },
        req,
        trx: tx,
      });
    });
  }

  dispatchFineNotification({
    schoolId,
    studentId: dispute.student_id,
    event: 'FINE_DISPUTE_UPDATED',
    params: {
      message: `Your fine review request has been resolved: ${resolution_action}. Note: ${resolution_note || 'Reviewed by school management'}`,
      message_te: `మీ జరిమానా సమీక్ష అభ్యర్థన పరిష్కరించబడింది: ${resolution_action}.`,
    },
  }).catch(() => {});

  return { dispute_id: disputeId, status: resolution_action };
}

// ============== 5. QUERIES, DETAILS, STATS & REPORTS ==============

export async function getFineDetails(schoolId, fineId) {
  const [fine] = await sql`
    SELECT
      f.*,
      fc.name as category_name,
      fc.code as category_code,
      fp.name as policy_name,
      fp.calculation_type as policy_calculation_type,
      s.admission_no,
      p.display_name as student_name,
      p.photo_url as student_photo_url,
      req_p.display_name as requested_by_name,
      app_p.display_name as approved_by_name,
      can_p.display_name as cancelled_by_name,
      enroll.class_name,
      enroll.section_name
    FROM public.fines f
    JOIN public.fine_categories fc ON f.category_id = fc.id
    LEFT JOIN public.fine_policies fp ON f.policy_id = fp.id
    JOIN public.students s ON f.student_id = s.id
    JOIN public.persons p ON s.person_id = p.id
    LEFT JOIN public.users req_u ON f.requested_by = req_u.id
    LEFT JOIN public.persons req_p ON req_u.person_id = req_p.id
    LEFT JOIN public.users app_u ON f.approved_by = app_u.id
    LEFT JOIN public.persons app_p ON app_u.person_id = app_p.id
    LEFT JOIN public.users can_u ON f.cancelled_by = can_u.id
    LEFT JOIN public.persons can_p ON can_u.person_id = can_p.id
    LEFT JOIN LATERAL (
      SELECT cl.name as class_name, sc.name as section_name
      FROM public.student_enrollments se
      JOIN public.class_sections cs ON se.class_section_id = cs.id
      JOIN public.classes cl ON cs.class_id = cl.id
      JOIN public.sections sc ON cs.section_id = sc.id
      WHERE se.student_id = f.student_id AND se.status = 'active'
      ORDER BY se.created_at DESC
      LIMIT 1
    ) enroll ON true
    WHERE f.id = ${fineId} AND f.school_id = ${Number(schoolId)}
  `;

  if (!fine) {
    const error = new Error('Fine not found');
    error.status = 404;
    throw error;
  }

  const [payments, waivers, disputes, attachments, auditLogs] = await Promise.all([
    sql`
      SELECT fp.*, u.person_id, p.display_name as received_by_name
      FROM public.fine_payments fp
      LEFT JOIN public.users u ON fp.received_by = u.id
      LEFT JOIN public.persons p ON u.person_id = p.id
      WHERE fp.fine_id = ${fineId}
      ORDER BY fp.paid_at DESC
    `,
    sql`
      SELECT fw.*, p.display_name as waived_by_name
      FROM public.fine_waivers fw
      JOIN public.users u ON fw.waived_by = u.id
      JOIN public.persons p ON u.person_id = p.id
      WHERE fw.fine_id = ${fineId}
      ORDER BY fw.created_at DESC
    `,
    sql`
      SELECT fd.*, sub_p.display_name as submitted_by_name, rev_p.display_name as reviewed_by_name
      FROM public.fine_disputes fd
      JOIN public.users sub_u ON fd.submitted_by = sub_u.id
      JOIN public.persons sub_p ON sub_u.person_id = sub_p.id
      LEFT JOIN public.users rev_u ON fd.reviewed_by = rev_u.id
      LEFT JOIN public.persons rev_p ON rev_u.person_id = rev_p.id
      WHERE fd.fine_id = ${fineId}
      ORDER BY fd.created_at DESC
    `,
    sql`
      SELECT * FROM public.fine_attachments
      WHERE fine_id = ${fineId}
      ORDER BY created_at DESC
    `,
    sql`
      SELECT al.*, p.display_name as user_name
      FROM public.audit_logs al
      LEFT JOIN public.users u ON al.user_id = u.id
      LEFT JOIN public.persons p ON u.person_id = p.id
      WHERE al.school_id = ${Number(schoolId)} AND al.entity = 'fine' AND al.entity_id = ${fineId}
      ORDER BY al.created_at DESC
      LIMIT 50
    `,
  ]);

  return {
    ...fine,
    payments,
    waivers,
    disputes,
    attachments,
    audit_logs: auditLogs,
  };
}

export async function listFines(schoolId, options = {}) {
  const {
    student_id,
    category_id,
    status,
    statuses,
    class_id,
    academic_year_id,
    requested_by,
    search,
    from_date,
    to_date,
    page = 1,
    limit = 50,
    sort_by = 'created_at',
    sort_order = 'DESC',
  } = options;

  const safeLimit = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 50));
  const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
  const offset = (pageNum - 1) * safeLimit;

  const statusList = Array.isArray(statuses) && statuses.length > 0
    ? statuses
    : (status ? [status] : null);

  const searchTerm = search ? `%${String(search).trim()}%` : null;

  const [countResult, rows] = await Promise.all([
    sql`
      SELECT COUNT(*)::int as total
      FROM public.fines f
      JOIN public.students s ON f.student_id = s.id
      JOIN public.persons p ON s.person_id = p.id
      JOIN public.fine_categories fc ON f.category_id = fc.id
      LEFT JOIN LATERAL (
        SELECT cs.class_id
        FROM public.student_enrollments se
        JOIN public.class_sections cs ON se.class_section_id = cs.id
        WHERE se.student_id = f.student_id AND se.status = 'active'
        ORDER BY se.created_at DESC
        LIMIT 1
      ) enroll ON true
      WHERE f.school_id = ${Number(schoolId)}
        ${student_id ? sql`AND f.student_id = ${student_id}` : sql``}
        ${category_id ? sql`AND f.category_id = ${category_id}` : sql``}
        ${statusList ? sql`AND f.status IN ${sql(statusList)}` : sql``}
        ${class_id ? sql`AND enroll.class_id = ${class_id}` : sql``}
        ${academic_year_id ? sql`AND f.academic_year_id = ${academic_year_id}` : sql``}
        ${requested_by ? sql`AND f.requested_by = ${requested_by}` : sql``}
        ${from_date ? sql`AND f.created_at >= ${from_date}` : sql``}
        ${to_date ? sql`AND f.created_at <= ${to_date}` : sql``}
        ${searchTerm ? sql`AND (
          f.fine_no ILIKE ${searchTerm} OR
          p.display_name ILIKE ${searchTerm} OR
          s.admission_no ILIKE ${searchTerm} OR
          f.reason ILIKE ${searchTerm}
        )` : sql``}
    `,
    sql`
      SELECT
        f.id,
        f.fine_no,
        f.student_id,
        f.category_id,
        fc.name as category_name,
        fc.code as category_code,
        f.requested_amount,
        f.approved_amount,
        f.original_amount,
        f.adjustment_amount,
        f.waived_amount,
        f.paid_amount,
        f.outstanding_amount,
        f.status,
        f.source_type,
        f.source_id,
        f.reason,
        f.created_at,
        f.posted_at,
        f.paid_at,
        s.admission_no,
        p.display_name as student_name,
        enroll.class_name,
        enroll.section_name,
        creator.display_name as created_by_name
      FROM public.fines f
      JOIN public.students s ON f.student_id = s.id
      JOIN public.persons p ON s.person_id = p.id
      JOIN public.fine_categories fc ON f.category_id = fc.id
      LEFT JOIN public.users cu ON f.created_by = cu.id
      LEFT JOIN public.persons creator ON cu.person_id = creator.id
      LEFT JOIN LATERAL (
        SELECT cs.class_id, cl.name as class_name, sc.name as section_name
        FROM public.student_enrollments se
        JOIN public.class_sections cs ON se.class_section_id = cs.id
        JOIN public.classes cl ON cs.class_id = cl.id
        JOIN public.sections sc ON cs.section_id = sc.id
        WHERE se.student_id = f.student_id AND se.status = 'active'
        ORDER BY se.created_at DESC
        LIMIT 1
      ) enroll ON true
      WHERE f.school_id = ${Number(schoolId)}
        ${student_id ? sql`AND f.student_id = ${student_id}` : sql``}
        ${category_id ? sql`AND f.category_id = ${category_id}` : sql``}
        ${statusList ? sql`AND f.status IN ${sql(statusList)}` : sql``}
        ${class_id ? sql`AND enroll.class_id = ${class_id}` : sql``}
        ${academic_year_id ? sql`AND f.academic_year_id = ${academic_year_id}` : sql``}
        ${requested_by ? sql`AND f.requested_by = ${requested_by}` : sql``}
        ${from_date ? sql`AND f.created_at >= ${from_date}` : sql``}
        ${to_date ? sql`AND f.created_at <= ${to_date}` : sql``}
        ${searchTerm ? sql`AND (
          f.fine_no ILIKE ${searchTerm} OR
          p.display_name ILIKE ${searchTerm} OR
          s.admission_no ILIKE ${searchTerm} OR
          f.reason ILIKE ${searchTerm}
        )` : sql``}
      ORDER BY
        ${sort_by === 'fine_no' ? sql`f.fine_no` : sql``}
        ${sort_by === 'amount' ? sql`f.original_amount` : sql``}
        ${sort_by === 'outstanding' ? sql`f.outstanding_amount` : sql``}
        ${sort_by === 'student' ? sql`p.display_name` : sql``}
        ${sort_by === 'created_at' || !['fine_no', 'amount', 'outstanding', 'student'].includes(sort_by) ? sql`f.created_at` : sql``}
        ${sort_order?.toUpperCase() === 'ASC' ? sql`ASC` : sql`DESC`}
      LIMIT ${safeLimit} OFFSET ${offset}
    `,
  ]);

  const total = countResult[0]?.total || 0;
  return {
    data: rows,
    meta: {
      total,
      page: pageNum,
      limit: safeLimit,
      total_pages: Math.ceil(total / safeLimit) || 1,
    },
  };
}

export async function getFineStats(schoolId, academicYearId = null) {
  const [row] = await sql`
    SELECT
      COALESCE(SUM(original_amount), 0)::numeric as total_generated,
      COALESCE(SUM(paid_amount), 0)::numeric as total_collected,
      COALESCE(SUM(outstanding_amount) FILTER (WHERE status IN ('POSTED', 'PARTIALLY_PAID', 'PARTIALLY_WAIVED', 'DISPUTED')), 0)::numeric as total_outstanding,
      COALESCE(SUM(waived_amount), 0)::numeric as total_waived,
      COALESCE(COUNT(*) FILTER (WHERE status = 'PENDING_APPROVAL'), 0)::int as pending_approvals_count,
      COALESCE(COUNT(*) FILTER (WHERE status = 'DISPUTED'), 0)::int as active_disputes_count,
      COALESCE(COUNT(*) FILTER (WHERE status = 'CANCELLED'), 0)::int as cancelled_count,
      COALESCE(COUNT(*), 0)::int as total_fines_count
    FROM public.fines
    WHERE school_id = ${Number(schoolId)}
      ${academicYearId ? sql`AND academic_year_id = ${academicYearId}` : sql``}
  `;

  return {
    total_generated: Number(row?.total_generated || 0),
    total_collected: Number(row?.total_collected || 0),
    total_outstanding: Number(row?.total_outstanding || 0),
    total_waived: Number(row?.total_waived || 0),
    pending_approvals_count: Number(row?.pending_approvals_count || 0),
    active_disputes_count: Number(row?.active_disputes_count || 0),
    cancelled_count: Number(row?.cancelled_count || 0),
    total_fines_count: Number(row?.total_fines_count || 0),
    collection_percentage: row?.total_generated > 0
      ? Number(((Number(row.total_collected) / Number(row.total_generated)) * 100).toFixed(1))
      : 0,
  };
}

export async function getAgingReport(schoolId) {
  const rows = await sql`
    SELECT
      f.id,
      f.fine_no,
      f.student_id,
      p.display_name as student_name,
      s.admission_no,
      fc.name as category_name,
      f.outstanding_amount,
      f.posted_at,
      CURRENT_DATE - f.posted_at::date as age_days,
      CASE
        WHEN CURRENT_DATE - f.posted_at::date <= 30 THEN '0_30'
        WHEN CURRENT_DATE - f.posted_at::date <= 60 THEN '31_60'
        WHEN CURRENT_DATE - f.posted_at::date <= 90 THEN '61_90'
        ELSE '90_plus'
      END as age_bucket
    FROM public.fines f
    JOIN public.students s ON f.student_id = s.id
    JOIN public.persons p ON s.person_id = p.id
    JOIN public.fine_categories fc ON f.category_id = fc.id
    WHERE f.school_id = ${Number(schoolId)}
      AND f.status IN ('POSTED', 'PARTIALLY_PAID', 'PARTIALLY_WAIVED', 'DISPUTED')
      AND f.outstanding_amount > 0
    ORDER BY f.posted_at ASC
  `;

  const buckets = {
    '0_30': { label: '0–30 Days', count: 0, total_amount: 0, items: [] },
    '31_60': { label: '31–60 Days', count: 0, total_amount: 0, items: [] },
    '61_90': { label: '61–90 Days', count: 0, total_amount: 0, items: [] },
    '90_plus': { label: '90+ Days', count: 0, total_amount: 0, items: [] },
  };

  for (const item of rows) {
    const b = buckets[item.age_bucket];
    if (b) {
      b.count += 1;
      b.total_amount += Number(item.outstanding_amount);
      b.items.push(item);
    }
  }

  return buckets;
}

export async function getCategorySummaryReport(schoolId) {
  return sql`
    SELECT
      fc.id as category_id,
      fc.name as category_name,
      fc.code as category_code,
      COUNT(f.id)::int as fines_count,
      COALESCE(SUM(f.original_amount), 0)::numeric as total_generated,
      COALESCE(SUM(f.paid_amount), 0)::numeric as total_collected,
      COALESCE(SUM(f.outstanding_amount) FILTER (WHERE f.status IN ('POSTED', 'PARTIALLY_PAID', 'PARTIALLY_WAIVED', 'DISPUTED')), 0)::numeric as total_outstanding,
      COALESCE(SUM(f.waived_amount), 0)::numeric as total_waived
    FROM public.fine_categories fc
    LEFT JOIN public.fines f ON fc.id = f.category_id AND f.school_id = ${Number(schoolId)}
    WHERE fc.school_id = ${Number(schoolId)}
    GROUP BY fc.id, fc.name, fc.code
    ORDER BY total_generated DESC
  `;
}

export async function exportFinesToXlsx(schoolId, options = {}) {
  const result = await listFines(schoolId, { ...options, limit: 10000 });
  const rows = result.data.map((f, i) => ({
    '#': i + 1,
    'Fine No': f.fine_no,
    'Student Name': f.student_name,
    'Admission No': f.admission_no,
    'Class / Section': [f.class_name, f.section_name].filter(Boolean).join(' - ') || '—',
    'Category': f.category_name,
    'Original Amount (₹)': Number(f.original_amount),
    'Paid (₹)': Number(f.paid_amount),
    'Waived (₹)': Number(f.waived_amount),
    'Outstanding (₹)': Number(f.outstanding_amount),
    'Status': f.status,
    'Reason': f.reason,
    'Created Date': f.created_at ? new Date(f.created_at).toLocaleDateString('en-IN') : '—',
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Fines & Penalties');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export async function findDuplicateManualFines(schoolId, { student_id, category_id, source_id, amount }) {
  return sql`
    SELECT id, fine_no, original_amount, status, created_at
    FROM public.fines
    WHERE school_id = ${Number(schoolId)}
      AND student_id = ${student_id}
      AND category_id = ${category_id}
      AND status NOT IN ('CANCELLED', 'REJECTED')
      AND created_at::date = CURRENT_DATE
      AND original_amount = ${Number(amount)}
      ${source_id ? sql`AND source_id = ${source_id}` : sql``}
    ORDER BY created_at DESC
    LIMIT 5
  `;
}

export async function listStudentFinesForLedger(schoolId, studentId) {
  const rows = await sql`
    SELECT
      f.id, f.fine_no, f.original_amount, f.paid_amount, f.waived_amount,
      f.outstanding_amount, f.status, f.reason, f.calculation_details,
      f.source_type, f.source_id, f.created_at, f.posted_at,
      fc.name as category_name, fc.code as category_code
    FROM public.fines f
    JOIN public.fine_categories fc ON f.category_id = fc.id
    WHERE f.student_id = ${studentId}
      AND f.school_id = ${Number(schoolId)}
      AND f.status IN ('POSTED', 'PARTIALLY_PAID', 'PARTIALLY_WAIVED', 'DISPUTED')
    ORDER BY f.created_at DESC
  `;
  const fineBalance = rows.reduce((acc, r) => acc + Number(r.outstanding_amount || 0), 0);
  const fineTotal = rows.reduce((acc, r) => acc + Number(r.original_amount || 0) + Number(r.adjustment_amount || 0), 0);
  const finePaid = rows.reduce((acc, r) => acc + Number(r.paid_amount || 0), 0);
  return {
    fines: rows,
    fine_due: {
      total_fines: fineTotal,
      balance_due: fineBalance,
      paid_amount: finePaid,
      count: rows.length,
    },
  };
}

export async function getStudentFinesGrouped(schoolId, studentId) {
  const rows = await sql`
    SELECT
      f.*,
      fc.name as category_name,
      fc.code as category_code,
      fp.name as policy_name
    FROM public.fines f
    JOIN public.fine_categories fc ON f.category_id = fc.id
    LEFT JOIN public.fine_policies fp ON f.policy_id = fp.id
    WHERE f.school_id = ${Number(schoolId)} AND f.student_id = ${studentId}
    ORDER BY f.created_at DESC
  `;
  const activeStatuses = ['PENDING_APPROVAL', 'POSTED', 'PARTIALLY_PAID', 'PARTIALLY_WAIVED', 'DISPUTED'];
  return {
    active: rows.filter((r) => activeStatuses.includes(r.status) && Number(r.outstanding_amount) > 0),
    history: rows.filter((r) => !activeStatuses.includes(r.status) || Number(r.outstanding_amount) <= 0),
  };
}

export async function listFineWaivers(schoolId, options = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(String(options.limit), 10) || 50));
  const pageNum = Math.max(1, parseInt(String(options.page), 10) || 1);
  const offset = (pageNum - 1) * safeLimit;
  const [countResult, rows] = await Promise.all([
    sql`SELECT COUNT(*)::int as total FROM public.fine_waivers WHERE school_id = ${Number(schoolId)}`,
    sql`
      SELECT
        fw.*,
        f.fine_no,
        p.display_name as student_name,
        s.admission_no as student_admission_no,
        fc.name as category_name,
        wp.display_name as approved_by_name
      FROM public.fine_waivers fw
      JOIN public.fines f ON fw.fine_id = f.id
      JOIN public.students s ON fw.student_id = s.id
      JOIN public.persons p ON s.person_id = p.id
      JOIN public.fine_categories fc ON f.category_id = fc.id
      JOIN public.users u ON fw.waived_by = u.id
      JOIN public.persons wp ON u.person_id = wp.id
      WHERE fw.school_id = ${Number(schoolId)}
      ORDER BY fw.created_at DESC
      LIMIT ${safeLimit} OFFSET ${offset}
    `,
  ]);
  const total = countResult[0]?.total || 0;
  return {
    data: rows,
    meta: { total, page: pageNum, limit: safeLimit, total_pages: Math.ceil(total / safeLimit) || 1 },
  };
}

export async function listFineDisputes(schoolId, options = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(String(options.limit), 10) || 50));
  const pageNum = Math.max(1, parseInt(String(options.page), 10) || 1);
  const offset = (pageNum - 1) * safeLimit;
  const status = options.status;
  const [countResult, rows] = await Promise.all([
    sql`
      SELECT COUNT(*)::int as total FROM public.fine_disputes
      WHERE school_id = ${Number(schoolId)}
        ${status ? sql`AND status = ${status}` : sql``}
    `,
    sql`
      SELECT
        fd.*,
        fd.reason_type as reason,
        f.fine_no,
        f.outstanding_amount,
        p.display_name as student_name,
        s.admission_no as student_admission_no,
        fc.name as category_name,
        sub_p.display_name as parent_name
      FROM public.fine_disputes fd
      JOIN public.fines f ON fd.fine_id = f.id
      JOIN public.students s ON fd.student_id = s.id
      JOIN public.persons p ON s.person_id = p.id
      JOIN public.fine_categories fc ON f.category_id = fc.id
      JOIN public.users sub_u ON fd.submitted_by = sub_u.id
      JOIN public.persons sub_p ON sub_u.person_id = sub_p.id
      WHERE fd.school_id = ${Number(schoolId)}
        ${status ? sql`AND fd.status = ${status}` : sql``}
      ORDER BY fd.created_at DESC
      LIMIT ${safeLimit} OFFSET ${offset}
    `,
  ]);
  const total = countResult[0]?.total || 0;
  return {
    data: rows,
    meta: { total, page: pageNum, limit: safeLimit, total_pages: Math.ceil(total / safeLimit) || 1 },
  };
}

export async function requestFineClarification(schoolId, fineId, { message }, user, req = null) {
  if (!message) throw httpError('Clarification message is required');
  const [fine] = await sql`
    SELECT * FROM public.fines WHERE id = ${fineId} AND school_id = ${Number(schoolId)}
  `;
  if (!fine) throw httpError('Fine not found', 404);
  if (fine.status !== FINE_STATUSES.PENDING_APPROVAL) {
    throw httpError('Clarification can only be requested on pending approvals');
  }
  const [updated] = await sql`
    UPDATE public.fines
    SET
      internal_note = COALESCE(internal_note || E'\n', '') || ${`[Clarification requested]: ${message}`},
      updated_at = NOW()
    WHERE id = ${fineId} AND school_id = ${Number(schoolId)}
    RETURNING *
  `;
  await logFineEvent({
    schoolId,
    userId: user?.internal_id,
    action: 'FINE_CLARIFICATION_REQUESTED',
    entityId: fineId,
    details: { message },
    req,
  });
  return updated;
}

export async function allocateFinePaymentsToReceipt({
  schoolId,
  fineItems,
  payment_method,
  transaction_ref,
  remarks,
  user,
  req,
  receipt,
}) {
  if (!Array.isArray(fineItems) || fineItems.length === 0) return [];
  const posted = [];
  for (const item of fineItems) {
    const result = await recordFinePayment(
      schoolId,
      item.fine_id,
      {
        amount: item.amount,
        payment_method,
        transaction_ref: `${transaction_ref}-fine-${item.fine_id}`,
        remarks,
        existing_receipt: receipt,
      },
      user,
      req
    );
    posted.push(result);
  }
  return posted;
}

/**
 * Dispatches async in-app & push notification to student and parents.
 */
async function dispatchFineNotification({ schoolId, studentId, event, params }) {
  try {
    const recipients = await sql`
      SELECT u.id as user_id FROM public.users u
      JOIN public.students s ON u.person_id = s.person_id
      WHERE s.id = ${studentId} AND s.school_id = ${Number(schoolId)} AND u.account_status = 'active'
      UNION
      SELECT u.id as user_id FROM public.users u
      JOIN public.parents p ON u.person_id = p.person_id AND p.school_id = ${Number(schoolId)}
      JOIN public.student_parents sp ON p.id = sp.parent_id AND sp.school_id = ${Number(schoolId)}
      WHERE sp.student_id = ${studentId} AND u.account_status = 'active'
    `;

    if (recipients.length > 0) {
      await sendNotificationToUsers(
        recipients.map((r) => r.user_id),
        event,
        params
      );
    }
  } catch (error) {
    logger.warn({ error: error.message, studentId, event }, 'Failed to dispatch fine notification');
  }
}
