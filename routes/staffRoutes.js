import express from 'express';
import sql, { supabaseAdmin } from '../db.js';
import { requirePermission, requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  assertSchoolEmailAvailable,
  createSchoolScopedAuthUser,
  sendSchoolEmailConflict,
  updateSchoolScopedAuthEmail
} from '../utils/schoolEmail.js';
import { resolveDbRoleCode } from '../utils/roleCodes.js';

const router = express.Router();

/**
 * Salary is management-only (RBAC epic #13). A staff/accounts member must never
 * see any staff member's salary. Admin bypasses; otherwise the caller must hold
 * the salary.view permission. Used to strip the salary field from list/detail
 * responses so the value never leaves the server for unauthorized callers.
 */
const canViewSalary = (req) =>
  !!req.user && (req.user.roles?.includes('admin') || req.user.permissions?.includes('salary.view'));

const stripSalary = (row) => {
  if (!row || typeof row !== 'object') return row;
  const { salary, ...rest } = row;
  return rest;
};

/**
 * SuperAdmin first-admin seed historically created person + user + admin role
 * without a `staff` row. Manage Staff only queries `staff`, so those admins were
 * invisible. Heal missing rows on list so existing tenants recover automatically.
 */
async function ensureAdminStaffRows(schoolId) {
  await sql`
    INSERT INTO staff_designations (school_id, name)
    SELECT DISTINCT u.school_id, 'Administrator'
    FROM users u
    JOIN user_roles ur
      ON ur.user_id = u.id
     AND ur.school_id = u.school_id
     AND ur.deleted_at IS NULL
    JOIN roles r
      ON r.id = ur.role_id
     AND r.code = 'admin'
     AND r.school_id = u.school_id
    WHERE u.school_id = ${schoolId}
      AND u.person_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM staff st
        WHERE st.person_id = u.person_id
          AND st.school_id = u.school_id
          AND st.deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM staff_designations sd
        WHERE sd.school_id = u.school_id
          AND sd.name = 'Administrator'
      )
  `;

  await sql`
    INSERT INTO staff (school_id, person_id, staff_code, joining_date, status_id, designation_id)
    SELECT
      u.school_id,
      u.person_id,
      'ADM-' || UPPER(SUBSTRING(REPLACE(u.person_id::text, '-', ''), 1, 8)),
      CURRENT_DATE,
      1,
      COALESCE(
        (SELECT sd.id FROM staff_designations sd
         WHERE sd.school_id = u.school_id AND sd.name = 'Administrator' LIMIT 1),
        (SELECT sd.id FROM staff_designations sd
         WHERE sd.school_id = u.school_id AND sd.name = 'Principal' LIMIT 1),
        (SELECT sd.id FROM staff_designations sd
         WHERE sd.school_id = u.school_id ORDER BY sd.id LIMIT 1)
      )
    FROM users u
    JOIN user_roles ur
      ON ur.user_id = u.id
     AND ur.school_id = u.school_id
     AND ur.deleted_at IS NULL
    JOIN roles r
      ON r.id = ur.role_id
     AND r.code = 'admin'
     AND r.school_id = u.school_id
    WHERE u.school_id = ${schoolId}
      AND u.person_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM staff st
        WHERE st.person_id = u.person_id
          AND st.school_id = u.school_id
          AND st.deleted_at IS NULL
      )
  `;
}

let accountsStaffCreationColumnReady = false;

async function ensureAccountsStaffCreationColumn() {
  if (accountsStaffCreationColumnReady) return;

  await sql`
    ALTER TABLE schools
    ADD COLUMN IF NOT EXISTS accounts_staff_creation_enabled BOOLEAN NOT NULL DEFAULT true
  `;
  accountsStaffCreationColumnReady = true;
}

function normalizeStaffPayload(body) {
  return {
    first_name: body.first_name?.trim(),
    middle_name: body.middle_name?.trim() || null,
    last_name: body.last_name?.trim(),
    dob: body.dob || null,
    gender_id: body.gender_id || null, // Default to null if missing
    staff_code: body.staff_code?.trim(),
    joining_date: body.joining_date,
    status_id: body.status_id || 1, // Default to Active (1)
    designation_id: body.designation_id || null, // Default to null if missing
    salary: body.salary || null,
    email: body.email?.trim() || null,
    phone: body.phone?.trim() || null,
    password: body.password || null,
    role_code: body.role_code || null
  };
}

