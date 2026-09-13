import sql from '../db.js';
import logger from '../utils/logger.js';
import { getSchoolAutomationRule, RULE_KEYS } from './automationRuleService.js';
import { resolveStudentRecipientUserIds } from './automationActionService.js';
import { sendNotificationToUsers } from './notificationService.js';
import { feeToday } from './feeRecoveryScope.js';

export const RISK_STATES = {
  HEALTHY: 'HEALTHY',
  APPROACHING_RISK: 'APPROACHING_RISK',
  BELOW_THRESHOLD: 'BELOW_THRESHOLD',
};

export const INTERVENTION_STATUSES = {
  NOT_REVIEWED: 'not_reviewed',
  PARENT_CONTACTED: 'parent_contacted',
  MONITORING: 'monitoring',
  RESOLVED: 'resolved',
};

/**
 * Authoritative attendance percentage formula:
 * (present + late + 0.5 * half_day) / total * 100
 */
export function calculateAttendancePercentage({ present = 0, late = 0, half_day = 0, total = 0 }) {
  if (!total || total <= 0) return 0;
  const weighted = Number(present || 0) + Number(late || 0) + (0.5 * Number(half_day || 0));
  return Math.round((weighted / Number(total)) * 1000) / 10;
}

/**
 * Pure risk tier classification.
 * Handles both function signature styles:
 * 1) (percentage, config)
 * 2) (percentage, totalSessions, triggerConfig)
 */
export function classifyAttendanceRisk(percentage, arg2 = {}, arg3 = {}) {
  let totalSessions = 100;
  let triggerConfig = {};

  if (typeof arg2 === 'number') {
    totalSessions = arg2;
    triggerConfig = arg3 || {};
  } else if (typeof arg2 === 'object') {
    triggerConfig = arg2 || {};
  }

  const minDays = triggerConfig.min_total_days ?? triggerConfig.min_days ?? 5;
  if (totalSessions < minDays || percentage == null) {
    return RISK_STATES.HEALTHY;
  }

  const warning = triggerConfig.warning_threshold_pct ?? triggerConfig.warning_threshold ?? 78;
  const critical = triggerConfig.critical_threshold_pct ?? triggerConfig.critical_threshold ?? 75;

  if (percentage < critical) {
    return RISK_STATES.BELOW_THRESHOLD;
  }
  if (percentage < warning) {
    return RISK_STATES.APPROACHING_RISK;
  }
  return RISK_STATES.HEALTHY;
}

/**
 * Evaluates whether an attendance risk alert should fire, enforcing hysteresis recovery and cooldown.
 */
export function shouldSendRiskAlert({
  currentTier,
  previousTier = 'HEALTHY',
  attendancePct,
  lastAlertAt = null,
  now = new Date(),
  config = {}
}) {
  const critical = config.critical_threshold_pct ?? config.critical_threshold ?? 75;
  const recoveryBuffer = config.recovery_buffer_pct ?? config.recovery_buffer ?? 3;
  const cooldownDays = config.cooldown_days ?? 7;

  // Hysteresis: if student was BELOW_THRESHOLD and current tier is HEALTHY,
  // require attendance to clear (critical + recoveryBuffer) before considering them HEALTHY.
  let effectiveTier = currentTier;
  if (previousTier === 'BELOW_THRESHOLD' && currentTier === 'HEALTHY' && attendancePct < (critical + recoveryBuffer)) {
    effectiveTier = 'APPROACHING_RISK';
  }

  if (effectiveTier === 'HEALTHY') {
    return { shouldAlert: false, reason: 'HEALTHY', effectiveTier };
  }

  if (lastAlertAt) {
    const elapsedDays = (new Date(now).getTime() - new Date(lastAlertAt).getTime()) / (1000 * 60 * 60 * 24);
    if (elapsedDays < cooldownDays && previousTier === effectiveTier) {
      return { shouldAlert: false, reason: 'COOLDOWN_ACTIVE', effectiveTier };
    }
  }

  const alertType = effectiveTier === 'BELOW_THRESHOLD' ? 'CRITICAL' : 'WARNING';
  return { shouldAlert: true, alertType, effectiveTier };
}

