import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';

import {
  buildClassMarksWorkbook,
  buildMissingMarksWorkbook,
  buildSchoolMarksWorkbook,
  classifyMarksResult,
  missingMarksRows,
} from './resultWorkbooks.js';
import { summarizeStudentMarks } from '../services/marksTotalsService.js';

test('missing marks export includes assigned and unassigned class-subject gaps', () => {
  const readiness = {
    missing_entries: 3,
    papers: [{
      class_name: '2', subject_name: 'English',
      pending_teachers: [{ teacher_name: 'Anita', section_names: ['A'], expected_entries: 20, entered_entries: 18, missing_entries: 2 }],
      unassigned_sections: [{ section_name: 'B' }],
    }],
  };
  assert.deepEqual(missingMarksRows(readiness).map((row) => row.teacher_name), ['Anita', 'Unassigned']);
  assert.ok(buildMissingMarksWorkbook({ schoolName: 'School', examName: 'FA-1', readiness }).length > 0);
});

test('class marks export uses direct columns for direct papers and component columns for component papers', () => {
  const buffer = buildClassMarksWorkbook({
    schoolName: 'School', teacherName: 'Teacher', rankingMethod: 'competition',
    exam: { name: 'FA-1' }, classSection: { class_name: '2', section_name: 'A', academic_year: '2026-27' },
    papers: [
      { exam_subject_id: 'hin', subject_name: 'Hindi', assessment_schema: 'consolidated', max_marks: 25 },
      { exam_subject_id: 'eng', subject_name: 'English', assessment_schema: 'component', max_marks: 50, participation_max_marks: 10, written_work_max_marks: 10, project_work_max_marks: 10, slip_test_max_marks: 20 },
    ],
    students: [{
      student_name: 'Aarav', admission_no: 'A1', roll_number: 1, rank: 1, result_status: 'Pass',
      subjects: [
        { exam_subject_id: 'hin', mark_id: 'm1', marks_obtained: 23, max_marks: 25 },
        { exam_subject_id: 'eng', mark_id: 'm2', marks_obtained: 40, max_marks: 50, participation_marks: 9, written_work_marks: 8, project_work_marks: 8, slip_test_marks: 15 },
      ],
    }],
  });
  const sheet = XLSX.read(buffer, { type: 'buffer' }).Sheets['Class Marks'];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  assert.equal(rows[5][4], 'Hindi');
  assert.equal(rows[5][6], 'English');
  assert.equal(rows[6][4], 'Marks /25');
  assert.equal(rows[6][6], 'Participation /10');
  assert.equal(rows[7][4], 23);
  assert.equal(rows[7][6], 9);
});

