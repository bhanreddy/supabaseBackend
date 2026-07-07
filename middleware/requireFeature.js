/**
 * requireFeature(featureKey)
 *
 * Server-side enforcement for per-school STUDENT feature flags. Generalizes
 * middleware/pfEnabled.middleware.js. Returns 403 { code:'FEATURE_DISABLED', feature }
 * when the caller is a student and the feature is disabled for their school.
 *
 * ROLE-SCOPED ON PURPOSE: only the STUDENT role is gated. Staff/admin/accounts
 * are governed by roles/permissions, so this can sit at a shared router mount
 * without breaking non-student access. Unauthenticated requests pass through
 * (the route's own requireAuth rejects them with 401).
 *
 * school_id is taken from the JWT-derived req.user only — never from client input.
 */
import { isFeatureEnabled, STUDENT_ROLE } from '../utils/featureRegistry.js';

/** Roles that use the student/parent portal and are subject to feature flags. */
const PORTAL_GATED_ROLES = [STUDENT_ROLE, 'parent'];

export const requireFeature = (featureKey) => async (req, res, next) => {
  const roles = req.user?.roles || [];
  // Gate student/parent portal users only. Staff/admin/accounts pass through.
  if (!req.user || !PORTAL_GATED_ROLES.some((r) => roles.includes(r))) {
    return next();
  }
  if (req.user.schoolId == null) {
    return res.status(403).json({ error: 'No school associated with this account' });
  }

  try {
    const enabled = await isFeatureEnabled(req.user.schoolId, featureKey);
    if (!enabled) {
      return res.status(403).json({ code: 'FEATURE_DISABLED', feature: featureKey });
    }
    return next();
  } catch (err) {
    return next(err); // transient DB errors -> global handler maps to 503
  }
};

export default requireFeature;

// ponytail: STUDENT_ROLE is compared against req.user.roles (role codes). If a
// school renames the student role code, update STUDENT_ROLE in featureRegistry.js.
