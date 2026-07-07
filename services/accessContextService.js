/**
 * accessContextService.js — Portal switcher: materialize and query switchable contexts.
 *
 * One Supabase login (users.id) may expose multiple contexts:
 *   - Direct role portals (staff, admin, accounts, driver)
 *   - Legacy self-student login (student role on child's person)
 *   - Guardian-linked children (parent.person_id = user.person_id)
 */

import sql from '../db.js';

/** Map DB role codes → portal route group. */
const ROLE_TO_PORTAL = {
  admin: 'admin',
  principal: 'admin',
  staff: 'staff',
  teacher: 'staff',
  accounts: 'accounts',
  driver: 'driver',
  student: 'student',
  parent: 'student',
};

const PORTAL_SORT = {
  student: 0,
  staff: 1,
  admin: 2,
  accounts: 3,
  driver: 4,
  library: 5,
  transport: 6,
};

const PORTAL_GROUP_LABELS = {
  student: 'My Children',
  staff: 'Work',
  admin: 'Administration',
  accounts: 'Accounts',
  driver: 'Transport',
  library: 'Library',
  transport: 'Transport',
};

function portalHomeRoute(portalType) {
  switch (portalType) {
    case 'student': return '/(tabs)/home';
    case 'staff': return '/staff/dashboard';
    case 'admin': return '/admin/dashboard';
    case 'accounts': return '/accounts/dashboard';
    case 'driver': return '/driver/dashboard';
    default: return '/(tabs)/home';
  }
}

async function fetchPermissionsForRoles(schoolId, roleCodes) {
  if (!roleCodes?.length) return [];
  const rows = await sql`
    SELECT DISTINCT p.code
    FROM roles r
    JOIN role_permissions rp ON rp.role_id = r.id AND rp.school_id = r.school_id
    JOIN permissions p ON p.id = rp.permission_id AND p.school_id = r.school_id
    WHERE r.school_id = ${schoolId}
      AND r.code = ANY(${roleCodes})
      AND r.deleted_at IS NULL
    ORDER BY p.code
  `;
  return rows.map((r) => r.code);
}

async function buildStudentClassSubtitle(studentId, schoolId) {
  const [row] = await sql`
    SELECT c.name AS class_name, sec.name AS section_name
    FROM student_enrollments se
    JOIN class_sections cs ON cs.id = se.class_section_id AND cs.deleted_at IS NULL
    JOIN classes c ON c.id = cs.class_id AND c.deleted_at IS NULL
    JOIN sections sec ON sec.id = cs.section_id AND sec.deleted_at IS NULL
    WHERE se.student_id = ${studentId}
      AND se.school_id = ${schoolId}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
    ORDER BY se.created_at DESC
    LIMIT 1
  `;
  if (!row) return null;
  if (row.class_name && row.section_name) {
    return `${row.class_name} · Sec ${row.section_name}`;
  }
  return row.class_name || row.section_name || null;
}

/**
 * Compute desired contexts for a user without writing to DB.
 */
