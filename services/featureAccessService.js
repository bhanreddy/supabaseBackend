/**
 * Universal Feature Access Resolution Engine
 * SchoolIMS 5.1.8 Core Platform Architecture
 *
 * Centralized, authoritative backend service for feature access,
 * entitlement resolution, plan gating, and access request workflows.
 */
import sql from '../db.js';

export const FeatureAccessState = {
  ALLOWED: 'ALLOWED',
  PLAN_REQUIRED: 'PLAN_REQUIRED',
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  ADMIN_APPROVAL_REQUIRED: 'ADMIN_APPROVAL_REQUIRED',
  COMING_SOON: 'COMING_SOON',
  BETA: 'BETA',
  MAINTENANCE: 'MAINTENANCE',
  TEMPORARILY_UNAVAILABLE: 'TEMPORARILY_UNAVAILABLE',
  INVALID_ROUTE: 'INVALID_ROUTE',
  ACCESS_CHECK_FAILED: 'ACCESS_CHECK_FAILED',
};

// In-memory cache for feature registry metadata & plans (60s TTL)
let registryCache = null;
let registryCacheTime = 0;
const REGISTRY_TTL_MS = 60 * 1000;

/**
 * Fetch and cache the master feature definitions and plan tiers from DB.
 */
export async function getCachedRegistry() {
  const now = Date.now();
  if (registryCache && now - registryCacheTime < REGISTRY_TTL_MS) {
    return registryCache;
  }

  const [features, plans, planFeatures, rollouts] = await Promise.all([
    sql`SELECT * FROM public.features`,
    sql`SELECT * FROM public.plans ORDER BY tier_rank ASC`,
    sql`SELECT * FROM public.plan_features WHERE enabled = true`,
    sql`SELECT * FROM public.feature_rollouts WHERE is_active = true`,
  ]);

  const featuresByKey = new Map(features.map((f) => [f.key, f]));
  const plansById = new Map(plans.map((p) => [p.id, p]));
  const rolloutsByKey = new Map(rollouts.map((r) => [r.feature_key, r]));

  const featuresByPlan = new Map();
  for (const pf of planFeatures) {
    if (!featuresByPlan.has(pf.plan_id)) {
      featuresByPlan.set(pf.plan_id, new Set());
    }
    featuresByPlan.get(pf.plan_id).add(pf.feature_key);
  }

  registryCache = {
    featuresByKey,
    plansById,
    rolloutsByKey,
    featuresByPlan,
  };
  registryCacheTime = now;
  return registryCache;
}

/** Clear cache on writes */
export function invalidateRegistryCache() {
  registryCache = null;
  registryCacheTime = 0;
}

/**
 * Deterministic hash for percentage rollouts.
 * Returns integer 0-99.
 */
function computeDeterministicHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 100;
}

/**
 * Resolve feature access with deterministic precedence.
 *
 * Precedence Order:
 *  1. Feature exists in registry? NO -> INVALID_ROUTE
 *  2. Feature in maintenance? YES -> MAINTENANCE
 *  3. Feature coming soon? YES -> COMING_SOON
 *  4. Explicit user override exists? YES (allow/deny)
 *  5. Explicit school override exists? YES (allow/deny)
 *  6. Rollout configuration check (ALL, SELECTED_SCHOOLS, PERCENTAGE, BETA_USERS, INTERNAL_ONLY)
 *  7. Feature beta check
 *  8. Role compatibility check (e.g. parent attempting admin tools)
 *  9. School subscription / plan containment (ALLOWED vs PLAN_REQUIRED)
 * 10. Fallback -> PERMISSION_DENIED
 */
