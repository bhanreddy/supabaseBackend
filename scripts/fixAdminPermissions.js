/**
 * Fix Admin Permissions Script
 * Ensures admin user has all necessary permissions
 */

import 'dotenv/config';
import sql from '../db.js';

async function fixAdminPermissions() {
    console.log('🔧 Fixing admin permissions...\n');

    try {
        // 1. Find all admin users
        const adminUsers = await sql`
            SELECT u.id, p.display_name
            FROM users u
            JOIN persons p ON u.person_id = p.id
            JOIN user_roles ur ON u.id = ur.user_id
            JOIN roles r ON ur.role_id = r.id
            WHERE r.code = 'admin'
        `;

        if (adminUsers.length === 0) {
            console.log('❌ No admin users found!');
            console.log('   Run: node scripts/seedAdmin.js');
            process.exit(1);
        }

        console.log(`✅ Found ${adminUsers.length} admin user(s):`);
        adminUsers.forEach(u => console.log(`   - ${u.display_name} (${u.id})`));

        // 2. Get admin role
        const [adminRole] = await sql`SELECT id FROM roles WHERE code = 'admin'`;

        if (!adminRole) {
            console.log('❌ Admin role not found in database!');
            process.exit(1);
        }

        // 3. Get ALL permissions
        const allPermissions = await sql`SELECT id, code FROM permissions ORDER BY code`;

        console.log(`\n📋 Total permissions in system: ${allPermissions.length}`);

        // 4. Assign ALL permissions to admin role
        console.log('\n🔄 Assigning all permissions to admin role...');

        let assigned = 0;
        for (const perm of allPermissions) {
            await sql`
                INSERT INTO role_permissions (role_id, permission_id)
                VALUES (${adminRole.id}, ${perm.id})
                ON CONFLICT (role_id, permission_id) DO NOTHING
            `;
            assigned++;
        }

        console.log(`✅ Assigned ${assigned} permissions to admin role`);

        // 5. Verify
        const [verification] = await sql`
            SELECT COUNT(*) as count
            FROM role_permissions rp
            JOIN roles r ON rp.role_id = r.id
            WHERE r.code = 'admin'
        `;

        console.log(`\n✅ Admin role now has ${verification.count} permissions`);

        console.log('\n═══════════════════════════════════════════');
        console.log('✅ ADMIN PERMISSIONS FIXED');
        console.log('═══════════════════════════════════════════');
        console.log('Admin users can now:');
        console.log('  ✓ Create accounts staff');
        console.log('  ✓ Manage all users');
        console.log('  ✓ Access all features');
        console.log('═══════════════════════════════════════════');

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }

    process.exit(0);
}

fixAdminPermissions();
