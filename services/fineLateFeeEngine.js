import sql from '../db.js';
import logger from '../utils/logger.js';
import { calculateFineAmount, formatYmdInTimezone, calculateDaysBetween } from './finePolicyEngine.js';
import { FINE_STATUSES } from './fineStateMachine.js';
import { logFineEvent } from './fineAuditService.js';
import { sendNotificationToUsers } from './notificationService.js';

export const LATE_FEE_SCAN_JOB = 'fine-nightly-late-fee-scan';

/**
 * Scans overdue invoices for a single school and applies automatic late fees idempotently.
 */
export async function scanAndApplyLateFeesForSchool(schoolId, options = {}) {
  const { asOfDate = null, timezone = 'Asia/Kolkata', dryRun = false } = options;
  const todayYmd = asOfDate || formatYmdInTimezone(new Date(), timezone);

  // 1. Fetch active auto-apply policies for this school
  const policies = await sql`
    SELECT fp.*, fc.name as category_name
    FROM public.fine_policies fp
    JOIN public.fine_categories fc ON fp.category_id = fc.id
    WHERE fp.school_id = ${Number(schoolId)}
      AND fp.active = TRUE
      AND fp.auto_apply = TRUE
      AND fp.applicable_module IN ('FEE_INVOICE', 'GENERAL')
  `;

  if (policies.length === 0) {
    return { schoolId, scanned: 0, applied: 0, updated: 0, warnings: 0 };
  }

  const defaultPolicy = policies[0]; // Primary late fee policy
  const graceDays = Number(defaultPolicy.grace_days || 0);

  // 2. Fetch unpaid/partially paid student fees with a passed due date
  const overdueFees = await sql`
    SELECT
      sf.id,
      sf.student_id,
      sf.amount_due,
      sf.amount_paid,
      sf.discount,
      sf.due_date,
      ft.name as fee_type_name
    FROM public.student_fees sf
    JOIN public.fee_structures fs ON sf.fee_structure_id = fs.id
    JOIN public.fee_types ft ON fs.fee_type_id = ft.id
    WHERE sf.school_id = ${Number(schoolId)}
      AND sf.deleted_at IS NULL
      AND (sf.amount_due - COALESCE(sf.discount, 0) - COALESCE(sf.amount_paid, 0)) > 0
      AND sf.due_date IS NOT NULL
      AND sf.due_date <= ${todayYmd}::date
    ORDER BY sf.due_date ASC
  `;

  let appliedCount = 0;
  let updatedCount = 0;
  let warningCount = 0;

  for (const fee of overdueFees) {
    const dueYmd = String(fee.due_date).slice(0, 10);
    const elapsedDays = calculateDaysBetween(dueYmd, todayYmd);
    const idempotencyKey = `auto_late_fee_${schoolId}_${defaultPolicy.id}_${fee.id}`;

    // A. Check if within grace period -> send warning if not already sent today
    if (elapsedDays <= graceDays) {
      const remainingGrace = graceDays - elapsedDays;
      if (!dryRun && elapsedDays > 0) {
        const [insertedWarning] = await sql`
          INSERT INTO public.fine_warning_events (
            school_id, student_id, student_fee_id, policy_id, warning_date
          ) VALUES (
            ${Number(schoolId)}, ${fee.student_id}, ${fee.id}, ${defaultPolicy.id}, ${todayYmd}::date
          )
          ON CONFLICT (school_id, student_fee_id, warning_date) DO NOTHING
          RETURNING id
        `;
        if (insertedWarning) {
          warningCount++;
          dispatchWarningNotification({
            schoolId,
            studentId: fee.student_id,
            feeTypeName: fee.fee_type_name,
            remainingGrace,
            perDayAmount: defaultPolicy.per_day_amount,
          }).catch(() => {});
        }
      }
      continue;
    }

    // B. Past grace period -> calculate fine
    const calc = calculateFineAmount(defaultPolicy, {
      due_date: dueYmd,
      as_of_date: todayYmd,
      timezone,
    });

    const calculatedAmount = calc.amount;
    if (calculatedAmount <= 0) continue;

    if (dryRun) {
      appliedCount++;
      continue;
    }

    await sql.begin(async (tx) => {
      const [existingFine] = await tx`
        SELECT * FROM public.fines
        WHERE school_id = ${Number(schoolId)} AND idempotency_key = ${idempotencyKey}
        FOR UPDATE
      `;

      if (existingFine) {
        if (['PAID', 'WAIVED', 'CANCELLED', 'REJECTED'].includes(existingFine.status)) {
          return;
        }

        const currentPosted = Number(existingFine.original_amount) + Number(existingFine.adjustment_amount || 0);
        if (calculatedAmount > currentPosted) {
          const delta = Number((calculatedAmount - currentPosted).toFixed(2));
          const newOutstanding = Math.max(0, Number(existingFine.outstanding_amount) + delta);
          const newAdjustment = Number(existingFine.adjustment_amount || 0) + delta;

          await tx`
            INSERT INTO public.fine_adjustments (school_id, fine_id, amount, reason)
            VALUES (
              ${Number(schoolId)}, ${existingFine.id}, ${delta},
              ${`Automatic late fee increment to ₹${calculatedAmount}`}
            )
          `;

          await tx`
            UPDATE public.fines
            SET
              adjustment_amount = ${newAdjustment},
              outstanding_amount = ${newOutstanding},
              calculation_details = ${sql.json(calc.details)},
              updated_at = NOW()
            WHERE id = ${existingFine.id}
          `;

          await logFineEvent({
            schoolId,
            action: 'AUTO_LATE_FEE_INCREMENTED',
            entityId: existingFine.id,
            details: {
              previous_amount: currentPosted,
              new_amount: calculatedAmount,
              delta,
              fineable_days: calc.details.fineable_days,
            },
            trx: tx,
          });

          updatedCount++;
        }
        return;
      }

      const reason = `Late fee for overdue ${fee.fee_type_name} (${calc.details.fineable_days} days past ${graceDays}-day grace period)`;
      const [noRow] = await tx`SELECT public.get_next_fine_no(${Number(schoolId)}) as fine_no`;
      const fineNo = noRow.fine_no;

      const [inserted] = await tx`
        INSERT INTO public.fines (
          fine_no, school_id, student_id, category_id, policy_id,
          source_type, source_id, idempotency_key, reason, calculation_details,
          requested_amount, approved_amount, original_amount, adjustment_amount,
          waived_amount, paid_amount, outstanding_amount, status,
          approved_at, posted_at
        ) VALUES (
          ${fineNo}, ${Number(schoolId)}, ${fee.student_id}, ${defaultPolicy.category_id}, ${defaultPolicy.id},
          'FEE_INVOICE', ${String(fee.id)}, ${idempotencyKey}, ${reason}, ${sql.json(calc.details)},
          ${calculatedAmount}, ${calculatedAmount}, ${calculatedAmount}, 0,
          0, 0, ${calculatedAmount}, ${FINE_STATUSES.POSTED},
          NOW(), NOW()
        )
        RETURNING *
      `;

      await logFineEvent({
        schoolId,
        action: 'AUTO_LATE_FEE_POSTED',
        entityId: inserted.id,
        details: {
          fine_no: fineNo,
          student_id: fee.student_id,
          student_fee_id: fee.id,
          amount: calculatedAmount,
          calc_details: calc.details,
        },
        trx: tx,
      });

      appliedCount++;
    });
  }

  return {
    schoolId,
    scanned: overdueFees.length,
    applied: appliedCount,
    updated: updatedCount,
    warnings: warningCount,
  };
}

