/**
 * Grant Staff Create Permission to Accounts Role
 * Fixes Access Denied error when Accounts users try to add staff
 */

import 'dotenv/config';
import sql from '../db.js';

async function grantPermission() {

  try {
    // 1. Get accountant role
    const [accountsRole] = await sql`SELECT id FROM roles WHERE code = 'accountant'`;

    if (!accountsRole) {

      process.exit(1);
    }

    // 2. Get staff.create permission
    const [perm] = await sql`SELECT id FROM permissions WHERE code = 'staff.create'`;

    if (!perm) {

      process.exit(1);
    }

    // 3. Assign permission
    await sql`
            INSERT INTO role_permissions (role_id, permission_id)
            VALUES (${accountsRole.id}, ${perm.id})
            ON CONFLICT (role_id, permission_id) DO NOTHING
        `;

    // Verify
    const [check] = await sql`
            SELECT 1 FROM role_permissions 
            WHERE role_id = ${accountsRole.id} AND permission_id = ${perm.id}
        `;

    if (check) {

    } else {

    }

  } catch (error) {

    process.exit(1);
  }

  process.exit(0);
}

grantPermission();