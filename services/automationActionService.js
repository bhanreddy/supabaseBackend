import sql from '../db.js';
import logger from '../utils/logger.js';
import { sendNotificationToUsersWithReport } from './notificationService.js';
import { getSchoolAutomationRule, RULE_KEYS } from './automationRuleService.js';
import { isFeatureEnabled } from '../utils/featureRegistry.js';
import { recoveryFees, feeCalendarDate, feeToday, determineReminderStage, assertFiniteRecoveryAmounts } from './feeRecoveryScope.js';

export function generateFeeReminderIdempotencyKey({ schoolId, studentFeeId, stage, dueDate }) {
  return `fee_reminder:${schoolId}:${studentFeeId}:${stage}:${feeCalendarDate(dueDate) || 'none'}`;
}
export function generateManualReminderIdempotencyKey({ schoolId, studentId, timestampStr }) {
  return `manual_fee_reminder:${schoolId}:${studentId}:${timestampStr || feeToday()}`;
}
export async function resolveStudentRecipientUserIds(studentIds, schoolId, db = sql) {
  if (!studentIds?.length) return [];
  const rows = await db`
    SELECT DISTINCT u.id AS user_id FROM users u
    JOIN persons p ON p.id = u.person_id AND p.school_id = ${schoolId} AND p.deleted_at IS NULL
    WHERE u.school_id = ${schoolId} AND u.account_status = 'active' AND u.deleted_at IS NULL
      AND (
        EXISTS (SELECT 1 FROM students s WHERE s.person_id = u.person_id
          AND s.school_id = ${schoolId} AND s.id = ANY(${studentIds}) AND s.deleted_at IS NULL AND s.status_id = 1)
        OR EXISTS (SELECT 1 FROM parents pr
          JOIN student_parents sp ON sp.parent_id = pr.id AND sp.school_id = ${schoolId}
          JOIN students s ON s.id = sp.student_id AND s.school_id = ${schoolId} AND s.deleted_at IS NULL AND s.status_id = 1
          WHERE pr.person_id = u.person_id AND pr.school_id = ${schoolId} AND pr.deleted_at IS NULL
            AND sp.deleted_at IS NULL AND sp.student_id = ANY(${studentIds})
            AND (sp.valid_from IS NULL OR sp.valid_from <= ${feeToday()}::date)
            AND (sp.valid_to IS NULL OR sp.valid_to >= ${feeToday()}::date))
      )
  `;
  return rows.map(r => r.user_id);
}

export async function isFeeRecoveryAvailable(schoolId) {
  const [school] = await sql`SELECT is_active FROM schools WHERE id = ${schoolId}`;
  return school?.is_active === true && await isFeatureEnabled(schoolId, 'nav.fees');
}
const skip = reason => ({ success: false, skipped: true, reason });

/**
 * Durable at-most-once delivery attempt. The claim commits BEFORE any external
 * side effect. A crash during delivery remains processing/failed and is never
 * automatically resent: FCM has no transactional idempotency contract.
 * Only failures known to precede the sender call can reclaim the same key.
 */
