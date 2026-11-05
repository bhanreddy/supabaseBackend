/**
 * Transport ETA service — live tracking v2, Phase C.
 * (see TRANSPORT_LIVE_TRACKING_PLAN.md)
 *
 * Predictive ETA to the student's boarding stop:
 *   - current (partial) leg: proportion of learned segment time remaining,
 *     guarded by route proximity; otherwise straight-line ÷ bounded live speed.
 *   - each full stop→stop segment after that: the LEARNED travel time
 *     (route_segment_time EWMA), which captures real dwell + traffic that a
 *     straight-line guess ignores. Segments with no learned time fall back to
 *     straight-line ÷ fallback speed.
 * Stored EW-variance yields a confidence range (eta_low..eta_high) and a
 * coarse confidence label. Pure + unit-tested; the endpoint only fetches rows.
 */

const R_KM = 6371;
const DEFAULT_FALLBACK_SPEED_KMH = 25;
const MAX_BUS_SPEED_KMH = 90;
/** Relative SD applied to the live leg and to straight-line fallback segments. */
const CURRENT_LEG_REL_SD = 0.25;
const FALLBACK_SEG_REL_SD = 0.4;
/** Variance floor per learned segment (≥10% of the mean) so ranges stay honest. */
const LEARNED_SEG_MIN_REL_SD = 0.1;
const HIGH_CONF_MIN_SAMPLES = 3;

