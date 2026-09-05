import XLSX from 'xlsx';

import { gradeForFinalPercentage } from '../services/finalResultCalculationService.js';

const safeNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const markValue = (subject, field = 'marks_obtained') => {
  if (!subject?.mark_id) return '';
  if (subject.is_absent) return 'AB';
  return subject[field] == null ? '' : safeNumber(subject[field]);
};

const gradeValue = (subject) => {
  if (!subject?.mark_id) return '';
  if (subject.is_absent) return 'AB';
  const maximum = safeNumber(subject.max_marks);
  if (maximum <= 0) return '';
  return gradeForFinalPercentage((safeNumber(subject.marks_obtained) / maximum) * 100).grade;
};

export function classifyMarksResult(papers = [], subjects = []) {
  const entered = subjects.filter((subject) => subject.mark_id);
  const incomplete = papers.length === 0 || entered.length < papers.length;
  const hasAbsence = entered.some((subject) => subject.is_absent);
  const hasFailedSubject = entered.some((subject) =>
    !subject.is_absent && safeNumber(subject.marks_obtained) < safeNumber(subject.passing_marks),
  );
  return {
    has_absence: hasAbsence,
    result_status: incomplete
      ? 'Incomplete'
      : hasAbsence
        ? 'Fail (Absent)'
        : hasFailedSubject
          ? 'Fail'
          : 'Pass',
  };
}

const workbookBuffer = (worksheet, sheetName) => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31));
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
};

export function missingMarksRows(readiness) {
  return (readiness?.papers || []).flatMap((paper) => {
    const assigned = (paper.pending_teachers || []).map((teacher) => ({
      teacher_name: teacher.teacher_name || 'Teacher',
      class_name: paper.class_name || '',
      sections: (teacher.section_names || []).join(', '),
      subject_name: paper.subject_name || '',
      expected_entries: safeNumber(teacher.expected_entries),
      entered_entries: safeNumber(teacher.entered_entries),
      missing_entries: safeNumber(teacher.missing_entries),
      assignment_status: 'Assigned',
    }));
    const unassigned = (paper.unassigned_sections || []).map((section) => ({
      teacher_name: 'Unassigned',
      class_name: paper.class_name || '',
      sections: section.section_name || '',
      subject_name: paper.subject_name || '',
      expected_entries: '',
      entered_entries: '',
      missing_entries: '',
      assignment_status: 'Teacher not assigned',
    }));
    if (assigned.length === 0 && unassigned.length === 0 && safeNumber(paper.missing_entries) > 0) {
      return [{
        teacher_name: 'Unresolved',
        class_name: paper.class_name || '',
        sections: '',
        subject_name: paper.subject_name || '',
        expected_entries: safeNumber(paper.expected_entries),
        entered_entries: safeNumber(paper.entered_entries),
        missing_entries: safeNumber(paper.missing_entries),
        assignment_status: 'No teacher assignment found',
      }];
    }
    return [...assigned, ...unassigned];
  });
}

export function buildMissingMarksWorkbook({ schoolName, examName, readiness }) {
  const rows = missingMarksRows(readiness);
  const data = [
    [`${schoolName || 'School'} — Unuploaded Marks`],
    ['Exam', examName || ''],
    ['Missing mark entries', safeNumber(readiness?.missing_entries)],
    ['Generated', new Date().toLocaleString('en-IN')],
    [],
    ['S.No.', 'Staff Name', 'Class', 'Section(s)', 'Subject', 'Expected Entries', 'Uploaded Entries', 'Missing Entries', 'Assignment Status'],
    ...rows.map((row, index) => [
      index + 1, row.teacher_name, row.class_name, row.sections, row.subject_name,
      row.expected_entries, row.entered_entries, row.missing_entries, row.assignment_status,
    ]),
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(data);
  worksheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } }];
  worksheet['!cols'] = [
    { wch: 8 }, { wch: 28 }, { wch: 14 }, { wch: 18 }, { wch: 24 },
    { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 22 },
  ];
  worksheet['!autofilter'] = { ref: `A6:I${Math.max(6, rows.length + 6)}` };
  worksheet['!freeze'] = { xSplit: 0, ySplit: 6 };
  const headerStyle = {
    fill: { fgColor: { rgb: '9A3412' } },
    font: { bold: true, color: { rgb: 'FFFFFF' } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  };
  for (let col = 0; col < 9; col += 1) {
    const address = XLSX.utils.encode_cell({ r: 5, c: col });
    if (worksheet[address]) worksheet[address].s = headerStyle;
  }
  return workbookBuffer(worksheet, 'Unuploaded Marks');
}

