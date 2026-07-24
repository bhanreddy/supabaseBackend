import express from 'express';
import { sendSuccess } from '../utils/apiResponse.js';
import { supabase, supabaseAdmin } from '../db.js';
import sql from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import config from '../config/env.js';
import { normalizeEmail } from '../utils/schoolEmail.js';
import { requireAuth } from '../middleware/auth.js';
import {
  refreshUserAccessContexts,
  buildContextsPayload,
  registerDeviceSession,
  switchActiveContext,
} from '../services/accessContextService.js';

const router = express.Router();

/** OPT-20: short TTL cache for staff class_section_id (rarely changes mid-session). */
const _authSectionCache = new Map();

async function getActiveAcademicYearIdForSchool(schoolId) {
  const [y] = await sql`
    SELECT id FROM academic_years
    WHERE now() BETWEEN start_date AND end_date
      AND school_id = ${schoolId}
    LIMIT 1
  `;
  return y?.id ?? null;
}

async function detectClassSectionForStaff(staffId, schoolId, academicYearId) {
  if (!staffId || !academicYearId) return null;
  const [row] = await sql`
    (
      SELECT class_section_id AS id FROM timetable_slots
      WHERE teacher_id = ${staffId}
        AND school_id = ${schoolId}
        AND academic_year_id = ${academicYearId}
        AND period_number = 1
        AND deleted_at IS NULL
      ORDER BY day_of_week, class_section_id
      LIMIT 1
    )
    UNION ALL
    (
      SELECT id FROM class_sections
      WHERE class_teacher_id = ${staffId}
        AND school_id = ${schoolId}
        AND academic_year_id = ${academicYearId}
        AND deleted_at IS NULL
      LIMIT 1
    )
    LIMIT 1
  `;
  return row?.id ?? null;
}

