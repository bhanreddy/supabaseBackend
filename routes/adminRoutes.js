import express from 'express';
import sql from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { ACCOUNTS_STAT_KEYS, resolveAccountsDashboardConfig } from '../utils/constants.js';
import { activeStructureFilter, getSchoolFeeMode } from '../services/feeModeService.js';

const router = express.Router();

let accountsStaffCreationColumnReady = false;

async function ensureAccountsStaffCreationColumn() {
    if (accountsStaffCreationColumnReady) return;

    await sql`
        ALTER TABLE schools
        ADD COLUMN IF NOT EXISTS accounts_staff_creation_enabled BOOLEAN NOT NULL DEFAULT true
    `;
    accountsStaffCreationColumnReady = true;
}

let partialFeePaymentColumnReady = false;

async function ensurePartialFeePaymentColumn() {
    if (partialFeePaymentColumnReady) return;

    await sql`
        ALTER TABLE schools
        ADD COLUMN IF NOT EXISTS partial_fee_payment_enabled BOOLEAN NOT NULL DEFAULT true
    `;
    partialFeePaymentColumnReady = true;
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

let accountAccessOverrideColumnsReady = false;

// Standing "Always allow access" override columns on users. Idempotent guard so
// the endpoints work even if the migration has not yet been applied on a deploy.
async function ensureAccountAccessOverrideColumns() {
    if (accountAccessOverrideColumnsReady) return;

    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS unrestricted_access BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS unrestricted_access_granted_by UUID REFERENCES users(id) ON DELETE SET NULL`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS unrestricted_access_granted_at TIMESTAMPTZ`;
    accountAccessOverrideColumnsReady = true;
}

/**
 * GET /admin/dashboard-stats
 * Get aggregated statistics for the admin dashboard
 * AR1: fee_transactions scoped via student_fees.school_id join
 */
router.get('/dashboard-stats', requireAuth, asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;

    const [
        [studentCount],
        [totalStaff],
        [staffPresentQuery],
        [complaintCount],
        [todayCollection],
        [totalCollection],
        [todayDiaryCount],
    ] = await Promise.all([
        sql`
        SELECT COUNT(*)::int as count FROM students WHERE deleted_at IS NULL AND school_id = ${schoolId}
    `,
        sql`
        SELECT COUNT(*)::int as count FROM staff WHERE status_id = 1 AND deleted_at IS NULL AND school_id = ${schoolId}
    `,
        sql`
        SELECT COUNT(*)::int as count FROM staff_attendance sa
        JOIN staff st ON sa.staff_id = st.id
        WHERE sa.attendance_date = CURRENT_DATE
          AND sa.status = 'present'
          AND sa.deleted_at IS NULL
          AND st.school_id = ${schoolId}
    `,
        sql`
        SELECT COUNT(*)::int as count FROM complaints WHERE status = 'open' AND school_id = ${schoolId}
    `,
        sql`
        SELECT COALESCE(SUM(ft.amount), 0) as total
        FROM fee_transactions ft
        JOIN student_fees sf ON ft.student_fee_id = sf.id
        WHERE ft.paid_at::DATE = CURRENT_DATE
          AND sf.school_id = ${schoolId}
    `,
        sql`
        SELECT COALESCE(SUM(ft.amount), 0) as total
        FROM fee_transactions ft
        JOIN student_fees sf ON ft.student_fee_id = sf.id
        WHERE sf.school_id = ${schoolId}
    `,
        sql`
        SELECT COUNT(*)::int as count 
        FROM diary_entries 
        WHERE school_id = ${schoolId} 
          AND entry_date = CURRENT_DATE 
          AND deleted_at IS NULL
    `,
    ]);

    const activeStaffCount = parseInt(totalStaff.count) || 0;
    const staffPresent = parseInt(staffPresentQuery.count) || 0;

    return sendSuccess(res, req.schoolId, {
        totalStudents: parseInt(studentCount.count),
        staffPresent: staffPresent,
        totalStaff: activeStaffCount,
        complaints: parseInt(complaintCount.count),
        collection: parseFloat(totalCollection?.total || 0),
        todayCollection: parseFloat(todayCollection?.total || 0),
        diaryEntriesToday: parseInt(todayDiaryCount?.count || 0)
    });
}));

