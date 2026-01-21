import sql from './db.js';

async function check() {
    try {
        console.log('--- ROLES & PERMISSIONS ---');

        const rows = await sql`
            SELECT r.code as role, perm.code as permission
            FROM roles r
            JOIN role_permissions rp ON r.id = rp.role_id
            JOIN permissions perm ON rp.permission_id = perm.id
            ORDER BY r.code, perm.code
        `;

        rows.forEach(r => {
            console.log(`${r.role} : ${r.permission}`);
        });

    } catch (e) {
        console.error(e);
    } process.exit();
}

check();
