import sql from '../db.js';
import { toZonedTime } from 'date-fns-tz';

export const FEE_COLLECTION_RESTRICTED = 'FEE_COLLECTION_OUT_OF_HOURS';
export const FEE_COLLECTION_MESSAGE = 'Collect Fee is available only during school hours. Ask your administrator for after-hours collection access.';

// Cache only school configuration, never a user's override or temporary grant.
const hoursCache = new Map();
async function getSchoolHours(schoolId) {
  const cached = hoursCache.get(schoolId);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const rows = await sql`
    SELECT key, value FROM school_settings
    WHERE school_id = ${schoolId}
      AND key IN ('school_hours_start', 'school_hours_end', 'school_timezone')
  `;
  const settings = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
  const value = {
    start: settings.school_hours_start || '08:00',
    end: settings.school_hours_end || '17:00',
    timezone: settings.school_timezone || 'Asia/Kolkata',
  };
  if (hoursCache.size >= 100) hoursCache.delete(hoursCache.keys().next().value);
  hoursCache.set(schoolId, { at: Date.now(), value });
  return value;
}

/** Existing Accounts hours/approvals apply only to collecting school fees. */
export async function getFeeCollectionAccess(user, at = new Date()) {
  if (!user) return { allowed: false, code: 'UNAUTHORIZED', message: 'Unauthorized' };
  if (!user.roles?.some((role) => ['accounts', 'accountant'].includes(role))) return { allowed: true };

  const userId = user.internal_id || user.id;
  const [account] = await sql`
    SELECT unrestricted_access FROM users
    WHERE id = ${userId} AND school_id = ${user.schoolId}
      AND account_status = 'active' AND deleted_at IS NULL
  `;
  if (!account) return { allowed: false, code: 'ACCOUNT_NOT_ACTIVE', message: 'Account is not active' };
  if (account.unrestricted_access === true) return { allowed: true };

  const hours = await getSchoolHours(user.schoolId);
  const now = toZonedTime(at, hours.timezone);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = (time) => {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  };
  // Preserve the existing Mon–Fri window, inclusive start / exclusive end.
  if (now.getDay() >= 1 && now.getDay() <= 5
      && minutes >= toMinutes(hours.start) && minutes < toMinutes(hours.end)) {
    return { allowed: true };
  }

  const grants = await sql`
    SELECT id FROM temp_access_grants
    WHERE requested_by = ${userId} AND school_id = ${user.schoolId}
      AND department = 'accounts' AND is_active = true AND expires_at > NOW()
    LIMIT 1
  `;
  if (grants.length) return { allowed: true };
  return { allowed: false, code: FEE_COLLECTION_RESTRICTED, message: FEE_COLLECTION_MESSAGE };
}
