/**
 * Transport ETA service — live tracking v2, Phase C.
 * (see TRANSPORT_LIVE_TRACKING_PLAN.md)
 *
 * Predictive ETA to the student's boarding stop:
 *   - current (partial) leg bus→next-stop: live straight-line ÷ live speed —
 *     most accurate for the part the bus is actively driving.
 *   - each full stop→stop segment after that: the LEARNED travel time
 *     (route_segment_time EWMA), which captures real dwell + traffic that a
 *     straight-line guess ignores. Segments with no learned time fall back to
 *     straight-line ÷ fallback speed.
 * Stored EW-variance yields a confidence range (eta_low..eta_high) and a
 * coarse confidence label. Pure + unit-tested; the endpoint only fetches rows.
 */

const R_KM = 6371;
const DEFAULT_FALLBACK_SPEED_KMH = 25;
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

const hasCoords = (s) => s && s.latitude != null && s.longitude != null;
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
}) {
  const none = {
    eta_minutes: null, eta_low_minutes: null, eta_high_minutes: null,
    confidence: 'low', distance_km: null, source: 'none',
  };
  const done = (src) => ({
    eta_minutes: 0, eta_low_minutes: 0, eta_high_minutes: 0,
    confidence: 'high', distance_km: 0, source: src,
  });

  const boardingIdx = stops.findIndex((s) => s.id === boardingStopId);
  if (boardingIdx === -1) return none;
  const boarding = stops[boardingIdx];
  if (['completed', 'skipped', 'arrived'].includes(boarding.status)) return done('arrived');
  if (!location) return none;

  // First stop the bus is still heading to.
  const nextIdx = stops.findIndex((s) => s.status === 'pending' || s.status === 'arrived');
  if (nextIdx === -1 || nextIdx > boardingIdx) return done('passed');

  let totalSec = 0;
  let totalVar = 0;
  let distanceKm = 0;
  let learnedSegs = 0;
  let fallbackSegs = 0;
  let minSamples = Infinity;

  // ── Live partial leg: bus → next stop ──
  const next = stops[nextIdx];
  const speed = num(location.speed) >= 5 ? num(location.speed) : fallbackSpeedKmh;
  if (hasCoords(next)) {
    const dKm = haversineKm(num(location.latitude), num(location.longitude), num(next.latitude), num(next.longitude));
    distanceKm += dKm;
    const legSec = (dKm / speed) * 3600;
    totalSec += legSec;
    totalVar += (legSec * CURRENT_LEG_REL_SD) ** 2;
  }

  // ── Full segments next → … → boarding ──
  for (let i = nextIdx; i < boardingIdx; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    const seg = segments[segKey(a.id, b.id)];
    if (seg && seg.ewma != null) {
      totalSec += seg.ewma;
      totalVar += Math.max(seg.ewvar || 0, (seg.ewma * LEARNED_SEG_MIN_REL_SD) ** 2);
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
      fallbackSegs++; // unknown segment (no learned time, no coords)
    }
  }

  const totalSegs = learnedSegs + fallbackSegs;
  let confidence;
  if (totalSegs === 0) confidence = 'medium';               // just the live leg
  else if (fallbackSegs === 0 && minSamples >= HIGH_CONF_MIN_SAMPLES) confidence = 'high';
  else if (learnedSegs >= fallbackSegs) confidence = 'medium';
  else confidence = 'low';

  const sd = Math.sqrt(totalVar);
  const toMin = (s) => s / 60;
  const point = Math.round(toMin(totalSec));
  return {
    eta_minutes: point,
    eta_low_minutes: Math.max(0, Math.round(toMin(totalSec - sd))),
    eta_high_minutes: Math.max(point, Math.round(toMin(totalSec + sd))),
    confidence,
    distance_km: Math.round(distanceKm * 100) / 100,
    source: learnedSegs > 0 ? (fallbackSegs > 0 ? 'hybrid' : 'learned') : 'straight_line',
  };
}
