/**
 * Compare academic year codes like "2024-25" and "2026-27".
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareAcademicYearCodes(a, b) {
  const startA = parseAcademicYearStart(a);
  const startB = parseAcademicYearStart(b);
  return startA - startB;
}

/** True when dueYear is strictly before the active year. */
export function isPreviousAcademicYear(dueYear, activeYear) {
  return compareAcademicYearCodes(dueYear, activeYear) < 0;
}

export function parseAcademicYearStart(code) {
  if (!code || typeof code !== 'string') return 0;
  const part = code.split('-')[0];
  const n = parseInt(part, 10);
  return Number.isFinite(n) ? n : 0;
}
