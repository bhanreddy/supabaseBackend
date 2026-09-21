/**
 * Fail closed before a tenant-scoped query is constructed. Keep this helper
 * deliberately small so it is safe to use in financial and reporting paths.
 */
export function assertTenantScope(schoolId) {
  const numericSchoolId = Number(schoolId);
  if (!Number.isInteger(numericSchoolId) || numericSchoolId <= 0) {
    const error = new Error('A valid schoolId is required for tenant-scoped database access');
    error.code = 'TENANT_SCOPE_REQUIRED';
    error.status = 400;
    throw error;
  }
  return numericSchoolId;
}
