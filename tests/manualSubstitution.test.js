import test, { mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { errorHandler } from '../utils/asyncHandler.js';

const SCHOOL_ID = 12;
const OTHER_SCHOOL_ID = 13;
const SLOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const REGULAR_TEACHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const SUBSTITUTE_TEACHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const EXISTING_ID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const ADMIN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';

const state = {
  today: '2026-09-25',
  existing: null,
  insertConflict: false,
  conflicts: {},
  attendance: [],
  leaves: [],
  inactiveTeacherId: null,
  queries: [],
  inserts: [],
  timetableMutations: [],
  createdCover: null,
};

function resetState() {
  state.today = '2026-09-25';
  state.existing = null;
  state.insertConflict = false;
  state.conflicts = {};
  state.attendance = [];
  state.leaves = [];
  state.inactiveTeacherId = null;
  state.queries = [];
  state.inserts = [];
  state.timetableMutations = [];
  state.createdCover = null;
}

const targetSlot = {
  slot_id: SLOT_ID,
  academic_year_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  class_section_id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
  period_number: 2,
  subject_id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
  absent_teacher_id: REGULAR_TEACHER_ID,
  start_time: '09:00:00',
  end_time: '09:45:00',
  class_name: '8',
  section_name: 'A',
  subject_name: 'Math',
  absent_teacher_name: 'Regular Teacher',
};

const boardSlots = [
  {
    slot_id: 'slot-free',
    period_number: 1,
    is_break: false,
    regular_teacher_id: REGULAR_TEACHER_ID,
    regular_teacher_name: 'Regular Teacher',
    class_name: '8',
    section_name: 'A',
    subject_name: 'Math',
  },
  {
    slot_id: 'slot-break',
    period_number: 2,
    is_break: true,
    period_name: 'Lunch',
    regular_teacher_id: null,
    class_name: '8',
    section_name: 'A',
    subject_name: 'Lunch',
  },
  {
    slot_id: 'slot-open',
    period_number: 3,
    is_break: false,
    regular_teacher_id: null,
    class_name: '7',
    section_name: 'B',
    subject_name: 'Art',
  },
];

function sql(strings, ...values) {
  const query = strings.join('?');
  state.queries.push({ query, values });
  if (/UPDATE\s+timetable_slots|INSERT\s+INTO\s+timetable_slots/i.test(query)) {
    state.timetableMutations.push(query);
    throw new Error('permanent timetable must not change');
  }

  if (query.includes('has_regular_class')) {
    return [{
      has_regular_class: state.conflicts.hasRegularClass ?? false,
      has_other_cover: state.conflicts.hasOtherCover ?? false,
      is_on_leave: state.conflicts.isOnLeave ?? false,
      is_absent: state.conflicts.isAbsent ?? false,
      is_half_day_afternoon: state.conflicts.isHalfDayAfternoon ?? false,
      declared_absent: state.conflicts.declaredAbsent ?? false,
    }];
  }
  if (query.includes('AS is_auto_suggested')) {
    if (!values.includes(SCHOOL_ID)) return [];
    return state.existing ? [state.existing] : [];
  }
  if (query.includes('INSERT INTO timetable_substitutions')) {
    if (!values.includes(SCHOOL_ID)) {
      const error = new Error('cross-school insert');
      error.status = 403;
      throw error;
    }
    if (state.insertConflict) {
      const error = new Error('duplicate key value violates unique constraint');
      error.code = '23505';
      throw error;
    }
    state.inserts.push(values);
    state.createdCover = {
      slot_id: SLOT_ID,
      period_number: 2,
      is_break: false,
      regular_teacher_id: REGULAR_TEACHER_ID,
      regular_teacher_name: 'Regular Teacher',
      class_name: '8',
      section_name: 'A',
      subject_name: 'Math',
      substitution_id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc9',
      substitute_teacher_id: SUBSTITUTE_TEACHER_ID,
      substitute_teacher_name: 'Cover Teacher',
      reason: 'Staff meeting',
    };
    return [{
      id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc9',
      reason: values.find((value) => value === 'Staff meeting' || value === 'Called away') || null,
    }];
  }
  if (query.includes('DELETE FROM timetable_substitutions')) return [];
  if (query.includes('SET cancelled_at')) {
    const substitutionId = values[1];
    const schoolId = values[2];
    if (substitutionId === EXISTING_ID && schoolId === SCHOOL_ID) return [{ id: EXISTING_ID }];
    return [];
  }
  if (query.includes('la.id AS leave_id')) return state.leaves;
  if (query.includes('sa.status IN')) return state.attendance;
  if (query.includes('attendance_recorded')) return [{ attendance_recorded: state.attendance.length > 0 }];
  if (query.includes('FROM academic_years ay')) {
    if (!values.includes(SCHOOL_ID)) return [];
    return [{ academic_year_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', timetable_mode: 'uniform' }];
  }
  if (query.includes('to_char')) return [{ date: state.today }];
  if (query.includes('lunch')) return [{ sort_order: 5 }];
  if (query.includes('SELECT id, name')) return [{ id: 'p1', name: 'Period 1', sort_order: 1, is_break: false }];
  if (query.includes('regular_teacher_id')) {
    if (!values.includes(SCHOOL_ID)) return [];
    return state.createdCover ? [...boardSlots, state.createdCover] : boardSlots;
  }
  if (query.includes('absent_teacher_id')) {
    if (!values.includes(SCHOOL_ID)) return [];
    return [targetSlot];
  }
  if (query.includes('FROM staff st') && query.includes('JOIN users u')) {
    if (state.inactiveTeacherId && values.includes(state.inactiveTeacherId)) return [];
    return [{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }];
  }
  return [];
}
sql.begin = async (fn) => fn(sql);

mock.module('../db.js', {
  defaultExport: sql,
  namedExports: { supabase: {}, supabaseAdmin: {} },
});
mock.module('../middleware/auth.js', {
  namedExports: {
    requireAuth: (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next(),
  },
});
mock.module('../services/notificationService.js', {
  namedExports: { sendNotificationToUsers: async () => {} },
});

const { default: router } = await import('../routes/substitutionRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.schoolId = Number(req.headers['x-school-id'] || SCHOOL_ID);
  req.user = { internal_id: ADMIN_ID };
  next();
});
app.use('/substitutions', router);
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

function assignmentBody(overrides = {}) {
  return {
    date: '2026-09-25',
    slot_id: SLOT_ID,
    substitute_teacher_id: SUBSTITUTE_TEACHER_ID,
    reason: 'Staff meeting',
    ...overrides,
  };
}

test('manual picker loads every scheduled slot and the affected board does not count them as uncovered', async () => {
  resetState();
  const all = await request('GET', '/substitutions/board?date=2026-09-25&scope=all');
  const affected = await request('GET', '/substitutions/board?date=2026-09-25');

  assert.equal(all.status, 200);
  assert.equal(all.json.school_id, SCHOOL_ID);
  assert.deepEqual(all.json.data.slots.map((slot) => slot.slot_id), ['slot-free', 'slot-break', 'slot-open']);
  assert.equal(all.json.data.summary.uncovered_slots, 0);
  assert.equal(all.json.data.summary.total_slots, 0);

  assert.equal(affected.status, 200);
  assert.equal(affected.json.data.slots.length, 0);
  assert.equal(affected.json.data.summary.uncovered_slots, 0);
  assert.equal(state.timetableMutations.length, 0);
});

test('creates a substitution when the regular teacher has no leave or absence', async () => {
  resetState();
  const created = await request('POST', '/substitutions', { body: assignmentBody() });

  assert.equal(created.status, 201);
  assert.equal(created.json.data.message, 'Substitute assigned for this date only');
  assert.equal(state.inserts.length, 1);
  assert.ok(state.inserts[0].includes(SCHOOL_ID));
  assert.ok(state.inserts[0].includes(REGULAR_TEACHER_ID));
  assert.ok(state.inserts[0].includes('Staff meeting'));
  assert.equal(state.timetableMutations.length, 0);
  assert.equal(state.queries.some((entry) => /UPDATE\s+timetable_slots|INSERT\s+INTO\s+timetable_slots/i.test(entry.query)), false);

  const affected = await request('GET', '/substitutions/board?date=2026-09-25');
  assert.equal(affected.status, 200);
  assert.equal(affected.json.data.slots.length, 1);
  assert.equal(affected.json.data.slots[0].slot_id, SLOT_ID);
  assert.equal(affected.json.data.slots[0].unavailability_label, 'Manual Substitution');
  assert.deepEqual(affected.json.data.slots[0].unavailability_sources, ['manual']);
  assert.equal(affected.json.data.slots[0].substitute_teacher_name, 'Cover Teacher');
  assert.equal(affected.json.data.summary.covered_slots, 1);
  assert.equal(affected.json.data.summary.uncovered_slots, 0);
});

test('approved leave can still be covered without a manual reason', async () => {
  resetState();
  state.leaves = [{
    leave_id: 'l-1',
    leave_status: 'approved',
    start_date: '2026-09-25',
    end_date: '2026-09-25',
    staff_id: REGULAR_TEACHER_ID,
    staff_code: 'T001',
    teacher_name: 'Regular Teacher',
  }];
  const created = await request('POST', '/substitutions', { body: assignmentBody({ reason: '' }) });
  assert.equal(created.status, 201);
  assert.equal(state.inserts.length, 1);
});

test('allows a manual substitution without a reason', async () => {
  resetState();
  const created = await request('POST', '/substitutions', { body: assignmentBody({ reason: ' ' }) });
  assert.equal(created.status, 201);
  assert.equal(state.inserts.length, 1);
});

test('allows a future date and rejects a past date', async () => {
  resetState();
  const future = await request('POST', '/substitutions', { body: assignmentBody({ date: '2026-09-26', reason: 'Called away' }) });
  assert.equal(future.status, 201);

  resetState();
  const past = await request('POST', '/substitutions', { body: assignmentBody({ date: '2026-09-24' }) });
  assert.equal(past.status, 400);
  assert.match(past.json.error, /Past dates/);
  assert.equal(state.inserts.length, 0);
});

test('rejects busy, absent, on-leave, half-day, and already-assigned substitute teachers', async () => {
  const cases = [
    ['hasRegularClass', /no longer free/],
    ['hasOtherCover', /no longer free/],
    ['isOnLeave', /approved leave/],
    ['isAbsent', /marked absent/],
    ['isHalfDayAfternoon', /half-day/],
  ];

  for (const [flag, pattern] of cases) {
    resetState();
    state.conflicts[flag] = true;
    const response = await request('POST', '/substitutions', { body: assignmentBody() });
    assert.equal(response.status, 409, flag);
    assert.match(response.json.error, pattern);
    assert.equal(state.inserts.length, 0);
  }
});

test('prevents a second active substitution for the same slot and date', async () => {
  resetState();
  state.existing = { id: EXISTING_ID, is_auto_suggested: false };
  const duplicate = await request('POST', '/substitutions', { body: assignmentBody() });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.json.error, /already assigned/);
  assert.equal(state.inserts.length, 0);

  resetState();
  state.insertConflict = true;
  const raced = await request('POST', '/substitutions', { body: assignmentBody() });
  assert.equal(raced.status, 409);
  assert.match(raced.json.error, /assigned by someone else/);
});

test('changing an existing manual substitution supersedes that row instead of duplicating it', async () => {
  resetState();
  state.existing = { id: EXISTING_ID, is_auto_suggested: false };
  const changed = await request('POST', '/substitutions', {
    body: assignmentBody({ supersede_substitution_id: EXISTING_ID, reason: 'Called away' }),
  });
  assert.equal(changed.status, 201);
  assert.equal(state.inserts.length, 1);
  assert.ok(state.queries.some((entry) => entry.query.includes('SET cancelled_at') && entry.values.includes(EXISTING_ID)));
});

test('cancels a manual substitution only inside the owning school', async () => {
  resetState();
  const cancelled = await request('DELETE', `/substitutions/${EXISTING_ID}`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.data.message, 'Substitution cancelled');

  const otherSchool = await request('DELETE', `/substitutions/${EXISTING_ID}`, { schoolId: OTHER_SCHOOL_ID });
  assert.equal(otherSchool.status, 404);
  assert.match(otherSchool.json.error, /not found/);
});

test('another school cannot assign or read this school timetable slot', async () => {
  resetState();
  const assigned = await request('POST', '/substitutions', {
    schoolId: OTHER_SCHOOL_ID,
    body: assignmentBody(),
  });
  assert.equal(assigned.status, 404);
  assert.equal(state.inserts.length, 0);

  const board = await request('GET', '/substitutions/board?date=2026-09-25&scope=all', {
    schoolId: OTHER_SCHOOL_ID,
  });
  assert.equal(board.status, 200);
  assert.equal(board.json.school_id, OTHER_SCHOOL_ID);
  assert.equal(board.json.data.slots.length, 0);
  assert.ok(state.queries.some((entry) => entry.values.includes(OTHER_SCHOOL_ID)));
  assert.equal(state.inserts.some((values) => values.includes(OTHER_SCHOOL_ID)), false);
});
