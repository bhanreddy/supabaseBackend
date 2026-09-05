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
      student_name: 'Aarav', admission_no: 'A1', roll_number: 1, total_obtained: 63, percentage: 84, rank: 1, result_status: 'Pass', completed_subjects: 2,
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

test('school marks export creates an overview and one sheet per class-section', () => {
  const paper = { exam_subject_id: 'eng', subject_name: 'English', assessment_schema: 'consolidated', max_marks: 25 };
  const student = {
    student_name: 'Aarav', admission_no: 'A1', roll_number: 1,
      total_obtained: 23, percentage: 92, rank: 1, result_status: 'Pass', completed_subjects: 1,
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
  assert.equal(overview[5][2], 'A');
  assert.equal(overview[6][2], 'B');
});

test('class sheet labels sections with no configured exam papers', () => {
  const buffer = buildClassMarksWorkbook({
    schoolName: 'School', teacherName: 'Teacher', rankingMethod: 'competition',
    exam: { name: 'FA-1' }, classSection: { class_name: '3', section_name: 'A', academic_year: '2026-27' },
    papers: [],
    students: [{
      student_name: 'Maya', admission_no: 'A2', roll_number: 2,
      total_obtained: 0, percentage: null, rank: null, result_status: 'Incomplete', completed_subjects: 0, subjects: [],
    }],
  });
  const sheet = XLSX.read(buffer, { type: 'buffer' }).Sheets['Class Marks'];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  assert.equal(rows[7][8], 'No exam papers configured');
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
