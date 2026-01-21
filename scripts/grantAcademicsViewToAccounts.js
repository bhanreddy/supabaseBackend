import 'dotenv/config';
import sql from '../db.js';

async function grantPermissions() {
    console.log('🔧 Granting necessary permissions to accounts role...\n');

    try {
        const [accountsRole] = await sql`SELECT id FROM roles WHERE code = 'accounts'`;
        if (!accountsRole) {
            console.log('❌ Accounts role not found');
            process.exit(1);
        }

        const permissionsToGrant = ['academics.view', 'students.create', 'students.edit'];

        for (const permCode of permissionsToGrant) {
            const [perm] = await sql`SELECT id FROM permissions WHERE code = ${permCode}`;
            if (!perm) {
                console.log(`⚠️ Permission ${permCode} not found in database, skipping...`);
                continue;
            }

            await sql`
                INSERT INTO role_permissions (role_id, permission_id)
                VALUES (${accountsRole.id}, ${perm.id})
                ON CONFLICT (role_id, permission_id) DO NOTHING
            `;
            console.log(`✅ Granted ${permCode} to accounts`);
        }

    } catch (e) {
        console.error('❌ Error granting permissions:', e);
        process.exit(1);
    }
    console.log('\n✨ Permissions update complete.');
    process.exit(0);
}

grantPermissions();