/**
 * GET /admin/diary/today
 * Get today's diary entries for admin viewing
 */
router.get('/diary/today', requireAuth, asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { class_id, section_id } = req.query;

    let query = sql`
        SELECT 
            de.id,
            de.entry_date,
            de.content,
            de.created_at,
            s.name as subject_name,
            creator.display_name as teacher_name
        FROM diary_entries de
        LEFT JOIN subjects s ON de.subject_id = s.id
        LEFT JOIN users u ON de.created_by = u.id
        LEFT JOIN persons creator ON u.person_id = creator.id
        WHERE de.school_id = ${schoolId}
          AND de.entry_date = CURRENT_DATE
          AND de.deleted_at IS NULL
    `;

    if (class_id && section_id) {
        query = sql`${query} AND de.class_section_id = (
            SELECT id FROM class_sections 
            WHERE class_id = ${class_id} AND section_id = ${section_id} AND school_id = ${schoolId} LIMIT 1
        )`;
    }

    const entries = await query;
    return sendSuccess(res, schoolId, entries);
}));

/**
 * GET /admin/diary/history
 * Get diary entries for a specific date
 */
router.get('/diary/history', requireAuth, asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { class_id, section_id, date } = req.query;

    if (!date) {
        return res.status(400).json({ success: false, message: 'Date is required' });
    }

    let query = sql`
        SELECT 
            de.id,
            de.entry_date,
            de.content,
            de.created_at,
            s.name as subject_name,
            creator.display_name as teacher_name
        FROM diary_entries de
        LEFT JOIN subjects s ON de.subject_id = s.id
        LEFT JOIN users u ON de.created_by = u.id
        LEFT JOIN persons creator ON u.person_id = creator.id
        WHERE de.school_id = ${schoolId}
          AND de.entry_date = ${date}
          AND de.deleted_at IS NULL
    `;

    if (class_id && section_id) {
        query = sql`${query} AND de.class_section_id = (
            SELECT id FROM class_sections 
            WHERE class_id = ${class_id} AND section_id = ${section_id} AND school_id = ${schoolId} LIMIT 1
        )`;
    }

    const entries = await query;
    return sendSuccess(res, schoolId, entries);
}));

/**
 * GET /admin/accounts-dashboard-config
 * Read school configuration for accounts dashboard visibility
 */
router.get('/accounts-dashboard-config', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
    const rows = await sql`
        SELECT accounts_dashboard_config
        FROM schools
        WHERE id = ${req.schoolId}
    `;
    const config = resolveAccountsDashboardConfig(rows[0]?.accounts_dashboard_config);
    return sendSuccess(res, req.schoolId, { config });
}));

/**
 * PUT /admin/accounts-dashboard-config
 * Save school configuration for accounts dashboard visibility
 */
router.put('/accounts-dashboard-config', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
    const { config } = req.body;
    if (!config || typeof config !== 'object') {
        return res.status(400).json({ error: 'config object is required in request body' });
    }

    // Validate every key and value
    for (const [key, val] of Object.entries(config)) {
        if (!ACCOUNTS_STAT_KEYS.includes(key)) {
            return res.status(400).json({ error: `Invalid configuration key: ${key}` });
        }
        if (typeof val !== 'boolean') {
            return res.status(400).json({ error: `Value for key ${key} must be a boolean` });
        }
    }

    const normalized = resolveAccountsDashboardConfig(config);

    await sql`
        UPDATE schools
        SET accounts_dashboard_config = ${sql.json(normalized)}
        WHERE id = ${req.schoolId}
    `;

    return sendSuccess(res, req.schoolId, { config: normalized });
}));

/**
 * GET /admin/payroll-distribution
 * Read whether accounts team payroll processing is blocked
 */
router.get('/payroll-distribution', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    const [row] = await sql`
        SELECT payroll_distribution_blocked
        FROM schools
        WHERE id = ${req.schoolId}
    `;
    return sendSuccess(res, req.schoolId, {
        blocked: Boolean(row?.payroll_distribution_blocked),
    });
}));

/**
 * PUT /admin/payroll-distribution
 * Block or unblock payroll distribution for the accounts department
 */
