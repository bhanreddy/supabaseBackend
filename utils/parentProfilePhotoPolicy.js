/**
 * School-level permission for parent-portal profile pictures.
 *
 * Family logins are stored as `student` (the parent-facing account), `students`,
 * or `parent`. Those accounts share PATCH/DELETE /users/me/photo with every other
 * portal, so the route must refuse them when this setting is off. Staff, admin,
 * driver, and accounts uploads stay allowed.
 *
 * Missing or unrecognised values fail closed: parents cannot change a photo
 * until an administrator explicitly stores "true".
 */
export const PARENT_PROFILE_PHOTO_SETTING_KEY = 'allow_parent_profile_photo_upload';

const FAMILY_PORTAL_ROLES = new Set(['student', 'students', 'parent']);

export function isParentPortalAccount(roles) {
  const normalized = (Array.isArray(roles) ? roles : [])
    .map((role) => String(role || '').trim().toLowerCase())
    .filter(Boolean);
  return normalized.length > 0 && normalized.every((role) => FAMILY_PORTAL_ROLES.has(role));
}

export function isParentProfilePhotoUploadEnabled(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

export function normalizeParentProfilePhotoSetting(value) {
  if (value === true || String(value).trim().toLowerCase() === 'true') return 'true';
  if (value === false || String(value).trim().toLowerCase() === 'false') return 'false';
  return null;
}

export function parentProfilePhotoChangeDecision({ roles, settingValue }) {
  if (!isParentPortalAccount(roles)) {
    return { allowed: true };
  }
  if (isParentProfilePhotoUploadEnabled(settingValue)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    status: 403,
    error: 'Profile picture uploads are disabled for parent accounts.',
  };
}
