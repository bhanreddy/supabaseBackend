export class RollNumberValidationError extends Error {
  constructor(message, code = 'INVALID_ROLL_NUMBERS') {
    super(message);
    this.name = 'RollNumberValidationError';
    this.code = code;
  }
}

/**
 * Validate a complete class roll-number submission.
 *
 * A teacher may choose any positive starting number, but the submitted range
 * must be unique and gap-free (for example 1,2,3 or 21,22,23).
 */
export function validateRollAssignments(rawAssignments, expectedEnrollmentIds = []) {
  if (!Array.isArray(rawAssignments) || rawAssignments.length === 0) {
    throw new RollNumberValidationError('Add a roll number for every student in the class.');
  }

  const assignments = rawAssignments.map((raw) => {
    const enrollmentId = String(raw?.enrollment_id || '').trim();
    const rollNumber = Number(raw?.roll_number);
    if (!enrollmentId) {
      throw new RollNumberValidationError('Every roll number must belong to a valid student enrollment.');
    }
    if (!Number.isSafeInteger(rollNumber) || rollNumber < 1 || rollNumber > 9999) {
      throw new RollNumberValidationError('Roll numbers must be whole numbers between 1 and 9999.');
    }
    return { enrollment_id: enrollmentId, roll_number: rollNumber };
  });

  const enrollmentIds = assignments.map((item) => item.enrollment_id);
  if (new Set(enrollmentIds).size !== enrollmentIds.length) {
    throw new RollNumberValidationError('A student was included more than once.', 'DUPLICATE_STUDENT');
  }

  const rollNumbers = assignments.map((item) => item.roll_number);
  if (new Set(rollNumbers).size !== rollNumbers.length) {
    throw new RollNumberValidationError('Each student must have a different roll number.', 'DUPLICATE_ROLL_NUMBER');
  }

  if (expectedEnrollmentIds.length > 0) {
    const expected = new Set(expectedEnrollmentIds.map(String));
    const submitted = new Set(enrollmentIds);
    if (
      expected.size !== submitted.size ||
      [...expected].some((enrollmentId) => !submitted.has(enrollmentId))
    ) {
      throw new RollNumberValidationError(
        'Roll numbers must be submitted for every current student in the class.',
        'INCOMPLETE_CLASS_ROSTER',
      );
    }
  }

  const sorted = [...rollNumbers].sort((a, b) => a - b);
  const start = sorted[0];
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] !== start + index) {
      throw new RollNumberValidationError(
        'Roll numbers must be continuous without gaps (for example 1, 2, 3 or 21, 22, 23).',
        'NON_CONTINUOUS_ROLL_NUMBERS',
      );
    }
  }

  return {
    assignments,
    start,
    end: sorted[sorted.length - 1],
  };
}
