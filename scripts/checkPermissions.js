/**
 * Check User Permissions Script
 * Verifies that admin user has correct permissions
 */

import 'dotenv/config';
import sql from '../db.js';

const ADMIN_EMAIL = 'admin@school.com';

async function checkPermissions() {
    console.log('🔍 Checking admin permissions...\n');

    try {
        // Find admin user by email
        const [contact] = await sql`
            SELECT person_id FROM person_contacts 
            WHERE contact_value = ${ADMIN_EMAIL} AND contact_type = 'email'
        `;

        if (!contact) {
            console.log('❌ Admin email not found');
            return;
        }

        // Get user info with roles and permissions
        const [userInfo] = await sql`
            SELECT 
                u.id,
                u.account_status,
                p.display_name,
                array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL) as roles,
                array_agg(DISTINCT perm.code) FILTER (WHERE perm.code IS NOT NULL) as permissions
            FROM users u
            JOIN persons p ON u.person_id = p.id
            LEFT JOIN user_roles ur ON u.id = ur.user_id
            LEFT JOIN roles r ON ur.role_id = r.id
            LEFT JOIN role_permissions rp ON r.id = rp.role_id
            LEFT JOIN permissions perm ON rp.permission_id = perm.id
            WHERE p.id = ${contact.person_id}
            GROUP BY u.id, p.display_name
        `;

        if (!userInfo) {
            console.log('❌ User not found in database');
            return;
        }

        console.log('✅ User Found:');
        console.log(`   Name: ${userInfo.display_name}`);
        console.log(`   ID: ${userInfo.id}`);
        console.log(`   Status: ${userInfo.account_status}`);
        console.log(`\n📋 Roles: ${userInfo.roles?.join(', ') || 'None'}`);
        console.log(`\n🔑 Permissions (${userInfo.permissions?.length || 0} total):`);

        if (userInfo.permissions && userInfo.permissions.length > 0) {
            userInfo.permissions.forEach(perm => {
                console.log(`   - ${perm}`);
            });
        } else {
            console.log('   ❌ NO PERMISSIONS ASSIGNED!');
        }

        // Check for users.create and staff.create permission
        const hasUserCreate = userInfo.permissions?.includes('users.create');
        const hasStaffCreate = userInfo.permissions?.includes('staff.create');
        const isAdmin = userInfo.roles?.includes('admin');

        console.log('\n🎯 Access Check:');
        console.log(`   Is Admin Role: ${isAdmin ? '✅' : '❌'}`);
        console.log(`   Has users.create: ${hasUserCreate ? '✅' : '❌'}`);
        console.log(`   Has staff.create: ${hasStaffCreate ? '✅' : '❌'}`);

        if (isAdmin || (hasUserCreate && hasStaffCreate)) {
            console.log('\n✅ User CAN create staff & users');
        } else {
            console.log('\n❌ User CANNOT create staff - Missing permissions!');
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
    }

    process.exit(0);
}

checkPermissions();
