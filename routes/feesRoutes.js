import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// ============== FEE TYPES ==============

/**
 * GET /fees/types
 * List all fee types
 */
router.get('/types', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const types = await sql`
    SELECT id, name, code, description, is_recurring, is_optional
    FROM fee_types
    ORDER BY name
  `;
  res.json(types);
}));

// ============== FEE STRUCTURE ==============

/**
 * GET /fees/structure
 * Get fee structure (filter by class_id, academic_year_id)
 */
router.get('/structure', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { class_id, academic_year_id } = req.query;

  let structures;
  if (class_id && academic_year_id) {
    structures = await sql`
      SELECT 
        fs.id, fs.amount, fs.due_date, fs.frequency,
        ft.name as fee_type, ft.code as fee_code, ft.is_optional,
        c.name as class_name, ay.code as academic_year
      FROM fee_structures fs
      JOIN fee_types ft ON fs.fee_type_id = ft.id
      JOIN classes c ON fs.class_id = c.id
      JOIN academic_years ay ON fs.academic_year_id = ay.id
      WHERE fs.class_id = ${class_id} AND fs.academic_year_id = ${academic_year_id}
      ORDER BY ft.name
    `;
  } else if (academic_year_id) {
    structures = await sql`
      SELECT 
        fs.id, fs.amount, fs.due_date, fs.frequency,
        ft.name as fee_type, ft.code as fee_code,
        c.name as class_name, c.id as class_id
      FROM fee_structures fs
      JOIN fee_types ft ON fs.fee_type_id = ft.id
      JOIN classes c ON fs.class_id = c.id
      WHERE fs.academic_year_id = ${academic_year_id}
      ORDER BY c.name, ft.name
    `;
  } else {
    structures = await sql`
      SELECT 
        fs.id, fs.amount, fs.due_date, fs.frequency,
        ft.name as fee_type, c.name as class_name,
        ay.code as academic_year
      FROM fee_structures fs
      JOIN fee_types ft ON fs.fee_type_id = ft.id
      JOIN classes c ON fs.class_id = c.id
      JOIN academic_years ay ON fs.academic_year_id = ay.id
      ORDER BY ay.start_date DESC, c.name, ft.name
      LIMIT 100
    `;
  }

  res.json(structures);
}));

/**
 * POST /fees/structure
 * Create fee structure for a class
 */
router.post('/structure', requirePermission('fees.manage'), asyncHandler(async (req, res) => {
  const { academic_year_id, class_id, fee_type_id, amount, due_date, frequency } = req.body;

  if (!academic_year_id || !class_id || !fee_type_id || !amount) {
    return res.status(400).json({ error: 'academic_year_id, class_id, fee_type_id, and amount are required' });
  }

  const [structure] = await sql`
    INSERT INTO fee_structures (academic_year_id, class_id, fee_type_id, amount, due_date, frequency)
    VALUES (${academic_year_id}, ${class_id}, ${fee_type_id}, ${amount}, ${due_date}, ${frequency || 'monthly'})
    RETURNING *
  `;

  res.status(201).json({ message: 'Fee structure created', structure });
}));

/**
 * PUT /fees/structure/:id
 * Update fee structure
 */
router.put('/structure/:id', requirePermission('fees.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { amount, due_date, frequency } = req.body;

  const [updated] = await sql`
    UPDATE fee_structures
    SET 
      amount = COALESCE(${amount}, amount),
      due_date = COALESCE(${due_date}, due_date),
      frequency = COALESCE(${frequency}, frequency)
    WHERE id = ${id}
    RETURNING *
  `;

  if (!updated) {
    return res.status(404).json({ error: 'Fee structure not found' });
  }

  res.json({ message: 'Fee structure updated', structure: updated });
}));

// ============== STUDENT FEES ==============

/**
 * GET /fees/students/:studentId
 * Get fee details for a student
 */
