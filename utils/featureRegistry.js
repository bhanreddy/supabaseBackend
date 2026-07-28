/**
 * FEATURE_REGISTRY — single source of truth for STUDENT-role feature flags.
 *
 * Each entry:
 *   key             stable flag key (also the DB feature_key)
 *   label           human label (Founder Console)
 *   group           UI group: drawer | quick_actions | topbar | home | bottom_nav
 *   default_enabled effective value when no override row exists
 *   data_bearing    true => MUST be enforced server-side via requireFeature()
 *   toggleable      false => core; cannot be flipped off (Founder Console disables it)
 *
 * Absent override row => default_enabled. Never treat "no row" as false.
 * Keep in sync with SuperAdmin/SuperAdminBackend/src/config/featureRegistry.js (separate deploy).
 */
import sql from '../db.js';

export const STUDENT_ROLE = 'student';

export const FEATURE_REGISTRY = [
  // drawer
  { key: 'menu.dcgd',             label: 'DCGD',            group: 'drawer',        default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'menu.ai_doubt_assist',  label: 'AI Doubt Assist', group: 'drawer',       default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'menu.insurance',        label: 'Insurance',       group: 'drawer',        default_enabled: true, data_bearing: false, toggleable: true },
  { key: 'menu.money_science',    label: 'Money Science',   group: 'drawer',        default_enabled: true, data_bearing: false, toggleable: true },
  // quick_actions
  { key: 'quick.announcements',   label: 'Announcements',   group: 'quick_actions', default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'quick.complaints',      label: 'Complaints',      group: 'quick_actions', default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'quick.life_values',     label: 'Life Values',     group: 'quick_actions', default_enabled: true, data_bearing: false, toggleable: true },
  { key: 'quick.transport',       label: 'Transport',       group: 'quick_actions', default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'quick.science_projects',label: 'Science Projects',group: 'quick_actions', default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'quick.profile',         label: 'Profile',         group: 'quick_actions', default_enabled: true, data_bearing: true,  toggleable: true },
  // Relocated quick actions (stable keys retained for existing overrides and API guards)
  { key: 'topbar.diary',          label: 'Diary',           group: 'quick_actions', default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'topbar.lms',            label: 'LMS',             group: 'quick_actions', default_enabled: true, data_bearing: true,  toggleable: true },
  // home
  { key: 'home.todays_snapshot',  label: "Today's Snapshot (attendance)", group: 'home', default_enabled: true, data_bearing: true, toggleable: true },
  { key: 'home.academic_advisor', label: 'Academic Advisor',group: 'home',          default_enabled: true, data_bearing: true,  toggleable: true },
  // bottom_nav
  { key: 'nav.time_table',        label: 'Time Table',      group: 'bottom_nav',    default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'nav.fees',              label: 'Fees',            group: 'bottom_nav',    default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'nav.results',           label: 'Results',         group: 'bottom_nav',    default_enabled: true, data_bearing: true,  toggleable: true },
  { key: 'nav.home',              label: 'Home',            group: 'bottom_nav',    default_enabled: true, data_bearing: true,  toggleable: false },
];

const REGISTRY_BY_KEY = new Map(FEATURE_REGISTRY.map((f) => [f.key, f]));

export const getFeature = (key) => REGISTRY_BY_KEY.get(key) || null;

/** Registry defaults as a plain { key: boolean } map — the fail-safe baseline. */
export function registryDefaults() {
  return FEATURE_REGISTRY.reduce((acc, f) => {
    acc[f.key] = f.default_enabled;
    return acc;
  }, {});
}

/** Fetch override rows for a school (student role) as a { feature_key: enabled } map. */
async function fetchOverrides(schoolId) {
  const rows = await sql`
    SELECT feature_key, enabled
    FROM school_feature_flags
    WHERE school_id = ${schoolId} AND role = ${STUDENT_ROLE}
  `;
  return rows.reduce((acc, r) => {
    acc[r.feature_key] = r.enabled;
    return acc;
  }, {});
}

/** Pure merge: registry defaults overlaid with a { feature_key: enabled } override map. */
export function mergeOverrides(overrides = {}) {
  return FEATURE_REGISTRY.reduce((acc, f) => {
    acc[f.key] = Object.prototype.hasOwnProperty.call(overrides, f.key)
      ? overrides[f.key]
      : f.default_enabled;
    return acc;
  }, {});
}

/**
 * Effective { feature_key: boolean } map for a school:
 * registry defaults overlaid with any override rows.
 */
export async function resolveFeatures(schoolId) {
  return mergeOverrides(await fetchOverrides(schoolId));
}

/** Effective value for a single feature (override row if present, else registry default). */
export async function isFeatureEnabled(schoolId, featureKey) {
  const feature = getFeature(featureKey);
  if (!feature) return true; // unknown key: never block on a typo
  const [row] = await sql`
    SELECT enabled
    FROM school_feature_flags
    WHERE school_id = ${schoolId} AND role = ${STUDENT_ROLE} AND feature_key = ${featureKey}
    LIMIT 1
  `;
  return row ? row.enabled === true : feature.default_enabled;
}
