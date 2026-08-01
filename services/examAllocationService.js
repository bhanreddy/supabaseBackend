// Exam seating & invigilation engine.
//
// A "sitting" is one exam on one date at one session start time. For every
// sitting the engine seats the enrolled students of each class that has a
// paper there into the admin-chosen rooms (in the admin's order), and assigns
// one invigilator per room from a staff pool, balancing duty counts across
// the whole exam and never placing one person in two rooms of one sitting.
//
// Invariants:
//  - Every query is school-scoped (schoolId always comes from middleware).
//  - Regeneration replaces the whole allocation for the exam in one
//    transaction; a failed run leaves the previous allocation untouched.
//  - Capacity shortfalls fail up front with exact numbers, before any write.
//  - One seat per student per sitting is enforced by a DB unique index.

import sql from '../db.js';
import { ExamTimetableError } from './examTimetableService.js';

const UNTIMED = '00:00:00';

/** Normalize a session time to HH:MM:SS ('00:00:00' when null/absent). */
export function sessionKey(time) {
  if (!time) return UNTIMED;
  const t = String(time);
  return t.length === 5 ? `${t}:00` : t;
}

/**
 * Seat students into rooms.
 *  - studentsByClass: Map<classId, [{ enrollment_id, class_id }]> (pre-sorted)
 *  - classOrder: class ids in fill order
 *  - rooms: [{ room_id, capacity, rows?, columns?, class_ids? }] in fill order
 *  - strategy:
 *      'sequential' — class after class, room after room
 *      'mixed'      — round-robin across the classes allowed in each room
 *      'balanced'   — every room seats an equal share of each class (a
 *                     30-seat hall with 3 classes gets ~10 from each); when a
 *                     class runs short its seats are topped up from the
 *                     largest remaining class
 *      'maximize'   — fill restricted rooms first, then choose every seat to
 *                     minimise same-class neighbours on the left and in front
 * Returns { seats: [{ room_id, enrollment_id, class_id, seat_no }], unseated }.
 * Pure function — unit tested.
 */
