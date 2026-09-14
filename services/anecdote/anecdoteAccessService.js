import sql from '../../db.js';

export class AnecdoteAccessError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.status = status;
    this.name = 'AnecdoteAccessError';
  }
}

export function isPrivilegedStaff(roles = []) {
  return (roles || []).some((role) => ['admin', 'principal', 'coordinator'].includes(role));
}

export function isFamilyRole(roles = []) {
  return (roles || []).some((role) => ['parent', 'student', 'students'].includes(role));
}

export function isStaffRecorderRole(roles = []) {
  return isPrivilegedStaff(roles) || (roles || []).some((role) => ['staff', 'teacher'].includes(role));
}

export async function assertStudentInSchool({ schoolId, studentId }) {
  if (!schoolId || !studentId) {
    throw new AnecdoteAccessError('Student ID is required', 400);
  }

  const [row] = await sql`
    SELECT id
    FROM public.students
    WHERE school_id = ${schoolId}
      AND id = ${studentId}
      AND deleted_at IS NULL
    LIMIT 1
  `;

  if (!row) {
    throw new AnecdoteAccessError('Student not found in this school', 404);
  }

  return row;
}

export async function resolveStaffId({ schoolId, userId = null, personId = null }) {
  if (!schoolId || (!userId && !personId)) return null;

  if (personId) {
    const [byPerson] = await sql`
      SELECT s.id
      FROM public.staff s
      WHERE s.school_id = ${schoolId}
        AND s.deleted_at IS NULL
        AND s.person_id = ${personId}
      LIMIT 1
    `;
    if (byPerson) return byPerson.id;
  }

  if (!userId) return null;

  const [staff] = await sql`
    SELECT s.id
    FROM public.staff s
    JOIN public.users u ON u.person_id = s.person_id AND u.school_id = ${schoolId}
    WHERE s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
      AND u.id = ${userId}
    LIMIT 1
  `;

  return staff?.id || null;
}

export async function resolveLinkedStudentId({ schoolId, personId }) {
  if (!schoolId || !personId) return null;

  const [own] = await sql`
    SELECT id
    FROM public.students
    WHERE school_id = ${schoolId}
      AND person_id = ${personId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (own) return own.id;

  const [linked] = await sql`
    SELECT sp.student_id AS id
    FROM public.student_parents sp
    JOIN public.parents par ON par.id = sp.parent_id
    WHERE sp.school_id = ${schoolId}
      AND par.person_id = ${personId}
      AND par.deleted_at IS NULL
    ORDER BY sp.is_primary_contact DESC NULLS LAST
    LIMIT 1
  `;

  return linked?.id || null;
}

export async function teacherMayAccessStudent({ schoolId, studentId, staffId }) {
  if (!staffId) return false;

  const [row] = await sql`
    SELECT 1
    FROM public.student_enrollments se
    JOIN public.class_sections cs ON cs.id = se.class_section_id
    WHERE se.school_id = ${schoolId}
      AND se.student_id = ${studentId}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
      AND cs.deleted_at IS NULL
      AND (
        cs.class_teacher_id = ${staffId}
        OR EXISTS (
          SELECT 1
          FROM public.timetable_slots ts
          WHERE ts.class_section_id = cs.id
            AND ts.teacher_id = ${staffId}
            AND ts.school_id = ${schoolId}
            AND ts.deleted_at IS NULL
        )
      )
    LIMIT 1
  `;

  return Boolean(row);
}

export async function familyMayAccessStudent({ schoolId, studentId, personId }) {
  if (!personId) return false;

  const [own] = await sql`
    SELECT 1
    FROM public.students
    WHERE school_id = ${schoolId}
      AND id = ${studentId}
      AND person_id = ${personId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (own) return true;

  const [linked] = await sql`
    SELECT 1
    FROM public.student_parents sp
    JOIN public.parents par ON par.id = sp.parent_id
    WHERE sp.school_id = ${schoolId}
      AND sp.student_id = ${studentId}
      AND par.person_id = ${personId}
      AND par.deleted_at IS NULL
    LIMIT 1
  `;

  return Boolean(linked);
}

/**
 * Server-side authorization for a student-owned intelligence/anecdote record.
 * Tenant is always the JWT school. Never trust a client-supplied school_id.
 */
export async function assertStudentAccessible({ schoolId, studentId, user }) {
  await assertStudentInSchool({ schoolId, studentId });

  const roles = user?.roles || [];
  if (isPrivilegedStaff(roles)) return true;

  if (isFamilyRole(roles)) {
    const allowed = await familyMayAccessStudent({
      schoolId,
      studentId,
      personId: user?.person_id || null,
    });
    if (!allowed) {
      throw new AnecdoteAccessError('Not authorized to access this student', 403);
    }
    return true;
  }

  const staffId = await resolveStaffId({
    schoolId,
    userId: user?.internal_id || null,
    personId: user?.person_id || null,
  });
  const allowed = await teacherMayAccessStudent({ schoolId, studentId, staffId });
  if (!allowed) {
    throw new AnecdoteAccessError('Not authorized to access this student', 403);
  }
  return true;
}

export function teacherAuthorizedStudentSql({ schoolId, staffId }) {
  return sql`
    EXISTS (
      SELECT 1
      FROM public.student_enrollments se
      JOIN public.class_sections cs ON cs.id = se.class_section_id
      WHERE se.school_id = ${schoolId}
        AND se.student_id = a.student_id
        AND se.status = 'active'
        AND se.deleted_at IS NULL
        AND (
          cs.class_teacher_id = ${staffId}
          OR EXISTS (
            SELECT 1
            FROM public.timetable_slots ts
            WHERE ts.class_section_id = cs.id
              AND ts.teacher_id = ${staffId}
              AND ts.school_id = ${schoolId}
              AND ts.deleted_at IS NULL
          )
        )
    )
  `;
}
