import sql from '../db.js';
import logger from '../utils/logger.js';
import { RULE_KEYS } from './automationRuleService.js';
import { scanAndProcessAttendanceRiskForSchool } from './attendanceRiskService.js';

export const ATTENDANCE_RISK_JOB_NAME = 'attendance-risk-scan';

/**
 * Scan all active schools where attendance risk automation is enabled.
 */
export async function runNightlyAttendanceRiskScan() {
  const activeSchools = await sql`
    SELECT s.id
    FROM schools s
    JOIN school_automation_rules r ON s.id = r.school_id
    WHERE s.is_active = true
      AND r.rule_key = ${RULE_KEYS.ATTENDANCE_RISK_ALERTS}
      AND r.is_enabled = true
  `;

  logger.info({ count: activeSchools.length }, 'Starting attendance risk scan across schools');
  const results = [];

  for (const school of activeSchools) {
    try {
      const res = await scanAndProcessAttendanceRiskForSchool(school.id);
      results.push(res);
    } catch (err) {
      logger.error({ err: err.message, schoolId: school.id }, 'Error running attendance risk scan for school');
      results.push({ schoolId: school.id, error: err.message });
    }
  }

  return results;
}
