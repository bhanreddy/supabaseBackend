import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeResultReadiness } from './examResultPublishingService.js';

test('result readiness stays false until every scheduled paper entry exists', () => {
  const readiness = summarizeResultReadiness([
    { exam_subject_id: 'math', class_name: '10', subject_name: 'Math', expected_entries: 30, entered_entries: 30 },
    { exam_subject_id: 'science', class_name: '10', subject_name: 'Science', expected_entries: 30, entered_entries: 28 },
  ]);

  assert.equal(readiness.ready, false);
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
  assert.equal(readiness.papers_complete, 2);
  assert.equal(readiness.missing_entries, 0);
});

test('an exam with papers but no active students is not publishable', () => {
  const readiness = summarizeResultReadiness([
    { exam_subject_id: 'math', class_name: '10', subject_name: 'Math', expected_entries: 0, entered_entries: 0 },
  ]);

  assert.equal(readiness.ready, false);
});
