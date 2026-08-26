import 'dotenv/config';
import sql from '../db.js';

async function grantStaffAndTeacherLeavesViewPermission() {
  try {
    await sql`
      INSERT INTO permissions (school_id, code, name)
      SELECT s.id, 'leaves.view', 'View Leaves'
      FROM schools s
      WHERE NOT EXISTS (
        SELECT 1
        FROM permissions p
        WHERE p.school_id = s.id
          AND p.code = 'leaves.view'
      )
    `;

    const inserted = await sql`
      INSERT INTO role_permissions (school_id, role_id, permission_id)
      SELECT r.school_id, r.id, p.id
      FROM roles r
      JOIN permissions p ON p.school_id = r.school_id AND p.code = 'leaves.view'
      WHERE r.code IN ('staff', 'teacher')
        AND NOT EXISTS (
          SELECT 1 FROM role_permissions rp
          WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = r.school_id
        )
      RETURNING school_id, role_id
    `;

    const schools = [...new Set(inserted.map((row) => row.school_id))];
    console.log(`Granted leaves.view to staff/teacher roles in ${schools.length} school(s).`);
    if (schools.length > 0) {
      console.log(`Updated school_id(s): ${schools.join(', ')}`);
    } else {
      console.log('No changes needed — staff/teacher roles already have leaves.view everywhere.');
    }
  } catch (err) {
    console.error('Error granting leaves.view to staff/teacher roles:', err);
    process.exit(1);
  }

  process.exit(0);
}

grantStaffAndTeacherLeavesViewPermission();
