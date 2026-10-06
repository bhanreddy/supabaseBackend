import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import express from 'express';
import XLSX from 'xlsx';
import { createFeeRecoveryFixture } from './support/feeRecoveryDatabase.js';

// Only an explicitly supplied local database is permitted. Never use .env.
const url = process.env.ARREARS_TEST_DATABASE_URL;
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw new Error('Set ARREARS_TEST_DATABASE_URL to a local PostgreSQL admin connection');
}
const admin = postgres(url, { ssl: false, max: 1, onnotice() {} });
const database = `schoolims_arrears_test_${process.pid}`;
await admin.unsafe(`CREATE DATABASE ${database}`);
const localUrl = new URL(url);
localUrl.pathname = `/${database}`;
const db = postgres(localUrl.toString(), { ssl: false, max: 8, onnotice() {} });
mock.module('../db.js', { defaultExport: db, namedExports: { supabase: {}, supabaseAdmin: {} } });
const pass = (req, res, next) => next();
mock.module('../middleware/auth.js', { namedExports: {
  verifyToken: pass, requireAuth: pass, requirePermission: () => pass, requireAnyPermission: () => pass,
} });
mock.module('../middleware/requireRole.js', { namedExports: { requireRole: () => pass } });
mock.module('../services/notificationService.js', { namedExports: {
  sendNotificationToUsers: async () => { throw new Error('Unexpected notification'); },
  sendNotificationToUsersWithReport: async () => { throw new Error('Unexpected notification'); },
} });
mock.module('../services/geminiTranslator.js', { namedExports: {
  translateFields: async (value) => value, getTranslationStats: async () => ({}), probeTranslation: async () => ({}),
} });
mock.module('../routes/feeRecoveryRoutes.js', { defaultExport: express.Router() });
mock.module('../services/fineService.js', { namedExports: {
  listStudentFinesForLedger: async () => [], allocateFinePaymentsToReceipt: async () => [],
} });

let server, base, school, otherSchool, requestSchool, requestCollector, today;
async function seedSchool(id) {
  await db`INSERT INTO schools(id, name, code) VALUES (${id}, ${'Arrears Test ' + id}, ${String(id)})`;
  const [year] = await db`INSERT INTO academic_years(school_id, code, start_date, end_date)
    VALUES (${id}, '2026-27', '2026-04-01', '2027-03-31') RETURNING id`;
  const [person] = await db`INSERT INTO persons(school_id, first_name, display_name, gender_id)
    VALUES (${id}, 'Student', 'Test Student', 1) RETURNING id`;
  const [student] = await db`INSERT INTO students(school_id, person_id, admission_no, admission_date, status_id)
    VALUES (${id}, ${person.id}, 'ADM-1', '2026-04-01', 1) RETURNING id`;
  const [collectorPerson] = await db`INSERT INTO persons(school_id, first_name, display_name, gender_id)
    VALUES (${id}, 'Collector', ${'Collector ' + id}, 1) RETURNING id`;
  const [collector] = await db`INSERT INTO users(school_id, person_id) VALUES (${id}, ${collectorPerson.id}) RETURNING id`;
  const [due] = await db`INSERT INTO defaulter_dues(school_id, student_id, due_academic_year, original_amount, source)
    VALUES (${id}, ${student.id}, '2025-26', 2000, 'manual_legacy') RETURNING id`;
  return { id, student: student.id, collector: collector.id, due: due.id, year: year.id };
}
async function api(path, body) {
  const response = await fetch(base + path, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : {});
  const payload = await response.json();
  assert.equal(response.status, body ? 201 : 200, JSON.stringify(payload));
  return payload.data;
}
async function collect(target, amount, payment_method = 'cash') {
  requestSchool = target.id;
  requestCollector = target.collector;
  return api(`/defaulters/${target.due}/collect`, { amount, payment_method, transaction_ref: randomUUID() });
}

