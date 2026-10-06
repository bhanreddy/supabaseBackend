import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSummativePrintSubject, prepareSummativeMarksSection,
  summativeFormativeKeys, usesSummativeMarksRegister,
} from './summativeMarksPrintService.js';

const exam = { name: 'SA-1', exam_type: 'sa_results' };
const paper = (name = 'Social', max = 80) => ({
  exam_subject_id: `sa-${name}`, subject_id: name, subject_name: name,
  max_marks: max, assessment_schema: 'consolidated',
});
const saved = (score, maximum = 50, extra = {}) => ({
  mark_id: 'saved', max_marks: maximum, marks_obtained: score, ...extra,
});
const component = (extra = {}) => saved(17.5, 50, {
  assessment_schema: 'component', participation_marks: 10, written_work_marks: 10,
  project_work_marks: 10, slip_test_marks: 17.5, ...extra,
});
const student = (id, papers, score = 70) => ({
  student_id: id, student_name: `Student ${id}`, subjects: papers.map((item) => ({
    ...saved(score, item.max_marks), exam_subject_id: item.exam_subject_id,
  })),
});
const section = (papers, students) => ({
  classSection: { id: 'section-a', class_name: '8', section_name: 'A' }, papers, students,
});
const sources = (studentId, papers, score = 45, maximum = 50, extra = {}) =>
  papers.flatMap((item) => ['FA-1', 'FA-2'].map((name) => ({
    ...saved(score, maximum), student_id: studentId, subject_id: item.subject_id,
    class_section_id: 'section-a', exam_name: name, exam_type: 'fa_results', ...extra,
  })));

test('the new summative register applies only to Classes 6–10', () => {
  for (const name of ['6', '6th', 'Class 7', 'GRADE 8', 'VI', 'VII', 'VIII', 'IX', 'X', '10TH', 'Std. 9']) {
    assert.equal(usesSummativeMarksRegister(exam, { class_name: name }), true, name);
  }
  for (const name of ['5', '5th', 'V', '11', 'XI', 'Nursery', '']) {
    assert.equal(usesSummativeMarksRegister(exam, { class_name: name }), false, name);
  }
  assert.equal(usesSummativeMarksRegister({ exam_type: 'fa_results' }, { class_name: '8' }), false);
});

test('70 out of 80 remains 70, and the combined FA totals contribute 18 out of 20', () => {
  const result = calculateSummativePrintSubject(paper(), saved('70', 80), saved('44', 50), saved('46', 50));
  assert.equal(result.exam_marks, 70);
  assert.equal(result.formative_contribution, 18);
  assert.equal(result.total, 88);
  assert.equal(result.maximum, 100);
  assert.equal(result.is_complete, true);
});

test('component FA sums and consolidated FA totals follow the same formula despite stale cached marks', () => {
  const direct = calculateSummativePrintSubject(paper(), saved(70, 80), saved(47.5), saved(47.5));
  const components = calculateSummativePrintSubject(paper(), saved(70, 80), component(), component());
  assert.deepEqual(components, direct);
  assert.equal(components.formative_contribution, 19);
  assert.equal(components.total, 89);
});

test('different FA maxima use the percentage of their combined totals', () => {
  const result = calculateSummativePrintSubject(paper(), saved(70, 80), saved(20, 25), saved(45, 50));
  assert.equal(result.formative_contribution, 17.33);
  assert.equal(result.total, 87.33);
});

test('both component and consolidated missing sources leave calculated totals incomplete', () => {
  for (const missing of [undefined, saved(null), component({
    participation_marks: null, written_work_marks: null, project_work_marks: null, slip_test_marks: null,
  })]) {
    const result = calculateSummativePrintSubject(paper(), saved(70, 80), saved(45), missing);
    assert.equal(result.exam_marks, 70);
    assert.equal(result.formative_contribution, null);
    assert.equal(result.total, null);
    assert.equal(result.is_complete, false);
  }
});

test('saved zeros and absences are entered results, with zero contribution', () => {
  const zero = calculateSummativePrintSubject(paper(), saved(0, 80), saved(0), saved(0));
  assert.equal(zero.total, 0);
  assert.equal(zero.is_complete, true);
  const absent = calculateSummativePrintSubject(paper(), saved(null, 80, { is_absent: true }), saved(40), saved(40));
  assert.equal(absent.exam_absent, true);
  assert.equal(absent.total, 16);
  const absentFa = calculateSummativePrintSubject(paper(), saved(70, 80), saved(null, 50, { is_absent: true }), saved(40));
  assert.equal(absentFa.formative_contribution, 8);
  assert.equal(absentFa.formative_absent, true);
});

test('Physics and Biology each contribute 40 + 10 and combine within a grand maximum of 600', () => {
  const papers = ['Telugu', 'Hindi', 'English', 'Math', 'Social'].map((name) => paper(name));
  papers.push(paper('Physics', 40), paper('Biology', 40));
  const child = student('one', papers, 70);
  child.subjects.slice(-2).forEach((mark) => { mark.marks_obtained = 35; });
  const rows = sources('one', papers, 45);
  rows.filter((row) => ['Physics', 'Biology'].includes(row.subject_id)).forEach((row) => {
    row.marks_obtained = 22.5; row.max_marks = 25;
  });
  const result = prepareSummativeMarksSection(section(papers, [child]), exam, rows).students[0];
  assert.equal(result.summative_subjects.at(-1).formative_contribution, 9);
  assert.equal(result.summative_subjects.at(-1).total, 44);
  assert.equal(result.total_obtained, 528);
  assert.equal(result.total_max, 600);
  assert.equal(result.percentage, 88);
  assert.equal(result.rank, 1);
});