export async function resolveFeatureAccess({ schoolId, userId, role, featureKey }) {
  if (!featureKey || typeof featureKey !== 'string') {
    return buildResolutionResponse({
      allowed: false,
      state: FeatureAccessState.INVALID_ROUTE,
      featureKey: 'unknown',
      role,
    });
  }

  try {
    const { featuresByKey, plansById, rolloutsByKey, featuresByPlan } = await getCachedRegistry();

    // 1. Feature exists?
    const feature = featuresByKey.get(featureKey);
    if (!feature) {
      return buildResolutionResponse({
        allowed: false,
        state: FeatureAccessState.INVALID_ROUTE,
        featureKey,
        role,
      });
    }

    // 2. Feature in maintenance?
    if (feature.is_maintenance) {
      return buildResolutionResponse({
        allowed: false,
        state: FeatureAccessState.MAINTENANCE,
        feature,
        role,
      });
    }

    // 3. Feature globally active / coming soon?
    if (!feature.is_active || feature.rollout_strategy === 'COMING_SOON') {
      return buildResolutionResponse({
        allowed: false,
        state: FeatureAccessState.COMING_SOON,
        feature,
        role,
      });
    }

    // 4. Explicit User Override
    if (userId && schoolId) {
      const [userOverride] = await sql`
        SELECT enabled, expires_at
        FROM public.user_feature_overrides
        WHERE school_id = ${schoolId} AND user_id = ${userId} AND feature_key = ${featureKey}
        LIMIT 1
      `;
      if (userOverride && (!userOverride.expires_at || new Date(userOverride.expires_at) > new Date())) {
        if (userOverride.enabled === false) {
          return buildResolutionResponse({
            allowed: false,
            state: FeatureAccessState.PERMISSION_DENIED,
            feature,
            role,
            reason: 'Explicit user access restriction',
          });
        }
        if (userOverride.enabled === true) {
          return buildResolutionResponse({
            allowed: true,
            state: FeatureAccessState.ALLOWED,
            feature,
            role,
          });
        }
      }
    }

    // 5. Explicit School Override
    if (schoolId) {
      const [schoolOverride] = await sql`
        SELECT enabled, expires_at
        FROM public.school_feature_overrides
        WHERE school_id = ${schoolId} AND feature_key = ${featureKey}
        LIMIT 1
      `;
      if (schoolOverride && (!schoolOverride.expires_at || new Date(schoolOverride.expires_at) > new Date())) {
        if (schoolOverride.enabled === false) {
          return buildResolutionResponse({
            allowed: false,
            state: FeatureAccessState.FEATURE_DISABLED,
            feature,
            role,
            reason: 'Feature disabled for your school',
          });
        }
        if (schoolOverride.enabled === true) {
          return buildResolutionResponse({
            allowed: true,
            state: FeatureAccessState.ALLOWED,
            feature,
            role,
          });
        }
      }
    }

    // 6. Rollout Configuration Check
    const rollout = rolloutsByKey.get(featureKey);
    const rolloutType = rollout && rollout.is_active ? rollout.rollout_type : feature.rollout_strategy;
    const rolloutPayload = rollout && rollout.is_active ? (rollout.rollout_payload || {}) : (feature.metadata?.rollout || {});

    if (rolloutType && rolloutType !== 'ALL') {
      switch (rolloutType) {
        case 'SELECTED_SCHOOLS': {
          const allowedSchools = Array.isArray(rolloutPayload.school_ids) ? rolloutPayload.school_ids : [];
          if (!allowedSchools.includes(Number(schoolId))) {
            return buildResolutionResponse({
              allowed: false,
              state: FeatureAccessState.COMING_SOON,
              feature,
              role,
              reason: 'Feature is currently limited to select partner schools',
            });
          }
          break;
        }
        case 'PERCENTAGE': {
          const pct = Number(rolloutPayload.percentage) || 0;
          const hashVal = computeDeterministicHash(`${schoolId}:${featureKey}`);
          if (hashVal >= pct) {
            return buildResolutionResponse({
              allowed: false,
              state: FeatureAccessState.COMING_SOON,
              feature,
              role,
              reason: 'Feature rollout is currently in progress',
            });
          }
          break;
        }
        case 'INTERNAL_ONLY': {
          const allowedInternalUsers = Array.isArray(rolloutPayload.user_ids) ? rolloutPayload.user_ids : [];
          if (!allowedInternalUsers.includes(userId)) {
            return buildResolutionResponse({
              allowed: false,
              state: FeatureAccessState.COMING_SOON,
              feature,
              role,
              reason: 'Feature available for internal preview only',
            });
          }
          break;
        }
        case 'BETA_USERS': {
          const betaUsers = Array.isArray(rolloutPayload.user_ids) ? rolloutPayload.user_ids : [];
          if (!betaUsers.includes(userId)) {
            return buildResolutionResponse({
              allowed: false,
              state: FeatureAccessState.BETA,
              feature,
              role,
              reason: 'Early access program required',
            });
          }
          break;
        }
        default:
          break;
      }
    }

    // 7. Feature Beta Check
    if (feature.is_beta) {
      const [betaEnrollment] = schoolId
        ? await sql`
            SELECT 1 FROM public.school_feature_overrides
            WHERE school_id = ${schoolId} AND feature_key = ${featureKey} AND enabled = true
          `
        : [];
      if (!betaEnrollment) {
        return buildResolutionResponse({
          allowed: false,
          state: FeatureAccessState.BETA,
          feature,
          role,
        });
      }
    }

    // 8. Role Permission Sanity Check
    // Roles like 'student' or 'parent' cannot access strictly administrative or faculty tools
    const normalizedRole = String(role || 'student').toLowerCase();
    const adminOnlyCategories = ['security', 'finance'];
    if (['student', 'parent'].includes(normalizedRole) && adminOnlyCategories.includes(feature.category)) {
      return buildResolutionResponse({
        allowed: false,
        state: FeatureAccessState.PERMISSION_DENIED,
        feature,
        role,
        reason: 'This section requires staff or administrator credentials',
      });
    }

    // 9. School Subscription & Plan Containment
    let schoolPlanId = 'standard';
    let subscriptionStatus = 'active';

    if (schoolId) {
      const [sub] = await sql`
        SELECT plan_id, plan_name, subscription_status
        FROM public.saas_subscriptions
        WHERE school_id = ${schoolId}
        LIMIT 1
      `;
      if (sub) {
        schoolPlanId = sub.plan_id || 'standard';
        subscriptionStatus = sub.subscription_status || 'active';
      }
    }

    // Check for paused/cancelled subscription
    if (['paused', 'cancelled'].includes(subscriptionStatus)) {
      return buildResolutionResponse({
        allowed: false,
        state: FeatureAccessState.TEMPORARILY_UNAVAILABLE,
        feature,
        role,
        subscription: { currentPlan: schoolPlanId, status: subscriptionStatus },
        reason: 'Subscription is temporarily inactive',
      });
    }

    const currentPlan = plansById.get(schoolPlanId) || plansById.get('standard');
    const minRequiredPlan = feature.min_plan_tier
      ? plansById.get(feature.min_plan_tier)
      : plansById.get('starter');

    const planFeaturesSet = featuresByPlan.get(schoolPlanId) || new Set();
    const isIncludedByMapping = planFeaturesSet.has(featureKey);
    const isIncludedByRank = currentPlan && minRequiredPlan && currentPlan.tier_rank >= minRequiredPlan.tier_rank;

    if (isIncludedByMapping || isIncludedByRank) {
      return buildResolutionResponse({
        allowed: true,
        state: FeatureAccessState.ALLOWED,
        feature,
        role,
        subscription: {
          currentPlan: schoolPlanId,
          requiredPlan: feature.min_plan_tier || 'starter',
          status: subscriptionStatus,
        },
      });
    }

    // Available in higher plan tier?
    if (minRequiredPlan && currentPlan && minRequiredPlan.tier_rank > currentPlan.tier_rank) {
      return buildResolutionResponse({
        allowed: false,
        state: FeatureAccessState.PLAN_REQUIRED,
        feature,
        role,
        subscription: {
          currentPlan: schoolPlanId,
          requiredPlan: minRequiredPlan.id,
          requiredPlanName: minRequiredPlan.name,
          status: subscriptionStatus,
        },
      });
    }

    // Fallback
    return buildResolutionResponse({
      allowed: false,
      state: FeatureAccessState.PERMISSION_DENIED,
      feature,
      role,
    });
  } catch (error) {
    console.error('[featureAccessService] Error resolving feature access:', error);
    return buildResolutionResponse({
      allowed: false,
      state: FeatureAccessState.ACCESS_CHECK_FAILED,
      featureKey,
      role,
      reason: error.message || 'Verification service error',
    });
  }
}

