/**
 * Check Admin User Script
 * Checks if admin user exists in both Supabase Auth and local database
 * and fixes any inconsistencies
 */

import 'dotenv/config';
import sql, { supabaseAdmin } from '../db.js';

const ADMIN_EMAIL = 'admin@school.com';

async function checkAndFixAdmin() {
    console.log('🔍 Checking admin user status...\n');

    try {
        // 1. Check Supabase Auth
        console.log('1️⃣ Checking Supabase Auth...');
        const { data: authUsers, error: listError } = await supabaseAdmin.auth.admin.listUsers();

        if (listError) {
            console.error('❌ Error listing auth users:', listError.message);
            return;
        }

        const authUser = authUsers.users.find(u => u.email === ADMIN_EMAIL);

        if (!authUser) {
            console.log('❌ Admin user NOT found in Supabase Auth');
            console.log('   Run seedAdmin.js to create the admin user');
            return;
        }

        console.log(`✅ Admin found in Supabase Auth (ID: ${authUser.id})`);

        // 2. Check local database
        console.log('\n2️⃣ Checking local database...');
        const [localUser] = await sql`
            SELECT u.id, p.display_name
            FROM users u
            JOIN persons p ON u.person_id = p.id
            WHERE u.id = ${authUser.id}
        `;

        if (!localUser) {
            console.log('❌ Admin user NOT found in local database');
            console.log('   This is the cause of "account not found" error');
            console.log('\n🔧 Attempting to fix...');

            // Get gender ID
            const [gender] = await sql`SELECT id FROM genders WHERE name = 'Male'`;

            // Create person and user in transaction
            await sql.begin(async sql => {
                // Create Person
                const [person] = await sql`
                    INSERT INTO persons (first_name, last_name, gender_id)
                    VALUES ('Admin', 'User', ${gender.id})
                    RETURNING id
                `;
                console.log('   ✓ Person created');

                // Create User (with Supabase ID)
                await sql`
                    INSERT INTO users (id, person_id, account_status)
                    VALUES (${authUser.id}, ${person.id}, 'active')
                `;
                console.log('   ✓ User created');

                // Get Admin Role
                const [adminRole] = await sql`SELECT id FROM roles WHERE code = 'admin'`;

                // Assign Admin Role
                await sql`
                    INSERT INTO user_roles (user_id, role_id)
                    VALUES (${authUser.id}, ${adminRole.id})
                `;
                console.log('   ✓ Admin role assigned');

                // Add email contact
                await sql`
                    INSERT INTO person_contacts (person_id, contact_type, contact_value, is_primary)
                    VALUES (${person.id}, 'email', ${ADMIN_EMAIL}, true)
                `;
                console.log('   ✓ Contact added');
            });

            console.log('\n✅ Admin user fixed! You can now login.');

        } else {
            console.log(`✅ Admin found in local database (${localUser.display_name})`);

            // 3. Check role assignment
            console.log('\n3️⃣ Checking role assignment...');
            const [roleCheck] = await sql`
                SELECT r.code
                FROM user_roles ur
                JOIN roles r ON ur.role_id = r.id
                WHERE ur.user_id = ${authUser.id} AND r.code = 'admin'
            `;

            if (!roleCheck) {
                console.log('❌ Admin role NOT assigned');
                console.log('🔧 Fixing...');

                const [adminRole] = await sql`SELECT id FROM roles WHERE code = 'admin'`;
                await sql`
                    INSERT INTO user_roles (user_id, role_id)
                    VALUES (${authUser.id}, ${adminRole.id})
                    ON CONFLICT DO NOTHING
                `;
                console.log('✅ Admin role assigned');
            } else {
                console.log('✅ Admin role properly assigned');
            }
        }

        console.log('\n═══════════════════════════════════════════');
        console.log('✅ ADMIN USER IS READY');
        console.log('═══════════════════════════════════════════');
        console.log(`   Email:    ${ADMIN_EMAIL}`);
        console.log(`   Password: Admin@123`);
        console.log('═══════════════════════════════════════════');

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }

    process.exit(0);
}

checkAndFixAdmin();
