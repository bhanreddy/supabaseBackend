import express from 'express';
import XLSX from 'xlsx';
import sql from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { ACCOUNTS_STAT_KEYS, resolveAccountsDashboardConfig } from '../utils/constants.js';
import { activeStructureFilter, getSchoolFeeMode } from '../services/feeModeService.js';
import { getTranslationStats, probeTranslation } from '../services/geminiTranslator.js';

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

let partialFeeDirectCollectColumnReady = false;

async function ensurePartialFeeDirectCollectColumn() {
    if (partialFeeDirectCollectColumnReady) return;

    await sql`
        ALTER TABLE schools
        ADD COLUMN IF NOT EXISTS partial_fee_direct_collect_enabled BOOLEAN NOT NULL DEFAULT false
    `;
    partialFeeDirectCollectColumnReady = true;
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
 * Resolve the academic year used by the due-list report. The school setting is
 * authoritative; the most recent year is only a safe fallback for older data.
 */
async function resolveDueListAcademicYear(schoolId, requestedYearId) {
    if (requestedYearId) {
        const [year] = await sql`
            SELECT id, code
            FROM academic_years
            WHERE id = ${requestedYearId}
              AND school_id = ${schoolId}
              AND deleted_at IS NULL
            LIMIT 1
        `;
        return year || null;
    }

    const [year] = await sql`
        SELECT ay.id, ay.code
        FROM academic_years ay
        LEFT JOIN school_settings ss
          ON ss.school_id = ay.school_id
         AND ss.key = 'active_academic_year_id'
         AND ss.value = ay.id::text
        WHERE ay.school_id = ${schoolId}
          AND ay.deleted_at IS NULL
        ORDER BY CASE WHEN ss.value IS NOT NULL THEN 0 ELSE 1 END, ay.start_date DESC
        LIMIT 1
    `;
    return year || null;
}

function money(value) {
    return Number(value || 0);
}

function buildDueListWorkbook({ schoolName, academicYear, rows, filters }) {
    const generatedAt = new Date().toLocaleString('en-IN');
    const totals = rows.reduce((acc, row) => ({
        schoolTotal: acc.schoolTotal + money(row.school_total_fee),
        discount: acc.discount + money(row.discount_given),
        finalFee: acc.finalFee + money(row.final_fee),
        paid: acc.paid + money(row.paid_fee),
        due: acc.due + money(row.due_amount),
    }), { schoolTotal: 0, discount: 0, finalFee: 0, paid: 0, due: 0 });

    const filtersText = [
        filters.class_name ? `Class: ${filters.class_name}` : null,
        filters.section_name ? `Section: ${filters.section_name}` : null,
        filters.village_name ? `Village: ${filters.village_name}` : null,
        filters.overdue_only ? 'Only overdue dues' : null,
    ].filter(Boolean).join(' | ') || 'All pending fees';

    const sheetRows = [
        [`${schoolName || 'School'} — Pending Fees Due List`],
        ['Academic Year', academicYear],
        ['Filters', filtersText],
        ['Generated', generatedAt],
        [],
        ['Students', rows.length, 'School Total Fee', totals.schoolTotal, 'Discount Given', totals.discount, 'Final Fee', totals.finalFee, 'Paid Fee', totals.paid, 'Due Amount', totals.due],
        [],
        ['S.No.', 'Admission No.', 'Student Name', 'Class', 'Section', 'Roll No.', 'Village / Stop', 'Route', 'School Total Fee', 'Discount Given', 'Final Fee', 'Paid Fee', 'Due Amount', 'Fee Items', 'Earliest Due Date', 'Overdue'],
        ...rows.map((row, index) => [
            index + 1,
            row.admission_no || '',
            row.student_name || '',
            row.class_name || '',
            row.section_name || '',
            row.roll_number ?? '',
            row.village || 'Not assigned',
            row.route_name || '',
            money(row.school_total_fee),
            money(row.discount_given),
            money(row.final_fee),
            money(row.paid_fee),
            money(row.due_amount),
            Number(row.fee_item_count || 0),
            row.earliest_due_date || '',
            row.is_overdue ? 'Yes' : 'No',
        ]),
        [],
        ['TOTAL', '', '', '', '', '', '', '', totals.schoolTotal, totals.discount, totals.finalFee, totals.paid, totals.due],
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(sheetRows);
    worksheet['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 15 } },
    ];
    worksheet['!cols'] = [
        { wch: 8 }, { wch: 16 }, { wch: 28 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 22 }, { wch: 20 },
        { wch: 17 }, { wch: 17 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 10 }, { wch: 17 }, { wch: 10 },
    ];
    worksheet['!autofilter'] = { ref: `A8:P${Math.max(8, rows.length + 8)}` };
    worksheet['!freeze'] = { xSplit: 0, ySplit: 8 };

    const headerStyle = {
        fill: { fgColor: { rgb: '5B21B6' } },
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    };
    const summaryLabelStyle = { font: { bold: true, color: { rgb: '4C1D95' } }, fill: { fgColor: { rgb: 'EDE9FE' } } };
    const currencyFormat = '₹#,##0.00';

    for (let col = 0; col < 16; col += 1) {
        const cell = XLSX.utils.encode_cell({ r: 7, c: col });
        if (worksheet[cell]) worksheet[cell].s = headerStyle;
    }
    for (const cell of ['A1', 'A6', 'C6', 'E6', 'G6', 'I6', 'K6']) {
        if (worksheet[cell]) worksheet[cell].s = summaryLabelStyle;
    }
    for (const cell of ['D6', 'F6', 'H6', 'J6', 'L6']) {
        if (worksheet[cell]) worksheet[cell].z = currencyFormat;
    }
    for (let row = 8; row <= rows.length + 8; row += 1) {
        for (const col of [8, 9, 10, 11, 12]) {
            const cell = XLSX.utils.encode_cell({ r: row, c: col });
            if (worksheet[cell]) worksheet[cell].z = currencyFormat;
        }
    }
    const totalRow = rows.length + 9;
    for (let col = 0; col < 16; col += 1) {
        const cell = XLSX.utils.encode_cell({ r: totalRow, c: col });
        if (worksheet[cell]) worksheet[cell].s = { font: { bold: true }, fill: { fgColor: { rgb: 'FEF3C7' } } };
    }
    for (const col of [8, 9, 10, 11, 12]) {
        const cell = XLSX.utils.encode_cell({ r: totalRow, c: col });
        if (worksheet[cell]) worksheet[cell].z = currencyFormat;
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Pending Fees');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
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
 * GET /admin/diary/options
 * Return the current academic year's class-sections and the subjects actually
 * assigned to each mapping. Admin diary writes use class_section_id directly;
 * accepting unrelated class + section ids would create ambiguous targets.
 */
router.get('/diary/options', requirePermission('diary.manage'), asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;

    const options = await sql`
        WITH chosen_year AS (
            SELECT ay.id
            FROM academic_years ay
            WHERE ay.school_id = ${schoolId}
            ORDER BY
                CASE WHEN CURRENT_DATE BETWEEN ay.start_date AND ay.end_date THEN 0 ELSE 1 END,
                ay.start_date DESC
            LIMIT 1
        )
        SELECT
            cs.id AS class_section_id,
            c.id AS class_id,
            c.name AS class_name,
            c.sort_order AS class_sort_order,
            sec.id AS section_id,
            sec.name AS section_name,
            ay.id AS academic_year_id,
            ay.code AS academic_year,
            COALESCE(subject_rows.subjects, '[]'::jsonb) AS subjects
        FROM class_sections cs
        JOIN chosen_year cy ON cy.id = cs.academic_year_id
        JOIN academic_years ay ON ay.id = cs.academic_year_id AND ay.school_id = ${schoolId}
        JOIN classes c ON c.id = cs.class_id AND c.school_id = ${schoolId}
        JOIN sections sec ON sec.id = cs.section_id AND sec.school_id = ${schoolId}
        LEFT JOIN LATERAL (
            SELECT jsonb_agg(
                jsonb_build_object('id', assigned.id, 'name', assigned.name, 'name_te', assigned.name_te)
                ORDER BY assigned.name
            ) AS subjects
            FROM (
                SELECT DISTINCT s.id, s.name, s.name_te
                FROM subjects s
                WHERE s.school_id = ${schoolId}
                  AND (
                    EXISTS (
                        SELECT 1
                        FROM class_subjects csub
                        WHERE csub.class_section_id = cs.id
                          AND csub.subject_id = s.id
                          AND csub.school_id = ${schoolId}
                          AND csub.deleted_at IS NULL
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM timetable_slots ts
                        WHERE ts.class_section_id = cs.id
                          AND ts.subject_id = s.id
                          AND ts.school_id = ${schoolId}
                          AND ts.deleted_at IS NULL
                    )
                  )
            ) assigned
        ) subject_rows ON true
        WHERE cs.school_id = ${schoolId}
          AND cs.deleted_at IS NULL
          AND c.deleted_at IS NULL
        ORDER BY c.sort_order NULLS LAST, c.name, sec.name
    `;

    return sendSuccess(res, schoolId, options);
}));

/**
 * GET /admin/diary/today
 * Get today's diary entries for admin viewing
 */
router.get('/diary/today', requirePermission('diary.manage'), asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { class_section_id, class_id, section_id, subject_id } = req.query;

    let query = sql`
        SELECT 
            de.id,
            de.class_section_id,
            de.entry_date,
            de.subject_id,
            de.title,
            de.title_te,
            de.content,
            de.content_te,
            de.homework_due_date,
            de.attachments,
            de.created_by,
            de.created_at,
            de.updated_at,
            c.id AS class_id,
            c.name AS class_name,
            sec.id AS section_id,
            sec.name AS section_name,
            s.name as subject_name,
            creator.display_name as teacher_name
        FROM diary_entries de
        JOIN class_sections cs ON de.class_section_id = cs.id AND cs.school_id = ${schoolId}
        JOIN classes c ON cs.class_id = c.id AND c.school_id = ${schoolId}
        JOIN sections sec ON cs.section_id = sec.id AND sec.school_id = ${schoolId}
        LEFT JOIN subjects s ON de.subject_id = s.id
        LEFT JOIN users u ON de.created_by = u.id
        LEFT JOIN persons creator ON u.person_id = creator.id
        WHERE de.school_id = ${schoolId}
          AND de.entry_date = CURRENT_DATE
          AND de.deleted_at IS NULL
    `;

    if (class_section_id) query = sql`${query} AND de.class_section_id = ${class_section_id}`;
    if (!class_section_id && class_id) query = sql`${query} AND cs.class_id = ${class_id}`;
    if (!class_section_id && section_id) query = sql`${query} AND cs.section_id = ${section_id}`;
    if (subject_id) query = sql`${query} AND de.subject_id = ${subject_id}`;

    query = sql`${query} ORDER BY c.sort_order NULLS LAST, c.name, sec.name, de.created_at DESC`;

    const entries = await query;
    return sendSuccess(res, schoolId, entries);
}));

