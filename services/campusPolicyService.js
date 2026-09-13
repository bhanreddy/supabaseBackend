import sql from '../db.js';
import { toZonedTime } from 'date-fns-tz';

/**
 * Great-circle distance between two coordinates in meters (Haversine formula).
 */
export function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Fetch active campus policy for a school.
 */
export async function getCampusPolicy(schoolId, campusId = null) {
  let rows;
  if (campusId) {
    rows = await sql`
      SELECT * FROM campus_attendance_policies
      WHERE id = ${campusId} AND school_id = ${schoolId} AND is_active = true
      LIMIT 1
    `;
  } else {
    rows = await sql`
      SELECT * FROM campus_attendance_policies
      WHERE school_id = ${schoolId} AND is_active = true
      ORDER BY created_at ASC
      LIMIT 1
    `;
  }

  if (!rows.length) {
    // Return safe default policy if not explicitly configured in DB
    return {
      id: null,
      school_id: schoolId,
      campus_name: 'Main Campus',
      center_latitude: 17.385044,
      center_longitude: 78.486671,
      radius_meters: 150.0,
      max_location_age_seconds: 30,
      max_accuracy_meters: 50.0,
      challenge_expiry_seconds: 60,
      policy_version: '1.0',
      enforcement_mode: 'disabled',
      school_timezone: 'Asia/Kolkata',
      check_in_start_time: '06:00',
      check_in_end_time: '12:00',
      check_out_start_time: '14:00',
      check_out_end_time: '20:00',
      grace_period_minutes: 15,
    };
  }

  return rows[0];
}

/**
 * Validates location evidence against campus policy.
 * Evaluates coordinates, freshness, reported accuracy, and geofence boundary uncertainty.
 */
export function evaluateLocationPolicy(location, policy, serverNow = new Date()) {
  if (!location || typeof location !== 'object') {
    return { ok: false, code: 'LOCATION_MISSING', message: 'Location evidence is missing' };
  }

  const { latitude, longitude, accuracy, timestamp, mocked } = location;

  // 1. Coordinate finiteness and sanity
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return { ok: false, code: 'INVALID_COORDINATES', message: 'Latitude and longitude must be valid finite numbers' };
  }

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { ok: false, code: 'COORDINATES_OUT_OF_BOUNDS', message: 'Coordinates are out of physical Earth range' };
  }

  // 2. Mock location check
  if (mocked === true) {
    return { ok: false, code: 'MOCK_LOCATION_DETECTED', message: 'Simulated or mock location provider detected' };
  }

  // 3. Location freshness
  const locationTime = Number(timestamp);
  if (!Number.isFinite(locationTime)) {
    return { ok: false, code: 'INVALID_TIMESTAMP', message: 'Invalid location timestamp' };
  }

  const serverTimeMs = serverNow.getTime();
  const maxAgeMs = (policy.max_location_age_seconds || 30) * 1000;
  const clockSkewAllowanceMs = 5000; // max 5 seconds into future

  if (locationTime > serverTimeMs + clockSkewAllowanceMs) {
    return { ok: false, code: 'LOCATION_IN_FUTURE', message: 'Location timestamp is in the future' };
  }

  const ageMs = serverTimeMs - locationTime;
  if (ageMs > maxAgeMs) {
    return {
      ok: false,
      code: 'LOCATION_TOO_OLD',
      message: `Location reading is ${Math.round(ageMs / 1000)}s old (max allowed: ${policy.max_location_age_seconds}s)`,
    };
  }

  // 4. Accuracy validation
  const maxAccuracy = Number(policy.max_accuracy_meters) || 50.0;
  if (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy <= 0) {
    return { ok: false, code: 'INVALID_ACCURACY', message: 'Reported GPS accuracy is invalid' };
  }

  if (accuracy > maxAccuracy) {
    return {
      ok: false,
      code: 'POOR_GPS_ACCURACY',
      message: `GPS accuracy (±${Math.round(accuracy)}m) exceeds required threshold (±${Math.round(maxAccuracy)}m)`,
    };
  }

  // 5. Geofence evaluation with boundary uncertainty check
  const campusLat = Number(policy.center_latitude);
  const campusLon = Number(policy.center_longitude);
  const radius = Number(policy.radius_meters) || 100.0;

  const distanceMeters = calculateDistanceMeters(latitude, longitude, campusLat, campusLon);

  // If center is completely outside the campus radius
  if (distanceMeters > radius) {
    return {
      ok: false,
      code: 'OUTSIDE_CAMPUS',
      message: `You are ${Math.round(distanceMeters - radius)}m outside the ${policy.campus_name || 'campus'} boundary`,
      distanceMeters,
      radius,
    };
  }

  // If point is inside, but uncertainty circle overlaps the boundary
  // As specified: "If location uncertainty overlaps a boundary, request a better reading or use the exception path rather than silently widening it."
  if (distanceMeters + accuracy > radius) {
    return {
      ok: false,
      code: 'LOCATION_UNCERTAIN_AT_BOUNDARY',
      message: `GPS accuracy radius overlaps campus boundary. Please step into an open area for a clearer GPS signal.`,
      distanceMeters,
      accuracy,
      radius,
    };
  }

  return {
    ok: true,
    distanceMeters,
    accuracy,
    radius,
    campusName: policy.campus_name,
  };
}