/**
 * Constructs normalized response payload with role-sensitive UI messaging and actions.
 */
export function buildResolutionResponse({
  allowed,
  state,
  feature,
  featureKey,
  role,
  subscription,
  reason,
}) {
  const normalizedRole = String(role || 'student').toLowerCase();
  const key = feature?.key || featureKey || 'unknown';
  const name = feature?.name || formatFeatureName(key);
  const description = feature?.description || 'Institutional management capability.';
  const category = feature?.category || 'operations';
  const hero = feature?.hero_archetype || 'ORBIT';

  let benefits = [];
  if (feature?.metadata?.benefits && Array.isArray(feature.metadata.benefits)) {
    benefits = feature.metadata.benefits;
  } else {
    benefits = getDefaultBenefitsForCategory(category);
  }

  // 1. Eyebrow, Title & Description
  let eyebrow = 'CAPABILITY';
  let title = name;
  let desc = description;

  switch (state) {
    case FeatureAccessState.PLAN_REQUIRED:
      eyebrow = 'PREMIUM CAPABILITY';
      desc = description;
      break;
    case FeatureAccessState.FEATURE_DISABLED:
      eyebrow = 'FEATURE UNAVAILABLE';
      desc = reason || `${name} is currently disabled by your institution administration.`;
      break;
    case FeatureAccessState.PERMISSION_DENIED:
      eyebrow = 'ACCESS RESTRICTED';
      desc = reason || `Your role does not have authorization to access ${name}.`;
      break;
    case FeatureAccessState.ADMIN_APPROVAL_REQUIRED:
      eyebrow = 'APPROVAL REQUIRED';
      desc = `Access to ${name} requires administrative authorization before use.`;
      break;
    case FeatureAccessState.COMING_SOON:
      eyebrow = 'COMING SOON';
      desc = `${name} is currently in final development. Subscribe to receive launch notifications.`;
      break;
    case FeatureAccessState.BETA:
      eyebrow = 'EARLY ACCESS';
      desc = `${name} is in pilot testing. Request early access for your school to test before general availability.`;
      break;
    case FeatureAccessState.MAINTENANCE:
      eyebrow = 'TEMPORARILY UNAVAILABLE';
      desc = `${name} is undergoing scheduled maintenance. Services will resume shortly.`;
      break;
    case FeatureAccessState.TEMPORARILY_UNAVAILABLE:
      eyebrow = 'SERVICE TEMPORARILY PAUSED';
      desc = reason || 'This module is temporarily unavailable. Please verify with your institution.';
      break;
    case FeatureAccessState.INVALID_ROUTE:
      eyebrow = 'PAGE NOT FOUND';
      title = 'Screen Not Found';
      desc = 'The requested screen or feature does not exist or has been relocated.';
      benefits = ['Verify navigation links', 'Check portal dashboard', 'Contact school IT support'];
      break;
    case FeatureAccessState.ACCESS_CHECK_FAILED:
      eyebrow = 'UNABLE TO VERIFY ACCESS';
      title = 'Verification Offline';
      desc = 'Unable to securely verify your feature entitlement. Check network connection and retry.';
      benefits = ['Offline mode enabled', 'No billing charges incurred', 'Local cache active'];
      break;
    default:
      break;
  }

  // 2. Role-Sensitive Actions
  const actions = [];
  const isAdmin = ['admin', 'principal'].includes(normalizedRole);
  const isFaculty = ['teacher', 'staff', 'accountant'].includes(normalizedRole);
  const isFamily = ['parent', 'student'].includes(normalizedRole);

  if (state === FeatureAccessState.PLAN_REQUIRED) {
    if (isAdmin) {
      actions.push({ type: 'UPGRADE_PLAN', label: 'View Upgrade Options', variant: 'primary' });
      actions.push({ type: 'CONTACT_SUPPORT', label: 'Contact NexSyrus Support', variant: 'secondary' });
    } else if (isFaculty) {
      actions.push({ type: 'ASK_ADMIN', label: 'Ask Administrator', variant: 'primary' });
      actions.push({ type: 'GO_HOME', label: 'Go to Dashboard', variant: 'secondary' });
    } else {
      actions.push({ type: 'ASK_ADMIN', label: 'Ask Your School', variant: 'primary' });
      actions.push({ type: 'GO_HOME', label: 'Go to Dashboard', variant: 'secondary' });
    }
    actions.push({ type: 'GO_BACK', label: 'Go Back', variant: 'ghost' });
  } else if (state === FeatureAccessState.COMING_SOON) {
    actions.push({ type: 'NOTIFY_ME', label: 'Notify Me', variant: 'primary' });
    actions.push({ type: 'GO_HOME', label: 'Go to Dashboard', variant: 'secondary' });
  } else if (state === FeatureAccessState.BETA) {
    actions.push({ type: 'REQUEST_EARLY_ACCESS', label: 'Request Early Access', variant: 'primary' });
    actions.push({ type: 'GO_HOME', label: 'Go to Dashboard', variant: 'secondary' });
  } else if (state === FeatureAccessState.FEATURE_DISABLED || state === FeatureAccessState.ADMIN_APPROVAL_REQUIRED) {
    actions.push({ type: 'ASK_ADMIN', label: isFamily ? 'Ask Your School' : 'Ask Administrator', variant: 'primary' });
    actions.push({ type: 'GO_HOME', label: 'Go to Dashboard', variant: 'secondary' });
  } else if (state === FeatureAccessState.PERMISSION_DENIED) {
    actions.push({ type: 'GO_HOME', label: 'Go to Dashboard', variant: 'primary' });
    actions.push({ type: 'GO_BACK', label: 'Go Back', variant: 'secondary' });
  } else if (state === FeatureAccessState.INVALID_ROUTE) {
    actions.push({ type: 'GO_HOME', label: 'Go to Dashboard', variant: 'primary' });
    actions.push({ type: 'GO_BACK', label: 'Go Back', variant: 'secondary' });
  } else if (state === FeatureAccessState.ACCESS_CHECK_FAILED) {
    actions.push({ type: 'RETRY', label: 'Retry Verification', variant: 'primary' });
    actions.push({ type: 'GO_HOME', label: 'Go to Dashboard', variant: 'secondary' });
  } else if (state === FeatureAccessState.MAINTENANCE || state === FeatureAccessState.TEMPORARILY_UNAVAILABLE) {
    actions.push({ type: 'GO_HOME', label: 'Return to Dashboard', variant: 'primary' });
    actions.push({ type: 'RETRY', label: 'Check Again', variant: 'secondary' });
  }

  return {
    allowed: Boolean(allowed),
    state,
    feature: {
      key,
      name,
      description,
      category,
      hero,
    },
    subscription: subscription || { currentPlan: 'standard', requiredPlan: 'standard' },
    ui: {
      eyebrow,
      title,
      description: desc,
      benefits,
    },
    actions,
    reason,
  };
}