router.put('/payroll-distribution', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    const { blocked } = req.body;
    if (typeof blocked !== 'boolean') {
        return res.status(400).json({ error: 'blocked boolean is required in request body' });
    }

    await sql`
        UPDATE schools
        SET payroll_distribution_blocked = ${blocked}
        WHERE id = ${req.schoolId}
    `;

    return sendSuccess(res, req.schoolId, {
        blocked,
        message: blocked
            ? 'Payroll distribution blocked for accounts'
            : 'Payroll distribution enabled for accounts',
    });
}));

/**
 * GET /admin/staff-payslips
 * Read whether staff portal users can view their payslips.
 */
router.get('/staff-payslips', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    await ensureStaffPayslipsColumn();

    const [row] = await sql`
        SELECT staff_payslips_enabled
        FROM schools
        WHERE id = ${req.schoolId}
    `;
    return sendSuccess(res, req.schoolId, {
        enabled: row?.staff_payslips_enabled !== false,
    });
}));

/**
 * PUT /admin/staff-payslips
 * Enable or disable payslip access in the staff portal.
 */
router.put('/staff-payslips', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled boolean is required in request body' });
    }

    await ensureStaffPayslipsColumn();

    await sql`
        UPDATE schools
        SET staff_payslips_enabled = ${enabled}
        WHERE id = ${req.schoolId}
    `;

    return sendSuccess(res, req.schoolId, {
        enabled,
        message: enabled
            ? 'Staff portal payslips enabled'
            : 'Staff portal payslips hidden',
    });
}));

/**
 * GET /admin/accounts-staff-creation
 * Read whether accounts users may create staff/admin/driver accounts.
 */
router.get('/accounts-staff-creation', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    await ensureAccountsStaffCreationColumn();

    const [row] = await sql`
        SELECT accounts_staff_creation_enabled
        FROM schools
        WHERE id = ${req.schoolId}
    `;
    return sendSuccess(res, req.schoolId, {
        enabled: row?.accounts_staff_creation_enabled !== false,
    });
}));

/**
 * PUT /admin/accounts-staff-creation
 * Enable or disable direct staff/admin/driver creation for accounts users.
 */
router.put('/accounts-staff-creation', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled boolean is required in request body' });
    }

    await ensureAccountsStaffCreationColumn();

    await sql`
        UPDATE schools
        SET accounts_staff_creation_enabled = ${enabled}
        WHERE id = ${req.schoolId}
    `;

    return sendSuccess(res, req.schoolId, {
        enabled,
        message: enabled
            ? 'Accounts staff creation enabled'
            : 'Accounts staff creation disabled',
    });
}));

/**
 * GET /admin/partial-fee-payment
 * Read whether partial term-fee collection is enabled for this school.
 */
router.get('/partial-fee-payment', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    await ensurePartialFeePaymentColumn();

    const [row] = await sql`
        SELECT partial_fee_payment_enabled
        FROM schools
        WHERE id = ${req.schoolId}
    `;
    return sendSuccess(res, req.schoolId, {
        enabled: row?.partial_fee_payment_enabled === true,
    });
}));

/**
 * PUT /admin/partial-fee-payment
 * Enable or disable partial term-fee collection school-wide.
 * When disabled, collectors must post the full remaining balance.
 */
router.put('/partial-fee-payment', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled boolean is required in request body' });
    }

    await ensurePartialFeePaymentColumn();

    await sql`
        UPDATE schools
        SET partial_fee_payment_enabled = ${enabled}
        WHERE id = ${req.schoolId}
    `;

    return sendSuccess(res, req.schoolId, {
        enabled,
        message: enabled
            ? 'Partial fee collection enabled for this school'
            : 'Partial fee collection disabled — full balance required',
    });
}));

/**
 * GET /admin/accounts-portal-staff
 * List staff with accounts portal access status for admin toggles.
 */
