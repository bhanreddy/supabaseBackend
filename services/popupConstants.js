/**
 * Shared popup constants, targeting helpers, action registry, and validators.
 * Keep this module free of I/O so unit tests can cover eligibility and CTA safety.
 */

export const POPUP_CATEGORIES = Object.freeze([
  'INFORMATION', 'WARNING', 'IMPORTANT', 'EMERGENCY', 'FEATURE_UPDATE', 'APP_UPDATE',
  'PAYMENT', 'ATTENDANCE', 'EXAM', 'TRANSPORT', 'DOCUMENT', 'MAINTENANCE', 'CUSTOM',
]);

export const POPUP_PRIORITIES = Object.freeze(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']);
export const PRIORITY_RANK = Object.freeze({ CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 });

export const POPUP_LAYOUTS = Object.freeze(['COMPACT', 'STANDARD', 'RICH', 'CRITICAL', 'UPDATE']);
export const POPUP_STATUSES = Object.freeze(['DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'EXPIRED', 'ARCHIVED']);
export const POPUP_FREQUENCIES = Object.freeze([
  'SHOW_ONCE', 'UNTIL_ACKNOWLEDGED', 'EVERY_LOGIN', 'ONCE_PER_DAY', 'UNTIL_ACTION_COMPLETED',
]);
export const UPDATE_MODES = Object.freeze(['NONE', 'OPTIONAL_UPDATE', 'FORCED_UPDATE']);

export const TARGET_ROLE_GROUPS = Object.freeze(['everyone', 'management', 'staff', 'parent', 'accounts', 'driver']);

/** Maps admin targeting groups onto actual SchoolIMS role codes. */
export const ROLE_GROUP_CODES = Object.freeze({
  everyone: null,
  management: ['admin', 'principal'],
  staff: ['staff', 'teacher'],
  parent: ['parent', 'student'],
  accounts: ['accounts', 'accountant'],
  driver: ['driver'],
});

export const ACTION_TYPES = Object.freeze([
  'NONE', 'INTERNAL_ROUTE', 'OPEN_MODULE', 'OPEN_SCREEN', 'OPEN_RECORD',
  'EXTERNAL_URL', 'DOWNLOAD_DOCUMENT', 'CALL_PHONE', 'OPEN_SUPPORT',
  'UPDATE_APP', 'ACKNOWLEDGE', 'DISMISS', 'CUSTOM_ACTION',
]);

export const BUTTON_STYLES = Object.freeze(['primary', 'secondary', 'destructive', 'ghost']);
export const COMPLETION_TYPES = Object.freeze(['NONE', 'FEE_PENDING']);

export const EVENT_TYPES = Object.freeze([
  'POPUP_ELIGIBLE', 'POPUP_VIEWED', 'POPUP_CLICKED', 'POPUP_DISMISSED',
  'POPUP_ACKNOWLEDGED', 'POPUP_ACTION_COMPLETED',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_PARAM_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;
const SAFE_PARAM_VALUE = /^[A-Za-z0-9._:@+\-]{1,80}$/;
const PHONE_RE = /^\+?[0-9][0-9\s\-()]{6,20}$/;

export const POPUP_ACTIONS = Object.freeze({
  OPEN_FEES: {
    type: 'OPEN_MODULE',
    allowedRoles: ['parent', 'student', 'accounts', 'accountant', 'admin', 'principal'],
    params: ['studentId'],
  },
  OPEN_ATTENDANCE: {
    type: 'OPEN_MODULE',
    allowedRoles: ['parent', 'student', 'staff', 'teacher', 'admin', 'principal'],
    params: ['studentId', 'classId'],
  },
  OPEN_ATTENDANCE_ANALYTICS: {
    type: 'OPEN_SCREEN',
    allowedRoles: ['admin', 'principal', 'staff', 'teacher'],
    params: [],
  },
  OPEN_RESULTS: {
    type: 'OPEN_SCREEN',
    allowedRoles: ['parent', 'student', 'staff', 'teacher', 'admin', 'principal'],
    params: ['studentId', 'examId'],
  },
  OPEN_HOMEWORK: {
    type: 'OPEN_MODULE',
    allowedRoles: ['parent', 'student', 'staff', 'teacher'],
    params: [],
  },
  OPEN_TIMETABLE: {
    type: 'OPEN_MODULE',
    allowedRoles: ['parent', 'student', 'staff', 'teacher', 'admin', 'principal', 'driver'],
    params: [],
  },
  OPEN_TRANSPORT: {
    type: 'OPEN_MODULE',
    allowedRoles: ['parent', 'student', 'driver', 'admin', 'principal'],
    params: ['routeId'],
  },
  OPEN_NOTICES: {
    type: 'OPEN_MODULE',
    allowedRoles: ['parent', 'student', 'staff', 'teacher', 'admin', 'principal', 'accounts', 'accountant', 'driver'],
    params: [],
  },
  OPEN_PROFILE: {
    type: 'OPEN_SCREEN',
    allowedRoles: ['parent', 'student', 'staff', 'teacher', 'admin', 'principal', 'accounts', 'accountant', 'driver'],
    params: [],
  },
  OPEN_REPORTS: {
    type: 'OPEN_SCREEN',
    allowedRoles: ['admin', 'principal', 'accounts', 'accountant'],
    params: [],
  },
  OPEN_COLLECTION_REPORT: {
    type: 'OPEN_SCREEN',
    allowedRoles: ['accounts', 'accountant', 'admin', 'principal'],
    params: [],
  },
  OPEN_RECONCILIATION: {
    type: 'OPEN_SCREEN',
    allowedRoles: ['accounts', 'accountant', 'admin', 'principal'],
    params: [],
  },
  OPEN_SUPPORT: {
    type: 'OPEN_SUPPORT',
    allowedRoles: ['parent', 'student', 'staff', 'teacher', 'admin', 'principal', 'accounts', 'accountant', 'driver'],
    params: [],
  },
  OPEN_UPDATE: {
    type: 'UPDATE_APP',
    allowedRoles: ['parent', 'student', 'staff', 'teacher', 'admin', 'principal', 'accounts', 'accountant', 'driver'],
    params: [],
  },
  VIEW_ROUTE: {
    type: 'OPEN_SCREEN',
    allowedRoles: ['driver', 'admin', 'principal'],
    params: ['routeId'],
  },
});

export function isUuid(value) {
  return UUID_RE.test(String(value || ''));
}

export function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((v) => String(v).trim()).filter(Boolean))];
}

export function uniqueUuids(values = []) {
  return uniqueStrings(values).filter(isUuid);
}

export function mapRolesToGroups(roles = []) {
  const groups = new Set();
  for (const role of roles) {
    const code = String(role || '').toLowerCase();
    if (['admin', 'principal'].includes(code)) groups.add('management');
    if (['staff', 'teacher'].includes(code)) groups.add('staff');
    if (['parent', 'student'].includes(code)) groups.add('parent');
    if (['accounts', 'accountant'].includes(code)) groups.add('accounts');
    if (code === 'driver') groups.add('driver');
  }
  return [...groups];
}

export function expandTargetRoles(groups = []) {
  const codes = new Set();
  for (const group of groups) {
    const mapped = ROLE_GROUP_CODES[group];
    if (mapped) mapped.forEach((code) => codes.add(code));
  }
  return [...codes];
}

export function normalizeTargeting(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  let roles = uniqueStrings(source.roles).map((r) => r.toLowerCase()).filter((r) => TARGET_ROLE_GROUPS.includes(r));
  const everyone = Boolean(source.everyone) || roles.includes('everyone');
  if (everyone) roles = ['everyone'];
  return {
    everyone,
    roles,
    class_ids: uniqueUuids(source.class_ids),
    section_ids: uniqueUuids(source.section_ids),
    student_ids: uniqueUuids(source.student_ids),
    user_ids: uniqueUuids(source.user_ids),
    staff_ids: uniqueUuids(source.staff_ids),
    route_ids: uniqueUuids(source.route_ids),
    department_ids: uniqueUuids(source.department_ids),
  };
}

export function targetingHasAudience(targeting) {
  const t = normalizeTargeting(targeting);
  return Boolean(
    t.everyone
    || t.roles.length
    || t.class_ids.length
    || t.section_ids.length
    || t.student_ids.length
    || t.user_ids.length
    || t.staff_ids.length
    || t.route_ids.length
    || t.department_ids.length
  );
}

function intersects(left = [], right = []) {
  if (!right.length) return true;
  const set = new Set(left.map(String));
  return right.some((id) => set.has(String(id)));
}

/**
 * Efficient in-memory targeting. Candidate popups are already school-scoped.
 */
export function userMatchesTargeting(ctx, targetingInput) {
  if (!ctx?.userId || !ctx?.schoolId) return false;
  const targeting = normalizeTargeting(targetingInput);

  if (targeting.user_ids.length && !targeting.user_ids.includes(String(ctx.userId))) {
    return false;
  }
  if (targeting.staff_ids.length) {
    if (!ctx.staffId || !targeting.staff_ids.includes(String(ctx.staffId))) return false;
  }

  const roleOk = targeting.everyone
    || targeting.roles.includes('everyone')
    || (!targeting.roles.length && (targeting.user_ids.length || targeting.staff_ids.length))
    || targeting.roles.some((group) => (ctx.roleGroups || []).includes(group));
  if (!roleOk) return false;

  if (targeting.class_ids.length && !intersects(ctx.classIds, targeting.class_ids)) return false;
  if (targeting.section_ids.length && !intersects(ctx.sectionIds, targeting.section_ids)) return false;
  if (targeting.student_ids.length && !intersects(ctx.studentIds, targeting.student_ids)) return false;
  if (targeting.route_ids.length && !intersects(ctx.routeIds, targeting.route_ids)) return false;
  if (targeting.department_ids.length && !intersects(ctx.departmentIds, targeting.department_ids)) return false;
  return true;
}

export function schoolDateKey(date = new Date(), timeZone = 'Asia/Kolkata') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function isWithinSchedule(popup, now = new Date()) {
  const start = popup?.start_at ? new Date(popup.start_at) : null;
  const end = popup?.end_at ? new Date(popup.end_at) : null;
  if (start && Number.isNaN(start.getTime())) return false;
  if (end && Number.isNaN(end.getTime())) return false;
  if (start && start > now) return false;
  if (end && end <= now) return false;
  return true;
}

export function resolveEffectiveStatus(popup, now = new Date()) {
  const status = popup?.status || 'DRAFT';
  if (['DRAFT', 'PAUSED', 'ARCHIVED'].includes(status)) return status;
  const end = popup?.end_at ? new Date(popup.end_at) : null;
  if (end && !Number.isNaN(end.getTime()) && end <= now) return 'EXPIRED';
  const start = popup?.start_at ? new Date(popup.start_at) : null;
  if (popup?.published_at && start && start > now) return 'SCHEDULED';
  if (popup?.published_at && isWithinSchedule(popup, now)) return 'ACTIVE';
  return status;
}

/**
 * Frequency uses server-side user state. SHOW_ONCE / missed-update: no row means eligible.
 */
export function isFrequencyEligible(popup, state, { now = new Date(), sessionId = null, timeZone = 'Asia/Kolkata', actionCompleted = false } = {}) {
  if (state?.completed_at) return false;
  if (popup.frequency === 'UNTIL_ACTION_COMPLETED' && actionCompleted) return false;

  if (state?.is_test && state?.test_queued_at) {
    if (state.dismissed_at && new Date(state.dismissed_at) >= new Date(state.test_queued_at)) return false;
    if (state.acknowledged_at && new Date(state.acknowledged_at) >= new Date(state.test_queued_at)) return false;
    return true;
  }

  switch (popup.frequency) {
    case 'SHOW_ONCE':
      return !(state?.first_seen_at || state?.dismissed_at || state?.acknowledged_at);
    case 'UNTIL_ACKNOWLEDGED':
      return !state?.acknowledged_at;
    case 'EVERY_LOGIN':
      if (!sessionId) return !state?.last_displayed_at;
      return !state?.last_session_id || state.last_session_id !== sessionId;
    case 'ONCE_PER_DAY': {
      if (!state?.last_displayed_at) return true;
      return schoolDateKey(new Date(state.last_displayed_at), timeZone) !== schoolDateKey(now, timeZone);
    }
    case 'UNTIL_ACTION_COMPLETED':
      return !state?.completed_at && !actionCompleted;
    default:
      return false;
  }
}

export function sortPopupQueue(popups = []) {
  return [...popups].sort((a, b) => {
    const rankA = PRIORITY_RANK[a.priority] ?? 9;
    const rankB = PRIORITY_RANK[b.priority] ?? 9;
    if (rankA !== rankB) return rankA - rankB;
    const startA = new Date(a.start_at || a.created_at || 0).getTime();
    const startB = new Date(b.start_at || b.created_at || 0).getTime();
    if (startA !== startB) return startA - startB;
    return String(a.id).localeCompare(String(b.id));
  });
}

export function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function normalizeButtons(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > 2) throw httpError('A popup can have at most 2 action buttons.');
  return list.map((button, index) => {
    const label = String(button?.label || '').replace(/\s+/g, ' ').trim().slice(0, 32);
    if (!label) throw httpError('Each button needs a label.');
    const actionType = String(button?.actionType || button?.action_type || 'NONE').toUpperCase();
    if (!ACTION_TYPES.includes(actionType)) throw httpError(`Unsupported button action: ${actionType}`);
    const visualStyle = BUTTON_STYLES.includes(button?.visualStyle || button?.visual_style)
      ? (button.visualStyle || button.visual_style)
      : (index === 0 ? 'primary' : 'secondary');
    const target = button?.target != null ? String(button.target).trim().slice(0, 80) : null;
    const parameters = sanitizeActionParameters(button?.parameters || {});
    validateActionPayload(actionType, target, parameters);
    return {
      id: String(button?.id || `btn_${index + 1}`).slice(0, 40),
      label,
      actionType,
      target: target || null,
      parameters,
      visualStyle,
      order: Number.isInteger(button?.order) ? button.order : index,
    };
  }).sort((a, b) => a.order - b.order);
}

export function sanitizeActionParameters(parameters = {}) {
  const out = {};
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return out;
  for (const [key, value] of Object.entries(parameters)) {
    if (!SAFE_PARAM_KEY.test(key)) continue;
    if (value == null || value === '') continue;
    const str = String(value).trim();
    if (!SAFE_PARAM_VALUE.test(str)) continue;
    if (key.toLowerCase().includes('url') || str.includes('..') || str.includes('/') && !isUuid(str)) continue;
    out[key] = str.slice(0, 80);
  }
  return out;
}

export function isSafeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return false;
    if (!url.hostname || url.hostname === 'localhost') return false;
    if (url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

export function validateActionPayload(actionType, target, parameters = {}) {
  if (actionType === 'EXTERNAL_URL') {
    if (!isSafeExternalUrl(target)) throw httpError('External URL must be a valid https address.');
    return;
  }
  if (actionType === 'CALL_PHONE') {
    if (!PHONE_RE.test(String(target || ''))) throw httpError('Phone action needs a valid phone number.');
    return;
  }
  if (actionType === 'DOWNLOAD_DOCUMENT') {
    if (!isUuid(target) && !isUuid(parameters.documentId)) {
      throw httpError('Document actions require a document id.');
    }
    return;
  }
  if (actionType === 'OPEN_MODULE' || actionType === 'OPEN_SCREEN' || actionType === 'OPEN_RECORD' || actionType === 'CUSTOM_ACTION') {
    const key = String(target || '').toUpperCase();
    if (!key || key.includes('..') || key.includes('/') || key.includes('\\')) {
      throw httpError('Internal popup actions must use the controlled action registry.');
    }
    if (actionType !== 'CUSTOM_ACTION' && !POPUP_ACTIONS[key] && !['NONE', 'ACKNOWLEDGE', 'DISMISS', 'UPDATE_APP', 'OPEN_SUPPORT'].includes(actionType)) {
      // OPEN_MODULE target should be a registry key such as OPEN_FEES
      if (!POPUP_ACTIONS[key]) throw httpError(`Unknown popup action target: ${key}`);
    }
  }
  if (target && (String(target).includes('..') || String(target).startsWith('/'))) {
    throw httpError('Popup actions cannot use raw navigation paths.');
  }
}

export function actionAllowedForRoles(actionType, target, roles = []) {
  if (['NONE', 'ACKNOWLEDGE', 'DISMISS', 'UPDATE_APP', 'OPEN_SUPPORT', 'EXTERNAL_URL', 'CALL_PHONE'].includes(actionType)) {
    return true;
  }
  const key = String(target || '').toUpperCase();
  const spec = POPUP_ACTIONS[key];
  if (!spec) return false;
  return roles.some((role) => spec.allowedRoles.includes(String(role).toLowerCase()));
}

export function normalizeCompletionCondition(raw = {}) {
  const type = String(raw?.type || 'NONE').toUpperCase();
  if (!COMPLETION_TYPES.includes(type)) throw httpError(`Unsupported completion condition: ${type}`);
  return { type };
}

export function publicPopupPayload(popup, extras = {}) {
  return {
    id: popup.id,
    title: popup.title,
    heading: popup.heading,
    message: popup.message,
    category: popup.category,
    priority: popup.priority,
    layout_type: popup.layout_type,
    image_url: popup.image_url,
    icon: popup.icon,
    frequency: popup.frequency,
    start_at: popup.start_at,
    end_at: popup.end_at,
    allow_dismiss: popup.allow_dismiss,
    require_acknowledgement: popup.require_acknowledgement,
    update_mode: popup.update_mode,
    buttons: Array.isArray(popup.buttons) ? popup.buttons : [],
    is_test: Boolean(extras.is_test),
    inbox_state: extras.inbox_state || null,
  };
}

export const TITLE_MAX = 120;
export const HEADING_MAX = 180;
export const MESSAGE_MAX = 4000;
export const ELIGIBLE_LIMIT = 15;
export const INBOX_LIMIT = 50;