const classMarksWorksheet = ({
  schoolName,
  teacherName,
  exam,
  classSection,
  papers = [],
  students = [],
  rankingMethod,
  filterLabel,
}) => {
  const baseColumns = [
    { top: 'S.No.', sub: '', width: 8 },
    { top: 'Student Name', sub: '', width: 28 },
    { top: 'Admission No.', sub: '', width: 16 },
    { top: 'Roll No.', sub: '', width: 10 },
  ];
  const paperColumns = papers.flatMap((paper) => {
    if (paper.assessment_schema === 'component') {
      return [
        { top: paper.subject_name, sub: `Participation /${safeNumber(paper.participation_max_marks)}`, key: 'participation_marks', width: 15 },
        { top: paper.subject_name, sub: `Written /${safeNumber(paper.written_work_max_marks)}`, key: 'written_work_marks', width: 13 },
        { top: paper.subject_name, sub: `Project /${safeNumber(paper.project_work_max_marks)}`, key: 'project_work_marks', width: 13 },
        { top: paper.subject_name, sub: `Slip Test /${safeNumber(paper.slip_test_max_marks)}`, key: 'slip_test_marks', width: 13 },
        { top: paper.subject_name, sub: `Total /${safeNumber(paper.max_marks)}`, key: 'marks_obtained', width: 12 },
        { top: paper.subject_name, sub: 'Grade', key: 'grade', width: 10 },
      ];
    }
    return [
      { top: paper.subject_name, sub: `Marks /${safeNumber(paper.max_marks)}`, key: 'marks_obtained', width: 12 },
      { top: paper.subject_name, sub: 'Grade', key: 'grade', width: 10 },
    ];
  });
  const totalMax = papers.reduce((total, paper) => total + safeNumber(paper.max_marks), 0);
  const summaryColumns = [
    { top: 'Overall', sub: `Total /${totalMax}`, width: 14 },
    { top: 'Overall', sub: 'Percentage', width: 13 },
    { top: 'Overall', sub: 'Rank', width: 9 },
    { top: 'Overall', sub: 'Result', width: 14 },
    { top: 'Overall', sub: 'Entry Status', width: 15 },
  ];
  const allColumns = [...baseColumns, ...paperColumns, ...summaryColumns];
  const topHeader = allColumns.map((column) => column.top);
  const subHeader = allColumns.map((column) => column.sub);
  const dataRows = students.map((student, index) => {
    const subjectByPaper = new Map((student.subjects || []).map((subject) => [String(subject.exam_subject_id), subject]));
    const subjectCells = papers.flatMap((paper) => {
      const subject = subjectByPaper.get(String(paper.exam_subject_id));
      if (paper.assessment_schema === 'component') {
        return [
          markValue(subject, 'participation_marks'), markValue(subject, 'written_work_marks'),
          markValue(subject, 'project_work_marks'), markValue(subject, 'slip_test_marks'),
          markValue(subject), gradeValue(subject),
        ];
      }
      return [markValue(subject), gradeValue(subject)];
    });
    return [
      index + 1,
      student.student_name || '',
      student.admission_no || '',
      student.roll_number ?? '',
      ...subjectCells,
      student.total_obtained,
      student.percentage == null ? '' : safeNumber(student.percentage),
      student.rank ?? '',
      student.result_status || '',
      papers.length === 0
        ? 'No exam papers configured'
        : student.completed_subjects === papers.length
          ? 'Complete'
          : `${student.completed_subjects}/${papers.length} entered`,
    ];
  });
  const rankingLabel = {
    competition: 'Standard competition (1, 1, 1, 4)',
    attendance_tiebreak: 'Marks, then attendance tie-break',
    dense: 'Consecutive ranks (1, 1, 1, 2)',
  }[rankingMethod] || rankingMethod || '';
  const data = [
    [`${schoolName || 'School'} — ${exam?.name || 'Class Marks'}`],
    ['Class Teacher', teacherName || ''],
    ['Class', `${classSection?.class_name || ''}-${classSection?.section_name || ''}`, 'Academic Year', classSection?.academic_year || ''],
    ['Ranking Algorithm', rankingLabel],
    filterLabel ? ['Export Filters', filterLabel] : [],
    topHeader,
    subHeader,
    ...dataRows,
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(data);
  const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: allColumns.length - 1 } }];
  for (let col = 0; col < baseColumns.length; col += 1) {
    merges.push({ s: { r: 5, c: col }, e: { r: 6, c: col } });
  }
  let paperStart = baseColumns.length;
  for (const paper of papers) {
    const width = paper.assessment_schema === 'component' ? 6 : 2;
    merges.push({ s: { r: 5, c: paperStart }, e: { r: 5, c: paperStart + width - 1 } });
    paperStart += width;
  }
  merges.push({ s: { r: 5, c: paperStart }, e: { r: 5, c: paperStart + summaryColumns.length - 1 } });
  worksheet['!merges'] = merges;
  worksheet['!cols'] = allColumns.map((column) => ({ wch: column.width }));
  worksheet['!freeze'] = { xSplit: 4, ySplit: 7 };
  worksheet['!autofilter'] = { ref: `A7:${XLSX.utils.encode_col(allColumns.length - 1)}${Math.max(7, dataRows.length + 7)}` };
  const headerStyle = {
    fill: { fgColor: { rgb: '7C2D12' } },
    font: { bold: true, color: { rgb: 'FFFFFF' } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: {
      top: { style: 'thin', color: { rgb: '9CA3AF' } },
      bottom: { style: 'thin', color: { rgb: '9CA3AF' } },
      left: { style: 'thin', color: { rgb: '9CA3AF' } },
      right: { style: 'thin', color: { rgb: '9CA3AF' } },
    },
  };
  for (let row = 5; row <= 6; row += 1) {
    for (let col = 0; col < allColumns.length; col += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: col });
      if (worksheet[address]) worksheet[address].s = headerStyle;
    }
  }
  const percentageColumn = allColumns.length - 4;
  for (let row = 7; row < dataRows.length + 7; row += 1) {
    const address = XLSX.utils.encode_cell({ r: row, c: percentageColumn });
    if (worksheet[address]) worksheet[address].z = '0.00"%"';
  }
  return worksheet;
};

