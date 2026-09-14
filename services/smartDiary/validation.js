const ALLOWED_SOURCES = new Set(['MANUAL', 'PHOTO', 'VOICE', 'TEMPLATE', 'REUSED', 'COPIED', 'CLASS_DIARY_AI']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function sanitizeDueDate(dueDate, entryDate) {
  if (!dueDate) return null;
  const due = String(dueDate).slice(0, 10);
  const entry = String(entryDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  if (due < entry) return null;
  return due;
}

export function sanitizeSource(value) {
  const source = String(value || 'MANUAL').toUpperCase();
  return ALLOWED_SOURCES.has(source) ? source : 'MANUAL';
}