async function claimExecutionSlot({ schoolId, ruleKey, entityType, entityId, idempotencyKey, stage, payload }) {
  try {
    const [inserted] = await sql`
      INSERT INTO automation_execution_logs (
        school_id, rule_key, entity_type, entity_id, student_id,
        idempotency_key, status, stage, payload
      ) VALUES (
        ${schoolId}, ${ruleKey}, ${entityType}, ${entityId}, ${entityId},
        ${idempotencyKey}, 'processing', ${stage}, ${sql.json(payload)}
      )
      ON CONFLICT (school_id, idempotency_key) DO NOTHING
      RETURNING id
    `;
    if (!inserted) return { claimed: false, reason: 'ALREADY_CLAIMED' };
    return { claimed: true, logId: inserted.id };
  } catch (err) {
    logger.warn({ err: err.message, idempotencyKey }, 'Could not claim execution slot');
    return { claimed: false, reason: 'CLAIM_FAILED' };
  }
}

async function markExecutionCompleted(logId, { recipientUserIds = [], metadata = {} } = {}) {
  await sql`
    UPDATE automation_execution_logs
    SET status = 'completed', executed_at = now(),
        recipient_user_ids = ${sql.json(recipientUserIds)},
        metadata = ${sql.json(metadata)}, error_summary = NULL
    WHERE id = ${logId}
  `;
}

async function markExecutionFailed(logId, errorSummary) {
  await sql`
    UPDATE automation_execution_logs
    SET status = 'failed', executed_at = now(),
        error_summary = ${errorSummary}
    WHERE id = ${logId}
  `;
}

/**
 * Authoritative attendance calculation for a single student.
 */
export async function calculateStudentAttendance(schoolId, studentId, lookbackDays = 60) {
  const [row] = await sql`
    SELECT
      s.id AS student_id,
      p.display_name AS student_name,
      s.admission_no,
      c.id AS class_id,
      c.name AS class_name,
      sec.id AS section_id,
      sec.name AS section_name,
      COUNT(da.id)::int AS total_sessions,
      COUNT(da.id) FILTER (WHERE da.status = 'present')::int AS present_count,
      COUNT(da.id) FILTER (WHERE da.status = 'late')::int AS late_count,
      COUNT(da.id) FILTER (WHERE da.status = 'half_day')::int AS half_day_count,
      COUNT(da.id) FILTER (WHERE da.status = 'absent')::int AS absent_count,
      ROUND(
        (
          COUNT(da.id) FILTER (WHERE da.status IN ('present', 'late'))
          + 0.5 * COUNT(da.id) FILTER (WHERE da.status = 'half_day')
        )::numeric / NULLIF(COUNT(da.id), 0) * 100,
        1
      )::float AS attendance_percentage
    FROM students s
    JOIN persons p ON s.person_id = p.id
    JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active'
    JOIN class_sections cs ON se.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    LEFT JOIN daily_attendance da ON da.student_enrollment_id = se.id
      AND da.deleted_at IS NULL
      AND da.school_id = ${schoolId}
      AND da.attendance_date >= CURRENT_DATE - (${lookbackDays} * INTERVAL '1 day')
    WHERE s.school_id = ${schoolId}
      AND s.id = ${studentId}
      AND s.deleted_at IS NULL
    GROUP BY s.id, p.display_name, s.admission_no, c.id, c.name, sec.id, sec.name
  `;

  return row || null;
}

/**
 * Query active students with attendance percentage and intervention status for a school.
 */