test.before(async () => {
  await createFeeRecoveryFixture(db);
  await db.unsafe("ALTER TABLE fee_types ADD COLUMN name_te text; ALTER TABLE schools ADD COLUMN IF NOT EXISTS accounts_dashboard_config jsonb");
  // Use deployed table definitions for the additional report sources.
  const baseline = fs.readFileSync(new URL('../migrations/baselines/20260905_public_schema.sql', import.meta.url), 'utf8');
  const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  await db.unsafe("CREATE TYPE public.transport_billing_cycle AS ENUM ('monthly','quarterly','term','annual')");
  for (const name of ['transport_fee', 'transport_fee_payments', 'transport_stops', 'fee_adjustments']) {
    const ddl = baseline.match(new RegExp(`CREATE TABLE public.${name} \\([\\s\\S]*?\\n\\);`));
    assert.ok(ddl, name);
    await db.unsafe(ddl[0]);
  }
  for (const name of ['school_settings', 'approval_requests']) {
    await db.unsafe(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))[0]);
  }
  await db.unsafe("ALTER TABLE schools ADD COLUMN IF NOT EXISTS fee_mode text DEFAULT 'per_class'; ALTER TABLE receipts ADD COLUMN fee_type text DEFAULT 'tuition', ADD COLUMN transport_payment_id uuid;");
  for (const name of ['20260605_create_defaulter_dues.sql', '20260731_school_scoped_receipt_numbers.sql']) {
    const migration = fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replace(/^BEGIN;|^COMMIT;/gm, '');
    await db.begin(tx => tx.unsafe(migration));
  }
  await db`INSERT INTO genders(id, name) VALUES (1, 'Male')`;
  await db`INSERT INTO student_statuses(id, code) VALUES (1, 'active')`;
  school = await seedSchool(1);
  otherSchool = await seedSchool(2);
  requestSchool = school.id;
  requestCollector = school.collector;
  const [{ day }] = await db`SELECT CURRENT_DATE::text AS day`;
  today = day;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.schoolId = requestSchool;
    req.user = { internal_id: requestCollector, schoolId: requestSchool };
    next();
  });
  app.use('/defaulters', (await import('../routes/defaulterRoutes.js')).default);
  app.use('/fees', (await import('../routes/feesRoutes.js')).default);
  app.use('/admin', (await import('../routes/adminRoutes.js')).default);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await db.end();
  await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
  await admin.end();
});

let payment;
test('collecting a previous-year due exposes its existing receipt and full printing data', async () => {
  payment = await collect(school, 350);
  assert.equal(Number(payment.due.paid_amount), 350);
  assert.equal(Number(payment.due.balance), 1650);
  const transactions = await api('/fees/transactions');
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].id, payment.payment.id);
  assert.equal(transactions[0].receipt_no, payment.receipt.receipt_no);
  assert.equal(transactions[0].transaction_source, 'arrears');
  assert.equal(transactions[0].can_delete, false);
  assert.equal(transactions[0].academic_year, '2025-26');
  const details = await api(`/fees/receipts/${payment.receipt.id}`);
  assert.equal(details.items.length, 1);
  assert.equal(Number(details.items[0].amount), 350);
  assert.equal(details.items[0].payment_method, 'cash');
  assert.equal(details.items[0].transaction_ref, payment.payment.transaction_ref);
  assert.equal((await api(`/fees/transactions/${payment.payment.id}/receipt-no`)).receipt_no, payment.receipt.receipt_no);
  const receipts = await api('/fees/receipts');
  assert.equal(receipts[0].fee_type, 'Arrears — 2025-26');
  assert.equal(receipts[0].payment_method, 'cash');
});

