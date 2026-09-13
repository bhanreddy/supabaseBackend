import sql from '../db.js';
import { randomUUID } from 'node:crypto';
import { sendNotificationToUsers } from './notificationService.js';
import { normalizeWebsiteGalleryImage } from '../utils/websiteGalleryImage.js';
import {
  actorUserId,
  normalizePortalText,
  uploadSchoolPortalImage,
  removeSchoolPortalImage,
} from '../utils/schoolPortalMedia.js';
import {
  ELIGIBLE_LIMIT,
  INBOX_LIMIT,
  MESSAGE_MAX,
  POPUP_CATEGORIES,
  POPUP_FREQUENCIES,
  POPUP_LAYOUTS,
  POPUP_PRIORITIES,
  TITLE_MAX,
  HEADING_MAX,
  UPDATE_MODES,
  actionAllowedForRoles,
  expandTargetRoles,
  httpError,
  isFrequencyEligible,
  isUuid,
  isWithinSchedule,
  mapRolesToGroups,
  normalizeButtons,
  normalizeCompletionCondition,
  normalizeTargeting,
  publicPopupPayload,
  resolveEffectiveStatus,
  sortPopupQueue,
  targetingHasAudience,
  userMatchesTargeting,
} from './popupConstants.js';

function missingRelation(error) {
  return error?.code === '42P01' || /does not exist/i.test(error?.message || '');
}

export function schoolPopupObjectPath(schoolId, imageId) {
  return `${schoolId}/popups/${imageId}.jpg`;
}

