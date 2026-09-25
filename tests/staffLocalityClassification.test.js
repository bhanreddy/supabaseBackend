import test, { mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { errorHandler } from '../utils/asyncHandler.js';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const SCHOOL_ID = 1;
const OTHER_SCHOOL_ID = 2;

const state = {
  today: '2026-09-25',
  staff: [],
  classifications: [],
  audits: [],
  seq: 0,
  inTransaction: false,
};

function resetState() {
  state.today = '2026-09-25';
  state.staff = [];
  state.classifications = [];
  state.audits = [];
  state.seq = 0;
  state.inTransaction = false;
}

function schoolKey(value) {
  return Number(value);
}

function sameScope(row, schoolId, staffId) {
  return schoolKey(row.school_id) === schoolKey(schoolId) && String(row.staff_id) === String(staffId);
}

function sql(strings, ...values) {
  const query = strings.join('?');
  if (/teacher_payroll_snapshots|INTO\s+staff_payroll|UPDATE\s+staff_payroll/i.test(query)) {
    throw new Error('Staff classification must not rewrite payroll snapshots');
  }

  if (query.includes('INSERT INTO teacher_payroll_audit_logs')) {
    state.audits.push({
      school_id: schoolKey(values[0]),
      staff_id: values[2] == null ? null : String(values[2]),
      actor_id: values[3],
      action: values[4],
      detail: values[5],
    });
    return [];
  }

  if (query.includes('INSERT INTO staff_locality_classifications')) {
    const row = {
      id: `cls-${++state.seq}`,
      school_id: schoolKey(values[0]),
      staff_id: String(values[1]),
      classification: values[2],
      effective_from: values[3],
      effective_to: values[4] || null,
      created_by: values[5],
      written_in_transaction: state.inTransaction,
    };
    state.classifications.push(row);
    return [{ ...row }];
  }

  if (query.includes('DELETE FROM staff_locality_classifications')) {
    const index = state.classifications.findIndex((row) => (
      row.id === values[0]
      && sameScope(row, values[1], values[2])
      && row.effective_from >= values[3]
    ));
    if (index >= 0) state.classifications.splice(index, 1);
    return [];
  }

  if (query.includes('UPDATE staff_locality_classifications') && query.includes('SET classification')) {
    const row = state.classifications.find((item) => (
      item.id === values[1]
      && sameScope(item, values[2], values[3])
      && item.effective_from === values[4]
    ));
    if (!row) return [];
    row.classification = values[0];
    row.effective_to = null;
    return [{ ...row }];
  }

  if (query.includes('UPDATE staff_locality_classifications') && query.includes('WHERE id')) {
    const row = state.classifications.find((item) => (
      item.id === values[1] && sameScope(item, values[2], values[3]) && item.effective_to == null
    ));
    if (row) row.effective_to = values[0];
    return [];
  }

  if (query.includes('UPDATE staff_locality_classifications')) {
    for (const row of state.classifications) {
      if (!sameScope(row, values[1], values[2])) continue;
      if (row.effective_to == null && row.effective_from < values[3]) row.effective_to = values[0];
    }
    return [];
  }

  if (query.includes('SELECT id FROM staff_locality_classifications')) {
    const end = values[2] || '9999-12-31';
    const start = values[3];
    return state.classifications
      .filter((row) => {
        if (!sameScope(row, values[0], values[1])) return false;
        const rowEnd = row.effective_to || '9999-12-31';
        return row.effective_from <= end && rowEnd >= start;
      })
      .map((row) => ({ id: row.id }));
  }

  if (query.includes('CURRENT_DATE') && query.includes('staff_locality_classifications')) {
    const today = state.today;
    const match = state.classifications
      .filter((row) => (
        sameScope(row, values[0], values[1])
        && row.effective_from <= today
        && (row.effective_to == null || row.effective_to >= today)
      ))
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
    return match ? [{ classification: match.classification }] : [];
  }

  if (query.includes('SELECT id, classification, effective_from, effective_to')) {
    return state.classifications
      .filter((row) => sameScope(row, values[0], values[1]))
      .sort((a, b) => a.effective_from.localeCompare(b.effective_from))
      .map((row) => ({ ...row }));
  }

  if (query.includes('school_timezone')) {
    return [{ date: state.today }];
  }

  if (query.includes('INSERT INTO persons')) {
    return [{ id: `person-${++state.seq}` }];
  }

  if (query.includes('INSERT INTO staff')) {
    const row = {
      id: `staff-${++state.seq}`,
      school_id: schoolKey(values[0]),
      person_id: values[1],
      staff_code: values[2],
      joining_date: values[3],
      status_id: values[4],
      designation_id: values[5],
      salary: values[6],
      deleted_at: null,
    };
    state.staff.push(row);
    return [{ ...row }];
  }

  if (query.includes('INSERT INTO person_contacts') || query.includes('INSERT INTO user_roles')) return [];

  if (query.includes('INSERT INTO users')) return [{ id: values[0] }];

  if (query.includes('SELECT id FROM roles')) return [{ id: 'role-1' }];

  if (query.includes('lower(contact_value)')) return [];

  if (query.includes('SELECT id FROM person_contacts')) return [{ id: 'contact-1' }];

  if (query.includes('UPDATE persons') || query.includes('UPDATE person_contacts')) return [];

  if (query.includes('UPDATE staff')) {
    const id = values[5];
    const schoolId = values[6];
    const row = state.staff.find((item) => item.id === id && schoolKey(item.school_id) === schoolKey(schoolId));
    if (!row) return [];
    if (values[0] != null) row.staff_code = values[0];
    if (values[1] != null) row.joining_date = values[1];
    if (values[2] != null) row.status_id = values[2];
    if (values[3] != null) row.designation_id = values[3];
    if (values[4] != null) row.salary = values[4];
    return [{ ...row }];
  }

  if (/FROM staff s\b/.test(query)) {
    const staffId = values[0];
    const schoolId = values[1];
    const row = state.staff.find((item) => item.id === staffId && schoolKey(item.school_id) === schoolKey(schoolId) && !item.deleted_at);
    if (!row) return [];
    return [{
      ...row,
      display_name: 'Ada Lovelace',
      first_name: 'Ada',
      last_name: 'Lovelace',
    }];
  }

  if (query.includes('as contacts')) {
    const row = state.staff.find((item) => item.id === values[0] && schoolKey(item.school_id) === schoolKey(values[1]) && !item.deleted_at);
    return row ? [{ ...row, first_name: 'Ada', last_name: 'Lovelace' }] : [];
  }

  if (query.includes('as current_phone')) {
    const row = state.staff.find((item) => item.id === values[0] && schoolKey(item.school_id) === schoolKey(values[1]) && !item.deleted_at);
    if (!row) return [];
    return [{
      person_id: row.person_id,
      user_id: `auth-${row.id}`,
      current_email: 'ada@school.edu',
      current_phone: '9876543210',
    }];
  }

  throw new Error(`Unhandled SQL: ${query.replace(/\s+/g, ' ').slice(0, 240)}`);
}

sql.begin = async (fn) => {
  state.inTransaction = true;
  try {
    return await fn(sql);
  } finally {
    state.inTransaction = false;
  }
};
sql.json = (value) => value;

let authSeq = 0;
const supabaseAdmin = {
  auth: {
    admin: {
      createUser: async () => ({ data: { user: { id: `auth-${++authSeq}` } }, error: null }),
      updateUserById: async () => ({ data: { user: {} }, error: null }),
      getUserById: async () => ({ data: { user: { user_metadata: {} } }, error: null }),
    },
  },
};

mock.module('../db.js', {
  defaultExport: sql,
  namedExports: { supabase: {}, supabaseAdmin },
});
mock.module('../middleware/auth.js', {
  namedExports: {
    requireAuth: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
  },
});

const { default: router } = await import('../routes/staffRoutes.js');
const { saveClassification, payrollMonthStart, readLocalityClassificationField } = await import('../services/teacherPayrollService.js');
const { PayrollWorkflowError } = await import('../services/teacherPayrollWorkflow.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const schoolId = Number(req.headers['x-school-id'] || SCHOOL_ID);
  req.schoolId = schoolId;
  req.user = {
    schoolId,
    internal_id: ADMIN_ID,
    roles: ['admin'],
    permissions: ['staff.create', 'staff.edit', 'staff.view'],
  };
  next();
});
app.use('/staff', router);
app.use(errorHandler);

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!server) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function request(method, path, { body, schoolId = SCHOOL_ID } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-school-id': String(schoolId),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

let codeSeq = 0;
function staffBody(overrides = {}) {
  codeSeq += 1;
  return {
    first_name: 'Ada',
    last_name: 'Lovelace',
    staff_code: `STF-${codeSeq}`,
    joining_date: '2024-06-15',
    email: `ada${codeSeq}@school.edu`,
    phone: '9876543210',
    password: 'secret1',
    designation_id: 2,
    gender_id: 1,
    ...overrides,
  };
}

function rowsFor(staffId, schoolId = SCHOOL_ID) {
  return state.classifications.filter((row) => sameScope(row, schoolId, staffId));
}

function overlaps(left, right) {
  const leftEnd = left.effective_to || '9999-12-31';
  const rightEnd = right.effective_to || '9999-12-31';
  return left.effective_from <= rightEnd && right.effective_from <= leftEnd;
}

test('locality field parsing accepts only LOCAL, NON_LOCAL, null, or omission', () => {
  assert.deepEqual(readLocalityClassificationField({}), { present: false, value: null });
  assert.deepEqual(readLocalityClassificationField({ locality_classification: null }), { present: true, value: null });
  assert.equal(readLocalityClassificationField({ locality_classification: 'LOCAL' }).value, 'LOCAL');
  assert.equal(readLocalityClassificationField({ locality_classification: 'NON_LOCAL' }).value, 'NON_LOCAL');
  assert.equal(readLocalityClassificationField({ locality_classification: 'REMOTE' }).invalid, true);
  assert.equal(payrollMonthStart('2026-09-25'), '2026-09-01');
});

test('create staff with LOCAL stores a classification from the joining date', async () => {
  resetState();
  const created = await request('POST', '/staff', {
    body: staffBody({ locality_classification: 'LOCAL', joining_date: '2024-06-15' }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const staffId = created.json.data.staff.id;
  const rows = rowsFor(staffId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].classification, 'LOCAL');
  assert.equal(rows[0].effective_from, '2024-06-15');
  assert.equal(rows[0].effective_to, null);
  assert.equal(rows[0].created_by, ADMIN_ID);
  assert.equal(rows[0].school_id, SCHOOL_ID);
  assert.equal(rows[0].written_in_transaction, true);
  assert.equal(created.json.data.staff && state.staff.length, 1);
});

test('create staff with NON_LOCAL stores that classification', async () => {
  resetState();
  const created = await request('POST', '/staff', {
    body: staffBody({ locality_classification: 'NON_LOCAL' }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const rows = rowsFor(created.json.data.staff.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].classification, 'NON_LOCAL');
  assert.equal(rows[0].effective_to, null);
});

test('create staff without a classification writes no classification row', async () => {
  resetState();
  const omitted = await request('POST', '/staff', { body: staffBody() });
  assert.equal(omitted.status, 201, JSON.stringify(omitted.json));
  assert.equal(rowsFor(omitted.json.data.staff.id).length, 0);

  const explicitNull = await request('POST', '/staff', { body: staffBody({ locality_classification: null }) });
  assert.equal(explicitNull.status, 201, JSON.stringify(explicitNull.json));
  assert.equal(rowsFor(explicitNull.json.data.staff.id).length, 0);
  assert.equal(state.staff.length, 2);
});

test('invalid classification returns 400 and does not create staff', async () => {
  resetState();
  const created = await request('POST', '/staff', { body: staffBody({ locality_classification: 'REMOTE' }) });
  assert.equal(created.status, 400);
  assert.equal(created.json.code, 'INVALID_CLASSIFICATION');
  assert.equal(state.staff.length, 0);
  assert.equal(state.classifications.length, 0);

  const updated = await request('PUT', '/staff/missing', { body: { locality_classification: '' } });
  assert.equal(updated.status, 400);
  assert.equal(updated.json.code, 'INVALID_CLASSIFICATION');
});

test('GET /staff/:id returns the classification effective today', async () => {
  resetState();
  const created = await request('POST', '/staff', { body: staffBody({ locality_classification: 'LOCAL' }) });
  const staffId = created.json.data.staff.id;
  const beforeChange = await request('GET', `/staff/${staffId}`);
  assert.equal(beforeChange.status, 200);
  assert.equal(beforeChange.json.data.locality_classification, 'LOCAL');

  const changed = await request('PUT', `/staff/${staffId}`, { body: { locality_classification: 'NON_LOCAL' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  const afterChange = await request('GET', `/staff/${staffId}`);
  assert.equal(afterChange.json.data.locality_classification, 'NON_LOCAL');
});

test('updating without the property keeps the existing classification', async () => {
  resetState();
  const created = await request('POST', '/staff', { body: staffBody({ locality_classification: 'LOCAL' }) });
  const staffId = created.json.data.staff.id;
  const before = rowsFor(staffId).map((row) => ({ ...row }));
  const updated = await request('PUT', `/staff/${staffId}`, { body: { first_name: 'Augusta' } });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  assert.deepEqual(rowsFor(staffId), before);
  const loaded = await request('GET', `/staff/${staffId}`);
  assert.equal(loaded.json.data.locality_classification, 'LOCAL');
});

test('updating to the same value does not create a duplicate', async () => {
  resetState();
  const created = await request('POST', '/staff', { body: staffBody({ locality_classification: 'NON_LOCAL' }) });
  const staffId = created.json.data.staff.id;
  const updated = await request('PUT', `/staff/${staffId}`, { body: { locality_classification: 'NON_LOCAL' } });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  const rows = rowsFor(staffId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].effective_from, '2024-06-15');
  assert.equal(rows[0].classification, 'NON_LOCAL');
  assert.equal(state.audits.filter((entry) => entry.staff_id === staffId).length, 0);
});

test('changing classification closes the previous record without overlap', async () => {
  resetState();
  const created = await request('POST', '/staff', {
    body: staffBody({ locality_classification: 'LOCAL', joining_date: '2024-06-15' }),
  });
  const staffId = created.json.data.staff.id;
  const updated = await request('PUT', `/staff/${staffId}`, { body: { locality_classification: 'NON_LOCAL' } });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  const rows = rowsFor(staffId).sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [row.classification, row.effective_from, row.effective_to]),
    [
      ['LOCAL', '2024-06-15', '2026-08-31'],
      ['NON_LOCAL', '2026-09-01', null],
    ],
  );
  assert.equal(overlaps(rows[0], rows[1]), false);
  const audit = state.audits.find((entry) => entry.staff_id === staffId && entry.action === 'CLASSIFICATION_SAVED');
  assert.equal(audit.actor_id, ADMIN_ID);
  assert.equal(audit.school_id, SCHOOL_ID);
  assert.equal(audit.detail.previous, 'LOCAL');
  assert.equal(audit.detail.classification, 'NON_LOCAL');
});

test('a classification that already starts this month is updated in place', async () => {
  resetState();
  const created = await request('POST', '/staff', {
    body: staffBody({ locality_classification: 'LOCAL', joining_date: '2026-09-01' }),
  });
  const staffId = created.json.data.staff.id;
  const updated = await request('PUT', `/staff/${staffId}`, { body: { locality_classification: 'NON_LOCAL' } });
  assert.equal(updated.status, 200, JSON.stringify(updated.json));
  const rows = rowsFor(staffId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].classification, 'NON_LOCAL');
  assert.equal(rows[0].effective_from, '2026-09-01');
  assert.equal(rows[0].effective_to, null);
});

test('clearing the classification closes the active record and preserves history', async () => {
  resetState();
  const created = await request('POST', '/staff', { body: staffBody({ locality_classification: 'LOCAL' }) });
  const staffId = created.json.data.staff.id;
  const cleared = await request('PUT', `/staff/${staffId}`, { body: { locality_classification: null } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  const rows = rowsFor(staffId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].classification, 'LOCAL');
  assert.equal(rows[0].effective_from, '2024-06-15');
  assert.equal(rows[0].effective_to, '2026-08-31');
  const loaded = await request('GET', `/staff/${staffId}`);
  assert.equal(loaded.json.data.locality_classification, null);
  assert.equal(state.audits.some((entry) => entry.action === 'CLASSIFICATION_CLEARED' && entry.staff_id === staffId), true);
});

test('classification reads and writes stay inside the caller school', async () => {
  resetState();
  const created = await request('POST', '/staff', { body: staffBody({ locality_classification: 'LOCAL' }) });
  const staffId = created.json.data.staff.id;
  state.classifications.push({
    id: 'cls-other-school',
    school_id: OTHER_SCHOOL_ID,
    staff_id: staffId,
    classification: 'NON_LOCAL',
    effective_from: '2020-01-01',
    effective_to: null,
    created_by: ADMIN_ID,
  });
  const otherStaff = await request('POST', '/staff', {
    schoolId: OTHER_SCHOOL_ID,
    body: staffBody({ locality_classification: 'NON_LOCAL' }),
  });
  const otherId = otherStaff.json.data.staff.id;

  const own = await request('GET', `/staff/${staffId}`);
  assert.equal(own.json.data.locality_classification, 'LOCAL');
  const foreign = await request('GET', `/staff/${otherId}`);
  assert.equal(foreign.status, 404);
  const foreignAsOwner = await request('GET', `/staff/${otherId}`, { schoolId: OTHER_SCHOOL_ID });
  assert.equal(foreignAsOwner.json.data.locality_classification, 'NON_LOCAL');

  const before = rowsFor(otherId, OTHER_SCHOOL_ID).map((row) => ({ ...row }));
  const denied = await request('PUT', `/staff/${otherId}`, { body: { locality_classification: 'LOCAL' } });
  assert.equal(denied.status, 404);
  assert.deepEqual(rowsFor(otherId, OTHER_SCHOOL_ID), before);
  assert.equal(state.classifications.find((row) => row.id === 'cls-other-school').classification, 'NON_LOCAL');
});

test('payroll classification endpoint still checks permission and rejects overlaps', async () => {
  resetState();
  const created = await request('POST', '/staff', { body: staffBody({ locality_classification: 'LOCAL' }) });
  const staffId = created.json.data.staff.id;
  const user = { permissions: ['payroll.prepare'], roles: ['admin'] };
  await assert.rejects(
    () => saveClassification({
      schoolId: SCHOOL_ID,
      staffId,
      actorId: ADMIN_ID,
      user: { permissions: ['staff.edit'], roles: [] },
      classification: 'NON_LOCAL',
      effectiveFrom: '2026-10-01',
    }),
    (error) => error instanceof PayrollWorkflowError && error.code === 'FORBIDDEN',
  );

  const saved = await saveClassification({
    schoolId: SCHOOL_ID,
    staffId,
    actorId: ADMIN_ID,
    user,
    classification: 'NON_LOCAL',
    effectiveFrom: '2026-10-01',
  });
  assert.equal(saved.classification, 'NON_LOCAL');
  assert.equal(saved.effective_from, '2026-10-01');

  await assert.rejects(
    () => saveClassification({
      schoolId: SCHOOL_ID,
      staffId,
      actorId: ADMIN_ID,
      user,
      classification: 'LOCAL',
      effectiveFrom: '2026-09-15',
    }),
    (error) => error.status === 409 && error.code === 'CLASSIFICATION_OVERLAP',
  );
});