test('today and day/month range totals include arrears once and respect school/collector filters', async () => {
  await collect(otherSchool, 900);
  requestSchool = school.id;
  requestCollector = school.collector;
  const ownToday = await api(`/fees/today-collection?received_by=${otherSchool.collector}`);
  assert.equal(ownToday.collector_id, school.collector);
  assert.equal(ownToday.total_collected, 350);
  assert.equal(ownToday.total_transactions, 1);
  assert.equal(ownToday.by_payment_method[0].total_amount, 350);
  assert.equal(ownToday.transactions[0].id, payment.payment.id);
  for (const query of ['', `?date=${today}`, `?from_date=${today}&to_date=${today}T23:59:59`, `?from_date=${today}&to_date=${today}T23:59:59&group_by=month`]) {
    const summary = await api('/fees/collection-summary' + query);
    assert.equal(summary.total_collected, 350);
    assert.equal(summary.total_transactions, 1);
    if (summary.periods) assert.equal(summary.periods[0].total_amount, 350);
  }
  assert.deepEqual(await api(`/fees/transactions?received_by=${otherSchool.collector}`), []);
  assert.deepEqual(await api('/fees/transactions?payment_method=upi'), []);
  assert.deepEqual(await api('/fees/transactions?from_date=2000-01-01&to_date=2000-01-02'), []);
  assert.equal((await api(`/fees/collection-summary?date=${today}&received_by=${otherSchool.collector}`)).total_collected, 0);
  const missing = await fetch(base + `/fees/receipts/${(await db`SELECT id FROM receipts WHERE school_id = 2`)[0].id}`);
  assert.equal(missing.status, 404);
});

test('mixed tuition, transport and arrears collections paginate and total correctly', async () => {
  const [cls] = await db`INSERT INTO classes(school_id, name) VALUES (1, 'Class 1') RETURNING id`;
  const [type] = await db`INSERT INTO fee_types(school_id, name) VALUES (1, 'Tuition') RETURNING id`;
  const [structure] = await db`INSERT INTO fee_structures(school_id, academic_year_id, class_id, fee_type_id, amount)
    VALUES (1, ${school.year}, ${cls.id}, ${type.id}, 1000) RETURNING id`;
  const [fee] = await db`INSERT INTO student_fees(school_id, student_id, fee_structure_id, amount_due)
    VALUES (1, ${school.student}, ${structure.id}, 1000) RETURNING id`;
  await db`INSERT INTO fee_transactions(school_id, student_fee_id, amount, payment_method, transaction_ref, received_by)
    VALUES (1, ${fee.id}, 100, 'cash', 'TUITION-1', ${school.collector})`;
  await db`INSERT INTO transport_fee_payments(school_id, student_id, academic_year, amount, payment_method, transaction_ref, received_by)
    VALUES (1, ${school.student}, '2026-27', 200, 'upi', 'TRANSPORT-1', ${school.collector})`;
  const second = await collect(school, 450, 'upi');
  const rows = await api('/fees/transactions?limit=2');
  const page2 = await api('/fees/transactions?limit=2&page=2');
  assert.equal(rows.length, 2);
  assert.equal(page2.length, 2);
  assert.equal(rows[0].id, second.payment.id);
  assert.equal(new Set([...rows, ...page2].map(row => row.id)).size, 4);
  const todayResult = await api('/fees/today-collection');
  assert.equal(todayResult.total_collected, 1100);
  assert.equal(todayResult.total_transactions, 4);
  assert.deepEqual(Object.fromEntries(todayResult.by_payment_method.map(row => [row.payment_method, row.total_amount])), { cash: 450, upi: 650 });
  const summary = await api(`/fees/collection-summary?date=${today}`);
  assert.equal(summary.total_collected, 1100);
  assert.equal(summary.total_transactions, 4);
  for (const group of ['day', 'month']) {
    const range = await api(`/fees/collection-summary?from_date=${today}&to_date=${today}T23:59:59&group_by=${group}`);
    assert.equal(range.total_collected, 1100);
    assert.equal(range.periods.length, 1);
    assert.equal(range.periods[0].total_amount, 1100);
    assert.equal(range.periods[0].transaction_count, 4);
  }
});

