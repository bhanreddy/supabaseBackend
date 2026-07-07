
import 'dotenv/config';
import sql from '../db.js';

async function grantStaffViewPermissions() {

  try {
    const [staffRole] = await sql`SELECT id FROM roles WHERE code = 'staff'`;
    if (!staffRole) {process.exit(1);}

    // Permissions needed for dashboard
    const permsToGrant = ['students.view', 'attendance.view', 'fees.view', 'notices.view', 'timetable.view', 'diary.view'];

    for (const code of permsToGrant) {
      const [perm] = await sql`SELECT id FROM permissions WHERE code = ${code}`;
      if (perm) {
        await sql`
                    INSERT INTO role_permissions (role_id, permission_id)
                    VALUES (${staffRole.id}, ${perm.id})
                    ON CONFLICT (role_id, permission_id) DO NOTHING
                `;

      } else {

      }
    }
  } catch (e) {

    process.exit(1);
  }
  process.exit(0);
}

grantStaffViewPermissions();