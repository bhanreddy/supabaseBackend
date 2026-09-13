/**
 * Privacy & Audience Visibility Policy Engine for Celebrations.
 * Enforces server-side multi-tenancy and role-based visibility.
 */

const ADMIN_ROLES = new Set(['admin', 'management', 'principal', 'superadmin']);
const STAFF_ROLES = new Set(['staff', 'teacher', 'principal']);

/**
 * Normalizes user roles into lowercase string array.
 * @param {object} user
 * @returns {string[]}
 */
function getUserRoles(user) {
  if (!user) return [];
  if (Array.isArray(user.roles)) {
    return user.roles.map((r) => String(r).toLowerCase());
  }
  if (typeof user.role === 'string') {
    return [user.role.toLowerCase()];
  }
  return [];
}

/**
 * Checks if user has admin/management privileges.
 * @param {string[]} roles
 * @returns {boolean}
 */
function isAdminOrManagement(roles) {
  return roles.some((role) => ADMIN_ROLES.has(role));
}

/**
 * Checks if user has staff/teacher privileges.
 * @param {string[]} roles
 * @returns {boolean}
 */
function isStaff(roles) {
  return roles.some((role) => STAFF_ROLES.has(role));
}

/**
 * Determines whether a user context can view a specific celebration.
 *
 * @param {object} user - Requester context (from auth token / session)
 * @param {object} celebration - Celebration event record
 * @param {object} [settings] - School celebration settings
 * @returns {boolean}
 */
export function canViewCelebration(user, celebration, settings = {}) {
  if (!user || !celebration) return false;

  // 1. Strict Tenant Boundary
  const userSchoolId = user.schoolId ?? user.school_id;
  if (!userSchoolId || String(userSchoolId) !== String(celebration.schoolId)) {
    return false;
  }

  // 2. Master Feature Gate
  if (settings.is_enabled === false) {
    return false;
  }

  const roles = getUserRoles(user);
  const userPersonId = user.person_id ? String(user.person_id) : null;
  const userStaffId = user.staff_id || user.staffId ? String(user.staff_id || user.staffId) : null;
  const userStudentId = user.student_id || user.studentId ? String(user.student_id || user.studentId) : null;
  const userStudentIds = Array.isArray(user.studentIds)
    ? user.studentIds.map(String)
    : (userStudentId ? [userStudentId] : []);

  // 3. Category Feature Gates
  if (celebration.targetType === 'STUDENT' && settings.student_birthday_enabled === false) {
    return false;
  }
  if (celebration.targetType === 'STAFF' && settings.staff_birthday_enabled === false) {
    return false;
  }

  // Admins / Management can view all school celebrations that are enabled for their category
  if (isAdminOrManagement(roles)) {
    return true;
  }

  // 4. STUDENT BIRTHDAY RULES
  if (celebration.targetType === 'STUDENT') {
    const studentId = String(celebration.targetId);
    const isSelfStudent = userStudentId === studentId || userPersonId === String(celebration.personId);
    const isParentOfStudent = userStudentIds.includes(studentId);

    // The student and their linked parents always see their own celebration
    if (isSelfStudent || isParentOfStudent) {
      return true;
    }

    const visibility = settings.student_visibility || 'class';

    // If visibility is self_only, only the student and parents can see
    if (visibility === 'self_only') {
      return false;
    }

    // If visibility is class-level
    if (visibility === 'class') {
      // Class teacher can see
      if (userStaffId && celebration.classTeacherId && String(celebration.classTeacherId) === userStaffId) {
        return true;
      }

      // Other staff can see students
      if (isStaff(roles)) {
        return true;
      }

      // Parents / Students in the SAME class/section can see
      const userClassSectionIds = new Set(
        [user.class_section_id, user.classSectionId, ...(user.classSectionIds || [])]
          .filter(Boolean)
          .map(String),
      );
      const userSectionIds = new Set(
        [user.section_id, user.sectionId, ...(user.sectionIds || [])]
          .filter(Boolean)
          .map(String),
      );
      const userClassIds = new Set(
        [user.class_id, user.classId, ...(user.classIds || [])]
          .filter(Boolean)
          .map(String),
      );

      if (celebration.classSectionId && userClassSectionIds.has(String(celebration.classSectionId))) {
        return true;
      }
      if (celebration.sectionId && userSectionIds.has(String(celebration.sectionId))) {
        return true;
      }
      if (celebration.classId && userClassIds.has(String(celebration.classId))) {
        return true;
      }

      // Otherwise hidden from parents of different classes
      return false;
    }

    // If visibility is school-wide
    if (visibility === 'school') {
      return true;
    }

    return false;
  }

  // 4. STAFF BIRTHDAY RULES
  if (celebration.targetType === 'STAFF') {
    if (settings.staff_birthday_enabled === false) {
      return false;
    }

    const staffId = String(celebration.targetId);
    const isSelfStaff = userStaffId === staffId || userPersonId === String(celebration.personId);

    // Staff member always sees their own celebration
    if (isSelfStaff) {
      return true;
    }

    // Fellow staff members can view staff birthdays
    if (isStaff(roles)) {
      return true;
    }

    const visibility = settings.staff_visibility || 'staff';

    // Parents / Students can only view staff birthdays if staff_visibility is 'school'
    if (visibility === 'school') {
      return true;
    }

    return false;
  }

  return false;
}

/**
 * Filters a list of celebrations for the given user.
 *
 * @param {object[]} celebrations
 * @param {object} user
 * @param {object} settings
 * @returns {object[]}
 */
export function filterCelebrationsForUser(celebrations, user, settings = {}) {
  if (!Array.isArray(celebrations) || celebrations.length === 0) {
    return [];
  }
  return celebrations.filter((item) => canViewCelebration(user, item, settings));
}
