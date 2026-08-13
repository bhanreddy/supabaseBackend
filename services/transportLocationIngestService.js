/**
 * Phase E GPS ingestion primitives. All tenant identity is supplied by the
 * authenticated route, never by a client payload. DB is injectable so callers
 * and tests can use a rollback transaction.
 */
import sql from '../db.js';
import logger from '../utils/logger.js';

export const LOCATION_BATCH = Object.freeze({
  MAX_FIXES: 1000,
  MAX_AGE_MS: 6 * 60 * 60 * 1000,
  MAX_FUTURE_SKEW_MS: 5 * 60 * 1000,
  REALTIME_MIN_INTERVAL_SECONDS: 5,
});

const finiteOrNull = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function validateLocationFix(raw) {
  const latitude = finiteOrNull(raw?.latitude);
  const longitude = finiteOrNull(raw?.longitude);
  const speed = finiteOrNull(raw?.speed);
  const heading = finiteOrNull(raw?.heading);
  const recordedMs = Date.parse(raw?.recorded_at);

  if (latitude == null || latitude < -90 || latitude > 90) return null;
  if (longitude == null || longitude < -180 || longitude > 180) return null;
  if (!Number.isFinite(recordedMs)) return null;
  if (raw?.speed != null && speed == null) return null;
  if (raw?.heading != null && heading == null) return null;

  return {
    latitude,
    longitude,
    speed,
    heading,
    recorded_at: new Date(recordedMs).toISOString(),
    is_mocked: raw?.is_mocked === true,
  };
}

/** Pure validation, age filtering, timestamp deduplication, and ordering. */
export function normalizeLocationBatch(rawFixes, now = new Date()) {
  if (!Array.isArray(rawFixes)) throw new TypeError('fixes must be an array');
  if (rawFixes.length === 0) throw new RangeError('fixes must not be empty');
  if (rawFixes.length > LOCATION_BATCH.MAX_FIXES) {
    throw new RangeError(`fixes must contain at most ${LOCATION_BATCH.MAX_FIXES} items`);
  }

  const nowMs = now.getTime();
  const byTimestamp = new Map();
  let invalidCount = 0;
  let staleCount = 0;

  for (const raw of rawFixes) {
    const fix = validateLocationFix(raw);
    if (!fix) {
      invalidCount += 1;
      continue;
    }
    const timestamp = Date.parse(fix.recorded_at);
    if (timestamp < nowMs - LOCATION_BATCH.MAX_AGE_MS ||
        timestamp > nowMs + LOCATION_BATCH.MAX_FUTURE_SKEW_MS) {
      staleCount += 1;
      continue;
    }
    byTimestamp.set(fix.recorded_at, fix);
  }

  const fixes = [...byTimestamp.values()]
    .sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
  return {
    fixes,
    invalidCount,
    staleCount,
    duplicateCount: rawFixes.length - invalidCount - staleCount - fixes.length,
  };
}

/**
 * Persist all accepted history fixes idempotently and advance the one live row
 * only when the newest client timestamp is at least five seconds newer.
 * Automation still receives the newest newly-persisted GPS point: UI map
 * throttling must never suppress an arrival/departure decision.
 */
export async function ingestLocationBatch({ schoolId, busId, fixes: rawFixes, now = new Date() }, db = sql) {
  const normalized = normalizeLocationBatch(rawFixes, now);
  if (normalized.fixes.length === 0) {
    return { ...normalized, insertedCount: 0, realtimeUpdated: false, newestForEvaluation: null };
  }

  const payload = JSON.stringify(normalized.fixes);
  const inserted = await db`
    INSERT INTO bus_trip_history
      (school_id, bus_id, latitude, longitude, speed, heading, recorded_at, is_mocked, is_suspicious)
    SELECT ${schoolId}, ${busId}, f.latitude, f.longitude, f.speed, f.heading,
           f.recorded_at, f.is_mocked, f.is_mocked
    FROM jsonb_to_recordset((${payload}::text)::jsonb) AS f(
      latitude double precision,
      longitude double precision,
      speed double precision,
      heading double precision,
      recorded_at timestamptz,
      is_mocked boolean
    )
    ON CONFLICT (bus_id, recorded_at) DO NOTHING
    RETURNING id, recorded_at
  `;

  // Mocked fixes remain in immutable history for audit evidence, but never
  // replace a real public live location or drive automation.
  // Only evaluate a newly recorded point, never an offline retry that was
  // already processed. The live-location row is intentionally rate-limited
  // for map traffic, but geofence debounce needs every fresh GPS observation.
  const insertedAtMs = new Set(inserted.map((row) => Date.parse(row.recorded_at)));
  const newest = [...normalized.fixes].reverse().find(
    (fix) => !fix.is_mocked && insertedAtMs.has(Date.parse(fix.recorded_at)),
  );
  if (!newest) {
    return {
      ...normalized,
      insertedCount: inserted.length,
      realtimeUpdated: false,
      newestForEvaluation: null,
      location: null,
    };
  }
  const [live] = await db`
    INSERT INTO bus_locations
      (school_id, bus_id, latitude, longitude, speed, heading, recorded_at, is_mocked, is_suspicious)
    VALUES
      (${schoolId}, ${busId}, ${newest.latitude}, ${newest.longitude}, ${newest.speed},
       ${newest.heading}, ${newest.recorded_at}, ${newest.is_mocked}, ${newest.is_mocked})
    ON CONFLICT (bus_id) DO UPDATE SET
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      speed = EXCLUDED.speed,
      heading = EXCLUDED.heading,
      recorded_at = EXCLUDED.recorded_at,
      is_mocked = EXCLUDED.is_mocked,
      is_suspicious = EXCLUDED.is_suspicious
    WHERE bus_locations.school_id = ${schoolId}
      AND EXCLUDED.recorded_at >= bus_locations.recorded_at
          + (${LOCATION_BATCH.REALTIME_MIN_INTERVAL_SECONDS} * INTERVAL '1 second')
    RETURNING *
  `;

  return {
    ...normalized,
    insertedCount: inserted.length,
    realtimeUpdated: Boolean(live),
    newestForEvaluation: newest,
    location: live || null,
  };
}

/** One explicit call site makes the "newest fix only" law testable. */
export async function runNewestFixEffects(context, dependencies) {
  if (!context?.fix || context.fix.is_mocked) return;
  const effects = [
    ['geofence', () => dependencies.evaluateGeofence(context.schoolId, context.busId, context.fix, dependencies.db)],
    ['approach_push', () => dependencies.notifyApproachingStop(
      context.schoolId, context.busId, context.fix.latitude, context.fix.longitude, dependencies.db,
    )],
    ['running_late', () => dependencies.evaluateRunningLate(context.schoolId, context.busId, context.fix, dependencies.db)],
  ];
  for (const [effect, run] of effects) {
    try {
      await run();
    } catch (error) {
      // Side effects are intentionally isolated: GPS persistence must survive
      // a failed FCM call, calibration query, or worker outage.
      logger.error({ err: error, event: 'transport_side_effect_failed', effect, schoolId: context.schoolId, busId: context.busId }, 'Transport side effect failed');
    }
  }
}
