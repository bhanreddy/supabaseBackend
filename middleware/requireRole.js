import sql from '../db.js';

/**
 * requireRole(...roleCodes)
 * Middleware factory. Checks if req.user has one of the specified roles
 * within req.user.schoolId scope.
 *
 * Usage:
 *   router.get('/students', requireRole('admin', 'staff'), handler)
 */
export const requireRole = (...roleCodes) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized: No user logged in' });
    }

    if (!req.user.schoolId) {
      return res.status(403).json({ error: 'No school context found for user' });
    }

    try {
      const result = await sql`
        SELECT r.code FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = ${req.user.internal_id || req.user.id}
          AND ur.school_id = ${req.user.schoolId}
          AND r.school_id = ${req.user.schoolId}
          AND r.code = ANY(${roleCodes})
        LIMIT 1
      `;

      if (result.length === 0) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      // Attach the matched role to req for downstream use
      req.userRole = result[0].code;
      next();
    } catch (err) {
      console.error('[requireRole] Error checking role:', err);
      return res.status(500).json({ error: 'Internal error checking permissions' });
    }
  };
};
