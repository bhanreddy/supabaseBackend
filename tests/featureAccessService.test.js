import test from 'node:test';
import assert from 'node:assert/strict';
import sql from '../db.js';
import {
  FeatureAccessState,
  resolveFeatureAccess,
  buildResolutionResponse,
  requestFeatureAccess,
  subscribeFeatureNotification,
  getAllFeatureEntitlements,
  getCachedRegistry,
  invalidateRegistryCache,
} from '../services/featureAccessService.js';

test('Feature Access: returns INVALID_ROUTE for unknown feature keys', async () => {
  const result = await resolveFeatureAccess({
    schoolId: 1,
    userId: '984f8a31-a135-465f-ab88-211e1157b341',
    role: 'admin',
    featureKey: 'non_existent_future_module_xyz',
  });

  assert.equal(result.allowed, false);
  assert.equal(result.state, FeatureAccessState.INVALID_ROUTE);
  assert.equal(result.ui.eyebrow, 'PAGE NOT FOUND');
  assert.ok(result.actions.some((a) => a.type === 'GO_HOME'));
});

test('Feature Access: allows core features for standard plan schools', async () => {
  // school 1 has standard plan
  const result = await resolveFeatureAccess({
    schoolId: 1,
    userId: '984f8a31-a135-465f-ab88-211e1157b341',
    role: 'admin',
    featureKey: 'attendance',
  });

  assert.equal(result.allowed, true);
  assert.equal(result.state, FeatureAccessState.ALLOWED);
  assert.equal(result.feature.key, 'attendance');
});

test('Feature Access: requires upgrade (PLAN_REQUIRED) for premium feature when on standard plan', async () => {
  // 'analytics' requires 'premium' plan
  const result = await resolveFeatureAccess({
    schoolId: 1, // standard plan
    userId: '984f8a31-a135-465f-ab88-211e1157b341',
    role: 'admin',
    featureKey: 'analytics',
  });

  assert.equal(result.allowed, false);
  assert.equal(result.state, FeatureAccessState.PLAN_REQUIRED);
  assert.equal(result.ui.eyebrow, 'PREMIUM CAPABILITY');
  assert.equal(result.subscription.requiredPlan, 'premium');
  assert.ok(result.actions.some((a) => a.type === 'UPGRADE_PLAN'));
});

test('Feature Access: role-sensitive messaging adapts actions to caller role', async () => {
  // Admin role gets UPGRADE_PLAN
  const adminRes = await resolveFeatureAccess({
    schoolId: 1,
    userId: '984f8a31-a135-465f-ab88-211e1157b341',
    role: 'admin',
    featureKey: 'visitor_management',
  });
  assert.ok(adminRes.actions.some((a) => a.type === 'UPGRADE_PLAN'));
  assert.ok(!adminRes.actions.some((a) => a.type === 'ASK_ADMIN'));

  // Teacher role gets ASK_ADMIN ("Ask Administrator")
  const teacherRes = await resolveFeatureAccess({
    schoolId: 1,
    userId: '984f8a31-a135-465f-ab88-211e1157b341',
    role: 'teacher',
    featureKey: 'visitor_management',
  });
  assert.ok(!teacherRes.actions.some((a) => a.type === 'UPGRADE_PLAN'));
  const askAdminAction = teacherRes.actions.find((a) => a.type === 'ASK_ADMIN');
  assert.ok(askAdminAction);
  assert.equal(askAdminAction.label, 'Ask Administrator');

  // Parent role gets ASK_ADMIN with label "Ask Your School"
  const parentRes = await resolveFeatureAccess({
    schoolId: 1,
    userId: '984f8a31-a135-465f-ab88-211e1157b341',
    role: 'parent',
    featureKey: 'academic_planning',
  });
  const askSchoolAction = parentRes.actions.find((a) => a.type === 'ASK_ADMIN');
  assert.ok(askSchoolAction);
  assert.equal(askSchoolAction.label, 'Ask Your School');
});