function parseSchoolId(schoolId) {
  const parsed = Number.parseInt(String(schoolId), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw httpError('Invalid school context', 403);
  return parsed;
}

function requireUserId(user) {
  const userId = actorUserId(user);
  if (!isUuid(userId)) throw httpError('Authenticated user is required', 401);
  return userId;
}

function emptyContext(userId, schoolId, roles = []) {
  return {
    userId: String(userId),
    schoolId,
    roles: roles.map((r) => String(r).toLowerCase()),
    roleGroups: mapRolesToGroups(roles),
    studentIds: [],
    classIds: [],
    sectionIds: [],
    staffId: null,
    routeIds: [],
    departmentIds: [],
  };
}

export async function loadUserTargetingContext(schoolId, user) {
  const userId = requireUserId(user);
  const roles = user?.roles || [];
  const ctx = emptyContext(userId, schoolId, roles);

  const tasks = [];
  if (roles.some((r) => ['parent', 'student'].includes(r))) {
    tasks.push((async () => {
      const rows = await sql`
        SELECT s.id AS student_id, cs.class_id, cs.section_id, st.route_id
        FROM users u
        JOIN students s ON s.person_id = u.person_id AND s.school_id = u.school_id
        LEFT JOIN student_enrollments se
          ON se.student_id = s.id AND se.school_id = s.school_id AND se.status = 'active'
        LEFT JOIN class_sections cs
          ON cs.id = se.class_section_id AND cs.school_id = s.school_id
        LEFT JOIN student_transport st
          ON st.student_id = s.id AND st.school_id = s.school_id AND st.is_active = TRUE
        WHERE u.id = ${userId} AND u.school_id = ${schoolId}

        UNION

        SELECT s.id AS student_id, cs.class_id, cs.section_id, st.route_id
        FROM users u
        JOIN parents p ON p.person_id = u.person_id AND p.school_id = u.school_id
        JOIN student_parents sp
          ON sp.parent_id = p.id AND sp.school_id = p.school_id AND sp.deleted_at IS NULL
        JOIN students s ON s.id = sp.student_id AND s.school_id = p.school_id
        LEFT JOIN student_enrollments se
          ON se.student_id = s.id AND se.school_id = s.school_id AND se.status = 'active'
        LEFT JOIN class_sections cs
          ON cs.id = se.class_section_id AND cs.school_id = s.school_id
        LEFT JOIN student_transport st
          ON st.student_id = s.id AND st.school_id = s.school_id AND st.is_active = TRUE
        WHERE u.id = ${userId} AND u.school_id = ${schoolId}
      `;
      for (const row of rows) {
        if (row.student_id) ctx.studentIds.push(String(row.student_id));
        if (row.class_id) ctx.classIds.push(String(row.class_id));
        if (row.section_id) ctx.sectionIds.push(String(row.section_id));
        if (row.route_id) ctx.routeIds.push(String(row.route_id));
      }
    })());
  }

  if (roles.some((r) => ['staff', 'teacher', 'admin', 'principal', 'driver', 'accounts', 'accountant'].includes(r))) {
    tasks.push((async () => {
      const rows = await sql`
        SELECT st.id AS staff_id, cs.class_id, cs.section_id, dra.route_id, b.route_id AS bus_route_id
        FROM users u
        JOIN staff st ON st.person_id = u.person_id AND st.school_id = u.school_id AND st.deleted_at IS NULL
        LEFT JOIN class_sections cs
          ON cs.class_teacher_id = st.id AND cs.school_id = st.school_id
        LEFT JOIN driver_route_assignments dra
          ON dra.driver_id = st.id AND dra.school_id = st.school_id
         AND dra.deleted_at IS NULL AND dra.is_active = TRUE
        LEFT JOIN buses b
          ON b.driver_id = st.id AND b.school_id = st.school_id AND b.deleted_at IS NULL
        WHERE u.id = ${userId} AND u.school_id = ${schoolId}
      `;
      for (const row of rows) {
        if (row.staff_id) ctx.staffId = String(row.staff_id);
        if (row.class_id) ctx.classIds.push(String(row.class_id));
        if (row.section_id) ctx.sectionIds.push(String(row.section_id));
        if (row.route_id) ctx.routeIds.push(String(row.route_id));
        if (row.bus_route_id) ctx.routeIds.push(String(row.bus_route_id));
      }
    })());
  }

  await Promise.all(tasks);
  ctx.studentIds = [...new Set(ctx.studentIds)];
  ctx.classIds = [...new Set(ctx.classIds)];
  ctx.sectionIds = [...new Set(ctx.sectionIds)];
  ctx.routeIds = [...new Set(ctx.routeIds)];
  return ctx;
}

async function feePendingForStudents(schoolId, studentIds = []) {
  if (!studentIds.length) return false;
  const [row] = await sql`
    SELECT EXISTS (
      SELECT 1
      FROM student_fees sf
      WHERE sf.school_id = ${schoolId}
        AND sf.student_id = ANY(${sql.array(studentIds)}::uuid[])
        AND sf.deleted_at IS NULL
        AND GREATEST(sf.amount_due - COALESCE(sf.discount, 0) - COALESCE(sf.amount_paid, 0), 0) > 0
    ) AS pending
  `;
  return Boolean(row?.pending);
}

async function completionResolved(popup, ctx) {
  const type = popup?.completion_condition?.type || 'NONE';
  if (type === 'FEE_PENDING') {
    const targeted = popup.targeting?.student_ids?.length
      ? ctx.studentIds.filter((id) => popup.targeting.student_ids.includes(id))
      : ctx.studentIds;
    if (!targeted.length) return false;
    return !(await feePendingForStudents(ctx.schoolId, targeted));
  }
  return false;
}

async function loadActiveCandidates(schoolId) {
  return sql`
    SELECT
      id, school_id, title, heading, message, category, priority, layout_type,
      image_url, icon, status, frequency, start_at, end_at, allow_dismiss,
      require_acknowledgement, update_mode, targeting, buttons, completion_condition,
      published_at, created_at
    FROM popups
    WHERE school_id = ${schoolId}
      AND deleted_at IS NULL
      AND status IN ('ACTIVE', 'SCHEDULED', 'PAUSED')
      AND published_at IS NOT NULL
    ORDER BY
      CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
      start_at ASC
    LIMIT 80
  `;
}

async function loadStatesByPopupIds(schoolId, userId, popupIds) {
  if (!popupIds.length) return new Map();
  const rows = await sql`
    SELECT *
    FROM popup_user_states
    WHERE school_id = ${schoolId}
      AND user_id = ${userId}
      AND popup_id = ANY(${sql.array(popupIds)}::uuid[])
  `;
  return new Map(rows.map((row) => [String(row.popup_id), row]));
}

async function recordEvent(schoolId, popupId, userId, eventType, { actionType = null, isTest = false, metadata = {} } = {}) {
  await sql`
    INSERT INTO popup_events (school_id, popup_id, user_id, event_type, action_type, is_test, metadata)
    VALUES (${schoolId}, ${popupId}, ${userId}, ${eventType}, ${actionType}, ${isTest}, ${sql.json(metadata)})
  `;
}

async function upsertState(schoolId, popupId, userId, patchSql) {
  await sql`
    INSERT INTO popup_user_states (school_id, popup_id, user_id)
    VALUES (${schoolId}, ${popupId}, ${userId})
    ON CONFLICT (school_id, popup_id, user_id) DO NOTHING
  `;
  const [row] = await patchSql;
  return row;
}

export async function listEligiblePopups(schoolId, user, { sessionId = null, timeZone = 'Asia/Kolkata' } = {}) {
  const parsedSchoolId = parseSchoolId(schoolId);
  const userId = requireUserId(user);
  const now = new Date();

  try {
    const [ctx, candidates, testRows] = await Promise.all([
      loadUserTargetingContext(parsedSchoolId, user),
      loadActiveCandidates(parsedSchoolId),
      sql`
        SELECT pus.popup_id, pus.test_queued_at, pus.dismissed_at, pus.acknowledged_at, pus.is_test
        FROM popup_user_states pus
        JOIN popups p ON p.id = pus.popup_id AND p.school_id = pus.school_id
        WHERE pus.school_id = ${parsedSchoolId}
          AND pus.user_id = ${userId}
          AND pus.is_test = TRUE
          AND pus.test_queued_at IS NOT NULL
          AND p.deleted_at IS NULL
      `,
    ]);

    const testIds = new Set(testRows.map((row) => String(row.popup_id)));
    const extraTests = testIds.size
      ? await sql`
          SELECT
            id, school_id, title, heading, message, category, priority, layout_type,
            image_url, icon, status, frequency, start_at, end_at, allow_dismiss,
            require_acknowledgement, update_mode, targeting, buttons, completion_condition,
            published_at, created_at
          FROM popups
          WHERE school_id = ${parsedSchoolId}
            AND deleted_at IS NULL
            AND id = ANY(${sql.array([...testIds])}::uuid[])
        `
      : [];

    const byId = new Map();
    for (const popup of [...candidates, ...extraTests]) byId.set(String(popup.id), popup);
    const popupIds = [...byId.keys()];
    const states = await loadStatesByPopupIds(parsedSchoolId, userId, popupIds);

    const eligible = [];
    for (const popup of byId.values()) {
      const state = states.get(String(popup.id));
      const isTest = Boolean(state?.is_test && state?.test_queued_at);
      if (!isTest) {
        const status = resolveEffectiveStatus(popup, now);
        if (status !== 'ACTIVE') continue;
        if (!isWithinSchedule(popup, now)) continue;
        if (!userMatchesTargeting(ctx, popup.targeting)) continue;
      }
      const actionCompleted = popup.frequency === 'UNTIL_ACTION_COMPLETED'
        ? await completionResolved(popup, ctx)
        : false;
      if (!isFrequencyEligible(popup, state, { now, sessionId, timeZone, actionCompleted })) continue;
      eligible.push({
        ...publicPopupPayload(popup, { is_test: isTest }),
        _sort: popup,
      });
    }

    const ranked = sortPopupQueue(eligible.map((item) => ({ ...item._sort, ...item }))).slice(0, ELIGIBLE_LIMIT);
    return ranked.map(({ _sort, ...item }) => item);
  } catch (error) {
    if (missingRelation(error)) return [];
    throw error;
  }
}

export async function listInbox(schoolId, user, { unreadOnly = false, limit = INBOX_LIMIT } = {}) {
  const parsedSchoolId = parseSchoolId(schoolId);
  const userId = requireUserId(user);
  const safeLimit = Math.min(Math.max(Number(limit) || INBOX_LIMIT, 1), 100);
  const ctx = await loadUserTargetingContext(parsedSchoolId, user);
  const now = new Date();

  const popups = await sql`
    SELECT
      p.id, p.title, p.heading, p.message, p.category, p.priority, p.layout_type,
      p.image_url, p.icon, p.status, p.frequency, p.start_at, p.end_at, p.allow_dismiss,
      p.require_acknowledgement, p.update_mode, p.targeting, p.buttons, p.published_at,
      p.created_at, pus.first_seen_at, pus.acknowledged_at, pus.dismissed_at,
      pus.inbox_read_at, pus.completed_at, pus.is_test
    FROM popups p
    LEFT JOIN popup_user_states pus
      ON pus.popup_id = p.id AND pus.school_id = p.school_id AND pus.user_id = ${userId}
    WHERE p.school_id = ${parsedSchoolId}
      AND p.deleted_at IS NULL
      AND p.published_at IS NOT NULL
      AND p.status IN ('ACTIVE', 'SCHEDULED', 'PAUSED', 'EXPIRED')
      AND COALESCE(pus.is_test, FALSE) = FALSE
    ORDER BY p.start_at DESC, p.created_at DESC
    LIMIT 120
  `;

  const items = [];
  for (const popup of popups) {
    if (!userMatchesTargeting(ctx, popup.targeting)) continue;
    const status = resolveEffectiveStatus(popup, now);
    if (!['ACTIVE', 'EXPIRED', 'PAUSED'].includes(status) && !popup.first_seen_at) continue;
    const unread = !popup.inbox_read_at && !popup.acknowledged_at;
    if (unreadOnly && !unread) continue;
    items.push({
      ...publicPopupPayload(popup),
      status,
      first_seen_at: popup.first_seen_at,
      acknowledged_at: popup.acknowledged_at,
      dismissed_at: popup.dismissed_at,
      completed_at: popup.completed_at,
      inbox_read_at: popup.inbox_read_at,
      unread,
    });
    if (items.length >= safeLimit) break;
  }
  return items;
}

export async function unreadCount(schoolId, user) {
  const items = await listInbox(schoolId, user, { unreadOnly: true, limit: 50 });
  return items.filter((item) => item.unread && resolveEffectiveStatus(item) !== 'PAUSED').length;
}

async function loadOwnedPopup(schoolId, popupId, { includeDeleted = false } = {}) {
  if (!isUuid(popupId)) throw httpError('Popup not found', 404);
  const [popup] = await sql`
    SELECT *
    FROM popups
    WHERE id = ${popupId}
      AND school_id = ${schoolId}
      ${includeDeleted ? sql`` : sql`AND deleted_at IS NULL`}
    LIMIT 1
  `;
  if (!popup) throw httpError('Popup not found', 404);
  return popup;
}

export async function assertPopupAccessible(schoolId, popupId, user, { allowTest = true } = {}) {
  const popup = await loadOwnedPopup(schoolId, popupId);
  const ctx = await loadUserTargetingContext(schoolId, user);
  const userId = requireUserId(user);
  const [state] = await sql`
    SELECT * FROM popup_user_states
    WHERE school_id = ${schoolId} AND popup_id = ${popupId} AND user_id = ${userId}
  `;
  const isTest = Boolean(allowTest && state?.is_test && state?.test_queued_at);
  if (!isTest && !userMatchesTargeting(ctx, popup.targeting)) {
    throw httpError('Popup not found', 404);
  }
  return { popup, ctx, state, userId, isTest };
}

export async function markPopupViewed(schoolId, popupId, user, { sessionId = null } = {}) {
  const parsedSchoolId = parseSchoolId(schoolId);
  const { popup, state, userId, isTest } = await assertPopupAccessible(parsedSchoolId, popupId, user);
  if (state?.first_seen_at && popup.frequency === 'SHOW_ONCE' && !isTest) {
    return { viewed: true, duplicate: true };
  }
  const row = await upsertState(parsedSchoolId, popupId, userId, sql`
    UPDATE popup_user_states
    SET
      first_seen_at = COALESCE(first_seen_at, NOW()),
      last_seen_at = NOW(),
      last_displayed_at = NOW(),
      last_session_id = COALESCE(${sessionId || null}, last_session_id),
      view_count = view_count + 1
    WHERE school_id = ${parsedSchoolId} AND popup_id = ${popupId} AND user_id = ${userId}
    RETURNING *
  `);
  await recordEvent(parsedSchoolId, popupId, userId, 'POPUP_VIEWED', { isTest });
  return { viewed: true, duplicate: Boolean(state?.first_seen_at), state: row };
}

export async function markPopupClicked(schoolId, popupId, user, { actionType = null, target = null } = {}) {
  const parsedSchoolId = parseSchoolId(schoolId);
  const { popup, userId, isTest } = await assertPopupAccessible(parsedSchoolId, popupId, user);
  const roles = user?.roles || [];
  if (actionType && !actionAllowedForRoles(actionType, target, roles) && !['ACKNOWLEDGE', 'DISMISS', 'NONE'].includes(actionType)) {
    throw httpError('This action is not available for your role', 403);
  }
  const row = await upsertState(parsedSchoolId, popupId, userId, sql`
    UPDATE popup_user_states
    SET
      clicked_at = COALESCE(clicked_at, NOW()),
      click_count = click_count + 1,
      last_action_type = COALESCE(${actionType || null}, last_action_type)
    WHERE school_id = ${parsedSchoolId} AND popup_id = ${popupId} AND user_id = ${userId}
    RETURNING *
  `);
  await recordEvent(parsedSchoolId, popupId, userId, 'POPUP_CLICKED', { actionType, isTest, metadata: { target } });
  return { clicked: true, popup_id: popup.id, state: row };
}

export async function markPopupDismissed(schoolId, popupId, user) {
  const parsedSchoolId = parseSchoolId(schoolId);
  const { popup, state, userId, isTest } = await assertPopupAccessible(parsedSchoolId, popupId, user);
  if (!popup.allow_dismiss && popup.require_acknowledgement && !isTest) {
    throw httpError('This popup must be acknowledged', 409);
  }
  if (state?.dismissed_at && popup.frequency === 'SHOW_ONCE') {
    return { dismissed: true, duplicate: true };
  }
  const row = await upsertState(parsedSchoolId, popupId, userId, sql`
    UPDATE popup_user_states
    SET
      dismissed_at = COALESCE(dismissed_at, NOW()),
      first_seen_at = COALESCE(first_seen_at, NOW()),
      last_seen_at = NOW(),
      test_queued_at = CASE WHEN is_test THEN NULL ELSE test_queued_at END
    WHERE school_id = ${parsedSchoolId} AND popup_id = ${popupId} AND user_id = ${userId}
    RETURNING *
  `);
  await recordEvent(parsedSchoolId, popupId, userId, 'POPUP_DISMISSED', { isTest });
  return { dismissed: true, duplicate: Boolean(state?.dismissed_at), state: row };
}

export async function markPopupAcknowledged(schoolId, popupId, user) {
  const parsedSchoolId = parseSchoolId(schoolId);
  const { state, userId, isTest } = await assertPopupAccessible(parsedSchoolId, popupId, user);
  const row = await upsertState(parsedSchoolId, popupId, userId, sql`
    UPDATE popup_user_states
    SET
      acknowledged_at = COALESCE(acknowledged_at, NOW()),
      first_seen_at = COALESCE(first_seen_at, NOW()),
      last_seen_at = NOW(),
      inbox_read_at = COALESCE(inbox_read_at, NOW()),
      test_queued_at = CASE WHEN is_test THEN NULL ELSE test_queued_at END
    WHERE school_id = ${parsedSchoolId} AND popup_id = ${popupId} AND user_id = ${userId}
    RETURNING *
  `);
  if (!state?.acknowledged_at) {
    await recordEvent(parsedSchoolId, popupId, userId, 'POPUP_ACKNOWLEDGED', { isTest });
  }
  return { acknowledged: true, duplicate: Boolean(state?.acknowledged_at), state: row };
}

export async function markInboxRead(schoolId, popupId, user) {
  const parsedSchoolId = parseSchoolId(schoolId);
  const { userId } = await assertPopupAccessible(parsedSchoolId, popupId, user);
  await upsertState(parsedSchoolId, popupId, userId, sql`
    UPDATE popup_user_states
    SET inbox_read_at = COALESCE(inbox_read_at, NOW())
    WHERE school_id = ${parsedSchoolId} AND popup_id = ${popupId} AND user_id = ${userId}
    RETURNING *
  `);
  return { read: true };
}

function normalizePopupInput(body = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || body.title != null) {
    const title = normalizePortalText(body.title, TITLE_MAX);
    if (!title) throw httpError('Popup title is required.');
    out.title = title;
  }
  if (!partial || body.heading != null) {
    out.heading = body.heading == null || body.heading === ''
      ? null
      : normalizePortalText(body.heading, HEADING_MAX);
  }
  if (!partial || body.message != null) {
    const message = String(body.message || '').trim();
    if (!message) throw httpError('Popup message is required.');
    if (message.length > MESSAGE_MAX) throw httpError(`Message must be ${MESSAGE_MAX} characters or fewer.`);
    out.message = message;
  }
  if (!partial || body.category != null) {
    const category = String(body.category || 'INFORMATION').toUpperCase();
    if (!POPUP_CATEGORIES.includes(category)) throw httpError('Invalid popup category.');
    out.category = category;
  }
  if (!partial || body.priority != null) {
    const priority = String(body.priority || 'NORMAL').toUpperCase();
    if (!POPUP_PRIORITIES.includes(priority)) throw httpError('Invalid popup priority.');
    out.priority = priority;
  }
  if (!partial || body.layout_type != null || body.layoutType != null) {
    const layout = String(body.layout_type || body.layoutType || 'STANDARD').toUpperCase();
    if (!POPUP_LAYOUTS.includes(layout)) throw httpError('Invalid popup layout.');
    out.layout_type = layout;
  }
  if (!partial || body.frequency != null) {
    const frequency = String(body.frequency || 'SHOW_ONCE').toUpperCase();
    if (!POPUP_FREQUENCIES.includes(frequency)) throw httpError('Invalid popup frequency.');
    out.frequency = frequency;
  }
  if (!partial || body.update_mode != null || body.updateMode != null) {
    const updateMode = String(body.update_mode || body.updateMode || 'NONE').toUpperCase();
    if (!UPDATE_MODES.includes(updateMode)) throw httpError('Invalid update mode.');
    out.update_mode = updateMode;
  }
  if (!partial || body.start_at != null || body.startAt != null) {
    const start = new Date(body.start_at || body.startAt || Date.now());
    if (Number.isNaN(start.getTime())) throw httpError('Invalid start date.');
    out.start_at = start.toISOString();
  }
  if (!partial || body.end_at != null || body.endAt != null) {
    const raw = body.end_at ?? body.endAt;
    if (raw == null || raw === '') out.end_at = null;
    else {
      const end = new Date(raw);
      if (Number.isNaN(end.getTime())) throw httpError('Invalid end date.');
      out.end_at = end.toISOString();
    }
  }
  if (out.start_at && out.end_at && new Date(out.end_at) <= new Date(out.start_at)) {
    throw httpError('End date must be after start date.');
  }
  if (!partial || body.allow_dismiss != null || body.allowDismiss != null) {
    out.allow_dismiss = body.allow_dismiss ?? body.allowDismiss ?? true;
  }
  if (!partial || body.require_acknowledgement != null || body.requireAcknowledgement != null) {
    out.require_acknowledgement = body.require_acknowledgement ?? body.requireAcknowledgement ?? false;
  }
  if (!partial || body.send_push != null || body.sendPush != null) {
    out.send_push = Boolean(body.send_push ?? body.sendPush);
  }
  if (!partial || body.icon != null) {
    out.icon = body.icon ? String(body.icon).trim().slice(0, 48) : null;
  }
  if (!partial || body.targeting != null) {
    out.targeting = normalizeTargeting(body.targeting);
  }
  if (!partial || body.buttons != null) {
    out.buttons = normalizeButtons(body.buttons);
  }
  if (!partial || body.completion_condition != null || body.completionCondition != null) {
    out.completion_condition = normalizeCompletionCondition(body.completion_condition || body.completionCondition);
  }
  if (out.frequency === 'UNTIL_ACKNOWLEDGED') out.require_acknowledgement = true;
  if (out.update_mode === 'FORCED_UPDATE') {
    out.allow_dismiss = false;
    out.require_acknowledgement = true;
  }
  return out;
}