const haversineKm = (aLat, aLng, bLat, bLng) => {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const hasCoords = s => s && s.latitude != null && s.longitude != null && Number.isFinite(Number(s.latitude)) && Math.abs(Number(s.latitude))<=90 && Number.isFinite(Number(s.longitude)) && Math.abs(Number(s.longitude))<=180;
const num = (v) => Number(v);

/** Segment lookup key. */
export const segKey = (fromStopId, toStopId) => `${fromStopId}->${toStopId}`;

/**
 * @param {object} p
 * @param {{latitude,longitude,speed}|null} p.location  live bus fix
 * @param {Array<{id,latitude,longitude,status,exec_order}>} p.stops  exec order
 * @param {string} p.boardingStopId
 * @param {Object<string,{ewma:number,ewvar:number,count:number}>} [p.segments]
 * @param {number} [p.fallbackSpeedKmh]
 * @returns {{eta_minutes, eta_low_minutes, eta_high_minutes, confidence, distance_km, source}}
 */
export function computeLearnedEta({
  location,
  stops,
  boardingStopId,
  segments = {},
  fallbackSpeedKmh = DEFAULT_FALLBACK_SPEED_KMH,
  now = Date.now(),
}) {
  if (!Number.isFinite(fallbackSpeedKmh) || fallbackSpeedKmh <= 0 || fallbackSpeedKmh > 250) fallbackSpeedKmh = DEFAULT_FALLBACK_SPEED_KMH;
  const none = {
    eta_minutes: null, eta_low_minutes: null, eta_high_minutes: null,
    confidence: 'low', distance_km: null, source: 'none',
  };
  const done = (src) => ({
    eta_minutes: 0, eta_low_minutes: 0, eta_high_minutes: 0,
    confidence: 'high', distance_km: 0, source: src,
  });

  // The execution order is authoritative, including reversed afternoon trips.
  stops = [...stops].sort((a, b) => (a.exec_order ?? a.stop_order ?? 0) - (b.exec_order ?? b.stop_order ?? 0));
  const boardingIdx = stops.findIndex((s) => s.id === boardingStopId);
  if (boardingIdx === -1) return none;
  const boarding = stops[boardingIdx];
  if (['completed','skipped'].includes(boarding.status)) return {...none,source:boarding.status};
  if (!hasCoords(location) || location.is_mocked || location.is_suspicious || location.accuracy != null && (!Number.isFinite(Number(location.accuracy)) || Number(location.accuracy) < 0 || Number(location.accuracy) > 100) || !Number.isFinite(Date.parse(location.recorded_at)) || now-Date.parse(location.recorded_at)>30000 || Date.parse(location.recorded_at)>now+5000) return {...none,source:'stale_or_unavailable'};
  if (boarding.status==='arrived') return done('arrived');

  // First stop the bus is still heading to.
  const nextIdx = stops.findIndex((s) => s.status === 'pending' || s.status === 'arrived');
  if (nextIdx === -1 || nextIdx > boardingIdx) return {...none,source:'passed'};

  let totalSec = 0;
  let totalVar = 0;
  let distanceKm = 0;
  let learnedSegs = 0;
  let fallbackSegs = 0;
  let minSamples = Infinity;

  // Estimate the unfinished leg using the learned segment when the fix lies
  // near its corridor. This preserves measured traffic/dwell instead of letting
  // a momentary speed spike erase several minutes of expected travel time.
  const next = stops[nextIdx];
  if (!hasCoords(next)) return none;
  const dKm = haversineKm(num(location.latitude), num(location.longitude), num(next.latitude), num(next.longitude));
  distanceKm += dKm;
  const previous = stops[nextIdx - 1];
  const partial = previous && segments[segKey(previous.id, next.id)];
  let usedLearnedPartial = false;
  let uncertainLiveSpeed = false;
  if (next.status !== 'arrived') {
    if (hasCoords(previous) && partial && Number.isFinite(partial.ewma) && partial.ewma > 0 && partial.ewma <= 10800) {
      const fullKm = haversineKm(num(previous.latitude), num(previous.longitude), num(next.latitude), num(next.longitude));
      const fromKm = haversineKm(num(previous.latitude), num(previous.longitude), num(location.latitude), num(location.longitude));
      // Triangle excess guards against using an unrelated/off-route segment.
      if (fullKm > 0.03 && fromKm + dKm <= fullKm + Math.max(0.15, fullKm * 0.15)) {
        const remaining = Math.min(1, dKm / fullKm);
        const legSec = partial.ewma * remaining;
        totalSec += legSec;
        totalVar += Math.max(Number.isFinite(partial.ewvar) ? partial.ewvar : 0, (partial.ewma * CURRENT_LEG_REL_SD) ** 2) * remaining ** 2;
        learnedSegs++;
        minSamples = Math.min(minSamples, partial.count || 1);
        usedLearnedPartial = true;
      }
    }
    if (!usedLearnedPartial) {
      const liveSpeed = num(location.speed);
      const moving = location.speed != null && Number.isFinite(liveSpeed) && liveSpeed >= 5 && liveSpeed <= MAX_BUS_SPEED_KMH;
      uncertainLiveSpeed = !moving;
      const speed = moving ? liveSpeed : Math.min(fallbackSpeedKmh, MAX_BUS_SPEED_KMH);
      const legSec = (dKm / speed) * 3600;
      totalSec += legSec;
      totalVar += (legSec * (moving ? CURRENT_LEG_REL_SD : 0.6)) ** 2;
    }
  }

  // ── Full segments next → … → boarding ──
  for (let i = nextIdx; i < boardingIdx; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    const seg = segments[segKey(a.id, b.id)];
    if (seg && Number.isFinite(seg.ewma) && seg.ewma >= 0 && seg.ewma <= 10800) {
      totalSec += seg.ewma;
      totalVar += Math.max(Number.isFinite(seg.ewvar) ? seg.ewvar : 0, (seg.ewma * LEARNED_SEG_MIN_REL_SD) ** 2);
      learnedSegs++;
      minSamples = Math.min(minSamples, seg.count || 1);
      if (hasCoords(a) && hasCoords(b)) {
        distanceKm += haversineKm(num(a.latitude), num(a.longitude), num(b.latitude), num(b.longitude));
      }
    } else if (hasCoords(a) && hasCoords(b)) {
      const dKm = haversineKm(num(a.latitude), num(a.longitude), num(b.latitude), num(b.longitude));
      distanceKm += dKm;
      const segSec = (dKm / fallbackSpeedKmh) * 3600;
      totalSec += segSec;
      totalVar += (segSec * FALLBACK_SEG_REL_SD) ** 2;
      fallbackSegs++;
    } else {
      return none; // A missing segment must not silently contribute zero travel time.
    }
  }

  const totalSegs = learnedSegs + fallbackSegs;
  let confidence;
  if (totalSegs === 0) confidence = 'medium';               // just the live leg
  else if (fallbackSegs === 0 && minSamples >= HIGH_CONF_MIN_SAMPLES) confidence = 'high';
  else if (learnedSegs >= fallbackSegs) confidence = 'medium';
  else confidence = 'low';

  const ageSeconds = Math.max(0, (now - Date.parse(location.recorded_at)) / 1000);
  // A stopped bus, inaccurate fix or delayed packet deserves a wider range.
  // Never count down an old ETA as if motion after capture were observed.
  const degraded = uncertainLiveSpeed || Number(location.speed) <= 2 || ageSeconds > 15 || Number(location.accuracy) > 50;
  if (degraded) confidence = 'low';
  totalVar += (ageSeconds * 0.5) ** 2;
  const sd = Math.sqrt(totalVar);
  const toMin = (s) => s / 60;
  // Only an actual arrived status can promise zero. Rounding a moving bus to
  // zero was making parents see “arriving now” hundreds of metres too early.
  const point = Math.max(1, Math.round(toMin(totalSec)));
  return {
    eta_minutes: point,
    eta_low_minutes: Math.max(0, Math.round(toMin(totalSec - sd))),
    eta_high_minutes: Math.max(point, Math.round(toMin(totalSec + sd))),
    confidence,
    distance_km: Math.round(distanceKm * 100) / 100,
    source: learnedSegs > 0 ? (fallbackSegs > 0 ? 'hybrid' : 'learned') : 'straight_line',
  };
}
