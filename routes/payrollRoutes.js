
import express from 'express';
import sql from '../db.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendNotificationToUsers } from '../services/notificationService.js';

const router = express.Router();

/**
 * Payroll is management-only (admin/principal, or any role explicitly granted
 * payroll.process). Accounts is intentionally excluded — segregation of duties:
 * the accounts role must not see salaries or payslips (RBAC epic #3, #13).
 * Admin bypasses via role; principal holds payroll.process from the seed.
 */
function requirePayrollIssuer(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const roles = req.user.roles || [];
  const perms = req.user.permissions || [];
  if (roles.includes('admin') || perms.includes('payroll.process')) {
    return next();
  }
  console.warn(`[payroll] denied: user=${req.user.internal_id} roles=[${roles.join(',')}] ${req.method} ${req.originalUrl}`);
  return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
}

function isAccountsOnlyUser(req) {
  const roles = req.user?.roles || [];
  const elevated = roles.some((r) => ['admin', 'principal'].includes(r));
  return roles.includes('accounts') && !elevated;
}

async function getPayrollDistributionBlocked(schoolId) {
  const [row] = await sql`
    SELECT payroll_distribution_blocked
    FROM schools
    WHERE id = ${schoolId}
  `;
  return Boolean(row?.payroll_distribution_blocked);
}

async function assertCanDistributePayroll(req, res) {
  if (!isAccountsOnlyUser(req)) return true;
  const blocked = await getPayrollDistributionBlocked(req.schoolId);
  if (blocked) {
    res.status(403).json({
      error: 'Payroll distribution is currently blocked by the admin. Contact your principal to release salaries.',
      code: 'PAYROLL_DISTRIBUTION_BLOCKED'
    });
    return false;
  }
  return true;
}

async function notifyPayrollRecipient(staffId, schoolId) {
  const [user] = await sql`
    SELECT u.id
    FROM staff s
    JOIN users u
      ON u.person_id = s.person_id
     AND u.school_id = s.school_id
     AND u.deleted_at IS NULL
    WHERE s.id = ${staffId}
      AND s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
      AND u.account_status = 'active'
    LIMIT 1
  `;

  if (!user) return;
  await sendNotificationToUsers(
    [user.id],
    'PAYROLL_SUCCESS',
    { message: 'Your salary has been credited successfully.' },
    { deepLink: '/staff/payslip', role: 'staff' },
  );
}

/**
 * GET /distribution-status
 * Whether accounts payroll processing is blocked for this school
 */
router.get('/distribution-status', requirePayrollIssuer, asyncHandler(async (req, res) => {
  const blocked = await getPayrollDistributionBlocked(req.schoolId);
  return sendSuccess(res, req.schoolId, {
    blocked,
    accounts_blocked: blocked && isAccountsOnlyUser(req),
  });
}));

/**
 * PUT /:id/adjust
 * Apply a manual salary increase/decrease before payment (pending rows only)
 */
router.put('/:id/adjust', requirePayrollIssuer, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { salary_adjustment, remarks } = req.body;

  if (salary_adjustment === undefined || salary_adjustment === null || Number.isNaN(Number(salary_adjustment))) {
    return res.status(400).json({ error: 'salary_adjustment is required and must be a number' });
  }

  const adjustment = Number(salary_adjustment);

  const [existing] = await sql`
    SELECT sp.id, sp.status, sp.base_salary, sp.bonus, sp.deductions
    FROM staff_payroll sp
    JOIN staff s ON sp.staff_id = s.id
    WHERE sp.id = ${id} AND s.school_id = ${req.schoolId}
  `;

  if (!existing) {
    return res.status(404).json({ error: 'Payroll record not found' });
  }

  if (existing.status !== 'pending') {
    return res.status(400).json({ error: 'Only pending payroll rows can be adjusted' });
  }

  const base = Number(existing.base_salary) || 0;
  const bonus = Number(existing.bonus) || 0;
  const deductions = Number(existing.deductions) || 0;
  const net = Math.max(0, base + bonus + adjustment - deductions);

  const [payroll] = await sql`
    UPDATE staff_payroll
    SET
      salary_adjustment = ${adjustment},
      net_salary = ${net},
      remarks = COALESCE(${remarks ?? null}, remarks),
      updated_at = now()
    WHERE id = ${id}
      AND staff_id IN (SELECT id FROM staff WHERE school_id = ${req.schoolId})
      AND status = 'pending'
    RETURNING *
  `;

  if (!payroll) {
    return res.status(404).json({ error: 'Payroll record could not be updated' });
  }

  return sendSuccess(res, req.schoolId, { message: 'Salary adjustment saved', payroll });
}));

/**
 * POST /process
 * Process payroll for a specific staff member
 */
router.post('/process', requirePayrollIssuer, asyncHandler(async (req, res) => {
  if (!(await assertCanDistributePayroll(req, res))) return;

  const { staff_id, month, year, payment_date } = req.body;

  if (!staff_id || !month || !year) {
    return res.status(400).json({ error: 'staff_id, month, and year are required' });
  }

  const [staffCheck] = await sql`SELECT id FROM staff WHERE id = ${staff_id} AND school_id = ${req.schoolId}`;
  if (!staffCheck) {
    return res.status(404).json({ error: 'Staff not found' });
  }

  await sql`SELECT recalculate_staff_payroll(${staff_id}, ${month}, ${year})`;

  const payDate = payment_date || new Date();

  const [payroll] = await sql`
    UPDATE staff_payroll
    SET 
      status = 'paid',
      payment_date = ${payDate},
      updated_at = now()
    WHERE staff_id = ${staff_id}
      AND payroll_month = ${month}
      AND payroll_year = ${year}
      AND staff_id IN (SELECT id FROM staff WHERE school_id = ${req.schoolId})
    RETURNING *
  `;

  if (!payroll) {
    return res.status(404).json({ error: 'Payroll record could not be processed' });
  }

  (async () => {
    try {
      await notifyPayrollRecipient(staff_id, req.schoolId);
    } catch (err) {
      // non-blocking
    }
  })();

  return sendSuccess(res, req.schoolId, { message: 'Payroll processed successfully', payroll });
}));

/**
 * PUT /:id/pay
 * Mark a specific payroll record as paid by ID
 */
router.put('/:id/pay', requirePayrollIssuer, asyncHandler(async (req, res) => {
  if (!(await assertCanDistributePayroll(req, res))) return;

  const { id } = req.params;
  const payment_date = new Date();

  const [payrollCheck] = await sql`
    SELECT sp.id FROM staff_payroll sp
    JOIN staff s ON sp.staff_id = s.id
    WHERE sp.id = ${id} AND s.school_id = ${req.schoolId}
  `;
  if (!payrollCheck) {
    return res.status(404).json({ error: 'Payroll record not found' });
  }

  const [payroll] = await sql`
    UPDATE staff_payroll
    SET 
      status = 'paid',
      payment_date = ${payment_date},
      updated_at = now()
    WHERE id = ${id} AND staff_id IN (SELECT id FROM staff WHERE school_id = ${req.schoolId})
    RETURNING *
  `;

  if (!payroll) {
    return res.status(404).json({ error: 'Payroll record not found' });
  }

  (async () => {
    try {
      await notifyPayrollRecipient(payroll.staff_id, req.schoolId);
    } catch (err) {
      // non-blocking
    }
  })();

  return sendSuccess(res, req.schoolId, { message: 'Payroll marked as paid', payroll });
}));

export default router;