function adminPopupPayload(popup, extras = {}) {
  return {
    ...popup,
    targeting: popup.targeting || {},
    buttons: popup.buttons || [],
    completion_condition: popup.completion_condition || { type: 'NONE' },
    effective_status: resolveEffectiveStatus(popup),
    ...extras,
  };
}

export async function listAdminPopups(schoolId, { status = null, search = '', page = 1, pageSize = 25 } = {}) {
  const parsedSchoolId = parseSchoolId(schoolId);
  const safePage = Math.max(Number(page) || 1, 1);
  const safeSize = Math.min(Math.max(Number(pageSize) || 25, 1), 100);
  const offset = (safePage - 1) * safeSize;
  const term = String(search || '').trim();

  const rows = await sql`
    SELECT
      p.*,
      pe.display_name AS created_by_email,
      (
        SELECT COUNT(*)::int FROM popup_user_states s
        WHERE s.popup_id = p.id AND s.school_id = p.school_id AND s.is_test = FALSE AND s.first_seen_at IS NOT NULL
      ) AS unique_views,
      (
        SELECT COALESCE(SUM(s.view_count), 0)::int FROM popup_user_states s
        WHERE s.popup_id = p.id AND s.school_id = p.school_id AND s.is_test = FALSE
      ) AS views,
      (
        SELECT COUNT(*)::int FROM popup_user_states s
        WHERE s.popup_id = p.id AND s.school_id = p.school_id AND s.is_test = FALSE AND s.clicked_at IS NOT NULL
      ) AS clicks,
      (
        SELECT COUNT(*)::int FROM popup_user_states s
        WHERE s.popup_id = p.id AND s.school_id = p.school_id AND s.is_test = FALSE AND s.acknowledged_at IS NOT NULL
      ) AS acknowledgements
    FROM popups p
    LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN persons pe ON pe.id = u.person_id
    WHERE p.school_id = ${parsedSchoolId}
      AND p.deleted_at IS NULL
      ${term ? sql`AND (p.title ILIKE ${'%' + term + '%'} OR p.message ILIKE ${'%' + term + '%'})` : sql``}
    ORDER BY p.updated_at DESC
    LIMIT ${safeSize + 50} OFFSET ${offset}
  `;

  const now = new Date();
  let items = rows.map((row) => adminPopupPayload(row, { effective_status: resolveEffectiveStatus(row, now) }));
  if (status && status !== 'all') {
    const wanted = String(status).toUpperCase();
    items = items.filter((item) => item.effective_status === wanted);
  }
  return {
    items: items.slice(0, safeSize),
    page: safePage,
    page_size: safeSize,
    has_more: items.length > safeSize,
  };
}