export async function computeAccessContexts(userId) {
  const [userRow] = await sql`
    SELECT u.id, u.person_id, u.school_id, u.account_status,
           p.display_name, p.photo_url
    FROM users u
    JOIN persons p ON p.id = u.person_id
    WHERE u.id = ${userId} AND u.deleted_at IS NULL
  `;
  if (!userRow || userRow.account_status !== 'active') return [];

  const roleRows = await sql`
    SELECT DISTINCT r.code
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ${userId}
      AND ur.deleted_at IS NULL
      AND r.deleted_at IS NULL
  `;
  const roleCodes = roleRows.map((r) => r.code);
  const contexts = [];
  const seenKeys = new Set();

  const pushContext = (spec) => {
    if (seenKeys.has(spec.context_key)) return;
    seenKeys.add(spec.context_key);
    contexts.push(spec);
  };

  // Direct role portals (one context per portal type, merged roles)
  const portalRoleMap = new Map();
  for (const code of roleCodes) {
    const portal = ROLE_TO_PORTAL[code];
    if (!portal) continue;
    if (!portalRoleMap.has(portal)) portalRoleMap.set(portal, []);
    portalRoleMap.get(portal).push(code);
  }

  const [staffRow] = await sql`
    SELECT st.id, sd.name AS designation_name
    FROM staff st
    LEFT JOIN staff_designations sd ON sd.id = st.designation_id
    WHERE st.person_id = ${userRow.person_id}
      AND st.school_id = ${userRow.school_id}
      AND st.deleted_at IS NULL
    LIMIT 1
  `;

  for (const [portalType, codes] of portalRoleMap.entries()) {
    if (portalType === 'student') continue; // handled below (self + guardian)

    pushContext({
      context_key: `role:${portalType}`,
      portal_type: portalType,
      role_codes: codes,
      school_id: userRow.school_id,
      student_id: null,
      staff_id: portalType === 'staff' || portalType === 'admin' ? staffRow?.id ?? null : null,
      parent_id: null,
      display_name: userRow.display_name,
      subtitle: staffRow?.designation_name ?? codes.map((c) => c === 'accounts' ? 'Accounts' : c).join(', '),
      photo_url: userRow.photo_url,
      sort_order: PORTAL_SORT[portalType] ?? 99,
      source: 'direct_role',
    });
  }

  // Legacy self-student login: user's person IS the student
  const selfStudents = await sql`
    SELECT s.id AS student_id, p.display_name, p.photo_url
    FROM students s
    JOIN persons p ON p.id = s.person_id
    WHERE s.person_id = ${userRow.person_id}
      AND s.school_id = ${userRow.school_id}
      AND s.deleted_at IS NULL
  `;

  for (const st of selfStudents) {
    const subtitle = await buildStudentClassSubtitle(st.student_id, userRow.school_id);
    pushContext({
      context_key: `student_self:${st.student_id}`,
      portal_type: 'student',
      role_codes: roleCodes.includes('student') ? ['student'] : ['parent'],
      school_id: userRow.school_id,
      student_id: st.student_id,
      staff_id: null,
      parent_id: null,
      display_name: st.display_name,
      subtitle,
      photo_url: st.photo_url,
      sort_order: 0,
      source: 'direct_role',
    });
  }

  // Guardian-linked children via parents.person_id = users.person_id
  const guardianLinks = await sql`
    SELECT s.id AS student_id,
           par.id AS parent_id,
           sp.display_name,
           sp.photo_url
    FROM parents par
    JOIN student_parents sp_link ON sp_link.parent_id = par.id AND sp_link.deleted_at IS NULL
    JOIN students s ON s.id = sp_link.student_id AND s.deleted_at IS NULL
    JOIN persons sp ON sp.id = s.person_id
    WHERE par.person_id = ${userRow.person_id}
      AND par.school_id = ${userRow.school_id}
      AND par.deleted_at IS NULL
  `;

  for (const link of guardianLinks) {
    const subtitle = await buildStudentClassSubtitle(link.student_id, userRow.school_id);
    pushContext({
      context_key: `guardian:${link.student_id}`,
      portal_type: 'student',
      role_codes: roleCodes.includes('parent') ? ['parent'] : ['student'],
      school_id: userRow.school_id,
      student_id: link.student_id,
      staff_id: null,
      parent_id: link.parent_id,
      display_name: link.display_name,
      subtitle,
      photo_url: link.photo_url,
      sort_order: 0,
      source: 'guardian_link',
    });
  }

  return contexts;
}

/**
 * Upsert computed contexts and revoke stale ones.
 */