export async function getAttendanceRiskInsights(schoolId, {
  classId = null,
  sectionId = null,
  riskState = null,
  interventionStatus = null,
  page = 1,
  limit = 1000,
  lookbackDays = 60,
} = {}) {
  const rule = await getSchoolAutomationRule(schoolId, RULE_KEYS.ATTENDANCE_RISK_ALERTS);
  const triggerConfig = rule.trigger_config;

  const rows = await sql`
    SELECT
      s.id AS student_id,
      s.id AS id,
      p.display_name AS student_name,
      s.admission_no,
      c.id AS class_id,
      c.name AS class_name,
      sec.id AS section_id,
      sec.name AS section_name,
      COUNT(da.id)::int AS total_sessions,
      COUNT(da.id) FILTER (WHERE da.status = 'present')::int AS present_count,
      COUNT(da.id) FILTER (WHERE da.status = 'late')::int AS late_count,
      COUNT(da.id) FILTER (WHERE da.status = 'half_day')::int AS half_day_count,
      COUNT(da.id) FILTER (WHERE da.status = 'absent')::int AS absent_count,
      ROUND(
        (
          COUNT(da.id) FILTER (WHERE da.status IN ('present', 'late'))
          + 0.5 * COUNT(da.id) FILTER (WHERE da.status = 'half_day')
        )::numeric / NULLIF(COUNT(da.id), 0) * 100,
        1
      )::float AS attendance_percentage,
      ai.status AS intervention_status,
      ai.notes AS intervention_notes,
      ai.updated_at AS intervention_updated_at
    FROM students s
    JOIN persons p ON s.person_id = p.id
    JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active'
    JOIN class_sections cs ON se.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    LEFT JOIN attendance_interventions ai ON ai.student_id = s.id AND ai.school_id = ${schoolId}
    LEFT JOIN daily_attendance da ON da.student_enrollment_id = se.id
      AND da.deleted_at IS NULL
      AND da.school_id = ${schoolId}
      AND da.attendance_date >= CURRENT_DATE - (${lookbackDays} * INTERVAL '1 day')
    WHERE s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
      ${classId ? sql`AND c.id = ${classId}` : sql``}
      ${sectionId ? sql`AND sec.id = ${sectionId}` : sql``}
    GROUP BY s.id, p.display_name, s.admission_no, c.id, c.name, sec.id, sec.name, ai.status, ai.notes, ai.updated_at
    ORDER BY c.name, sec.name, p.display_name
  `;

  // Attach calculated riskState (for insights reporting, evaluate any student with recorded attendance)
  const enriched = rows.map((r) => {
    const state = classifyAttendanceRisk(r.attendance_percentage, r.total_sessions, {
      ...triggerConfig,
      min_total_days: 1,
    });
    return {
      ...r,
      risk_state: state,
      intervention_status: r.intervention_status || INTERVENTION_STATUSES.NOT_REVIEWED,
    };
  });

  const counts = {
    total: enriched.length,
    healthy: enriched.filter((r) => r.risk_state === RISK_STATES.HEALTHY).length,
    approachingRisk: enriched.filter((r) => r.risk_state === RISK_STATES.APPROACHING_RISK).length,
    belowThreshold: enriched.filter((r) => r.risk_state === RISK_STATES.BELOW_THRESHOLD).length,
    notReviewed: enriched.filter((r) => r.intervention_status === INTERVENTION_STATUSES.NOT_REVIEWED && r.risk_state !== RISK_STATES.HEALTHY).length,
    resolved: enriched.filter((r) => r.intervention_status === INTERVENTION_STATUSES.RESOLVED).length,
  };

  // Case-insensitive & alias-friendly risk tier normalization
  let normalizedRisk = null;
  if (riskState && String(riskState).toUpperCase() !== 'ALL') {
    const raw = String(riskState).toUpperCase();
    if (raw === 'BELOW_THRESHOLD' || raw === 'CRITICAL') {
      normalizedRisk = RISK_STATES.BELOW_THRESHOLD;
    } else if (raw === 'APPROACHING_RISK' || raw === 'APPROACHING' || raw === 'WARNING') {
      normalizedRisk = RISK_STATES.APPROACHING_RISK;
    } else if (raw === 'HEALTHY') {
      normalizedRisk = RISK_STATES.HEALTHY;
    } else {
      normalizedRisk = raw;
    }
  }

  // Case-insensitive intervention status normalization
  let normalizedIntervention = null;
  if (interventionStatus && String(interventionStatus).toLowerCase() !== 'all') {
    normalizedIntervention = String(interventionStatus).toLowerCase();
  }

  let filtered = enriched;
  if (normalizedRisk) {
    filtered = filtered.filter((r) => String(r.risk_state).toUpperCase() === normalizedRisk);
  }
  if (normalizedIntervention) {
    if (normalizedIntervention === 'not_reviewed') {
      filtered = filtered.filter(
        (r) =>
          String(r.intervention_status).toLowerCase() === 'not_reviewed' &&
          r.risk_state !== RISK_STATES.HEALTHY
      );
    } else {
      filtered = filtered.filter((r) => String(r.intervention_status).toLowerCase() === normalizedIntervention);
    }
  }

  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 1000));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeLimit;
  const paginated = filtered.slice(offset, offset + safeLimit);

  return {
    summary: counts,
    students: paginated,
    pagination: {
      total: filtered.length,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(filtered.length / safeLimit),
    },
    thresholds: {
      warning: triggerConfig.warning_threshold ?? 78,
      critical: triggerConfig.critical_threshold ?? 75,
    },
  };
}

