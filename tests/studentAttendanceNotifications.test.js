import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import express from 'express';

const today = '2026-10-23';
const students = ['student-1', 'student-2', 'student-3'];
const enrollments = students.map((student_id) => ({ student_id, enrollment_id: `enrollment-${student_id}` }));
const state = { rows: [], sends: [], events: [], recipientQueries: [], committed: false, failCommit: false };

function sql(strings, ...values) {
  if (typeof strings === 'string') return strings;
  const query = strings.join('?');
  if (query.includes('SELECT timetable_mode')) return [{ timetable_mode: 'uniform' }];
  if (query.includes('SELECT se.id AS enrollment_id')) {
    return enrollments.filter((row) => values.at(-1).includes(row.student_id));
  }
  if (query.includes('INSERT INTO daily_attendance')) {
    // Model PostgreSQL's conditional upsert, including null -> marked session.
    assert.match(query, /WHERE daily_attendance\.\? IS DISTINCT FROM EXCLUDED\.\?/);
    assert.equal(values.at(-1), values.at(-2));
    const [column, schoolId, date, , ids, statuses] = values;
    assert.equal(schoolId, 12);
    const changed = [];
    ids.forEach((enrollmentId, index) => {
      let row = state.rows.find((item) => item.student_enrollment_id === enrollmentId && item.attendance_date === date && !item.deleted_at);
      if (row && row[column] === statuses[index]) return;
      if (!row) {
        row = {
          id: `attendance-${state.rows.length + 1}`, student_enrollment_id: enrollmentId,
          attendance_date: date, morning_status: null, afternoon_status: null, deleted_at: null,
        };
        state.rows.push(row);
      }
      row[column] = statuses[index];
      const sessions = [row.morning_status, row.afternoon_status];
      row.status = sessions.includes('present') || sessions.includes('late')
        ? sessions.includes('absent') ? 'half_day' : 'present'
        : 'absent';
      changed.push({ ...row });
    });
    return changed;
  }
  if (query.includes('FROM daily_attendance')) {
    assert.match(query, /school_id = \?/);
    assert.match(query, /deleted_at IS NULL/);
    const [, ids, date] = values;
    return state.rows.filter((row) => ids.includes(row.student_enrollment_id) && row.attendance_date === date && !row.deleted_at);
  }
  if (query.includes('FROM school_settings setting')) return [{ timezone: 'Asia/Kolkata' }];
  if (query.includes("'student'::text as role")) {
    assert.equal(state.committed, true);
    const ids = values.find(Array.isArray);
    state.recipientQueries.push(ids);
    return ids.flatMap((student_id) => [
      { student_id, user_id: `user-${student_id}`, role: 'student' },
      { student_id, user_id: `parent-${student_id}`, role: 'parent' },
    ]);
  }
  throw new Error(`Unexpected query: ${query}`);
}
sql.array = (values) => values;
sql.begin = async (fn) => {
  const result = await fn(sql);
  if (state.failCommit) throw new Error('Commit failed');
  state.committed = true;
  return result;
};

mock.module('../db.js', { defaultExport: sql });
mock.module('../config/env.js', { defaultExport: { nodeEnv: 'test' } });
mock.module('../middleware/auth.js', { namedExports: {
  requireAuth: (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next(),
} });
mock.module('../services/notificationService.js', { namedExports: {
  sendNotificationToUsers: async (ids, type, params) => {
    assert.equal(state.committed, true);
    state.sends.push({ ids, type, params });
  },
} });
mock.module('../services/automationEventService.js', { namedExports: {
  AUTOMATION_EVENTS: { STUDENT_ATTENDANCE_RISK_CHANGED: 'attendance-risk' },
  emitSchoolEvent: (name, payload) => state.events.push({ name, ...payload }),
} });
mock.module('../services/attendanceRiskService.js', { namedExports: {
  getAttendanceRiskInsights: async () => [], updateStudentIntervention: async () => {},
} });
mock.module('../services/staffAttendanceV2Service.js', { namedExports: { recordAdminAttendanceBatch: async () => [] } });
mock.module('../services/workingDayResolver.js', { namedExports: { resolveSchoolDay: async () => ({ isHoliday: false }) } });
mock.module('../services/attendanceStreakService.js', { namedExports: { enrichStudentsWithStreaks: async () => [] } });

const { default: attendanceRoutes } = await import('../routes/attendanceRoutes.js');
let server;
let baseUrl;
before(async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date(`${today}T06:00:00Z`) });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.schoolId = 12;
    req.user = { roles: ['admin'], internal_id: 'teacher-user' };
    next();
  });
  app.use('/attendance', attendanceRoutes);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  mock.timers.reset();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  state.rows = [];
  resetNotifications();
  state.failCommit = false;
});

