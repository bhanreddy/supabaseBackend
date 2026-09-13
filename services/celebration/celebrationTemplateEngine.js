/**
 * Whitelist of permissible celebration template replacement tokens.
 * Arbitrary expressions and dynamic execution (eval) are strictly prohibited.
 */
const ALLOWED_PLACEHOLDERS = new Set([
  'first_name',
  'full_name',
  'class',
  'section',
  'designation',
  'department',
  'school_name',
]);

/**
 * Escapes characters that could cause markup or format issues.
 * @param {string} str
 * @returns {string}
 */
function sanitizeValue(str) {
  if (str == null) return '';
  return String(str)
    .replace(/[<>]/g, '')
    .trim();
}

/**
 * Interpolates template strings with permitted placeholders.
 *
 * @param {string} template
 * @param {Record<string, string|number|null|undefined>} context
 * @returns {string}
 */
export function renderCelebrationTemplate(template, context = {}) {
  if (!template || typeof template !== 'string') {
    return '';
  }

  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawKey) => {
    const lowerKey = rawKey.trim().toLowerCase();
    if (!ALLOWED_PLACEHOLDERS.has(lowerKey)) {
      return ''; // Strip unknown/unauthorized tokens and arbitrary expressions
    }
    const val = context[lowerKey];
    return sanitizeValue(val);
  }).trim();
}
