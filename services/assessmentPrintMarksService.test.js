import test from 'node:test';
import assert from 'node:assert/strict';
import { assessmentPrintSubjects, minimumPassingPrintMark } from './assessmentPrintMarksService.js';
import { displayAssessmentPapers, summarizeStudentMarks } from './marksTotalsService.js';

const paper = (schema = 'consolidated', extra = {}) => ({
  exam_subject_id: 'english', subject_name: 'English', max_marks: schema === 'component' ? 50 : 25,
  assessment_schema: schema, slip_test_max_marks: 20, ...extra,
});
const saved = (score, extra = {}) => ({ exam_subject_id: 'english', mark_id: 'saved', marks_obtained: score, ...extra });
const freeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

test('the 36% floor uses configured maxima and rounds upward to the stored precision', () => {
  for (const [maximum, expected] of [[20, 7.2], [25, 9], [50, 18], [80, 28.8], [100, 36], [10, 3.6], ['12.34', 4.45], [.01, .01]]) {
    assert.equal(minimumPassingPrintMark(maximum), expected);
    assert.ok(expected / Number(maximum) >= .36);
  }
  for (const value of [null, '', 0, -1, 'invalid', Infinity]) assert.equal(minimumPassingPrintMark(value), null);
});

test('original mode preserves scores, and passing mode raises only direct marks below 36%', () => {
  const papers = freeze([paper()]);
  const subjects = freeze([saved(0), saved(8.99), saved(9), saved(20)]);
  assert.deepEqual(assessmentPrintSubjects(papers, subjects).map(row => row.marks_obtained), [0, 8.99, 9, 20]);
  assert.deepEqual(assessmentPrintSubjects(papers, subjects, 'passing_criteria').map(row => row.marks_obtained), [9, 9, 9, 20]);
  assert.deepEqual(subjects.map(row => row.marks_obtained), [0, 8.99, 9, 20]);
});

test('component Slip Test alone is raised even when the existing total already passes', () => {
  const papers = freeze([paper('component')]);
  const subjects = freeze([saved(42, { participation_marks: 10, written_work_marks: 10, project_work_marks: 10, slip_test_marks: 1 })]);
  const result = assessmentPrintSubjects(papers, subjects, 'passing_criteria');
  assert.equal(result[0].slip_test_marks, 7.2);
  assert.equal(result[0].marks_obtained, 37.2);
  assert.deepEqual([result[0].participation_marks, result[0].written_work_marks, result[0].project_work_marks], [10, 10, 10]);
  assert.equal(summarizeStudentMarks({ papers, subjects: result }).total_obtained, 37.2);
  assert.equal(subjects[0].slip_test_marks, 1);
  assert.equal(subjects[0].marks_obtained, 42);
  assert.equal(assessmentPrintSubjects(papers, subjects)[0].marks_obtained, 31);
});

test('configured component schema and Slip Test maximum override stale row metadata', () => {
  const result = assessmentPrintSubjects([paper('component', { max_marks: 25, slip_test_max_marks: 10 })], [saved(25, {
    assessment_schema: 'consolidated', slip_test_max_marks: 20,
    participation_marks: 5, written_work_marks: 5, project_work_marks: 5, slip_test_marks: 0,
  })], 'passing_criteria');
  assert.equal(result[0].slip_test_marks, 3.6);
  assert.equal(result[0].marks_obtained, 18.6);
});

test('print adjustment keeps absences, missing rows and invalid scores unchanged', () => {
  for (const schema of ['consolidated', 'component']) {
    const rows = [saved(null), saved(0, { is_absent: true, slip_test_marks: 0 }),
      saved(0, { mark_id: null, slip_test_marks: 0 }), saved('invalid', { slip_test_marks: 'invalid' })];
    const original = assessmentPrintSubjects([paper(schema)], rows);
    assert.deepEqual(assessmentPrintSubjects([paper(schema)], rows, 'passing_criteria'), original);
  }
  const missingSlip = [saved(30, { participation_marks: 10, written_work_marks: 10, project_work_marks: 10, slip_test_marks: null })];
  assert.equal(assessmentPrintSubjects([paper('component')], missingSlip, 'passing_criteria')[0].slip_test_marks, null);
  assert.equal(assessmentPrintSubjects([paper('consolidated', { max_marks: 0 })], [saved(0)], 'passing_criteria')[0].marks_obtained, 0);
});

test('passing marks do not create an unused Science/EVS entry or count both alternatives', () => {
  const papers = [paper('consolidated', { subject_name: 'Science' }), paper('consolidated', { exam_subject_id: 'evs', subject_name: 'EVS' })];
  const adjusted = assessmentPrintSubjects(papers, [saved(0), saved(null, { exam_subject_id: 'evs', mark_id: null })], 'passing_criteria');
  assert.deepEqual(displayAssessmentPapers(papers, [{ subjects: adjusted }]).map(p => p.subject_name), ['Science']);
  const totals = summarizeStudentMarks({ papers, subjects: adjusted });
  assert.equal(totals.total_obtained, 9);
  assert.equal(totals.total_max, 25);
  assert.equal(totals.is_complete, true);
});
