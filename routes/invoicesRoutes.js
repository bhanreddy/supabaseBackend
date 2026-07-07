import express from 'express';
import sql from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// ── GET /invoices ──────────────────────────────────────────────────────────────
// Lists invoices (student fees) belonging to the authenticated school only.
// INV1: Both sf.school_id AND s.school_id filtered for defense-in-depth.
// INV3: requireAuth + requirePermission guard.
router.get(
  '/',
  requireAuth,
  requirePermission('fees.view'),
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const { student_id, status, limit = 50, offset = 0 } = req.query;

    const invoices = await sql`
      SELECT
        sf.id,
        sf.student_id,
        sf.fee_structure_id,
        sf.amount_due,
        sf.amount_paid,
        sf.status,
        sf.due_date,
        sf.created_at,
        sf.updated_at,
        p.display_name AS student_name,
        s.admission_no,
        ft.name AS fee_type
      FROM student_fees sf
      JOIN students s  ON sf.student_id      = s.id
        AND s.school_id  = ${schoolId}
      JOIN persons p   ON s.person_id         = p.id
      JOIN fee_structures fs ON sf.fee_structure_id = fs.id
      JOIN fee_types ft ON fs.fee_type_id     = ft.id
      WHERE sf.school_id = ${schoolId}
        ${student_id ? sql`AND sf.student_id = ${student_id}` : sql``}
        ${status     ? sql`AND sf.status     = ${status}`     : sql``}
      ORDER BY sf.created_at DESC
      LIMIT  ${limit}
      OFFSET ${offset}
    `;

    // Format to match Invoice interface expected by frontend
    const formattedInvoices = invoices.map((inv) => ({
      ...inv,
      student: { person: { display_name: inv.student_name } },
      fee_structure: { fee_type: { name: inv.fee_type } },
    }));

    return sendSuccess(res, req.schoolId, formattedInvoices);
  })
);

// ── GET /invoices/:id ──────────────────────────────────────────────────────────
// Returns a specific invoice only if it belongs to the authenticated school.
// INV2: school_id included in WHERE — returns 404 on miss (never 403/500).
// INV3: requireAuth + requirePermission guard.
router.get(
  '/:id',
  requireAuth,
  requirePermission('fees.view'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const schoolId = req.schoolId;

    const [invoice] = await sql`
      SELECT
        sf.id,
        sf.student_id,
        sf.fee_structure_id,
        sf.amount_due,
        sf.amount_paid,
        sf.status,
        sf.due_date,
        sf.created_at,
        sf.updated_at,
        p.display_name AS student_name,
        s.admission_no,
        ft.name AS fee_type
      FROM student_fees sf
      JOIN students s  ON sf.student_id       = s.id
        AND s.school_id   = ${schoolId}
      JOIN persons p   ON s.person_id          = p.id
      JOIN fee_structures fs ON sf.fee_structure_id = fs.id
      JOIN fee_types ft ON fs.fee_type_id      = ft.id
      WHERE sf.id        = ${id}
        AND sf.school_id = ${schoolId}
    `;

    // INV2: 404 rather than 403/500 on miss — prevents ID enumeration
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const formattedInvoice = {
      ...invoice,
      student: { person: { display_name: invoice.student_name } },
      fee_structure: { fee_type: { name: invoice.fee_type } },
    };

    return sendSuccess(res, req.schoolId, formattedInvoice);
  })
);

export default router;