router.get('/students/:studentId', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const { academic_year_id } = req.query;

  // Get student info
  const [student] = await sql`
    SELECT s.id, s.admission_no, p.display_name
    FROM students s
    JOIN persons p ON s.person_id = p.id
    WHERE s.id = ${studentId} AND s.deleted_at IS NULL
  `;

  if (!student) {
    return res.status(404).json({ error: 'Student not found' });
  }

  // Get fees
  let fees;
  if (academic_year_id) {
    fees = await sql`
      SELECT 
        sf.id, sf.amount_due, sf.amount_paid, sf.discount, sf.status,
        sf.due_date, sf.period_month, sf.period_year,
        ft.name as fee_type, ft.code as fee_code
      FROM student_fees sf
      JOIN fee_structures fs ON sf.fee_structure_id = fs.id
      JOIN fee_types ft ON fs.fee_type_id = ft.id
      WHERE sf.student_id = ${studentId}
        AND fs.academic_year_id = ${academic_year_id}
      ORDER BY sf.due_date DESC
    `;
  } else {
    fees = await sql`
      SELECT 
        sf.id, sf.amount_due, sf.amount_paid, sf.discount, sf.status,
        sf.due_date, sf.period_month, sf.period_year,
        ft.name as fee_type, ay.code as academic_year
      FROM student_fees sf
      JOIN fee_structures fs ON sf.fee_structure_id = fs.id
      JOIN fee_types ft ON fs.fee_type_id = ft.id
      JOIN academic_years ay ON fs.academic_year_id = ay.id
      WHERE sf.student_id = ${studentId}
      ORDER BY sf.due_date DESC
      LIMIT 50
    `;
  }

  // Calculate summary
  const summary = await sql`
    SELECT 
      COALESCE(SUM(amount_due - discount), 0) as total_due,
      COALESCE(SUM(amount_paid), 0) as total_paid,
      COALESCE(SUM(amount_due - discount - amount_paid), 0) as balance
    FROM student_fees
    WHERE student_id = ${studentId}
  `;

  res.json({
    student,
    summary: summary[0],
    fees
  });
}));

/**
 * POST /fees/collect
 * Collect fee payment
 */
router.post('/collect', requirePermission('fees.collect'), asyncHandler(async (req, res) => {
  const { student_fee_id, amount, payment_method, transaction_ref, remarks } = req.body;

  if (!student_fee_id || !amount || !payment_method) {
    return res.status(400).json({ error: 'student_fee_id, amount, and payment_method are required' });
  }

  const validMethods = ['cash', 'card', 'upi', 'bank_transfer', 'cheque', 'online'];
  if (!validMethods.includes(payment_method)) {
    return res.status(400).json({ error: `payment_method must be one of: ${validMethods.join(', ')}` });
  }

  // Check if fee exists and amount is valid
  const [fee] = await sql`
    SELECT id, amount_due, amount_paid, discount 
    FROM student_fees WHERE id = ${student_fee_id}
  `;

  if (!fee) {
    return res.status(404).json({ error: 'Student fee not found' });
  }

  const remaining = fee.amount_due - fee.discount - fee.amount_paid;
  if (amount > remaining) {
    return res.status(400).json({ error: `Amount exceeds remaining balance of ${remaining}` });
  }

  // Create transaction (trigger will update student_fees.amount_paid)
  const [transaction] = await sql`
    INSERT INTO fee_transactions (student_fee_id, amount, payment_method, transaction_ref, received_by, remarks)
    VALUES (${student_fee_id}, ${amount}, ${payment_method}, ${transaction_ref}, ${req.user?.internal_id}, ${remarks})
    RETURNING *
  `;

  res.status(201).json({ message: 'Payment collected successfully', transaction });
}));

/**
 * GET /fees/summaries
 * Get comprehensive fee summary for all students (or filtered)
 */