test('the science pass threshold applies to the combined Science total', () => {
  const papers = [paper('Physics', 40), paper('Biology', 40)];
  const child = student('one', papers, 35);
  child.subjects[0].marks_obtained = 0;
  const result = prepareSummativeMarksSection(section(papers, [child]), exam, sources('one', papers, 0, 25)).students[0];
  assert.equal(result.total_obtained, 35);
  assert.equal(result.result_status, 'Pass');
});

test('FA data matches the student, subject and section, and does not substitute older saved marks for latest missing entries', () => {
  const papers = [paper()];
  const rows = [
    ...sources('one', papers, null),
    ...sources('one', papers, 50),
    ...sources('one', papers, 50, 50, { class_section_id: 'section-b' }),
    ...sources('two', papers, 50),
    ...sources('one', [paper('English')], 50),
  ];
  const result = prepareSummativeMarksSection(section(papers, [student('one', papers)]), exam, rows).students[0];
  assert.equal(result.is_complete, false);
  assert.equal(result.rank, null);
  assert.equal(result.total_obtained, null);
});

test('ranks and result filters use combined scores for the whole complete cohort', () => {
  const papers = [paper()];
  const students = [student('one', papers, 70), student('two', papers, 75), student('three', papers, 20), student('four', papers, 80)];
  const rows = [...sources('one', papers, 50), ...sources('two', papers, 0), ...sources('three', papers, 45)];
  const prepared = prepareSummativeMarksSection(section(papers, students), exam, rows);
  assert.deepEqual(prepared.students.map((child) => [child.total_obtained, child.rank]), [[90, 1], [75, 2], [38, 3], [null, null]]);
  const passed = prepareSummativeMarksSection(section(papers, students), exam, rows, 'competition', 'pass');
  assert.equal(passed.students.find((child) => child.student_id === 'three').result_status, 'Pass');
  assert.equal(passed.students.length, 3);
  const incomplete = prepareSummativeMarksSection(section(papers, students), exam, rows, 'competition', 'incomplete');
  assert.deepEqual(incomplete.students.map((child) => child.student_id), ['four']);
});

test('SA-2 uses FA-3 and FA-4; an unrecognized summative name is explained', () => {
  assert.deepEqual(summativeFormativeKeys({ ...exam, name: 'SA-II' }), ['fa3', 'fa4']);
  assert.throws(() => summativeFormativeKeys({ ...exam, name: 'Annual' }), /SA-1 or SA-2/);
  const papers = [paper()];
  const rows = sources('one', papers, 40).map((row) => ({ ...row, exam_name: row.exam_name === 'FA-1' ? 'FA-3' : 'FA-4' }));
  const result = prepareSummativeMarksSection(section(papers, [student('one', papers)]), { ...exam, name: 'SA-2' }, rows);
  assert.deepEqual(result.formative_keys, ['fa3', 'fa4']);
  assert.equal(result.students[0].total_obtained, 86);
});

test('a 100-mark exam prints the entered score directly without requiring an 80-mark configuration', () => {
  const papers = [paper('English', 100)];
  const result = prepareSummativeMarksSection(section(papers, [student('one', papers, 90)]), exam, sources('one', papers)).students[0];
  assert.equal(result.summative_subjects[0].exam_marks, 90);
  assert.equal(result.summative_subjects[0].formative_contribution, 18);
  assert.equal(result.summative_subjects[0].total, 108);
  assert.equal(result.total_obtained, 108);
  assert.equal(result.total_max, 120);
  assert.equal(result.percentage, 90);
  assert.equal(result.rank, 1);
});

test('mixed exam maxima preserve entered scores and use the actual combined maximum for percentage', () => {
  const papers = [paper('English', 100), paper('Social', 60)];
  const child = student('one', papers, 90);
  child.subjects[1].marks_obtained = 50;
  const result = prepareSummativeMarksSection(section(papers, [child]), exam, sources('one', papers)).students[0];
  assert.equal(result.total_obtained, 176);
  assert.equal(result.total_max, 200);
  assert.equal(result.percentage, 88);
});

test('the combined Science pass threshold uses its configured maximum when exam papers are not 40 marks', () => {
  const papers = [paper('Physics', 50), paper('Biology', 50)];
  const child = student('one', papers, 36);
  child.subjects[0].marks_obtained = 0;
  const result = prepareSummativeMarksSection(section(papers, [child]), exam, sources('one', papers, 0, 25)).students[0];
  assert.equal(result.total_obtained, 36);
  assert.equal(result.total_max, 120);
  assert.equal(result.percentage, 30);
  assert.equal(result.result_status, 'Fail');
});

test('summative totals and cohort ranks count entered Science or EVS once and preserve both results', () => {
  const papers = [paper('English'), paper('Science'), paper('EVS')];
  const scienceOnly = student('science', papers.filter((item) => item.subject_name !== 'EVS'));
  const evsOnly = student('evs', papers.filter((item) => item.subject_name !== 'Science'));
  const both = student('both', papers);
  both.subjects[2].marks_obtained = 80;
  const rows = [
    ...sources('science', papers.filter((item) => item.subject_name !== 'EVS')),
    ...sources('evs', papers.filter((item) => item.subject_name !== 'Science')),
    ...sources('both', papers),
  ];
  const result = prepareSummativeMarksSection(section(papers, [scienceOnly, evsOnly, both]), exam, rows);
  for (const child of result.students) {
    assert.equal(child.total_obtained, 176);
    assert.equal(child.total_max, 200);
    assert.equal(child.percentage, 88);
    assert.equal(child.is_complete, true);
    assert.equal(child.rank, 1);
    assert.equal(child.result_status, 'Pass');
  }
  const evsResult = result.students[2].summative_subjects.find((item) => item.subject_name === 'EVS');
  assert.equal(evsResult.total, 98);
  assert.equal(evsResult.counts_in_total, false);
});