export async function refreshUserAccessContexts(userId) {
  const specs = await computeAccessContexts(userId);
  const activeKeys = specs.map((s) => s.context_key);

  if (specs.length === 0) {
    await sql`
      UPDATE user_access_contexts
      SET revoked_at = now(), revoked_reason = 'no_valid_contexts', updated_at = now()
      WHERE user_id = ${userId}
        AND revoked_at IS NULL
        AND deleted_at IS NULL
    `;
    return [];
  }

  for (const spec of specs) {
    await sql`
      INSERT INTO user_access_contexts (
        user_id, school_id, context_key, portal_type, role_codes,
        student_id, staff_id, parent_id,
        display_name, subtitle, photo_url, sort_order, source,
        is_switchable, revoked_at, revoked_reason
      ) VALUES (
        ${userId}, ${spec.school_id}, ${spec.context_key}, ${spec.portal_type}, ${spec.role_codes},
        ${spec.student_id}, ${spec.staff_id}, ${spec.parent_id},
        ${spec.display_name}, ${spec.subtitle}, ${spec.photo_url}, ${spec.sort_order}, ${spec.source},
        true, NULL, NULL
      )
      ON CONFLICT (user_id, context_key) DO UPDATE SET
        portal_type = EXCLUDED.portal_type,
        role_codes = EXCLUDED.role_codes,
        student_id = EXCLUDED.student_id,
        staff_id = EXCLUDED.staff_id,
        parent_id = EXCLUDED.parent_id,
        display_name = EXCLUDED.display_name,
        subtitle = EXCLUDED.subtitle,
        photo_url = EXCLUDED.photo_url,
        sort_order = EXCLUDED.sort_order,
        source = EXCLUDED.source,
        is_switchable = true,
        revoked_at = NULL,
        revoked_reason = NULL,
        updated_at = now()
    `;
  }

  await sql`
    UPDATE user_access_contexts
    SET revoked_at = now(), revoked_reason = 'context_removed', updated_at = now()
    WHERE user_id = ${userId}
      AND context_key <> ALL(${activeKeys})
      AND revoked_at IS NULL
      AND deleted_at IS NULL
  `;

  return listSwitchableContexts(userId);
}

function mapContextRow(row, permissions = null) {
  return {
    id: row.id,
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
    home_route: portalHomeRoute(row.portal_type),
    permissions: permissions ?? undefined,
  };
}

export async function listSwitchableContexts(userId) {
  const rows = await sql`
    SELECT uac.*, sch.name AS school_name
    FROM user_access_contexts uac
    JOIN schools sch ON sch.id = uac.school_id
    WHERE uac.user_id = ${userId}
      AND uac.deleted_at IS NULL
      AND uac.revoked_at IS NULL
      AND uac.is_switchable = true
      AND (uac.valid_to IS NULL OR uac.valid_to > now())
      AND (uac.valid_from IS NULL OR uac.valid_from <= now())
    ORDER BY uac.sort_order, uac.display_name
  `;
  return rows;
}

export async function getContextById(userId, contextId) {
  const [row] = await sql`
    SELECT uac.*, sch.name AS school_name
    FROM user_access_contexts uac
    JOIN schools sch ON sch.id = uac.school_id
    WHERE uac.id = ${contextId}
      AND uac.user_id = ${userId}
      AND uac.deleted_at IS NULL
      AND uac.revoked_at IS NULL
      AND uac.is_switchable = true
  `;
  return row ?? null;
}

export async function registerDeviceSession(userId, deviceId, { ip, userAgent } = {}) {
  if (!deviceId) throw new Error('deviceId is required');

  const contexts = await listSwitchableContexts(userId);
  const defaultContextId = contexts[0]?.id ?? null;

  const [session] = await sql`
    INSERT INTO user_active_sessions (user_id, device_id, active_context_id, last_seen_at, ip_address, user_agent)
    VALUES (${userId}, ${deviceId}, ${defaultContextId}, now(), ${ip ?? null}, ${userAgent ?? null})
    ON CONFLICT (user_id, device_id) DO UPDATE SET
      last_seen_at = now(),
      ip_address = COALESCE(EXCLUDED.ip_address, user_active_sessions.ip_address),
      user_agent = COALESCE(EXCLUDED.user_agent, user_active_sessions.user_agent),
      active_context_id = COALESCE(user_active_sessions.active_context_id, EXCLUDED.active_context_id)
    RETURNING *
  `;

  return session;
}

