/**
 * Grant Staff Create Permission to Accounts Role
 * Fixes Access Denied error when Accounts users try to add staff
 */

import 'dotenv/config';
import sql from '../db.js';

async function grantPermission() {
    console.log('🔧 Granting staff.create permission to accounts role...\n');

    try {
        // 1. Get accounts role
        const [accountsRole] = await sql`SELECT id FROM roles WHERE code = 'accounts'`;

        if (!accountsRole) {
            console.log('❌ Accounts role not found!');
            process.exit(1);
        }

        // 2. Get staff.create permission
        const [perm] = await sql`SELECT id FROM permissions WHERE code = 'staff.create'`;

        if (!perm) {
            console.log('❌ staff.create permission not found!');
            process.exit(1);
        }

        // 3. Assign permission
        await sql`
            INSERT INTO role_permissions (role_id, permission_id)
            VALUES (${accountsRole.id}, ${perm.id})
            ON CONFLICT (role_id, permission_id) DO NOTHING
        `;

        console.log('✅ Successfully granted staff.create to accounts role');

        // Verify
        const [check] = await sql`
            SELECT 1 FROM role_permissions 
            WHERE role_id = ${accountsRole.id} AND permission_id = ${perm.id}
        `;

        if (check) {
            console.log('✅ Verification successful');
        } else {
            console.log('❌ Verification failed');
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }

    process.exit(0);
}

grantPermission();