function isAccountsOnlyUser(req) {
  const roles = req.user?.roles || [];
  const elevated = roles.some((role) => ['admin', 'principal'].includes(role));
  return roles.includes('accounts') && !elevated;
}

async function getAccountsStaffCreationEnabled(schoolId) {
  await ensureAccountsStaffCreationColumn();

  const [row] = await sql`
    SELECT accounts_staff_creation_enabled
    FROM schools
    WHERE id = ${schoolId}
  `;
  return row?.accounts_staff_creation_enabled !== false;
}

async function assertAccountsCanCreateStaff(req, res) {
  if (!isAccountsOnlyUser(req)) return true;

  const enabled = await getAccountsStaffCreationEnabled(req.user.schoolId);
  if (enabled) return true;

  res.status(403).json({
    error: 'Direct staff, admin, and driver creation is disabled for accounts users.',
    code: 'ACCOUNTS_STAFF_CREATION_DISABLED'
  });
  return false;
}

let staffPayslipsColumnReady = false;

async function ensureStaffPayslipsColumn() {
  if (staffPayslipsColumnReady) return;

  await sql`
    ALTER TABLE schools
    ADD COLUMN IF NOT EXISTS staff_payslips_enabled BOOLEAN NOT NULL DEFAULT true
  `;
  staffPayslipsColumnReady = true;
}

async function getStaffPayslipsEnabled(schoolId) {
  await ensureStaffPayslipsColumn();
  const [row] = await sql`
    SELECT staff_payslips_enabled
    FROM schools
    WHERE id = ${schoolId}
  `;
  return row?.staff_payslips_enabled !== false;
}

function canBypassStaffPayslipsGate(req) {
  return req.user.roles?.includes('admin') || req.user.permissions?.includes('payslip.view');
}

function formatStaffPayslipRows(payslips) {
  const formatCurrency = (amount) => `₹${Number(amount || 0).toLocaleString('en-IN')}`;
  return payslips.map((p) => {
    const date = new Date();
    date.setMonth(Number(p.month) - 1);
    const monthName = date.toLocaleString('default', { month: 'long' });
    const statusStr = p.status != null ? String(p.status) : '';
    return {
      id: p.id,
      month: `${monthName} ${p.year}`,
      status: statusStr ? statusStr.charAt(0).toUpperCase() + statusStr.slice(1) : '',
      earnings: formatCurrency(p.earnings),
      deductions: formatCurrency(p.deductions),
      net: formatCurrency(p.net),
      payment_date: p.payment_date
    };
  });
}

/**
 * @param {{ disbursedOnly?: boolean }} opts - If true, only rows marked paid by accounts (excludes pending payroll).
 */
async function fetchPayslipsForStaffId(staffId, schoolId, opts = {}) {
  const { disbursedOnly = false } = opts;
  return sql`
    SELECT 
      sp.id,
      sp.payroll_month as month,
      sp.payroll_year as year,
      sp.status,
      sp.net_salary as net,
      sp.base_salary + COALESCE(sp.bonus, 0) as earnings,
      sp.deductions as deductions,
      sp.payment_date,
      st.staff_code,
      p.display_name as staff_name,
      sd.name as designation
    FROM staff_payroll sp
    JOIN staff st ON sp.staff_id = st.id AND st.school_id = ${schoolId}
    JOIN persons p ON st.person_id = p.id
    LEFT JOIN staff_designations sd ON st.designation_id = sd.id
    WHERE sp.staff_id = ${staffId}
    ${disbursedOnly ? sql`AND sp.status = 'paid'` : sql``}
    ORDER BY sp.payroll_year DESC, sp.payroll_month DESC
  `;
}

/**
 * GET /staff
 * List all staff members
 */