function resetNotifications() {
  state.sends = [];
  state.events = [];
  state.recipientQueries = [];
  state.committed = false;
}

async function mark(statuses = ['present', 'absent', 'present'], session = 'morning', date = today) {
  const response = await fetch(`${baseUrl}/attendance`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      class_section_id: 'class-1', date, session,
      records: statuses.map((status, index) => ({ student_id: students[index], status })),
    }),
  });
  const body = await response.json();
  if (!state.failCommit) assert.equal(response.status, 201, JSON.stringify(body));
  // Notifications are dispatched asynchronously after the transaction.
  await new Promise((resolve) => setImmediate(resolve));
  return { status: response.status, ...body };
}

test('first marking notifies all submitted students and parents with the session status', async () => {
  const response = await mark();
  assert.equal(response.status, 201);
  assert.equal(response.data.count, 3);
  assert.deepEqual(state.recipientQueries, [students]);
  assert.deepEqual(state.sends, [
    { ids: ['user-student-2', 'parent-student-2'], type: 'ATTENDANCE_ABSENT', params: { date: today } },
    { ids: ['user-student-1', 'parent-student-1', 'user-student-3', 'parent-student-3'], type: 'ATTENDANCE_PRESENT', params: { message: `Attendance marked for ${today}.` } },
  ]);
});

for (const [beforeStatuses, afterStatuses, type] of [
  [['present', 'absent', 'present'], ['present', 'present', 'present'], 'ATTENDANCE_PRESENT'],
  [['present', 'present', 'present'], ['present', 'absent', 'present'], 'ATTENDANCE_ABSENT'],
]) {
  test(`correction sends ${type} only to the changed student and parent`, async () => {
    await mark(beforeStatuses);
    resetNotifications();
    const response = await mark(afterStatuses);
    assert.equal(response.status, 201);
    assert.equal(response.data.count, 3);
    assert.equal(response.data.records.length, 3);
    assert.deepEqual(state.recipientQueries, [['student-2']]);
    assert.equal(state.sends.length, 1);
    assert.equal(state.sends[0].type, type);
    assert.deepEqual(state.sends[0].ids, ['user-student-2', 'parent-student-2']);
    assert.deepEqual(state.events.map((event) => event.studentId), ['student-2']);
  });
}

test('unchanged retries succeed with the full count and send no notifications', async () => {
  await mark();
  resetNotifications();
  const response = await mark();
  assert.equal(response.status, 201);
  assert.equal(response.data.count, 3);
  assert.deepEqual(state.recipientQueries, []);
  assert.deepEqual(state.sends, []);
  assert.deepEqual(state.events, []);
});

test('first afternoon marks notify even if the derived daily status is unchanged', async () => {
  await mark(['present', 'present', 'present']);
  resetNotifications();
  const response = await mark(['present', 'present', 'present'], 'afternoon');
  assert.equal(response.data.count, 3);
  assert.deepEqual(state.recipientQueries, [students]);
  assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0].ids.length, 6);
  assert.ok(response.data.records.every((row) => row.morning_status === 'present' && row.afternoon_status === 'present'));
});

test('afternoon corrections use the changed session even when daily status stays present', async () => {
  await mark(['present', 'present', 'present']);
  await mark(['present', 'present', 'present'], 'afternoon');
  resetNotifications();
  const response = await mark(['present', 'late', 'present'], 'afternoon');
  assert.equal(response.data.records[1].status, 'present');
  assert.equal(response.data.records[1].morning_status, 'present');
  assert.deepEqual(state.recipientQueries, [['student-2']]);
  assert.deepEqual(state.sends[0].ids, ['user-student-2', 'parent-student-2']);
  resetNotifications();
  await mark(['present', 'late', 'present'], 'afternoon');
  assert.deepEqual(state.sends, []);
});

test('remarking after clearing attendance notifies the students again', async () => {
  await mark();
  state.rows.forEach((row) => { row.deleted_at = '2026-10-23T06:01:00Z'; });
  resetNotifications();
  const response = await mark();
  assert.equal(response.data.count, 3);
  assert.deepEqual(state.recipientQueries, [students]);
});

test('backdated marks and corrections do not notify families', async () => {
  await mark(undefined, 'morning', '2026-10-22');
  assert.deepEqual(state.sends, []);
  resetNotifications();
  await mark(['present', 'present', 'present'], 'morning', '2026-10-22');
  assert.deepEqual(state.recipientQueries, []);
  assert.deepEqual(state.sends, []);
});

test('a failed transaction sends no notifications or automation events', async () => {
  state.failCommit = true;
  const response = await mark();
  assert.equal(response.status, 500);
  assert.deepEqual(state.sends, []);
  assert.deepEqual(state.events, []);
});
