import sql from '../db.js';
import logger from '../utils/logger.js';
import { getSchoolAutomationRule, recordRuleTriggered, RULE_KEYS } from './automationRuleService.js';
import { dispatchFeeReminder, isFeeRecoveryAvailable } from './automationActionService.js';
import { recoveryFees, feeToday, determineReminderStage } from './feeRecoveryScope.js';
export { determineReminderStage } from './feeRecoveryScope.js';
export const FEE_REMINDER_JOB_NAME = 'fee-recovery-scan';

export async function scanAndDispatchFeeRemindersForSchool(schoolId, { dryRun = false } = {}) {
  if (!await isFeeRecoveryAvailable(schoolId)) return { schoolId, skipped: true, reason: 'FEATURE_DISABLED' };
  const rule = await getSchoolAutomationRule(schoolId, RULE_KEYS.FEE_DUE_REMINDER);
  if (!rule.is_enabled) return { schoolId, skipped: true, reason: 'RULE_DISABLED' };
  const { query: fees } = await recoveryFees(schoolId);
  const days = [...new Set([-rule.trigger_config.days_before_due, 0, ...rule.trigger_config.overdue_stages])];
  const dueDates = days.map(day => new Date(Date.parse(feeToday()) - day * 86400000).toISOString().slice(0, 10));
  const result = { schoolId, scannedCount: 0, eligibleCount: 0, dispatchedCount: 0, skippedCount: 0, errorCount: 0 };
  let after = '00000000-0000-0000-0000-000000000000';
  while (true) {
    const rows = await sql`SELECT id, student_id, due_date FROM (${fees}) f
      WHERE balance_due > 0 AND due_date = ANY(${dueDates}::date[])
        AND id > ${after}::uuid ORDER BY id LIMIT 200`;
    if (!rows.length) break;
    result.scannedCount += rows.length;
    for (let offset = 0; offset < rows.length; offset += 3) {
      await Promise.all(rows.slice(offset, offset + 3).map(async row => {
        const stage = determineReminderStage(row.due_date, rule.trigger_config);
        if (!stage) return;
        result.eligibleCount++;
        if (dryRun) return;
        try {
          const sent = await dispatchFeeReminder({ schoolId, studentId: row.student_id, studentFeeId: row.id, stage });
          if (sent.success) result.dispatchedCount++;
          else if (sent.skipped) result.skippedCount++;
          else result.errorCount++;
        } catch (error) {
          result.errorCount++;
          logger.warn({ schoolId, code: error.code }, 'Fee candidate failed before delivery');
        }
      }));
    }
    after = rows.at(-1).id;
  }
  if (!dryRun) await recordRuleTriggered(schoolId, RULE_KEYS.FEE_DUE_REMINDER);
  return result;
}

export async function runNightlyFeeReminderScan() {
  let after = 0;
  let count = 0;
  let failures = 0;
  while (true) {
    const schools = await sql`SELECT s.id FROM schools s JOIN school_automation_rules r ON r.school_id = s.id
      WHERE s.is_active AND r.rule_key = ${RULE_KEYS.FEE_DUE_REMINDER} AND r.is_enabled
        AND s.id > ${after} ORDER BY s.id LIMIT 100`;
    if (!schools.length) break;
    for (const school of schools) {
      try {
        const result = await scanAndDispatchFeeRemindersForSchool(school.id);
        failures += result.errorCount || 0;
        count++;
      } catch (error) {
        failures++;
        logger.error({ schoolId: school.id, code: error.code }, 'Fee scan failed for school; continuing other schools');
      }
    }
    after = schools.at(-1).id;
  }
  // Durable pg-boss retries; committed claims make retries safe across schools.
  if (failures) throw new Error(`Fee scan encountered ${failures} failures; see execution history`);
  return { count };
}