/**
 * Nightly worker scheduled across all active schools.
 */
export async function runNightlyFineLateFeeScan() {
  const schools = await sql`SELECT id FROM public.schools WHERE is_active = TRUE ORDER BY id`;
  let totalApplied = 0;
  let totalUpdated = 0;

  for (const school of schools) {
    try {
      const result = await scanAndApplyLateFeesForSchool(school.id);
      totalApplied += result.applied;
      totalUpdated += result.updated;
    } catch (error) {
      logger.error({ error: error.message, schoolId: school.id }, 'Late fee scan failed for school');
    }
  }

  logger.info({ totalApplied, totalUpdated }, 'Completed nightly fine late fee scan');
  return { totalApplied, totalUpdated };
}

/**
 * Sends advance warning before late fees begin.
 */
async function dispatchWarningNotification({ schoolId, studentId, feeTypeName, remainingGrace, perDayAmount }) {
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
      const msg = `Reminder: Fee payment for ${feeTypeName} is overdue. Late charges of ₹${perDayAmount}/day begin in ${remainingGrace} day${remainingGrace === 1 ? '' : 's'}. Pay promptly to avoid penalties.`;
      const msgTe = `గుర్తుచేపు: ${feeTypeName} గడువు ముగిసింది. ఇంకా ${remainingGrace} రోజుల్లో రోజుకు ₹${perDayAmount} చొప్పున ఆలస్య రుసుము ప్రారంభమవుతుంది.`;
      await sendNotificationToUsers(
        recipients.map((r) => r.user_id),
        'FINE_WARNING',
        { message: msg, message_te: msgTe }
      );
    }
  } catch (err) {
    logger.warn({ error: err.message, studentId }, 'Failed to dispatch late fee warning');
  }
}
