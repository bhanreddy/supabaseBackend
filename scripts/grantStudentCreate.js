import 'dotenv/config';
import sql from '../db.js';

async function grantStudentCreate() {

  try {
    const [accountsRole] = await sql`SELECT id FROM roles WHERE code = 'accounts'`;
    if (!accountsRole) {process.exit(1);}

    const [perm] = await sql`SELECT id FROM permissions WHERE code = 'students.create'`;
    if (!perm) {process.exit(1);}

    await sql`
            INSERT INTO role_permissions (role_id, permission_id)
            VALUES (${accountsRole.id}, ${perm.id})
            ON CONFLICT (role_id, permission_id) DO NOTHING
        `;

  } catch (e) {

    process.exit(1);
  }
  process.exit(0);
}
grantStudentCreate();