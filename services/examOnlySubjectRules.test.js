import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExamOnlySubjectError,
  chooseApplicablePaper,
  isAdminMarksOverride,
  mergeMarksAssignments,
  normalizeExamOnlyEntries,
  validateSpecialSubjectSpecs,
} from './examOnlySubjectRules.js';

test('special subject names are trimmed and duplicates are rejected case-insensitively', () => {
  const specs = validateSpecialSubjectSpecs([{
    name: '  Handwriting  ',
    max_marks: 20,
    passing_marks: 0,
    targets: [{ class_id: 'class-1', class_section_id: 'section-a' }],
  }]);
  assert.equal(specs[0].name, 'Handwriting');
  assert.equal(specs[0].passing_marks, 0);

  assert.throws(
    () => validateSpecialSubjectSpecs([
      {
        name: 'Handwriting',
        max_marks: 20,
        passing_marks: 8,
        targets: [{ class_id: 'class-1', class_section_id: null }],
      },
      {
        name: ' handwriting ',
        max_marks: 10,
        passing_marks: 4,
        targets: [{ class_id: 'class-1', class_section_id: 'section-a' }],
      },
    ]),
    (error) => error instanceof ExamOnlySubjectError && /Duplicate special subject/.test(error.message),
  );
});

test('invalid mark limits are rejected and a class-wide target overlaps sections', () => {
  assert.throws(
    () => validateSpecialSubjectSpecs([{
      name: 'Drawing',
      max_marks: 0,
      passing_marks: 0,
      targets: [{ class_id: 'class-1', class_section_id: null }],
    }]),
    /greater than zero/,
  );
  assert.throws(
    () => validateSpecialSubjectSpecs([{
      name: 'Drawing',
      max_marks: 10,
      passing_marks: -1,
      targets: [{ class_id: 'class-1', class_section_id: null }],
    }]),
    /between 0 and maximum/,
  );

  const differentSections = validateSpecialSubjectSpecs([
    {
      name: 'Drawing',
      max_marks: 10,
      passing_marks: 4,
      targets: [
        { class_id: 'class-1', class_section_id: 'a' },
        { class_id: 'class-1', class_section_id: 'b' },
      ],
    },
  ]);
  assert.equal(differentSections[0].targets.length, 2);
});

test('section-specific papers win and two exams are ambiguous', () => {
  const chosen = chooseApplicablePaper([
    { exam_id: 'exam-1', class_section_id: null, id: 'class-wide' },
    { exam_id: 'exam-1', class_section_id: 'section-a', id: 'section' },
  ], 'section-a');
  assert.equal(chosen.ambiguous, false);
  assert.equal(chosen.paper.id, 'section');

  const ambiguous = chooseApplicablePaper([
    { exam_id: 'exam-1', class_section_id: 'section-a', id: 'one' },
    { exam_id: 'exam-2', class_section_id: null, id: 'two' },
  ], 'section-a');
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.paper, null);
});

test('legacy client max marks do not widen the configured limit', () => {
  const rows = normalizeExamOnlyEntries(
    [{ student_id: 's1', marks: 30, max_marks: 25 }],
    { configuredMax: 40 },
  );
  assert.deepEqual(rows, [{ student_id: 's1', marks: 30, is_absent: false }]);

  assert.throws(
    () => normalizeExamOnlyEntries(
      [{ student_id: 's1', marks: 30, max_marks: 100 }],
      { configuredMax: 20 },
    ),
    /between 0 and 20/,
  );

  const absent = normalizeExamOnlyEntries(
    [{ student_id: 's1', marks: 'A', max_marks: 25 }],
    { configuredMax: 20 },
  );
  assert.deepEqual(absent, [{ student_id: 's1', marks: null, is_absent: true }]);
});

test('exam-only assignments are appended without replacing a real teaching assignment', () => {
  const merged = mergeMarksAssignments(
    [{
      class_section_id: 'sec-a',
      class_id: 'class-1',
      class_name: '5',
      section_id: 'A',
      section_name: 'A',
      subject_id: 'math',
      subject_name: 'Math',
      assignment_id: 'sec-a-math',
    }],
    [
      {
        class_section_id: 'sec-a',
        class_id: 'class-1',
        class_name: '5',
        section_id: 'A',
        section_name: 'A',
        subject_id: 'math',
        subject_name: 'Math',
      },
      {
        class_section_id: 'sec-a',
        class_id: 'class-1',
        class_name: '5',
        section_id: 'A',
        section_name: 'A',
        subject_id: 'hand',
        subject_name: 'Handwriting',
      },
    ],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].assignment_id, 'sec-a-math');
  assert.equal(merged[0].exam_only, undefined);
  assert.equal(merged[1].subject_name, 'Handwriting');
  assert.equal(merged[1].exam_only, true);
  assert.equal(merged[1].assignment_id, 'sec-a-hand');
});

test('only the admin role overrides class-teacher marks entry', () => {
  assert.equal(isAdminMarksOverride({ roles: ['admin'] }), true);
  assert.equal(isAdminMarksOverride({ roles: ['teacher'] }), false);
  assert.equal(isAdminMarksOverride({ roles: ['principal'] }), false);
});