router.get('/accounts-portal-staff', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;

    const rows = await sql`
        SELECT
            st.id AS staff_id,
            p.first_name,
            p.last_name,
            p.display_name,
            st.staff_code,
            sd.name AS designation,
            u.id AS user_id,
            (
                SELECT pc.contact_value
                FROM person_contacts pc
                WHERE pc.person_id = p.id
                  AND pc.contact_type = 'email'
                  AND pc.is_primary = true
                  AND pc.deleted_at IS NULL
                LIMIT 1
            ) AS email,
            (u.id IS NOT NULL) AS has_login,
            EXISTS (
                SELECT 1
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = u.id
                  AND ur.school_id = ${schoolId}
                  AND ur.deleted_at IS NULL
                  AND r.code = 'accounts'
            ) AS has_accounts_access,
            EXISTS (
                SELECT 1
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = u.id
                  AND ur.school_id = ${schoolId}
                  AND ur.deleted_at IS NULL
                  AND r.code IN ('admin', 'principal')
            ) AS is_elevated
        FROM staff st
        JOIN persons p ON st.person_id = p.id
        LEFT JOIN staff_designations sd ON st.designation_id = sd.id
        LEFT JOIN users u ON u.person_id = p.id
            AND u.school_id = st.school_id
            AND u.deleted_at IS NULL
        WHERE st.school_id = ${schoolId}
          AND st.deleted_at IS NULL
        ORDER BY p.display_name
    `;

    return sendSuccess(res, schoolId, { staff: rows });
}));

/**
 * PUT /admin/accounts-portal-staff/:staffId
 * Grant or revoke accounts portal access for an existing staff member.
 */
router.put('/accounts-portal-staff/:staffId', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { staffId } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled boolean is required in request body' });
    }

    const [staffRow] = await sql`
        SELECT
            st.id,
            u.id AS user_id,
            EXISTS (
                SELECT 1
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = u.id
                  AND ur.school_id = ${schoolId}
                  AND ur.deleted_at IS NULL
                  AND r.code IN ('admin', 'principal')
            ) AS is_elevated
        FROM staff st
        LEFT JOIN users u ON u.person_id = st.person_id
            AND u.school_id = st.school_id
            AND u.deleted_at IS NULL
        WHERE st.id = ${staffId}
          AND st.school_id = ${schoolId}
          AND st.deleted_at IS NULL
        LIMIT 1
    `;

    if (!staffRow) {
        return res.status(404).json({ error: 'Staff not found' });
    }

    if (staffRow.is_elevated) {
        return res.status(400).json({ error: 'Admin and principal accounts already have accounts portal access' });
    }

    if (!staffRow.user_id) {
        return res.status(400).json({
            error: 'Staff member does not have login credentials. Create an accounts staff account first.',
        });
    }

    const [accountsRole] = await sql`
        SELECT id FROM roles WHERE code = 'accounts' AND school_id = ${schoolId}
    `;
    const [staffRole] = await sql`
        SELECT id FROM roles WHERE code = 'staff' AND school_id = ${schoolId}
    `;

    if (!accountsRole || !staffRole) {
        return res.status(500).json({ error: 'Required roles are not configured for this school' });
    }

    if (enabled) {
        await sql.begin(async (tx) => {
            await tx`
                DELETE FROM user_roles
                WHERE user_id = ${staffRow.user_id}
                  AND school_id = ${schoolId}
                  AND role_id IN (
                    SELECT id FROM roles
                    WHERE school_id = ${schoolId}
                      AND code NOT IN ('admin', 'principal')
                  )
            `;
            await tx`
                INSERT INTO user_roles (user_id, role_id, school_id, granted_by)
                VALUES (${staffRow.user_id}, ${accountsRole.id}, ${schoolId}, ${req.user?.internal_id || null})
                ON CONFLICT (user_id, role_id) DO UPDATE SET deleted_at = NULL
            `;
        });
    } else {
        await sql.begin(async (tx) => {
            await tx`
                DELETE FROM user_roles
                WHERE user_id = ${staffRow.user_id}
                  AND school_id = ${schoolId}
                  AND role_id = ${accountsRole.id}
            `;

            const remaining = await tx`
                SELECT 1
                FROM user_roles ur
                WHERE ur.user_id = ${staffRow.user_id}
                  AND ur.school_id = ${schoolId}
                  AND ur.deleted_at IS NULL
                LIMIT 1
            `;

            if (remaining.length === 0) {
                await tx`
                    INSERT INTO user_roles (user_id, role_id, school_id, granted_by)
                    VALUES (${staffRow.user_id}, ${staffRole.id}, ${schoolId}, ${req.user?.internal_id || null})
                    ON CONFLICT (user_id, role_id) DO UPDATE SET deleted_at = NULL
                `;
            }
        });
    }

    return sendSuccess(res, schoolId, {
        staff_id: staffId,
        has_accounts_access: enabled,
        message: enabled
            ? 'Accounts portal access granted'
            : 'Accounts portal access removed',
    });
}));

