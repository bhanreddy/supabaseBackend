
import 'dotenv/config';
import sql from '../db.js';

async function checkStaffPermissions() {
    console.log('🔍 Checking Staff permissions...\n');
    try {
        const permissions = await sql`
            SELECT p.code 
            FROM role_permissions rp 
            JOIN permissions p ON rp.permission_id = p.id 
            JOIN roles r ON rp.role_id = r.id 
            WHERE r.code = 'staff'
        `;

        console.log('Staff Role Permissions:', permissions.map(p => p.code));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

checkStaffPermissions();