router.get('/summaries', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { class_id, academic_year_id, search } = req.query;

  const summaries = await sql`
    SELECT 
      s.id as student_id, 
      s.admission_no,
      p.display_name as student_name,
      c.name as class_name,
      COALESCE(SUM(sf.amount_due), 0) as total_amount,
      COALESCE(SUM(sf.amount_paid), 0) as paid_amount,
      COALESCE(SUM(sf.amount_due - sf.amount_paid - sf.discount), 0) as due_amount,
      CASE 
        WHEN SUM(sf.amount_due - sf.amount_paid - sf.discount) <= 0 THEN 'Paid'
        WHEN SUM(sf.amount_paid) > 0 THEN 'Partial'
        ELSE 'Pending'
      END as status
    FROM students s
    JOIN persons p ON s.person_id = p.id
    JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active'
    JOIN class_sections cs ON se.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    LEFT JOIN student_fees sf ON s.id = sf.student_id 
      ${academic_year_id ? sql`AND sf.fee_structure_id IN (SELECT id FROM fee_structures WHERE academic_year_id = ${academic_year_id})` : sql``}
    WHERE s.deleted_at IS NULL
    ${class_id ? sql`AND c.id = ${class_id}` : sql``}
    ${search ? sql`AND (p.display_name ILIKE ${'%' + search + '%'} OR s.admission_no ILIKE ${'%' + search + '%'})` : sql``}
    GROUP BY s.id, s.admission_no, p.display_name, c.name
    ORDER BY p.display_name
    LIMIT 100
  `;

  res.json(summaries);
}));

/**
 * GET /fees/defaulters
 * Get list of fee defaulters
 */
router.get('/defaulters', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { class_id, academic_year_id, min_days_overdue = 0 } = req.query;

  let defaulters = await sql`
    SELECT 
      s.id as student_id, s.admission_no,
      p.display_name as student_name,
      c.name as class_name, sec.name as section_name,
      SUM(sf.amount_due - sf.discount - sf.amount_paid) as total_due,
      MIN(sf.due_date) as oldest_due_date,
      CURRENT_DATE - MIN(sf.due_date) as days_overdue
    FROM student_fees sf
    JOIN students s ON sf.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    JOIN fee_structures fs ON sf.fee_structure_id = fs.id
    JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active'
    JOIN class_sections cs ON se.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    WHERE sf.status IN ('pending', 'partial', 'overdue')
      AND sf.due_date < CURRENT_DATE
      AND s.deleted_at IS NULL
      ${academic_year_id ? sql`AND fs.academic_year_id = ${academic_year_id}` : sql``}
      ${class_id ? sql`AND c.id = ${class_id}` : sql``}
    GROUP BY s.id, s.admission_no, p.display_name, c.name, sec.name
    HAVING CURRENT_DATE - MIN(sf.due_date) >= ${min_days_overdue}
    ORDER BY total_due DESC
  `;

  res.json(defaulters);
}));

/**
 * GET /fees/receipts
 * List receipts
 */
router.get('/receipts', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { student_id, from_date, to_date, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let receipts;
  if (student_id) {
    receipts = await sql`
      SELECT 
        r.id, r.receipt_no, r.total_amount, r.issued_at, r.remarks,
        issuer.display_name as issued_by
      FROM receipts r
      LEFT JOIN users u ON r.issued_by = u.id
      LEFT JOIN persons issuer ON u.person_id = issuer.id
      WHERE r.student_id = ${student_id}
      ORDER BY r.issued_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    receipts = await sql`
      SELECT 
        r.id, r.receipt_no, r.total_amount, r.issued_at,
        s.admission_no, p.display_name as student_name
      FROM receipts r
      JOIN students s ON r.student_id = s.id
      JOIN persons p ON s.person_id = p.id
      WHERE TRUE
        ${from_date ? sql`AND r.issued_at >= ${from_date}` : sql``}
        ${to_date ? sql`AND r.issued_at <= ${to_date}` : sql``}
      ORDER BY r.issued_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  res.json(receipts);
}));

/**
 * GET /fees/receipts/:id
 * Get receipt details
 */
