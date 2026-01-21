
import 'dotenv/config';
import sql from '../db.js';

async function grantStaffViewPermissions() {
    console.log('🔧 Granting View permissions to staff role...\n');

    try {
        const [staffRole] = await sql`SELECT id FROM roles WHERE code = 'staff'`;
        if (!staffRole) { console.log('❌ Staff role not found'); process.exit(1); }

        // Permissions needed for dashboard
        const permsToGrant = ['students.view', 'attendance.view', 'fees.view', 'notices.view', 'timetable.view', 'diary.view'];

        for (const code of permsToGrant) {
            const [perm] = await sql`SELECT id FROM permissions WHERE code = ${code}`;
            if (perm) {
                await sql`
                    INSERT INTO role_permissions (role_id, permission_id)
                    VALUES (${staffRole.id}, ${perm.id})
                    ON CONFLICT (role_id, permission_id) DO NOTHING
                `;
                console.log(`✅ Granted ${code}`);
            } else {
                console.log(`⚠️ Permission ${code} not found in DB`);
            }
        }
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
    process.exit(0);
}

grantStaffViewPermissions();
