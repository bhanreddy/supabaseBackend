/**
 * Resolve student_id for parent/student portal routes.
 * Prefers server-validated active context; falls back to legacy person_id join.
 */

import sql from '../db.js';

export function getPortalRoleCodes(req) {
  if (req.activeContext?.role_codes?.length) {
    return req.activeContext.role_codes;
  }
  return req.user?.roles || [];
}

export function isStudentPortalRequest(req) {
  const codes = getPortalRoleCodes(req);
  return codes.includes('student') || codes.includes('parent');
}

export function requireStudentPortal(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!isStudentPortalRequest(req)) {
    return res.status(403).json({ error: 'Student portal access required' });
  }
  next();
}

function isStaffViewer(req) {
  const codes = getPortalRoleCodes(req);
  return (
    req.user?.permissions?.includes('students.view')
    || codes.includes('admin')
    || codes.includes('principal')
    || codes.includes('staff')
    || codes.includes('accounts')
  );
}

/**
 * Returns student UUID for the current request, or null if not found.
 */
export async function resolveStudentId(req) {
  if (req.activeContext?.student_id) {
    return req.activeContext.student_id;
  }

  const userId = req.user?.internal_id || req.user?.id;
  const schoolId = req.activeContext?.school_id || req.user?.schoolId || req.schoolId;
  if (!userId || !schoolId) return null;

  const [row] = await sql`
    SELECT s.id
    FROM students s
    JOIN users u ON s.person_id = u.person_id AND s.school_id = u.school_id
    WHERE u.id = ${userId}
      AND u.school_id = ${schoolId}
      AND s.deleted_at IS NULL
      AND u.deleted_at IS NULL
    LIMIT 1
  `;
  if (row?.id) return row.id;

  const [guardian] = await sql`
    SELECT sp.student_id AS id
    FROM users u
    JOIN parents par ON par.person_id = u.person_id AND par.school_id = u.school_id
    JOIN student_parents sp ON sp.parent_id = par.id AND sp.deleted_at IS NULL
    WHERE u.id = ${userId}
      AND u.school_id = ${schoolId}
      AND par.deleted_at IS NULL
    ORDER BY sp.is_primary_contact DESC, sp.created_at ASC
    LIMIT 1
  `;
  return guardian?.id ?? null;
}

/**
 * Map route param `me` / user id → student id; pass through explicit student UUIDs.
 */
export async function resolveStudentIdFromParam(req, id) {
  if (id === 'me' || id === req.user?.internal_id || id === req.user?.id) {
    return resolveStudentId(req);
  }
  return id;
}

/**
 * Guardian link check: user may access student_id via active context OR legacy person join OR parent link.
 */
export async function assertStudentAccess(req, studentId) {
  if (!studentId) return false;

  if (req.activeContext?.student_id === studentId) {
    return true;
  }

  const userId = req.user?.internal_id || req.user?.id;
  const schoolId = req.activeContext?.school_id || req.user?.schoolId || req.schoolId;
  if (!userId || !schoolId) return false;

  const [legacy] = await sql`
    SELECT 1
    FROM students s
    JOIN users u ON s.person_id = u.person_id AND s.school_id = u.school_id
    WHERE u.id = ${userId}
      AND s.id = ${studentId}
      AND s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
    LIMIT 1
  `;
  if (legacy) return true;

  const [guardian] = await sql`
    SELECT 1
    FROM users u
    JOIN parents par ON par.person_id = u.person_id AND par.school_id = u.school_id
    JOIN student_parents sp ON sp.parent_id = par.id AND sp.deleted_at IS NULL
    WHERE u.id = ${userId}
      AND u.school_id = ${schoolId}
      AND sp.student_id = ${studentId}
      AND par.deleted_at IS NULL
    LIMIT 1
  `;
  return !!guardian;
}

/**
 * Staff with students.view may access any student; portal users only linked children.
 */
export async function canAccessStudentData(req, targetStudentId) {
  if (!targetStudentId) return false;
  if (isStaffViewer(req)) return true;
  if (!isStudentPortalRequest(req)) return false;
  return assertStudentAccess(req, targetStudentId);
}

/**
 * Resolve param + enforce access. Returns null and sends response when denied.
 */
export async function resolveStudentParamWithAccess(req, res, id) {
  const targetStudentId = await resolveStudentIdFromParam(req, id);
  if (!targetStudentId) {
    res.status(404).json({ error: 'Student profile not found' });
    return null;
  }
  const allowed = await canAccessStudentData(req, targetStudentId);
  if (!allowed) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return targetStudentId;
}

/**
 * Active student's class_id for LMS scoping.
 */
export async function resolveStudentClassId(req) {
  const studentId = await resolveStudentId(req);
  if (!studentId) return null;

  const schoolId = req.activeContext?.school_id || req.user?.schoolId || req.schoolId;
  const [row] = await sql`
    SELECT cs.class_id
    FROM student_enrollments se
    JOIN class_sections cs ON se.class_section_id = cs.id
    WHERE se.student_id = ${studentId}
      AND se.school_id = ${schoolId}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
    ORDER BY se.created_at DESC
    LIMIT 1
  `;
  return row?.class_id ?? null;
}

/**
 * Resolve student id for non-admin fee/portal reads.
 */
export async function resolveStudentIdForSelfService(req) {
  const studentId = await resolveStudentId(req);
  return studentId;
}
