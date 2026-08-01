// Exam timetable generator — pure-logic unit tests (no DB needed).
// Run: node tests/examTimetable.test.js
import assert from 'node:assert/strict';
import {
  buildExamDates,
  assignSubjects,
  normalizeParams,
  normalizeSyllabus,
  ExamTimetableError,
} from '../services/examTimetableService.js';
import { seatStudents, assignInvigilators, sessionKey } from '../services/examAllocationService.js';

let assertions = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); assertions++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); assertions++; };

// ── buildExamDates ──────────────────────────────────────────────────────
// 2026-07-20 is a Monday; 2026-07-26 is a Sunday.
eq(
  buildExamDates({ startDate: '2026-07-20', endDate: '2026-07-26', includeSaturdays: true, excludedDates: [], gapDays: 0 }),
  ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25'],
  'Mon-Sat included, Sunday skipped'
);
eq(
  buildExamDates({ startDate: '2026-07-20', endDate: '2026-07-26', includeSaturdays: false, excludedDates: [], gapDays: 0 }),
  ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'],
  'Saturday excluded when include_saturdays=false'
);
eq(
  buildExamDates({ startDate: '2026-07-20', endDate: '2026-07-26', includeSaturdays: true, excludedDates: ['2026-07-22'], gapDays: 0 }),
  ['2026-07-20', '2026-07-21', '2026-07-23', '2026-07-24', '2026-07-25'],
  'explicit excluded date (holiday) skipped'
);
eq(
  buildExamDates({ startDate: '2026-07-20', endDate: '2026-07-31', includeSaturdays: true, excludedDates: [], gapDays: 1 }),
  ['2026-07-20', '2026-07-22', '2026-07-24', '2026-07-27', '2026-07-29', '2026-07-31'],
  'gap_days=1 keeps every second working day'
);
eq(
  buildExamDates({
    startDate: '2026-07-20',
    endDate: '2026-07-31',
    allowedWeekdays: ['monday', 'wednesday', 'friday'],
    excludedDates: [],
    gapDays: 0,
  }),
  ['2026-07-20', '2026-07-22', '2026-07-24', '2026-07-27', '2026-07-29', '2026-07-31'],
  'custom weekdays schedule only on selected days'
);
eq(
  buildExamDates({
    startDate: '2026-07-20',
    endDate: '2026-07-31',
    allowedWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    excludedDates: [],
    gapDays: 0,
    maxConsecutiveDays: 3,
  }),
  ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-24', '2026-07-25', '2026-07-27', '2026-07-29', '2026-07-30', '2026-07-31'],
  'maximum consecutive days inserts a rest day after each full streak'
);

// ── assignSubjects ──────────────────────────────────────────────────────
const classSubjects = new Map([
  ['c1', new Set(['math', 'sci', 'eng'])],
  ['c2', new Set(['math', 'eng'])],
]);
const subjectOrder = ['math', 'sci', 'eng'];
const dates = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23'];

const aligned = assignSubjects({ classSubjects, subjectOrder, dates, mode: 'aligned' });
eq(aligned.required, 3, 'aligned needs one day per union subject');
const alignedMathDates = aligned.assignments.filter((a) => a.subject_id === 'math').map((a) => a.exam_date);
eq(alignedMathDates, ['2026-07-20', '2026-07-20'], 'aligned: same subject, same day, both classes');
ok(
  !aligned.assignments.some((a) => a.class_id === 'c2' && a.subject_id === 'sci'),
  'aligned: class without the subject gets no row'
);
eq(
  aligned.assignments.find((a) => a.class_id === 'c2' && a.subject_id === 'eng').exam_date,
  '2026-07-22',
  'aligned: c2 skips the sci day (gap remains editable manually)'
);

const perClass = assignSubjects({ classSubjects, subjectOrder, dates, mode: 'per_class' });
eq(perClass.required, 3, 'per_class needs max(subjects per class) days');
eq(
  perClass.assignments.find((a) => a.class_id === 'c2' && a.subject_id === 'eng').exam_date,
  '2026-07-21',
  'per_class: c2 fills consecutive days with no gap'
);

