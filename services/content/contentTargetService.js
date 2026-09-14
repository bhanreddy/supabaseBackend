import { normalizeTargetId } from './contentUtils.js';
import sql from '../../db.js';
import logger from '../../utils/logger.js';

/**
 * Replace audience targets for a given content item.
 */
export async function setContentTargets({ schoolId, contentId, targets = [] }) {
  return sql.begin(async (tx) => {
    await tx`
      DELETE FROM public.content_targets
      WHERE content_id = ${contentId} AND school_id = ${schoolId}
    `;

    // Default to school-wide if empty
    const normalizedTargets = targets.length > 0
      ? targets
      : [{ target_type: 'SCHOOL', target_id: 'all' }];

    for (const t of normalizedTargets) {
      await tx`
        INSERT INTO public.content_targets (
          content_id,
          school_id,
          target_type,
          target_id
        ) VALUES (
          ${contentId},
          ${schoolId},
          ${t.target_type || 'SCHOOL'},
          ${normalizeTargetId(t.target_type, t.target_id)}
        )
        ON CONFLICT (content_id, target_type, target_id) DO NOTHING
      `;
    }

    return normalizedTargets;
  });
}

/**
 * Get all audience targets for a content item.
 */
export async function getContentTargets({ schoolId, contentId }) {
  return sql`
    SELECT id, target_type, target_id
    FROM public.content_targets
    WHERE content_id = ${contentId} AND school_id = ${schoolId}
  `;
}

/**
 * Check whether a specific user can view content items targeted to them.
 * Evaluates school, roles, enrolled class/section, or explicit user targeting.
 */
export async function resolveUserTargetFilterSql(user) {
  const userId = user.internal_id || user.id;
  const roles = user.roles || [];
  const personId = user.person_id;

  // Find enrolled class_id and class_section_id if student
  let classId = null;
  let sectionId = null;

  if (personId) {
    const enrollments = await sql`
      SELECT se.class_section_id, cs.class_id
      FROM public.students s
      JOIN public.student_enrollments se ON se.student_id = s.id AND se.status = 'active'
      JOIN public.class_sections cs ON cs.id = se.class_section_id
      WHERE s.person_id = ${personId} AND s.school_id = ${user.schoolId}
      LIMIT 1
    `;
    if (enrollments.length > 0) {
      sectionId = enrollments[0].class_section_id;
      classId = enrollments[0].class_id;
    } else {
      // Check if parent of a student
      const parentEnrollments = await sql`
        SELECT se.class_section_id, cs.class_id
        FROM public.parents p
        JOIN public.student_parents sp ON sp.parent_id = p.id
        JOIN public.students s ON s.id = sp.student_id
        JOIN public.student_enrollments se ON se.student_id = s.id AND se.status = 'active'
        JOIN public.class_sections cs ON cs.id = se.class_section_id
        WHERE p.person_id = ${personId} AND p.school_id = ${user.schoolId}
        LIMIT 1
      `;
      if (parentEnrollments.length > 0) {
        sectionId = parentEnrollments[0].class_section_id;
        classId = parentEnrollments[0].class_id;
      }
    }
  }

  return { userId, roles, classId, sectionId };
}

/**
 * Resolve recipient user IDs eligible to receive push notifications for a content item.
 */
export async function resolveEligibleRecipientsForContent({ schoolId, contentId }) {
  const targets = await sql`
    SELECT target_type, target_id
    FROM public.content_targets
    WHERE content_id = ${contentId} AND school_id = ${schoolId}
  `;

  if (!targets.length) {
    // School-wide by default
    const allUsers = await sql`
      SELECT id FROM public.users
      WHERE school_id = ${schoolId} AND account_status = 'active' AND deleted_at IS NULL
    `;
    return allUsers.map((u) => u.id);
  }

  const hasSchoolWide = targets.some((t) => t.target_type === 'SCHOOL' && t.target_id === 'all');
  if (hasSchoolWide) {
    const allUsers = await sql`
      SELECT id FROM public.users
      WHERE school_id = ${schoolId} AND account_status = 'active' AND deleted_at IS NULL
    `;
    return allUsers.map((u) => u.id);
  }

  const userIds = new Set();

  for (const t of targets) {
    if (t.target_type === 'USER') {
      userIds.add(t.target_id);
    } else if (t.target_type === 'ROLE') {
      const roleUsers = await sql`
        SELECT u.id
        FROM public.users u
        JOIN public.user_roles ur ON ur.user_id = u.id
        JOIN public.roles r ON r.id = ur.role_id
        WHERE u.school_id = ${schoolId}
          AND r.code = ${t.target_id}
          AND u.account_status = 'active'
          AND u.deleted_at IS NULL
      `;
      roleUsers.forEach((u) => userIds.add(u.id));
    } else if (t.target_type === 'CLASS') {
      const classUsers = await sql`
        SELECT DISTINCT u.id
        FROM public.users u
        JOIN public.students s ON u.person_id = s.person_id
        JOIN public.student_enrollments se ON s.id = se.student_id
        JOIN public.class_sections cs ON se.class_section_id = cs.id
        WHERE cs.class_id = ${t.target_id}
          AND cs.school_id = ${schoolId}
          AND u.school_id = ${schoolId}
          AND se.status = 'active'
          AND u.account_status = 'active'

        UNION

        SELECT DISTINCT u.id
        FROM public.users u
        JOIN public.parents p ON u.person_id = p.person_id
        JOIN public.student_parents sp ON p.id = sp.parent_id
        JOIN public.students s ON sp.student_id = s.id
        JOIN public.student_enrollments se ON s.id = se.student_id
        JOIN public.class_sections cs ON se.class_section_id = cs.id
        WHERE cs.class_id = ${t.target_id}
          AND cs.school_id = ${schoolId}
          AND u.school_id = ${schoolId}
          AND se.status = 'active'
          AND u.account_status = 'active'
      `;
      classUsers.forEach((u) => userIds.add(u.id));
    } else if (t.target_type === 'SECTION') {
      const sectionUsers = await sql`
        SELECT DISTINCT u.id
        FROM public.users u
        JOIN public.students s ON u.person_id = s.person_id
        JOIN public.student_enrollments se ON s.id = se.student_id
        WHERE se.class_section_id = ${t.target_id}
          AND se.school_id = ${schoolId}
          AND u.school_id = ${schoolId}
          AND se.status = 'active'
          AND u.account_status = 'active'

        UNION

        SELECT DISTINCT u.id
        FROM public.users u
        JOIN public.parents p ON u.person_id = p.person_id
        JOIN public.student_parents sp ON p.id = sp.parent_id
        JOIN public.students s ON sp.student_id = s.id
        JOIN public.student_enrollments se ON s.id = se.student_id
        WHERE se.class_section_id = ${t.target_id}
          AND se.school_id = ${schoolId}
          AND u.school_id = ${schoolId}
          AND se.status = 'active'
          AND u.account_status = 'active'
      `;
      sectionUsers.forEach((u) => userIds.add(u.id));
    }
  }

  return Array.from(userIds);
}
