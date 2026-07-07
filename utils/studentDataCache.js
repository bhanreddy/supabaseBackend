// OPT: TTL Map for semi-static API payloads to cut repeat DB reads on hot paths (e.g. timetable slots).
/**
 * In-memory TTL cache for semi-static student API payloads (timetable, dashboard, etc.).
 * Keys must include school_id + student scope to avoid cross-tenant leakage.
 */

const store = new Map(); // key -> { value, expiresAt }

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function studentCacheGet(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function studentCacheSet(key, value, ttlMs = DEFAULT_TTL_MS) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function studentCacheDelete(key) {
  store.delete(key);
}

/** Remove all entries whose keys start with prefix (e.g. "1:timetable:"). */
export function studentCacheDeleteByPrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
}

export function studentCacheKey(studentId, schoolId, dataType) {
  return `${schoolId}:student:${studentId}:${dataType}`;
}
