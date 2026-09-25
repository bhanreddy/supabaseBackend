import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getUnavailableTeachers,
  getSubstitutionBoardData,
  validateSubstituteAvailability,
  getFirstAfternoonPeriodNumber,
  getScheduleContext,
  requiresManualSubstitutionReason,
} from '../services/teacherAvailabilityService.js';

describe('teacherAvailabilityService', () => {
  // Mock DB executor builder
  function createMockDb(fixtures = {}) {
    const fn = async (strings, ...values) => {
      const query = strings.join('?');
      // console.log('DEBUG QUERY:', query);

      // Conflict check in validateSubstituteAvailability
      if (query.includes('has_regular_class')) {
        return [
          {
            has_regular_class: fixtures.hasRegularClass ?? false,
            has_other_cover: fixtures.hasOtherCover ?? false,
            is_on_leave: fixtures.isOnLeave ?? false,
            is_absent: fixtures.isAbsent ?? false,
            is_half_day_afternoon: fixtures.isHalfDayAfternoon ?? false,
            declared_absent: fixtures.declaredAbsent ?? false,
          },
        ];
      }

      // 1. Leave applications query
      if (query.includes('la.id AS leave_id')) {
        return fixtures.leaves || [];
      }

      // 2. Staff attendance query
      if (query.includes('FROM staff_attendance sa') && query.includes('sa.status IN')) {
        return fixtures.attendance || [];
      }

      // 3. Attendance recorded existence check
      if (query.includes('SELECT EXISTS(SELECT 1 FROM staff_attendance') || query.includes('SELECT EXISTS(\n      SELECT 1 FROM staff_attendance')) {
        return [{ attendance_recorded: fixtures.attendanceRecorded ?? false }];
      }

      // 4. Schedule context
      if (query.includes('FROM academic_years ay')) {
        return fixtures.scheduleContext ? [fixtures.scheduleContext] : [];
      }

      // 5. Periods query
      if (query.includes('FROM periods p') && query.includes('SELECT id, name')) {
        return fixtures.periods || [];
      }

      // 6. First afternoon period query
      if (query.includes('FROM periods p') && query.includes('lunch')) {
        return [{ sort_order: fixtures.firstAfternoonPeriod || 5 }];
      }

      // 7. Timetable slots query
      if (query.includes('FROM timetable_slots ts')) {
        return fixtures.slots || [];
      }

      // 8. Active teaching staff check in validateSubstituteAvailability
      if (query.includes('FROM staff st') && query.includes('JOIN users u')) {
        if (fixtures.inactiveTeacherId && values.includes(fixtures.inactiveTeacherId)) {
          return [];
        }
        return [{ id: 'active-user-1' }];
      }

      return [];
    };
    return fn;
  }

  test('approved full-day leave identifies teacher when no attendance recorded', async () => {
    const mockDb = createMockDb({
      leaves: [
        {
          leave_id: 'l-1',
          leave_status: 'approved',
          start_date: '2026-09-24',
          end_date: '2026-09-24',
          staff_id: 'staff-1',
          staff_code: 'T001',
          teacher_name: 'Anita Roy',
        },
      ],
      attendance: [],
      attendanceRecorded: false,
    });

    const result = await getUnavailableTeachers(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
    });

    assert.equal(result.unavailableTeachers.length, 1);
    const teacher = result.unavailableTeachers[0];
    assert.equal(teacher.id, 'staff-1');
    assert.deepEqual(teacher.sources, ['leave']);
    assert.equal(teacher.source_label, 'Leave');
    assert.equal(teacher.leave_status, 'approved');
    assert.equal(teacher.attendance_status, null);
    assert.equal(result.attendanceRecorded, false);
  });

  test('rejected or cancelled leaves are not treated as unavailable', async () => {
    // getUnavailableTeachers query filters where la.status = 'approved'
    // If DB returns empty array (because only rejected/cancelled leaves exist), teacher is not unavailable
    const mockDb = createMockDb({
      leaves: [],
      attendance: [],
      attendanceRecorded: true,
    });

    const result = await getUnavailableTeachers(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
    });

    assert.equal(result.unavailableTeachers.length, 0);
  });

  test('attendance absent supplements and identifies teacher with no leave', async () => {
    const mockDb = createMockDb({
      leaves: [],
      attendance: [
        {
          attendance_id: 'att-1',
          attendance_status: 'absent',
          staff_id: 'staff-2',
          staff_code: 'T002',
          teacher_name: 'Suresh Kumar',
        },
      ],
      attendanceRecorded: true,
    });

    const result = await getUnavailableTeachers(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
    });

    assert.equal(result.unavailableTeachers.length, 1);
    const teacher = result.unavailableTeachers[0];
    assert.equal(teacher.id, 'staff-2');
    assert.deepEqual(teacher.sources, ['attendance']);
    assert.equal(teacher.source_label, 'Attendance: Absent');
    assert.equal(teacher.attendance_status, 'absent');
    assert.equal(teacher.is_half_day, false);
    assert.equal(result.attendanceRecorded, true);
  });

  test('both leave and attendance for the same teacher deduplicates without loss of primary leave source', async () => {
    const mockDb = createMockDb({
      leaves: [
        {
          leave_id: 'l-1',
          leave_status: 'approved',
          start_date: '2026-09-24',
          end_date: '2026-09-24',
          staff_id: 'staff-common',
          staff_code: 'T003',
          teacher_name: 'Vikas Sharma',
        },
      ],
      attendance: [
        {
          attendance_id: 'att-common',
          attendance_status: 'absent',
          staff_id: 'staff-common',
          staff_code: 'T003',
          teacher_name: 'Vikas Sharma',
        },
      ],
      attendanceRecorded: true,
    });

    const result = await getUnavailableTeachers(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
    });

    assert.equal(result.unavailableTeachers.length, 1);
    const teacher = result.unavailableTeachers[0];
    assert.equal(teacher.id, 'staff-common');
    assert.deepEqual(teacher.sources, ['leave', 'attendance']);
    assert.equal(teacher.source_label, 'Leave, Attendance: Absent');
    assert.equal(teacher.leave_status, 'approved');
    assert.equal(teacher.attendance_status, 'absent');
  });

  test('half-day attendance marks teacher unavailable only for afternoon periods', async () => {
    const mockDb = createMockDb({
      leaves: [],
      attendance: [
        {
          attendance_id: 'att-hd',
          attendance_status: 'half_day',
          staff_id: 'staff-hd',
          staff_code: 'T004',
          teacher_name: 'Meena Patel',
        },
      ],
      attendanceRecorded: true,
      scheduleContext: {
        academic_year_id: 'ay-1',
        timetable_mode: 'uniform',
      },
      firstAfternoonPeriod: 4, // Afternoon starts at Period 4
      periods: [
        { sort_order: 1, name: 'P1', is_break: false },
        { sort_order: 2, name: 'P2', is_break: false },
        { sort_order: 3, name: 'P3', is_break: false },
        { sort_order: 4, name: 'P4', is_break: false },
      ],
      slots: [
        // Morning period for Meena (P2)
        {
          slot_id: 'slot-morning',
          period_number: 2,
          regular_teacher_id: 'staff-hd',
          regular_teacher_name: 'Meena Patel',
          class_name: '10',
          section_name: 'A',
          subject_name: 'Math',
        },
        // Afternoon period for Meena (P4)
        {
          slot_id: 'slot-afternoon',
          period_number: 4,
          regular_teacher_id: 'staff-hd',
          regular_teacher_name: 'Meena Patel',
          class_name: '10',
          section_name: 'B',
          subject_name: 'Math',
        },
      ],
    });

    const board = await getSubstitutionBoardData(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
      scope: 'affected',
    });

    // Only the afternoon slot (P4 >= 4) should be considered affected
    assert.equal(board.slots.length, 1);
    assert.equal(board.slots[0].slot_id, 'slot-afternoon');
    assert.equal(board.slots[0].period_number, 4);
    assert.equal(board.slots[0].unavailability_label, 'Attendance: Half Day');

    // Morning slot was not affected
    assert.ok(!board.slots.some((s) => s.slot_id === 'slot-morning'));
  });

  test('substitute validation rejects regular teacher covering own class', async () => {
    const mockDb = createMockDb();
    const result = await validateSubstituteAvailability(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
      slot: { absent_teacher_id: 't-same', period_number: 1 },
      substituteTeacherId: 't-same',
      academicYearId: 'ay-1',
      timetableDay: 'monday',
    });

    assert.equal(result.available, false);
    assert.equal(result.status, 400);
    assert.ok(result.error.includes('own class'));
  });

  test('substitute validation rejects teacher on approved leave', async () => {
    const mockDb = createMockDb({
      isOnLeave: true,
    });
    const result = await validateSubstituteAvailability(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
      slot: { absent_teacher_id: 't-absent', period_number: 1 },
      substituteTeacherId: 't-candidate',
      academicYearId: 'ay-1',
      timetableDay: 'monday',
    });

    assert.equal(result.available, false);
    assert.equal(result.status, 409);
    assert.ok(result.error.includes('approved leave'));
  });

  test('substitute validation rejects teacher marked absent in attendance', async () => {
    const mockDb = createMockDb({
      isAbsent: true,
    });
    const result = await validateSubstituteAvailability(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
      slot: { absent_teacher_id: 't-absent', period_number: 1 },
      substituteTeacherId: 't-candidate',
      academicYearId: 'ay-1',
      timetableDay: 'monday',
    });

    assert.equal(result.available, false);
    assert.equal(result.status, 409);
    assert.ok(result.error.includes('marked absent'));
  });

  test('substitute validation rejects teacher with timetable conflict in same period', async () => {
    const mockDb = createMockDb({
      hasRegularClass: true,
    });
    const result = await validateSubstituteAvailability(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
      slot: { absent_teacher_id: 't-absent', period_number: 1 },
      substituteTeacherId: 't-candidate',
      academicYearId: 'ay-1',
      timetableDay: 'monday',
    });

    assert.equal(result.available, false);
    assert.equal(result.status, 409);
    assert.ok(result.error.includes('no longer free'));
  });

  test('substitute validation allows free, active teacher with no clashes', async () => {
    const mockDb = createMockDb({
      isOnLeave: false,
      isAbsent: false,
      hasRegularClass: false,
      hasOtherCover: false,
      declaredAbsent: false,
    });
    const result = await validateSubstituteAvailability(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
      slot: { absent_teacher_id: 't-absent', period_number: 1 },
      substituteTeacherId: 't-free',
      academicYearId: 'ay-1',
      timetableDay: 'monday',
    });

    assert.equal(result.available, true);
    assert.equal(result.error, undefined);
  });

  test('unavailable teacher with no scheduled classes shows in unavailable list but produces no affected slots', async () => {
    const mockDb = createMockDb({
      leaves: [
        {
          leave_id: 'l-no-class',
          leave_status: 'approved',
          start_date: '2026-09-24',
          end_date: '2026-09-24',
          staff_id: 'staff-free',
          staff_code: 'T999',
          teacher_name: 'Counselor Teacher',
        },
      ],
      scheduleContext: {
        academic_year_id: 'ay-1',
        timetable_mode: 'uniform',
      },
      slots: [], // No classes scheduled for this teacher on this day
    });

    const board = await getSubstitutionBoardData(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
      scope: 'affected',
    });

    assert.equal(board.unavailable_teachers.length, 1);
    assert.equal(board.unavailable_teachers[0].id, 'staff-free');
    assert.equal(board.unavailable_teachers[0].affected_slots_count, 0);
    assert.equal(board.slots.length, 0);
    assert.equal(board.summary.total_slots, 0);
    assert.equal(board.summary.unavailable_teachers_count, 1);
  });

  test('multiple teachers and multiple affected classes are discovered and annotated', async () => {
    const mockDb = createMockDb({
      leaves: [
        {
          leave_id: 'l-1',
          leave_status: 'approved',
          start_date: '2026-09-24',
          end_date: '2026-09-24',
          staff_id: 't-1',
          staff_code: 'T1',
          teacher_name: 'Teacher One',
        },
      ],
      attendance: [
        {
          attendance_id: 'att-2',
          attendance_status: 'absent',
          staff_id: 't-2',
          staff_code: 'T2',
          teacher_name: 'Teacher Two',
        },
      ],
      scheduleContext: {
        academic_year_id: 'ay-1',
        timetable_mode: 'uniform',
      },
      slots: [
        {
          slot_id: 'slot-1',
          period_number: 1,
          regular_teacher_id: 't-1',
          regular_teacher_name: 'Teacher One',
          class_name: '10',
          section_name: 'A',
          subject_name: 'Physics',
        },
        {
          slot_id: 'slot-2',
          period_number: 2,
          regular_teacher_id: 't-2',
          regular_teacher_name: 'Teacher Two',
          class_name: '9',
          section_name: 'B',
          subject_name: 'Chemistry',
        },
        // Unaffected slot for Teacher Three (present)
        {
          slot_id: 'slot-3',
          period_number: 3,
          regular_teacher_id: 't-3',
          regular_teacher_name: 'Teacher Three',
          class_name: '8',
          section_name: 'A',
          subject_name: 'Biology',
        },
      ],
    });

    const board = await getSubstitutionBoardData(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
      scope: 'affected',
    });

    assert.equal(board.unavailable_teachers.length, 2);
    // slot-1 and slot-2 are affected; slot-3 is not
    assert.equal(board.slots.length, 2);
    assert.equal(board.slots[0].slot_id, 'slot-1');
    assert.equal(board.slots[0].unavailability_label, 'Leave');
    assert.equal(board.slots[1].slot_id, 'slot-2');
    assert.equal(board.slots[1].unavailability_label, 'Attendance: Absent');
  });

  test('substitute validation rejects inactive teachers', async () => {
    const mockDb = createMockDb({
      inactiveTeacherId: 't-inactive',
    });
    const result = await validateSubstituteAvailability(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
      slot: { absent_teacher_id: 't-absent', period_number: 1 },
      substituteTeacherId: 't-inactive',
      academicYearId: 'ay-1',
      timetableDay: 'monday',
    });

    assert.equal(result.available, false);
    assert.equal(result.status, 400);
    assert.ok(result.error.includes('inactive'));
  });

  test('substitute validation rejects a teacher already covering another class in the period', async () => {
    const mockDb = createMockDb({ hasOtherCover: true });
    const result = await validateSubstituteAvailability(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
      slot: { absent_teacher_id: 't-absent', period_number: 2 },
      substituteTeacherId: 't-busy',
      academicYearId: 'ay-1',
      timetableDay: 'monday',
    });

    assert.equal(result.available, false);
    assert.equal(result.status, 409);
    assert.ok(result.error.includes('no longer free'));
  });

  test('substitute validation rejects half-day attendance in an afternoon period', async () => {
    const mockDb = createMockDb({ isHalfDayAfternoon: true });
    const result = await validateSubstituteAvailability(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
      slot: { absent_teacher_id: 't-absent', period_number: 6 },
      substituteTeacherId: 't-half',
      academicYearId: 'ay-1',
      timetableDay: 'monday',
    });

    assert.equal(result.available, false);
    assert.equal(result.status, 409);
    assert.ok(result.error.includes('half-day'));
  });

  test('manual cover is required only when the regular teacher is still available', () => {
    assert.equal(requiresManualSubstitutionReason(null, 1, 5), true);
    assert.equal(requiresManualSubstitutionReason({ is_half_day: true }, 2, 5), true);
    assert.equal(requiresManualSubstitutionReason({ is_half_day: true }, 5, 5), false);
    assert.equal(requiresManualSubstitutionReason({ is_half_day: false, sources: ['leave'] }, 1, 5), false);
    assert.equal(requiresManualSubstitutionReason({ is_half_day: false, sources: ['attendance'] }, 3, 5), false);
  });

  test('scope=all loads scheduled slots without counting them as uncovered before assignment', async () => {
    const slots = [
      {
        slot_id: 'slot-free',
        period_number: 1,
        is_break: false,
        regular_teacher_id: 't-free',
        regular_teacher_name: 'Free Teacher',
        class_name: '6',
        section_name: 'A',
        subject_name: 'English',
      },
      {
        slot_id: 'slot-break',
        period_number: 2,
        is_break: true,
        regular_teacher_id: 't-free',
        regular_teacher_name: 'Free Teacher',
        class_name: '6',
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
    const mockDb = createMockDb({
      leaves: [],
      attendance: [],
      scheduleContext: { academic_year_id: 'ay-1', timetable_mode: 'uniform' },
      slots,
    });

    const all = await getSubstitutionBoardData(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
      scope: 'all',
    });
    const affected = await getSubstitutionBoardData(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
      scope: 'affected',
    });

    assert.equal(all.slots.length, 3);
    assert.deepEqual(all.slots.map((slot) => slot.slot_id), ['slot-free', 'slot-break', 'slot-open']);
    assert.equal(all.summary.total_slots, 0);
    assert.equal(all.summary.uncovered_slots, 0);
    assert.equal(all.summary.covered_slots, 0);
    assert.equal(affected.slots.length, 0);
    assert.equal(affected.summary.uncovered_slots, 0);
  });

  test('a manual substitution appears on the affected board and is labelled manual', async () => {
    const mockDb = createMockDb({
      leaves: [],
      attendance: [],
      scheduleContext: { academic_year_id: 'ay-1', timetable_mode: 'uniform' },
      slots: [
        {
          slot_id: 'slot-free',
          period_number: 1,
          is_break: false,
          regular_teacher_id: 't-free',
          regular_teacher_name: 'Free Teacher',
          class_name: '6',
          section_name: 'A',
          subject_name: 'English',
        },
        {
          slot_id: 'slot-manual',
          period_number: 4,
          is_break: false,
          regular_teacher_id: 't-free',
          regular_teacher_name: 'Free Teacher',
          class_name: '8',
          section_name: 'C',
          subject_name: 'Science',
          substitution_id: 'sub-1',
          substitute_teacher_id: 't-cover',
          substitute_teacher_name: 'Cover Teacher',
          reason: 'Department meeting',
        },
      ],
    });

    const board = await getSubstitutionBoardData(mockDb, {
      schoolId: 1,
      date: '2026-09-24',
      scope: 'affected',
    });

    assert.equal(board.slots.length, 1);
    assert.equal(board.slots[0].slot_id, 'slot-manual');
    assert.deepEqual(board.slots[0].unavailability_sources, ['manual']);
    assert.equal(board.slots[0].unavailability_label, 'Manual Substitution');
    assert.equal(board.slots[0].substitute_teacher_name, 'Cover Teacher');
    assert.equal(board.slots[0].reason, 'Department meeting');
    assert.equal(board.summary.total_slots, 1);
    assert.equal(board.summary.covered_slots, 1);
    assert.equal(board.summary.uncovered_slots, 0);
  });

  test('tenant isolation ensures schoolId is strictly scoped in queries', async () => {
    const capturedValues = [];
    const mockDb = async (strings, ...values) => {
      capturedValues.push(...values);
      return [];
    };

    await getUnavailableTeachers(mockDb, {
      schoolId: 42,
      date: '2026-09-24',
    });
    await getSubstitutionBoardData(mockDb, {
      schoolId: 42,
      date: '2026-09-24',
      scope: 'all',
    });

    // Verify schoolId 42 was passed to SQL queries and another school was not.
    assert.ok(capturedValues.includes(42), 'schoolId 42 must be present in SQL parameters');
    assert.equal(capturedValues.includes(99), false);
  });
});
