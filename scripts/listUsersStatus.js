
import 'dotenv/config';
import sql from '../db.js';

async function listUsersStatus() {
    try {
        const users = await sql`
            SELECT u.id, u.email, u.account_status, array_agg(r.code) as roles
            FROM users u
            LEFT JOIN user_roles ur ON u.id = ur.user_id
            LEFT JOIN roles r ON ur.role_id = r.id
            GROUP BY u.id, u.email, u.account_status
        `;
        console.log(users);
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

listUsersStatus();