/**
 * Returns current school-local date YYYY-MM-DD for a given timezone.
 */
export function getSchoolLocalDate(timezone = 'Asia/Kolkata', now = new Date()) {
  const zoned = toZonedTime(now, timezone);
  const y = zoned.getFullYear();
  const m = String(zoned.getMonth() + 1).padStart(2, '0');
  const d = String(zoned.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function timeToMinutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Validate a partial administrator policy update before it reaches PostgreSQL. */
export function validateCampusPolicyUpdate(input) {
  const errors = [];
  const numberInRange = (field, min, max) => {
    if (input[field] === undefined || input[field] === null) return;
    const value = Number(input[field]);
    if (!Number.isFinite(value) || value < min || value > max) {
      errors.push(`${field} must be between ${min} and ${max}`);
    }
  };

  if (input.campus_name !== undefined) {
    const name = String(input.campus_name).trim();
    if (!name || name.length > 120) errors.push('campus_name must contain 1 to 120 characters');
  }
  if (input.enforcement_mode !== undefined &&
      !['disabled', 'pilot', 'optional', 'enforced'].includes(input.enforcement_mode)) {
    errors.push('enforcement_mode is invalid');
  }
  numberInRange('center_latitude', -90, 90);
  numberInRange('center_longitude', -180, 180);
  numberInRange('radius_meters', 10, 5000);
  numberInRange('max_location_age_seconds', 5, 300);
  numberInRange('max_accuracy_meters', 1, 200);
  numberInRange('grace_period_minutes', 0, 180);
  numberInRange('challenge_expiry_seconds', 15, 120);
  for (const field of ['max_location_age_seconds', 'challenge_expiry_seconds', 'grace_period_minutes']) {
    if (input[field] != null && !Number.isInteger(Number(input[field]))) errors.push(`${field} must be an integer`);
  }
  if (input.school_timezone != null) {
    try { new Intl.DateTimeFormat('en', { timeZone: input.school_timezone }).format(); }
    catch { errors.push('school_timezone must be a valid IANA timezone'); }
  }

  for (const field of [
    'check_in_start_time',
    'check_in_end_time',
    'check_out_start_time',
    'check_out_end_time',
  ]) {
    if (input[field] !== undefined && timeToMinutes(input[field]) === null) {
      errors.push(`${field} must use HH:mm or HH:mm:ss format`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Enforce rollout and school-local check-in/check-out windows. */
export function evaluateAttendanceWindow(action, policy, now = new Date()) {
  const mode = policy?.enforcement_mode || 'disabled';
  if (mode === 'disabled') {
    return { ok: false, code: 'ATTENDANCE_V2_DISABLED', message: 'Mobile staff attendance is not enabled for this school.' };
  }

  const zoned = toZonedTime(now, policy?.school_timezone || 'Asia/Kolkata');
  const currentMinutes = zoned.getHours() * 60 + zoned.getMinutes();
  const start = timeToMinutes(action === 'check_in' ? policy?.check_in_start_time : policy?.check_out_start_time);
  const end = timeToMinutes(action === 'check_in' ? policy?.check_in_end_time : policy?.check_out_end_time);
  if (start == null || end == null) {
    return { ok: false, code: 'INVALID_ATTENDANCE_WINDOW', message: 'The school attendance window is not configured correctly.' };
  }

  const grace = Math.max(0, Number(policy?.grace_period_minutes) || 0);
  const rawEffectiveEnd = end + grace;
  const effectiveEnd = rawEffectiveEnd % (24 * 60);
  const crossesMidnight = start > end || rawEffectiveEnd >= 24 * 60;
  const inWindow = crossesMidnight
    ? currentMinutes >= start || currentMinutes <= effectiveEnd
    : currentMinutes >= start && currentMinutes <= effectiveEnd;
  if (!inWindow) {
    return {
      ok: false,
      code: 'OUTSIDE_ATTENDANCE_WINDOW',
      message: `${action === 'check_in' ? 'Check-in' : 'Check-out'} is outside the configured attendance window.`,
    };
  }
  return { ok: true };
}
