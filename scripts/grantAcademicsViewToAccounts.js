import 'dotenv/config';
import sql from '../db.js';

async function grantPermissions() {

  try {
    const [accountsRole] = await sql`SELECT id FROM roles WHERE code = 'accounts'`;
    if (!accountsRole) {

      process.exit(1);
    }

    const permissionsToGrant = ['academics.view', 'students.view', 'students.create', 'students.edit'];

    for (const permCode of permissionsToGrant) {
      const [perm] = await sql`SELECT id FROM permissions WHERE code = ${permCode}`;
      if (!perm) {

        continue;
      }

      await sql`
                INSERT INTO role_permissions (school_id, role_id, permission_id)
                VALUES (1, ${accountsRole.id}, ${perm.id})
                ON CONFLICT (role_id, permission_id) DO NOTHING
            `;

    }

  } catch (e) {
    console.error('Error in grantPermissions:', e);
    process.exit(1);
  }

  console.log('Successfully granted permissions');
  process.exit(0);
}

grantPermissions();