router.get('/', requirePermission('staff.view'), asyncHandler(async (req, res) => {
  const { status, designation_id, search, page = 1, limit = 50 } = req.query;
  const safeLimit = Math.min(200, Math.max(1, parseInt(String(limit), 10) || 50));
  const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
  const offset = (pageNum - 1) * safeLimit;

  // Backfill staff rows for admins seeded without one (SuperAdmin first-admin).
  await ensureAdminStaffRows(req.schoolId);

  // school_id is always taken from the JWT (req.schoolId), never from the client.
  const hasSearch = typeof search === 'string' && search.trim() !== '';
  const searchTerm = hasSearch ? `%${search.trim()}%` : '';
  const searchClause = hasSearch
    ? sql`AND (
        p.display_name ILIKE ${searchTerm} OR
        p.first_name ILIKE ${searchTerm} OR
        p.last_name ILIKE ${searchTerm} OR
        CONCAT(p.first_name, ' ', p.last_name) ILIKE ${searchTerm} OR
        st.staff_code ILIKE ${searchTerm}
      )`
    : sql``;

  const [staff, [countResult]] = await Promise.all([
    sql`
    SELECT
      st.id, st.staff_code, st.joining_date, st.salary,
      p.first_name, p.middle_name, p.last_name, p.display_name, p.dob, p.photo_url,
      g.name as gender,
      sd.name as designation,
      ss.name as status,
      (SELECT contact_value FROM person_contacts pc
       WHERE pc.person_id = p.id AND pc.contact_type = 'email' AND pc.is_primary = true LIMIT 1) as email,
      (SELECT contact_value FROM person_contacts pc
       WHERE pc.person_id = p.id AND pc.contact_type = 'phone' AND pc.is_primary = true LIMIT 1) as phone
    FROM staff st
    JOIN persons p ON st.person_id = p.id
    LEFT JOIN genders g ON p.gender_id = g.id
    LEFT JOIN staff_designations sd ON st.designation_id = sd.id
    LEFT JOIN staff_statuses ss ON st.status_id = ss.id
    WHERE st.deleted_at IS NULL
      AND st.school_id = ${req.schoolId}
      ${status ? sql`AND ss.code = ${status}` : sql``}
      ${designation_id ? sql`AND st.designation_id = ${designation_id}` : sql``}
      ${searchClause}
    ORDER BY p.display_name
    LIMIT ${safeLimit} OFFSET ${offset}
  `,
    sql`
    SELECT COUNT(*)::int as total
    FROM staff st
    JOIN persons p ON st.person_id = p.id
    LEFT JOIN staff_statuses ss ON st.status_id = ss.id
    WHERE st.deleted_at IS NULL
      AND st.school_id = ${req.schoolId}
      ${status ? sql`AND ss.code = ${status}` : sql``}
      ${designation_id ? sql`AND st.designation_id = ${designation_id}` : sql``}
      ${searchClause}
  `,
  ]);

  // Segregation of duties: strip salary unless the caller may view it.
  const visibleStaff = canViewSalary(req) ? staff : staff.map(stripSalary);

  return sendSuccess(res, req.schoolId, {
    data: visibleStaff,
    meta: {
      total: countResult.total,
      page: pageNum,
      limit: safeLimit,
      total_pages: Math.ceil(countResult.total / safeLimit) || 1,
    },
  });
}));

/**
 * GET /staff/me/profile
 * Logged-in staff member's profile (personal info + driver transport assignment when applicable).
 */