test('staff class marks export writes numeric obtained, maximum and percentage from the shared service', () => {
  const papers = [
    { exam_subject_id: 'eng', subject_name: 'English', assessment_schema: 'consolidated', max_marks: 100 },
    { exam_subject_id: 'math', subject_name: 'Mathematics', assessment_schema: 'consolidated', max_marks: 100 },
    { exam_subject_id: 'sci', subject_name: 'Science', assessment_schema: 'consolidated', max_marks: 100 },
  ];
  const buffer = buildClassMarksWorkbook({
    schoolName: 'School', teacherName: 'Teacher', rankingMethod: 'competition',
    exam: { name: 'SA-1' }, classSection: { class_name: '5', section_name: 'A', academic_year: '2026-27' },
    papers,
    students: [
      {
        student_name: 'Aarav', admission_no: 'A1', roll_number: 1, rank: 1, result_status: 'Pass',
        subjects: [
          { exam_subject_id: 'eng', mark_id: 'm1', max_marks: 100, marks_obtained: 85 },
          { exam_subject_id: 'math', mark_id: 'm2', max_marks: 100, marks_obtained: 90 },
          { exam_subject_id: 'sci', mark_id: 'm3', max_marks: 100, marks_obtained: 80 },
        ],
      },
      {
        // Only two of three papers entered: the maximum must follow the marks.
        student_name: 'Maya', admission_no: 'A2', roll_number: 2, rank: 2, result_status: 'Incomplete',
        subjects: [
          { exam_subject_id: 'eng', mark_id: 'm4', max_marks: 100, marks_obtained: 85 },
          { exam_subject_id: 'math', mark_id: 'm5', max_marks: 100, marks_obtained: 85 },
          { exam_subject_id: 'sci', mark_id: null, max_marks: 100, marks_obtained: null },
        ],
      },
    ],
  });
  const sheet = XLSX.read(buffer, { type: 'buffer' }).Sheets['Class Marks'];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const summaryStart = 4 + papers.length * 2;

  assert.equal(rows[3][2], 'Exam Maximum Marks');
  assert.equal(rows[3][3], 300);
  assert.deepEqual(rows[6].slice(summaryStart), [
    'Total Obtained', 'Total Maximum', 'Percentage', 'Rank', 'Result', 'Entry Status',
  ]);

  assert.deepEqual(rows[7].slice(summaryStart, summaryStart + 3), [255, 300, 85]);
  assert.equal(rows[7][summaryStart + 5], 'Complete');
  assert.deepEqual(rows[8].slice(summaryStart, summaryStart + 3), [170, 200, 85]);
  assert.equal(rows[8][summaryStart + 5], '2/3 entered');

  const formattedSheet = XLSX.read(buffer, { type: 'buffer', cellNF: true }).Sheets['Class Marks'];
  const percentageCell = formattedSheet[XLSX.utils.encode_cell({ r: 7, c: summaryStart + 2 })];
  assert.equal(percentageCell.t, 'n');
  assert.equal(percentageCell.z, '0.00"%"');
  assert.equal(sheet[XLSX.utils.encode_cell({ r: 7, c: summaryStart })].t, 'n');
  assert.equal(sheet[XLSX.utils.encode_cell({ r: 7, c: summaryStart + 1 })].t, 'n');
});

test('class marks export keeps an absent paper in the maximum and leaves an unmarked student blank', () => {
  const papers = [
    { exam_subject_id: 'eng', subject_name: 'English', assessment_schema: 'consolidated', max_marks: 100 },
    { exam_subject_id: 'math', subject_name: 'Mathematics', assessment_schema: 'consolidated', max_marks: 100 },
  ];
  const buffer = buildClassMarksWorkbook({
    schoolName: 'School', teacherName: 'Teacher', rankingMethod: 'competition',
    exam: { name: 'SA-1' }, classSection: { class_name: '5', section_name: 'A', academic_year: '2026-27' },
    papers,
    students: [
      {
        student_name: 'Absent Student', admission_no: 'A1', roll_number: 1, rank: 2, result_status: 'Fail (Absent)',
        subjects: [
          { exam_subject_id: 'eng', mark_id: 'm1', max_marks: 100, marks_obtained: 80 },
          { exam_subject_id: 'math', mark_id: 'm2', max_marks: 100, marks_obtained: null, is_absent: true },
        ],
      },
      {
        student_name: 'No Marks', admission_no: 'A2', roll_number: 2, rank: null, result_status: 'Incomplete',
        subjects: [
          { exam_subject_id: 'eng', mark_id: null, max_marks: 100, marks_obtained: null },
          { exam_subject_id: 'math', mark_id: null, max_marks: 100, marks_obtained: null },
        ],
      },
    ],
  });
  const rows = XLSX.utils.sheet_to_json(
    XLSX.read(buffer, { type: 'buffer' }).Sheets['Class Marks'],
    { header: 1, defval: '' },
  );
  const summaryStart = 4 + papers.length * 2;
  assert.deepEqual(rows[7].slice(summaryStart, summaryStart + 3), [80, 200, 40]);
  assert.deepEqual(rows[8].slice(summaryStart, summaryStart + 3), ['', '', '']);
  assert.equal(rows[8][summaryStart + 5], '0/2 entered');
});