/**
 * Handle "Ask Administrator" workflow with deduplication.
 */
export async function requestFeatureAccess({ schoolId, userId, role, userName, featureKey, requestMessage }) {
  if (!schoolId || !userId || !featureKey) {
    throw new Error('schoolId, userId, and featureKey are required');
  }

  // 1. Check for existing active pending request
  const [existing] = await sql`
    SELECT id, created_at
    FROM public.feature_access_requests
    WHERE school_id = ${schoolId} AND feature_key = ${featureKey} AND requested_by = ${userId} AND status = 'PENDING'
    LIMIT 1
  `;

  if (existing) {
    return {
      alreadyRequested: true,
      requestId: existing.id,
      message: 'Request already submitted. Your school administrator has been notified.',
      createdAt: existing.created_at,
    };
  }

  // 2. Insert new request
  const [newRequest] = await sql`
    INSERT INTO public.feature_access_requests (
      school_id, feature_key, requested_by, user_role, user_name, request_message, status
    ) VALUES (
      ${schoolId}, ${featureKey}, ${userId}, ${role || 'staff'}, ${userName || null}, ${requestMessage || null}, 'PENDING'
    )
    RETURNING id, created_at
  `;

  // 3. Log audit event
  await sql`
    INSERT INTO public.feature_access_audit_logs (
      school_id, user_id, feature_key, action, metadata
    ) VALUES (
      ${schoolId}, ${userId}, ${featureKey}, 'ACCESS_REQUEST_SUBMITTED', ${sql.json({ requestId: newRequest.id, role })}
    )
  `;

  return {
    alreadyRequested: false,
    requestId: newRequest.id,
    message: 'Access request submitted successfully to school administration.',
    createdAt: newRequest.created_at,
  };
}

