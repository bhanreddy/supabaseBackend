const JUNK_OPTIONAL_STRINGS = new Set(['', 'null', 'none', 'undefined']);

/**
 * Normalize optional string fields (e.g. last_name, middle_name).
 * Returns SQL NULL for empty/whitespace-only and common junk literals;
 * otherwise returns the trimmed original (preserving real casing).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeOptionalString(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (JUNK_OPTIONAL_STRINGS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/**
 * Normalize optional name fields on a row/object before insert/update.
 * @param {Record<string, unknown>} row
 * @param {string[]} fields
 * @returns {Record<string, unknown>}
 */
export function normalizeOptionalNameFields(row, fields = ['middle_name', 'last_name']) {
  const out = { ...row };
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(out, field)) {
      out[field] = normalizeOptionalString(out[field]);
    }
  }
  return out;
}
