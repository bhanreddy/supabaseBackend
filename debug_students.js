import sql from './db.js';
async function run() {
    try {
        const students = await sql`
            SELECT s.id, p.display_name, u.id as user_id 
            FROM students s 
            JOIN persons p ON s.person_id = p.id 
            LEFT JOIN users u ON p.id = u.person_id
        `;
        console.log('Students:', students);

        const roles = await sql`SELECT * FROM roles`;
        console.log('Roles:', roles);

        const studentRoles = await sql`
            SELECT u.id as user_id, r.code 
            FROM users u 
            JOIN user_roles ur ON u.id = ur.user_id 
            JOIN roles r ON ur.role_id = r.id
            WHERE r.code = 'student' or r.code = 'staff' or r.code = 'teacher'
        `;
        console.log('User Roles:', studentRoles);

    } catch (e) {
        console.error(e);
    } finally {
        process.exit();
    }
}
run();