export async function getActiveContextForDevice(userId, deviceId) {
  if (!deviceId) return null;

  const [row] = await sql`
    SELECT uac.*, sch.name AS school_name
    FROM user_active_sessions uas
    JOIN user_access_contexts uac ON uac.id = uas.active_context_id
    JOIN schools sch ON sch.id = uac.school_id
    WHERE uas.user_id = ${userId}
      AND uas.device_id = ${deviceId}
      AND uac.deleted_at IS NULL
      AND uac.revoked_at IS NULL
  `;
  return row ?? null;
}

export async function buildContextsPayload(userId, deviceId = null) {
  const contexts = await listSwitchableContexts(userId);
  let activeContextId = null;

  if (deviceId) {
    const active = await getActiveContextForDevice(userId, deviceId);
    activeContextId = active?.id ?? null;
  }
  if (!activeContextId && contexts.length > 0) {
    activeContextId = contexts[0].id;
  }

  const groupMap = new Map();
  for (const row of contexts) {
    const label = PORTAL_GROUP_LABELS[row.portal_type] || row.portal_type;
    if (!groupMap.has(row.portal_type)) {
      groupMap.set(row.portal_type, { label, portal_type: row.portal_type, contexts: [] });
    }
    groupMap.get(row.portal_type).contexts.push({
      ...mapContextRow(row),
      is_active: row.id === activeContextId,
    });
  }

  const groups = [...groupMap.values()].sort(
    (a, b) => (PORTAL_SORT[a.portal_type] ?? 99) - (PORTAL_SORT[b.portal_type] ?? 99)
  );

  let activeContext = null;
  if (activeContextId) {
    const row = contexts.find((c) => c.id === activeContextId);
    if (row) {
      const permissions = await fetchPermissionsForRoles(row.school_id, row.role_codes);
      activeContext = {
        ...mapContextRow(row, permissions),
        is_active: true,
      };
    }
  }

  return {
    activeContextId,
    activeContext,
    groups,
    total: contexts.length,
  };
}

/**
 * Switch active context for a device; writes audit log.
 */
export async function switchActiveContext(userId, deviceId, contextId, meta = {}) {
  if (!deviceId) {
    const err = new Error('device_id is required');
    err.code = 'DEVICE_ID_REQUIRED';
    throw err;
  }

  const target = await getContextById(userId, contextId);
  if (!target) {
    const err = new Error('Access context is not valid');
    err.code = 'CONTEXT_INVALID';
    throw err;
  }

  const [prevSession] = await sql`
    SELECT active_context_id
    FROM user_active_sessions
    WHERE user_id = ${userId} AND device_id = ${deviceId}
  `;

  const [session] = await sql`
    INSERT INTO user_active_sessions (
      user_id, device_id, active_context_id, last_switched_at, last_seen_at,
      ip_address, user_agent
    ) VALUES (
      ${userId}, ${deviceId}, ${contextId}, now(), now(),
      ${meta.ip ?? null}, ${meta.userAgent ?? null}
    )
    ON CONFLICT (user_id, device_id) DO UPDATE SET
      active_context_id = EXCLUDED.active_context_id,
      last_switched_at = now(),
      last_seen_at = now(),
      ip_address = COALESCE(EXCLUDED.ip_address, user_active_sessions.ip_address),
      user_agent = COALESCE(EXCLUDED.user_agent, user_active_sessions.user_agent)
    RETURNING *
  `;

  await sql`
    INSERT INTO context_switch_logs (
      user_id, device_id, from_context_id, to_context_id,
      switch_reason, ip_address, user_agent, request_id, school_id
    ) VALUES (
      ${userId}, ${deviceId}, ${prevSession?.active_context_id ?? null}, ${contextId},
      ${meta.reason ?? 'user_initiated'}, ${meta.ip ?? null}, ${meta.userAgent ?? null},
      ${meta.requestId ?? null}, ${target.school_id}
    )
  `;

  const permissions = await fetchPermissionsForRoles(target.school_id, target.role_codes);
  const activeContext = {
    ...mapContextRow(target, permissions),
    is_active: true,
  };

  return {
    sessionId: session.id,
    activeContextId: contextId,
    activeContext,
    homeRoute: portalHomeRoute(target.portal_type),
    switchedAt: new Date().toISOString(),
  };
}

export { portalHomeRoute, PORTAL_GROUP_LABELS };
