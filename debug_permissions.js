import sql from './db.js';

async function check() {
    try {
        console.log('Checking Admin Permissions...');

        // 1. Get Admin User
        const [admin] = await sql`
            SELECT u.id, p.display_name 
            FROM users u
            JOIN persons p ON u.person_id = p.id
            JOIN person_contacts pc ON p.id = pc.person_id
            WHERE pc.contact_value = 'admin@school.com'
        `;

        if (!admin) {
            console.log('Admin user not found!');
            return;
        }
        console.log(`Admin ID: ${admin.id}, Name: ${admin.display_name}`);

        // 2. Get Roles
        const roles = await sql`
            SELECT r.code 
            FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = ${admin.id}
        `;
        console.log('Roles:', roles.map(r => r.code));

        // 3. Get Effective Permissions
        const permissions = await sql`
            SELECT DISTINCT perm.code
            FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            JOIN role_permissions rp ON r.id = rp.role_id
            JOIN permissions perm ON rp.permission_id = perm.id
            WHERE ur.user_id = ${admin.id}
        `;

        console.log('Permissions:', permissions.map(p => p.code).sort());

        const hasView = permissions.some(p => p.code === 'students.view');
        console.log(`Has 'students.view': ${hasView}`);

    } catch (e) {
        console.error(e);
    } process.exit();
}

check();
