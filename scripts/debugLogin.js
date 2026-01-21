
import 'dotenv/config';
import sql, { supabase } from '../db.js';

const ADMIN_EMAIL = 'admin@school.com';
const ADMIN_PASSWORD = 'Admin@123';

async function debugLogin() {
    console.log('🔍 Debugging Login Flow...');

    // 1. Supabase Auth Login
    console.log('\n1. Testing Supabase Auth Login...');
    const { data, error } = await supabase.auth.signInWithPassword({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD
    });

    if (error) {
        console.error('❌ Supabase Auth Failed:', error.message);
        process.exit(1);
    }
    console.log('✅ Supabase Auth Successful');
    console.log('   User ID:', data.user.id);
    const userId = data.user.id;

    // 2. Test "authRoutes.js" Login Query
    console.log('\n2. Testing POST /login internal query...');
    try {
        const userInfo = await sql`
            SELECT 
            u.id, u.account_status,
            p.first_name, p.last_name, p.display_name, p.photo_url,
            array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL) as roles,
            array_agg(DISTINCT perm.code) FILTER (WHERE perm.code IS NOT NULL) as permissions
            FROM users u
            JOIN persons p ON u.person_id = p.id
            LEFT JOIN user_roles ur ON u.id = ur.user_id
            LEFT JOIN roles r ON ur.role_id = r.id
            LEFT JOIN role_permissions rp ON r.id = rp.role_id
            LEFT JOIN permissions perm ON rp.permission_id = perm.id
            WHERE u.id = ${userId}
            GROUP BY u.id, p.first_name, p.last_name, p.display_name, p.photo_url
        `;

        if (userInfo.length === 0) {
            console.error('❌ Login Query returned 0 results! User not found in local DB.');
        } else {
            console.log('✅ Login Query returned user.');
            console.log('   Account Status:', userInfo[0].account_status);
            console.log('   Roles:', userInfo[0].roles);
            if (userInfo[0].account_status !== 'active') {
                console.error('❌ Account is NOT active.');
            }
        }
    } catch (err) {
        console.error('❌ Login Query Error:', err);
    }

    // 3. Test "middleware/auth.js" identifyUser Query
    console.log('\n3. Testing Middleware identifyUser query...');
    try {
        const middlewareInfo = await sql`
            SELECT 
                u.id, 
                u.account_status,
                array_agg(DISTINCT r.code) as roles,
                array_agg(DISTINCT p.code) as permissions
            FROM users u
            LEFT JOIN user_roles ur ON u.id = ur.user_id
            LEFT JOIN roles r ON ur.role_id = r.id
            LEFT JOIN role_permissions rp ON r.id = rp.role_id
            LEFT JOIN permissions p ON rp.permission_id = p.id
            WHERE u.id = ${userId}
            GROUP BY u.id
        `;

        if (middlewareInfo.length === 0) {
            console.error('❌ Middleware Query returned 0 results!');
        } else {
            console.log('✅ Middleware Query returned user.');
            console.log('   Roles:', middlewareInfo[0].roles);
            console.log('   Account Status:', middlewareInfo[0].account_status);
        }

    } catch (err) {
        console.error('❌ Middleware Query Error:', err);
    }

    // 4. Check explicit Tables
    console.log('\n4. Checking tables individually...');
    const personCheck = await sql`SELECT * FROM users WHERE id = ${userId}`;
    console.log(`   Users table count for ID: ${personCheck.length}`);

    const roleCheck = await sql`
        SELECT r.code FROM user_roles ur 
        JOIN roles r ON ur.role_id = r.id 
        WHERE ur.user_id = ${userId}
    `;
    console.log('   Roles found in DB:', roleCheck.map(r => r.code));

    process.exit(0);
}

debugLogin();