router.get('/receipts/:id', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [receipt] = await sql`
    SELECT 
      r.*,
      s.admission_no, p.display_name as student_name,
      issuer.display_name as issued_by_name
    FROM receipts r
    JOIN students s ON r.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    LEFT JOIN users u ON r.issued_by = u.id
    LEFT JOIN persons issuer ON u.person_id = issuer.id
    WHERE r.id = ${id}
  `;

  if (!receipt) {
    return res.status(404).json({ error: 'Receipt not found' });
  }

  // Get receipt items
  const items = await sql`
    SELECT 
      ri.amount,
      ft.name as fee_type,
      t.payment_method, t.transaction_ref, t.paid_at
    FROM receipt_items ri
    JOIN fee_transactions t ON ri.fee_transaction_id = t.id
    JOIN student_fees sf ON t.student_fee_id = sf.id
    JOIN fee_structures fs ON sf.fee_structure_id = fs.id
    JOIN fee_types ft ON fs.fee_type_id = ft.id
    WHERE ri.receipt_id = ${id}
  `;

  res.json({ ...receipt, items });
}));

/**
 * GET /fees/transactions
 * List fee transactions
 */
router.get('/transactions', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { from_date, to_date, payment_method, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  const transactions = await sql`
    SELECT 
      t.id, t.amount, t.payment_method, t.transaction_ref, t.paid_at, t.remarks,
      s.admission_no, p.display_name as student_name,
      ft.name as fee_type,
      receiver.display_name as received_by
    FROM fee_transactions t
    JOIN student_fees sf ON t.student_fee_id = sf.id
    JOIN students s ON sf.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    JOIN fee_structures fs ON sf.fee_structure_id = fs.id
    JOIN fee_types ft ON fs.fee_type_id = ft.id
    LEFT JOIN users u ON t.received_by = u.id
    LEFT JOIN persons receiver ON u.person_id = receiver.id
    WHERE TRUE
      ${from_date ? sql`AND t.paid_at >= ${from_date}` : sql``}
      ${to_date ? sql`AND t.paid_at <= ${to_date}` : sql``}
      ${payment_method ? sql`AND t.payment_method = ${payment_method}` : sql``}
    ORDER BY t.paid_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  res.json(transactions);
}));

/**
 * POST /fees/transactions
 * Record a transaction (alternative to /collect)
 */
router.post('/transactions', requirePermission('fees.collect'), asyncHandler(async (req, res) => {
  // Redirect to collect endpoint
  const { student_fee_id, amount, payment_method, transaction_ref, remarks } = req.body;

  if (!student_fee_id || !amount || !payment_method) {
    return res.status(400).json({ error: 'student_fee_id, amount, and payment_method are required' });
  }

  const [transaction] = await sql`
    INSERT INTO fee_transactions (student_fee_id, amount, payment_method, transaction_ref, received_by, remarks)
    VALUES (${student_fee_id}, ${amount}, ${payment_method}, ${transaction_ref}, ${req.user?.internal_id}, ${remarks})
    RETURNING *
  `;

  res.status(201).json({ message: 'Transaction recorded', transaction });
}));

/**
 * GET /fees/collection-summary
 * Get daily/monthly collection summary
 */
router.get('/collection-summary', requirePermission('fees.view'), asyncHandler(async (req, res) => {
  const { date, from_date, to_date, group_by = 'day' } = req.query;

  if (date) {
    // Single day summary
    const summary = await sql`
      SELECT 
        payment_method,
        COUNT(*) as transaction_count,
        SUM(amount) as total_amount
      FROM fee_transactions
      WHERE DATE(paid_at) = ${date}
      GROUP BY payment_method
    `;

    const total = await sql`
      SELECT 
        COUNT(*) as total_transactions,
        COALESCE(SUM(amount), 0) as total_collected
      FROM fee_transactions
      WHERE DATE(paid_at) = ${date}
    `;

    res.json({
      date,
      by_payment_method: summary,
      ...total[0]
    });
  } else if (from_date && to_date) {
    // Range summary
    let summary;
    if (group_by === 'month') {
      summary = await sql`
        SELECT 
          DATE_TRUNC('month', paid_at) as period,
          COUNT(*) as transaction_count,
          SUM(amount) as total_amount
        FROM fee_transactions
        WHERE paid_at BETWEEN ${from_date} AND ${to_date}
        GROUP BY DATE_TRUNC('month', paid_at)
        ORDER BY period
      `;
    } else {
      summary = await sql`
        SELECT 
          DATE(paid_at) as period,
          COUNT(*) as transaction_count,
          SUM(amount) as total_amount
        FROM fee_transactions
        WHERE paid_at BETWEEN ${from_date} AND ${to_date}
        GROUP BY DATE(paid_at)
        ORDER BY period
      `;
    }

    res.json(summary);
  } else {
    // Today's summary by default
    const today = new Date().toISOString().split('T')[0];
    const summary = await sql`
      SELECT 
        COUNT(*) as total_transactions,
        COALESCE(SUM(amount), 0) as total_collected
      FROM fee_transactions
      WHERE DATE(paid_at) = ${today}
    `;

    res.json({ date: today, ...summary[0] });
  }
}));

/**
 * GET /fees/dashboard-stats
 * Get consolidated stats for dashboard
 */
router.get('/dashboard-stats', asyncHandler(async (req, res) => {
  // 1. Today's Collection
  const todayStats = await sql`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM fee_transactions
        WHERE paid_at::date = CURRENT_DATE
    `;

  // 2. Monthly Collection
  const monthlyStats = await sql`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM fee_transactions
        WHERE date_trunc('month', paid_at) = date_trunc('month', CURRENT_DATE)
    `;

  // 3. Pending Dues (Total Outstanding)
  const pendingStats = await sql`
        SELECT COALESCE(SUM(amount_due - amount_paid - discount), 0) as total
        FROM student_fees
        WHERE status IN ('pending', 'partial', 'overdue')
    `;

  // 4. Recent Transactions (Last 5)
  const recentTransactions = await sql`
        SELECT 
            ft.id,
            ft.amount,
            ft.paid_at as collected_at,
            ft.payment_method,
            p.display_name as student_name,
            c.name as class_name,
            ftype.name as fee_type
        FROM fee_transactions ft
        JOIN student_fees sf ON ft.student_fee_id = sf.id
        JOIN students s ON sf.student_id = s.id
        JOIN persons p ON s.person_id = p.id
        LEFT JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        LEFT JOIN classes c ON fs.class_id = c.id
        LEFT JOIN fee_types ftype ON fs.fee_type_id = ftype.id
        ORDER BY ft.paid_at DESC
        LIMIT 5
    `;

  res.json({
    today_collection: Number(todayStats[0].total),
    monthly_collection: Number(monthlyStats[0].total),
    pending_dues: Number(pendingStats[0].total),
    recent_transactions: recentTransactions
  });
}));

/**
 * POST /fees/adjust
 * Apply an adjustment (waiver/discount) to a student fee
 */
router.post('/adjust', requirePermission('fees.manage'), asyncHandler(async (req, res) => {
  const { student_fee_id, amount, reason } = req.body;

  if (!student_fee_id || amount === undefined || !reason) {
    return res.status(400).json({ error: 'student_fee_id, amount, and reason are required' });
  }

  // Check if fee exists
  const [fee] = await sql`
    SELECT id, amount_due, amount_paid, discount 
    FROM student_fees WHERE id = ${student_fee_id}
  `;

  if (!fee) {
    return res.status(404).json({ error: 'Student fee not found' });
  }

  // Validate that discount doesn't exceed amount due
  const newTotalDiscount = Number(fee.discount) + Number(amount);
  if (newTotalDiscount > Number(fee.amount_due)) {
    return res.status(400).json({ error: 'Total discount cannot exceed the amount due' });
  }

  // Update discount (trigger will update status)
  const [updated] = await sql`
    UPDATE student_fees
    SET discount = discount + ${amount},
        updated_at = NOW()
    WHERE id = ${student_fee_id}
    RETURNING *
  `;

  // Log the adjustment in a new audit log or remarks of a virtual transaction?
  // For now, let's assume we might want to record this in an audit log later.
  // We should also ideally store the reason somewhere.

  res.json({ message: 'Adjustment applied successfully', fee: updated });
}));

export default router;
