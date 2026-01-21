
import 'dotenv/config';
import sql from '../db.js';

async function checkAccountsPermissions() {
    console.log('🔍 Checking Accounts permissions...\n');
    try {
        const permissions = await sql`
            SELECT p.code 
            FROM role_permissions rp 
            JOIN permissions p ON rp.permission_id = p.id 
            JOIN roles r ON rp.role_id = r.id 
            WHERE r.code = 'accounts'
        `;

        console.log('Accounts Role Permissions:', permissions.map(p => p.code));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

checkAccountsPermissions();