export async function getAdminPopup(schoolId, popupId) {
  const popup = await loadOwnedPopup(parseSchoolId(schoolId), popupId);
  return adminPopupPayload(popup);
}

export async function createPopup(schoolId, user, body = {}) {
  const parsedSchoolId = parseSchoolId(schoolId);
  const input = normalizePopupInput(body);
  const userId = actorUserId(user);
  const [item] = await sql`
    INSERT INTO popups (
      school_id, title, heading, message, category, priority, layout_type, icon,
      status, frequency, start_at, end_at, allow_dismiss, require_acknowledgement,
      send_push, update_mode, targeting, buttons, completion_condition, created_by, updated_by
    ) VALUES (
      ${parsedSchoolId}, ${input.title}, ${input.heading}, ${input.message}, ${input.category},
      ${input.priority}, ${input.layout_type}, ${input.icon}, 'DRAFT', ${input.frequency},
      ${input.start_at}, ${input.end_at}, ${input.allow_dismiss}, ${input.require_acknowledgement},
      ${input.send_push}, ${input.update_mode}, ${sql.json(input.targeting)}, ${sql.json(input.buttons)},
      ${sql.json(input.completion_condition)}, ${userId}, ${userId}
    )
    RETURNING *
  `;
  return adminPopupPayload(item);
}

