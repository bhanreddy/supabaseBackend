import sql from '../../db.js';
import logger from '../../utils/logger.js';

/**
 * Immutable audit logger for all Content Engine events.
 */
export async function logContentAudit({
  schoolId,
  contentId,
  action,
  performedBy = null,
  changedFields = {},
  previousState = {},
  newState = {},
  ipAddress = null,
  tx = null,
}) {
  if (!schoolId || !contentId || !action) {
    logger.warn({ schoolId, contentId, action }, 'logContentAudit called with missing arguments');
    return;
  }

  const executor = tx || sql;

  try {
    await executor`
      INSERT INTO public.content_audit_logs (
        school_id,
        content_id,
        action,
        performed_by,
        changed_fields,
        previous_state,
        new_state,
        ip_address
      ) VALUES (
        ${schoolId},
        ${contentId},
        ${action},
        ${performedBy},
        ${sql.json(changedFields)},
        ${sql.json(previousState)},
        ${sql.json(newState)},
        ${ipAddress}
      )
    `;
  } catch (err) {
    logger.error({ err: err.message, schoolId, contentId, action }, 'Failed to record content audit log');
  }
}

/**
 * Retrieve audit history for a specific content item.
 */
export async function getContentAuditLogs({ schoolId, contentId }) {
  return sql`
    SELECT
      l.id,
      l.action,
      l.performed_by,
      p.first_name || ' ' || coalesce(p.last_name, '') AS performed_by_name,
      l.changed_fields,
      l.previous_state,
      l.new_state,
      l.ip_address,
      l.created_at
    FROM public.content_audit_logs l
    LEFT JOIN public.users u ON u.id = l.performed_by
    LEFT JOIN public.persons p ON p.id = u.person_id
    WHERE l.school_id = ${schoolId}
      AND l.content_id = ${contentId}
    ORDER BY l.created_at DESC
  `;
}