/**
 * GET /admin/diary/history
 * Get diary entries for a specific date
 */
router.get('/diary/history', requirePermission('diary.manage'), asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { class_id, section_id, date } = req.query;

    if (!date) {
        return res.status(400).json({ success: false, message: 'Date is required' });
    }

    let query = sql`
        SELECT 
            de.id,
            de.class_section_id,
            de.entry_date,
            de.subject_id,
            de.title,
            de.title_te,
            de.content,
            de.content_te,
            de.homework_due_date,
            de.attachments,
            de.created_by,
            de.created_at,
            de.updated_at,
            c.id AS class_id,
            c.name AS class_name,
            sec.id AS section_id,
            sec.name AS section_name,
            s.name as subject_name,
            creator.display_name as teacher_name
        FROM diary_entries de
        JOIN class_sections cs ON de.class_section_id = cs.id AND cs.school_id = ${schoolId}
        JOIN classes c ON cs.class_id = c.id AND c.school_id = ${schoolId}
        JOIN sections sec ON cs.section_id = sec.id AND sec.school_id = ${schoolId}
        LEFT JOIN subjects s ON de.subject_id = s.id
        LEFT JOIN users u ON de.created_by = u.id
        LEFT JOIN persons creator ON u.person_id = creator.id
        WHERE de.school_id = ${schoolId}
          AND de.entry_date = ${date}
          AND de.deleted_at IS NULL
    `;

    if (class_id) query = sql`${query} AND cs.class_id = ${class_id}`;
    if (section_id) query = sql`${query} AND cs.section_id = ${section_id}`;

    query = sql`${query} ORDER BY c.sort_order NULLS LAST, c.name, sec.name, de.created_at DESC`;

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
 * GET /admin/partial-fee-direct-collect
 * Read whether the accounts department may collect partial term-fees directly,
 * without raising an approval request to admin.
 */
router.get('/partial-fee-direct-collect', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    await ensurePartialFeeDirectCollectColumn();

    const [row] = await sql`
        SELECT partial_fee_direct_collect_enabled
        FROM schools
        WHERE id = ${req.schoolId}
    `;
    return sendSuccess(res, req.schoolId, {
        enabled: row?.partial_fee_direct_collect_enabled === true,
    });
}));

