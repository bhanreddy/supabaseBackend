import XLSX from 'xlsx';

import { gradeForFinalPercentage } from '../services/finalResultCalculationService.js';
import {
  examTotalMaximum,
  marksEntryStatusLabel,
  subjectPercentage,
  summarizeStudentMarks,
} from '../services/marksTotalsService.js';

const safeNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

/** Blank cells stay blank so a missing entry is never read as a zero score. */
const numericCell = (value) => value == null ? '' : value;

const markValue = (subject, field = 'marks_obtained') => {
  if (!subject?.mark_id) return '';
  if (subject.is_absent) return 'AB';
  return subject[field] == null ? '' : safeNumber(subject[field]);
};

const gradeValue = (subject) => {
  if (!subject?.mark_id) return '';
  if (subject.is_absent) return 'AB';
  const percentage = subjectPercentage(subject.marks_obtained, subject.max_marks);
  if (percentage == null) return '';
  return gradeForFinalPercentage(percentage).grade;
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
    if (!paper) return [];
    const assigned = (paper.pending_teachers || []).filter(Boolean).map((teacher) => ({
      teacher_name: teacher.teacher_name || 'Teacher',
      class_name: paper.class_name || '',
      sections: (teacher.section_names || []).filter(Boolean).join(', '),
      subject_name: paper.subject_name || '',
      expected_entries: safeNumber(teacher.expected_entries),
      entered_entries: safeNumber(teacher.entered_entries),
      missing_entries: safeNumber(teacher.missing_entries),
      assignment_status: 'Assigned',
    }));
    const unassigned = (paper.unassigned_sections || []).filter(Boolean).map((section) => ({
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

const headerCellStyle = {
  fill: { fgColor: { rgb: '9A3412' } },
  font: { bold: true, color: { rgb: 'FFFFFF' } },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  border: {
    top: { style: 'thin', color: { rgb: 'E5E7EB' } },
    bottom: { style: 'thin', color: { rgb: 'E5E7EB' } },
    left: { style: 'thin', color: { rgb: 'E5E7EB' } },
    right: { style: 'thin', color: { rgb: 'E5E7EB' } },
  },
};

export function buildMissingMarksWorkbook({ schoolName, examName, readiness }) {
  const rows = missingMarksRows(readiness);

  // ── Sheet 1: Compact, mobile-first Follow-up Sheet ──────────────────────────
  const followupHeaders = ['#', 'Staff', 'Class / Section', 'Subject', 'Progress', 'Missing', 'Status'];
  const followupCols = [
    { wch: 6 },  // #
    { wch: 18 }, // Staff
    { wch: 16 }, // Class / Section
    { wch: 18 }, // Subject
    { wch: 11 }, // Progress
    { wch: 9 },  // Missing
    { wch: 17 }, // Status
  ];

  const followupDataRows = rows.map((row, index) => {
    const classSection = row.class_name && row.sections
      ? `${row.class_name} - ${row.sections}`
      : (row.class_name || row.sections || '—');

    let progress = '—';
    if (typeof row.expected_entries === 'number' && typeof row.entered_entries === 'number' && row.expected_entries > 0) {
      progress = `${row.entered_entries} / ${row.expected_entries}`;
    }

    const missing = typeof row.missing_entries === 'number' && row.missing_entries >= 0
      ? row.missing_entries
      : '';

    let status = 'Follow up';
    if (row.assignment_status === 'Teacher not assigned') {
      status = 'Teacher not assigned';
    } else if (row.assignment_status === 'No teacher assignment found' || row.assignment_status === 'Assignment unresolved') {
      status = 'Assignment unresolved';
    }

    return [
      index + 1,
      row.teacher_name,
      classSection,
      row.subject_name,
      progress,
      missing,
      status,
    ];
  });

  const followupAoa = [
    [`${schoolName || 'School'} — Unuploaded Marks`],
    ['Exam', examName || ''],
    ['Generated', new Date().toLocaleString('en-IN')],
    ['Expected Entries', safeNumber(readiness?.expected_entries), 'Uploaded Entries', safeNumber(readiness?.entered_entries)],
    ['Missing Entries', safeNumber(readiness?.missing_entries), 'Follow-up Items', rows.length],
    [],
    followupHeaders,
    ...followupDataRows,
  ];

  const followupSheet = XLSX.utils.aoa_to_sheet(followupAoa);
  followupSheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }];
  followupSheet['!cols'] = followupCols;
  followupSheet['!autofilter'] = { ref: `A7:G${Math.max(7, rows.length + 7)}` };
  followupSheet['!freeze'] = { xSplit: 0, ySplit: 7 };

  for (let col = 0; col < followupHeaders.length; col += 1) {
    const address = XLSX.utils.encode_cell({ r: 6, c: col });
    if (followupSheet[address]) followupSheet[address].s = headerCellStyle;
  }

  // Format data cells
  for (let r = 0; r < followupDataRows.length; r += 1) {
    const rowIdx = 7 + r;
    const row = rows[r];
    const isUnassigned = row.assignment_status === 'Teacher not assigned';
    const isUnresolved = row.assignment_status === 'No teacher assignment found';

    // Wrap text on text cells
    for (let c = 0; c < followupHeaders.length; c += 1) {
      const addr = XLSX.utils.encode_cell({ r: rowIdx, c });
      if (!followupSheet[addr]) continue;
      const cell = followupSheet[addr];
      cell.s = cell.s || {};
      cell.s.alignment = cell.s.alignment || {};
      if (c === 0 || c === 5) {
        cell.s.alignment.horizontal = 'right';
      } else if (c === 4 || c === 6) {
        cell.s.alignment.horizontal = 'center';
      } else {
        cell.s.alignment.wrapText = true;
      }
      if (isUnassigned || isUnresolved) {
        cell.s.fill = { fgColor: { rgb: 'FFFBEB' } }; // Subtle amber highlight
      }
    }
  }

  // ── Sheet 2: Complete Numeric Details Sheet ─────────────────────────────────
  const detailsHeaders = [
    '#', 'Staff Name', 'Class', 'Sections', 'Subject',
    'Expected', 'Uploaded', 'Missing', 'Assignment Status',
  ];
  const detailsCols = [
    { wch: 6 },  // #
    { wch: 22 }, // Staff Name
    { wch: 12 }, // Class
    { wch: 14 }, // Sections
    { wch: 20 }, // Subject
    { wch: 12 }, // Expected
    { wch: 12 }, // Uploaded
    { wch: 12 }, // Missing
    { wch: 22 }, // Assignment Status
  ];

  const detailsDataRows = rows.map((row, index) => [
    index + 1,
    row.teacher_name,
    row.class_name,
    row.sections,
    row.subject_name,
    row.expected_entries,
    row.entered_entries,
    row.missing_entries,
    row.assignment_status,
  ]);

  const detailsAoa = [
    [`${schoolName || 'School'} — Missing Marks Details`],
    ['Exam', examName || ''],
    ['Generated', new Date().toLocaleString('en-IN')],
    ['Total Missing Entries', safeNumber(readiness?.missing_entries)],
    [],
    detailsHeaders,
    ...detailsDataRows,
  ];

  const detailsSheet = XLSX.utils.aoa_to_sheet(detailsAoa);
  detailsSheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } }];
  detailsSheet['!cols'] = detailsCols;
  detailsSheet['!autofilter'] = { ref: `A6:I${Math.max(6, rows.length + 6)}` };
  detailsSheet['!freeze'] = { xSplit: 0, ySplit: 6 };

  for (let col = 0; col < detailsHeaders.length; col += 1) {
    const address = XLSX.utils.encode_cell({ r: 5, c: col });
    if (detailsSheet[address]) detailsSheet[address].s = headerCellStyle;
  }

  // Assemble workbook buffer with Follow-up first
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, followupSheet, 'Follow-up');
  XLSX.utils.book_append_sheet(workbook, detailsSheet, 'Details');

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
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
  const examMaximum = examTotalMaximum(papers);
  // Obtained and Maximum are separate numeric columns: a single "Total /300"
  // header cannot describe a student whose marks are only partly entered.
  const summaryColumns = [
    { top: 'Overall', sub: 'Total Obtained', width: 15 },
    { top: 'Overall', sub: 'Total Maximum', width: 15 },
    { top: 'Overall', sub: 'Percentage', width: 13 },
    { top: 'Overall', sub: 'Rank', width: 9 },
    { top: 'Overall', sub: 'Result', width: 14 },
    { top: 'Overall', sub: 'Entry Status', width: 24 },
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
    // Recomputed from the shared service rather than trusting the caller, so
    // the workbook can never disagree with the progress report screen.
    const totals = summarizeStudentMarks({ papers, subjects: student.subjects });
    return [
      index + 1,
      student.student_name || '',
      student.admission_no || '',
      student.roll_number ?? '',
      ...subjectCells,
      numericCell(totals.total_obtained),
      totals.total_max > 0 ? totals.total_max : '',
      numericCell(totals.percentage),
      student.rank ?? '',
      student.result_status || '',
      marksEntryStatusLabel(totals, papers.length),
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
    ['Ranking Algorithm', rankingLabel, 'Exam Maximum Marks', examMaximum],
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
  const percentageColumn = allColumns.findIndex((column) =>
    column.top === 'Overall' && column.sub === 'Percentage',
  );
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
      ? students.filter((student) =>
        summarizeStudentMarks({ papers, subjects: student.subjects }).is_complete,
      ).length
      : 0;
    return [
      index + 1,
      section.classSection?.class_name || '',
      section.classSection?.section_name || '',
      section.teacherName || '',
      students.length,
      papers.length,
      examTotalMaximum(papers),
      completeStudents,
      students.length - completeStudents,
    ];
  });
  const overview = XLSX.utils.aoa_to_sheet([
    [`${schoolName || 'School'} — ${exam?.name || 'Marks'} — School-wide Export`],
    ['Academic Year', exam?.academic_year || ''],
    ['Generated', new Date().toLocaleString('en-IN')],
    filterLabel ? ['Export Filters', filterLabel] : [],
    ['S.No.', 'Class', 'Section', 'Class Teacher', 'Students', 'Subjects', 'Exam Maximum Marks', 'Complete Students', 'Incomplete Students'],
    ...overviewRows,
  ]);
  overview['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } }];
  overview['!cols'] = [
    { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 28 },
    { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 19 }, { wch: 21 },
  ];
  overview['!freeze'] = { xSplit: 0, ySplit: 5 };
  overview['!autofilter'] = { ref: `A5:I${Math.max(5, overviewRows.length + 5)}` };
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
