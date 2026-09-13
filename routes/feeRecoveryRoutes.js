import express from 'express';
import { requirePermission } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getFeeRecoveryOverview,
  getFeeDefaultersList,
  getFeeReminderHistory,
} from '../services/feeRecoveryService.js';
import {
  getSchoolAutomationRule,
  upsertSchoolAutomationRule,
  RULE_KEYS,
} from '../services/automationRuleService.js';
import { dispatchFeeReminder, isFeeRecoveryAvailable } from '../services/automationActionService.js';
import { scanAndDispatchFeeRemindersForSchool } from '../services/feeAutomationJobService.js';
import sql from '../db.js';
import { recoveryFees, assertFiniteRecoveryAmounts } from '../services/feeRecoveryScope.js';
import { z } from 'zod';

const router = express.Router();
router.use(requireRole('admin', 'accounts', 'principal', 'management'));
router.use(asyncHandler(async (req, res, next) => {
  if (!await isFeeRecoveryAvailable(req.schoolId)) return res.status(403).json({ code: 'FEATURE_DISABLED', feature: 'nav.fees' });
  next();
}));
router.use((req, res, next) => {
  const query = z.object({
    academic_year_id: z.string().uuid().optional(), student_id: z.string().uuid().optional(),
    class_id: z.string().uuid().optional(), section_id: z.string().uuid().optional(),
    ageing_stage: z.enum(['current','1-7 days','8-30 days','31-60 days','61-90 days','90+ days']).optional(),
    segmentation: z.enum(['new','repeat','persistent']).optional(), search: z.string().max(100).optional(),
    page: z.coerce.number().int().min(1).max(1000000).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
  }).safeParse(req.query);
  if (!query.success) return sendError(res, 400, 'Invalid recovery filters');
  next();
});
const reminderBody = z.object({
  student_ids: z.array(z.string().uuid()).min(1).max(100).transform(ids => [...new Set(ids)]),
  custom_message: z.string().trim().max(500).optional(),
  dry_run: z.boolean().default(false),
});

/**
 * GET /api/v1/fees/recovery/overview
 * Executive fee recovery KPIs: totals, collection efficiency, 6 ageing buckets, class breakdown.
 */
router.get(
  '/overview',
  requirePermission('fees.view'),
  asyncHandler(async (req, res) => {
    const { academic_year_id } = req.query;
    const overview = await getFeeRecoveryOverview(req.schoolId, { academicYearId: academic_year_id });
    return sendSuccess(res, req.schoolId, overview);
  })
);

/**
 * GET /api/v1/fees/recovery/defaulters
 * Paginated list of defaulters with segmentation badges, ageing stages, last payment, and reminder counts.
 */
router.get(
  '/defaulters',
  requirePermission('fees.view'),
  asyncHandler(async (req, res) => {
    const {
      class_id,
      section_id,
      ageing_stage,
      segmentation,
      search,
      min_paid_percent,
      max_paid_percent,
      page,
      limit,
    } = req.query;

    const result = await getFeeDefaultersList(req.schoolId, {
      classId: class_id,
      sectionId: section_id,
      ageingStage: ageing_stage,
      segmentation,
      search,
      minPaidPercent: min_paid_percent !== undefined && min_paid_percent !== '' ? Number(min_paid_percent) : null,
      maxPaidPercent: max_paid_percent !== undefined && max_paid_percent !== '' ? Number(max_paid_percent) : null,
      page,
      limit,
    });

    return sendSuccess(res, req.schoolId, result);
  })
);

/**
 * GET /api/v1/fees/recovery/rules
 * Fetch automated fee reminder rule settings for this school.
 */
router.get(
  '/rules',
  requirePermission('fees.manage'),
  asyncHandler(async (req, res) => {
    const rule = await getSchoolAutomationRule(req.schoolId, RULE_KEYS.FEE_DUE_REMINDER);
    return sendSuccess(res, req.schoolId, rule);
  })
);

/**
 * PUT /api/v1/fees/recovery/rules
 * Update automated fee reminder configuration (enable/disable, trigger stages, cooldown).
 */
router.put(
  '/rules',
  requirePermission('fees.manage'),
  asyncHandler(async (req, res) => {
    const { is_enabled, trigger_config, action_config } = req.body;
    const updated = await upsertSchoolAutomationRule(req.schoolId, RULE_KEYS.FEE_DUE_REMINDER, {
      is_enabled,
      trigger_config,
      action_config,
    }, req.user.internal_id || req.user.id);
    return sendSuccess(res, req.schoolId, updated);
  })
);

/**
 * POST /api/v1/fees/recovery/remind
 * Trigger manual or bulk fee reminder. Supports dry-run safety confirmation.
 */
