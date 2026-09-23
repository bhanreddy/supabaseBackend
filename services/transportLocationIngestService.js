import { evaluateOverspeed } from './transportSafetyService.js';
import { evaluateTripSignals } from './transportSignalService.js';
import sql from '../db.js';
import { transportError, withTransportTransaction } from './transportAccessService.js';
import { evaluateGeofence } from './transportGeofenceService.js';
export const LOCATION_BATCH = Object.freeze({
  MAX_FIXES: 1000,
  MAX_AGE_MS: 21600000,
  MAX_FUTURE_SKEW_MS: 5000,
  FRESH_MS: 30000,
  REALTIME_MIN_INTERVAL_SECONDS: 0
});
const number = v => typeof v === 'number' && Number.isFinite(v);
export function validateLocationFix(raw) {
  if (!raw || !number(raw.latitude) || Math.abs(raw.latitude) > 90 || !number(raw.longitude) || Math.abs(raw.longitude) > 180) return null;
  const recordedMs = typeof raw.recorded_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw.recorded_at) ? Date.parse(raw.recorded_at) : NaN;
  if (!Number.isFinite(recordedMs) || raw.is_mocked != null && typeof raw.is_mocked !== 'boolean') return null;
  for (const [key, max] of [['speed', 250], ['heading', 360], ['accuracy', 10000]]) {
    if (raw[key] != null && (!number(raw[key]) || raw[key] < 0 || raw[key] > max || key === 'heading' && raw[key] === 360)) return null;
  }
  if (raw.fix_id != null && (typeof raw.fix_id !== 'string' || !raw.fix_id.length || raw.fix_id.length > 160)) return null;
  return {
    latitude: raw.latitude,
    longitude: raw.longitude,
    speed: raw.speed ?? null,
    heading: raw.heading ?? null,
    accuracy: raw.accuracy ?? null,
    recorded_at: new Date(recordedMs).toISOString(),
    is_mocked: raw.is_mocked === true,
    fix_id: raw.fix_id ?? null
  };
}
export function normalizeLocationBatch(rawFixes, now = new Date()) {
  if (!Array.isArray(rawFixes)) throw new TypeError('fixes must be an array');
  if (!rawFixes.length || rawFixes.length > LOCATION_BATCH.MAX_FIXES) throw new RangeError('Send between 1 and 1000 fixes');
  const seen = new Set(),
    fixes = [],
    acknowledgements = [];
  let invalidCount = 0,
    staleCount = 0,
    duplicateCount = 0;
  rawFixes.forEach((raw, index) => {
    const fix = validateLocationFix(raw),
      ack = {
        index,
        fix_id: typeof raw?.fix_id === 'string' ? raw.fix_id : null
      };
    if (!fix) {
      invalidCount++;
      ack.status = 'rejected';
      ack.reason = 'invalid_fix';
    } else if (Date.parse(fix.recorded_at) < now.getTime() - LOCATION_BATCH.MAX_AGE_MS || Date.parse(fix.recorded_at) > now.getTime() + LOCATION_BATCH.MAX_FUTURE_SKEW_MS) {
      staleCount++;
      ack.status = 'rejected';
      ack.reason = 'timestamp_out_of_range';
    } else if (seen.has(fix.fix_id || fix.recorded_at)) {
      duplicateCount++;
      ack.status = 'duplicate';
    } else {
      seen.add(fix.fix_id || fix.recorded_at);
      fixes.push({
        ...fix,
        index
      });
      ack.status = 'accepted';
    }
    acknowledgements.push(ack);
  });
  fixes.sort((a, b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at));
  return {
    fixes,
    acknowledgements,
    invalidCount,
    staleCount,
    duplicateCount
  };
}
export async function ingestLocationBatch({
  schoolId,
  busId,
  tripId,
  sessionId,
  deviceId,
  driverId,
  fixes: rawFixes,
  now = new Date()
}, db = sql) {
  if (!tripId || !sessionId || !deviceId || !driverId) throw transportError(409, 'TRACKING_SESSION_REQUIRED', 'Start or resume tracking before uploading locations');
  const normalized = normalizeLocationBatch(rawFixes, now);
  return withTransportTransaction(db, async tx => {
    const [trip] = await tx`SELECT t.* FROM trips t JOIN buses b ON b.id=t.bus_id AND b.school_id=t.school_id
      WHERE t.id=${tripId} AND t.school_id=${schoolId} AND t.bus_id=${busId} AND t.driver_id=${driverId}
      AND b.driver_id=${driverId} AND b.is_active=true AND b.deleted_at IS NULL FOR UPDATE OF t`;
    if (!trip || trip.tracking_session_id !== sessionId || trip.tracking_device_id !== deviceId) throw transportError(409, 'TRACKING_SESSION_CHANGED', 'Tracking session has changed');
    const eligible = normalized.fixes.filter(fix => {
      const outside = Date.parse(fix.recorded_at) < new Date(trip.started_at).getTime() || trip.ended_at && Date.parse(fix.recorded_at) > new Date(trip.ended_at).getTime();
      if (outside) Object.assign(normalized.acknowledgements[fix.index], {
        status: 'rejected',
        reason: 'outside_trip'
      });
      return !outside;
    });
    const inserted = eligible.length ? await tx`INSERT INTO bus_trip_history
      (school_id,bus_id,trip_id,session_id,fix_id,latitude,longitude,speed,heading,accuracy,recorded_at,is_mocked,is_suspicious)
      SELECT ${schoolId},${busId},${trip.id},${sessionId},f.fix_id,f.latitude,f.longitude,f.speed,f.heading,f.accuracy,f.recorded_at,f.is_mocked,f.is_mocked
      FROM jsonb_to_recordset(${tx.json(eligible)}) AS f(fix_id text,latitude double precision,longitude double precision,speed double precision,
        heading double precision,accuracy double precision,recorded_at timestamptz,is_mocked boolean)
      ON CONFLICT DO NOTHING RETURNING fix_id,recorded_at` : [];
    const insertedKeys = new Set(inserted.map(row => `${row.fix_id || ''}:${new Date(row.recorded_at).getTime()}`));
    const accepted = eligible.filter(fix => {
      const exists = insertedKeys.has(`${fix.fix_id || ''}:${Date.parse(fix.recorded_at)}`);
      if (!exists) normalized.acknowledgements[fix.index].status = 'duplicate';
      return exists;
    });
    const insertedCount = inserted.length;
    const liveTrip = ['active', 'in_progress'].includes(trip.status);
    // Only fresh observations from this session may affect live state. History remains useful for audit.
    const fresh = accepted.filter(f => liveTrip && !f.is_mocked && now.getTime() - Date.parse(f.recorded_at) <= LOCATION_BATCH.FRESH_MS);
    const newest = fresh.at(-1);
    let location = null;
    if (newest) {
      [location] = await tx`INSERT INTO bus_locations(school_id,bus_id,trip_id,latitude,longitude,speed,heading,accuracy,recorded_at,is_mocked,is_suspicious)
        VALUES(${schoolId},${busId},${trip.id},${newest.latitude},${newest.longitude},${newest.speed},${newest.heading},${newest.accuracy},${newest.recorded_at},false,false)
        ON CONFLICT(bus_id) DO UPDATE SET trip_id=EXCLUDED.trip_id,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,
          speed=EXCLUDED.speed,heading=EXCLUDED.heading,accuracy=EXCLUDED.accuracy,recorded_at=EXCLUDED.recorded_at,received_at=now(),is_mocked=false,is_suspicious=false
        WHERE bus_locations.school_id=EXCLUDED.school_id AND EXCLUDED.recorded_at>bus_locations.recorded_at RETURNING *`;
      for (const fix of fresh) {
        if (trip.last_automation_at && Date.parse(fix.recorded_at) <= new Date(trip.last_automation_at).getTime()) continue;
        await evaluateGeofence(schoolId, busId, fix, tx, trip);
        await evaluateTripSignals(trip, fix, tx);
        await evaluateOverspeed(schoolId, busId, {
          ...fix,
          trip_id: trip.id
        }, tx);
        trip.last_automation_at = fix.recorded_at;
      }
      await tx`UPDATE trips SET last_automation_at=${trip.last_automation_at} WHERE id=${trip.id} AND school_id=${schoolId}`;
    }
    await tx`INSERT INTO driver_heartbeat(school_id,driver_id,last_ping,status) VALUES(${schoolId},${driverId},now(),'online')
      ON CONFLICT(school_id,driver_id) DO UPDATE SET last_ping=now(),status='online' WHERE driver_heartbeat.school_id=${schoolId}`;
    return {
      ...normalized,
      fixes: accepted,
      insertedCount,
      realtimeUpdated: Boolean(location),
      location: location || null,
      newestForEvaluation: null
    };
  });
}
// Compatibility export: request handlers must not schedule state changes after committing GPS.
export async function runNewestFixEffects() {
  return;
}