export async function updatePopup(schoolId, popupId, user, body = {}) {
  const parsedSchoolId = parseSchoolId(schoolId);
  const existing = await loadOwnedPopup(parsedSchoolId, popupId);
  if (['EXPIRED', 'ARCHIVED'].includes(resolveEffectiveStatus(existing)) && body.status == null) {
    throw httpError('Expired popups cannot be edited. Duplicate it instead.');
  }
  const merged = {
    ...existing,
    ...body,
    targeting: body.targeting ?? existing.targeting,
    buttons: body.buttons ?? existing.buttons,
    completion_condition: body.completion_condition ?? body.completionCondition ?? existing.completion_condition,
  };
  const input = normalizePopupInput(merged);
  const userId = actorUserId(user);
  const [item] = await sql`
    UPDATE popups SET
      title = ${input.title},
      heading = ${input.heading},
      message = ${input.message},
      category = ${input.category},
      priority = ${input.priority},
      layout_type = ${input.layout_type},
      icon = ${input.icon},
      frequency = ${input.frequency},
      start_at = ${input.start_at},
      end_at = ${input.end_at},
      allow_dismiss = ${input.allow_dismiss},
      require_acknowledgement = ${input.require_acknowledgement},
      send_push = ${input.send_push},
      update_mode = ${input.update_mode},
      targeting = ${sql.json(input.targeting)},
      buttons = ${sql.json(input.buttons)},
      completion_condition = ${sql.json(input.completion_condition)},
      updated_by = ${userId}
    WHERE id = ${popupId} AND school_id = ${parsedSchoolId} AND deleted_at IS NULL
    RETURNING *
  `;
  if (!item) throw httpError('Popup not found', 404);
  return adminPopupPayload(item);
}