test('Feature Access: school override disabled turns an allowed feature into FEATURE_DISABLED', async () => {
  const schoolId = 1;
  const featureKey = 'fees';

  // 1. Insert temporary school override disabling fees
  await sql`
    INSERT INTO public.school_feature_overrides (school_id, feature_key, enabled, reason)
    VALUES (${schoolId}, ${featureKey}, false, 'School accountant disabled digital fees')
    ON CONFLICT (school_id, feature_key) DO UPDATE SET enabled = false
  `;

  try {
    const result = await resolveFeatureAccess({
      schoolId,
      userId: '984f8a31-a135-465f-ab88-211e1157b341',
      role: 'admin',
      featureKey,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.state, FeatureAccessState.FEATURE_DISABLED);
    assert.equal(result.ui.eyebrow, 'FEATURE UNAVAILABLE');
  } finally {
    // Clean up override
    await sql`
      DELETE FROM public.school_feature_overrides
      WHERE school_id = ${schoolId} AND feature_key = ${featureKey}
    `;
  }
});

test('Feature Access: user override allow grants access even if plan restricts it', async () => {
  const schoolId = 1; // standard plan
  const userId = '984f8a31-a135-465f-ab88-211e1157b341';
  const featureKey = 'analytics'; // premium feature

  // 1. Insert user override allowing access
  await sql`
    INSERT INTO public.user_feature_overrides (school_id, user_id, feature_key, enabled, reason)
    VALUES (${schoolId}, ${userId}, ${featureKey}, true, 'Special pilot grant')
    ON CONFLICT (school_id, user_id, feature_key) DO UPDATE SET enabled = true
  `;

  try {
    const result = await resolveFeatureAccess({
      schoolId,
      userId,
      role: 'admin',
      featureKey,
    });

    assert.equal(result.allowed, true);
    assert.equal(result.state, FeatureAccessState.ALLOWED);
  } finally {
    // Clean up
    await sql`
      DELETE FROM public.user_feature_overrides
      WHERE school_id = ${schoolId} AND user_id = ${userId} AND feature_key = ${featureKey}
    `;
  }
});

test('Feature Access: coming soon rollout state returns COMING_SOON with NOTIFY_ME action', async () => {
  const result = await resolveFeatureAccess({
    schoolId: 9999, // not in selected schools
    userId: '984f8a31-a135-465f-ab88-211e1157b341',
    role: 'teacher',
    featureKey: 'ai_anecdote', // rollout: SELECTED_SCHOOLS
  });

  assert.equal(result.allowed, false);
  assert.equal(result.state, FeatureAccessState.COMING_SOON);
  assert.equal(result.ui.eyebrow, 'COMING SOON');
  assert.ok(result.actions.some((a) => a.type === 'NOTIFY_ME'));
});

test('Feature Access: requestFeatureAccess creates pending request and prevents duplicates', async () => {
  const schoolId = 1;
  const userId = '984f8a31-a135-465f-ab88-211e1157b341';
  const featureKey = 'advanced_reports';

  // Clean up any prior test artifacts
  await sql`
    DELETE FROM public.feature_access_requests
    WHERE school_id = ${schoolId} AND user_id = ${userId} AND feature_key = ${featureKey}
  `.catch(() => {});
  await sql`
    DELETE FROM public.feature_access_requests
    WHERE school_id = ${schoolId} AND requested_by = ${userId} AND feature_key = ${featureKey}
  `;

  try {
    // First request should succeed with alreadyRequested: false
    const res1 = await requestFeatureAccess({
      schoolId,
      userId,
      role: 'teacher',
      userName: 'Anita Sharma',
      featureKey,
      requestMessage: 'Needed for annual board exam analysis',
    });

    assert.equal(res1.alreadyRequested, false);
    assert.ok(res1.requestId);

    // Second request with same user and feature should return alreadyRequested: true
    const res2 = await requestFeatureAccess({
      schoolId,
      userId,
      role: 'teacher',
      userName: 'Anita Sharma',
      featureKey,
      requestMessage: 'Duplicate submission check',
    });

    assert.equal(res2.alreadyRequested, true);
    assert.equal(res2.requestId, res1.requestId);
  } finally {
    await sql`
      DELETE FROM public.feature_access_requests
      WHERE school_id = ${schoolId} AND requested_by = ${userId} AND feature_key = ${featureKey}
    `;
  }
});

test('Feature Access: subscribeFeatureNotification creates subscription and handles duplicates', async () => {
  const schoolId = 1;
  const userId = '984f8a31-a135-465f-ab88-211e1157b341';
  const featureKey = 'ai_predictive_enrollment';

  await sql`
    DELETE FROM public.feature_notification_subscriptions
    WHERE school_id = ${schoolId} AND user_id = ${userId} AND feature_key = ${featureKey}
  `;

  try {
    const res1 = await subscribeFeatureNotification({
      schoolId,
      userId,
      featureKey,
    });
    assert.equal(res1.alreadySubscribed, false);

    const res2 = await subscribeFeatureNotification({
      schoolId,
      userId,
      featureKey,
    });
    assert.equal(res2.alreadySubscribed, true);
  } finally {
    await sql`
      DELETE FROM public.feature_notification_subscriptions
      WHERE school_id = ${schoolId} AND user_id = ${userId} AND feature_key = ${featureKey}
    `;
  }
});

test('Feature Access: getAllFeatureEntitlements resolves full map of school features', async () => {
  const entitlements = await getAllFeatureEntitlements(1, '984f8a31-a135-465f-ab88-211e1157b341', 'admin');

  assert.equal(entitlements.schoolId, 1);
  assert.ok(entitlements.features);
  assert.equal(typeof entitlements.features.attendance, 'object');
  assert.equal(entitlements.features.attendance.allowed, true);
  assert.equal(entitlements.features.analytics.allowed, false);
  assert.equal(entitlements.features.analytics.state, FeatureAccessState.PLAN_REQUIRED);
});
