import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import postgres from 'postgres';
import express from 'express';

// An explicitly supplied, disposable LOCAL database only. Never use DATABASE_URL.
const url = process.env.LIBRARY_TEST_DATABASE_URL;
test('library API with real PostgreSQL', { skip: !url }, async (t) => {
  const parsed = new URL(url);
  assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname) && /^\/library_test(?:_|$)/.test(parsed.pathname), 'Use a disposable local library_test database');
  const db = postgres(url, { max: 8, onnotice() {} });
  t.after(() => db.end());
  await db.unsafe(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE schools (id integer PRIMARY KEY, name text, is_active boolean DEFAULT true);
    CREATE TABLE roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer REFERENCES schools(id), code text, name text, is_system boolean, deleted_at timestamptz, UNIQUE(school_id,code));
    CREATE TABLE permissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer REFERENCES schools(id), code text, name text, deleted_at timestamptz, UNIQUE(school_id,code));
    CREATE TABLE role_permissions (school_id integer, role_id uuid REFERENCES roles(id), permission_id uuid REFERENCES permissions(id), PRIMARY KEY(role_id,permission_id));
    CREATE TABLE persons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer, display_name text, photo_url text, deleted_at timestamptz);
    CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, school_id integer, account_status text, deleted_at timestamptz);
    CREATE TABLE students (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, school_id integer, admission_no text, status_id integer DEFAULT 1, deleted_at timestamptz);
    CREATE TABLE staff (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, school_id integer, staff_code text, deleted_at timestamptz);
    CREATE TABLE school_settings (school_id integer, key text, value text);
    CREATE TABLE classes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer, name text, deleted_at timestamptz);
    CREATE TABLE sections (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer, name text, deleted_at timestamptz);
    CREATE TABLE class_sections (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer, class_id uuid, section_id uuid, class_teacher_id uuid, deleted_at timestamptz);
    CREATE TABLE student_enrollments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer, student_id uuid, class_section_id uuid, status text, deleted_at timestamptz);
    CREATE TABLE timetable_slots (class_section_id uuid, teacher_id uuid, deleted_at timestamptz);
    CREATE TABLE class_subjects (class_section_id uuid, teacher_id uuid, school_id integer, deleted_at timestamptz);
    CREATE TABLE complaints (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), school_id integer, title text, title_te text, description text, description_te text, category text, priority text, raised_by uuid, raised_for_student_id uuid);
    INSERT INTO schools(id,name) VALUES (1,'One'),(2,'Two');
    INSERT INTO roles(school_id,code,name) SELECT s.id,v,v FROM schools s CROSS JOIN unnest(ARRAY['admin','principal','staff']) v;
    CREATE FUNCTION test_seed_default_roles() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO roles(school_id,code,name) SELECT NEW.id,v,v FROM unnest(ARRAY['admin','principal','staff']) v;
      RETURN NEW;
    END $$;
    CREATE TRIGGER trg_school_seed_defaults AFTER INSERT ON schools FOR EACH ROW EXECUTE FUNCTION test_seed_default_roles();`);
  const migration = await fs.readFile(new URL('../migrations/20261104_librarian_library.sql', import.meta.url), 'utf8');
  await db.begin((tx) => tx.unsafe(migration.replace(/^BEGIN;|^COMMIT;/gm, '')));
  await db.begin((tx) => tx.unsafe(migration.replace(/^BEGIN;|^COMMIT;/gm, '')));
  mock.module('../db.js', { defaultExport: db, namedExports: { supabase: {}, supabaseAdmin: {}, createRequestAuthClient: () => ({}) } });
  mock.module('../config/env.js', { defaultExport: { nodeEnv: 'test' } });
  mock.module('../services/staffDeviceService.js', { namedExports: { enforceStaffDeviceProof: async () => true } });
  mock.module('../services/geminiTranslator.js', { namedExports: { translateFields: async () => ({}) } });
  mock.module('../services/notificationService.js', { namedExports: { sendNotificationToUsers: async () => {} } });
  const { default: libraryRouter } = await import('../routes/libraryRoutes.js');
  const { default: complaintsRouter } = await import('../routes/complaintsRoutes.js');
  const { requireSchoolId } = await import('../middleware/schoolId.js');
  const { ACTIVE_STUDENT_STATUS_ID } = await import('../utils/activeStudentFilter.js');
  const [operator] = await db`INSERT INTO users (school_id, account_status) VALUES (1,'active') RETURNING id`;
  const [p1] = await db`INSERT INTO persons (school_id,display_name) VALUES (1,'Reader One') RETURNING id`;
  const [p2] = await db`INSERT INTO persons (school_id,display_name) VALUES (1,'Reader Two') RETURNING id`;
  const [pOther] = await db`INSERT INTO persons (school_id,display_name) VALUES (2,'Other School') RETURNING id`;
  const [student] = await db`INSERT INTO students (school_id,person_id,admission_no,status_id) VALUES (1,${p1.id},'S001',${ACTIVE_STUDENT_STATUS_ID}) RETURNING id`;
  await db`INSERT INTO students (school_id,person_id,admission_no,status_id) VALUES (1,${p2.id},'S002',${ACTIVE_STUDENT_STATUS_ID}), (2,${pOther.id},'X001',${ACTIVE_STUDENT_STATUS_ID})`;
  const [classRow] = await db`INSERT INTO classes(school_id,name) VALUES (1,'Class 1') RETURNING id`;
  const [section] = await db`INSERT INTO sections(school_id,name) VALUES (1,'A') RETURNING id`;
  const [cs] = await db`INSERT INTO class_sections(school_id,class_id,section_id) VALUES (1,${classRow.id},${section.id}) RETURNING id`;
  await db`INSERT INTO student_enrollments(school_id,student_id,class_section_id,status) VALUES (1,${student.id},${cs.id},'active')`;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const role = req.headers['x-test-role'] || 'librarian';
    req.user = role === 'anonymous' ? null : { id: operator.id, internal_id: operator.id, person_id: p1.id, schoolId: 1,
      roles: [role], permissions: role === 'librarian' ? ['library.view','library.manage','complaints.view','complaints.create'] : role === 'staff' ? ['complaints.view','complaints.create'] : [] };
    next();
  });
  app.use(requireSchoolId);
  app.use('/api/v1/library', libraryRouter);
  app.use('/api/v1/complaints', complaintsRouter);
  app.use((error, req, res, next) => { res.status(500).json({ error: error.message }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function call(path, method = 'GET', body, role = 'librarian') {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-test-role': role }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    return { status: response.status, ...data };
  }
  let book, copy, loan;
  await t.test('migration seeds roles idempotently and for new schools', async () => {
    assert.equal((await db`SELECT * FROM roles WHERE code = 'librarian'`).length, 2);
    await db`INSERT INTO schools(id,name) VALUES (3,'New School')`;
    assert.equal((await db`SELECT * FROM role_permissions WHERE school_id = 3`).length, 8);
    assert.equal((await db`SELECT * FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE r.code='principal' AND r.school_id=3`).length, 2);
    assert.equal((await db`SELECT * FROM role_permissions rp JOIN roles r ON r.id=rp.role_id WHERE r.code='librarian' AND r.school_id=1`).length, 4);
  });
  await t.test('denies anonymous, students and teaching staff; uses JWT school', async () => {
    assert.equal((await call('/library/books', 'GET', null, 'anonymous')).status, 401);
    assert.equal((await call('/library/books', 'GET', null, 'student')).status, 403);
    assert.equal((await call('/library/books', 'GET', null, 'staff')).status, 403);
    const result = await call('/library/books?school_id=2');
    assert.equal(result.status, 200); assert.equal(String(result.school_id), '1');
  });
  await t.test('catalog creates, edits, searches and inventories accessioned copies', async () => {
    book = (await call('/library/books', 'POST', { title: 'Stories', author: 'Author' })).data;
    assert.ok(book.id);
    copy = (await call(`/library/books/${book.id}/copies`, 'POST', { accession_no: 'LIB001', shelf: 'A1' })).data;
    assert.ok(copy.id);
    assert.equal((await call(`/library/books/${book.id}/copies`, 'POST', { accession_no: 'LIB001' })).status, 409);
    assert.equal((await call(`/library/books/${book.id}`, 'PUT', { title: 'Stories', author: 'Writer', category: 'Fiction' })).status, 200);
    const result = await call('/library/books?search=LIB001');
    assert.equal(result.data.rows[0].available, 1); assert.equal(result.data.rows[0].author, 'Writer');
    assert.equal((await call('/library/classes')).data.length, 1);
    assert.equal((await call('/library/students?class_id=' + classRow.id)).data[0].id, student.id);
    assert.equal((await call('/library/borrowers?search=Other')).data.length, 0);
  });
  await t.test('rejects cross-school borrower and copy references', async () => {
    assert.equal((await call('/library/loans', 'POST', { copy_id: copy.id, borrower_person_id: pOther.id })).status, 400);
    const [foreignBook] = await db`INSERT INTO library_books(school_id,title,author) VALUES (2,'Other','Other') RETURNING id`;
    assert.equal((await call(`/library/books/${foreignBook.id}/copies`)).status, 404);
    assert.equal((await call(`/library/books/${foreignBook.id}`, 'PUT', { title: 'Hack', author: 'Hack' })).status, 404);
  });
  await t.test('concurrent issue attempts lend one physical copy exactly once', async () => {
    const results = await Promise.all([p1,p2].map((p) => call('/library/loans', 'POST', { copy_id: copy.id, borrower_person_id: p.id })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200,409]);
    loan = results.find((r) => r.status === 200).data;
    assert.equal((await call(`/library/copies/${copy.id}`, 'PUT', { status: 'available', shelf: 'A' })).status, 409);
    assert.equal((await call(`/library/books/${book.id}`, 'DELETE')).status, 409);
  });
  await t.test('reservation blocks renewal and is fulfilled only in queue order', async () => {
    const nextBorrower = loan.borrower_person_id === p1.id ? p2 : p1;
    assert.equal((await call('/library/reservations', 'POST', { book_id: book.id, borrower_person_id: nextBorrower.id })).status, 200);
    assert.equal((await call(`/library/loans/${loan.id}/renew`, 'POST', {})).status, 409);
    assert.equal((await call(`/library/loans/${loan.id}/return`, 'POST', {})).status, 200);
    assert.equal((await call(`/library/loans/${loan.id}/return`, 'POST', {})).status, 409);
    assert.equal((await call('/library/loans', 'POST', { copy_id: copy.id, borrower_person_id: loan.borrower_person_id })).status, 409);
    loan = (await call('/library/loans', 'POST', { copy_id: copy.id, borrower_person_id: nextBorrower.id })).data;
    assert.ok(loan.id); assert.equal((await call('/library/reservations')).data.length, 0);
  });
  await t.test('renewal limit and borrower loan limit are enforced', async () => {
    assert.equal((await call('/library/settings', 'PUT', { loan_days: 7, max_loans: 1, max_renewals: 1, fine_per_day: 2.5 })).status, 200);
    assert.equal((await call(`/library/loans/${loan.id}/renew`, 'POST', {})).status, 200);
    assert.equal((await call(`/library/loans/${loan.id}/renew`, 'POST', {})).status, 409);
    const extra = (await call(`/library/books/${book.id}/copies`, 'POST', { accession_no: 'LIB002' })).data;
    assert.equal((await call('/library/loans', 'POST', { copy_id: extra.id, borrower_person_id: loan.borrower_person_id })).status, 409);
  });
  await t.test('school-local overdue fine, damaged stock, and partial payments are consistent', async () => {
    await db`UPDATE library_loans SET due_date = (now() AT TIME ZONE 'Asia/Kolkata')::date - 3, fine_per_day=2.35 WHERE id=${loan.id}`;
    assert.equal((await call('/library/loans?status=overdue')).data.rows.length, 1);
    assert.equal((await call(`/library/loans/${loan.id}/renew`, 'POST', {})).status, 409);
    const returned = await call(`/library/loans/${loan.id}/return`, 'POST', { condition: 'damaged' });
    assert.equal(Number(returned.data.fine_amount), 7.05);
    assert.equal((await call(`/library/loans/${loan.id}/payment`, 'POST', { amount: 8 })).status, 409);
    assert.equal((await call(`/library/loans/${loan.id}/payment`, 'POST', { amount: 2.05 })).status, 200);
    assert.equal((await call(`/library/loans/${loan.id}/payment`, 'POST', { amount: 5 })).status, 200);
    assert.equal((await call('/library/loans?status=fines')).data.rows.length, 0);
    const report = (await call('/library/reports')).data;
    assert.equal(Number(report.collected_fines), 7.05); assert.equal(Number(report.outstanding_fines), 0);
    assert.ok(report.activity.some((v) => v.action === 'fine.payment'));
    assert.equal((await call(`/library/books/${book.id}/copies`)).data.find((v) => v.id === copy.id).status, 'damaged');
  });
  await t.test('librarian complaints cover any active class while teachers remain assignment-bound', async () => {
    const body = { title: 'Book damage', description: 'Library book was damaged', raised_for_student_id: student.id };
    assert.equal((await call('/complaints', 'POST', body)).status, 201);
    const [unassigned] = await db`SELECT id FROM students WHERE person_id=${p2.id}`;
    assert.equal((await call('/complaints', 'POST', { ...body, raised_for_student_id: unassigned.id })).status, 201);
    assert.equal((await call('/complaints', 'POST', body, 'staff')).status, 403);
    const [foreignStudent] = await db`SELECT id FROM students WHERE school_id=2 LIMIT 1`;
    assert.equal((await call('/complaints', 'POST', { ...body, raised_for_student_id: foreignStudent.id })).status, 400);
    assert.equal((await call('/complaints/bulk', 'POST', { ...body, raised_for_student_ids: [student.id] })).status, 201);
  });
  await t.test('archiving keeps loan history and withdraws remaining copies', async () => {
    assert.equal((await call(`/library/books/${book.id}`, 'DELETE')).status, 200);
    assert.equal((await call('/library/books')).data.total, 0);
    assert.equal((await call('/library/loans?status=history')).data.rows.length, 2);
  });
});
