export const DEFAULT_CONTENT_TIMEZONE = 'Asia/Kolkata';

export function sanitizeRichText(value) {
  if (value == null) return value;
  return String(value)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/on\w+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/javascript:/gi, '');
}

export function isSafeHttpUrl(url) {
  if (!url) return true;
  try {
    const parsed = new URL(String(url).trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function schoolLocalDate(timezone = DEFAULT_CONTENT_TIMEZONE, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
}

/** ISO weekday: 1 = Monday … 7 = Sunday */
export function schoolIsoWeekday(timezone = DEFAULT_CONTENT_TIMEZONE, date = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(date);
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[weekday] || 1;
}

export function normalizeTargetId(targetType, targetId) {
  const raw = String(targetId ?? 'all').trim();
  if (!targetType || targetType === 'SCHOOL' || targetType === 'ROLE') {
    return raw.toLowerCase();
  }
  return raw;
}