/**
 * Update attendance intervention state for a student.
 */
export async function updateStudentIntervention(schoolId, studentId, { status, notes, updatedBy = null }) {
  if (!Object.values(INTERVENTION_STATUSES).includes(status)) {
    throw new Error(`Invalid intervention status: ${status}`);
  }

  const [saved] = await sql`
    INSERT INTO attendance_interventions (
      school_id, student_id, status, notes, updated_by, updated_at
    )
    SELECT ${schoolId}, s.id, ${status}, ${notes || null}, ${updatedBy}, now()
    FROM students s
    WHERE s.id = ${studentId} AND s.school_id = ${schoolId} AND s.deleted_at IS NULL
    ON CONFLICT (school_id, student_id) DO UPDATE
    SET
      status = EXCLUDED.status,
      notes = COALESCE(EXCLUDED.notes, attendance_interventions.notes),
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
    RETURNING id, school_id, student_id, status, notes, updated_by, updated_at
  `;
  if (!saved) {
    const error = new Error('Student not found in this school');
    error.status = 404;
    throw error;
  }
  return saved;
}

/**
 * Evaluate and dispatch attendance risk alert for a single student.
 * Uses hysteresis / cooldown logic to prevent notification spam.
 */
export async function evaluateAndDispatchAttendanceAlert({
  schoolId,
  studentId,
  force = false,
  lookbackDays = 60,
}) {
  const rule = await getSchoolAutomationRule(schoolId, RULE_KEYS.ATTENDANCE_RISK_ALERTS);
  if (!rule.is_enabled && !force) {
    return { skipped: true, reason: 'RULE_DISABLED' };
  }

  const data = await calculateStudentAttendance(schoolId, studentId, lookbackDays);
  if (!data) {
    return { skipped: true, reason: 'STUDENT_NOT_FOUND' };
  }

  const riskState = classifyAttendanceRisk(data.attendance_percentage, data.total_sessions, rule.trigger_config);

  // Check last alert in execution logs
  const [lastLog] = await sql`
    SELECT id, stage, status, executed_at, metadata
    FROM automation_execution_logs
    WHERE school_id = ${schoolId}
      AND rule_key = ${RULE_KEYS.ATTENDANCE_RISK_ALERTS}
      AND entity_type = 'student'
      AND entity_id = ${studentId}
      AND status = 'completed'
    ORDER BY executed_at DESC
    LIMIT 1
  `;

  const now = new Date();
  const decision = shouldSendRiskAlert({
    currentTier: riskState,
    previousTier: lastLog?.stage || RISK_STATES.HEALTHY,
    attendancePct: data.attendance_percentage,
    lastAlertAt: force ? null : lastLog?.executed_at,
    now,
    config: rule.trigger_config,
  });
  if (decision.effectiveTier === RISK_STATES.HEALTHY) {
    await sql`UPDATE attendance_interventions SET status='resolved', updated_at=now()
      WHERE school_id=${schoolId} AND student_id=${studentId} AND status <> 'resolved'`;

    if (lastLog && lastLog.stage !== RISK_STATES.HEALTHY) {
      const dateStr = feeToday(now);
      const recSlot = await claimExecutionSlot({
        schoolId,
        ruleKey: RULE_KEYS.ATTENDANCE_RISK_ALERTS,
        entityType: 'student',
        entityId: studentId,
        idempotencyKey: `attendance_risk:${schoolId}:${studentId}:HEALTHY:${dateStr}`,
        stage: RISK_STATES.HEALTHY,
        payload: {
          studentId,
          studentName: data.student_name,
          attendancePercentage: data.attendance_percentage,
          riskState: RISK_STATES.HEALTHY,
          recoveredFrom: lastLog.stage,
        },
      });
      if (recSlot.claimed) {
        await markExecutionCompleted(recSlot.logId, {
          metadata: { recovered: true, previousStage: lastLog.stage, attendancePercentage: data.attendance_percentage },
        });
      }
    }
    return { skipped: true, reason: 'STUDENT_HEALTHY', riskState: decision.effectiveTier };
  }
  if (!decision.shouldAlert) return { skipped: true, reason: decision.reason, riskState: decision.effectiveTier };
  const effectiveRiskState = decision.effectiveTier;

  // Idempotency key per student + riskState + date
  const dateStr = feeToday(now);
  const idempotencyKey = `attendance_risk:${schoolId}:${studentId}:${effectiveRiskState}:${dateStr}`;

  const slot = await claimExecutionSlot({
    schoolId,
    ruleKey: RULE_KEYS.ATTENDANCE_RISK_ALERTS,
    entityType: 'student',
    entityId: studentId,
    idempotencyKey,
    stage: effectiveRiskState,
    channel: 'push',
    payload: {
      studentId,
      studentName: data.student_name,
      attendancePercentage: data.attendance_percentage,
      riskState: effectiveRiskState,
    },
  });

  if (!slot.claimed) {
    return { skipped: true, reason: slot.reason };
  }

  const logId = slot.logId;

  try {
    const recipientUserIds = await resolveStudentRecipientUserIds([studentId], schoolId);
    if (!recipientUserIds.length) {
      await markExecutionCompleted(logId, {
        recipientUserIds: [],
        metadata: { delivery: 'NO_ACTIVE_USERS' },
      });
      return { success: true, deliveredCount: 0, reason: 'NO_RECIPIENTS' };
    }

    const eventType = effectiveRiskState === RISK_STATES.BELOW_THRESHOLD
      ? 'ATTENDANCE_RISK_CRITICAL'
      : 'ATTENDANCE_RISK_WARNING';

    const threshold = effectiveRiskState === RISK_STATES.BELOW_THRESHOLD
      ? (rule.trigger_config.critical_threshold_pct ?? rule.trigger_config.critical_threshold ?? 75)
      : (rule.trigger_config.warning_threshold_pct ?? rule.trigger_config.warning_threshold ?? 78);

    const dispatchResult = await sendNotificationToUsers(
      recipientUserIds,
      eventType,
      {
        studentName: data.student_name,
        attendancePct: String(data.attendance_percentage),
        threshold: String(threshold),
      },
      { schoolId, deepLink: '/Screen/attendance' }
    );

    if (dispatchResult.failureCount > 0 && dispatchResult.successCount === 0) {
      throw new Error('Attendance alert delivery failed for every targeted device');
    }
    await markExecutionCompleted(logId, {
      recipientUserIds,
      metadata: {
        attendancePercentage: data.attendance_percentage,
        riskState: effectiveRiskState,
        successCount: dispatchResult.successCount,
        failureCount: dispatchResult.failureCount,
      },
    });

    return {
      success: true,
      deliveredCount: dispatchResult.successCount,
      riskState: effectiveRiskState,
      logId,
    };
  } catch (error) {
    logger.error({ err: error.message, studentId, schoolId }, 'Failed to dispatch attendance risk alert');
    await markExecutionFailed(logId, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Scan all active students for a school and dispatch alerts where appropriate.
 */
export async function scanAndProcessAttendanceRiskForSchool(schoolId, { force = false } = {}) {
  const rule = await getSchoolAutomationRule(schoolId, RULE_KEYS.ATTENDANCE_RISK_ALERTS);
  if (!rule.is_enabled && !force) {
    return { schoolId, skipped: true, reason: 'RULE_DISABLED' };
  }

  const insights = await getAttendanceRiskInsights(schoolId, { limit: 1000 });
  const atRisk = insights.students.filter(
    (s) => s.risk_state === RISK_STATES.APPROACHING_RISK || s.risk_state === RISK_STATES.BELOW_THRESHOLD
  );

  let evaluatedCount = atRisk.length;
  let dispatchedCount = 0;
  let skippedCount = 0;

  for (const student of atRisk) {
    const result = await evaluateAndDispatchAttendanceAlert({
      schoolId,
      studentId: student.student_id,
      force,
    });
    if (result.success && result.deliveredCount > 0) dispatchedCount++;
    else skippedCount++;
  }

  return {
    schoolId,
    totalScanned: insights.summary.total,
    evaluatedCount,
    dispatchedCount,
    skippedCount,
  };
}