export async function dispatchFeeReminder({ schoolId, studentId, studentFeeId = null,
  stage = 'manual', customMessage = null, actorId = null }) {
  if (!schoolId || !studentId) return skip('INVALID_CONTEXT');
  if (!await isFeeRecoveryAvailable(schoolId)) return skip('FEATURE_DISABLED');
  const rule = await getSchoolAutomationRule(schoolId, RULE_KEYS.FEE_DUE_REMINDER);
  const scheduled = stage !== 'manual';
  if (scheduled && !rule.is_enabled) return skip('RULE_DISABLED');
  const { query: fees } = await recoveryFees(schoolId);
  const current = await sql`SELECT * FROM (${fees}) f WHERE f.student_id = ${studentId}
    AND f.balance_due > 0 ${studentFeeId ? sql`AND f.id = ${studentFeeId}` : sql``}`;
  if (!current.length) return skip('NO_DUES');
  for (const row of current) assertFiniteRecoveryAmounts(row.amount_due, row.amount_paid, row.discount, row.balance_due);
  if (scheduled && (!studentFeeId || determineReminderStage(current[0].due_date, rule.trigger_config) !== stage)) return skip('STAGE_CHANGED');
  const key = scheduled
    ? generateFeeReminderIdempotencyKey({ schoolId, studentFeeId, stage, dueDate: current[0].due_date })
    : generateManualReminderIdempotencyKey({ schoolId, studentId });

  const claim = await sql.begin(async tx => {
    // Transaction-pooler safe and shared by every instance, fee and manual path.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`fee-reminder:${schoolId}:${studentId}`}, 0))`;
    const [duplicate] = await tx`SELECT * FROM automation_execution_logs
      WHERE school_id = ${schoolId} AND idempotency_key = ${key} FOR UPDATE`;
    if (duplicate && !(duplicate.status === 'failed' && duplicate.metadata?.deliveryStarted === false && duplicate.attempt < 3)) return null;
    const [recent] = await tx`SELECT id FROM automation_execution_logs
      WHERE school_id = ${schoolId} AND student_id = ${studentId} AND rule_key = 'fee_due_reminder'
        AND idempotency_key <> ${key}
        AND (status IN ('processing', 'completed') OR (status = 'failed' AND metadata->>'deliveryStarted' IS DISTINCT FROM 'false') OR (status = 'skipped' AND metadata->>'deliveryStarted' = 'true'))
        AND created_at > now() - make_interval(days => ${rule.trigger_config.cooldown_days}) LIMIT 1`;
    if (recent) return null;
    const [row] = duplicate
      ? await tx`UPDATE automation_execution_logs SET status = 'processing', attempt = attempt + 1, error_summary = NULL
          WHERE id = ${duplicate.id} AND school_id = ${schoolId} RETURNING id`
      : await tx`INSERT INTO automation_execution_logs
          (school_id, rule_key, entity_type, entity_id, student_id, idempotency_key, status, stage, payload)
          VALUES (${schoolId}, 'fee_due_reminder', ${studentFeeId ? 'student_fee' : 'student'},
            ${studentFeeId || studentId}, ${studentId}, ${key}, 'processing', ${stage},
            ${tx.json({ studentId, studentFeeId })}) RETURNING id`;
    return row;
  });
  if (!claim) return skip('IDEMPOTENCY_OR_COOLDOWN');

  let deliveryStarted = false;
  try {
    return await sql.begin(async tx => {
      // Payment, refund, concession, withdrawal, rule and school changes serialize
      // with this final eligibility check. No scanned financial value is trusted.
      await tx`SELECT id FROM schools WHERE id = ${schoolId} FOR SHARE`;
      await tx`SELECT id FROM school_automation_rules WHERE school_id = ${schoolId} AND rule_key = 'fee_due_reminder' FOR SHARE`;
      await tx`SELECT school_id FROM school_feature_flags WHERE school_id = ${schoolId} AND role = 'student' AND feature_key = 'nav.fees' FOR SHARE`;
      await tx`SELECT id FROM students WHERE id = ${studentId} AND school_id = ${schoolId} FOR SHARE`;
      await tx`SELECT fs.id FROM fee_structures fs JOIN student_fees sf ON sf.fee_structure_id = fs.id
        WHERE sf.student_id = ${studentId} AND sf.school_id = ${schoolId} AND fs.school_id = ${schoolId} FOR SHARE OF fs`;
      await tx`SELECT id FROM student_fees WHERE student_id = ${studentId} AND school_id = ${schoolId} ORDER BY id FOR UPDATE`;
      const available = await isFeeRecoveryAvailable(schoolId);
      const latestRule = await getSchoolAutomationRule(schoolId, RULE_KEYS.FEE_DUE_REMINDER);
      const { query: latestFees } = await recoveryFees(schoolId);
      const rows = await tx`SELECT * FROM (${latestFees}) f WHERE student_id = ${studentId} AND balance_due > 0
        ${studentFeeId ? sql`AND id = ${studentFeeId}` : sql``}`;
      for (const row of rows) assertFiniteRecoveryAmounts(row.amount_due, row.amount_paid, row.discount, row.balance_due);
      let reason = !available ? 'FEATURE_DISABLED' : scheduled && !latestRule.is_enabled ? 'RULE_DISABLED' : !rows.length ? 'NO_DUES' : null;
      if (!reason && scheduled && determineReminderStage(rows[0].due_date, latestRule.trigger_config) !== stage) reason = 'STAGE_CHANGED';
      const recipients = reason ? [] : await resolveStudentRecipientUserIds([studentId], schoolId, tx);
      if (!reason && !recipients.length) reason = 'NO_RECIPIENTS';
      if (reason) {
        await tx`UPDATE automation_execution_logs SET status = 'skipped', executed_at = now(), error_summary = ${reason}
          WHERE id = ${claim.id} AND school_id = ${schoolId}`;
        return skip(reason);
      }
      const amount = rows.reduce((sum, row) => sum + Math.round(Number(row.balance_due) * 100), 0) / 100;
      const formatted = `₹${amount.toLocaleString('en-IN')}`;
      // Manual requests can contain future-due fees; never label those overdue.
      const message = `Fee balance for ${rows[0].student_name}: ${formatted}. Please check Fees for due dates and payment details.`;
      const messageTe = `${rows[0].student_name} కొరకు ఫీజు బకాయి: ${formatted}. గడువు తేదీలు, చెల్లింపు వివరాల కోసం ఫీజులు చూడండి.`;
      deliveryStarted = true;
      const report = await sendNotificationToUsersWithReport(recipients, 'FEE_REMINDER', {
        message: customMessage ? `${message} ${customMessage.trim()}` : message,
        message_te: customMessage ? `${messageTe} ${customMessage.trim()}` : messageTe,
      }, { schoolId, deepLink: '/Screen/fees', senderId: actorId });
      const status = report.successCount > 0 ? 'completed' : report.failureCount > 0 ? 'failed' : 'skipped';
      const metadata = { deliveryStarted: true, successCount: report.successCount, failureCount: report.failureCount,
        noTokenCount: report.noTokenCount || 0, delivery: status === 'completed' ? 'PROVIDER_ACCEPTED' : status === 'failed' ? 'PROVIDER_FAILED' : 'NO_PUSH_RECIPIENTS' };
      await tx`UPDATE automation_execution_logs SET status = ${status}, executed_at = now(),
        recipient_user_ids = ${tx.json(recipients)}, metadata = ${tx.json(metadata)},
        error_summary = ${status === 'completed' ? null : metadata.delivery}
        WHERE id = ${claim.id} AND school_id = ${schoolId}`;
      return { success: status === 'completed', skipped: status === 'skipped', reason: metadata.delivery,
        error: status === 'failed' ? metadata.delivery : undefined, deliveredCount: report.successCount, logId: claim.id };
    });
  } catch (error) {
    logger.error({ schoolId, studentId, code: error.code, deliveryStarted }, 'Fee reminder attempt failed');
    // If even this write fails, the committed processing claim still prevents resend.
    await sql`UPDATE automation_execution_logs SET status = 'failed', error_summary = ${deliveryStarted ? 'DELIVERY_OUTCOME_UNKNOWN' : 'PRE_DELIVERY_FAILURE'},
      metadata = ${sql.json({ deliveryStarted })}, executed_at = now() WHERE id = ${claim.id} AND school_id = ${schoolId}`;
    if (!deliveryStarted) throw error; // pg-boss may safely retry this claim, max 3 attempts.
    return { success: false, error: 'DELIVERY_OUTCOME_UNKNOWN', logId: claim.id };
  }
}