// ── sessions: multiple papers per day ───────────────────────────────────
const twoSessions = assignSubjects({ classSubjects, subjectOrder, dates, mode: 'aligned', sessionsPerDay: 2 });
eq(twoSessions.required, 2, '3 subjects at 2 sessions/day need 2 days');
const mathSlot = twoSessions.assignments.find((a) => a.class_id === 'c1' && a.subject_id === 'math');
const sciSlot = twoSessions.assignments.find((a) => a.class_id === 'c1' && a.subject_id === 'sci');
const engSlot = twoSessions.assignments.find((a) => a.class_id === 'c1' && a.subject_id === 'eng');
eq(mathSlot.exam_date, '2026-07-20', 'sessions: subject 1 on day 1');
eq(mathSlot.session_index, 0, 'sessions: subject 1 in session 1');
eq(sciSlot.exam_date, '2026-07-20', 'sessions: subject 2 same day');
eq(sciSlot.session_index, 1, 'sessions: subject 2 in session 2');
eq(engSlot.exam_date, '2026-07-21', 'sessions: subject 3 rolls to day 2');
eq(engSlot.session_index, 0, 'sessions: subject 3 back in session 1');

const afternoonStart = assignSubjects({
  classSubjects,
  subjectOrder,
  dates,
  mode: 'aligned',
  sessionsPerDay: 2,
  startingSessionIndex: 1,
});
eq(afternoonStart.required, 2, 'afternoon start accounts for the unused first morning');
const afternoonMath = afternoonStart.assignments.find((a) => a.class_id === 'c1' && a.subject_id === 'math');
const afternoonSci = afternoonStart.assignments.find((a) => a.class_id === 'c1' && a.subject_id === 'sci');
const afternoonEng = afternoonStart.assignments.find((a) => a.class_id === 'c1' && a.subject_id === 'eng');
eq(afternoonMath.exam_date, '2026-07-20', 'afternoon start: first subject stays on day 1');
eq(afternoonMath.session_index, 1, 'afternoon start: first subject uses session 2');
eq(afternoonSci.exam_date, '2026-07-21', 'afternoon start: second subject rolls to day 2');
eq(afternoonSci.session_index, 0, 'afternoon start: day 2 begins with session 1');
eq(afternoonEng.exam_date, '2026-07-21', 'afternoon start: day 2 uses both sessions');
eq(afternoonEng.session_index, 1, 'afternoon start: third subject uses session 2');
eq(
  assignSubjects({
    classSubjects,
    subjectOrder: ['math', 'sci'],
    dates,
    mode: 'aligned',
    sessionsPerDay: 2,
    startingSessionIndex: 1,
  }).required,
  2,
  'afternoon start: two subjects require two dates because day 1 has only one usable session'
);

const perClassSessions = assignSubjects({ classSubjects, subjectOrder, dates, mode: 'per_class', sessionsPerDay: 2 });
eq(perClassSessions.required, 2, 'per_class with sessions: ceil(3/2) days');
eq(
  perClassSessions.assignments.find((a) => a.class_id === 'c2' && a.subject_id === 'eng').session_index,
  1,
  'per_class: c2 second subject sits in session 2 of day 1'
);
const perClassAfternoon = assignSubjects({
  classSubjects,
  subjectOrder,
  dates,
  mode: 'per_class',
  sessionsPerDay: 2,
  startingSessionIndex: 1,
});
eq(perClassAfternoon.required, 2, 'per_class afternoon start includes the partial first date');
eq(
  perClassAfternoon.assignments.find((a) => a.class_id === 'c2' && a.subject_id === 'eng').session_index,
  0,
  'per_class afternoon start: second subject moves to session 1 on day 2'
);

