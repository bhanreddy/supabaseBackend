import sql from '../../db.js';
import logger from '../../utils/logger.js';

/**
 * Audit logger for all Anecdote lifecycle transitions.
 */
export async function logAnecdoteAudit({
  schoolId,
  anecdoteId,
  action,
  changedFields = {},
  previousState = {},
  newState = {},
  performedBy = null,
  ipAddress = null,
}) {
  if (!schoolId || !anecdoteId || !action) {
    logger.warn({ schoolId, anecdoteId, action }, 'logAnecdoteAudit called with missing arguments');
    return;
  }

  try {
    await sql`
      INSERT INTO public.anecdote_audit_logs (
        school_id,
        anecdote_id,
        action,
        changed_fields,
        previous_state,
        new_state,
        performed_by,
        ip_address
      ) VALUES (
        ${schoolId},
        ${anecdoteId},
        ${action},
        ${sql.json(changedFields)},
        ${sql.json(previousState)},
        ${sql.json(newState)},
        ${performedBy},
        ${ipAddress}
      )
    `;
  } catch (err) {
    logger.error({ err: err.message, schoolId, anecdoteId, action }, 'Failed to record anecdote audit log');
  }
}

/**
 * Fetch chronological audit history for an Anecdote.
 */
export async function getAnecdoteAuditHistory({ schoolId, anecdoteId }) {
  return sql`
    SELECT
      l.id,
      l.action,
      l.changed_fields,
      l.previous_state,
      l.new_state,
      l.performed_by,
      p.display_name AS performed_by_name,
      l.ip_address,
      l.created_at
    FROM public.anecdote_audit_logs l
    LEFT JOIN public.users u ON u.id = l.performed_by
    LEFT JOIN public.persons p ON p.id = u.person_id
    WHERE l.school_id = ${schoolId}
      AND l.anecdote_id = ${anecdoteId}
    ORDER BY l.created_at DESC
  `;
}
