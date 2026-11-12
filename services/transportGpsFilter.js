/**
 * Trip-local, event-time GPS quality gate and bounded position filter.
 * State is persisted under the trip row lock, never in process memory.
 * Raw observations remain in history; only qualified fixes affect live state.
 */
export const GPS_FILTER = Object.freeze({
  VERSION: 1,
  MAX_ACCURACY_M: 50,
  MIN_ACCURACY_M: 3,
  MAX_SPEED_MPS: 45, // 162 km/h: plausibility bound, not a permitted bus speed.
  REACQUIRE_GAP_MS: 30000,
  REACQUIRE_HITS: 3,
  REACQUIRE_SPAN_MS: 4000,
  REACQUIRE_MAX_GAP_MS: 10000,
  MAX_SMOOTHING_OFFSET_M: 15,
});
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rad = degrees => degrees * Math.PI / 180;
export function gpsDistance(a, b) {
  const dlat = rad(b.latitude - a.latitude), dlng = rad(b.longitude - a.longitude);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dlng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(Math.max(0, h))));
}
const validPoint = point => point && finite(point.latitude) && Math.abs(point.latitude) <= 90
  && finite(point.longitude) && Math.abs(point.longitude) <= 180;
const accuracy = fix => Math.max(GPS_FILTER.MIN_ACCURACY_M, fix.accuracy);
const speedMps = fix => finite(fix.speed) && fix.speed >= 0 && fix.speed <= 162 ? fix.speed / 3.6 : null;
const longitudeDelta = (from, to) => ((to - from + 540) % 360) - 180;
const mix = (a, b, gain) => ({
  latitude: a.latitude + (b.latitude - a.latitude) * gain,
  longitude: ((a.longitude + longitudeDelta(a.longitude, b.longitude) * gain + 540) % 360) - 180,
});
function reachable(a, b) {
  const seconds = (Date.parse(b.recorded_at) - Date.parse(a.recorded_at)) / 1000;
  if (seconds <= 0) return false;
  const distance = Math.max(0, gpsDistance(a, b) - accuracy(a) - accuracy(b));
  // A speed-sensitive envelope catches spikes below the absolute ceiling while
  // allowing acceleration and uncertainty. Long gaps require confirmation.
  const reported = Math.max(speedMps(a) ?? 0, speedMps(b) ?? 0);
  const limit = seconds <= 10 ? Math.min(GPS_FILTER.MAX_SPEED_MPS, Math.max(25, reported + 8) + seconds * 1.5) : GPS_FILTER.MAX_SPEED_MPS;
  return distance <= limit * seconds;
}
function course(a, b) {
  const longitude = rad(longitudeDelta(a.longitude, b.longitude));
  return (Math.atan2(Math.sin(longitude) * Math.cos(rad(b.latitude)),
    Math.cos(rad(a.latitude)) * Math.sin(rad(b.latitude)) - Math.sin(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.cos(longitude)) * 180 / Math.PI + 360) % 360;
}
function cleanState(value) {
  return value?.version === GPS_FILTER.VERSION && validPoint(value.anchor) && finite(value.anchor.accuracy)
    && validPoint(value.position) && Number.isFinite(Date.parse(value.anchor.recorded_at)) ? value : null;
}

/** The returned automationFix uses qualified RAW coordinates, never smoothed coordinates. */
export function filterGpsFix(previousState, fix) {
  let state = cleanState(previousState);
  const time = Date.parse(fix.recorded_at);
  const reject = reason => ({ state, accepted: false, reason, position: null, automationFix: null });
  if (!validPoint(fix) || !Number.isFinite(time)) return reject('invalid_fix');
  // Equal-timestamp observations never count as independent evidence.
  if (state && time <= Date.parse(state.last_seen_at || state.anchor.recorded_at)) return reject('out_of_order');
  if (state) state = { ...state, last_seen_at: fix.recorded_at };
  if (fix.is_mocked || fix.is_suspicious) {
    if (state) state.pending = null;
    return reject('mocked_or_suspicious');
  }
  if (!finite(fix.accuracy) || fix.accuracy < 0 || fix.accuracy > GPS_FILTER.MAX_ACCURACY_M) {
    if (state) state.pending = null; // Poor fixes cannot bridge reacquisition evidence.
    return reject('poor_accuracy');
  }
  let reacquired = false;
  if (state) {
    const gap = time - Date.parse(state.anchor.recorded_at);
    if (gap >= GPS_FILTER.REACQUIRE_GAP_MS) {
      const pending = state.pending;
      const continuous = pending && time - Date.parse(pending.fix.recorded_at) <= GPS_FILTER.REACQUIRE_MAX_GAP_MS
        && reachable(pending.fix, fix);
      const next = { fix, hits: continuous ? pending.hits + 1 : 1, first_at: continuous ? pending.first_at : fix.recorded_at };
      state.pending = next;
      if (next.hits < GPS_FILTER.REACQUIRE_HITS || time - Date.parse(next.first_at) < GPS_FILTER.REACQUIRE_SPAN_MS) return reject('reacquiring');
      reacquired = true;
    } else if (!reachable(state.anchor, fix)) {
      state.pending = null;
      return reject('implausible_jump');
    }
  }

  const anchor = state?.anchor;
  const seconds = anchor ? (time - Date.parse(anchor.recorded_at)) / 1000 : 0;
  const distance = anchor ? gpsDistance(anchor, fix) : 0;
  const sensorSpeed = speedMps(fix);
  const measurableMotion = anchor && seconds >= 1 && seconds < 15
    && distance > accuracy(anchor) + accuracy(fix) + 3;
  // Do not turn ordinary stationary noise into a speed/heading measurement.
  const derivedSpeed = measurableMotion ? Math.min(GPS_FILTER.MAX_SPEED_MPS, distance / seconds) : null;
  const movingSpeed = Math.max(sensorSpeed ?? 0, derivedSpeed ?? 0);
  const stationary = sensorSpeed != null && movingSpeed <= 2 / 3.6;
  let point = { latitude: fix.latitude, longitude: fix.longitude };
  let variance = accuracy(fix) ** 2;
  if (state && !reacquired) {
    const prior = state.position;
    const processNoise = Math.max(2, movingSpeed) * seconds;
    const predictedVariance = Math.max(9, state.variance || 9) + processNoise ** 2;
    let gain = predictedVariance / (predictedVariance + variance);
    const jitterRadius = Math.min(12, Math.max(3, (accuracy(anchor) + accuracy(fix)) / 2));
    const withinStationaryNoise = stationary && gpsDistance(prior, fix) <= jitterRadius;
    // Slowly converge while stopped instead of freezing a biased first fix.
    // A newly much more precise observation receives priority immediately.
    gain = withinStationaryNoise ? Math.max(0.1, Math.min(0.25, gain)) : Math.max(0.65, gain);
    if (accuracy(fix) * 2 < accuracy(anchor)) gain = Math.max(0.85, gain);
    point = mix(prior, fix, gain);
    // Bound latency through bends and departures; never drag a moving bus far
    // behind the measured coordinate just to make its marker look smooth.
    if (gpsDistance(point, fix) > Math.min(GPS_FILTER.MAX_SMOOTHING_OFFSET_M, accuracy(fix) * 0.75)) {
      point = { latitude: fix.latitude, longitude: fix.longitude };
    }
    variance = Math.max(9, (1 - gain) * predictedVariance);
  }
  const speed = stationary ? 0 : sensorSpeed != null ? Math.max(sensorSpeed, derivedSpeed ?? 0) * 3.6 : derivedSpeed != null ? derivedSpeed * 3.6 : null;
  const heading = movingSpeed >= 3 / 3.6
    ? finite(fix.heading) && fix.heading >= 0 && fix.heading < 360 ? fix.heading : measurableMotion ? course(anchor, fix) : null
    : null;
  const position = { ...fix, ...point, speed, heading,
    // Preserve sensor uncertainty and account for filter offset. A smooth dot
    // is never advertised as more precise than the phone's observation.
    accuracy: Math.max(accuracy(fix), fix.accuracy + gpsDistance(point, fix)),
  };
  return {
    state: { version: GPS_FILTER.VERSION, anchor: fix, position, variance, last_seen_at: fix.recorded_at, pending: null },
    accepted: true, reason: reacquired ? 'reacquired' : stationary ? 'stationary' : 'tracking', position,
    automationFix: reacquired ? null : { ...fix, speed, heading },
  };
}

/** Compatibility gate for released apps that do not transmit sensor accuracy.
 * Retain that uncertainty, reject jumps/replays/mocked fixes, and expose raw
 * coordinates only. The geofence applies a tighter radius and longer dwell.
 */
export function filterLegacyGpsFix(previousState, fix) {
  let state = previousState || {};
  const anchor = state.legacy_anchor || state.anchor;
  const time = Date.parse(fix.recorded_at);
  const reject = reason => ({ state, accepted: false, reason, position: null, automationFix: null });
  if (!validPoint(fix) || !Number.isFinite(time)) return reject('invalid_fix');
  if (fix.is_mocked || fix.is_suspicious) return reject('mocked_or_suspicious');
  const seconds = anchor ? (time - Date.parse(anchor.recorded_at)) / 1000 : null;
  if (seconds != null && seconds <= 0) return reject('out_of_order');
  const distance = anchor ? gpsDistance(anchor, fix) : 0;
  if (seconds != null && distance > GPS_FILTER.MAX_SPEED_MPS * seconds) return reject('implausible_jump');
  const derivedSpeed = seconds != null && distance > 10 ? distance / seconds * 3.6 : 0;
  const speed = Math.max(derivedSpeed, fix.speed ?? 0);
  const raw = { ...fix, accuracy: null, speed };
  state = { ...state, legacy_anchor: raw };
  return { state, accepted: true, reason: 'legacy_accuracy_unknown', position: raw,
    automationFix: { ...raw, legacy_accuracy_unknown: true } };
}