/**
 * GET /admin/account-access
 * List this school's accounts-role users with their standing "Always allow
 * access" override status. Feeds the toggle UI on the access-requests page.
 *
 * This is a SIBLING to the access_requests listing (which the client reads
 * straight from Supabase): the override lives on `users`, not on a request row,
 * and is a distinct concept from the one-time/expiring temp_access_grants flow.
 */
router.get('/account-access', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    await ensureAccountAccessOverrideColumns();

    const rows = await sql`
        SELECT
            u.id AS user_id,
            p.display_name,
            u.unrestricted_access AS enabled,
            u.unrestricted_access_granted_at AS granted_at,
            u.unrestricted_access_granted_by AS granted_by,
            gp.display_name AS granted_by_name,
            (
                SELECT pc.contact_value
                FROM person_contacts pc
                WHERE pc.person_id = p.id
                  AND pc.contact_type = 'email'
                  AND pc.is_primary = true
                  AND pc.deleted_at IS NULL
                LIMIT 1
            ) AS email
        FROM users u
        JOIN persons p ON u.person_id = p.id
        JOIN user_roles ur ON ur.user_id = u.id
            AND ur.school_id = ${schoolId}
            AND ur.deleted_at IS NULL
        JOIN roles r ON r.id = ur.role_id
            AND r.school_id = ${schoolId}
            AND r.code = 'accounts'
        LEFT JOIN users gu ON gu.id = u.unrestricted_access_granted_by
        LEFT JOIN persons gp ON gu.person_id = gp.id
        WHERE u.school_id = ${schoolId}
          AND u.deleted_at IS NULL
        ORDER BY p.display_name
    `;

    return sendSuccess(res, schoolId, { accountants: rows });
}));

/**
 * PATCH /admin/account-access/:userId
 * Turn the standing "Always allow access" override ON or OFF for one accountant.
 *
 * Guards:
 *  - Caller must be admin/principal (requireRole, JWT-derived).
 *  - Target user must belong to the caller's school (IDOR guard).
 *  - Target user must hold the 'accounts' role.
 */
router.patch('/account-access/:userId', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const callerId = req.user.internal_id;
    const { userId } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled boolean is required in request body' });
    }

    await ensureAccountAccessOverrideColumns();

    // Target must be a same-school accounts-role user. Both conditions are
    // checked in one query so a cross-school or wrong-role id resolves to 404/400
    // without leaking which guard failed.
    const [target] = await sql`
        SELECT
            u.id,
            p.display_name,
            EXISTS (
                SELECT 1
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = u.id
                  AND ur.school_id = ${schoolId}
                  AND ur.deleted_at IS NULL
                  AND r.code = 'accounts'
            ) AS is_accounts
        FROM users u
        JOIN persons p ON u.person_id = p.id
        WHERE u.id = ${userId}
          AND u.school_id = ${schoolId}
          AND u.deleted_at IS NULL
        LIMIT 1
    `;

    if (!target) {
        return res.status(404).json({ error: 'User not found' });
    }
    if (!target.is_accounts) {
        return res.status(400).json({ error: 'Standing access override only applies to accounts-role users' });
    }

    const [updated] = await sql`
        UPDATE users
        SET unrestricted_access = ${enabled},
            unrestricted_access_granted_by = ${enabled ? callerId : null},
            unrestricted_access_granted_at = ${enabled ? sql`NOW()` : null}
        WHERE id = ${userId}
          AND school_id = ${schoolId}
        RETURNING unrestricted_access AS enabled, unrestricted_access_granted_at AS granted_at
    `;

    // Explicit audit trail of every flip (the auditLogger middleware also records
    // this PATCH, but we log a typed entry for easy querying).
    try {
        await sql`
            INSERT INTO audit_logs (user_id, action, entity, entity_id, details, ip_address, user_agent, school_id)
            VALUES (
                ${callerId},
                ${enabled ? 'ACCOUNT_ACCESS_OVERRIDE_ENABLED' : 'ACCOUNT_ACCESS_OVERRIDE_DISABLED'},
                'users',
                ${userId},
                ${sql.json({ target_user: userId, enabled })},
                ${req.ip},
                ${req.headers['user-agent'] || null},
                ${schoolId}
            )
        `;
    } catch (auditErr) {
        // Audit failure must not break the toggle.
    }

    return sendSuccess(res, schoolId, {
        user_id: userId,
        enabled: updated.enabled,
        granted_at: updated.granted_at,
        message: enabled
            ? 'Standing access enabled — this accountant can now sign in anytime'
            : 'Standing access disabled — normal school-hours restriction applies',
    });
}));

