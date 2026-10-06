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

test('class and accounts Excel keep both Science/EVS columns, count one, and classify unused alternatives as complete', () => {
  const papers = ['Telugu', 'Hindi', 'English', 'Math', 'Science', 'Social', 'EVS'].map((name) => ({
    exam_subject_id: name, subject_name: name, max_marks: 25, assessment_schema: 'consolidated',
  }));
  const marks = (names, score = 25) => names.map((name) => ({
    exam_subject_id: name, mark_id: `m-${name}`, marks_obtained: score, max_marks: 25, passing_marks: 8,
  }));
  const subjects = [
    marks(papers.filter((paper) => paper.subject_name !== 'EVS').map((paper) => paper.subject_name)),
    marks(papers.filter((paper) => paper.subject_name !== 'Science').map((paper) => paper.subject_name)),
    marks(papers.map((paper) => paper.subject_name)).map((row) => row.exam_subject_id === 'Science' ? { ...row, marks_obtained: 20 } : row),
  ];
  const section = { classSection: { class_name: '4', section_name: 'C' }, papers,
    students: subjects.map((rows, index) => ({ student_name: `Student ${index}`, rank: index === 2 ? 3 : 1,
      subjects: rows, ...classifyMarksResult(papers, rows) })) };
  const classBook = XLSX.read(buildClassMarksWorkbook({ ...section, exam: { name: 'FA-1' } }), { type: 'buffer' });
  const schoolBook = XLSX.read(buildSchoolMarksWorkbook({ sections: [section], exam: { name: 'FA-1' } }), { type: 'buffer' });
  for (const [book, name] of [[classBook, 'Class Marks'], [schoolBook, '4-C']]) {
    const rows = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: '' });
    assert.equal(rows[3][3], 150);
    assert.equal(rows[5][12], 'Science');
    assert.equal(rows[5][16], 'EVS');
    assert.deepEqual(rows[7].slice(18), [150, 150, 100, 1, 'Pass', 'Complete']);
    assert.deepEqual(rows[8].slice(18), [150, 150, 100, 1, 'Pass', 'Complete']);
    assert.deepEqual(rows[9].slice(18), [145, 150, 96.67, 3, 'Pass', 'Complete']);
    assert.equal(rows[9][12], 20);
    assert.equal(rows[9][16], 25);
  }
  const overview = XLSX.utils.sheet_to_json(schoolBook.Sheets.Overview, { header: 1 });
  assert.deepEqual(overview[5].slice(4), [3, 6, 150, 3, 0]);
});

test('an unused EVS absence does not fail Science results, and entered alternatives determine incomplete and failing results', () => {
  const papers = [{ exam_subject_id: 'sci', subject_name: 'Science', max_marks: 25 }, { exam_subject_id: 'evs', subject_name: 'EVS', max_marks: 25 }];
  const science = { exam_subject_id: 'sci', mark_id: 'science', max_marks: 25, marks_obtained: 20, passing_marks: 8 };
  const evs = { exam_subject_id: 'evs', mark_id: 'evs', max_marks: 25, marks_obtained: null, is_absent: true, passing_marks: 8 };
  assert.deepEqual(classifyMarksResult(papers, [science, evs]), { has_absence: false, result_status: 'Pass' });
  assert.equal(classifyMarksResult(papers, [{ ...science, marks_obtained: 5 }, { ...evs, is_absent: false, marks_obtained: 25 }]).result_status, 'Fail');
  assert.equal(classifyMarksResult(papers, []).result_status, 'Incomplete');
  assert.deepEqual(classifyMarksResult(papers, [evs]), { has_absence: true, result_status: 'Fail (Absent)' });
});

