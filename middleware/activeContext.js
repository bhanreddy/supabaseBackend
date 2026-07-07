/**
 * activeContext.js — Optional portal context for same-login child switching.
 *
 * Only runs when the client explicitly sends X-Active-Context.
 * Vault-based account switching (separate JWTs) does not use this middleware.
 */

import sql from '../db.js';
import { getContextById } from '../services/accessContextService.js';

async function attachPermissionsToContext(row) {
  if (!row) return null;

  const permRows = await sql`
    SELECT DISTINCT p.code
    FROM roles r
    JOIN role_permissions rp ON rp.role_id = r.id AND rp.school_id = r.school_id
    JOIN permissions p ON p.id = rp.permission_id AND p.school_id = r.school_id
    WHERE r.school_id = ${row.school_id}
      AND r.code = ANY(${row.role_codes || []})
      AND r.deleted_at IS NULL
    ORDER BY p.code
  `;

  return {
    id: row.id,
    context_key: row.context_key,
    portal_type: row.portal_type,
    role_codes: row.role_codes || [],
    school_id: row.school_id,
    school_name: row.school_name ?? null,
    student_id: row.student_id,
    staff_id: row.staff_id,
    parent_id: row.parent_id,
    display_name: row.display_name,
    subtitle: row.subtitle,
    photo_url: row.photo_url,
    source: row.source,
    permissions: permRows.map((p) => p.code),
  };
}

export const resolveActiveContext = async (req, res, next) => {
  try {
    if (!req.user?.internal_id && !req.user?.id) {
      return next();
    }

    const headerContextId = req.headers['x-active-context'] || null;
    if (!headerContextId) {
      return next();
    }

    const userId = req.user.internal_id || req.user.id;
    const contextRow = await getContextById(userId, headerContextId);
    if (!contextRow) {
      return res.status(403).json({
        error: 'Access context is not valid',
        code: 'CONTEXT_INVALID',
        action: 'SHOW_CONTEXT_PICKER',
      });
    }

    req.activeContext = await attachPermissionsToContext(contextRow);

    if (req.activeContext) {
      req.user.roles = req.activeContext.role_codes;
      req.user.permissions = req.activeContext.permissions;
      req.schoolId = req.activeContext.school_id;

      if (req.activeContext.staff_id) {
        req.user.staff_id = req.activeContext.staff_id;
      }
      if (req.activeContext.student_id) {
        req.user.active_student_id = req.activeContext.student_id;
      }
    }

    return next();
  } catch (err) {
    console.error('[resolveActiveContext] error:', err);
    return next();
  }
};

export function requireActivePortal(...portalTypes) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!req.activeContext) {
      return next();
    }
    if (!portalTypes.includes(req.activeContext.portal_type)) {
      return res.status(403).json({
        error: 'Wrong portal context for this action',
        code: 'WRONG_PORTAL_CONTEXT',
      });
    }
    next();
  };
}
