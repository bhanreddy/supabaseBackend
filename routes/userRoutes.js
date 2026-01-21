import express from 'express';
import sql, { supabaseAdmin } from '../db.js';
import { identifyUser, requirePermission } from '../middleware/auth.js';

const router = express.Router();

// Middleware to ensure user is logged in
router.use(identifyUser);

/**
 * POST /users
 * Create a new user (admin only)
 * 1. Creates Person in DB
 * 2. Creates Auth User in Supabase
 * 3. Creates User in DB linked to Person and Supabase ID
 * 4. Assigns Role
 */
router.post('/', async (req, res) => {
    // Check permission - either must be admin role or have users.create permission
    if (!req.user || (!req.user.roles.includes('admin') && !req.user.permissions.includes('users.create'))) {
        return res.status(403).json({ error: 'Forbidden: Insufficient permissions to create users' });
    }

    if (!supabaseAdmin) {
        return res.status(500).json({ error: 'Server misconfiguration: Admin client not initialized' });
    }

    const {
        email, password, role_code,
        first_name, middle_name, last_name, dob, gender_id
    } = req.body;

    if (!email || !password || !role_code || !first_name || !last_name) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const result = await sql.begin(async sql => {
            // 1. Create Person
            // Convert undefined to null for optional fields
            const [person] = await sql`
                INSERT INTO persons (first_name, middle_name, last_name, dob, gender_id)
                VALUES (${first_name}, ${middle_name || null}, ${last_name}, ${dob || null}, ${gender_id})
                RETURNING id
            `;

            // 2. Create Supabase Auth User
            const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
                email,
                password,
                email_confirm: true, // Auto-confirm email
                user_metadata: { person_id: person.id }
            });

            if (authError) {
                throw new Error(`Supabase Auth Error: ${authError.message}`);
            }

            const supabaseUserId = authData.user.id;

            // 3. Create Local User
            // Note: We explicitly set the ID to match Supabase User ID
            const [user] = await sql`
                INSERT INTO users (id, person_id, account_status)
                VALUES (${supabaseUserId}, ${person.id}, 'active')
                RETURNING id
            `;

            // 4. Assign Role
            // Get role ID from code
            const [role] = await sql`SELECT id FROM roles WHERE code = ${role_code}`;
            if (!role) {
                throw new Error(`Invalid role code: ${role_code}`);
            }

            await sql`
                INSERT INTO user_roles (user_id, role_id, granted_by)
                VALUES (${user.id}, ${role.id}, ${req.user.internal_id})
            `;

            // 5. Add Contact (Email)
            await sql`
                INSERT INTO person_contacts (person_id, contact_type, contact_value, is_primary)
                VALUES (${person.id}, 'email', ${email}, true)
            `;

            return {
                user_id: user.id,
                person_id: person.id,
                email: email,
                role: role_code
            };
        });

        res.status(201).json({
            message: 'User created successfully',
            user: result
        });

    } catch (error) {
        console.error('Error creating user:', error);
        // Supabase user might have been created even if DB failed if transaction blocked? 
        // Ideally we should rollback supabase user too, but Supabase doesn't support 2PC with Postgres this way easily.
        // For now, we assume if DB transaction fails (rolled back via sql.begin), we might have an orphan in Supabase Auth.
        // Production grade would involve a "compensation" action here to delete the Auth user if DB fails.
        if (error.message.includes('Supabase Auth Error')) {
            return res.status(400).json({ error: error.message });
        }
        res.status(500).json({ error: 'Failed to create user', details: error.message });
    }
});

/**
 * GET /users
 * List all users with their roles
 */
router.get('/', async (req, res) => {
    if (!req.user || (!req.user.roles.includes('admin') && !req.user.permissions.includes('users.view'))) {
        return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }

    try {
        const users = await sql`
            SELECT 
                u.id, u.account_status, u.last_login_at, u.created_at,
                p.display_name, p.photo_url,
                (SELECT contact_value FROM person_contacts pc 
                 WHERE pc.person_id = p.id AND pc.contact_type = 'email' AND pc.is_primary = true LIMIT 1) as email,
                array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL) as roles
            FROM users u
            JOIN persons p ON u.person_id = p.id
            LEFT JOIN user_roles ur ON u.id = ur.user_id
            LEFT JOIN roles r ON ur.role_id = r.id
            GROUP BY u.id, p.display_name, p.photo_url, p.id
            ORDER BY p.display_name
        `;

        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

/**
 * PUT /users/:id
 * Update user (account status, etc.)
 */
router.put('/:id', async (req, res) => {
    if (!req.user || (!req.user.roles.includes('admin') && !req.user.permissions.includes('users.edit'))) {
        return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }

    const { id } = req.params;
    const { account_status } = req.body;

    try {
        const [updated] = await sql`
            UPDATE users
            SET account_status = COALESCE(${account_status}, account_status)
            WHERE id = ${id}
            RETURNING id, account_status
        `;

        if (!updated) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ message: 'User updated', user: updated });
    } catch (error) {
        console.error('Error updating user:', error);
        res.status(500).json({ error: 'Failed to update user' });
    }
});

/**
 * POST /users/:id/roles
 * Assign a role to a user
 */
router.post('/:id/roles', async (req, res) => {
    if (!req.user || !req.user.roles.includes('admin')) {
        return res.status(403).json({ error: 'Forbidden: Only admins can assign roles' });
    }

    const { id } = req.params;
    const { role_code } = req.body;

    if (!role_code) {
        return res.status(400).json({ error: 'role_code is required' });
    }

    try {
        const [role] = await sql`SELECT id FROM roles WHERE code = ${role_code}`;
        if (!role) {
            return res.status(404).json({ error: 'Role not found' });
        }

        await sql`
            INSERT INTO user_roles (user_id, role_id, granted_by)
            VALUES (${id}, ${role.id}, ${req.user.internal_id})
            ON CONFLICT (user_id, role_id) DO NOTHING
        `;

        res.json({ message: 'Role assigned successfully' });
    } catch (error) {
        console.error('Error assigning role:', error);
        res.status(500).json({ error: 'Failed to assign role' });
    }
});

/**
 * DELETE /users/:id/roles/:roleId
 * Remove a role from a user
 */
router.delete('/:id/roles/:roleId', async (req, res) => {
    if (!req.user || !req.user.roles.includes('admin')) {
        return res.status(403).json({ error: 'Forbidden: Only admins can remove roles' });
    }

    const { id, roleId } = req.params;

    try {
        const [deleted] = await sql`
            DELETE FROM user_roles 
            WHERE user_id = ${id} AND role_id = ${roleId}
            RETURNING user_id
        `;

        if (!deleted) {
            return res.status(404).json({ error: 'Role assignment not found' });
        }

        res.json({ message: 'Role removed successfully' });
    } catch (error) {
        console.error('Error removing role:', error);
        res.status(500).json({ error: 'Failed to remove role' });
    }
});

export default router;
