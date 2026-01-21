/**
 * Force Recreate Admin User
 * Deletes and recreates admin user with all permissions
 */

import 'dotenv/config';
import sql, { supabaseAdmin } from '../db.js';

const ADMIN_EMAIL = 'admin@school.com';
const ADMIN_PASSWORD = 'Admin@123';

async function forceRecreateAdmin() {
    console.log('🔄 Force recreating admin user...\n');

    if (!supabaseAdmin) {
        console.error('❌ SUPABASE_SERVICE_ROLE_KEY not set');
        process.exit(1);
    }

    try {
        // 1. Delete existing Supabase auth user if exists
        console.log('1️⃣ Checking Supabase Auth...');
        const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers();
        const existingAuthUser = authUsers.users.find(u => u.email === ADMIN_EMAIL);

        if (existingAuthUser) {
            console.log(`   Found existing auth user, deleting...`);
            await supabaseAdmin.auth.admin.deleteUser(existingAuthUser.id);
            console.log('   ✓ Deleted from Supabase Auth');
        }

        // 2. Delete from local database
        console.log('\n2️⃣ Cleaning local database...');
        await sql`
            DELETE FROM person_contacts 
            WHERE person_id IN (
                SELECT person_id FROM users u 
                JOIN user_roles ur ON u.id = ur.user_id 
                JOIN roles r ON ur.role_id = r.id 
                WHERE r.code = 'admin'
            )
        `;
        await sql`
            DELETE FROM user_roles 
            WHERE user_id IN (
                SELECT u.id FROM users u 
                JOIN user_roles ur ON u.id = ur.user_id 
                JOIN roles r ON ur.role_id = r.id 
                WHERE r.code = 'admin'
            )
        `;
        const deletedUsers = await sql`
            DELETE FROM users 
            WHERE id IN (
                SELECT u.id FROM users u 
                JOIN user_roles ur ON u.id = ur.user_id 
                JOIN roles r ON ur.role_id = r.id 
                WHERE r.code = 'admin'
            )
            RETURNING person_id
        `;
        if (deletedUsers.length > 0) {
            await sql`DELETE FROM persons WHERE id = ${deletedUsers[0].person_id}`;
        }
        console.log('   ✓ Cleaned local database');

        // 3. Get gender ID
        const [gender] = await sql`SELECT id FROM genders WHERE name = 'Male'`;
        if (!gender) {
            console.error('❌ Reference data not loaded');
            process.exit(1);
        }

        // 4. Create new admin user
        console.log('\n3️⃣ Creating new admin user...');
        const result = await sql.begin(async sql => {
            // Create Person
            const [person] = await sql`
                INSERT INTO persons (first_name, last_name, gender_id)
                VALUES ('Admin', 'User', ${gender.id})
                RETURNING id
            `;
            console.log('   ✓ Person created');

            // Create Supabase Auth User
            const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
                email: ADMIN_EMAIL,
                password: ADMIN_PASSWORD,
                email_confirm: true,
                user_metadata: { person_id: person.id }
            });

            if (authError) throw new Error(`Supabase Auth Error: ${authError.message}`);
            console.log('   ✓ Supabase Auth user created');

            const supabaseUserId = authData.user.id;

            // Create Local User
            const [user] = await sql`
                INSERT INTO users (id, person_id, account_status)
                VALUES (${supabaseUserId}, ${person.id}, 'active')
                RETURNING id
            `;
            console.log('   ✓ Local user created');

            // Get Admin Role
            const [adminRole] = await sql`SELECT id FROM roles WHERE code = 'admin'`;
            if (!adminRole) throw new Error('Admin role not found');

            // Assign Admin Role
            await sql`
                INSERT INTO user_roles (user_id, role_id)
                VALUES (${user.id}, ${adminRole.id})
            `;
            console.log('   ✓ Admin role assigned');

            // Add email contact
            await sql`
                INSERT INTO person_contacts (person_id, contact_type, contact_value, is_primary)
                VALUES (${person.id}, 'email', ${ADMIN_EMAIL}, true)
            `;
            console.log('   ✓ Contact added');

            return { user_id: user.id };
        });

        // 5. Ensure admin has ALL permissions
        console.log('\n4️⃣ Assigning all permissions...');
        const [adminRole] = await sql`SELECT id FROM roles WHERE code = 'admin'`;
        const allPermissions = await sql`SELECT id FROM permissions`;

        for (const perm of allPermissions) {
            await sql`
                INSERT INTO role_permissions (role_id, permission_id)
                VALUES (${adminRole.id}, ${perm.id})
                ON CONFLICT (role_id, permission_id) DO NOTHING
            `;
        }
        console.log(`   ✓ Assigned ${allPermissions.length} permissions`);

        console.log('\n═══════════════════════════════════════════');
        console.log('✅ ADMIN USER CREATED SUCCESSFULLY');
        console.log('═══════════════════════════════════════════');
        console.log(`   Email:    ${ADMIN_EMAIL}`);
        console.log(`   Password: ${ADMIN_PASSWORD}`);
        console.log('═══════════════════════════════════════════');
        console.log('\n⚠️  Please logout and login again with these credentials');

        process.exit(0);

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

forceRecreateAdmin();
