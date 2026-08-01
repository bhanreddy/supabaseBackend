// Exam timetable generator — DB integration test.
// Everything (seed + generation) runs inside one transaction that is rolled
// back at the end, so the shared database is never mutated (same pattern as
// the transport integration tests). The service receives the open transaction
// via its `db` parameter and nests its own work as a savepoint.
// Run: node tests/examTimetable.integration.js
import assert from 'node:assert/strict';
import sql from '../db.js';
import { generateExamTimetable, ExamTimetableError } from '../services/examTimetableService.js';
import { generateExamAllocations } from '../services/examAllocationService.js';

const ROLLBACK = Symbol('exam-tt-rollback');
let assertions = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); assertions++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); assertions++; };

async function run() {
  try {
    await sql.begin(async (tx) => {
      const suffix = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;

      // ── Seed ──────────────────────────────────────────────────────────
      const [school] = await tx`
        INSERT INTO schools (name, code, is_active) VALUES (${`ExamTT ${suffix}`}, ${`ett${suffix}`}, true) RETURNING id
      `;
      const [otherSchool] = await tx`
        INSERT INTO schools (name, code, is_active) VALUES (${`ExamTT B ${suffix}`}, ${`etb${suffix}`}, true) RETURNING id
      `;
      const schoolId = school.id;

      const [year] = await tx`
        INSERT INTO academic_years (school_id, code, start_date, end_date)
        VALUES (${schoolId}, '2026-27', '2026-06-01', '2027-04-30') RETURNING id
      `;
      const [c1] = await tx`INSERT INTO classes (school_id, name) VALUES (${schoolId}, 'Class 6') RETURNING id`;
      const [c2] = await tx`INSERT INTO classes (school_id, name) VALUES (${schoolId}, 'Class 7') RETURNING id`;
      const [c3] = await tx`INSERT INTO classes (school_id, name) VALUES (${schoolId}, 'Class 8') RETURNING id`;
      const [foreignClass] = await tx`INSERT INTO classes (school_id, name) VALUES (${otherSchool.id}, 'Class X') RETURNING id`;
      const [secA] = await tx`INSERT INTO sections (school_id, name) VALUES (${schoolId}, 'A') RETURNING id`;
      const [cs1] = await tx`
        INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
        VALUES (${schoolId}, ${c1.id}, ${secA.id}, ${year.id}) RETURNING id
      `;
      const [cs2] = await tx`
        INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
        VALUES (${schoolId}, ${c2.id}, ${secA.id}, ${year.id}) RETURNING id
      `;
      const [cs3] = await tx`
        INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
        VALUES (${schoolId}, ${c3.id}, ${secA.id}, ${year.id}) RETURNING id
      `;

      const subjectIds = {};
      for (const [name, code] of [['Math', 'MAT'], ['Science', 'SCI'], ['English', 'ENG']]) {
        const [s] = await tx`
          INSERT INTO subjects (school_id, name, code) VALUES (${schoolId}, ${name}, ${`${code}${suffix}`.slice(0, 20)}) RETURNING id
        `;
        subjectIds[name] = s.id;
      }
      for (const subj of ['Math', 'Science', 'English']) {
        await tx`INSERT INTO class_subjects (school_id, class_section_id, subject_id) VALUES (${schoolId}, ${cs1.id}, ${subjectIds[subj]})`;
      }
      for (const subj of ['Math', 'English']) {
        await tx`INSERT INTO class_subjects (school_id, class_section_id, subject_id) VALUES (${schoolId}, ${cs2.id}, ${subjectIds[subj]})`;
      }
      // Class 8 deliberately has no class_subjects rows. Its timetable is the
      // only authoritative record that Science is taught there.
      await tx`
        INSERT INTO timetable_slots (
          school_id, academic_year_id, class_section_id, day_of_week,
          period_number, subject_id, start_time, end_time
        )
        VALUES (
          ${schoolId}, ${year.id}, ${cs3.id}, 'monday',
          1, ${subjectIds.Science}, '09:30', '10:15'
        )
      `;

      // Holiday on Tue 2026-07-21 — generator must skip it.
      await tx`
        INSERT INTO events (school_id, title, event_type, start_date, is_all_day)
        VALUES (${schoolId}, 'Test Holiday', 'holiday', '2026-07-21', true)
      `;

      const [exam] = await tx`
        INSERT INTO exams (school_id, name, academic_year_id, exam_type)
        VALUES (${schoolId}, 'Unit Test 1', ${year.id}, 'unit') RETURNING id
      `;

      // ── Timetable-only subject fallback ───────────────────────────────
      const [timetableOnlyExam] = await tx`
        INSERT INTO exams (school_id, name, academic_year_id, exam_type)
        VALUES (${schoolId}, 'Timetable Source Test', ${year.id}, 'unit') RETURNING id
      `;
      const timetableOnlyGen = await generateExamTimetable({
        schoolId,
        examId: timetableOnlyExam.id,
        db: tx,
        params: {
          class_ids: [c3.id],
          start_date: '2026-07-20',
          end_date: '2026-07-25',
        },
      });
      eq(timetableOnlyGen.inserted, 1, 'timetable-only subject is available to exam generation');
      const [timetableOnlyPaper] = await tx`
        SELECT class_id, subject_id
        FROM exam_subjects
        WHERE exam_id = ${timetableOnlyExam.id} AND deleted_at IS NULL
      `;
      eq(timetableOnlyPaper.class_id, c3.id, 'timetable-only paper uses the selected class');
      eq(timetableOnlyPaper.subject_id, subjectIds.Science, 'timetable-only paper uses the scheduled subject');

      // ── Generate (aligned) ────────────────────────────────────────────
      const gen = await generateExamTimetable({
        schoolId,
        examId: exam.id,
        db: tx,
        params: {
          class_ids: [c1.id, c2.id],
          start_date: '2026-07-20',
          end_date: '2026-07-25',
          start_time: '09:30',
          end_time: '12:30',
          subject_order: [subjectIds.Math, subjectIds.Science, subjectIds.English],
        },
      });
      eq(gen.inserted, 5, 'aligned inserts 3 papers for c1 + 2 for c2');

      const papers = await tx`
        SELECT class_id, subject_id, exam_date::text AS exam_date, start_time::text AS start_time
        FROM exam_subjects WHERE exam_id = ${exam.id} AND deleted_at IS NULL
      `;
      const mathDates = new Set(papers.filter((p) => p.subject_id === subjectIds.Math).map((p) => p.exam_date));
      eq(mathDates.size, 1, 'aligned: Math on the same day for both classes');
      ok([...mathDates][0] === '2026-07-20', 'Math lands on the first working day');
      ok(!papers.some((p) => p.exam_date === '2026-07-21'), 'holiday date skipped');
      ok(papers.every((p) => p.start_time === '09:30:00'), 'session time applied');

      const [examRow] = await tx`
        SELECT start_date::text AS s, end_date::text AS e, timetable_published FROM exams WHERE id = ${exam.id}
      `;
      eq(examRow.s, '2026-07-20', 'exam start snapped to schedule');
      eq(examRow.e, '2026-07-23', 'exam end snapped (holiday pushed English to Thu)');
      eq(examRow.timetable_published, false, 'not published after generation');

      // ── Marks preservation on regenerate ──────────────────────────────
      const [{ id: genderId }] = await tx`SELECT id FROM genders ORDER BY id LIMIT 1`;
      const [{ id: statusId }] = await tx`SELECT id FROM student_statuses ORDER BY id LIMIT 1`;
      const [person] = await tx`
        INSERT INTO persons (school_id, first_name, gender_id, display_name)
        VALUES (${schoolId}, 'Test', ${genderId}, 'Test Student') RETURNING id
      `;
      const [student] = await tx`
        INSERT INTO students (school_id, person_id, admission_no, admission_date, status_id)
        VALUES (${schoolId}, ${person.id}, ${`ADM${suffix}`}, '2026-06-01', ${statusId}) RETURNING id
      `;
      const [enrollment] = await tx`
        INSERT INTO student_enrollments (school_id, student_id, academic_year_id, class_section_id, start_date)
        VALUES (${schoolId}, ${student.id}, ${year.id}, ${cs1.id}, '2026-06-01') RETURNING id
      `;
      const [markedPaper] = await tx`
        SELECT id FROM exam_subjects
        WHERE exam_id = ${exam.id} AND class_id = ${c1.id} AND subject_id = ${subjectIds.Math} AND deleted_at IS NULL
      `;
      await tx`
        INSERT INTO marks (school_id, exam_subject_id, student_enrollment_id, marks_obtained)
        VALUES (${schoolId}, ${markedPaper.id}, ${enrollment.id}, 88)
      `;

      const regen = await generateExamTimetable({
        schoolId,
        examId: exam.id,
        db: tx,
        params: {
          class_ids: [c1.id, c2.id],
          start_date: '2026-08-03',
          end_date: '2026-08-08',
          mode: 'per_class',
        },
      });
      eq(regen.preserved, 1, 'paper with marks reported as preserved');
      eq(regen.inserted, 4, 'remaining papers regenerated');
      const [stillThere] = await tx`
        SELECT exam_date::text AS exam_date FROM exam_subjects WHERE id = ${markedPaper.id} AND deleted_at IS NULL
      `;
      eq(stillThere.exam_date, '2026-07-20', 'marked paper kept its original id and date');

      // ── Sessions + explicit subject selection ─────────────────────────
      const regen2 = await generateExamTimetable({
        schoolId,
        examId: exam.id,
        db: tx,
        params: {
          class_ids: [c1.id],
          start_date: '2026-09-07',
          end_date: '2026-09-12',
          sessions: [
            { start_time: '09:30', end_time: '11:30' },
            { start_time: '13:00', end_time: '15:00' },
          ],
          // English deliberately excluded; Science ordered before Math.
          subject_ids: [subjectIds.Science, subjectIds.Math],
          subject_marks: [
            { subject_id: subjectIds.Science, max_marks: 50, passing_marks: 18 },
          ],
        },
      });
      eq(regen2.preserved, 1, 'marked Math paper still preserved with subject selection');
      // Math has marks so only Science is (re)inserted.
      eq(regen2.inserted, 1, 'only the selected, unmarked subject is inserted');
      const sessionPapers = await tx`
        SELECT subject_id, exam_date::text AS exam_date, start_time::text AS start_time,
               max_marks, passing_marks
        FROM exam_subjects WHERE exam_id = ${exam.id} AND class_id = ${c1.id} AND deleted_at IS NULL
        ORDER BY exam_date, start_time
      `;
      const engGone = !sessionPapers.some((p) => p.subject_id === subjectIds.English);
      ok(engGone, 'excluded subject (English) has no paper');
      const sciPaper = sessionPapers.find((p) => p.subject_id === subjectIds.Science);
      eq(sciPaper.exam_date, '2026-09-07', 'first selected subject on day 1');
      eq(sciPaper.start_time, '09:30:00', 'session-1 timing applied');
      eq(Number(sciPaper.max_marks), 50, 'subject-specific maximum marks applied');
      eq(Number(sciPaper.passing_marks), 18, 'subject-specific passing marks applied');

      // ── Seating & invigilation ────────────────────────────────────────
      // More students: cs1 gets 4 more (5 total in c1), cs2 gets 3 (c2).
      const seedStudent = async (csId, n) => {
        const [pp] = await tx`
          INSERT INTO persons (school_id, first_name, gender_id, display_name)
          VALUES (${schoolId}, ${`S${n}`}, ${genderId}, ${`Student ${n}`}) RETURNING id
        `;
        const [st] = await tx`
          INSERT INTO students (school_id, person_id, admission_no, admission_date, status_id)
          VALUES (${schoolId}, ${pp.id}, ${`ADM${suffix}${n}`}, '2026-06-01', ${statusId}) RETURNING id
        `;
        await tx`
          INSERT INTO student_enrollments (school_id, student_id, academic_year_id, class_section_id, start_date, roll_number)
          VALUES (${schoolId}, ${st.id}, ${year.id}, ${csId}, '2026-06-01', ${n})
        `;
      };
      for (let n = 2; n <= 5; n++) await seedStudent(cs1.id, n);
      for (let n = 6; n <= 8; n++) await seedStudent(cs2.id, n);

      // Two invigilators.
      const staffIds = [];
      for (const nm of ['Teacher A', 'Teacher B']) {
        const [pp] = await tx`
          INSERT INTO persons (school_id, first_name, gender_id, display_name)
          VALUES (${schoolId}, ${nm}, ${genderId}, ${nm}) RETURNING id
        `;
        const [st] = await tx`
          INSERT INTO staff (school_id, person_id, staff_code, joining_date)
          VALUES (${schoolId}, ${pp.id}, ${`STF${suffix}${nm.slice(-1)}`}, '2026-06-01') RETURNING id
        `;
        staffIds.push(st.id);
      }

      // Two rooms: capacity 5 + 4 = 9 (8 students total).
      const [roomA] = await tx`
        INSERT INTO exam_rooms (school_id, name, row_count, column_count, capacity)
        VALUES (${schoolId}, 'Room A', 1, 5, 5) RETURNING id
      `;
      const [roomB] = await tx`
        INSERT INTO exam_rooms (school_id, name, row_count, column_count, capacity)
        VALUES (${schoolId}, 'Room B', 1, 4, 4) RETURNING id
      `;

      const alloc = await generateExamAllocations({
        schoolId,
        examId: exam.id,
        db: tx,
        params: {
          room_ids: [roomA.id, roomB.id],
          strategy: 'mixed',
          invigilator_staff_ids: staffIds,
        },
      });
      ok(alloc.sittings > 0, 'allocation covers the scheduled sittings');
      ok(alloc.students_seated > 0, 'students were seated');

      // Every sitting seats all 8 students of the two classes... unless the
      // sitting only involves one class (per_class regen split Math to c1
      // dates). Verify per-sitting integrity instead of a global count.
      const allocRows = await tx`
        SELECT era.id, era.exam_date::text AS d, era.session_start::text AS t,
               era.invigilator_staff_id,
               (SELECT COUNT(*)::int FROM exam_seat_assignments esa
                 WHERE esa.room_allocation_id = era.id AND esa.deleted_at IS NULL) AS seats
        FROM exam_room_allocations era
        WHERE era.exam_id = ${exam.id} AND era.deleted_at IS NULL
      `;
      ok(allocRows.length > 0, 'room allocations persisted');
      ok(allocRows.every((r) => r.seats > 0), 'no empty rooms allocated');

      const bySitting = new Map();
      for (const r of allocRows) {
        const k = `${r.d}|${r.t}`;
        if (!bySitting.has(k)) bySitting.set(k, []);
        bySitting.get(k).push(r);
      }
      for (const rows of bySitting.values()) {
        const invigs = rows.map((r) => r.invigilator_staff_id).filter(Boolean);
        eq(new Set(invigs).size, invigs.length, 'no invigilator double-booked within a sitting');
      }

      // One seat per student per sitting (DB index would also catch this).
      const [{ dup }] = await tx`
        SELECT COUNT(*)::int AS dup FROM (
          SELECT student_enrollment_id, exam_date, session_start
          FROM exam_seat_assignments
          WHERE exam_id = ${exam.id} AND deleted_at IS NULL
          GROUP BY 1, 2, 3 HAVING COUNT(*) > 1
        ) x
      `;
      eq(dup, 0, 'one seat per student per sitting');

      // Capacity shortfall: a single tiny room cannot hold a full sitting.
      const [tinyRoom] = await tx`
        INSERT INTO exam_rooms (school_id, name, row_count, column_count, capacity)
        VALUES (${schoolId}, 'Tiny', 1, 2, 2) RETURNING id
      `;
      await assert.rejects(
        generateExamAllocations({
          schoolId,
          examId: exam.id,
          db: tx,
          params: { room_ids: [tinyRoom.id], strategy: 'sequential', invigilator_staff_ids: [] },
        }),
        (err) => err instanceof ExamTimetableError && /Not enough room capacity/.test(err.message)
      );
      assertions++;

      // Tenant isolation: rooms from another school are rejected.
      const [foreignRoom] = await tx`
        INSERT INTO exam_rooms (school_id, name, row_count, column_count, capacity)
        VALUES (${otherSchool.id}, 'Foreign', 5, 10, 50) RETURNING id
      `;
      await assert.rejects(
        generateExamAllocations({
          schoolId,
          examId: exam.id,
          db: tx,
          params: { room_ids: [foreignRoom.id], strategy: 'sequential', invigilator_staff_ids: [] },
        }),
        (err) => err instanceof ExamTimetableError && /rooms not found/i.test(err.message)
      );
      assertions++;

      // ── Schedule changes invalidate seating ───────────────────────────
      const regen3 = await generateExamTimetable({
        schoolId,
        examId: exam.id,
        db: tx,
        params: {
          class_ids: [c1.id],
          start_date: '2026-10-05',
          end_date: '2026-10-10',
          subject_ids: [subjectIds.Science],
        },
      });
      ok(
        regen3.warnings.some((w) => /Seating & invigilation were cleared/.test(w)),
        'timetable regeneration warns that seating was cleared'
      );
      const [{ live_allocs }] = await tx`
        SELECT COUNT(*)::int AS live_allocs FROM exam_room_allocations
        WHERE exam_id = ${exam.id} AND deleted_at IS NULL
      `;
      eq(live_allocs, 0, 'stale room allocations soft-deleted on regeneration');
      const [{ live_seats }] = await tx`
        SELECT COUNT(*)::int AS live_seats FROM exam_seat_assignments
        WHERE exam_id = ${exam.id} AND deleted_at IS NULL
      `;
      eq(live_seats, 0, 'stale seat assignments soft-deleted on regeneration');

      // ── Capacity + tenant-isolation errors ────────────────────────────
      await assert.rejects(
        generateExamTimetable({
          schoolId,
          examId: exam.id,
          db: tx,
          params: { class_ids: [c1.id], start_date: '2026-08-03', end_date: '2026-08-04' },
        }),
        (err) => err instanceof ExamTimetableError && /Not enough exam days/.test(err.message)
      );
      assertions++;

      await assert.rejects(
        generateExamTimetable({
          schoolId,
          examId: exam.id,
          db: tx,
          params: { class_ids: [foreignClass.id], start_date: '2026-08-03', end_date: '2026-08-08' },
        }),
        (err) => err instanceof ExamTimetableError && /classes not found/i.test(err.message)
      );
      assertions++;

      throw ROLLBACK; // never commit test data
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  console.log(`examTimetable.integration.js: ${assertions} assertions passed (rolled back)`);
}

run().then(
  async () => { await sql.end({ timeout: 5 }); process.exit(0); },
  async (err) => { console.error('TEST FAILED:', err); await sql.end({ timeout: 5 }); process.exit(1); }
);