router.get('/me/profile', requireAuth, asyncHandler(async (req, res) => {
  const [profile] = await sql`
    SELECT
      st.id,
      st.staff_code,
      st.joining_date,
      p.first_name,
      p.middle_name,
      p.last_name,
      p.display_name,
      p.dob,
      p.photo_url,
      g.name AS gender,
      sd.name AS designation,
      ss.name AS status,
      (SELECT pc.contact_value FROM person_contacts pc
       WHERE pc.person_id = p.id AND pc.contact_type = 'email'
         AND pc.is_primary = true AND pc.deleted_at IS NULL
       LIMIT 1) AS email,
      (SELECT pc.contact_value FROM person_contacts pc
       WHERE pc.person_id = p.id AND pc.contact_type = 'phone'
         AND pc.is_primary = true AND pc.deleted_at IS NULL
       LIMIT 1) AS phone,
      (SELECT pc.contact_value FROM person_contacts pc
       WHERE pc.person_id = p.id AND pc.contact_type = 'address'
         AND pc.is_primary = true AND pc.deleted_at IS NULL
       LIMIT 1) AS address,
      (
        SELECT json_build_object(
          'id', b.id,
          'bus_no', b.bus_no,
          'registration_no', b.registration_no,
          'capacity', b.capacity
        )
        FROM buses b
        WHERE b.driver_id = st.id
          AND b.is_active = true
          AND b.deleted_at IS NULL
          AND b.school_id = ${req.schoolId}
        LIMIT 1
      ) AS bus,
      (
        SELECT COALESCE(json_agg(
          json_build_object('id', r.id, 'name', r.name, 'direction', r.direction)
          ORDER BY r.direction, r.name
        ), '[]'::json)
        FROM transport_routes r
        JOIN buses b ON r.bus_id = b.id
        WHERE b.driver_id = st.id
          AND r.is_active = true
          AND b.is_active = true
          AND b.deleted_at IS NULL
          AND b.school_id = ${req.schoolId}
      ) AS routes
    FROM staff st
    JOIN persons p ON st.person_id = p.id
    LEFT JOIN genders g ON p.gender_id = g.id
    LEFT JOIN staff_designations sd ON st.designation_id = sd.id
    LEFT JOIN staff_statuses ss ON st.status_id = ss.id
    WHERE st.person_id = ${req.user.person_id}
      AND st.school_id = ${req.schoolId}
      AND st.deleted_at IS NULL
    LIMIT 1
  `;

  if (!profile) {
    return res.status(404).json({ error: 'Staff profile not found for this user' });
  }

  return sendSuccess(res, req.schoolId, profile);
}));

/**
 * GET /staff/portal-config
 * Feature flags for the staff portal (payslips visibility, etc.).
 */
router.get('/portal-config', requireAuth, asyncHandler(async (req, res) => {
  const schoolEnabled = await getStaffPayslipsEnabled(req.schoolId);
  const payslips_enabled = canBypassStaffPayslipsGate(req) ? true : schoolEnabled;
  return sendSuccess(res, req.schoolId, { payslips_enabled });
}));

/**
 * GET /staff/me/payslips
 * Logged-in user's payslips from staff_payroll (same rows accounts updates via payroll routes).
 * Uses person_id → staff.id so clients do not confuse users.id with staff.id.
 */