router.post(
  '/remind',
  requirePermission('fees.manage'),
  asyncHandler(async (req, res) => {
    const parsed = reminderBody.safeParse(req.body);
    if (!parsed.success) return sendError(res, 400, 'Invalid reminder request: select 1–100 student UUIDs, a boolean dry_run and a message up to 500 characters');
    const { student_ids, custom_message: customMessage, dry_run } = parsed.data;
    const owned = await sql`SELECT id FROM students WHERE id = ANY(${student_ids}) AND school_id = ${req.schoolId} AND deleted_at IS NULL AND status_id = 1`;
    if (owned.length !== student_ids.length) return sendError(res, 404, 'Selected student not found');
    const { query: fees } = await recoveryFees(req.schoolId);

    // Calculate total outstanding for selected students
    const [stats] = await sql`
      SELECT
        COUNT(DISTINCT sf.student_id)::int AS count_with_dues,
        COALESCE(SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)), 0)::numeric AS total_outstanding
      FROM (${fees}) sf
      JOIN students s ON sf.student_id = s.id AND s.school_id = ${req.schoolId}
      WHERE sf.school_id = ${req.schoolId}
        AND sf.student_id IN ${sql(student_ids)}
        AND sf.deleted_at IS NULL
        AND (sf.amount_due - sf.discount - sf.amount_paid) > 0
    `;

    assertFiniteRecoveryAmounts(stats.total_outstanding);
    const totalOutstanding = Number(stats?.total_outstanding || 0);
    const countWithDues = Number(stats?.count_with_dues || 0);

    // Dry-run mode: returns preview without sending
    if (dry_run) {
      return sendSuccess(res, req.schoolId, {
        dry_run: true,
        selected_students_count: student_ids.length,
        eligible_students_count: countWithDues,
        total_outstanding: totalOutstanding,
        channel: 'push',
        sample_message: customMessage || `Outstanding fee reminder: ₹${totalOutstanding.toLocaleString('en-IN')} is due. Kindly clear the balance.`,
      });
    }

    // Actual execution: fetch student details and dispatch
    const studentsWithDues = await sql`
      SELECT
        s.id AS student_id,
        p.display_name AS student_name,
        SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0))::numeric AS balance_due,
        MIN(sf.due_date) AS oldest_due_date
      FROM (${fees}) sf
      JOIN students s ON sf.student_id = s.id AND s.school_id = ${req.schoolId}
      JOIN persons p ON s.person_id = p.id AND p.school_id = ${req.schoolId}
      WHERE sf.school_id = ${req.schoolId}
        AND sf.student_id IN ${sql(student_ids)}
        AND sf.deleted_at IS NULL
        AND (sf.amount_due - sf.discount - sf.amount_paid) > 0
      GROUP BY s.id, p.display_name
    `;

    await sql`INSERT INTO audit_logs (school_id, user_id, action, entity, entity_id, details)
      VALUES (${req.schoolId}, ${req.user.internal_id || req.user.id}, 'fee_recovery.reminders.requested', 'students', NULL,
      ${sql.json({ student_ids, eligible_count: studentsWithDues.length, channel: 'push' })})`;
    let dispatchedCount = 0;
    let skippedCount = 0;
    const skippedDetails = [];
    const errors = [];

    for (let offset = 0; offset < studentsWithDues.length; offset += 3) {
      await Promise.all(studentsWithDues.slice(offset, offset + 3).map(async student => {
      try {
        const result = await dispatchFeeReminder({
          schoolId: req.schoolId,
          studentId: student.student_id,
          studentName: student.student_name,
          amountDue: student.balance_due,
          dueDate: student.oldest_due_date,
          stage: 'manual',
          customMessage,
          actorId: req.user.internal_id || req.user.id,
        });

        if (result.success) {
          dispatchedCount++;
        } else if (result.skipped) {
          skippedCount++;
          skippedDetails.push({
            studentId: student.student_id,
            studentName: student.student_name,
            reason: result.reason || 'SKIPPED',
          });
        } else if (result.error) {
          errors.push({
            studentId: student.student_id,
            studentName: student.student_name,
            error: result.error,
          });
        }
      } catch (err) {
        errors.push({
          studentId: student.student_id,
          studentName: student.student_name,
          error: 'Reminder unavailable; check history before retrying',
        });
      }
      }));
    }

    return sendSuccess(res, req.schoolId, {
      requested_count: student_ids.length,
      eligible_count: studentsWithDues.length,
      dispatched_count: dispatchedCount,
      skipped_count: skippedCount,
      skipped_details: skippedDetails,
      error_count: errors.length,
      errors,
    });
  })
);

/**
 * GET /api/v1/fees/recovery/reminders/history
 * Chronological log of sent reminders.
 */
router.get(
  '/reminders/history',
  requirePermission('fees.view'),
  asyncHandler(async (req, res) => {
    const { student_id, page, limit } = req.query;
    const history = await getFeeReminderHistory(req.schoolId, {
      studentId: student_id,
      page,
      limit,
    });
    return sendSuccess(res, req.schoolId, history);
  })
);

/**
 * POST /api/v1/fees/recovery/scan
 * Trigger on-demand fee recovery scan.
 */
router.post(
  '/scan',
  requirePermission('fees.manage'),
  asyncHandler(async (req, res) => {
    if (req.body?.dry_run !== true || req.body?.force === true) {
      return sendError(res, 400, 'On-demand scans are preview-only. Confirm selected students using /remind.');
    }
    const result = await scanAndDispatchFeeRemindersForSchool(req.schoolId, { dryRun: true });
    return sendSuccess(res, req.schoolId, result);
  })
);

export default router;