export async function archivePopup(schoolId, popupId, user) {
  const parsedSchoolId = parseSchoolId(schoolId);
  await loadOwnedPopup(parsedSchoolId, popupId);
  const [item] = await sql`
    UPDATE popups
    SET status = 'ARCHIVED', deleted_at = NOW(), updated_by = ${actorUserId(user)}
    WHERE id = ${popupId} AND school_id = ${parsedSchoolId} AND deleted_at IS NULL
    RETURNING id
  `;
  if (!item) throw httpError('Popup not found', 404);
  return { deleted: true };
}

export async function duplicatePopup(schoolId, popupId, user) {
  const existing = await loadOwnedPopup(parseSchoolId(schoolId), popupId);
  return createPopup(schoolId, user, {
    ...existing,
    title: `${String(existing.title).slice(0, 110)} (copy)`,
    targeting: existing.targeting,
    buttons: existing.buttons,
    completion_condition: existing.completion_condition,
    send_push: false,
  });
}

export async function setPopupStatus(schoolId, popupId, user, nextStatus) {
  const parsedSchoolId = parseSchoolId(schoolId);
  const existing = await loadOwnedPopup(parsedSchoolId, popupId);
  const now = new Date();
  let status = nextStatus;
  let publishedAt = existing.published_at;
  let publishedBy = existing.published_by;

  if (nextStatus === 'PUBLISH') {
    if (!targetingHasAudience(existing.targeting)) {
      throw httpError('Publish requires a target audience.');
    }
    publishedAt = existing.published_at || now.toISOString();
    publishedBy = existing.published_by || actorUserId(user);
    status = new Date(existing.start_at) > now ? 'SCHEDULED' : 'ACTIVE';
  } else if (nextStatus === 'PAUSE') {
    if (!existing.published_at) throw httpError('Only published popups can be paused.');
    status = 'PAUSED';
  } else if (nextStatus === 'RESUME') {
    if (existing.status !== 'PAUSED') throw httpError('Only paused popups can be resumed.');
    status = new Date(existing.start_at) > now ? 'SCHEDULED' : 'ACTIVE';
  } else {
    throw httpError('Unsupported status transition.');
  }

  const [item] = await sql`
    UPDATE popups
    SET status = ${status},
        published_at = ${publishedAt},
        published_by = ${publishedBy},
        updated_by = ${actorUserId(user)}
    WHERE id = ${popupId} AND school_id = ${parsedSchoolId} AND deleted_at IS NULL
    RETURNING *
  `;
  return adminPopupPayload(item);
}