test('finance stats and receipt exports include recoveries; cleared/deleted dues retain payment history', async () => {
  const stats = await api(`/admin/finance-stats?date=${today}`);
  assert.equal(stats.today_collection, 1100);
  assert.equal(stats.monthly_collection, 1100);
  assert.equal(stats.collected_total, 1100);
  assert.equal(stats.recent_transactions.filter(row => row.transaction_source === 'arrears').length, 2);
  const config = Object.fromEntries(['pending_dues', 'revenue_trend', 'collection_efficiency', 'avg_attendance', 'academic_score', 'system_insights'].map(key => [key, false]));
  await db`UPDATE schools SET accounts_dashboard_config = ${db.json(config)} WHERE id = 1`;
  const { stats: dashboard } = await api('/fees/dashboard-stats?for_accounts=1');
  assert.equal(dashboard.collected_total, 1100);
  assert.equal(dashboard.todays_collection, 1100);
  assert.equal(dashboard.total_collection_month, 1100);
  assert.equal(dashboard.recent_transactions.filter(row => row.transaction_source === 'arrears').length, 2);
  const response = await fetch(base + `/admin/collection-receipts/export?from_date=${today}&to_date=${today}`);
  assert.equal(response.status, 200);
  const workbook = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: 'buffer' });
  const cells = JSON.stringify(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 }));
  assert.ok(cells.includes(payment.receipt.receipt_no));
  assert.ok(cells.includes('Arrears — 2025-26'));
  await collect(school, 1200);
  await db`UPDATE defaulter_dues SET deleted_at = now() WHERE id = ${school.due}`;
  assert.equal((await api('/fees/transactions')).filter(row => row.transaction_source === 'arrears').length, 3);
  assert.equal((await api(`/fees/receipts/${payment.receipt.id}`)).items.length, 1);
});

test('historical collections retain date and collector filtering independently of the due year', async () => {
  const [person] = await db`INSERT INTO persons(school_id, first_name, display_name, gender_id)
    VALUES (1, 'Second', 'Second Collector', 1) RETURNING id`;
  const [collector] = await db`INSERT INTO users(school_id, person_id) VALUES (1, ${person.id}) RETURNING id`;
  const [due] = await db`INSERT INTO defaulter_dues(school_id, student_id, due_academic_year, original_amount, source)
    VALUES (1, ${school.student}, '2024-25', 1000, 'carried_forward') RETURNING id`;
  const recovery = await collect({ ...school, collector: collector.id, due: due.id }, 125, 'upi');
  const [{ day }] = await db`SELECT (CURRENT_DATE - INTERVAL '1 month')::date::text AS day`;
  await db`UPDATE defaulter_payments SET paid_at = ${day + 'T23:59:59'}::timestamptz WHERE id = ${recovery.payment.id}`;
  requestCollector = school.collector;
  const rows = await api(`/fees/transactions?from_date=${day}&to_date=${day}T23:59:59&received_by=${collector.id}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].receipt_no, recovery.receipt.receipt_no);
  assert.equal(rows[0].academic_year, '2024-25');
  const summary = await api(`/fees/collection-summary?date=${day}&received_by=${collector.id}`);
  assert.equal(summary.total_collected, 125);
  assert.equal(summary.by_payment_method[0].total_amount, 125);
  assert.equal((await api(`/fees/collection-summary?date=${day}&received_by=${school.collector}`)).total_collected, 0);
  assert.equal((await api('/fees/today-collection')).total_collected, 2300);
  const response = await fetch(base + `/admin/collection-receipts/export?from_date=${day}&to_date=${day}`);
  assert.equal(response.status, 200);
  const workbook = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: 'buffer' });
  const cells = JSON.stringify(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 }));
  assert.ok(cells.includes(recovery.receipt.receipt_no));
  assert.equal((await api('/fees/collectors')).some(row => row.id === collector.id), true);
});