/**
 * POST /auth/login
 * Login with email and password via Supabase Auth
 */
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const canonicalEmail = normalizeEmail(email);

  const { data, error } = await supabase.auth.signInWithPassword({
    email: canonicalEmail,
    password
  });

  if (error) {
    return res.status(401).json({ error: 'Invalid credentials', details: error.message });
  }

  // Fetch user roles and permissions
  const userInfo = await sql`
    SELECT 
      u.id, u.school_id, u.account_status, u.person_id,
      p.first_name, p.last_name, p.display_name, p.photo_url,
      s.admission_no,
      st.id as staff_id,
      st.staff_code,
      (SELECT EXISTS(SELECT 1 FROM students st WHERE st.person_id = p.id AND st.deleted_at IS NULL)) as has_student_profile,
      (SELECT EXISTS(SELECT 1 FROM staff st WHERE st.person_id = p.id AND st.deleted_at IS NULL)) as has_staff_profile,
      array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL) as roles,
      array_agg(DISTINCT perm.code) FILTER (WHERE perm.code IS NOT NULL) as permissions,
      us.notification_sound,
      g.name as gender
    FROM users u
    JOIN persons p ON u.person_id = p.id
    LEFT JOIN genders g ON p.gender_id = g.id
    LEFT JOIN user_settings us ON u.id = us.user_id
    LEFT JOIN students s ON p.id = s.person_id
    LEFT JOIN staff st ON p.id = st.person_id
    LEFT JOIN user_roles ur ON u.id = ur.user_id
    LEFT JOIN roles r ON ur.role_id = r.id
    LEFT JOIN role_permissions rp ON r.id = rp.role_id
    LEFT JOIN permissions perm ON rp.permission_id = perm.id
    WHERE u.id = ${data.user.id}
    GROUP BY u.id, p.id, g.name, s.admission_no, st.id, us.notification_sound
  `;

  if (userInfo.length === 0) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const dbUser = userInfo[0];

  if (dbUser.account_status !== 'active') {
    return res.status(403).json({ error: 'Account is not active' });
  }

  // B5: Verify user belongs to requested school (tenant isolation)
  if (String(dbUser.school_id) !== String(req.schoolId)) {
    return res.status(403).json({ error: 'User does not belong to this school', code: 'SCHOOL_MISMATCH' });
  }

  // Check for Class/Section Assignment
  let classSectionId = null;
  if (dbUser.has_staff_profile && dbUser.staff_id) {
    const yearId = await getActiveAcademicYearIdForSchool(req.schoolId);
    if (yearId) {
      classSectionId = await detectClassSectionForStaff(dbUser.staff_id, req.schoolId, yearId);
    }
  } else if (dbUser.has_student_profile) {
    const [enrollment] = await sql`
            SELECT se.class_section_id 
            FROM student_enrollments se
            JOIN students s ON se.student_id = s.id
            WHERE s.person_id = ${dbUser.person_id}
              AND s.school_id = ${req.schoolId}
              AND se.school_id = ${req.schoolId}
              AND se.status = 'active'
              AND se.deleted_at IS NULL
            LIMIT 1
        `;
    if (enrollment) {
      classSectionId = enrollment.class_section_id;
    }
  }

  // Update last login
  await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${data.user.id}
      AND school_id = ${req.schoolId}`;

  try {
    await refreshUserAccessContexts(data.user.id);
  } catch (ctxErr) {
    console.error('[auth/login] refreshUserAccessContexts failed:', ctxErr.message);
  }

  return sendSuccess(res, req.schoolId, {
    message: 'Login successful',
    token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: {
      id: dbUser.id,
      email: canonicalEmail,
      display_name: dbUser.display_name,
      first_name: dbUser.first_name,
      last_name: dbUser.last_name,
      photo_url: dbUser.photo_url,
      roles: dbUser.roles || [],
      permissions: dbUser.permissions || [],
      admission_no: dbUser.admission_no,
      has_student_profile: dbUser.has_student_profile,
      has_staff_profile: dbUser.has_staff_profile,
      staff_id: dbUser.staff_id,
      staff_code: dbUser.staff_code,
      class_section_id: classSectionId,
      classId: classSectionId,
      notification_sound: dbUser.notification_sound || 'custom',
      gender: dbUser.gender
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

  return sendSuccess(res, req.schoolId, { message: 'Logged out successfully' });
}));

/**
 * POST /auth/validate-school-user
 * Validates that the Supabase JWT maps to an active user in the system.
 * The backend derives the school context from the users table using only the JWT uid.
 */
router.post('/validate-school-user', asyncHandler(async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const userInfo = await sql`
    SELECT
      u.id as user_id, u.school_id, u.account_status,
      u.is_temporary_password, u.person_id,
      p.display_name, p.photo_url,
      r.code as role_code, r.name as role_name,
      (SELECT EXISTS(
        SELECT 1 FROM staff st
        WHERE st.person_id = u.person_id AND st.school_id = u.school_id AND st.deleted_at IS NULL
      )) as has_staff_profile,
      (SELECT EXISTS(
        SELECT 1 FROM students s
        WHERE s.person_id = u.person_id AND s.school_id = u.school_id AND s.deleted_at IS NULL
      )) as has_student_profile,
      (SELECT st.id FROM staff st
       WHERE st.person_id = u.person_id AND st.school_id = u.school_id AND st.deleted_at IS NULL
       LIMIT 1) as staff_id,
      (SELECT st.staff_code FROM staff st
       WHERE st.person_id = u.person_id AND st.school_id = u.school_id AND st.deleted_at IS NULL
       LIMIT 1) as staff_code,
      (SELECT s.admission_no FROM students s
       WHERE s.person_id = u.person_id AND s.school_id = u.school_id AND s.deleted_at IS NULL
       LIMIT 1) as admission_no
    FROM users u
    JOIN persons p ON u.person_id = p.id
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN roles r ON ur.role_id = r.id
    WHERE u.id = ${req.user.id}
      AND u.deleted_at IS NULL
    LIMIT 1
  `;

  if (userInfo.length === 0) {
    return res.status(403).json({ error: 'account_not_in_school' });
  }

  const dbUser = userInfo[0];

  if (dbUser.account_status === 'locked') {
    return res.status(403).json({ error: 'account_locked' });
  }

  if (dbUser.account_status !== 'active') {
    return res.status(403).json({ error: 'account_not_active' });
  }

  // B5: Verify user belongs to requested school
  if (String(dbUser.school_id) !== String(req.schoolId)) {
    return res.status(403).json({ error: 'User does not belong to this school', code: 'SCHOOL_MISMATCH' });
  }

  // Update last login
  await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${req.user.id}
      AND school_id = ${req.schoolId}`;

  let portalContexts = null;
  try {
    await refreshUserAccessContexts(req.user.id);
    const deviceId = req.headers['x-device-id'] || null;
    portalContexts = await buildContextsPayload(req.user.id, deviceId);
  } catch (ctxErr) {
    console.error('[auth/validate-school-user] refreshUserAccessContexts failed:', ctxErr.message);
  }

  // Resolve the class-section for this login, exactly as /auth/login and /auth/me do.
  // This endpoint backs BOTH first login and every account switch/session restore, so
  // omitting it left validatedUser.classId undefined for switched accounts — and the
  // parent diary then queried its local DB with no class filter, showing one sibling's
  // homework in the other sibling's portal.
  let classSectionId = null;
  if (dbUser.has_staff_profile && dbUser.staff_id) {
    const cacheKey = `${dbUser.user_id}:${req.schoolId}`;
    const hit = _authSectionCache.get(cacheKey);
    if (hit && Date.now() < hit.expiresAt) {
      classSectionId = hit.id;
    } else {
      const yearId = await getActiveAcademicYearIdForSchool(req.schoolId);
      classSectionId = yearId ? await detectClassSectionForStaff(dbUser.staff_id, req.schoolId, yearId) : null;
      _authSectionCache.set(cacheKey, { id: classSectionId, expiresAt: Date.now() + 5 * 60_000 });
    }
  } else if (dbUser.has_student_profile) {
    const [enrollment] = await sql`
      SELECT se.class_section_id
      FROM student_enrollments se
      JOIN students s ON se.student_id = s.id
      WHERE s.person_id = ${dbUser.person_id}
        AND s.school_id = ${req.schoolId}
        AND se.school_id = ${req.schoolId}
        AND se.status = 'active'
        AND se.deleted_at IS NULL
      LIMIT 1
    `;
    if (enrollment) classSectionId = enrollment.class_section_id;
  }

  // Map DB role codes to frontend-expected codes
  const roleCode = dbUser.role_code === 'accounts' ? 'accountant' : dbUser.role_code;

  // Only return requiresPasswordChange for admin role
  const requiresPasswordChange = roleCode === 'admin' && dbUser.is_temporary_password === true;

  return sendSuccess(res, req.schoolId, {
    userId: dbUser.user_id,
    schoolId: dbUser.school_id,
    displayName: dbUser.display_name,
    photoUrl: dbUser.photo_url,
    role: { code: roleCode, name: dbUser.role_name },
    roles: (req.user?.roles || []).filter(Boolean),
    permissions: (req.user?.permissions || []).filter(Boolean),
    accountStatus: dbUser.account_status,
    has_staff_profile: dbUser.has_staff_profile,
    has_student_profile: dbUser.has_student_profile,
    staffId: dbUser.staff_id || null,
    staff_code: dbUser.staff_code || null,
    admission_no: dbUser.admission_no || null,
    class_section_id: classSectionId,
    classId: classSectionId,
    requiresPasswordChange,
    portalContexts,
  });
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

  return sendSuccess(res, req.schoolId, {
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
      u.id, u.school_id, u.person_id, u.account_status, u.last_login_at, u.created_at,
      p.first_name, p.middle_name, p.last_name, p.display_name, p.dob, p.photo_url,
      g.name as gender,
      s.admission_no,
      st.id as staff_id,
      st.staff_code,
      (SELECT EXISTS(SELECT 1 FROM students st WHERE st.person_id = p.id AND st.deleted_at IS NULL)) as has_student_profile,
      (SELECT EXISTS(SELECT 1 FROM staff st WHERE st.person_id = p.id AND st.deleted_at IS NULL)) as has_staff_profile,
      array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL) as roles,
      array_agg(DISTINCT perm.code) FILTER (WHERE perm.code IS NOT NULL) as permissions,
      us.notification_sound,
      -- Get contacts
      (SELECT json_agg(json_build_object('type', pc.contact_type, 'value', pc.contact_value, 'is_primary', pc.is_primary))
       FROM person_contacts pc WHERE pc.person_id = p.id AND pc.deleted_at IS NULL) as contacts
    FROM users u
    JOIN persons p ON u.person_id = p.id
    LEFT JOIN user_settings us ON u.id = us.user_id
    LEFT JOIN students s ON p.id = s.person_id
    LEFT JOIN staff st ON p.id = st.person_id
    LEFT JOIN genders g ON p.gender_id = g.id
    LEFT JOIN user_roles ur ON u.id = ur.user_id
    LEFT JOIN roles r ON ur.role_id = r.id
    LEFT JOIN role_permissions rp ON r.id = rp.role_id
    LEFT JOIN permissions perm ON rp.permission_id = perm.id
    WHERE u.id = ${req.user.id}
    GROUP BY u.id, p.id, g.name, s.admission_no, st.id, us.notification_sound
  `;

  if (userInfo.length === 0) {
    return res.status(404).json({ error: 'User not found' });
  }

  const dbUser = userInfo[0];

  // B5: Verify user belongs to requested school
  if (String(dbUser.school_id) !== String(req.schoolId)) {
    return res.status(403).json({ error: 'User does not belong to this school', code: 'SCHOOL_MISMATCH' });
  }

  // Check for Class/Section Assignment (Re-detect for /me)
  let classSectionId = null;
  if (dbUser.has_staff_profile && dbUser.staff_id) {
    const cacheKey = `${dbUser.id}:${req.schoolId}`;
    const hit = _authSectionCache.get(cacheKey);
    if (hit && Date.now() < hit.expiresAt) {
      classSectionId = hit.id;
    } else {
      const yearId = await getActiveAcademicYearIdForSchool(req.schoolId);
      classSectionId = yearId ? await detectClassSectionForStaff(dbUser.staff_id, req.schoolId, yearId) : null;
      _authSectionCache.set(cacheKey, { id: classSectionId, expiresAt: Date.now() + 5 * 60_000 });
    }
  } else if (dbUser.has_student_profile) {
    const [enrollment] = await sql`
            SELECT class_section_id FROM student_enrollments se 
            JOIN students s ON se.student_id = s.id 
            WHERE s.person_id = ${dbUser.person_id}
              AND s.school_id = ${req.schoolId}
              AND se.school_id = ${req.schoolId}
              AND se.status = 'active'
              AND se.deleted_at IS NULL 
            LIMIT 1
        `;
    if (enrollment) classSectionId = enrollment.class_section_id;
  }

  return sendSuccess(res, req.schoolId, {
    ...dbUser,
    staff_id: dbUser.staff_id,
    staff_code: dbUser.staff_code,
    class_section_id: classSectionId,
    classId: classSectionId,
    notification_sound: dbUser.notification_sound || 'custom'
  });
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

  const canonicalEmail = normalizeEmail(email);

  const { error } = await supabase.auth.resetPasswordForEmail(canonicalEmail, {
    redirectTo: config.auth.passwordResetRedirectUrl
  });

  if (error) {

  }

  // Always return success to prevent email enumeration
  return sendSuccess(res, req.schoolId, { message: 'If the email exists, a password reset link has been sent' });
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

  return sendSuccess(res, req.schoolId, { message: 'Password reset successfully' });
}));

/**
 * POST /auth/change-password
 * Change password by verifying current password first
 */
router.post('/change-password', asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!req.user || !req.user.id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }

  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(req.user.id);
  if (userError || !userData.user) {
    return res.status(400).json({ error: 'User not found' });
  }

  const email = userData.user.email;

  // Verify current password by attempting login
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password: current_password
  });

  if (signInError) {
    return res.status(401).json({ error: 'Incorrect current password' });
  }

  // Now update the password
  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
    password: new_password
  });

  if (updateError) {
    return res.status(500).json({ error: 'Failed to update password', details: updateError.message });
  }

  // Log the event
  try {
    await sql`
            INSERT INTO audit_logs (
                user_id, 
                action, 
                entity, 
                details, 
                ip_address, 
                user_agent, 
                request_id
            ) VALUES (
                ${req.user.id}, 
                'PASSWORD_CHANGED', 
                'users', 
                ${sql.json({ changed_at: new Date().toISOString() })}, 
                ${req.ip}, 
                ${req.headers['user-agent']}, 
                ${req.headers['x-request-id']}
            )
        `;
  } catch (auditErr) {

  }

  return sendSuccess(res, req.schoolId, { message: 'Password changed successfully. Please log in again.' });
}));

/**
 * POST /auth/admin/change-password
 * Change password for admin users with temporary password (forced password change flow)
 * Uses the user's own session token - does not require current password
 */
router.post('/admin/change-password', asyncHandler(async (req, res) => {
  const { newPassword, confirmPassword } = req.body;

  if (!req.user || !req.user.id) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }

  // Validate passwords match
  if (!newPassword || !confirmPassword) {
    return res.status(400).json({ success: false, message: 'New password and confirmation are required' });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'Passwords do not match' });
  }

  // Validate password strength
  if (newPassword.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
  }

  if (!/[A-Z]/.test(newPassword)) {
    return res.status(400).json({ success: false, message: 'Password must contain at least 1 uppercase letter' });
  }

  if (!/[0-9]/.test(newPassword)) {
    return res.status(400).json({ success: false, message: 'Password must contain at least 1 number' });
  }

  if (!/[!@#$%^&*(),.?":{}|<>]/.test(newPassword)) {
    return res.status(400).json({ success: false, message: 'Password must contain at least 1 special character (!@#$%^&*)' });
  }

  // Verify user is admin with temporary password
  const [userRecord] = await sql`
    SELECT u.id, u.is_temporary_password, r.code as role_code
    FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN roles r ON ur.role_id = r.id
    WHERE u.id = ${req.user.id}
      AND u.deleted_at IS NULL
    LIMIT 1
  `;

  if (!userRecord) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  if (userRecord.role_code !== 'admin') {
    return res.status(403).json({ success: false, message: 'This endpoint is only for admin users' });
  }

  if (!userRecord.is_temporary_password) {
    return res.status(400).json({ success: false, message: 'Password change not required for this account' });
  }

  // Update password via Supabase Auth using user's own session
  const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });

  if (updateError) {
    return res.status(500).json({ success: false, message: 'Failed to update password', details: updateError.message });
  }

  // Clear the temporary password flag
  await sql`
    UPDATE users 
    SET is_temporary_password = false 
    WHERE id = ${req.user.id}
  `;

  // Log the password change event
  try {
    await sql`
      INSERT INTO audit_logs (
        user_id, 
        action, 
        entity, 
        details, 
        ip_address, 
        user_agent, 
        request_id
      ) VALUES (
        ${req.user.id}, 
        'TEMPORARY_PASSWORD_CHANGED', 
        'users', 
        ${sql.json({ changed_at: new Date().toISOString(), was_temporary: true })}, 
        ${req.ip}, 
        ${req.headers['user-agent']}, 
        ${req.headers['x-request-id']}
      )
    `;
  } catch (auditErr) {
    // Audit log failure should not break the main flow
  }

  return res.status(200).json({ success: true, message: 'Password changed successfully' });
}));

/**
 * GET /auth/contexts
 * List all switchable portal/profile contexts for the logged-in user.
 */
router.get('/contexts', requireAuth, asyncHandler(async (req, res) => {
  const deviceId = req.headers['x-device-id'] || req.query.device_id || null;

  try {
    await refreshUserAccessContexts(req.user.id);
  } catch (ctxErr) {
    console.error('[auth/contexts] refresh failed:', ctxErr.message);
  }

  const payload = await buildContextsPayload(req.user.id, deviceId);
  return sendSuccess(res, req.schoolId, payload);
}));

/**
 * POST /auth/contexts/register-device
 * Bind a client device_id to the user's session (sets default active context).
 */
router.post('/contexts/register-device', requireAuth, asyncHandler(async (req, res) => {
  const deviceId = req.body?.device_id || req.headers['x-device-id'];
  if (!deviceId || typeof deviceId !== 'string') {
    return res.status(400).json({ error: 'device_id is required' });
  }

  try {
    await refreshUserAccessContexts(req.user.id);
  } catch (ctxErr) {
    console.error('[auth/contexts/register-device] refresh failed:', ctxErr.message);
  }

  const session = await registerDeviceSession(req.user.id, deviceId, {
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  const payload = await buildContextsPayload(req.user.id, deviceId);

  return sendSuccess(res, req.schoolId, {
    deviceId,
    sessionId: session.id,
    ...payload,
  });
}));

/**
 * POST /auth/contexts/switch
 * Switch the active portal/profile context for this device.
 */
router.post('/contexts/switch', requireAuth, asyncHandler(async (req, res) => {
  const deviceId = req.body?.device_id || req.headers['x-device-id'];
  const contextId = req.body?.context_id || req.body?.contextId;

  if (!deviceId || typeof deviceId !== 'string') {
    return res.status(400).json({ error: 'device_id is required' });
  }
  if (!contextId || typeof contextId !== 'string') {
    return res.status(400).json({ error: 'context_id is required' });
  }

  try {
    const result = await switchActiveContext(req.user.id, deviceId, contextId, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.headers['x-request-id'],
      reason: req.body?.reason || 'user_initiated',
    });

    const payload = await buildContextsPayload(req.user.id, deviceId);

    return sendSuccess(res, req.schoolId, {
      ...result,
      groups: payload.groups,
      total: payload.total,
    });
  } catch (err) {
    if (err.code === 'CONTEXT_INVALID') {
      return res.status(403).json({
        error: err.message,
        code: 'CONTEXT_INVALID',
        action: 'SHOW_CONTEXT_PICKER',
      });
    }
    if (err.code === 'DEVICE_ID_REQUIRED') {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
}));

/**
 * POST /auth/request-access
 * Unauthenticated endpoint to request out-of-hours access after a rejected login
 */
router.post('/request-access', asyncHandler(async (req, res) => {
  const { userId, department, note } = req.body;

  if (!userId || !department) {
    return res.status(400).json({ error: 'userId and department are required' });
  }

  // Look up the user's school_id (required for multi-tenancy)
  const [user] = await sql`SELECT school_id FROM users WHERE id = ${userId} AND deleted_at IS NULL`;
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Insert using the admin backend connection (bypasses RLS)
  try {
    const [request] = await sql`
        INSERT INTO access_requests (school_id, requested_by, department, request_note, status) 
        VALUES (${user.school_id}, ${userId}, ${department}, ${note}, 'pending')
        RETURNING id
    `;
    return sendSuccess(res, req.schoolId, { success: true, message: 'Access request submitted successfully', requestId: request.id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit request', details: err.message });
  }
}));
export default router;