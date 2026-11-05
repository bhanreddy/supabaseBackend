import express from 'express';
import sql from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { ACTIVE_STUDENT_STATUS_ID } from '../utils/activeStudentFilter.js';
import {
  libraryBookSchema, libraryCopySchema, librarySettingsSchema, libraryIssueSchema,
  libraryReservationSchema, libraryReturnSchema, libraryPaymentSchema,
  DEFAULT_LIBRARY_SETTINGS, libraryOverdueFine, assertLibraryRenewable,
} from '../utils/libraryRules.js';

const router = express.Router();
router.use(requireAuth, requirePermission('library.view'));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
router.param('id', (req, res, next, id) => uuid.test(id) ? next() : res.status(400).json({ error: 'Invalid library record ID.' }));
function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
const endpoint = (fn) => async (req, res, next) => {
  try { return sendSuccess(res, req.schoolId, await fn(req)); }
  catch (error) {
    if (error.name === 'ZodError') return res.status(400).json({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (error.code === '23505') return res.status(409).json({ error: 'This accession number or reservation already exists.' });
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
};
const actor = (req) => req.user.internal_id || req.user.id;
async function audit(tx, req, action, details) {
  await tx`INSERT INTO library_activity (school_id, actor_id, action, details)
    VALUES (${req.schoolId}, ${actor(req)}, ${action}, ${tx.json(details)})`;
}
// All stock/circulation mutations share one school lock. It serializes competing
// issues, reservations, returns and borrower-limit checks across API processes.
const mutate = (req, fn) => sql.begin(async (tx) => {
  await tx`SELECT pg_advisory_xact_lock(1104, ${req.schoolId}::integer)`;
  return fn(tx);
});
async function settings(tx, schoolId) {
  const [row] = await tx`SELECT * FROM library_settings WHERE school_id = ${schoolId}`;
  return row || DEFAULT_LIBRARY_SETTINGS;
}
async function today(tx, schoolId) {
  const [row] = await tx`SELECT to_char(now() AT TIME ZONE COALESCE(
    (SELECT value FROM school_settings WHERE school_id = ${schoolId} AND key = 'school_timezone' LIMIT 1),
    'Asia/Kolkata'), 'YYYY-MM-DD') AS day`;
  return row.day;
}
async function assertBorrower(tx, schoolId, personId) {
  const [row] = await tx`SELECT p.id FROM persons p WHERE p.id = ${personId} AND p.school_id = ${schoolId}
    AND p.deleted_at IS NULL AND (
      EXISTS (SELECT 1 FROM students s WHERE s.person_id = p.id AND s.school_id = ${schoolId}
        AND s.deleted_at IS NULL AND s.status_id = ${ACTIVE_STUDENT_STATUS_ID})
      OR EXISTS (SELECT 1 FROM staff st WHERE st.person_id = p.id AND st.school_id = ${schoolId} AND st.deleted_at IS NULL))`;
  if (!row) fail('Choose an active student or staff member from this school.', 400);
}
async function assertBook(tx, schoolId, bookId) {
  const [row] = await tx`SELECT * FROM library_books WHERE id = ${bookId} AND school_id = ${schoolId} AND deleted_at IS NULL`;
  if (!row) fail('Book not found.', 404);
  return row;
}

router.get('/settings', endpoint((req) => settings(sql, req.schoolId)));
router.put('/settings', requirePermission('library.manage'), endpoint(async (req) => {
  const data = librarySettingsSchema.parse(req.body);
  return mutate(req, async (tx) => {
    const [row] = await tx`INSERT INTO library_settings (school_id, loan_days, max_loans, max_renewals, fine_per_day)
      VALUES (${req.schoolId}, ${data.loan_days}, ${data.max_loans}, ${data.max_renewals}, ${data.fine_per_day})
      ON CONFLICT (school_id) DO UPDATE SET loan_days = EXCLUDED.loan_days, max_loans = EXCLUDED.max_loans,
        max_renewals = EXCLUDED.max_renewals, fine_per_day = EXCLUDED.fine_per_day RETURNING *`;
    await audit(tx, req, 'settings.updated', data);
    return row;
  });
}));

router.get('/classes', endpoint((req) => sql`
  SELECT DISTINCT cs.id AS class_section_id, cs.class_id, cs.section_id,
    c.name || ' - ' || sec.name AS label
  FROM class_sections cs JOIN classes c ON c.id = cs.class_id AND c.school_id = cs.school_id AND c.deleted_at IS NULL
  JOIN sections sec ON sec.id = cs.section_id AND sec.school_id = cs.school_id AND sec.deleted_at IS NULL
  WHERE cs.school_id = ${req.schoolId} AND cs.deleted_at IS NULL ORDER BY label`));

router.get('/students', endpoint(async (req) => {
  const { search = '', class_id, section_id } = req.query;
  if ((class_id && !uuid.test(class_id)) || (section_id && !uuid.test(section_id))) fail('Invalid class or section.', 400);
  const rows = await sql`SELECT DISTINCT s.id, s.person_id, p.display_name, s.admission_no, p.photo_url
    FROM students s JOIN persons p ON p.id = s.person_id AND p.school_id = s.school_id AND p.deleted_at IS NULL
    WHERE s.school_id = ${req.schoolId} AND s.deleted_at IS NULL AND s.status_id = ${ACTIVE_STUDENT_STATUS_ID}
      AND (p.display_name ILIKE ${`%${String(search).slice(0, 100)}%`} OR s.admission_no ILIKE ${`%${String(search).slice(0, 100)}%`})
      ${class_id || section_id ? sql`AND EXISTS (SELECT 1 FROM student_enrollments se
        JOIN class_sections cs ON cs.id = se.class_section_id AND cs.school_id = se.school_id AND cs.deleted_at IS NULL
        WHERE se.student_id = s.id AND se.school_id = ${req.schoolId} AND se.status = 'active' AND se.deleted_at IS NULL
        ${class_id ? sql`AND cs.class_id = ${class_id}` : sql``}
        ${section_id ? sql`AND cs.section_id = ${section_id}` : sql``})` : sql``}
    ORDER BY p.display_name LIMIT 500`;
  return rows;
}));
router.get('/borrowers', endpoint((req) => sql`
  SELECT p.id, p.display_name,
    COALESCE(s.admission_no, st.staff_code) AS code,
    CASE WHEN s.id IS NOT NULL THEN 'Student' ELSE 'Staff' END AS kind
  FROM persons p
  LEFT JOIN students s ON s.person_id = p.id AND s.school_id = p.school_id AND s.deleted_at IS NULL AND s.status_id = ${ACTIVE_STUDENT_STATUS_ID}
  LEFT JOIN staff st ON st.person_id = p.id AND st.school_id = p.school_id AND st.deleted_at IS NULL
  WHERE p.school_id = ${req.schoolId} AND p.deleted_at IS NULL AND (s.id IS NOT NULL OR st.id IS NOT NULL)
    AND (p.display_name ILIKE ${`%${String(req.query.search || '').slice(0, 100)}%`}
      OR s.admission_no ILIKE ${`%${String(req.query.search || '').slice(0, 100)}%`}
      OR st.staff_code ILIKE ${`%${String(req.query.search || '').slice(0, 100)}%`})
  ORDER BY p.display_name LIMIT 50`));

router.get('/books', endpoint(async (req) => {
  const page = Math.max(1, Math.trunc(Number(req.query.page) || 1));
  const search = `%${String(req.query.search || '').slice(0, 100)}%`;
  const rows = await sql`SELECT b.*, count(*) OVER()::int AS total,
    (SELECT count(*)::int FROM library_copies cp WHERE cp.school_id = b.school_id AND cp.book_id = b.id) AS copies,
    (SELECT count(*)::int FROM library_copies cp WHERE cp.school_id = b.school_id AND cp.book_id = b.id AND cp.status = 'available') AS available
    FROM library_books b WHERE b.school_id = ${req.schoolId} AND b.deleted_at IS NULL
      AND (b.title ILIKE ${search} OR b.author ILIKE ${search} OR b.isbn ILIKE ${search} OR b.category ILIKE ${search}
        OR EXISTS (SELECT 1 FROM library_copies cp WHERE cp.school_id = b.school_id AND cp.book_id = b.id AND cp.accession_no ILIKE ${search}))
    ORDER BY b.title, b.id LIMIT 50 OFFSET ${(page - 1) * 50}`;
  return { rows, total: rows[0]?.total || 0, page };
}));
router.get('/books/:id/copies', endpoint(async (req) => {
  await assertBook(sql, req.schoolId, req.params.id);
  return sql`SELECT * FROM library_copies WHERE school_id = ${req.schoolId} AND book_id = ${req.params.id} ORDER BY accession_no`;
}));
router.post('/books', requirePermission('library.manage'), endpoint(async (req) => {
  const data = libraryBookSchema.parse(req.body);
  return mutate(req, async (tx) => {
    const [book] = await tx`INSERT INTO library_books (school_id, title, author, isbn, category, publisher)
      VALUES (${req.schoolId}, ${data.title}, ${data.author}, ${data.isbn}, ${data.category}, ${data.publisher}) RETURNING *`;
    await audit(tx, req, 'book.created', { book_id: book.id, ...data });
    return book;
  });
}));
router.put('/books/:id', requirePermission('library.manage'), endpoint(async (req) => {
  const data = libraryBookSchema.parse(req.body);
  return mutate(req, async (tx) => {
    await assertBook(tx, req.schoolId, req.params.id);
    const [book] = await tx`UPDATE library_books SET title = ${data.title}, author = ${data.author}, isbn = ${data.isbn},
      category = ${data.category}, publisher = ${data.publisher}, updated_at = now()
      WHERE id = ${req.params.id} AND school_id = ${req.schoolId} RETURNING *`;
    await audit(tx, req, 'book.updated', { book_id: book.id, ...data });
    return book;
  });
}));
router.delete('/books/:id', requirePermission('library.manage'), endpoint((req) => mutate(req, async (tx) => {
  await assertBook(tx, req.schoolId, req.params.id);
  const [active] = await tx`SELECT 1 FROM library_copies WHERE school_id = ${req.schoolId} AND book_id = ${req.params.id} AND status = 'loaned'
    UNION ALL SELECT 1 FROM library_reservations WHERE school_id = ${req.schoolId} AND book_id = ${req.params.id} AND closed_at IS NULL LIMIT 1`;
  if (active) fail('Return all loans and close reservations before archiving this title.');
  await tx`UPDATE library_books SET deleted_at = now() WHERE id = ${req.params.id} AND school_id = ${req.schoolId}`;
  await tx`UPDATE library_copies SET status = 'withdrawn' WHERE book_id = ${req.params.id} AND school_id = ${req.schoolId}`;
  await audit(tx, req, 'book.archived', { book_id: req.params.id });
  return { archived: true };
})));
router.post('/books/:id/copies', requirePermission('library.manage'), endpoint(async (req) => {
  const data = libraryCopySchema.parse(req.body);
  return mutate(req, async (tx) => {
    await assertBook(tx, req.schoolId, req.params.id);
    const [copy] = await tx`INSERT INTO library_copies (school_id, book_id, accession_no, shelf)
      VALUES (${req.schoolId}, ${req.params.id}, ${data.accession_no}, ${data.shelf}) RETURNING *`;
    await audit(tx, req, 'copy.created', copy);
    return copy;
  });
}));
router.put('/copies/:id', requirePermission('library.manage'), endpoint(async (req) => {
  const { status, shelf } = req.body;
  if (!['available', 'lost', 'damaged', 'withdrawn'].includes(status) || typeof shelf !== 'string' || shelf.length > 100) fail('Invalid copy status or shelf.', 400);
  return mutate(req, async (tx) => {
    const [copy] = await tx`UPDATE library_copies cp SET status = ${status}, shelf = ${shelf.trim()}
      WHERE cp.id = ${req.params.id} AND cp.school_id = ${req.schoolId} AND cp.status <> 'loaned'
        AND EXISTS (SELECT 1 FROM library_books b WHERE b.id = cp.book_id AND b.school_id = cp.school_id AND b.deleted_at IS NULL) RETURNING cp.*`;
    if (!copy) fail('Copy is unavailable or on loan. Return it before updating stock.');
    await audit(tx, req, 'copy.updated', copy);
    return copy;
  });
}));

router.get('/loans', endpoint(async (req) => {
  const day = await today(sql, req.schoolId);
  const page = Math.max(1, Math.trunc(Number(req.query.page) || 1));
  const search = `%${String(req.query.search || '').slice(0, 100)}%`;
  const rows = await sql`SELECT l.*, to_char(l.due_date, 'YYYY-MM-DD') AS due_date,
    b.title, cp.accession_no, p.display_name AS borrower_name, count(*) OVER()::int AS total,
    CASE WHEN l.returned_at IS NULL THEN greatest(0, ${day}::date - l.due_date) * l.fine_per_day ELSE l.fine_amount END AS current_fine
    FROM library_loans l JOIN library_copies cp ON cp.id = l.copy_id AND cp.school_id = l.school_id
    JOIN library_books b ON b.id = cp.book_id AND b.school_id = l.school_id
    JOIN persons p ON p.id = l.borrower_person_id AND p.school_id = l.school_id
    WHERE l.school_id = ${req.schoolId}
      ${req.query.status === 'history' ? sql`AND l.returned_at IS NOT NULL` : req.query.status === 'fines' ? sql`AND l.fine_amount > l.fine_paid` : sql`AND l.returned_at IS NULL`}
      ${req.query.status === 'overdue' ? sql`AND l.due_date < ${day}::date` : sql``}
      AND (b.title ILIKE ${search} OR p.display_name ILIKE ${search} OR cp.accession_no ILIKE ${search})
    ORDER BY l.due_date, l.id LIMIT 50 OFFSET ${(page - 1) * 50}`;
  return { rows, total: rows[0]?.total || 0, page, today: day };
}));
router.post('/loans', requirePermission('library.manage'), endpoint(async (req) => {
  const data = libraryIssueSchema.parse(req.body);
  return mutate(req, async (tx) => {
    await assertBorrower(tx, req.schoolId, data.borrower_person_id);
    const policy = await settings(tx, req.schoolId);
    const day = await today(tx, req.schoolId);
    const [copy] = await tx`SELECT cp.* FROM library_copies cp JOIN library_books b ON b.id = cp.book_id AND b.school_id = cp.school_id
      WHERE cp.id = ${data.copy_id} AND cp.school_id = ${req.schoolId} AND b.deleted_at IS NULL`;
    if (!copy || copy.status !== 'available') fail('This copy is no longer available.');
    const [counts] = await tx`SELECT count(*)::int AS active, count(*) FILTER (WHERE due_date < ${day}::date)::int AS overdue
      FROM library_loans WHERE school_id = ${req.schoolId} AND borrower_person_id = ${data.borrower_person_id} AND returned_at IS NULL`;
    if (counts.active >= policy.max_loans) fail('This borrower has reached the loan limit.');
    if (counts.overdue > 0) fail('Return overdue books before borrowing again.');
    const [hold] = await tx`SELECT * FROM library_reservations WHERE school_id = ${req.schoolId}
      AND book_id = ${copy.book_id} AND closed_at IS NULL ORDER BY created_at, id LIMIT 1`;
    if (hold && hold.borrower_person_id !== data.borrower_person_id) fail('This title is reserved for another borrower.');
    const [loan] = await tx`INSERT INTO library_loans (school_id, copy_id, borrower_person_id, due_date, fine_per_day, issued_by)
      VALUES (${req.schoolId}, ${copy.id}, ${data.borrower_person_id}, ${day}::date + ${policy.loan_days}::integer, ${policy.fine_per_day}, ${actor(req)}) RETURNING *`;
    await tx`UPDATE library_copies SET status = 'loaned' WHERE id = ${copy.id} AND school_id = ${req.schoolId}`;
    if (hold) await tx`UPDATE library_reservations SET closed_at = now() WHERE id = ${hold.id} AND school_id = ${req.schoolId}`;
    await audit(tx, req, 'loan.issued', { loan_id: loan.id, ...data });
    return loan;
  });
}));
router.post('/loans/:id/renew', requirePermission('library.manage'), endpoint((req) => mutate(req, async (tx) => {
  const [loan] = await tx`SELECT l.*, to_char(l.due_date, 'YYYY-MM-DD') AS due_date, cp.book_id
    FROM library_loans l JOIN library_copies cp ON cp.id = l.copy_id AND cp.school_id = l.school_id
    WHERE l.id = ${req.params.id} AND l.school_id = ${req.schoolId}`;
  if (!loan) fail('Loan not found.', 404);
  await assertBorrower(tx, req.schoolId, loan.borrower_person_id);
  const policy = await settings(tx, req.schoolId);
  const day = await today(tx, req.schoolId);
  const [hold] = await tx`SELECT 1 FROM library_reservations WHERE school_id = ${req.schoolId} AND book_id = ${loan.book_id}
    AND closed_at IS NULL AND borrower_person_id <> ${loan.borrower_person_id} LIMIT 1`;
  const error = assertLibraryRenewable(loan, policy, day, !!hold);
  if (error) fail(error);
  const [updated] = await tx`UPDATE library_loans SET due_date = due_date + ${policy.loan_days}::integer, renewal_count = renewal_count + 1
    WHERE id = ${loan.id} AND school_id = ${req.schoolId} RETURNING *`;
  await audit(tx, req, 'loan.renewed', { loan_id: loan.id });
  return updated;
})));
router.post('/loans/:id/return', requirePermission('library.manage'), endpoint(async (req) => {
  const { condition } = libraryReturnSchema.parse(req.body);
  return mutate(req, async (tx) => {
    const [loan] = await tx`SELECT *, to_char(due_date, 'YYYY-MM-DD') AS due_date FROM library_loans WHERE id = ${req.params.id} AND school_id = ${req.schoolId}`;
    if (!loan) fail('Loan not found.', 404);
    if (loan.returned_at) fail('This loan has already been returned.');
    const fine = libraryOverdueFine(loan.due_date, await today(tx, req.schoolId), loan.fine_per_day);
    const [updated] = await tx`UPDATE library_loans SET returned_at = now(), returned_by = ${actor(req)}, return_condition = ${condition}, fine_amount = ${fine}
      WHERE id = ${loan.id} AND school_id = ${req.schoolId} RETURNING *`;
    await tx`UPDATE library_copies SET status = ${condition} WHERE id = ${loan.copy_id} AND school_id = ${req.schoolId}`;
    await audit(tx, req, 'loan.returned', { loan_id: loan.id, condition, fine });
    return updated;
  });
}));
router.post('/loans/:id/payment', requirePermission('library.manage'), endpoint(async (req) => {
  const { amount } = libraryPaymentSchema.parse(req.body);
  return mutate(req, async (tx) => {
    const [loan] = await tx`UPDATE library_loans SET fine_paid = fine_paid + ${amount}
      WHERE id = ${req.params.id} AND school_id = ${req.schoolId} AND returned_at IS NOT NULL AND fine_paid + ${amount} <= fine_amount RETURNING *`;
    if (!loan) fail('Payment exceeds the outstanding fine or this loan has not been returned.');
    await audit(tx, req, 'fine.payment', { loan_id: loan.id, amount });
    return loan;
  });
}));

router.get('/reservations', endpoint((req) => sql`SELECT r.*, b.title, p.display_name AS borrower_name
  FROM library_reservations r JOIN library_books b ON b.id = r.book_id AND b.school_id = r.school_id
  JOIN persons p ON p.id = r.borrower_person_id AND p.school_id = r.school_id
  WHERE r.school_id = ${req.schoolId} AND r.closed_at IS NULL ORDER BY r.created_at, r.id`));
router.post('/reservations', requirePermission('library.manage'), endpoint(async (req) => {
  const data = libraryReservationSchema.parse(req.body);
  return mutate(req, async (tx) => {
    await assertBook(tx, req.schoolId, data.book_id);
    await assertBorrower(tx, req.schoolId, data.borrower_person_id);
    const [row] = await tx`INSERT INTO library_reservations (school_id, book_id, borrower_person_id)
      VALUES (${req.schoolId}, ${data.book_id}, ${data.borrower_person_id}) RETURNING *`;
    await audit(tx, req, 'reservation.created', { reservation_id: row.id, ...data });
    return row;
  });
}));
router.delete('/reservations/:id', requirePermission('library.manage'), endpoint((req) => mutate(req, async (tx) => {
  const [row] = await tx`UPDATE library_reservations SET closed_at = now() WHERE id = ${req.params.id} AND school_id = ${req.schoolId} AND closed_at IS NULL RETURNING *`;
  if (!row) fail('Reservation not found.', 404);
  await audit(tx, req, 'reservation.closed', { reservation_id: row.id });
  return { closed: true };
})));
router.get('/reports', endpoint(async (req) => {
  const day = await today(sql, req.schoolId);
  const [inventory, circulation, activity] = await Promise.all([
    sql`SELECT cp.status, count(*)::int AS count FROM library_copies cp WHERE cp.school_id = ${req.schoolId} GROUP BY cp.status ORDER BY cp.status`,
    sql`SELECT count(*) FILTER (WHERE returned_at IS NULL)::int AS active_loans,
      count(*) FILTER (WHERE returned_at IS NULL AND due_date < ${day}::date)::int AS overdue,
      count(*) FILTER (WHERE returned_at IS NOT NULL)::int AS returned,
      COALESCE(sum(fine_amount - fine_paid),0) AS outstanding_fines, COALESCE(sum(fine_paid),0) AS collected_fines,
      count(DISTINCT borrower_person_id)::int AS borrowers FROM library_loans WHERE school_id = ${req.schoolId}`,
    sql`SELECT a.id, a.action, a.details, a.created_at, p.display_name AS actor_name FROM library_activity a
      LEFT JOIN users u ON u.id = a.actor_id AND u.school_id = a.school_id
      LEFT JOIN persons p ON p.id = u.person_id AND p.school_id = a.school_id
      WHERE a.school_id = ${req.schoolId} ORDER BY a.created_at DESC LIMIT 50`,
  ]);
  return { today: day, inventory, ...circulation[0], activity };
}));

export default router;