test('school marks export creates an overview and one sheet per class-section', () => {
  const paper = { exam_subject_id: 'eng', subject_name: 'English', assessment_schema: 'consolidated', max_marks: 25 };
  const student = {
    student_name: 'Aarav', admission_no: 'A1', roll_number: 1, rank: 1, result_status: 'Pass',
    subjects: [{ ...paper, mark_id: 'm1', marks_obtained: 23 }],
  };
  const buffer = buildSchoolMarksWorkbook({
    schoolName: 'School', exam: { name: 'FA-1', academic_year: '2026-27' }, rankingMethod: 'competition',
    sections: [
      { classSection: { class_name: '2', section_name: 'A', academic_year: '2026-27' }, teacherName: 'Teacher A', papers: [paper], students: [student] },
      { classSection: { class_name: '2', section_name: 'B', academic_year: '2026-27' }, teacherName: 'Teacher B', papers: [paper], students: [student] },
    ],
  });
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  assert.deepEqual(workbook.SheetNames, ['2-A', '2-B', 'Overview']);
  const overview = XLSX.utils.sheet_to_json(workbook.Sheets.Overview, { header: 1 });
  assert.equal(overview[4][1], 'Class');
  assert.equal(overview[4][6], 'Exam Maximum Marks');
  assert.equal(overview[5][2], 'A');
  assert.equal(overview[5][6], 25);
  assert.equal(overview[5][7], 1);
  assert.equal(overview[6][2], 'B');
});

test('accounts school-wide export totals every section with the same formula as the staff export', () => {
  const papers = [
    { exam_subject_id: 'eng', subject_name: 'English', assessment_schema: 'consolidated', max_marks: 50 },
    { exam_subject_id: 'math', subject_name: 'Mathematics', assessment_schema: 'consolidated', max_marks: 50 },
    { exam_subject_id: 'sci', subject_name: 'Science', assessment_schema: 'consolidated', max_marks: 50 },
  ];
  const subjects = [
    { exam_subject_id: 'eng', mark_id: 'm1', max_marks: 50, marks_obtained: 45 },
    { exam_subject_id: 'math', mark_id: 'm2', max_marks: 50, marks_obtained: 40 },
    { exam_subject_id: 'sci', mark_id: 'm3', max_marks: 50, marks_obtained: 35 },
  ];
  const student = {
    student_name: 'Aarav', admission_no: 'A1', roll_number: 1, rank: 1, result_status: 'Pass', subjects,
  };
  const schoolBuffer = buildSchoolMarksWorkbook({
    schoolName: 'School', exam: { name: 'SA-1', academic_year: '2026-27' }, rankingMethod: 'competition',
    sections: [
      { classSection: { class_name: '6', section_name: 'A', academic_year: '2026-27' }, teacherName: 'Teacher A', papers, students: [student] },
      { classSection: { class_name: '6', section_name: 'B', academic_year: '2026-27' }, teacherName: 'Teacher B', papers, students: [student] },
    ],
  });
  const classBuffer = buildClassMarksWorkbook({
    schoolName: 'School', teacherName: 'Teacher A', rankingMethod: 'competition',
    exam: { name: 'SA-1' }, classSection: { class_name: '6', section_name: 'A', academic_year: '2026-27' },
    papers, students: [student],
  });
  const summaryStart = 4 + papers.length * 2;
  const summaryOf = (buffer, sheetName) => XLSX.utils
    .sheet_to_json(XLSX.read(buffer, { type: 'buffer' }).Sheets[sheetName], { header: 1 })[7]
    .slice(summaryStart, summaryStart + 3);

  assert.deepEqual(summaryOf(schoolBuffer, '6-A'), [120, 150, 80]);
  assert.deepEqual(summaryOf(schoolBuffer, '6-B'), [120, 150, 80]);
  assert.deepEqual(summaryOf(classBuffer, 'Class Marks'), summaryOf(schoolBuffer, '6-A'));
});