export function seatStudents({ studentsByClass, classOrder, rooms, strategy }) {
  const queues = new Map(
    classOrder
      .map((id) => [id, [...(studentsByClass.get(id) || [])]])
      .filter(([, queue]) => queue.length > 0)
  );

  const seats = [];
  const pushRoomSeats = (room, students) => {
    students.forEach((student, i) => {
      seats.push({
        room_id: room.room_id,
        enrollment_id: student.enrollment_id,
        class_id: student.class_id,
        seat_no: i + 1,
      });
    });
  };

  const eligibleClassIds = (room) => {
    const allowed = Array.isArray(room.class_ids) && room.class_ids.length > 0
      ? new Set(room.class_ids.map(String))
      : null;
    return classOrder.filter((id) => queues.get(id)?.length > 0 && (!allowed || allowed.has(id)));
  };

  const arrangeForSeparation = (students, columns) => {
    const pools = new Map();
    for (const student of students) {
      if (!pools.has(student.class_id)) pools.set(student.class_id, []);
      pools.get(student.class_id).push(student);
    }
    const arranged = [];
    const width = Math.max(1, Number(columns) || students.length || 1);
    while (arranged.length < students.length) {
      const seatIndex = arranged.length;
      const leftClass = seatIndex % width === 0 ? null : arranged[seatIndex - 1]?.class_id;
      const frontClass = seatIndex < width ? null : arranged[seatIndex - width]?.class_id;
      let pickId = null;
      let pickPenalty = Infinity;
      let pickRemaining = -1;
      for (const classId of classOrder) {
        const pool = pools.get(classId);
        if (!pool?.length) continue;
        const penalty = Number(classId === leftClass) + Number(classId === frontClass);
        if (penalty < pickPenalty || (penalty === pickPenalty && pool.length > pickRemaining)) {
          pickId = classId;
          pickPenalty = penalty;
          pickRemaining = pool.length;
        }
      }
      if (pickId === null) break;
      arranged.push(pools.get(pickId).shift());
    }
    return arranged;
  };

  // The maximize strategy handles the most restrictive rooms first. This
  // avoids wasting an all-class room before a room reserved for one class.
  const roomPlan = rooms.map((room, index) => ({ ...room, originalIndex: index }));
  if (strategy === 'maximize') {
    roomPlan.sort((left, right) => {
      const leftRestriction = left.class_ids?.length || Number.MAX_SAFE_INTEGER;
      const rightRestriction = right.class_ids?.length || Number.MAX_SAFE_INTEGER;
      return leftRestriction - rightRestriction || left.originalIndex - right.originalIndex;
    });
  }

  let mixedCursor = 0;
  for (const room of roomPlan) {
    const capacity = Math.max(0, Math.floor(Number(room.capacity) || 0));
    const eligible = eligibleClassIds(room);
    if (capacity === 0 || eligible.length === 0) continue;
    let roomStudents = [];

    if (strategy === 'sequential') {
      for (const classId of eligible) {
        const queue = queues.get(classId);
        roomStudents.push(...queue.splice(0, Math.min(capacity - roomStudents.length, queue.length)));
        if (roomStudents.length >= capacity) break;
      }
    } else if (strategy === 'balanced') {
      const share = Math.floor(capacity / eligible.length);
      for (const classId of eligible) {
        const queue = queues.get(classId);
        roomStudents.push(...queue.splice(0, Math.min(share, queue.length)));
      }
      while (roomStudents.length < capacity) {
        let biggestId = null;
        for (const classId of eligible) {
          const queue = queues.get(classId);
          if (queue?.length > 0 && (biggestId === null || queue.length > queues.get(biggestId).length)) {
            biggestId = classId;
          }
        }
        if (biggestId === null) break;
        roomStudents.push(queues.get(biggestId).shift());
      }
      roomStudents = arrangeForSeparation(roomStudents, room.columns);
    } else if (strategy === 'maximize') {
      const width = Math.max(1, Number(room.columns) || capacity);
      while (roomStudents.length < capacity) {
        const active = eligible.filter((id) => queues.get(id)?.length > 0);
        if (active.length === 0) break;
        const seatIndex = roomStudents.length;
        const leftClass = seatIndex % width === 0 ? null : roomStudents[seatIndex - 1]?.class_id;
        const frontClass = seatIndex < width ? null : roomStudents[seatIndex - width]?.class_id;
        let pickId = null;
        let pickPenalty = Infinity;
        let pickRemaining = -1;
        for (const classId of active) {
          const queue = queues.get(classId);
          const penalty = Number(classId === leftClass) + Number(classId === frontClass);
          if (penalty < pickPenalty || (penalty === pickPenalty && queue.length > pickRemaining)) {
            pickId = classId;
            pickPenalty = penalty;
            pickRemaining = queue.length;
          }
        }
        roomStudents.push(queues.get(pickId).shift());
      }
    } else {
      // Mixed: deterministic round-robin within the room's allowed classes.
      let emptyPasses = 0;
      while (roomStudents.length < capacity && emptyPasses < eligible.length) {
        const classId = eligible[mixedCursor % eligible.length];
        mixedCursor++;
        const queue = queues.get(classId);
        if (queue?.length) {
          roomStudents.push(queue.shift());
          emptyPasses = 0;
        } else {
          emptyPasses++;
        }
      }
    }

    pushRoomSeats(room, roomStudents);
  }

  return {
    seats,
    unseated: [...queues.values()].reduce((total, queue) => total + queue.length, 0),
  };
}

/**
 * Assign invigilators to rooms across sittings, balancing duty counts.
 *  - sittings: [{ key, roomIds: [room_id] }] in chronological order
 *  - pool: staff ids
 * Returns Map<sittingKey, Map<room_id, staffId|null>>.
 * Pure function — unit tested.
 */
export function assignInvigilators({ sittings, pool }) {
  const dutyCount = new Map(pool.map((id) => [id, 0]));
  const result = new Map();
  for (const sitting of sittings) {
    const usedThisSitting = new Set();
    const roomMap = new Map();
    for (const roomId of sitting.roomIds) {
      // Least-burdened staff member not already used in this sitting; ties
      // break by pool order so the outcome is deterministic.
      let pick = null;
      for (const staffId of pool) {
        if (usedThisSitting.has(staffId)) continue;
        if (pick === null || dutyCount.get(staffId) < dutyCount.get(pick)) {
          pick = staffId;
        }
      }
      if (pick !== null) {
        usedThisSitting.add(pick);
        dutyCount.set(pick, dutyCount.get(pick) + 1);
      }
      roomMap.set(roomId, pick);
    }
    result.set(sitting.key, roomMap);
  }
  return result;
}

