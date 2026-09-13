/**
 * Auth/identity endpoints must keep the real administrator. Rewriting req.user
 * there made session refresh persist the viewed staff member as the logged-in
 * account, so the admin could not return to the admin portal.
 */
export function isStaffPortalIdentityPath(url) {
  const path = String(url || '').split('?')[0];
  return /(?:^|\/)auth(?:\/|$)/.test(path);
}