router.get('/me/payslips', requireAuth, asyncHandler(async (req, res) => {
  if (!(await getStaffPayslipsEnabled(req.schoolId)) && !canBypassStaffPayslipsGate(req)) {
    return res.status(403).json({
      error: 'Payslips are disabled for the staff portal',
      code: 'PAYSLIPS_DISABLED',
    });
  }

  const [targetStaff] = await sql`
    SELECT id FROM staff
    WHERE person_id = ${req.user.person_id}
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;

  if (!targetStaff) {
    return sendSuccess(res, req.schoolId, []);
  }

  const payslips = await fetchPayslipsForStaffId(targetStaff.id, req.schoolId, { disbursedOnly: true });
  return sendSuccess(res, req.schoolId, formatStaffPayslipRows(payslips));
}));

/**
 * GET /staff/:id
 * Get single staff member details
 */
router.get('/:id', requirePermission('staff.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [staff] = await sql`
    SELECT 
      st.id, st.staff_code, st.joining_date, st.salary, st.created_at,
      p.id as person_id, p.first_name, p.middle_name, p.last_name, p.display_name, p.dob, p.photo_url,
      g.name as gender,
      sd.name as designation, sd.id as designation_id,
      ss.name as status, ss.id as status_id,
      u.id as user_id, u.account_status,
      (SELECT pc.contact_value FROM person_contacts pc
       WHERE pc.person_id = p.id AND pc.contact_type = 'email'
         AND pc.is_primary = true AND pc.deleted_at IS NULL LIMIT 1) as email,
      (SELECT pc.contact_value FROM person_contacts pc
       WHERE pc.person_id = p.id AND pc.contact_type = 'phone'
         AND pc.is_primary = true AND pc.deleted_at IS NULL LIMIT 1) as phone,
      (SELECT pc.contact_value FROM person_contacts pc
       WHERE pc.person_id = p.id AND pc.contact_type = 'address'
         AND pc.is_primary = true AND pc.deleted_at IS NULL LIMIT 1) as address,
      (SELECT json_agg(json_build_object('type', pc.contact_type, 'value', pc.contact_value, 'is_primary', pc.is_primary))
       FROM person_contacts pc WHERE pc.person_id = p.id AND pc.deleted_at IS NULL) as contacts
    FROM staff st
    JOIN persons p ON st.person_id = p.id
    LEFT JOIN genders g ON p.gender_id = g.id
    LEFT JOIN staff_designations sd ON st.designation_id = sd.id
    LEFT JOIN staff_statuses ss ON st.status_id = ss.id
    LEFT JOIN users u ON u.person_id = p.id
    WHERE st.id = ${id} AND st.deleted_at IS NULL AND st.school_id = ${req.schoolId}
  `;

  if (!staff) {
    return res.status(404).json({ error: 'Staff not found' });
  }

  // Segregation of duties: strip salary unless the caller may view it.
  return sendSuccess(res, req.schoolId, canViewSalary(req) ? staff : stripSalary(staff));
}));

/**
 * POST /staff
 * Create new staff member (and optionally user login)
 */
router.post('/', requirePermission('staff.create'), asyncHandler(async (req, res) => {
  const staffData = normalizeStaffPayload(req.body);
  const {
    first_name, middle_name, last_name, dob, gender_id,
    staff_code, joining_date, status_id, designation_id, salary,
    email, phone, password, role_code
  } = staffData;

  if (!first_name || !last_name || !staff_code || !joining_date) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Missing required fields: first_name, last_name, staff_code, joining_date'
    });
  }

  // Every staff record created from this route must have usable login credentials.
  // Do not make this conditional on role_code; callers could otherwise bypass it.
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const normalizedPhone = typeof phone === 'string' ? phone.trim() : '';
  const phoneDigits = normalizedPhone.replace(/\D/g, '');
  if (!normalizedEmail || !normalizedPhone || !password) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Missing required credentials: email, phone, password'
    });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'A valid email address is required' });
  }
  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Phone number must contain 10 to 15 digits' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Password must be at least 6 characters' });
  }

  if (!(await assertAccountsCanCreateStaff(req, res))) {
    return;
  }

  try {
    const schoolId = req.user.schoolId;
    req.schoolId = String(schoolId);
    const canonicalEmail = await assertSchoolEmailAvailable(sql, schoolId, normalizedEmail);

    const result = await sql.begin(async (sql) => {
      // 1. Create Person
      const [person] = await sql`
                INSERT INTO persons (school_id, first_name, middle_name, last_name, dob, gender_id)
                VALUES (${schoolId}, ${first_name}, ${middle_name || null}, ${last_name}, ${dob || null}, ${gender_id})
                RETURNING id
            `;

      // 2. Create Staff
      const [staff] = await sql`
                INSERT INTO staff (school_id, person_id, staff_code, joining_date, status_id, designation_id, salary)
                VALUES (${schoolId}, ${person.id}, ${staff_code}, ${joining_date}, ${status_id || 1}, ${designation_id}, ${salary || null})
                RETURNING *
            `;

      // 3. Contacts
      if (canonicalEmail) {
        await sql`INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary) 
                    VALUES (${schoolId}, ${person.id}, 'email', ${canonicalEmail}, true)`;
      }
      if (normalizedPhone) {
        await sql`INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary)
                    VALUES (${schoolId}, ${person.id}, 'phone', ${normalizedPhone}, true)`;
      }

      // 4. Create User Login (Optional)
      if (password && canonicalEmail) {
        // Ensure Supabase Admin is available
        if (!supabaseAdmin) {
          throw new Error('Server misconfiguration: Admin client not initialized');
        }

        // Create Supabase User
        const { data: authData } = await createSchoolScopedAuthUser(supabaseAdmin, {
          schoolId,
          email: canonicalEmail,
          password,
          userMetadata: { person_id: person.id }
        });

        const supabaseUserId = authData.user.id;

        // Create Local User
        const [user] = await sql`
                    INSERT INTO users (id, school_id, person_id, account_status)
                    VALUES (${supabaseUserId}, ${schoolId}, ${person.id}, 'active')
                    RETURNING id
                `;

        // Assign Role (default to 'staff' if not provided)
        const userRole = resolveDbRoleCode(role_code) || 'staff';
        const [role] = await sql`SELECT id FROM roles WHERE code = ${userRole} AND school_id = ${schoolId}`;

        if (!role) {
          throw new Error(`Invalid role code: ${userRole}. No matching role found for this school.`);
        }

        await sql`
                        INSERT INTO user_roles (user_id, role_id, school_id, granted_by)
                        VALUES (${user.id}, ${role.id}, ${schoolId}, ${req.user?.internal_id || null})
                    `;
      }

      return staff;
    });

    return sendSuccess(res, req.schoolId, { message: 'Staff created successfully', staff: result }, 201);
  } catch (error) {
    console.error('Error creating staff:', error);
    if (sendSchoolEmailConflict(res, error)) return;
    if (error.message.includes('Supabase Auth Error')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to create staff: ' + (error.detail || error.message), details: error.message });
  }
}));

/**
 * PUT /staff/:id
 * Update staff member
 */
router.put('/:id', requirePermission('staff.edit'), asyncHandler(async (req, res) => {
  req.schoolId = String(req.user.schoolId);
  const { id } = req.params;
  const {
    first_name, middle_name, last_name, dob, gender_id,
    staff_code, joining_date, status_id, designation_id, salary,
    email, phone, password, role_code = null
  } = req.body;

  // Ownership check — also fetch the linked auth user_id and current email/phone
  const [staffCheck] = await sql`
    SELECT 
      st.person_id,
      u.id as user_id,
      (SELECT contact_value FROM person_contacts pc 
       WHERE pc.person_id = st.person_id AND pc.contact_type = 'email' AND pc.is_primary = true LIMIT 1) as current_email,
      (SELECT contact_value FROM person_contacts pc 
       WHERE pc.person_id = st.person_id AND pc.contact_type = 'phone' AND pc.is_primary = true LIMIT 1) as current_phone
    FROM staff st
    LEFT JOIN users u ON u.person_id = st.person_id
    WHERE st.id = ${id}
      AND st.deleted_at IS NULL
      AND st.school_id = ${req.schoolId}
  `;

  if (!staffCheck) {
    return res.status(404).json({ error: 'Staff not found' });
  }

  const personId = staffCheck.person_id;
  let authUserId = staffCheck.user_id;
  const canonicalEmail = email
    ? await assertSchoolEmailAvailable(sql, req.user.schoolId, email, personId)
    : null;

  const result = await sql.begin(async (sql) => {
    // 1. Update Person
    await sql`
      UPDATE persons
      SET 
        first_name = COALESCE(${first_name ?? null}, first_name),
        middle_name = COALESCE(${middle_name ?? null}, middle_name),
        last_name = COALESCE(${last_name ?? null}, last_name),
        dob = COALESCE(${dob ?? null}, dob),
        gender_id = COALESCE(${gender_id ?? null}, gender_id)
      WHERE id = ${personId}
        AND school_id = ${req.schoolId}
    `;

    // 2. Update Staff
    const [updatedStaff] = await sql`
      UPDATE staff
      SET 
        staff_code = COALESCE(${staff_code ?? null}, staff_code),
        joining_date = COALESCE(${joining_date ?? null}, joining_date),
        status_id = COALESCE(${status_id ?? null}, status_id),
        designation_id = COALESCE(${designation_id ?? null}, designation_id),
        salary = COALESCE(${salary ?? null}, salary)
      WHERE id = ${id}
        AND school_id = ${req.schoolId}
      RETURNING *
    `;

    // 3. Update Contacts (public table)
    if (canonicalEmail) {
      const [existing] = await sql`
        SELECT id FROM person_contacts 
        WHERE person_id = ${personId} AND contact_type = 'email' AND is_primary = true
      `;
      if (existing) {
        await sql`UPDATE person_contacts SET contact_value = ${canonicalEmail} WHERE id = ${existing.id} AND school_id = ${req.schoolId}`;
      } else {
        await sql`INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary) 
                  VALUES (${req.schoolId}, ${personId}, 'email', ${canonicalEmail}, true)`;
      }
    }

    if (phone) {
      const [existing] = await sql`
        SELECT id FROM person_contacts 
        WHERE person_id = ${personId} AND contact_type = 'phone' AND is_primary = true
      `;
      if (existing) {
        await sql`UPDATE person_contacts SET contact_value = ${phone} WHERE id = ${existing.id} AND school_id = ${req.schoolId}`;
      } else {
        await sql`INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary) 
                  VALUES (${req.schoolId}, ${personId}, 'phone', ${phone}, true)`;
      }
    }

    return updatedStaff;
  });

  // 4. Update Auth Credentials (Supabase auth.users via Admin API)
  let authUpdateResult = null;
  const emailForAuth = canonicalEmail || staffCheck.current_email;

  if (!authUserId && supabaseAdmin && password && password.length >= 6 && emailForAuth) {
    try {
      const userRole = resolveDbRoleCode(role_code) || 'staff';
      const { data: authUser } = await createSchoolScopedAuthUser(supabaseAdmin, {
        schoolId: req.user.schoolId,
        email: emailForAuth,
        password,
        userMetadata: { person_id: personId }
      });
      authUserId = authUser.user.id;

      const [existingLocalUser] = await sql`SELECT id FROM users WHERE id = ${authUserId}`;
      if (!existingLocalUser) {
        const [user] = await sql`
          INSERT INTO users (id, school_id, person_id, account_status)
          VALUES (${authUserId}, ${req.schoolId}, ${personId}, 'active')
          RETURNING id
        `;
        const [role] = await sql`SELECT id FROM roles WHERE code = ${userRole} AND school_id = ${req.schoolId}`;
        if (role) {
          await sql`
            INSERT INTO user_roles (user_id, role_id, school_id, granted_by)
            VALUES (${user.id}, ${role.id}, ${req.schoolId}, ${req.user?.internal_id || null})
            ON CONFLICT (user_id, role_id) DO NOTHING
          `;
        }
      }
      authUpdateResult = { created: true, updated: ['password', 'email'] };
    } catch (authCreateErr) {
      if (sendSchoolEmailConflict(res, authCreateErr)) return;
      return res.status(207).json({
        success: true,
        message: 'Profile updated but login account could not be created',
        staff: result,
        authError: authCreateErr.message || 'Failed to create login account'
      });
    }
  } else if (authUserId && supabaseAdmin) {
    const authUpdates = {};
    const updatedAuthFields = [];

    if (canonicalEmail && canonicalEmail !== staffCheck.current_email) {
      await updateSchoolScopedAuthEmail(supabaseAdmin, authUserId, {
        schoolId: req.user.schoolId,
        email: canonicalEmail
      });
      updatedAuthFields.push('email');
    }

    if (phone && phone !== staffCheck.current_phone) {
      authUpdates.phone = phone;
    }

    if (password && password.length >= 6) {
      authUpdates.password = password;
    }

    if (Object.keys(authUpdates).length > 0) {
      const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
        authUserId,
        authUpdates
      );

      if (authError) {
        return res.status(207).json({
          success: true,
          message: 'Profile updated but login credentials failed to update',
          staff: result,
          authError: authError.message
        });
      }
      updatedAuthFields.push(...Object.keys(authUpdates));
    }

    if (updatedAuthFields.length > 0) {
      authUpdateResult = { updated: updatedAuthFields };
    }
  } else if (password && password.length >= 6 && !emailForAuth) {
    return res.status(400).json({ error: 'Email is required to set or reset a staff password.' });
  }

  return sendSuccess(res, req.schoolId, { 
    message: 'Staff updated successfully', 
    staff: result,
    ...(authUpdateResult && { authUpdate: authUpdateResult })
  });
}));


/**
 * DELETE /staff/:id
 * Soft delete staff member
 */
router.delete('/:id', requirePermission('staff.delete'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [result] = await sql`
    UPDATE staff SET deleted_at = NOW() WHERE id = ${id} AND deleted_at IS NULL AND school_id = ${req.schoolId} RETURNING id
  `;

  if (!result) {
    return res.status(404).json({ error: 'Staff not found' });
  }

  return sendSuccess(res, req.schoolId, { message: 'Staff deleted successfully' });
}));

// ============== SUB-ROUTES ==============

/**
 * GET /staff/:id/classes
 * Get classes assigned to staff (placeholder - needs class_teachers table)
 */
router.get('/:id/classes', requirePermission('staff.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Placeholder - would need class_teachers junction table
  return sendSuccess(res, req.schoolId, {
    staff_id: id,
    message: 'Class assignment feature requires class_teachers table',
    classes: []
  });
}));

/**
 * GET /staff/:id/timetable
 * Get staff timetable (placeholder - needs timetable tables)
 */
router.get('/:id/timetable', requirePermission('staff.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Placeholder - will be implemented in Phase 3
  return sendSuccess(res, req.schoolId, {
    staff_id: id,
    message: 'Timetable will be implemented in Phase 3',
    schedule: []
  });
}));

/**
 * GET /staff/:id/payslips
 * Get ALL staff payslips (list)
 */
router.get('/:id/payslips', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;

  // 1. Check permissions (Own Data OR Has Permission)
  const [targetStaff] = await sql`SELECT person_id FROM staff WHERE id = ${id} AND school_id = ${req.schoolId}`;

  if (!targetStaff) {
    return res.status(404).json({ error: 'Staff not found' });
  }

  // Own payslips (self) OR management payslip.view. Accounts/staff.view is NOT
  // sufficient — payslips are management-only (RBAC epic #3). Admin bypasses.
  const isSelf = req.user.person_id === targetStaff.person_id;
  const hasPermission = req.user.roles?.includes('admin') || req.user.permissions?.includes('payslip.view');

  if (!isSelf && !hasPermission) {
    return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
  }

  if (isSelf && !(await getStaffPayslipsEnabled(req.schoolId)) && !canBypassStaffPayslipsGate(req)) {
    return res.status(403).json({
      error: 'Payslips are disabled for the staff portal',
      code: 'PAYSLIPS_DISABLED',
    });
  }

  // Staff viewing own list: only after accounts disburses (paid). Admins viewing another member: include pending.
  const payslips = await fetchPayslipsForStaffId(id, req.schoolId, { disbursedOnly: isSelf });
  return sendSuccess(res, req.schoolId, formatStaffPayslipRows(payslips));
}));

/**
 * GET /staff/:id/payslip
 * Get staff payslip (placeholder - needs payroll tables)
 */
router.get('/:id/payslip', requirePermission('payslip.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { month, year } = req.query;

  const targetDate = new Date();
  const targetMonth = month ? parseInt(month) : targetDate.getMonth() + 1;
  const targetYear = year ? parseInt(year) : targetDate.getFullYear();

  // Ensure payroll exists/is up-to-date
  // effectively "lazy load" the payroll calculation if it's missing or outdated
  // (Though triggers handle updates, this ensures existence if never calculated)
  await sql`SELECT recalculate_staff_payroll(${id}, ${targetMonth}, ${targetYear})`;

  const [payroll] = await sql`
        SELECT 
            sp.*,
            st.staff_code,
            p.display_name as staff_name,
            sd.name as designation
        FROM staff_payroll sp
        JOIN staff st ON sp.staff_id = st.id AND st.school_id = ${req.schoolId}
        JOIN persons p ON st.person_id = p.id
        LEFT JOIN staff_designations sd ON st.designation_id = sd.id
        WHERE sp.staff_id = ${id}
        AND sp.payroll_month = ${targetMonth}
        AND sp.payroll_year = ${targetYear}
    `;

  if (!payroll) {
    return res.status(404).json({ error: 'Payroll record not found' });
  }

  return sendSuccess(res, req.schoolId, payroll);
}));

export default router;