/**
 * PUT /admin/partial-fee-direct-collect
 * Enable or disable direct partial fee collection school-wide.
 * When enabled, accounts post partial payments immediately with no admin
 * approval step. When disabled, each partial still needs admin approval.
 */
router.put('/partial-fee-direct-collect', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled boolean is required in request body' });
    }

    await ensurePartialFeeDirectCollectColumn();

    await sql`
        UPDATE schools
        SET partial_fee_direct_collect_enabled = ${enabled}
        WHERE id = ${req.schoolId}
    `;

    return sendSuccess(res, req.schoolId, {
        enabled,
        message: enabled
            ? 'Accounts can now collect partial fees without admin approval'
            : 'Partial fee collection now requires admin approval',
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
/**
 * GET /admin/pending-fees/filter-options
 * Filter values are derived from students who currently have a school-fee due.
 * A transport stop is presented as a village because that is the available,
 * maintained locality field in this installation's transport data.
 */
router.get('/pending-fees/filter-options', requirePermission('fees.view'), asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const academicYear = await resolveDueListAcademicYear(schoolId, req.query.academic_year_id);
    if (!academicYear) {
        return res.status(404).json({ error: 'No academic year configured for this school.' });
    }

    const feeMode = await getSchoolFeeMode(schoolId);
    const structureModeFilter = activeStructureFilter(feeMode);
    const [classes, sections, villages] = await Promise.all([
        sql`
            SELECT DISTINCT c.id, c.name
            FROM student_fees sf
            JOIN fee_structures fs ON fs.id = sf.fee_structure_id
            JOIN student_enrollments se ON se.student_id = sf.student_id
              AND se.academic_year_id = fs.academic_year_id
              AND se.school_id = ${schoolId}
              AND se.status = 'active'
              AND se.deleted_at IS NULL
            JOIN class_sections cs ON cs.id = se.class_section_id AND cs.deleted_at IS NULL
            JOIN classes c ON c.id = cs.class_id AND c.deleted_at IS NULL
            WHERE sf.school_id = ${schoolId}
              AND fs.academic_year_id = ${academicYear.id}
              AND sf.deleted_at IS NULL
              AND fs.deleted_at IS NULL
              AND sf.status IN ('pending', 'partial', 'overdue')
              AND (sf.amount_due - sf.discount - sf.amount_paid) > 0
              ${structureModeFilter}
            ORDER BY c.name
        `,
        sql`
            SELECT DISTINCT sec.id, sec.name
            FROM student_fees sf
            JOIN fee_structures fs ON fs.id = sf.fee_structure_id
            JOIN student_enrollments se ON se.student_id = sf.student_id
              AND se.academic_year_id = fs.academic_year_id
              AND se.school_id = ${schoolId}
              AND se.status = 'active'
              AND se.deleted_at IS NULL
            JOIN class_sections cs ON cs.id = se.class_section_id AND cs.deleted_at IS NULL
            JOIN sections sec ON sec.id = cs.section_id AND sec.deleted_at IS NULL
            WHERE sf.school_id = ${schoolId}
              AND fs.academic_year_id = ${academicYear.id}
              AND sf.deleted_at IS NULL
              AND fs.deleted_at IS NULL
              AND sf.status IN ('pending', 'partial', 'overdue')
              AND (sf.amount_due - sf.discount - sf.amount_paid) > 0
              ${structureModeFilter}
            ORDER BY sec.name
        `,
        sql`
            SELECT DISTINCT ts.id, ts.name, tr.name AS route_name
            FROM student_fees sf
            JOIN fee_structures fs ON fs.id = sf.fee_structure_id
            JOIN student_transport st ON st.student_id = sf.student_id
              AND st.academic_year_id = fs.academic_year_id
              AND st.school_id = ${schoolId}
              AND st.is_active = TRUE
            JOIN transport_stops ts ON ts.id = st.stop_id AND ts.deleted_at IS NULL
            JOIN transport_routes tr ON tr.id = st.route_id AND tr.deleted_at IS NULL
            WHERE sf.school_id = ${schoolId}
              AND fs.academic_year_id = ${academicYear.id}
              AND sf.deleted_at IS NULL
              AND fs.deleted_at IS NULL
              AND sf.status IN ('pending', 'partial', 'overdue')
              AND (sf.amount_due - sf.discount - sf.amount_paid) > 0
              ${structureModeFilter}
            ORDER BY ts.name, tr.name
        `,
    ]);

    return sendSuccess(res, schoolId, {
        academic_year: academicYear,
        classes,
        sections,
        villages: villages.map((village) => ({
            ...village,
            label: village.route_name ? `${village.name} · ${village.route_name}` : village.name,
        })),
    });
}));