// ── normalizeParams validation ──────────────────────────────────────────
const base = { class_ids: ['c1'], start_date: '2026-07-20', end_date: '2026-07-24' };
ok(normalizeParams(base).mode === 'aligned', 'defaults to aligned mode');
ok(normalizeParams({ ...base, mode: 'per_class' }).mode === 'per_class', 'per_class mode accepted');
assert.throws(() => normalizeParams({ ...base, class_ids: [] }), ExamTimetableError); assertions++;
assert.throws(() => normalizeParams({ ...base, end_date: '2026-07-19' }), ExamTimetableError); assertions++;
assert.throws(() => normalizeParams({ ...base, start_time: '25:00' }), ExamTimetableError); assertions++;
assert.throws(() => normalizeParams({ ...base, start_time: '10:00', end_time: '09:00' }), ExamTimetableError); assertions++;
assert.throws(() => normalizeParams({ ...base, max_marks: 50, passing_marks: 60 }), ExamTimetableError); assertions++;
assert.throws(() => normalizeParams({ ...base, end_date: '2026-12-31' }), ExamTimetableError); assertions++;
ok(normalizeParams({ ...base, start_time: '09:30', end_time: '12:30' }).start_time === '09:30', 'valid times pass');
eq(
  normalizeParams({ ...base, allowed_weekdays: ['monday', 'wednesday'] }).allowed_weekdays,
  ['monday', 'wednesday'],
  'custom weekdays are normalized'
);
assert.throws(
  () => normalizeParams({ ...base, allowed_weekdays: [] }),
  ExamTimetableError,
  'at least one weekday is required'
); assertions++;
assert.throws(
  () => normalizeParams({ ...base, excluded_dates: ['2026-08-01'] }),
  ExamTimetableError,
  'blackout dates must stay inside the exam window'
); assertions++;
eq(
  normalizeParams({
    ...base,
    subject_marks: [{ subject_id: 'math', max_marks: '50', passing_marks: '18' }],
  }).subject_marks,
  [{ subject_id: 'math', max_marks: 50, passing_marks: 18 }],
  'subject mark overrides are normalized'
);

// sessions normalization
const legacy = normalizeParams({ ...base, start_time: '09:30', end_time: '12:30' });
eq(legacy.sessions.length, 1, 'legacy start/end becomes one session');
eq(legacy.sessions[0].start_time, '09:30', 'legacy session carries the time');

const multi = normalizeParams({
  ...base,
  starting_session_index: 0,
  sessions: [
    { start_time: '14:00', end_time: '16:00' },
    { start_time: '09:30', end_time: '12:00' },
  ],
});
eq(multi.sessions[0].start_time, '09:30', 'sessions sorted by start time');
eq(multi.start_time, '09:30', 'legacy fields mirror session 1');
eq(multi.starting_session_index, 1, 'starting session follows its selected time when sessions sort');
assert.throws(
  () => normalizeParams({
    ...base,
    starting_session_index: 2,
    sessions: [{ start_time: '09:00', end_time: '12:00' }, { start_time: '13:00', end_time: '16:00' }],
  }),
  ExamTimetableError,
  'starting session must exist'
); assertions++;
assert.throws(
  () => normalizeParams({ ...base, sessions: [{ start_time: '09:00', end_time: '12:00' }, { start_time: '11:00', end_time: '13:00' }] }),
  ExamTimetableError,
  'overlapping sessions rejected'
); assertions++;
assert.throws(
  () => normalizeParams({ ...base, sessions: [{ start_time: '09:00', end_time: '12:00' }, { start_time: null, end_time: null }] }),
  ExamTimetableError,
  'multi-session requires times on every session'
); assertions++;
assert.throws(
  () => normalizeParams({ ...base, sessions: [{}, {}, {}, {}] }),
  ExamTimetableError,
  'more than 3 sessions rejected'
); assertions++;

// ── syllabus normalization ──────────────────────────────────────────────
eq(normalizeSyllabus(null), null, 'null clears the syllabus');
eq(normalizeSyllabus([]), null, 'empty list clears the syllabus');
eq(
  JSON.stringify(normalizeSyllabus([{ topic: ' Prose ', marks: '30' }, { topic: 'Grammar', marks: 40 }])),
  JSON.stringify([{ topic: 'Prose', marks: 30 }, { topic: 'Grammar', marks: 40 }]),
  'topics trimmed, marks coerced to numbers'
);
eq(
  normalizeSyllabus([{ topic: 'Essay', marks: '' }])[0].marks,
  null,
  'blank weightage stored as null (topic without marks is fine)'
);
eq(
  normalizeSyllabus([{ topic: '  ' }, { topic: 'Real' }]).length,
  1,
  'empty editor rows dropped silently'
);
assert.throws(() => normalizeSyllabus('portions'), ExamTimetableError); assertions++;
assert.throws(() => normalizeSyllabus([{ topic: 'X', marks: -5 }]), ExamTimetableError); assertions++;
assert.throws(
  () => normalizeSyllabus(Array.from({ length: 51 }, (_, i) => ({ topic: `T${i}` }))),
  ExamTimetableError
); assertions++;

