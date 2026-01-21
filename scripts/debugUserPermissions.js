
import 'dotenv/config';
import sql from '../db.js';

// User ID from listRolesSimple output
const TARGET_USER_ID = '16decc11-c2b8-477d-9477-1b6bbc9b2b8e';

async function debugUserPermissions() {
    console.log(`🕵️ Debugging permissions for User ID: ${TARGET_USER_ID}\n`);
    try {
        const userInfo = await sql`
            SELECT 
                u.id, 
                u.account_status,
                array_agg(DISTINCT r.code) as roles,
                array_agg(DISTINCT p.code) as permissions
            FROM users u
            LEFT JOIN user_roles ur ON u.id = ur.user_id
            LEFT JOIN roles r ON ur.role_id = r.id
            LEFT JOIN role_permissions rp ON r.id = rp.role_id
            LEFT JOIN permissions p ON rp.permission_id = p.id
            WHERE u.id = ${TARGET_USER_ID}
            GROUP BY u.id
        `;

        if (userInfo.length === 0) {
            console.log('❌ User not found!');
        } else {
            const user = userInfo[0];
            console.log('✅ User Found:');
            console.log('   Account Status:', user.account_status);
            console.log('   Roles:', user.roles);
            console.log('   Student Create Perm:', user.permissions.includes('students.create') ? 'YES' : 'NO');
            console.log('   Staff Create Perm:', user.permissions.includes('staff.create') ? 'YES' : 'NO');
            console.log('   All Permissions:', user.permissions);
        }

    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

debugUserPermissions();