test('Excel maximum headings and per-student maxima follow the selected alternative when EVS and Science differ', () => {
  const papers = [{ exam_subject_id: 'sci', subject_name: 'Science', max_marks: 25 }, { exam_subject_id: 'evs', subject_name: 'EVS', max_marks: 50 }];
  const students = ['sci', 'evs'].map((id) => ({ student_name: id, subjects: [{ exam_subject_id: id, mark_id: id,
    marks_obtained: id === 'sci' ? 20 : 45, max_marks: id === 'sci' ? 25 : 50 }] }));
  const rows = XLSX.utils.sheet_to_json(XLSX.read(buildClassMarksWorkbook({ papers, students }), { type: 'buffer' }).Sheets['Class Marks'], { header: 1 });
  assert.equal(rows[3][3], '25 / 50');
  assert.deepEqual(rows[7].slice(8, 11), [20, 25, 80]);
  assert.deepEqual(rows[8].slice(8, 11), [45, 50, 90]);
});

test('Excel removes an empty EVS/Science column per class and keeps marks, totals, merges and filters aligned', () => {
  const papers = ['Telugu', 'Hindi', 'English', 'Math', 'Science', 'Social', 'EVS'].map((name) => ({
    exam_subject_id: name, subject_name: name, assessment_schema: 'consolidated', max_marks: 25,
  }));
  for (const active of ['Science', 'EVS']) {
    const section = { classSection: { class_name: '4', section_name: 'A' }, papers, students: [{
      student_name: 'Student', rank: 26, result_status: 'Pass', subjects: papers.map((paper) => ({
        exam_subject_id: paper.exam_subject_id, mark_id: ['Science', 'EVS'].includes(paper.subject_name) && paper.subject_name !== active ? null : paper.exam_subject_id,
        marks_obtained: ['Science', 'EVS'].includes(paper.subject_name) && paper.subject_name !== active ? null : 14,
      })),
    }] };
    const books = [
      [XLSX.read(buildClassMarksWorkbook(section), { type: 'buffer', cellStyles: true }), 'Class Marks'],
      [XLSX.read(buildSchoolMarksWorkbook({ sections: [section] }), { type: 'buffer', cellStyles: true }), '4-A'],
    ];
    for (const [book, name] of books) {
      const sheet = book.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      assert.ok(rows[5].includes(active));
      assert.ok(!rows[5].includes(active === 'EVS' ? 'Science' : 'EVS'));
      assert.deepEqual(rows[7].slice(16), [84, 150, 56, 26, 'Pass', 'Complete']);
      assert.equal(sheet['!cols'].length, 22);
      assert.equal(sheet['!autofilter'].ref, 'A7:V8');
      assert.ok(sheet['!merges'].some((merge) => merge.s.r === 5 && merge.s.c === 16 && merge.e.c === 21));
    }
  }
});