// ── seating: seatStudents ───────────────────────────────────────────────
const mkStudents = (cls, n) =>
  Array.from({ length: n }, (_, i) => ({ enrollment_id: `${cls}-s${i + 1}`, class_id: cls }));
const seatingClasses = new Map([
  ['c1', mkStudents('c1', 3)],
  ['c2', mkStudents('c2', 3)],
]);
const twoRooms = [
  { room_id: 'r1', capacity: 4 },
  { room_id: 'r2', capacity: 4 },
];

const seq = seatStudents({
  studentsByClass: seatingClasses,
  classOrder: ['c1', 'c2'],
  rooms: twoRooms,
  strategy: 'sequential',
});
eq(seq.unseated, 0, 'sequential: everyone fits');
eq(seq.seats.length, 6, 'sequential: 6 seats created');
eq(
  seq.seats.filter((s) => s.room_id === 'r1').length, 4,
  'sequential: room 1 fills to capacity first'
);
eq(seq.seats[0].seat_no, 1, 'seat numbering starts at 1 per room');
eq(
  seq.seats.filter((s) => s.room_id === 'r2')[0].seat_no, 1,
  'seat numbering resets in the next room'
);
ok(
  seq.seats.slice(0, 3).every((s) => s.class_id === 'c1'),
  'sequential: class 1 seated as a block'
);

const mixed = seatStudents({
  studentsByClass: seatingClasses,
  classOrder: ['c1', 'c2'],
  rooms: twoRooms,
  strategy: 'mixed',
});
eq(
  mixed.seats.slice(0, 4).map((s) => s.class_id).join(','),
  'c1,c2,c1,c2',
  'mixed: bench neighbours alternate classes'
);

const tight = seatStudents({
  studentsByClass: seatingClasses,
  classOrder: ['c1', 'c2'],
  rooms: [{ room_id: 'r1', capacity: 4 }],
  strategy: 'sequential',
});
eq(tight.unseated, 2, 'capacity shortfall reported exactly');

// ── seating: balanced (equal class share per room) ──────────────────────
const threeClasses = new Map([
  ['c7', mkStudents('c7', 10)],
  ['c8', mkStudents('c8', 10)],
  ['c9', mkStudents('c9', 10)],
]);

const oneHall = seatStudents({
  studentsByClass: threeClasses,
  classOrder: ['c7', 'c8', 'c9'],
  rooms: [{ room_id: 'hall', capacity: 30 }],
  strategy: 'balanced',
});
eq(oneHall.unseated, 0, 'balanced: everyone fits in the 30-seat hall');
const hallByClass = new Map();
for (const s of oneHall.seats) hallByClass.set(s.class_id, (hallByClass.get(s.class_id) || 0) + 1);
eq(hallByClass.get('c7'), 10, 'balanced: 10 of class 7 in the hall');
eq(hallByClass.get('c8'), 10, 'balanced: 10 of class 8 in the hall');
eq(hallByClass.get('c9'), 10, 'balanced: 10 of class 9 in the hall');

const twoHalls = seatStudents({
  studentsByClass: threeClasses,
  classOrder: ['c7', 'c8', 'c9'],
  rooms: [
    { room_id: 'h1', capacity: 15 },
    { room_id: 'h2', capacity: 15 },
  ],
  strategy: 'balanced',
});
eq(twoHalls.unseated, 0, 'balanced/2 rooms: everyone seated');
const h1Classes = new Map();
for (const s of twoHalls.seats.filter((x) => x.room_id === 'h1')) {
  h1Classes.set(s.class_id, (h1Classes.get(s.class_id) || 0) + 1);
}
eq(h1Classes.get('c7'), 5, 'balanced/2 rooms: room 1 gets 5 of class 7');
eq(h1Classes.get('c8'), 5, 'balanced/2 rooms: room 1 gets 5 of class 8');
eq(h1Classes.get('c9'), 5, 'balanced/2 rooms: room 1 gets 5 of class 9');

