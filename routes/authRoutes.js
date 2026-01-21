import express from 'express';
import { supabase } from '../db.js';
import sql from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * POST /auth/login
 * Login with email and password via Supabase Auth
 */
router.post('/login', asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
    });

    if (error) {
        return res.status(401).json({ error: 'Invalid credentials', details: error.message });
    }

    // Fetch user roles and permissions
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
    WHERE u.id = ${data.user.id}
    GROUP BY u.id, p.first_name, p.last_name, p.display_name, p.photo_url
  `;

    if (userInfo.length === 0) {
        return res.status(404).json({ error: 'User account not found in system' });
    }

    const dbUser = userInfo[0];

    if (dbUser.account_status !== 'active') {
        return res.status(403).json({ error: 'Account is not active' });
    }

    // Update last login
    await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${data.user.id}`;

    res.json({
        message: 'Login successful',
        token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
        user: {
            id: dbUser.id,
            email: data.user.email,
            display_name: dbUser.display_name,
            first_name: dbUser.first_name,
            last_name: dbUser.last_name,
            photo_url: dbUser.photo_url,
            roles: dbUser.roles || [],
            permissions: dbUser.permissions || []
        }
    });
}));

/**
 * POST /auth/logout
 * Logout current session
 */
router.post('/logout', asyncHandler(async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(400).json({ error: 'No session to logout' });
    }

    const { error } = await supabase.auth.signOut();

    if (error) {
        return res.status(500).json({ error: 'Logout failed', details: error.message });
    }

    res.json({ message: 'Logged out successfully' });
}));

/**
 * POST /auth/refresh
 * Refresh JWT token
 */
router.post('/refresh', asyncHandler(async (req, res) => {
    const { refresh_token } = req.body;

    if (!refresh_token) {
        return res.status(400).json({ error: 'Refresh token is required' });
    }

    const { data, error } = await supabase.auth.refreshSession({ refresh_token });

    if (error) {
        return res.status(401).json({ error: 'Token refresh failed', details: error.message });
    }

    res.json({
        token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at
    });
}));

/**
 * GET /auth/me
 * Get current authenticated user profile
 */
router.get('/me', asyncHandler(async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    // Fetch full profile
    const userInfo = await sql`
    SELECT 
      u.id, u.account_status, u.last_login_at, u.created_at,
      p.first_name, p.middle_name, p.last_name, p.display_name, p.dob, p.photo_url,
      g.name as gender,
      array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL) as roles,
      array_agg(DISTINCT perm.code) FILTER (WHERE perm.code IS NOT NULL) as permissions,
      -- Get contacts
      (SELECT json_agg(json_build_object('type', pc.contact_type, 'value', pc.contact_value, 'is_primary', pc.is_primary))
       FROM person_contacts pc WHERE pc.person_id = p.id AND pc.deleted_at IS NULL) as contacts
    FROM users u
    JOIN persons p ON u.person_id = p.id
    LEFT JOIN genders g ON p.gender_id = g.id
    LEFT JOIN user_roles ur ON u.id = ur.user_id
    LEFT JOIN roles r ON ur.role_id = r.id
    LEFT JOIN role_permissions rp ON r.id = rp.role_id
    LEFT JOIN permissions perm ON rp.permission_id = perm.id
    WHERE u.id = ${req.user.id}
    GROUP BY u.id, p.id, g.name
  `;

    if (userInfo.length === 0) {
        return res.status(404).json({ error: 'User not found' });
    }

    res.json(userInfo[0]);
}));

/**
 * POST /auth/forgot-password
 * Request password reset email
 */
router.post('/forgot-password', asyncHandler(async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: process.env.PASSWORD_RESET_REDIRECT_URL || 'http://localhost:3000/reset-password'
    });

    if (error) {
        // Don't reveal if email exists or not for security
        console.error('Password reset error:', error);
    }

    // Always return success to prevent email enumeration
    res.json({ message: 'If the email exists, a password reset link has been sent' });
}));

/**
 * POST /auth/reset-password
 * Reset password with token (called after user clicks email link)
 */
router.post('/reset-password', asyncHandler(async (req, res) => {
    const { new_password } = req.body;

    if (!new_password) {
        return res.status(400).json({ error: 'New password is required' });
    }

    if (new_password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const { error } = await supabase.auth.updateUser({ password: new_password });

    if (error) {
        return res.status(400).json({ error: 'Password reset failed', details: error.message });
    }

    res.json({ message: 'Password reset successfully' });
}));

export default router;