/**
 * Soft-delete every room allocation + seat for an exam. Called whenever the
 * schedule changes (papers added/removed/moved, timetable regenerated) —
 * seating is derived data and must never outlive the sittings it was built
 * for. Returns how many room allocations were cleared.
 */
export async function clearExamSeating(db, schoolId, examId) {
  await db`
    UPDATE exam_seat_assignments SET deleted_at = now()
    WHERE exam_id = ${examId} AND school_id = ${schoolId} AND deleted_at IS NULL
  `;
  const cleared = await db`
    UPDATE exam_room_allocations SET deleted_at = now()
    WHERE exam_id = ${examId} AND school_id = ${schoolId} AND deleted_at IS NULL
    RETURNING id
  `;
  return cleared.length;
}

function normalizeAllocationParams(raw = {}) {
  const rawRoomConfigs = Array.isArray(raw.room_configs) ? raw.room_configs : [];
  const configByRoom = new Map();
  for (const config of rawRoomConfigs) {
    if (!config?.room_id) continue;
    configByRoom.set(String(config.room_id), {
      room_id: String(config.room_id),
      class_ids: Array.isArray(config.class_ids)
        ? [...new Set(config.class_ids.map(String))]
        : [],
    });
  }
  const requestedRoomIds = Array.isArray(raw.room_ids) && raw.room_ids.length > 0
    ? raw.room_ids.map(String)
    : [...configByRoom.keys()];
  const p = {
    room_ids: [...new Set(requestedRoomIds)],
    room_configs: [],
    strategy: ['sequential', 'mixed', 'balanced', 'maximize'].includes(raw.strategy)
      ? raw.strategy
      : 'maximize',
    invigilator_staff_ids: Array.isArray(raw.invigilator_staff_ids)
      ? [...new Set(raw.invigilator_staff_ids.map(String))]
      : [],
  };
  if (p.room_ids.length === 0) {
    throw new ExamTimetableError('Select at least one room');
  }
  p.room_configs = p.room_ids.map((roomId) => (
    configByRoom.get(roomId) || { room_id: roomId, class_ids: [] }
  ));
  return p;
}

/**
 * Generate (or regenerate) seating + invigilation for an exam.
 * Returns { sittings, rooms_used, students_seated, invigilators_assigned, warnings }.
 */