/**
 * Handle "Notify Me" subscription with deduplication.
 */
export async function subscribeFeatureNotification({ schoolId, userId, featureKey }) {
  if (!schoolId || !userId || !featureKey) {
    throw new Error('schoolId, userId, and featureKey are required');
  }

  const [existing] = await sql`
    SELECT id, created_at
    FROM public.feature_notification_subscriptions
    WHERE school_id = ${schoolId} AND user_id = ${userId} AND feature_key = ${featureKey}
    LIMIT 1
  `;

  if (existing) {
    return {
      alreadySubscribed: true,
      message: "You're already on the list. We'll notify you as soon as this feature launches.",
    };
  }

  await sql`
    INSERT INTO public.feature_notification_subscriptions (school_id, user_id, feature_key)
    VALUES (${schoolId}, ${userId}, ${featureKey})
    ON CONFLICT (school_id, user_id, feature_key) DO NOTHING
  `;

  return {
    alreadySubscribed: false,
    message: "You're on the list! We'll notify you when this feature becomes available.",
  };
}

/**
 * Fetch all feature entitlements for caller (used for client-side pre-caching).
 */
export async function getAllFeatureEntitlements(schoolId, userId, role) {
  const { featuresByKey } = await getCachedRegistry();
  const featureKeys = Array.from(featuresByKey.keys());

  const entries = await Promise.all(
    featureKeys.map(async (key) => {
      const res = await resolveFeatureAccess({ schoolId, userId, role, featureKey: key });
      return [
        key,
        {
          allowed: res.allowed,
          state: res.state,
          requiredPlan: res.subscription?.requiredPlan,
        },
      ];
    })
  );

  return {
    schoolId,
    role,
    features: Object.fromEntries(entries),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Admin view: Fetch pending feature access requests.
 */
export async function getAdminFeatureAccessRequests(schoolId) {
  return sql`
    SELECT r.id, r.feature_key, f.name as feature_name, r.requested_by, r.user_role,
           r.user_name, r.status, r.request_message, r.created_at
    FROM public.feature_access_requests r
    LEFT JOIN public.features f ON f.key = r.feature_key
    WHERE r.school_id = ${schoolId}
    ORDER BY r.created_at DESC
    LIMIT 100
  `;
}

/**
 * Admin response: Approve or Reject a feature access request.
 */
export async function respondToFeatureAccessRequest({ schoolId, requestId, status, reviewedBy }) {
  if (!['APPROVED', 'REJECTED'].includes(status)) {
    throw new Error("Status must be 'APPROVED' or 'REJECTED'");
  }

  const [req] = await sql`
    SELECT * FROM public.feature_access_requests
    WHERE id = ${requestId} AND school_id = ${schoolId}
    LIMIT 1
  `;
  if (!req) {
    throw new Error('Access request not found');
  }

  const [updated] = await sql`
    UPDATE public.feature_access_requests
    SET status = ${status}, reviewed_at = NOW(), reviewed_by = ${reviewedBy}
    WHERE id = ${requestId} AND school_id = ${schoolId}
    RETURNING *
  `;

  // If approved, create user override
  if (status === 'APPROVED') {
    await sql`
      INSERT INTO public.user_feature_overrides (
        school_id, user_id, feature_key, enabled, reason, granted_by
      ) VALUES (
        ${schoolId}, ${req.requested_by}, ${req.feature_key}, true, 'Administrator approved access request', ${reviewedBy}
      )
      ON CONFLICT (school_id, user_id, feature_key)
      DO UPDATE SET enabled = true, updated_at = NOW()
    `;
  }

  // Audit log
  await sql`
    INSERT INTO public.feature_access_audit_logs (
      school_id, user_id, feature_key, action, metadata
    ) VALUES (
      ${schoolId}, ${req.requested_by}, ${req.feature_key}, ${'REQUEST_' + status}, ${sql.json({ requestId, reviewedBy })}
    )
  `;

  return updated;
}

function formatFeatureName(key) {
  return key
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getDefaultBenefitsForCategory(category) {
  switch (category) {
    case 'intelligence':
      return ['Advanced performance telemetry', 'Executive cohort tracking', 'Automated outlier detection'];
    case 'security':
      return ['Real-time gatekeeper verification', 'Campus digital badges', 'Automated security notifications'];
    case 'finance':
      return ['Automated collection reminders', 'Audited digital receipt ledger', 'Real-time realization metrics'];
    case 'academics':
      return ['Streamlined curriculum workflows', 'Comprehensive progress records', 'Teacher-parent collaboration'];
    default:
      return ['Institutional efficiency', 'Secure multi-tenant data', 'Automated notification alerts'];
  }
}
