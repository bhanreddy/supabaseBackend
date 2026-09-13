import sql from '../db.js';
import logger from '../utils/logger.js';

export const RULE_KEYS = {
  FEE_DUE_REMINDER: 'fee_due_reminder',
  FEE_OVERDUE_REMINDER: 'fee_overdue_reminder',
  ATTENDANCE_RISK_ALERTS: 'attendance_risk_alerts',
  AUTOMATED_SUBSTITUTION: 'automated_substitution',
  TRANSPORT_OVERSPEED_ALERT: 'transport_overspeed_alert',
  TRANSPORT_SAFEGUARDING_RECONCILE: 'transport_safeguarding_reconcile',
};

export const DEFAULT_FEE_REMINDER_TRIGGER = {
  days_before_due: 3,
  overdue_stages: [3, 7, 15, 30],
  cooldown_days: 2,
};

export const DEFAULT_FEE_REMINDER_ACTION = {
  channel: 'push',
  template: 'FEE_REMINDER',
};

export const DEFAULT_ATTENDANCE_RISK_TRIGGER = {
  warning_threshold: 78,
  critical_threshold: 75,
  cooldown_days: 7,
  lookback_days: 60,
  min_total_days: 5,
};

export const DEFAULT_ATTENDANCE_RISK_ACTION = {
  channel: 'push',
  template_warning: 'ATTENDANCE_RISK_WARNING',
  template_critical: 'ATTENDANCE_RISK_CRITICAL',
};

export const DEFAULT_SUBSTITUTION_TRIGGER = {
  auto_assign: false,
  notify_substitute: true,
};

export const DEFAULT_SUBSTITUTION_ACTION = {
  channel: 'push',
  template: 'SUBSTITUTION_ASSIGNED',
};

export const DEFAULT_TRANSPORT_OVERSPEED_TRIGGER = {
  default_speed_limit: 50,
  sustained_points: 3,
  sustained_duration_seconds: 15,
};

export const DEFAULT_TRANSPORT_OVERSPEED_ACTION = {
  channel: 'push',
  template: 'TRANSPORT_OVERSPEED_ALERT',
};

export const DEFAULT_SAFEGUARDING_TRIGGER = {
  verification_window_minutes: 30,
  alert_staff_first: true,
};

export const DEFAULT_SAFEGUARDING_ACTION = {
  channel: 'push',
  template: 'TRANSPORT_SAFEGUARDING_ANOMALY',
};

export function getDefaultConfigs(ruleKey) {
  switch (ruleKey) {
    case RULE_KEYS.ATTENDANCE_RISK_ALERTS:
      return { trigger: DEFAULT_ATTENDANCE_RISK_TRIGGER, action: DEFAULT_ATTENDANCE_RISK_ACTION };
    case RULE_KEYS.AUTOMATED_SUBSTITUTION:
      return { trigger: DEFAULT_SUBSTITUTION_TRIGGER, action: DEFAULT_SUBSTITUTION_ACTION };
    case RULE_KEYS.TRANSPORT_OVERSPEED_ALERT:
      return { trigger: DEFAULT_TRANSPORT_OVERSPEED_TRIGGER, action: DEFAULT_TRANSPORT_OVERSPEED_ACTION };
    case RULE_KEYS.TRANSPORT_SAFEGUARDING_RECONCILE:
      return { trigger: DEFAULT_SAFEGUARDING_TRIGGER, action: DEFAULT_SAFEGUARDING_ACTION };
    case RULE_KEYS.FEE_DUE_REMINDER:
    case RULE_KEYS.FEE_OVERDUE_REMINDER:
    default:
      return { trigger: DEFAULT_FEE_REMINDER_TRIGGER, action: DEFAULT_FEE_REMINDER_ACTION };
  }
}