/**
 * GET /admin/pending-fees/export
 * One row per student with outstanding school-fee dues. Money columns
 * (school total, discount, final fee, paid) aggregate ALL of that student's
 * fee lines for the academic year — including fully waived / paid lines —
 * so fee-adjustment waivers still appear under Discount Given. Due amount,
 * fee-item count, earliest due date, and overdue flag stay based on
 * outstanding lines only. Transport is used only for village/route filters.
 */
router.get('/pending-fees/export', requirePermission('fees.view'), asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { academic_year_id, class_id, section_id, village_id, overdue_only } = req.query;
    const academicYear = await resolveDueListAcademicYear(schoolId, academic_year_id);
    if (!academicYear) {
        return res.status(404).json({ error: 'No academic year configured for this school.' });
    }

    const feeMode = await getSchoolFeeMode(schoolId);
    const structureModeFilter = activeStructureFilter(feeMode);
    // Money columns MUST be aggregated at the student_fees grain (one row per
    // fee line). Joining student_enrollments / student_transport before the SUM
    // fans out fee lines whenever a student has more than one matching row —
    // e.g. two active enrollments in the same year after a mid-year section
    // change — which multiplies school-total / discount / paid / due. So we
    // aggregate fees per student in a CTE first, then join enrollment (deduped
    // to the latest active row) and transport (unique per year) for display only.
    const rows = await sql`
        WITH fee_agg AS (
            SELECT
                sf.student_id,
                COALESCE(SUM(sf.amount_due), 0)::numeric AS school_total_fee,
                COALESCE(SUM(sf.discount), 0)::numeric AS discount_given,
                COALESCE(SUM(sf.amount_due - sf.discount), 0)::numeric AS final_fee,
                COALESCE(SUM(sf.amount_paid), 0)::numeric AS paid_fee,
                COALESCE(SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)), 0)::numeric AS due_amount,
                COUNT(sf.id) FILTER (
                  WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0
                )::int AS fee_item_count,
                MIN(sf.due_date) FILTER (
                  WHERE (sf.amount_due - sf.discount - sf.amount_paid) > 0
                ) AS earliest_due_date,
                BOOL_OR(
                  sf.due_date < CURRENT_DATE
                  AND (sf.amount_due - sf.discount - sf.amount_paid) > 0
                ) AS is_overdue
            FROM student_fees sf
            JOIN fee_structures fs ON fs.id = sf.fee_structure_id
            WHERE sf.school_id = ${schoolId}
              AND fs.academic_year_id = ${academicYear.id}
              AND sf.deleted_at IS NULL
              AND fs.deleted_at IS NULL
              ${structureModeFilter}
            GROUP BY sf.student_id
            HAVING SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)) > 0
        ),
        enroll AS (
            SELECT DISTINCT ON (se.student_id)
                se.student_id,
                se.roll_number,
                cs.class_id,
                cs.section_id
            FROM student_enrollments se
            JOIN class_sections cs ON cs.id = se.class_section_id AND cs.deleted_at IS NULL
            WHERE se.academic_year_id = ${academicYear.id}
              AND se.school_id = ${schoolId}
              AND se.status = 'active'
              AND se.deleted_at IS NULL
            ORDER BY se.student_id, se.start_date DESC, se.created_at DESC
        )
        SELECT
            s.admission_no,
            p.display_name AS student_name,
            c.name AS class_name,
            sec.name AS section_name,
            en.roll_number,
            ts.name AS village,
            tr.name AS route_name,
            fa.school_total_fee,
            fa.discount_given,
            fa.final_fee,
            fa.paid_fee,
            fa.due_amount,
            fa.fee_item_count,
            fa.earliest_due_date,
            fa.is_overdue
        FROM fee_agg fa
        JOIN students s ON s.id = fa.student_id AND s.school_id = ${schoolId} AND s.deleted_at IS NULL
        JOIN persons p ON p.id = s.person_id
        JOIN enroll en ON en.student_id = fa.student_id
        JOIN classes c ON c.id = en.class_id AND c.deleted_at IS NULL
        JOIN sections sec ON sec.id = en.section_id AND sec.deleted_at IS NULL
        LEFT JOIN student_transport st ON st.student_id = fa.student_id
          AND st.academic_year_id = ${academicYear.id}
          AND st.school_id = ${schoolId}
          AND st.is_active = TRUE
        LEFT JOIN transport_stops ts ON ts.id = st.stop_id AND ts.deleted_at IS NULL
        LEFT JOIN transport_routes tr ON tr.id = st.route_id AND tr.deleted_at IS NULL
        WHERE TRUE
          ${class_id ? sql`AND c.id = ${class_id}` : sql``}
          ${section_id ? sql`AND sec.id = ${section_id}` : sql``}
          ${village_id ? sql`AND ts.id = ${village_id}` : sql``}
          AND (${overdue_only === 'true'} = FALSE OR fa.is_overdue)
        ORDER BY c.name, sec.name, p.display_name
    `;

    const [school] = await sql`
        SELECT name FROM schools WHERE id = ${schoolId} LIMIT 1
    `;
    const [classFilter] = class_id ? await sql`
        SELECT name FROM classes WHERE id = ${class_id} AND school_id = ${schoolId} LIMIT 1
    ` : [];
    const [sectionFilter] = section_id ? await sql`
        SELECT name FROM sections WHERE id = ${section_id} AND school_id = ${schoolId} LIMIT 1
    ` : [];
    const [villageFilter] = village_id ? await sql`
        SELECT name FROM transport_stops WHERE id = ${village_id} AND school_id = ${schoolId} LIMIT 1
    ` : [];

    const buffer = buildDueListWorkbook({
        schoolName: school?.name,
        academicYear: academicYear.code,
        rows,
        filters: {
            class_name: classFilter?.name,
            section_name: sectionFilter?.name,
            village_name: villageFilter?.name,
            overdue_only: overdue_only === 'true',
        },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="pending-fees-due-list-${stamp}.xlsx"`);
    return res.send(buffer);
}));

router.get('/finance-stats', requirePermission('fees.view'), asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

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
            WHERE ft.paid_at::DATE = ${targetDate}::DATE
              AND sf.school_id = ${schoolId}
              AND (ft.refund_of IS NULL OR ft.transaction_ref NOT LIKE 'VOID-%')
              AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = ft.school_id AND rev.refund_of = ft.id AND rev.transaction_ref LIKE 'VOID-%')
        `,
        sql`
            SELECT COALESCE(SUM(ft.amount), 0) as total
            FROM fee_transactions ft
            JOIN student_fees sf ON ft.student_fee_id = sf.id
            WHERE date_trunc('month', ft.paid_at) = date_trunc('month', ${targetDate}::DATE)
              AND sf.school_id = ${schoolId}
              AND (ft.refund_of IS NULL OR ft.transaction_ref NOT LIKE 'VOID-%')
              AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = ft.school_id AND rev.refund_of = ft.id AND rev.transaction_ref LIKE 'VOID-%')
        `,
        sql`
            SELECT COALESCE(SUM(ft.amount), 0) as total
            FROM fee_transactions ft
            JOIN student_fees sf ON ft.student_fee_id = sf.id
            WHERE sf.school_id = ${schoolId}
              AND (ft.refund_of IS NULL OR ft.transaction_ref NOT LIKE 'VOID-%')
              AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = ft.school_id AND rev.refund_of = ft.id AND rev.transaction_ref LIKE 'VOID-%')
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
                t.received_by as received_by_id,
                t.student_fee_id,
                sf.student_id,
                s.admission_no,
                p.display_name as student_name,
                enroll.class_name,
                enroll.section_name,
                father_info.father_name,
                father_info.father_mobile,
                r.receipt_no,
                ft.name as fee_type,
                ft.name_te as fee_type_te,
                ay.code as academic_year,
                receiver.display_name as received_by
            FROM fee_transactions t
            JOIN student_fees sf ON t.student_fee_id = sf.id
            JOIN students s ON sf.student_id = s.id
            JOIN persons p ON s.person_id = p.id
            LEFT JOIN receipt_items ri ON ri.fee_transaction_id = t.id AND ri.school_id = ${schoolId}
            LEFT JOIN receipts r ON r.id = ri.receipt_id AND r.school_id = ${schoolId}
            LEFT JOIN fee_structures fs ON sf.fee_structure_id = fs.id
            LEFT JOIN fee_types ft ON fs.fee_type_id = ft.id
            LEFT JOIN academic_years ay ON fs.academic_year_id = ay.id
            LEFT JOIN users u ON t.received_by = u.id
            LEFT JOIN persons receiver ON u.person_id = receiver.id
            LEFT JOIN LATERAL (
                SELECT c.name as class_name, sec.name as section_name
                FROM student_enrollments se
                JOIN class_sections cs ON se.class_section_id = cs.id
                JOIN classes c ON cs.class_id = c.id
                JOIN sections sec ON cs.section_id = sec.id
                WHERE se.student_id = s.id AND se.status = 'active'
                ORDER BY se.created_at DESC
                LIMIT 1
            ) enroll ON true
            LEFT JOIN LATERAL (
                SELECT
                    pp.display_name as father_name,
                    (
                        SELECT pc.contact_value
                        FROM person_contacts pc
                        WHERE pc.person_id = pp.id
                          AND pc.school_id = ${schoolId}
                          AND pc.contact_type = 'phone'
                          AND pc.deleted_at IS NULL
                        ORDER BY pc.is_primary DESC, pc.created_at
                        LIMIT 1
                    ) as father_mobile
                FROM student_parents sp
                JOIN parents par ON sp.parent_id = par.id AND par.deleted_at IS NULL
                JOIN persons pp ON par.person_id = pp.id
                LEFT JOIN relationship_types rt ON sp.relationship_id = rt.id
                WHERE sp.student_id = s.id
                  AND sp.school_id = ${schoolId}
                  AND sp.deleted_at IS NULL
                ORDER BY
                    CASE WHEN rt.name = 'Father' THEN 0 WHEN COALESCE(sp.is_primary_contact, true) THEN 1 ELSE 2 END,
                    sp.created_at
                LIMIT 1
            ) father_info ON true
            WHERE s.school_id = ${schoolId}
              AND t.paid_at::DATE = ${targetDate}::DATE
              AND (t.refund_of IS NULL OR t.transaction_ref NOT LIKE 'VOID-%')
              AND NOT EXISTS (SELECT 1 FROM fee_transactions rev WHERE rev.school_id = t.school_id AND rev.refund_of = t.id AND rev.transaction_ref LIKE 'VOID-%')
            ORDER BY t.paid_at DESC
            LIMIT 1000
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

/**
 * GET /admin/app-adoption
 *
 * Reports whether each active school account has registered an active mobile
 * device. This is intentionally described as "detected", not "downloaded":
 * app-store downloads that were never opened are not observable.
 */
router.get('/app-adoption', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(10, Number.parseInt(String(req.query.limit || '25'), 10) || 25));
    const offset = (page - 1) * limit;
    const search = String(req.query.search || '').trim();
    const role = String(req.query.role || 'all').trim().toLowerCase();
    const status = String(req.query.status || 'all').trim().toLowerCase();

    if (!['all', 'detected', 'not_detected'].includes(status)) {
        return res.status(400).json({ error: 'status must be all, detected, or not_detected' });
    }

    const searchPattern = `%${search}%`;
    const searchFilter = search
        ? sql`AND (
            p.display_name ILIKE ${searchPattern}
            OR COALESCE(contact.email, '') ILIKE ${searchPattern}
            OR COALESCE(contact.phone, '') ILIKE ${searchPattern}
            OR COALESCE(student_info.admission_no, '') ILIKE ${searchPattern}
          )`
        : sql``;
    const roleFilter = role !== 'all'
        ? sql`AND EXISTS (
            SELECT 1
            FROM user_roles ur_filter
            JOIN roles r_filter
              ON r_filter.id = ur_filter.role_id
             AND r_filter.school_id = ${schoolId}
             AND r_filter.deleted_at IS NULL
            WHERE ur_filter.user_id = u.id
              AND ur_filter.school_id = ${schoolId}
              AND ur_filter.deleted_at IS NULL
              AND r_filter.code = ${role}
          )`
        : sql``;
    const statusFilter = status === 'detected'
        ? sql`AND COALESCE(device_info.device_count, 0) > 0`
        : status === 'not_detected'
            ? sql`AND COALESCE(device_info.device_count, 0) = 0`
            : sql``;

    const baseFrom = sql`
        FROM users u
        JOIN persons p
          ON p.id = u.person_id
         AND p.school_id = ${schoolId}
         AND p.deleted_at IS NULL
        LEFT JOIN LATERAL (
            SELECT
                MAX(pc.contact_value) FILTER (WHERE pc.contact_type = 'email' AND pc.is_primary) AS email,
                MAX(pc.contact_value) FILTER (WHERE pc.contact_type = 'phone' AND pc.is_primary) AS phone
            FROM person_contacts pc
            WHERE pc.person_id = p.id
              AND pc.school_id = ${schoolId}
              AND pc.deleted_at IS NULL
        ) contact ON true
        LEFT JOIN LATERAL (
            SELECT ARRAY_AGG(DISTINCT r.code ORDER BY r.code) AS roles
            FROM user_roles ur
            JOIN roles r
              ON r.id = ur.role_id
             AND r.school_id = ${schoolId}
             AND r.deleted_at IS NULL
            WHERE ur.user_id = u.id
              AND ur.school_id = ${schoolId}
              AND ur.deleted_at IS NULL
        ) role_info ON true
        LEFT JOIN LATERAL (
            SELECT
                COUNT(*)::int AS device_count,
                MAX(COALESCE(ud.last_used_at, ud.updated_at, ud.created_at)) AS last_detected_at,
                ARRAY_AGG(DISTINCT ud.platform ORDER BY ud.platform) AS platforms
            FROM user_devices ud
            WHERE ud.user_id = u.id
              AND ud.school_id = ${schoolId}
              AND ud.is_active = true
        ) device_info ON true
        LEFT JOIN LATERAL (
            SELECT
                s.admission_no,
                c.name AS class_name,
                sec.name AS section_name
            FROM students s
            LEFT JOIN student_enrollments se
              ON se.student_id = s.id
             AND se.school_id = ${schoolId}
             AND se.status = 'active'
             AND se.deleted_at IS NULL
            LEFT JOIN class_sections cs
              ON cs.id = se.class_section_id
             AND cs.school_id = ${schoolId}
             AND cs.deleted_at IS NULL
            LEFT JOIN classes c
              ON c.id = cs.class_id
             AND c.school_id = ${schoolId}
             AND c.deleted_at IS NULL
            LEFT JOIN sections sec
              ON sec.id = cs.section_id
             AND sec.school_id = ${schoolId}
             AND sec.deleted_at IS NULL
            WHERE s.person_id = p.id
              AND s.school_id = ${schoolId}
              AND s.deleted_at IS NULL
            ORDER BY se.start_date DESC NULLS LAST
            LIMIT 1
        ) student_info ON true
        WHERE u.school_id = ${schoolId}
          AND u.deleted_at IS NULL
          AND u.account_status = 'active'
          ${searchFilter}
          ${roleFilter}
    `;

    const [summaryRows, rows] = await Promise.all([
        sql`
            SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE COALESCE(device_info.device_count, 0) > 0)::int AS detected,
                COUNT(*) FILTER (WHERE COALESCE(device_info.device_count, 0) = 0)::int AS not_detected
            ${baseFrom}
        `,
        sql`
            SELECT
                u.id AS user_id,
                p.display_name,
                p.photo_url,
                contact.email,
                contact.phone,
                COALESCE(role_info.roles, ARRAY[]::text[]) AS roles,
                u.last_login_at,
                u.created_at AS account_created_at,
                student_info.admission_no,
                student_info.class_name,
                student_info.section_name,
                COALESCE(device_info.device_count, 0)::int AS device_count,
                device_info.last_detected_at,
                COALESCE(device_info.platforms, ARRAY[]::text[]) AS platforms,
                (COALESCE(device_info.device_count, 0) > 0) AS app_detected
            ${baseFrom}
            ${statusFilter}
            ORDER BY
                (COALESCE(device_info.device_count, 0) = 0) DESC,
                p.display_name ASC,
                u.id ASC
            LIMIT ${limit}
            OFFSET ${offset}
        `,
    ]);

    const summary = summaryRows[0] || { total: 0, detected: 0, not_detected: 0 };
    const filteredTotal = status === 'detected'
        ? summary.detected
        : status === 'not_detected'
            ? summary.not_detected
            : summary.total;

    return sendSuccess(res, schoolId, {
        users: rows,
        summary: {
            total: Number(summary.total || 0),
            detected: Number(summary.detected || 0),
            not_detected: Number(summary.not_detected || 0),
        },
        meta: {
            page,
            limit,
            total: Number(filteredTotal || 0),
            total_pages: Math.max(1, Math.ceil(Number(filteredTotal || 0) / limit)),
        },
    });
}));

/**
 * GET /admin/translation-health
 * Admin diagnostic for the EN↔TE translation pipeline used by diary, notices
 * and complaints. Reports cumulative engine counters and (unless ?probe=false)
 * runs a live probe showing whether Gemini is answering or we've dropped to the
 * free-scraper fallback (degraded). If `degraded` or `!healthy`, translations
 * are unreliable — usually the Gemini key needs billing enabled.
 */
router.get('/translation-health', requireAuth, requireRole('admin', 'principal'), asyncHandler(async (req, res) => {
    const stats = getTranslationStats();
    const runProbe = String(req.query.probe ?? 'true') !== 'false';
    const probe = runProbe ? await probeTranslation() : null;
    return sendSuccess(res, req.schoolId, { stats, probe });
}));

export default router;
