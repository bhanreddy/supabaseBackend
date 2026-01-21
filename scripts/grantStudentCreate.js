import 'dotenv/config';
import sql from '../db.js';

async function grantStudentCreate() {
    console.log('🔧 Granting students.create permission to accounts role...\n');

    try {
        const [accountsRole] = await sql`SELECT id FROM roles WHERE code = 'accounts'`;
        if (!accountsRole) { console.log('❌ Accounts role not found'); process.exit(1); }

        const [perm] = await sql`SELECT id FROM permissions WHERE code = 'students.create'`;
        if (!perm) { console.log('❌ students.create permission not found'); process.exit(1); }

        await sql`
            INSERT INTO role_permissions (role_id, permission_id)
            VALUES (${accountsRole.id}, ${perm.id})
            ON CONFLICT (role_id, permission_id) DO NOTHING
        `;
        console.log('✅ Granted students.create to accounts');
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
    process.exit(0);
}
grantStudentCreate();