export async function publishPopup(schoolId, popupId, user) {
  const item = await setPopupStatus(schoolId, popupId, user, 'PUBLISH');
  if (item.send_push) {
    void sendOptionalPush(schoolId, item).catch(() => {});
  }
  return item;
}

async function sendOptionalPush(schoolId, popup) {
  const userIds = await estimateRecipientIds(schoolId, popup.targeting);
  if (!userIds.length) return;
  const deepLink = `/updates?popupId=${popup.id}`;
  await sendNotificationToUsers(userIds.slice(0, 5000), 'POPUP_ANNOUNCEMENT', {
    message: popup.title,
    popupId: popup.id,
  }, {
    schoolId,
    deepLink,
  });
}

export async function pausePopup(schoolId, popupId, user) {
  return setPopupStatus(schoolId, popupId, user, 'PAUSE');
}

export async function resumePopup(schoolId, popupId, user) {
  return setPopupStatus(schoolId, popupId, user, 'RESUME');
}

export async function queueTestPopup(schoolId, popupId, user) {
  const parsedSchoolId = parseSchoolId(schoolId);
  await loadOwnedPopup(parsedSchoolId, popupId);
  const userId = requireUserId(user);
  const [row] = await sql`
    INSERT INTO popup_user_states (
      school_id, popup_id, user_id, is_test, test_queued_at, dismissed_at, acknowledged_at, completed_at
    ) VALUES (
      ${parsedSchoolId}, ${popupId}, ${userId}, TRUE, NOW(), NULL, NULL, NULL
    )
    ON CONFLICT (school_id, popup_id, user_id) DO UPDATE
    SET is_test = TRUE,
        test_queued_at = NOW(),
        dismissed_at = NULL,
        acknowledged_at = NULL,
        last_session_id = NULL
    RETURNING popup_id
  `;
  return { queued: true, popup_id: row.popup_id };
}

export async function uploadPopupImage(schoolId, popupId, buffer) {
  const parsedSchoolId = parseSchoolId(schoolId);
  const existing = await loadOwnedPopup(parsedSchoolId, popupId);
  if (!buffer?.length) throw httpError('Attach an image under the "image" field.');
  let normalized;
  try {
    normalized = await normalizeWebsiteGalleryImage(buffer);
  } catch (err) {
    throw httpError(/optimize/i.test(err?.message || '') ? err.message : 'The uploaded file is not a valid supported image.');
  }
  const imageId = randomUUID();
  const storagePath = schoolPopupObjectPath(parsedSchoolId, imageId);
  const { imageUrl } = await uploadSchoolPortalImage(storagePath, normalized.buffer);
  try {
    const [item] = await sql`
      UPDATE popups
      SET image_url = ${imageUrl}, storage_path = ${storagePath}
      WHERE id = ${popupId} AND school_id = ${parsedSchoolId} AND deleted_at IS NULL
      RETURNING *
    `;
    if (existing.storage_path && existing.storage_path !== storagePath) {
      await removeSchoolPortalImage(existing.storage_path).catch(() => {});
    }
    return adminPopupPayload(item);
  } catch (error) {
    await removeSchoolPortalImage(storagePath).catch(() => {});
    throw error;
  }
}

async function usersForRoleGroup(schoolId, group) {
  if (group === 'everyone') {
    return sql`
      SELECT DISTINCT u.id
      FROM users u
      WHERE u.school_id = ${schoolId}
        AND u.account_status = 'active'
        AND u.deleted_at IS NULL
    `;
  }
  const codes = expandTargetRoles([group]);
  if (!codes.length) return [];
  return sql`
    SELECT DISTINCT u.id
    FROM users u
    JOIN user_roles ur ON ur.user_id = u.id AND ur.school_id = u.school_id AND ur.deleted_at IS NULL
    JOIN roles r ON r.id = ur.role_id AND r.school_id = u.school_id AND r.deleted_at IS NULL
    WHERE u.school_id = ${schoolId}
      AND u.account_status = 'active'
      AND u.deleted_at IS NULL
      AND r.code = ANY(${sql.array(codes)})
  `;
}

