import 'dotenv/config';
import sql from './db.js';

async function verify() {
    const res = await sql`
        SELECT p.code 
        FROM role_permissions rp 
        JOIN permissions p ON rp.permission_id = p.id 
        JOIN roles r ON rp.role_id = r.id 
        WHERE r.code = 'accounts'
    `;
    console.log('PERMISSIONS:', JSON.stringify(res.map(p => p.code)));
    process.exit(0);
}
verify();
