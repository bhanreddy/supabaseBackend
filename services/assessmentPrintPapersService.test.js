import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFormativePrintPapers } from './assessmentPrintPapersService.js';

const paper = { exam_subject_id: 'english', subject_name: 'English', assessment_schema: 'consolidated',
  max_marks: '20', passing_marks: '7.2', participation_max_marks: '10', written_work_max_marks: '10',
  project_work_max_marks: '10', slip_test_max_marks: '20' };
const mark = { exam_subject_id: 'english', mark_id: 'saved', marks_obtained: '43.5', participation_marks: '10',
  written_work_marks: '10', project_work_marks: '10', slip_test_marks: '13.5' };
const students = (...rows) => rows.map((row) => ({ subjects: [row] }));

test('recovers section A English while the same shared paper remains direct in section B', () => {
  Object.freeze(paper); Object.freeze(mark);
  const original = JSON.stringify({ paper, mark });
  const recovered = resolveFormativePrintPapers([paper], students(mark))[0];
  assert.equal(recovered.assessment_schema, 'component');
  assert.equal(recovered.max_marks, 50);
  assert.equal(recovered.passing_marks, 18);
  assert.equal(recovered.print_component_recovery, true);
  const b = resolveFormativePrintPapers([paper], students({ ...mark, marks_obtained: '17' }))[0];
  assert.equal(b, paper);
  assert.equal(JSON.stringify({ paper, mark }), original);
});

test('requires matching, complete, valid components across every scored row', () => {
  for (const conflicting of [
    { marks_obtained: 17 }, { marks_obtained: 43.4 }, { participation_marks: null },
    { participation_marks: 11, marks_obtained: 44.5 }, { participation_marks: -1, marks_obtained: 32.5 },
  ]) assert.equal(resolveFormativePrintPapers([paper], students(mark, { ...mark, ...conflicting }))[0], paper);
  for (const p of [{ ...paper, max_marks: 50 }, { ...paper, max_marks: 0 },
    { ...paper, written_work_max_marks: null }, { ...paper, assessment_schema: 'component' }]) {
    assert.equal(resolveFormativePrintPapers([p], students(mark))[0], p);
  }
});

test('missing and absent rows cannot trigger recovery and do not prevent valid cohort evidence', () => {
  const absent = { ...mark, is_absent: true, participation_marks: null };
  const missing = { ...mark, mark_id: null };
  assert.equal(resolveFormativePrintPapers([paper], students(absent, missing))[0], paper);
  assert.equal(resolveFormativePrintPapers([paper], students(mark, absent, missing))[0].max_marks, 50);
});