export async function estimateRecipientIds(schoolId, targetingInput) {
  const parsedSchoolId = parseSchoolId(schoolId);
  const targeting = normalizeTargeting(targetingInput);
  if (!targetingHasAudience(targeting)) return [];

  if (targeting.user_ids.length && !targeting.roles.length && !targeting.everyone && !targeting.class_ids.length) {
    const rows = await sql`
      SELECT id FROM users
      WHERE school_id = ${parsedSchoolId}
        AND id = ANY(${sql.array(targeting.user_ids)}::uuid[])
        AND account_status = 'active'
        AND deleted_at IS NULL
    `;
    return rows.map((row) => row.id);
  }

  const groups = targeting.everyone ? ['everyone'] : (targeting.roles.length ? targeting.roles : ['everyone']);
  const buckets = await Promise.all(groups.map((group) => usersForRoleGroup(parsedSchoolId, group)));
  let ids = new Set();
  for (const rows of buckets) for (const row of rows) ids.add(String(row.id));
  if (!ids.size) return [];

  if (targeting.class_ids.length || targeting.section_ids.length || targeting.student_ids.length || targeting.route_ids.length) {
    const scoped = await sql`
      SELECT DISTINCT u.id
      FROM users u
      LEFT JOIN parents p ON p.person_id = u.person_id AND p.school_id = u.school_id
      LEFT JOIN student_parents sp ON sp.parent_id = p.id AND sp.school_id = u.school_id AND sp.deleted_at IS NULL
      LEFT JOIN students s ON (
        (s.person_id = u.person_id AND s.school_id = u.school_id)
        OR (s.id = sp.student_id AND s.school_id = u.school_id)
      )
      LEFT JOIN student_enrollments se ON se.student_id = s.id AND se.school_id = u.school_id AND se.status = 'active'
      LEFT JOIN class_sections cs ON cs.id = se.class_section_id AND cs.school_id = u.school_id
      LEFT JOIN student_transport st ON st.student_id = s.id AND st.school_id = u.school_id AND st.is_active = TRUE
      WHERE u.school_id = ${parsedSchoolId}
        AND u.account_status = 'active'
        AND u.deleted_at IS NULL
        AND u.id = ANY(${sql.array([...ids])}::uuid[])
        ${targeting.class_ids.length ? sql`AND cs.class_id = ANY(${sql.array(targeting.class_ids)}::uuid[])` : sql``}
        ${targeting.section_ids.length ? sql`AND cs.section_id = ANY(${sql.array(targeting.section_ids)}::uuid[])` : sql``}
        ${targeting.student_ids.length ? sql`AND s.id = ANY(${sql.array(targeting.student_ids)}::uuid[])` : sql``}
        ${targeting.route_ids.length ? sql`AND st.route_id = ANY(${sql.array(targeting.route_ids)}::uuid[])` : sql``}
    `;
    ids = new Set(scoped.map((row) => String(row.id)));
  }

  if (targeting.user_ids.length) {
    ids = new Set([...ids].filter((id) => targeting.user_ids.includes(id)));
  }
  return [...ids];
}

export async function estimateAudience(schoolId, targeting) {
  const ids = await estimateRecipientIds(schoolId, targeting);
  return { estimated_recipients: ids.length };
}

export async function getPopupAnalytics(schoolId, popupId) {
  const parsedSchoolId = parseSchoolId(schoolId);
  const popup = await loadOwnedPopup(parsedSchoolId, popupId);
  const [stats] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE first_seen_at IS NOT NULL)::int AS unique_views,
      COALESCE(SUM(view_count), 0)::int AS total_views,
      COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicks,
      COUNT(*) FILTER (WHERE dismissed_at IS NOT NULL)::int AS dismissals,
      COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL)::int AS acknowledgements,
      COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int AS completions
    FROM popup_user_states
    WHERE school_id = ${parsedSchoolId}
      AND popup_id = ${popupId}
      AND is_test = FALSE
  `;
  const roleRows = await sql`
    SELECT r.code AS role_code, COUNT(DISTINCT pus.user_id)::int AS views
    FROM popup_user_states pus
    JOIN user_roles ur ON ur.user_id = pus.user_id AND ur.school_id = pus.school_id AND ur.deleted_at IS NULL
    JOIN roles r ON r.id = ur.role_id AND r.school_id = pus.school_id AND r.deleted_at IS NULL
    WHERE pus.school_id = ${parsedSchoolId}
      AND pus.popup_id = ${popupId}
      AND pus.is_test = FALSE
      AND pus.first_seen_at IS NOT NULL
    GROUP BY r.code
  `;
  const estimated = await estimateAudience(parsedSchoolId, popup.targeting);
  const uniqueViews = stats?.unique_views || 0;
  const clicks = stats?.clicks || 0;
  return {
    popup: adminPopupPayload(popup),
    targeted_users: estimated.estimated_recipients,
    delivered_users: uniqueViews,
    unique_views: uniqueViews,
    total_views: stats?.total_views || 0,
    clicks,
    dismissals: stats?.dismissals || 0,
    acknowledgements: stats?.acknowledgements || 0,
    pending_acknowledgements: popup.require_acknowledgement
      ? Math.max(estimated.estimated_recipients - (stats?.acknowledgements || 0), 0)
      : 0,
    completions: stats?.completions || 0,
    click_through_rate: uniqueViews ? Number((clicks / uniqueViews).toFixed(4)) : 0,
    by_role: roleRows,
  };
}

export async function getAdminOverview(schoolId) {
  const parsedSchoolId = parseSchoolId(schoolId);
  const rows = await sql`
    SELECT id, status, start_at, end_at, published_at
    FROM popups
    WHERE school_id = ${parsedSchoolId} AND deleted_at IS NULL
  `;
  const now = new Date();
  const counts = { DRAFT: 0, SCHEDULED: 0, ACTIVE: 0, PAUSED: 0, EXPIRED: 0, ARCHIVED: 0 };
  for (const row of rows) counts[resolveEffectiveStatus(row, now)] = (counts[resolveEffectiveStatus(row, now)] || 0) + 1;
  return { counts, total: rows.length };
}