test('filtered Excel retains columns used elsewhere in the class cohort', () => {
  const papers = [{ exam_subject_id: 'sci', subject_name: 'Science', max_marks: 25 }, { exam_subject_id: 'evs', subject_name: 'EVS', max_marks: 25 }];
  const section = { classSection: { class_name: '4', section_name: 'A' }, papers, displayPapers: papers,
    students: [{ student_name: 'Filtered', subjects: [{ exam_subject_id: 'evs', mark_id: 'evs', marks_obtained: 20 }] }] };
  const book = XLSX.read(buildSchoolMarksWorkbook({ sections: [section] }), { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(book.Sheets['4-A'], { header: 1 });
  assert.equal(rows[5][4], 'Science');
  assert.equal(rows[5][6], 'EVS');
  assert.deepEqual(rows[7].slice(8, 11), [20, 25, 80]);
});

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

test('missing marks export: Follow-up is first sheet, compact widths, and correct headers', () => {
  const readiness = {
    expected_entries: 40,
    entered_entries: 35,
    missing_entries: 5,
    papers: [
      {
        class_name: '5',
        subject_name: 'Mathematics',
        pending_teachers: [
          {
            teacher_name: 'Rajesh Sharma',
            section_names: ['A', 'B'],
            expected_entries: 40,
            entered_entries: 35,
            missing_entries: 5,
          },
        ],
        unassigned_sections: [],
      },
    ],
  };

  const buffer = buildMissingMarksWorkbook({
    schoolName: 'Greenwood High',
    examName: 'Mid-Term 2026',
    readiness,
  });

  const workbook = XLSX.read(buffer, { type: 'buffer', cellStyles: true });
  assert.equal(workbook.SheetNames[0], 'Follow-up');
  assert.equal(workbook.SheetNames[1], 'Details');

  const followupSheet = workbook.Sheets['Follow-up'];
  const rows = XLSX.utils.sheet_to_json(followupSheet, { header: 1, defval: '' });

  // Title and metadata rows
  assert.equal(rows[0][0], 'Greenwood High — Unuploaded Marks');
  assert.equal(rows[1][0], 'Exam');
  assert.equal(rows[1][1], 'Mid-Term 2026');
  assert.equal(rows[3][0], 'Expected Entries');
  assert.equal(rows[3][1], 40);
  assert.equal(rows[3][2], 'Uploaded Entries');
  assert.equal(rows[3][3], 35);
  assert.equal(rows[4][0], 'Missing Entries');
  assert.equal(rows[4][1], 5);
  assert.equal(rows[4][2], 'Follow-up Items');
  assert.equal(rows[4][3], 1);

  // Table header at row index 6
  assert.deepEqual(rows[6], ['#', 'Staff', 'Class / Section', 'Subject', 'Progress', 'Missing', 'Status']);

  // Data row 1
  assert.equal(rows[7][0], 1);
  assert.equal(rows[7][1], 'Rajesh Sharma');
  assert.equal(rows[7][2], '5 - A, B'); // multiple sections combined correctly
  assert.equal(rows[7][3], 'Mathematics');
  assert.equal(rows[7][4], '35 / 40');
  assert.equal(rows[7][5], 5);
  assert.equal(rows[7][6], 'Follow up');

  // Column width constraint: total widths <= 96 characters
  const cols = followupSheet['!cols'];
  assert.ok(cols && cols.length === 7);
  const totalWidth = cols.reduce((sum, col) => sum + (col.wch || 0), 0);
  assert.ok(totalWidth <= 96, `Follow-up total column width ${totalWidth} exceeds 96 character limit`);
  assert.ok(totalWidth >= 80, `Follow-up total column width ${totalWidth} is too narrow`);

  // Autofilter covers all columns A through G and rows 7 to 8
  assert.equal(followupSheet['!autofilter']?.ref, 'A7:G8');
});

test('missing marks export: unassigned and unresolved gaps preserve distinction without fake zeroes', () => {
  const readiness = {
    expected_entries: 50,
    entered_entries: 20,
    missing_entries: 30,
    papers: [
      {
        class_name: '3',
        subject_name: 'Science',
        missing_entries: 10,
        pending_teachers: [],
        unassigned_sections: [{ section_name: 'C' }],
      },
      {
        class_name: '4',
        subject_name: 'Social Studies',
        expected_entries: 20,
        entered_entries: 0,
        missing_entries: 20,
        pending_teachers: [],
        unassigned_sections: [],
      },
    ],
  };

  const buffer = buildMissingMarksWorkbook({
    schoolName: 'Delhi Public School',
    examName: 'Annual Exam',
    readiness,
  });

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const followupRows = XLSX.utils.sheet_to_json(workbook.Sheets['Follow-up'], { header: 1, defval: '' });

  // Unassigned section row
  assert.equal(followupRows[7][1], 'Unassigned');
  assert.equal(followupRows[7][2], '3 - C');
  assert.equal(followupRows[7][3], 'Science');
  assert.equal(followupRows[7][4], '—');
  assert.equal(followupRows[7][5], ''); // never converted to fake 0
  assert.equal(followupRows[7][6], 'Teacher not assigned');

  // Unresolved paper row
  assert.equal(followupRows[8][1], 'Unresolved');
  assert.equal(followupRows[8][2], '4');
  assert.equal(followupRows[8][3], 'Social Studies');
  assert.equal(followupRows[8][4], '0 / 20');
  assert.equal(followupRows[8][5], 20); // accurate numeric missing count
  assert.equal(followupRows[8][6], 'Assignment unresolved');

  // Check Details worksheet retains complete raw columns
  const detailsRows = XLSX.utils.sheet_to_json(workbook.Sheets.Details, { header: 1, defval: '' });
  assert.deepEqual(detailsRows[5], [
    '#', 'Staff Name', 'Class', 'Sections', 'Subject',
    'Expected', 'Uploaded', 'Missing', 'Assignment Status',
  ]);
  assert.equal(detailsRows[6][1], 'Unassigned');
  assert.equal(detailsRows[6][5], ''); // expected is empty
  assert.equal(detailsRows[6][7], ''); // missing is empty, not 0
  assert.equal(detailsRows[6][8], 'Teacher not assigned');

  assert.equal(detailsRows[7][1], 'Unresolved');
  assert.equal(detailsRows[7][5], 20);
  assert.equal(detailsRows[7][6], 0);
  assert.equal(detailsRows[7][7], 20);
  assert.equal(detailsRows[7][8], 'No teacher assignment found');
});

test('missing marks export: handles long names and malformed/empty arrays safely', () => {
  const longTeacherName = 'Prof. Dr. Venkata Satyanarayana Murthy Krishna Swamy';
  const longSubject = 'Advanced Information and Communications Technology & Applications';
  const readiness = {
    missing_entries: 1,
    papers: [
      {
        class_name: '10',
        subject_name: longSubject,
        pending_teachers: [
          {
            teacher_name: longTeacherName,
            section_names: ['Section-A1', 'Section-A2', 'Section-Special-Honors'],
            expected_entries: 50,
            entered_entries: 49,
            missing_entries: 1,
          },
        ],
      },
      null, // null paper
      {
        // empty paper
        pending_teachers: null,
        unassigned_sections: null,
      },
    ],
  };

  const buffer = buildMissingMarksWorkbook({
    schoolName: '',
    examName: '',
    readiness,
  });

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const followupRows = XLSX.utils.sheet_to_json(workbook.Sheets['Follow-up'], { header: 1, defval: '' });

  assert.equal(followupRows[7][1], longTeacherName);
  assert.equal(followupRows[7][3], longSubject);
  assert.equal(followupRows[7][6], 'Follow up');
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

test('class and accounts Excel exports calculate Social component totals rather than cached consolidated marks', () => {
  const paper = { exam_subject_id: 'social', subject_name: 'Social', assessment_schema: 'component', max_marks: 50,
    passing_marks: 18, participation_max_marks: 10, written_work_max_marks: 10, project_work_max_marks: 10, slip_test_max_marks: 20 };
  const student = { student_name: 'Student', rank: 1, subjects: [{ exam_subject_id: 'social', max_marks: 50, passing_marks: 18,
    mark_id: 'm-social', marks_obtained: 17.5, consolidated_marks_obtained: 17.5,
    participation_marks: 10, written_work_marks: 10, project_work_marks: 10, slip_test_marks: 17.5 }] };
  const classSection = { class_name: '6', section_name: 'A' };
  const options = { schoolName: 'School', exam: { name: 'FA-1' }, papers: [paper], students: [student], classSection };
  const classWorkbook = XLSX.read(buildClassMarksWorkbook(options), { type: 'buffer' });
  const schoolWorkbook = XLSX.read(buildSchoolMarksWorkbook({ ...options, sections: [options] }), { type: 'buffer' });
  for (const sheet of [classWorkbook.Sheets['Class Marks'], schoolWorkbook.Sheets['6-A']]) {
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    assert.deepEqual(rows[7].slice(4, 13), [10, 10, 10, 17.5, 47.5, 'A1', 47.5, 50, 95]);
  }
  assert.equal(classifyMarksResult([paper], student.subjects).result_status, 'Pass');
  assert.equal(classifyMarksResult([paper], [{ ...student.subjects[0], participation_marks: null,
    written_work_marks: null, project_work_marks: null, slip_test_marks: null }]).result_status, 'Incomplete');
});
