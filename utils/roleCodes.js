/**
 * Maps portal-facing role codes to database role codes.
 * DB stores `accounts`; validate-school-user returns `accountant` to the app.
 */
export function resolveDbRoleCode(roleCode) {
  if (!roleCode) return null;
  const normalized = String(roleCode).trim().toLowerCase();
  const ALIASES = { accountant: 'accounts' };
  return ALIASES[normalized] || normalized;
}
