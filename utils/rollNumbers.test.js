import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateRollAssignments } from './rollNumbers.js';

const enrollmentIds = ['enrollment-1', 'enrollment-2', 'enrollment-3'];

describe('roll number validation', () => {
  it('accepts complete continuous ranges starting at 1 or another positive number', () => {
    const fromOne = validateRollAssignments(
      enrollmentIds.map((enrollment_id, index) => ({ enrollment_id, roll_number: index + 1 })),
      enrollmentIds,
    );
    const fromTwentyOne = validateRollAssignments(
      enrollmentIds.map((enrollment_id, index) => ({ enrollment_id, roll_number: index + 21 })),
      enrollmentIds,
    );

    assert.deepEqual({ start: fromOne.start, end: fromOne.end }, { start: 1, end: 3 });
    assert.deepEqual({ start: fromTwentyOne.start, end: fromTwentyOne.end }, { start: 21, end: 23 });
  });

  it('rejects duplicate numbers and ranges with gaps', () => {
    assert.throws(
      () => validateRollAssignments([
        { enrollment_id: enrollmentIds[0], roll_number: 1 },
        { enrollment_id: enrollmentIds[1], roll_number: 1 },
        { enrollment_id: enrollmentIds[2], roll_number: 2 },
      ], enrollmentIds),
      { code: 'DUPLICATE_ROLL_NUMBER' },
    );
    assert.throws(
      () => validateRollAssignments([
        { enrollment_id: enrollmentIds[0], roll_number: 1 },
        { enrollment_id: enrollmentIds[1], roll_number: 2 },
        { enrollment_id: enrollmentIds[2], roll_number: 4 },
      ], enrollmentIds),
      { code: 'NON_CONTINUOUS_ROLL_NUMBERS' },
    );
  });

  it('rejects partial rosters and unknown enrollments', () => {
    assert.throws(
      () => validateRollAssignments([
        { enrollment_id: enrollmentIds[0], roll_number: 1 },
        { enrollment_id: enrollmentIds[1], roll_number: 2 },
      ], enrollmentIds),
      { code: 'INCOMPLETE_CLASS_ROSTER' },
    );
    assert.throws(
      () => validateRollAssignments([
        { enrollment_id: enrollmentIds[0], roll_number: 1 },
        { enrollment_id: enrollmentIds[1], roll_number: 2 },
        { enrollment_id: 'not-in-class', roll_number: 3 },
      ], enrollmentIds),
      { code: 'INCOMPLETE_CLASS_ROSTER' },
    );
  });
});
