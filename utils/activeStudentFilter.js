import sql from '../db.js';

/**
 * Seeded `student_statuses.id` for code = 'active'.
 * Prefer this constant over magic numbers at call sites.
 */
export const ACTIVE_STUDENT_STATUS_ID = 1;

/**
 * SQL fragment: student row is operationally active (not withdrawn / graduated / etc).
 * Common aliases used across roster queries.
 *
 * @param {'s' | 'student' | 'stu'} [alias='s']
 */
export function activeStudentSql(alias = 's') {
  switch (alias) {
    case 'student':
      return sql`student.status_id = ${ACTIVE_STUDENT_STATUS_ID} AND student.deleted_at IS NULL`;
    case 'stu':
      return sql`stu.status_id = ${ACTIVE_STUDENT_STATUS_ID} AND stu.deleted_at IS NULL`;
    case 's':
    default:
      return sql`s.status_id = ${ACTIVE_STUDENT_STATUS_ID} AND s.deleted_at IS NULL`;
  }
}

/**
 * Resolve list lifecycle for operational student APIs.
 * Default is active so staff/admin roster pages never surface withdrawn students
 * unless they explicitly ask for archive (`archived`) or history (`all`).
 *
 * @param {string | undefined} lifecycle
 * @param {string | number | undefined} statusId
 * @returns {'active' | 'archived' | 'all' | 'status'}
 */
export function resolveStudentListLifecycle(lifecycle, statusId) {
  if (statusId !== undefined && statusId !== null && String(statusId).trim() !== '') {
    return 'status';
  }
  const normalized = String(lifecycle || 'active').trim().toLowerCase();
  if (normalized === 'archived' || normalized === 'all' || normalized === 'active') {
    return normalized;
  }
  return 'active';
}