// Uneven classes: 10 + 4 into a 12-seat room → 6+4, topped up to 8+4.
const uneven = seatStudents({
  studentsByClass: new Map([
    ['a', mkStudents('a', 10)],
    ['b', mkStudents('b', 4)],
  ]),
  classOrder: ['a', 'b'],
  rooms: [{ room_id: 'r', capacity: 12 }],
  strategy: 'balanced',
});
const unevenCounts = new Map();
for (const s of uneven.seats) unevenCounts.set(s.class_id, (unevenCounts.get(s.class_id) || 0) + 1);
eq(unevenCounts.get('a'), 8, 'balanced top-up: short class backfilled from the larger one');
eq(unevenCounts.get('b'), 4, 'balanced top-up: short class fully seated');
eq(uneven.unseated, 2, 'balanced top-up: overflow reported');
const seatNos = uneven.seats.map((s) => s.seat_no);
eq(Math.max(...seatNos), 12, 'balanced: seat numbers run 1..capacity within the room');

// ── seating: maximize (room constraints + 2D neighbour separation) ─────
const checkerboard = seatStudents({
  studentsByClass: new Map([
    ['c1', mkStudents('c1', 3)],
    ['c2', mkStudents('c2', 3)],
  ]),
  classOrder: ['c1', 'c2'],
  rooms: [{ room_id: 'grid', rows: 2, columns: 3, capacity: 6, class_ids: ['c1', 'c2'] }],
  strategy: 'maximize',
});
eq(checkerboard.unseated, 0, 'maximize: everyone fits in the configured grid');
for (let index = 0; index < checkerboard.seats.length; index++) {
  const current = checkerboard.seats[index];
  if (index % 3 !== 0) {
    ok(
      current.class_id !== checkerboard.seats[index - 1].class_id,
      `maximize: seat ${index + 1} differs from its left neighbour`
    );
  }
  if (index >= 3) {
    ok(
      current.class_id !== checkerboard.seats[index - 3].class_id,
      `maximize: seat ${index + 1} differs from its front neighbour`
    );
  }
}

const constrainedRooms = seatStudents({
  studentsByClass: new Map([
    ['c1', mkStudents('c1', 3)],
    ['c2', mkStudents('c2', 3)],
  ]),
  classOrder: ['c1', 'c2'],
  rooms: [
    { room_id: 'all', rows: 1, columns: 3, capacity: 3, class_ids: ['c1', 'c2'] },
    { room_id: 'c1-only', rows: 1, columns: 3, capacity: 3, class_ids: ['c1'] },
  ],
  strategy: 'maximize',
});
eq(constrainedRooms.unseated, 0, 'maximize: restrictive rooms are planned first so no valid seat is wasted');
ok(
  constrainedRooms.seats.filter((seat) => seat.room_id === 'c1-only').every((seat) => seat.class_id === 'c1'),
  'maximize: per-room class restriction is enforced'
);
ok(
  constrainedRooms.seats.filter((seat) => seat.room_id === 'all').every((seat) => seat.class_id === 'c2'),
  'maximize: unrestricted room receives the remaining class'
);

// ── seating: assignInvigilators ─────────────────────────────────────────
const invig = assignInvigilators({
  sittings: [
    { key: 'd1', roomIds: ['r1', 'r2'] },
    { key: 'd2', roomIds: ['r1', 'r2'] },
    { key: 'd3', roomIds: ['r1'] },
  ],
  pool: ['t1', 't2', 't3'],
});
const d1 = invig.get('d1');
ok(d1.get('r1') !== d1.get('r2'), 'no double-booking within a sitting');
const counts = new Map();
for (const roomMap of invig.values()) {
  for (const staffId of roomMap.values()) {
    counts.set(staffId, (counts.get(staffId) || 0) + 1);
  }
}
const dutyValues = [...counts.values()];
ok(
  Math.max(...dutyValues) - Math.min(...dutyValues) <= 1,
  'duties balanced across the pool (max spread 1)'
);

const noPool = assignInvigilators({ sittings: [{ key: 'd1', roomIds: ['r1'] }], pool: [] });
eq(noPool.get('d1').get('r1'), null, 'empty pool leaves rooms uninvigilated, not crashed');

// ── sessionKey ──────────────────────────────────────────────────────────
eq(sessionKey(null), '00:00:00', 'null session normalizes to 00:00:00');
eq(sessionKey('09:30'), '09:30:00', 'HH:MM session normalizes to HH:MM:SS');
eq(sessionKey('09:30:00'), '09:30:00', 'HH:MM:SS passes through');

console.log(`examTimetable.test.js: ${assertions} assertions passed`);
process.exit(0);