export async function generateExamAllocations({ schoolId, examId, params: rawParams, db = sql }) {
  const runInTx = typeof db.begin === 'function'
    ? (fn) => db.begin(fn)
    : (fn) => db.savepoint(fn);
  const params = normalizeAllocationParams(rawParams);

  const [exam] = await db`
    SELECT id, academic_year_id FROM exams
    WHERE id = ${examId} AND school_id = ${schoolId} AND deleted_at IS NULL
  `;
  if (!exam) throw new ExamTimetableError('Exam not found', 404);

  // Sittings = distinct (date, session start) across the exam's dated papers.
  const paperRows = await db`
    SELECT DISTINCT es.exam_date::text AS exam_date,
           COALESCE(es.start_time, '00:00'::time)::text AS session_start,
           es.class_id
    FROM exam_subjects es
    WHERE es.exam_id = ${examId} AND es.school_id = ${schoolId}
      AND es.deleted_at IS NULL AND es.exam_date IS NOT NULL
  `;
  if (paperRows.length === 0) {
    throw new ExamTimetableError('Generate the exam timetable before allocating rooms');
  }

  const sittingMap = new Map(); // key -> { exam_date, session_start, classIds: Set }
  for (const row of paperRows) {
    const key = `${row.exam_date}|${row.session_start}`;
    let sitting = sittingMap.get(key);
    if (!sitting) {
      sitting = { exam_date: row.exam_date, session_start: row.session_start, classIds: new Set() };
      sittingMap.set(key, sitting);
    }
    sitting.classIds.add(String(row.class_id));
  }
  const sittings = [...sittingMap.values()].sort((a, b) =>
    `${a.exam_date}|${a.session_start}`.localeCompare(`${b.exam_date}|${b.session_start}`)
  );

  // Rooms, kept in the admin's chosen fill order.
  const roomRows = await db`
    SELECT id, name, row_count, column_count, capacity FROM exam_rooms
    WHERE id = ANY(${params.room_ids}) AND school_id = ${schoolId} AND deleted_at IS NULL
  `;
  if (roomRows.length !== params.room_ids.length) {
    throw new ExamTimetableError('One or more rooms not found for this school');
  }
  const roomById = new Map(roomRows.map((r) => [String(r.id), r]));
  const roomConfigById = new Map(params.room_configs.map((config) => [config.room_id, config]));
  const rooms = params.room_ids.map((id) => ({
    room_id: id,
    capacity: Number(roomById.get(id).capacity),
    rows: Number(roomById.get(id).row_count),
    columns: Number(roomById.get(id).column_count),
    class_ids: roomConfigById.get(id)?.class_ids || [],
  }));

  // Invigilator pool (validated against this school when provided).
  let pool = params.invigilator_staff_ids;
  if (pool.length > 0) {
    const staffRows = await db`
      SELECT id FROM staff WHERE id = ANY(${pool}) AND school_id = ${schoolId} AND deleted_at IS NULL
    `;
    if (staffRows.length !== pool.length) {
      throw new ExamTimetableError('One or more invigilators not found for this school');
    }
  }

  // Students of every involved class, enrollment-year scoped, in a stable
  // seating order (class → section → roll number → name).
  const allClassIds = [...new Set(sittings.flatMap((s) => [...s.classIds]))];
  const scheduledClassIds = new Set(allClassIds);
  for (const config of params.room_configs) {
    const invalidClassIds = config.class_ids.filter((id) => !scheduledClassIds.has(id));
    if (invalidClassIds.length > 0) {
      throw new ExamTimetableError('A room includes a class that is not scheduled in this exam');
    }
  }
  const studentRows = await db`
    SELECT se.id AS enrollment_id, cs.class_id,
           c.sort_order AS class_sort, c.name AS class_name,
           sec.name AS section_name, se.roll_number, p.display_name
    FROM student_enrollments se
    JOIN class_sections cs ON se.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    JOIN students s ON se.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    WHERE cs.class_id = ANY(${allClassIds})
      AND cs.school_id = ${schoolId}
      AND cs.academic_year_id = ${exam.academic_year_id}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
      AND s.deleted_at IS NULL
    ORDER BY c.sort_order NULLS LAST, c.name, sec.name, se.roll_number NULLS LAST, p.display_name
  `;
  const studentsByClass = new Map();
  const classOrder = [];
  for (const row of studentRows) {
    const cid = String(row.class_id);
    if (!studentsByClass.has(cid)) {
      studentsByClass.set(cid, []);
      classOrder.push(cid);
    }
    studentsByClass.get(cid).push({ enrollment_id: row.enrollment_id, class_id: cid });
  }

  // Capacity check for every sitting before touching anything.
  const shortfalls = [];
  const seatPlanBySitting = new Map();
  for (const sitting of sittings) {
    const sittingClassOrder = classOrder.filter((id) => sitting.classIds.has(id));
    const plan = seatStudents({
      studentsByClass,
      classOrder: sittingClassOrder,
      rooms,
      strategy: params.strategy,
    });
    if (plan.unseated > 0) {
      const eligibleCapacity = rooms.reduce((total, room) => {
        const allowed = room.class_ids.length === 0 || room.class_ids.some((id) => sitting.classIds.has(id));
        return total + (allowed ? room.capacity : 0);
      }, 0);
      shortfalls.push(
        `${sitting.exam_date} ${sitting.session_start.slice(0, 5)}: ${plan.unseated} student(s) do not fit (eligible capacity ${eligibleCapacity})`
      );
    }
    seatPlanBySitting.set(`${sitting.exam_date}|${sitting.session_start}`, plan);
  }
  if (shortfalls.length > 0) {
    throw new ExamTimetableError(
      'Not enough eligible room capacity. Add rooms, increase rows/columns, or adjust room class rules.',
      400,
      { shortfalls }
    );
  }

  // Only allocate rooms that actually received students in a sitting.
  const invigPlan = assignInvigilators({
    sittings: sittings.map((s) => {
      const key = `${s.exam_date}|${s.session_start}`;
      const usedRooms = [...new Set(seatPlanBySitting.get(key).seats.map((x) => x.room_id))];
      return { key, roomIds: usedRooms };
    }),
    pool,
  });

  const result = await runInTx(async (tx) => {
    await tx`SELECT id FROM exams WHERE id = ${examId} AND school_id = ${schoolId} FOR UPDATE`;

    await clearExamSeating(tx, schoolId, examId);

    let seated = 0;
    let invigilated = 0;
    for (const sitting of sittings) {
      const key = `${sitting.exam_date}|${sitting.session_start}`;
      const plan = seatPlanBySitting.get(key);
      const roomInvig = invigPlan.get(key) || new Map();
      const usedRoomIds = [...new Set(plan.seats.map((x) => x.room_id))];

      for (const roomId of usedRoomIds) {
        const invigilator = roomInvig.get(roomId) || null;
        const [alloc] = await tx`
          INSERT INTO exam_room_allocations
            (school_id, exam_id, exam_date, session_start, room_id, invigilator_staff_id)
          VALUES (${schoolId}, ${examId}, ${sitting.exam_date}, ${sitting.session_start},
                  ${roomId}, ${invigilator})
          RETURNING id
        `;
        if (invigilator) invigilated++;

        const roomSeats = plan.seats
          .filter((x) => x.room_id === roomId)
          .map((x) => ({
            school_id: schoolId,
            room_allocation_id: alloc.id,
            exam_id: examId,
            exam_date: sitting.exam_date,
            session_start: sitting.session_start,
            student_enrollment_id: x.enrollment_id,
            class_id: x.class_id,
            seat_no: x.seat_no,
          }));
        if (roomSeats.length > 0) {
          await tx`INSERT INTO exam_seat_assignments ${tx(roomSeats)}`;
          seated += roomSeats.length;
        }
      }
    }

    await tx`
      UPDATE exams SET allocation_params = ${sql.json(params)}
      WHERE id = ${examId} AND school_id = ${schoolId}
    `;

    return { students_seated: seated, invigilators_assigned: invigilated };
  });

  const warnings = [];
  if (pool.length === 0) {
    warnings.push('No invigilator pool selected — rooms were allocated without invigilators.');
  }

  // Classes on the schedule with nobody enrolled for the exam's year.
  const classesWithStudents = new Set(studentRows.map((r) => String(r.class_id)));
  const classNameRows = await db`
    SELECT id, name FROM classes WHERE id = ANY(${allClassIds}) AND school_id = ${schoolId}
  `;
  for (const c of classNameRows) {
    if (!classesWithStudents.has(String(c.id))) {
      warnings.push(`${c.name} has no enrolled students for this academic year — no seats created for it.`);
    }
  }

  // Invigilators who are also booked for ANOTHER exam at the same date+session.
  const overlaps = await db`
    SELECT DISTINCT p.display_name, e2.name AS exam_name
    FROM exam_room_allocations mine
    JOIN exam_room_allocations other
      ON other.exam_date = mine.exam_date
      AND other.session_start = mine.session_start
      AND other.invigilator_staff_id = mine.invigilator_staff_id
      AND other.exam_id <> mine.exam_id
      AND other.school_id = ${schoolId}
      AND other.deleted_at IS NULL
    JOIN exams e2 ON other.exam_id = e2.id AND e2.deleted_at IS NULL AND e2.status <> 'cancelled'
    JOIN staff st ON mine.invigilator_staff_id = st.id
    JOIN persons p ON st.person_id = p.id
    WHERE mine.exam_id = ${examId} AND mine.school_id = ${schoolId} AND mine.deleted_at IS NULL
  `;
  for (const o of overlaps) {
    warnings.push(`${o.display_name} is also invigilating "${o.exam_name}" at the same time — review the assignment.`);
  }

  return {
    ...result,
    sittings: sittings.length,
    rooms_used: rooms.length,
    warnings,
  };
}
