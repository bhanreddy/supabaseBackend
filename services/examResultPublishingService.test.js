import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeResultReadiness } from './examResultPublishingService.js';

test('result readiness stays false until every scheduled paper entry exists', () => {
  const readiness = summarizeResultReadiness([
    { exam_subject_id: 'math', class_name: '10', subject_name: 'Math', expected_entries: 30, entered_entries: 30 },
    { exam_subject_id: 'science', class_name: '10', subject_name: 'Science', expected_entries: 30, entered_entries: 28 },
  ]);

  assert.equal(readiness.ready, false);
  assert.equal(readiness.publishable, true);
  assert.equal(readiness.partial, true);
  assert.equal(readiness.papers_complete, 1);
  assert.equal(readiness.expected_entries, 60);
  assert.equal(readiness.entered_entries, 58);
  assert.equal(readiness.missing_entries, 2);
});

test('result readiness becomes true when every active student has every paper mark', () => {
  const readiness = summarizeResultReadiness([
    { exam_subject_id: 'math', class_name: '10', subject_name: 'Math', expected_entries: 2, entered_entries: 2 },
    { exam_subject_id: 'science', class_name: '10', subject_name: 'Science', expected_entries: 2, entered_entries: 2 },
  ]);

  assert.equal(readiness.ready, true);
  assert.equal(readiness.publishable, true);
  assert.equal(readiness.partial, false);
  assert.equal(readiness.papers_complete, 2);
  assert.equal(readiness.missing_entries, 0);
});

test('an exam with papers but no active students is not publishable', () => {
  const readiness = summarizeResultReadiness([
    { exam_subject_id: 'math', class_name: '10', subject_name: 'Math', expected_entries: 0, entered_entries: 0 },
  ]);

  assert.equal(readiness.ready, false);
  assert.equal(readiness.publishable, false);
});

test('readiness lists only teachers with missing marks for each class and subject', () => {
  const readiness = summarizeResultReadiness(
    [
      {
        exam_subject_id: 'hindi-5',
        class_id: 'class-5',
        subject_id: 'hindi',
        class_name: '5',
        subject_name: 'Hindi',
        expected_entries: 12,
        entered_entries: 7,
      },
    ],
    [
      {
        exam_subject_id: 'hindi-5',
        teacher_id: 'teacher-a',
        teacher_name: 'Anita Rao',
        section_names: ['A'],
        expected_entries: 6,
        entered_entries: 1,
      },
      {
        exam_subject_id: 'hindi-5',
        teacher_id: 'teacher-b',
        teacher_name: 'Meera Shah',
        section_names: ['B'],
        expected_entries: 6,
        entered_entries: 6,
      },
    ],
    [
      { exam_subject_id: 'hindi-5', section_id: 'section-c', section_name: 'C' },
    ],
  );

  assert.deepEqual(readiness.papers[0].pending_teachers, [
    {
      teacher_id: 'teacher-a',
      teacher_name: 'Anita Rao',
      section_names: ['A'],
      expected_entries: 6,
      entered_entries: 1,
      missing_entries: 5,
    },
  ]);
  assert.deepEqual(readiness.papers[0].unassigned_sections, [
    { section_id: 'section-c', section_name: 'C' },
  ]);
});