export function validateRuleUpdate(update = {}, ruleKey = RULE_KEYS.FEE_DUE_REMINDER) {
  const fail = (msg = 'Invalid automation rule configuration') => { const error = new Error(msg); error.status = 400; throw error; };
  if (!update || typeof update !== 'object' || Array.isArray(update)) fail();
  if (update.is_enabled !== undefined && typeof update.is_enabled !== 'boolean') fail();

  // If ruleKey is fee-related, apply strict fee validation
  if (ruleKey === RULE_KEYS.FEE_DUE_REMINDER || ruleKey === RULE_KEYS.FEE_OVERDUE_REMINDER) {
    if (update.trigger_config !== undefined) {
      const t = update.trigger_config;
      if (!t || typeof t !== 'object' || Array.isArray(t)) fail();
      if (Object.keys(t).some(k => !['days_before_due', 'overdue_stages', 'cooldown_days'].includes(k))) fail();
      if (t.days_before_due !== undefined && (!Number.isInteger(t.days_before_due) || t.days_before_due < 0 || t.days_before_due > 30)) fail();
      if (t.cooldown_days !== undefined && (!Number.isInteger(t.cooldown_days) || t.cooldown_days < 1 || t.cooldown_days > 30)) fail();
      if (t.overdue_stages !== undefined && (!Array.isArray(t.overdue_stages) || t.overdue_stages.length > 12 || t.overdue_stages.some(d => !Number.isInteger(d) || d < 1 || d > 365) || new Set(t.overdue_stages).size !== t.overdue_stages.length)) fail();
    }
    if (update.action_config !== undefined) {
      const a = update.action_config;
      if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !['channel', 'template'].includes(k))) fail();
      if (a.channel !== undefined && a.channel !== 'push') fail();
      if (a.template !== undefined && a.template !== 'FEE_REMINDER') fail();
    }
  } else if (ruleKey === RULE_KEYS.ATTENDANCE_RISK_ALERTS) {
    if (update.trigger_config !== undefined) {
      const t = update.trigger_config;
      if (!t || typeof t !== 'object' || Array.isArray(t)) fail();
      if (t.warning_threshold !== undefined && (typeof t.warning_threshold !== 'number' || t.warning_threshold <= 0 || t.warning_threshold > 100)) fail('warning_threshold must be between 1 and 100');
      if (t.critical_threshold !== undefined && (typeof t.critical_threshold !== 'number' || t.critical_threshold <= 0 || t.critical_threshold > 100)) fail('critical_threshold must be between 1 and 100');
      if (t.warning_threshold !== undefined && t.critical_threshold !== undefined && t.critical_threshold > t.warning_threshold) fail('critical_threshold cannot exceed warning_threshold');
    }
  } else if (ruleKey === RULE_KEYS.TRANSPORT_OVERSPEED_ALERT) {
    if (update.trigger_config !== undefined) {
      const t = update.trigger_config;
      if (!t || typeof t !== 'object' || Array.isArray(t)) fail();
      if (Object.keys(t).some(k => !['default_speed_limit', 'sustained_points', 'sustained_duration_seconds', 'cooldown_minutes'].includes(k))) fail();
      if (t.default_speed_limit !== undefined && (!Number.isFinite(t.default_speed_limit) || t.default_speed_limit < 10 || t.default_speed_limit > 150)) fail('default_speed_limit must be between 10 and 150');
      if (t.sustained_points !== undefined && (!Number.isInteger(t.sustained_points) || t.sustained_points < 2 || t.sustained_points > 30)) fail('sustained_points must be between 2 and 30');
      if (t.sustained_duration_seconds !== undefined && (!Number.isInteger(t.sustained_duration_seconds) || t.sustained_duration_seconds < 5 || t.sustained_duration_seconds > 300)) fail('sustained_duration_seconds must be between 5 and 300');
      if (t.cooldown_minutes !== undefined && (!Number.isInteger(t.cooldown_minutes) || t.cooldown_minutes < 1 || t.cooldown_minutes > 1440)) fail('cooldown_minutes must be between 1 and 1440');
    }
  }
}

/**
 * Get configuration for an automation rule.
 * If not present in DB, returns safe default (is_enabled = false).
 */
export async function getSchoolAutomationRule(schoolId, ruleKey, db = sql) {
  if (!schoolId || !ruleKey) return null;

  const defaults = getDefaultConfigs(ruleKey);

  const [row] = await db`
    SELECT id, school_id, rule_key, is_enabled, trigger_config, action_config, last_triggered_at, created_at, updated_at
    FROM school_automation_rules
    WHERE school_id = ${schoolId} AND rule_key = ${ruleKey}
  `;

  if (row) {
    validateRuleUpdate(row, ruleKey);
    return {
      ...row,
      trigger_config: { ...defaults.trigger, ...(row.trigger_config || {}) },
      action_config: { ...defaults.action, ...(row.action_config || {}) },
    };
  }

  // Return unpersisted default object
  return {
    id: null,
    school_id: schoolId,
    rule_key: ruleKey,
    is_enabled: false,
    trigger_config: defaults.trigger,
    action_config: defaults.action,
    last_triggered_at: null,
  };
}

/**
 * Check if a specific rule is enabled for a school.
 */
export async function isAutomationRuleEnabled(schoolId, ruleKey) {
  const rule = await getSchoolAutomationRule(schoolId, ruleKey);
  return Boolean(rule?.is_enabled);
}

/**
 * Upsert rule configuration for a school.
 */
export async function upsertSchoolAutomationRule(schoolId, ruleKey, { is_enabled, trigger_config, action_config }, actorId = null) {
  if (!schoolId || !ruleKey) {
    throw new Error('schoolId and ruleKey are required');
  }

  validateRuleUpdate({ is_enabled, trigger_config, action_config }, ruleKey);
  const existing = await getSchoolAutomationRule(schoolId, ruleKey);
  const finalEnabled = typeof is_enabled === 'boolean' ? is_enabled : existing.is_enabled;
  const finalTrigger = trigger_config ? { ...existing.trigger_config, ...trigger_config } : existing.trigger_config;
  const finalAction = action_config ? { ...existing.action_config, ...action_config } : existing.action_config;

  const saved = await sql.begin(async tx => {
  const [row] = await tx`
    INSERT INTO school_automation_rules (
      school_id, rule_key, is_enabled, trigger_config, action_config, updated_at
    )
    VALUES (
      ${schoolId}, ${ruleKey}, ${finalEnabled}, ${sql.json(finalTrigger)}, ${sql.json(finalAction)}, now()
    )
    ON CONFLICT (school_id, rule_key) DO UPDATE
    SET
      is_enabled = EXCLUDED.is_enabled,
      trigger_config = EXCLUDED.trigger_config,
      action_config = EXCLUDED.action_config,
      updated_at = now()
    RETURNING id, school_id, rule_key, is_enabled, trigger_config, action_config, last_triggered_at, updated_at
  `;

  await tx`INSERT INTO audit_logs (school_id, user_id, action, entity, entity_id, details)
    VALUES (${schoolId}, ${actorId}, 'fee_recovery.rules.updated', 'school_automation_rules', ${row.id},
      ${tx.json({ is_enabled: finalEnabled, trigger_config: finalTrigger, action_config: finalAction })})`;
  return row;
  });

  logger.info({ schoolId, ruleKey, is_enabled: finalEnabled }, 'School automation rule updated');
  return saved;
}

/**
 * Record that a rule has been triggered.
 */
export async function recordRuleTriggered(schoolId, ruleKey) {
  await sql`
    UPDATE school_automation_rules
    SET last_triggered_at = now()
    WHERE school_id = ${schoolId} AND rule_key = ${ruleKey}
  `;
}
