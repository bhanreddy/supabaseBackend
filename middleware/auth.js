import { supabase } from '../db.js';
import sql from '../db.js';

// Middleware to identify the user from the Supabase JWT
export const identifyUser = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            req.user = null;
            return next();
        }

        const token = authHeader.split(' ')[1];
        if (!token) {
            req.user = null;
            return next();
        }

        // 1. Verify Token with Supabase
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            // Token invalid or expired
            req.user = null;
            return next();
        }

        // 2. Fetch Internal User & Permissions
        // We fetch the user's role codes and permission codes
        const userInfo = await sql`
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
        WHERE u.id = ${user.id}
        GROUP BY u.id
    `;

        if (userInfo.length === 0) {
            // User exists in Auth but not in our public.users table? 
            // Sync issue or new user not yet created. Treat as guest for now.
            req.user = null;
            return next();
        }

        const dbUser = userInfo[0];

        if (dbUser.account_status !== 'active') {
            // User is locked or disabled
            req.user = null;
            return res.status(403).json({ error: 'Account is not active' });
        }

        // Attach to req
        req.user = {
            ...user,
            roles: dbUser.roles || [],
            permissions: dbUser.permissions || [],
            internal_id: dbUser.id
        };

        next();

    } catch (err) {
        console.error('Auth Middleware Error:', err);
        req.user = null;
        next();
    }
};

// Middleware to require specific permission
export const requirePermission = (permissionCode) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Unauthorized: No user logged in' });
        }

        // Super admin bypass (optional, e.g. if role is 'admin')
        if (req.user.roles.includes('admin')) {
            return next();
        }

        if (!req.user.permissions.includes(permissionCode)) {
            return res.status(403).json({ error: `Forbidden: Missing permission ${permissionCode}` });
        }

        next();
    };
};

// Middleware to just require authentication (valid user)
export const requireAuth = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};
