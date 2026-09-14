import sql from '../db.js';

export const CONTENT_TEST_SCHOOL_ID = 1;

async function firstUserByRole(schoolId, roleCodes) {
  const [row] = await sql`
    SELECT u.id
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id
    JOIN public.roles r ON r.id = ur.role_id AND r.school_id = u.school_id
    WHERE u.school_id = ${schoolId}
      AND r.code = ANY(${roleCodes}::varchar[])
      AND COALESCE(u.account_status, 'active') = 'active'
    ORDER BY u.id ASC
    LIMIT 1
  `;
  return row || null;
}

export async function loadSchool1ContentActors() {
  const schoolId = CONTENT_TEST_SCHOOL_ID;
  const adminRow = await firstUserByRole(schoolId, ['admin', 'principal']);
  const staffRow = await firstUserByRole(schoolId, ['staff', 'teacher']);
  const studentRow = await firstUserByRole(schoolId, ['student']);

  if (!adminRow) {
    throw new Error('School 1 must have an admin or principal user for content tests.');
  }

  const adminUser = {
    id: adminRow.id,
    internal_id: adminRow.id,
    schoolId,
    roles: ['admin'],
    permissions: [
      'content.view',
      'content.create',
      'content.submit',
      'content.approve',
      'content.publish',
      'content.manage',
    ],
  };

  const staffUser = {
    id: (staffRow || adminRow).id,
    internal_id: (staffRow || adminRow).id,
    schoolId,
    roles: staffRow ? ['teacher', 'staff'] : ['admin'],
    permissions: ['content.view', 'content.create', 'content.submit'],
  };

  const studentUser = {
    id: (studentRow || adminRow).id,
    internal_id: (studentRow || adminRow).id,
    schoolId,
    roles: studentRow ? ['student'] : ['admin'],
    permissions: ['content.view'],
  };

  return {
    schoolId,
    adminUser,
    staffUser,
    studentUser,
    hasDistinctStudent: Boolean(studentRow && studentRow.id !== adminRow.id && (!staffRow || studentRow.id !== staffRow.id)),
    hasDistinctStaff: Boolean(staffRow && staffRow.id !== adminRow.id),
  };
}