export function buildClassMarksWorkbook(options) {
  const worksheet = classMarksWorksheet(options);
  return workbookBuffer(worksheet, 'Class Marks');
}

const safeSheetName = (value) => String(value || 'Class')
  .replace(/[\\/?*\[\]:]/g, '-')
  .trim()
  .slice(0, 31) || 'Class';

/** One school-wide workbook with an overview and one marks sheet per class-section. */
export function buildSchoolMarksWorkbook({
  schoolName,
  exam,
  sections = [],
  rankingMethod,
  filterLabel,
}) {
  const workbook = XLSX.utils.book_new();
  const overviewRows = sections.map((section, index) => {
    const students = section.students || [];
    const papers = section.papers || [];
    const completeStudents = papers.length > 0
      ? students.filter((student) => student.completed_subjects === papers.length).length
      : 0;
    return [
      index + 1,
      section.classSection?.class_name || '',
      section.classSection?.section_name || '',
      section.teacherName || '',
      students.length,
      papers.length,
      completeStudents,
      students.length - completeStudents,
    ];
  });
  const overview = XLSX.utils.aoa_to_sheet([
    [`${schoolName || 'School'} — ${exam?.name || 'Marks'} — School-wide Export`],
    ['Academic Year', exam?.academic_year || ''],
    ['Generated', new Date().toLocaleString('en-IN')],
    filterLabel ? ['Export Filters', filterLabel] : [],
    ['S.No.', 'Class', 'Section', 'Class Teacher', 'Students', 'Subjects', 'Complete Students', 'Incomplete Students'],
    ...overviewRows,
  ]);
  overview['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }];
  overview['!cols'] = [
    { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 28 },
    { wch: 12 }, { wch: 12 }, { wch: 19 }, { wch: 21 },
  ];
  overview['!freeze'] = { xSplit: 0, ySplit: 5 };
  overview['!autofilter'] = { ref: `A5:H${Math.max(5, overviewRows.length + 5)}` };
  const usedNames = new Set(['Overview']);
  for (const section of sections) {
    const baseName = safeSheetName(`${section.classSection?.class_name || 'Class'}-${section.classSection?.section_name || 'Section'}`);
    let sheetName = baseName;
    let suffix = 2;
    while (usedNames.has(sheetName)) {
      const suffixText = `-${suffix}`;
      sheetName = `${baseName.slice(0, 31 - suffixText.length)}${suffixText}`;
      suffix += 1;
    }
    usedNames.add(sheetName);
    const worksheet = classMarksWorksheet({
      schoolName,
      teacherName: section.teacherName,
      exam,
      classSection: section.classSection,
      papers: section.papers,
      students: section.students,
      rankingMethod,
      filterLabel,
    });
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  }

  // Open directly on marks. The overview stays available as the final tab.
  XLSX.utils.book_append_sheet(workbook, overview, 'Overview');

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}
