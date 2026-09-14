/**
 * enforceFeatureAccess(featureKey)
 *
 * Authoritative server-side feature access gate.
 * Ensures clients cannot bypass the frontend gateway by manually making API requests.
 *
 * Verifies that the tenant school and authenticated user are entitled
 * to the requested feature under the active subscription plan and overrides.
 */
import { resolveFeatureAccess } from '../services/featureAccessService.js';
import sql from '../db.js';

export const enforceFeatureAccess = (featureKey) => async (req, res, next) => {
  // If user is not authenticated, let requireAuth middleware handle it (returns 401)
  if (!req.user) {
    return next();
  }

  const schoolId = req.user.schoolId;
  if (!schoolId) {
    return res.status(403).json({
      error: 'Access Denied: No school associated with this account',
      code: 'NO_SCHOOL_CONTEXT',
    });
  }

  const userId = req.user.id || req.user.internal_id;
  const roles = Array.isArray(req.user.roles) ? req.user.roles : [];
  const primaryRole = roles[0] || 'student';

  try {
    const decision = await resolveFeatureAccess({
      schoolId,
      userId,
      role: primaryRole,
      featureKey,
    });

    if (!decision.allowed) {
      // Audit blocked access attempt (fire-and-forget, non-blocking)
      sql`
        INSERT INTO public.feature_access_audit_logs (
          school_id, user_id, feature_key, action, previous_state, new_state, metadata
        ) VALUES (
          ${schoolId}, ${userId}, ${featureKey}, 'API_ACCESS_BLOCKED', NULL, ${decision.state},
          ${sql.json({ path: req.originalUrl, method: req.method, ip: req.ip })}
        )
      `.catch((err) => console.warn('[enforceFeatureAccess] Audit log error:', err.message));

      return res.status(403).json({
        error: `Feature access restricted: ${decision.ui?.title || featureKey}`,
        code: decision.state,
        access: decision,
      });
    }

    // Attach decision to request for downstream controllers
    req.featureAccess = decision;
    return next();
  } catch (err) {
    return next(err);
  }
};

export default enforceFeatureAccess;
