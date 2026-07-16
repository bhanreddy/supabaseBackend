import sql from '../db.js';

const STAFF_PORTAL_ROLES = new Set(['staff', 'teacher', 'principal']);

/**
 * Allow an authenticated admin to operate the staff portal as one selected
 * staff member. The target comes from a header, but identity and tenant scope
 * are re-resolved from the database on every request.
 *
 * req.user becomes the effective staff identity so existing self-scoped routes
 * (messages, diary, leave, LMS, profile photo, etc.) behave exactly as they do
 * for a real staff login. req.staffPortalAccess retains the real admin actor for
 * permission bypass and audit attribution.
 */
export const resolveStaffPortalAccess = async (req, res, next) => {
  const rawTarget = req.headers['x-staff-portal-id'];
  if (!rawTarget) return next();

  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const targetStaffId = String(rawTarget).trim();
  if (!targetStaffId) {
    return res.status(400).json({ error: 'Invalid staff portal target' });
  }

  const adminUser = { ...req.user };
  if (!(adminUser.roles || []).includes('admin')) {
    return res.status(403).json({ error: 'Only administrators can use staff portal access' });
  }

  try {
    const [target] = await sql`
      SELECT
        st.id AS staff_id,
        st.person_id,
        p.display_name,
        u.id AS user_id,
        u.account_status,
        COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
        COALESCE(array_agg(DISTINCT perm.code) FILTER (WHERE perm.code IS NOT NULL), '{}') AS permissions
      FROM staff st
      JOIN persons p ON p.id = st.person_id AND p.school_id = st.school_id
      LEFT JOIN users u ON u.person_id = st.person_id
        AND u.school_id = st.school_id
        AND u.deleted_at IS NULL
      LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.school_id = st.school_id
      LEFT JOIN roles r ON r.id = ur.role_id AND r.school_id = st.school_id
      LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.school_id = st.school_id
      LEFT JOIN permissions perm ON perm.id = rp.permission_id AND perm.school_id = st.school_id
      WHERE st.id = ${targetStaffId}
        AND st.school_id = ${adminUser.schoolId}
        AND st.deleted_at IS NULL
      GROUP BY st.id, st.person_id, p.display_name, u.id, u.account_status
      ORDER BY (u.account_status = 'active') DESC NULLS LAST
      LIMIT 1
    `;

    if (!target) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    if (!target.user_id || target.account_status !== 'active') {
      return res.status(409).json({
        error: 'This staff member does not have an active login account',
        code: 'STAFF_LOGIN_REQUIRED',
      });
    }

    const effectiveRoles = (target.roles || []).filter((role) => STAFF_PORTAL_ROLES.has(role));
    if (effectiveRoles.length === 0) {
      return res.status(409).json({
        error: 'This staff member is not assigned a staff-portal role',
        code: 'STAFF_PORTAL_ROLE_REQUIRED',
      });
    }

    req.staffPortalAccess = {
      admin_user_id: adminUser.internal_id,
      admin_person_id: adminUser.person_id,
      target_user_id: target.user_id,
      target_person_id: target.person_id,
      target_staff_id: target.staff_id,
      target_name: target.display_name,
    };

    req.user = {
      ...adminUser,
      id: target.user_id,
      internal_id: target.user_id,
      person_id: target.person_id,
      staff_id: target.staff_id,
      roles: effectiveRoles,
      permissions: (target.permissions || []).filter(Boolean),
    };

    return next();
  } catch (error) {
    console.error('[resolveStaffPortalAccess] error:', error);
    return res.status(503).json({ error: 'Could not establish staff portal access' });
  }
};
