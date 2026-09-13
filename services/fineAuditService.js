import sql from '../db.js';
import logger from '../utils/logger.js';

/**
 * Records an immutable financial audit log entry for fine events.
 */
export async function logFineEvent({
  schoolId,
  userId = null,
  action,
  entityId,
  details = {},
  req = null,
  trx = null,
}) {
  const executor = trx || sql;
  const requestId = req?.id || req?.requestId || `fine_audit_${Date.now()}`;
  const ip = req?.ip || req?.headers?.['x-forwarded-for'] || null;
  const userAgent = req?.headers?.['user-agent'] || null;

  try {
    await executor`
      INSERT INTO public.audit_logs (
        school_id,
        user_id,
        action,
        entity,
        entity_id,
        details,
        ip_address,
        user_agent,
        request_id
      ) VALUES (
        ${Number(schoolId)},
        ${userId},
        ${action},
        'fine',
        ${entityId ? String(entityId) : null},
        ${sql.json(details)},
        ${ip},
        ${userAgent},
        ${requestId}
      )
    `;
  } catch (error) {
    logger.error({ error: error.message, action, entityId, schoolId }, 'Failed to insert fine audit log');
  }
}