/**
 * GET /admin/finance-stats
 * Full finance summary for the admin Finance & Collection screen.
 * Never gated by accounts_dashboard_config visibility toggles.
 */
router.get('/finance-stats', requirePermission('fees.view'), asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const feeMode = await getSchoolFeeMode(schoolId);
    const structureModeFilter = activeStructureFilter(feeMode);

    const [
        [todayCollection],
        [monthlyCollection],
        [totalCollected],
        [pendingDues],
        [defaulterCount],
        recentTransactions,
    ] = await Promise.all([
        sql`
            SELECT COALESCE(SUM(ft.amount), 0) as total
            FROM fee_transactions ft
            JOIN student_fees sf ON ft.student_fee_id = sf.id
            WHERE ft.paid_at::DATE = CURRENT_DATE
              AND sf.school_id = ${schoolId}
        `,
        sql`
            SELECT COALESCE(SUM(ft.amount), 0) as total
            FROM fee_transactions ft
            JOIN student_fees sf ON ft.student_fee_id = sf.id
            WHERE date_trunc('month', ft.paid_at) = date_trunc('month', CURRENT_DATE)
              AND sf.school_id = ${schoolId}
        `,
        sql`
            SELECT COALESCE(SUM(ft.amount), 0) as total
            FROM fee_transactions ft
            JOIN student_fees sf ON ft.student_fee_id = sf.id
            WHERE sf.school_id = ${schoolId}
        `,
        sql`
            SELECT COALESCE(SUM(sf.amount_due - sf.amount_paid - sf.discount), 0) as total
            FROM student_fees sf
            JOIN fee_structures fs ON sf.fee_structure_id = fs.id
            WHERE sf.status IN ('pending', 'partial', 'overdue')
              AND sf.deleted_at IS NULL
              AND fs.deleted_at IS NULL
              AND sf.school_id = ${schoolId}
              ${structureModeFilter}
        `,
        sql`
            SELECT COUNT(DISTINCT sf.student_id)::int as count
            FROM student_fees sf
            JOIN fee_structures fs ON sf.fee_structure_id = fs.id
            WHERE sf.status IN ('pending', 'partial', 'overdue')
              AND sf.due_date < CURRENT_DATE
              AND sf.deleted_at IS NULL
              AND fs.deleted_at IS NULL
              AND sf.school_id = ${schoolId}
              ${structureModeFilter}
        `,
        sql`
            SELECT
                t.id, t.amount, t.payment_method, t.transaction_ref, t.paid_at, t.remarks,
                p.display_name as student_name
            FROM fee_transactions t
            JOIN student_fees sf ON t.student_fee_id = sf.id
            JOIN students s ON sf.student_id = s.id
            JOIN persons p ON s.person_id = p.id
            WHERE s.school_id = ${schoolId}
            ORDER BY t.paid_at DESC
            LIMIT 10
        `,
    ]);

    return sendSuccess(res, schoolId, {
        today_collection: parseFloat(todayCollection?.total || 0),
        monthly_collection: parseFloat(monthlyCollection?.total || 0),
        collected_total: parseFloat(totalCollected?.total || 0),
        pending_dues: parseFloat(pendingDues?.total || 0),
        defaulter_count: parseInt(defaulterCount?.count || 0, 10),
        recent_transactions: recentTransactions || [],
    });
}));

export default router;