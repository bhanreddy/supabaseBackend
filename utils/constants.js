export const ACCOUNTS_STAT_KEYS = [
  'total_collection_month',
  'todays_collection',
  'pending_dues',
  'revenue_trend',
  'collection_efficiency',
  'avg_attendance',
  'academic_score',
  'system_insights'
];

/** Parse JSONB / string config from DB into a plain object. */
export function parseAccountsDashboardConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

/** Resolve stored config to explicit booleans (missing => visible). */
export function resolveAccountsDashboardConfig(rawConfig) {
  const parsed = parseAccountsDashboardConfig(rawConfig);
  return ACCOUNTS_STAT_KEYS.reduce((acc, key) => {
    acc[key] = parsed[key] !== false;
    return acc;
  }, {});
}