test('exported cells equal the progress report screen summary for the same rows', () => {
  // Shaped exactly as postgres.js returns them: DECIMAL columns arrive as strings.
  const papers = [
    { exam_subject_id: 'eng', subject_name: 'English', assessment_schema: 'consolidated', max_marks: '100.00' },
    { exam_subject_id: 'math', subject_name: 'Mathematics', assessment_schema: 'consolidated', max_marks: '50.00' },
    { exam_subject_id: 'sci', subject_name: 'Science', assessment_schema: 'consolidated', max_marks: '25.00' },
  ];
  const subjects = [
    { exam_subject_id: 'eng', mark_id: 'm1', max_marks: '100.00', marks_obtained: '72.50', is_absent: false },
    { exam_subject_id: 'math', mark_id: 'm2', max_marks: '50.00', marks_obtained: null, is_absent: true },
    { exam_subject_id: 'sci', mark_id: null, max_marks: '25.00', marks_obtained: null, is_absent: false },
  ];
  // What GET /results/progress-card-assistant/student/:id reports on screen.
  const screenSummary = summarizeStudentMarks({ papers, subjects });

  const buffer = buildClassMarksWorkbook({
    schoolName: 'School', teacherName: 'Teacher', rankingMethod: 'competition',
    exam: { name: 'SA-1' }, classSection: { class_name: '7', section_name: 'A', academic_year: '2026-27' },
    papers,
    students: [{ student_name: 'Aarav', admission_no: 'A1', roll_number: 1, rank: 1, result_status: 'Fail (Absent)', subjects }],
  });
  const rows = XLSX.utils.sheet_to_json(
    XLSX.read(buffer, { type: 'buffer' }).Sheets['Class Marks'],
    { header: 1, defval: '' },
  );
  const summaryStart = 4 + papers.length * 2;

  assert.deepEqual(rows[7].slice(summaryStart, summaryStart + 3), [
    screenSummary.total_obtained,
    screenSummary.total_max,
    screenSummary.percentage,
  ]);
  assert.deepEqual(rows[7].slice(summaryStart, summaryStart + 3), [72.5, 150, 48.33]);
  assert.equal(rows[3][3], 175);
  assert.equal(rows[7][summaryStart + 5], '2/3 entered');
});

test('class sheet labels sections with no configured exam papers', () => {
  const buffer = buildClassMarksWorkbook({
    schoolName: 'School', teacherName: 'Teacher', rankingMethod: 'competition',
    exam: { name: 'FA-1' }, classSection: { class_name: '3', section_name: 'A', academic_year: '2026-27' },
    papers: [],
    students: [{
      student_name: 'Maya', admission_no: 'A2', roll_number: 2,
      rank: null, result_status: 'Incomplete', subjects: [],
    }],
  });
  const sheet = XLSX.read(buffer, { type: 'buffer' }).Sheets['Class Marks'];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  assert.equal(rows[7][9], 'No exam papers configured');
});

test('marks result classification distinguishes pass, fail, absence and incomplete entries', () => {
  const papers = [{ exam_subject_id: 'eng' }, { exam_subject_id: 'math' }];
  const subject = (id, marks, passing = 10, extra = {}) => ({
    exam_subject_id: id, mark_id: `mark-${id}`, marks_obtained: marks, passing_marks: passing, ...extra,
  });
  assert.equal(classifyMarksResult(papers, [subject('eng', 18), subject('math', 16)]).result_status, 'Pass');
  assert.equal(classifyMarksResult(papers, [subject('eng', 8), subject('math', 16)]).result_status, 'Fail');
  assert.deepEqual(classifyMarksResult(papers, [subject('eng', 18), subject('math', 0, 10, { is_absent: true })]), {
    has_absence: true,
    result_status: 'Fail (Absent)',
  });
  assert.equal(classifyMarksResult(papers, [subject('eng', 18)]).result_status, 'Incomplete');
});
