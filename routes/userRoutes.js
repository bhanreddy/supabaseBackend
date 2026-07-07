import express from 'express';
import sql, { supabaseAdmin } from '../db.js';
import { identifyUser, requirePermission, requireAuth } from '../middleware/auth.js';
import { singleAvatarUpload, handleAvatarMulterError } from '../middleware/avatarUpload.js';
import { normalizeAvatar } from '../utils/avatarImage.js';
import { uploadAvatar, removeAvatar } from '../utils/avatarStorage.js';
import { sendSuccess } from '../utils/apiResponse.js';
import {
  assertSchoolEmailAvailable,
  createSchoolScopedAuthUser,
  sendSchoolEmailConflict
} from '../utils/schoolEmail.js';
import { resolveDbRoleCode } from '../utils/roleCodes.js';

const router = express.Router();

// U1 FIX: Replace identifyUser with requireAuth to reject unauthenticated requests
router.use(requireAuth);

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
  if (!req.user || !req.user.roles.includes('admin') && !req.user.permissions.includes('users.create')) {
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
    const schoolId = req.user.schoolId;
    req.schoolId = String(schoolId);
    const canonicalEmail = await assertSchoolEmailAvailable(sql, schoolId, email);

    const result = await sql.begin(async (sql) => {
      // U2 FIX: Add school_id to persons INSERT
      const [person] = await sql`
                INSERT INTO persons (school_id, first_name, middle_name, last_name, dob, gender_id)
                VALUES (${schoolId}, ${first_name}, ${middle_name || null}, ${last_name}, ${dob || null}, ${gender_id})
                RETURNING id
            `;

      // 2. Create Supabase Auth User
      const { data: authData } = await createSchoolScopedAuthUser(supabaseAdmin, {
        schoolId,
        email: canonicalEmail,
        password,
        userMetadata: { person_id: person.id }
      });

      const supabaseUserId = authData.user.id;

      // U3 FIX: Add school_id to users INSERT
      const [user] = await sql`
                INSERT INTO users (id, school_id, person_id, account_status)
                VALUES (${supabaseUserId}, ${schoolId}, ${person.id}, 'active')
                RETURNING id
            `;

      // U4 FIX: Add school_id filter to role lookup
      const dbRoleCode = resolveDbRoleCode(role_code);
      const [role] = await sql`SELECT id FROM roles WHERE code = ${dbRoleCode} AND school_id = ${schoolId}`;
      if (!role) {
        throw new Error(`Invalid role code: ${dbRoleCode}`);
      }

      // U7 partial: Add school_id to user_roles INSERT
      await sql`
                INSERT INTO user_roles (user_id, role_id, school_id, granted_by)
                VALUES (${user.id}, ${role.id}, ${schoolId}, ${req.user.internal_id})
            `;

      // 5. Add Contact (Email)
      await sql`
                INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary)
                VALUES (${schoolId}, ${person.id}, 'email', ${canonicalEmail}, true)
            `;

      return {
        user_id: user.id,
        person_id: person.id,
        email: canonicalEmail,
        role: role_code
      };
    });

    return sendSuccess(res, req.schoolId, {
      message: 'User created successfully',
      user: result
    }, 201);

  } catch (error) {

    // Supabase user might have been created even if DB failed if transaction blocked?
    // Ideally we should rollback supabase user too, but Supabase doesn't support 2PC with Postgres this way easily.
    // For now, we assume if DB transaction fails (rolled back via sql.begin), we might have an orphan in Supabase Auth.
    // Production grade would involve a "compensation" action here to delete the Auth user if DB fails.
    if (sendSchoolEmailConflict(res, error)) return;
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
  if (!req.user || !req.user.roles.includes('admin') && !req.user.permissions.includes('users.view')) {
    return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
  }

  try {
    // U5 FIX: Add school_id filter to user list query
    const users = await sql`
            SELECT
                u.id, u.account_status, u.last_login_at, u.created_at,
                p.display_name, p.photo_url,
                (SELECT contact_value FROM person_contacts pc
                 WHERE pc.person_id = p.id AND pc.contact_type = 'email' AND pc.is_primary = true LIMIT 1) as email,
                array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL) as roles
            FROM users u
            JOIN persons p ON u.person_id = p.id
              AND p.school_id = ${req.schoolId}
            LEFT JOIN user_roles ur ON u.id = ur.user_id
              AND ur.school_id = ${req.schoolId}
            LEFT JOIN roles r ON ur.role_id = r.id
              AND r.school_id = ${req.schoolId}
            WHERE u.school_id = ${req.schoolId}
              AND u.deleted_at IS NULL
            GROUP BY u.id, p.display_name, p.photo_url, p.id
            ORDER BY p.display_name
        `;

    return sendSuccess(res, req.schoolId, users);
  } catch (error) {

    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * PUT /users/settings
 * Update personal settings for the authenticated user
 */
router.put('/settings', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { notification_sound } = req.body;

  if (notification_sound && !['custom', 'default'].includes(notification_sound)) {
    return res.status(400).json({ error: 'Invalid notification sound' });
  }

  try {
    const [upserted] = await sql`
            INSERT INTO user_settings (school_id, user_id, notification_sound)
    VALUES (${req.schoolId}, ${req.user.internal_id}, ${notification_sound || 'custom'})
            ON CONFLICT (user_id)
            DO UPDATE SET notification_sound = COALESCE(EXCLUDED.notification_sound, user_settings.notification_sound), updated_at = now()
            RETURNING *
        `;

    return sendSuccess(res, req.schoolId, { message: 'Settings updated successfully', settings: upserted });
  } catch (error) {

    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/**
 * PUT /users/:id
 * Update user (account status, etc.)
 */
router.put('/:id', async (req, res) => {
  if (!req.user || !req.user.roles.includes('admin') && !req.user.permissions.includes('users.edit')) {
    return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
  }

  const { id } = req.params;
  const { account_status } = req.body;

  try {
    // U6 FIX: Ownership check — verify user belongs to this school
    const [existing] = await sql`
            SELECT id FROM users
            WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
        `;
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    const [updated] = await sql`
            UPDATE users
            SET account_status = COALESCE(${account_status ?? null}, account_status)
            WHERE id = ${id} AND school_id = ${req.schoolId}
            RETURNING id, account_status
        `;

    if (!updated) {
      return res.status(404).json({ error: 'User not found' });
    }

    return sendSuccess(res, req.schoolId, { message: 'User updated', user: updated });
  } catch (error) {

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
    // U7 FIX: Verify user belongs to this school
    const [userCheck] = await sql`SELECT id FROM users WHERE id = ${id} AND school_id = ${req.schoolId}`;
    if (!userCheck) {
      return res.status(404).json({ error: 'User not found' });
    }

    // U7 FIX: Add school_id filter to role lookup
    const [role] = await sql`SELECT id FROM roles WHERE code = ${role_code} AND school_id = ${req.schoolId}`;
    if (!role) {
      return res.status(404).json({ error: 'Role not found' });
    }

    // U7 FIX: Add school_id to user_roles INSERT
    await sql`
            INSERT INTO user_roles (user_id, role_id, school_id, granted_by)
            VALUES (${id}, ${role.id}, ${req.schoolId}, ${req.user.internal_id})
            ON CONFLICT (user_id, role_id) DO NOTHING
        `;

    return sendSuccess(res, req.schoolId, { message: 'Role assigned successfully' });
  } catch (error) {

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
    // U8 FIX: Add school_id filter to user_roles DELETE
    const [deleted] = await sql`
            DELETE FROM user_roles
            WHERE user_id = ${id} AND role_id = ${roleId}
              AND school_id = ${req.schoolId}
            RETURNING user_id
        `;

    if (!deleted) {
      return res.status(404).json({ error: 'Role assignment not found' });
    }

    return sendSuccess(res, req.schoolId, { message: 'Role removed successfully' });
  } catch (error) {

    res.status(500).json({ error: 'Failed to remove role' });
  }
});

/**
 * PATCH /users/me/photo
 * Self-service profile picture upload/update for ANY portal (parent/admin/
 * staff/driver/accountant). Strictly scoped to the authenticated user's own
 * person via req.user.person_id — one user can never overwrite another's photo.
 *
 * Multipart form field: "photo". The server re-encodes to a square JPEG in the
 * 50–100 KB band, upserts it to the public `avatars` bucket at a stable path,
 * and writes the resulting URL to persons.photo_url.
 */
router.patch('/me/photo', singleAvatarUpload, handleAvatarMulterError, async (req, res) => {
  if (!req.user || !req.user.person_id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({ error: 'No image provided. Attach an image under the "photo" field.' });
  }

  try {
    const { buffer } = await normalizeAvatar(req.file.buffer);
    const photoUrl = await uploadAvatar(req.schoolId, req.user.person_id, buffer);

    const [updated] = await sql`
            UPDATE persons
            SET photo_url = ${photoUrl}, updated_at = now()
            WHERE id = ${req.user.person_id} AND school_id = ${req.schoolId}
            RETURNING id, photo_url
        `;

    if (!updated) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    return sendSuccess(res, req.schoolId, { message: 'Profile picture updated', photo_url: updated.photo_url });
  } catch (error) {
    if (/not a valid image/i.test(error?.message || '')) {
      return res.status(400).json({ error: 'The uploaded file is not a valid image.' });
    }
    return res.status(500).json({ error: 'Failed to update profile picture' });
  }
});

/**
 * DELETE /users/me/photo
 * Remove the authenticated user's own profile picture (revert to initials).
 */
router.delete('/me/photo', async (req, res) => {
  if (!req.user || !req.user.person_id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await removeAvatar(req.schoolId, req.user.person_id).catch(() => {});

    const [updated] = await sql`
            UPDATE persons
            SET photo_url = NULL, updated_at = now()
            WHERE id = ${req.user.person_id} AND school_id = ${req.schoolId}
            RETURNING id
        `;

    if (!updated) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    return sendSuccess(res, req.schoolId, { message: 'Profile picture removed', photo_url: null });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to remove profile picture' });
  }
});

export default router;