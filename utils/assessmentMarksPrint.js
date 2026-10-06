import { canonicalFinalSourceKey } from '../services/finalResultCalculationService.js';
import { displayAssessmentPapers, examMaximumForStudents, examTotalMaximum, normalizeAssessmentSubjects, selectScoringSubjects, subjectPercentage, summarizeStudentMarks } from '../services/marksTotalsService.js';
import { scienceAlternativeNote } from '../services/scienceSubjectSelection.js';
import { isSecondaryAssessmentClass } from '../services/summativeMarksPrintService.js';
import { componentMaximumsFromRow } from './componentMaximums.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
const display = (value) => value == null ? '—' : escapeHtml(typeof value === 'number' ? round(value) : value);

// The photographed registers include A2. Keep this print policy separate from
// the application's existing result calculation policy.
export function sampleAssessmentGrade(percentage) {
  if (percentage == null) return null;
  return [
    [91, 'A1'], [81, 'A2'], [71, 'B1'], [61, 'B2'],
    [51, 'C1'], [41, 'C2'], [35, 'D1'], [0, 'D2'],
  ].find(([minimum]) => percentage >= minimum)?.[1] ?? 'D2';
}

// Component samples assign 10 for a 20% contribution above 19, 9 above 17,
// 8 above 15, etc. (e.g. 19 -> 9; 19.4 -> 10; 16.6 -> 8).
export function sampleComponentGradePoint(percentage) {
  if (percentage == null) return null;
  return percentage > 95 ? 10 : percentage > 85 ? 9 : percentage > 75 ? 8
    : percentage > 65 ? 7 : percentage > 55 ? 6 : percentage > 45 ? 5 : 4;
}

export function sampleSummativeGradePoint(percentage) {
  const grade = sampleAssessmentGrade(percentage);
  return grade == null ? null : { A1: 10, A2: 9, B1: 8, B2: 7, C1: 6, C2: 5, D1: 4, D2: 3 }[grade];
}

function subjectKind(name) {
  const normalized = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (/^(tel|telugu)$/.test(normalized)) return 'telugu';
  if (/^(hin|hindi)$/.test(normalized)) return 'hindi';
  if (/^(eng|english)$/.test(normalized)) return 'english';
  if (/^(math|maths|mathematics)$/.test(normalized)) return 'math';
  if (/^(physics|physicalscience|physicalsciences|ps)$/.test(normalized)) return 'physics';
  if (/^(biology|biologicalscience|biologicalsciences|bioscience|bs)$/.test(normalized)) return 'biology';
  if (/^(science|generalscience)$/.test(normalized)) return 'science';
  if (/^(social|socialstudies|socialscience|socialsciences)$/.test(normalized)) return 'social';
  return normalized;
}
const order = ['telugu', 'hindi', 'english', 'math', 'science', 'physics', 'biology', 'social'];
const names = {
  telugu: ['Telugu', 'TEL'], hindi: ['Hindi', 'HIN'], english: ['English', 'ENG'],
  math: ['Math', 'MATH'], science: ['Science', 'SCIENCE'], social: ['Social', 'SOCIAL'],
};

function paperGroups(papers, component, summative = false) {
  const sorted = [...papers].sort((a, b) => {
    const aIndex = order.indexOf(subjectKind(a.subject_name));
    const bIndex = order.indexOf(subjectKind(b.subject_name));
    return (aIndex < 0 ? 99 : aIndex) - (bIndex < 0 ? 99 : bIndex);
  });
  const physics = sorted.find((paper) => subjectKind(paper.subject_name) === 'physics');
  const biology = sorted.find((paper) => subjectKind(paper.subject_name) === 'biology');
  const splitScience = Boolean(physics && biology) && (summative
    || (component && physics.assessment_schema === 'component' && biology.assessment_schema === 'component'));
  return sorted.flatMap((paper) => {
    const kind = subjectKind(paper.subject_name);
    if (splitScience && paper === biology) return [];
    const groupedPapers = splitScience && paper === physics ? [physics, biology] : [paper];
    const key = groupedPapers.length === 2 ? 'science' : kind;
    return [{
      papers: groupedPapers,
      name: names[key]?.[component ? 0 : 1] || paper.subject_name,
      component: component && groupedPapers.every((item) => item.assessment_schema === 'component'),
      maximum: examTotalMaximum(groupedPapers),
    }];
  });
}

function summativeTableHeader(groups, formativeKeys) {
  const formativeLabel = formativeKeys.map((key) => key.toUpperCase()).join('+');
  const columns = (examMaximum, weight, maximum) => [
    ['EXAM', examMaximum], [formativeLabel, `${weight}%`], ['Total', maximum],
  ].map(([label, max]) => `<th>${escapeHtml(label)}<br>${display(max)}</th>`).join('');
  const first = groups.map((group) => group.papers.length === 2
    ? th('PHY', 'colspan="3"') + th('BIO.SCI', 'colspan="6"')
    : th(group.name, 'colspan="5"')).join('');
  const detail = groups.map((group) => {
    const weight = group.papers.length === 2 ? 10 : 20;
    return group.papers.map((paper) => columns(Number(paper.max_marks), weight, Number(paper.max_marks) + weight)).join('')
      + (group.papers.length === 2 ? `<th>G.Total<br>${display(group.maximum + weight * group.papers.length)}</th>` : '')
      + th('GRADE', 'class="vertical"') + th('GPA', 'class="vertical"');
  }).join('');
  return `<tr><th rowspan="2">R<br>N<br>O</th>${th('STUDENT NAME', 'rowspan="2" class="student-name"')}${first}
    ${['G.TOTAL', '%', 'GRADE', 'GPA', 'RANK'].map((label) => th(label, 'rowspan="2"')).join('')}</tr><tr>${detail}</tr>`;
}

function summativeStudentRow(student, index, groups) {
  const subjects = new Map((student.summative_subjects || []).map((subject) => [String(subject.exam_subject_id), subject]));
  const results = groups.map((group) => {
    const marks = group.papers.map((paper) => subjects.get(String(paper.exam_subject_id)));
    const complete = marks.every((mark) => mark?.is_complete);
    const total = complete ? round(marks.reduce((sum, mark) => sum + mark.total, 0)) : null;
    const maximum = marks.reduce((sum, mark) => sum + (mark?.maximum || 0), 0);
    return { marks, total, percentage: subjectPercentage(total, maximum), counts: marks.some((mark) => mark?.counts_in_total !== false) };
  });
  const cells = groups.map((group, groupIndex) => {
    const result = results[groupIndex];
    return result.marks.map((mark) => td(mark?.exam_absent ? 'AB' : mark?.exam_marks)
      + td(mark?.formative_contribution) + td(mark?.total)).join('')
      + (group.papers.length === 2 ? td(result.total) : '')
      + td(sampleAssessmentGrade(result.percentage)) + td(sampleSummativeGradePoint(result.percentage));
  }).join('');
  const countedResults = results.filter((result) => result.counts);
  const gpa = student.is_complete
    ? round(countedResults.reduce((sum, result) => sum + sampleSummativeGradePoint(result.percentage), 0) / countedResults.length, 1) : null;
  const summary = [student.total_obtained, student.percentage,
    student.is_complete ? sampleAssessmentGrade(student.percentage) : null, gpa, student.rank];
  return `<tr>${td(index + 1)}${td(student.student_name, 'student-name')}${cells}${summary.map((value) => td(value)).join('')}</tr>`;
}

function assessmentTitle(exam, component) {
  const key = canonicalFinalSourceKey(exam?.exam_type, exam?.name);
  const label = exam?.exam_type === 'sa_results' ? 'SUMMATIVE ASSESSMENT' : 'FORMATIVE ASSESSMENT';
  return `${label}${key ? ` - ${key.slice(2)}` : ` - ${exam?.name || ''}`}${component ? ' MARKS LIST' : ''}`;
}

const td = (value, className = '') => `<td${className ? ` class="${className}"` : ''}>${display(value)}</td>`;
const th = (value, attributes = '') => `<th${attributes ? ` ${attributes}` : ''}>${display(value)}</th>`;

function componentLabels(paper) {
  const maximums = componentMaximumsFromRow(paper);
  return [['Res', maximums.participation], ['Wri', maximums.written_work],
    ['Pro', maximums.project_work], ['ST', maximums.slip_test]];
}
function componentHeaders(group, rowspan) {
  return group.papers.flatMap((paper) => componentLabels(paper).map(([label, max]) =>
    th(`${label}<br>${max}`, `rowspan="${rowspan}"`),
  ).concat(th('Total', `rowspan="${rowspan}" class="vertical"`))).join('')
    // Only these trusted, static labels contain markup.
    .replaceAll('&lt;br&gt;', '<br>');
}

function tableHeader(groups, maximum, component, componentGradeMode) {
  if (!component) {
    return `<tr>${th('S NO', 'rowspan="2"')}${th('STUDENT NAME', 'rowspan="2" class="student-name"')}
      ${groups.map((group) => th(group.name, 'colspan="2"')).join('')}
      ${th('TOT')}${th('AVG')}${th('RANK', 'rowspan="2"')}${th('%', 'rowspan="2"')}</tr>
      <tr>${groups.map((group) => th(group.maximum) + th('GRADE')).join('')}${th(maximum)}${th('GRADE')}</tr>`;
  }
  const split = groups.some((group) => group.papers.length === 2);
  const rows = split ? 3 : 2;
  const base = `<th rowspan="${rows}">R<br>N<br>O</th>` + th('STUDENT NAME', `rowspan="${rows}" class="student-name"`);
  const first = groups.map((group) => th(group.name, `colspan="${group.component ? group.papers.length * 5 + (group.papers.length === 2 ? 3 : 2) + (componentGradeMode === 'add' ? 1 : 0) : 2}"`)).join('');
  const summary = ['Total', '%', 'RANK', 'Grade', 'GPA'].map((label) => th(label, `rowspan="${rows}"${label === 'Grade' ? ' class="vertical"' : ''}`)).join('');
  const resultHeaders = (rowspan) => (componentGradeMode === 'replace'
    ? th('GRADE', `rowspan="${rowspan}" class="vertical"`)
    : th('20%', `rowspan="${rowspan}"`))
    + (componentGradeMode === 'add' ? th('GRADE', `rowspan="${rowspan}" class="vertical"`) : '')
    + th(componentGradeMode ? 'GPA' : 'G/GPA', `rowspan="${rowspan}" class="vertical"`);
  const detail = groups.map((group) => {
    if (!group.component) return th(group.maximum, `rowspan="${rows - 1}"`) + th('GRADE', `rowspan="${rows - 1}"`);
    if (group.papers.length === 2) {
      return th('Physical Science', 'colspan="5"') + th('Biological Science', 'colspan="5"')
        + th('Total', 'rowspan="2" class="vertical"') + resultHeaders(2);
    }
    return componentHeaders(group, rows - 1) + resultHeaders(rows - 1);
  }).join('');
  const last = split ? `<tr>${groups.filter((group) => group.papers.length === 2).map((group) => componentHeaders(group, 1)).join('')}</tr>` : '';
  return `<tr>${base}${first}${summary}</tr><tr>${detail}</tr>${last}`;
}

function groupResult(group, subjects) {
  const marks = group.papers.map((paper) => subjects.get(String(paper.exam_subject_id)));
  const complete = marks.every((mark) => mark?.mark_id && (mark.is_absent || mark.marks_obtained != null));
  const absent = marks.some((mark) => mark?.is_absent);
  const obtained = complete ? round(marks.reduce((total, mark) => total + (mark.is_absent ? 0 : Number(mark.marks_obtained)), 0)) : null;
  const percentage = subjectPercentage(obtained, group.maximum);
  return { marks, complete, absent, obtained, percentage };
}

function studentRow(student, index, groups, papers, component, componentGradeMode) {
  const subjects = new Map((student.subjects || []).map((subject) => [String(subject.exam_subject_id), subject]));
  const results = groups.map((group) => groupResult(group, subjects));
  const cells = groups.map((group, groupIndex) => {
    const result = results[groupIndex];
    if (!group.component) {
      return td(result.absent && group.papers.length === 1 ? 'AB' : result.obtained)
        + td(result.absent ? 'AB' : sampleAssessmentGrade(result.percentage));
    }
    const components = result.marks.map((mark) => {
      const value = (field) => !mark?.mark_id ? null : mark.is_absent ? 'AB' : mark[field];
      return ['participation_marks', 'written_work_marks', 'project_work_marks', 'slip_test_marks', 'marks_obtained']
        .map((field) => td(value(field))).join('');
    }).join('');
    const grade = result.complete
      ? result.absent && group.papers.length === 1 ? 'AB' : sampleAssessmentGrade(result.percentage) : null;
    return components + (group.papers.length === 2 ? td(result.obtained) : '')
      + td(componentGradeMode === 'replace' ? grade : result.percentage == null ? null : round(result.percentage / 5))
      + (componentGradeMode === 'add' ? td(grade) : '')
      + td(sampleComponentGradePoint(result.percentage));
  }).join('');
  const totals = summarizeStudentMarks({ papers, subjects: student.subjects });
  const grade = totals.is_complete ? sampleAssessmentGrade(totals.percentage) : null;
  const scoringPapers = selectScoringSubjects(papers, student.subjects).papers;
  const countedResults = results.filter((_, index) => groups[index].papers.some((paper) => scoringPapers.includes(paper)));
  const gpa = totals.is_complete ? round(countedResults.reduce((total, result) => total + sampleComponentGradePoint(result.percentage), 0) / countedResults.length, 1) : null;
  const total = totals.total_obtained == null ? null : `${totals.total_obtained}${totals.is_complete ? '' : '*'}`;
  const summary = component
    ? [total, totals.percentage, student.rank, grade, gpa]
    : [total, grade, student.rank, totals.percentage];
  return `<tr>${td(index + 1)}${td(student.student_name, 'student-name')}${cells}${summary.map((value) => td(value)).join('')}</tr>`;
}

function paginateStudents(students, component) {
  const pages = [];
  let page = [];
  let usedHeight = 0;
  const maxRows = component ? 28 : 30;
  const charsPerLine = component ? 25 : 30;
  for (const student of students) {
    // Reserve space for wrapped names instead of clipping a long student name
    // or letting the browser split a prepared page into uncounted pages.
    const words = String(student.student_name || '').split(/\s+/);
    let lines = 1;
    let lineLength = 0;
    for (const word of words) {
      if (lineLength && lineLength + word.length + 1 > charsPerLine) { lines += 1; lineLength = 0; }
      const extraLines = Math.max(0, Math.ceil(word.length / charsPerLine) - 1);
      lines += extraLines;
      lineLength = extraLines ? ((word.length - 1) % charsPerLine) + 1 : lineLength + word.length + (lineLength ? 1 : 0);
    }
    const height = Math.max(component ? 5.2 : 5.3, lines * (component ? 2.5 : 3.5) + (component ? 1.4 : 1.8));
    if (page.length && (page.length >= maxRows || usedHeight + height > 160)) {
      pages.push(page); page = []; usedHeight = 0;
    }
    page.push(student); usedHeight += height;
  }
  if (page.length || !pages.length) pages.push(page);
  return pages;
}

/** Printable A4 landscape registers, with explicit page breaks and repeated headings. */
export function buildAssessmentMarksPrint({ schoolName, exam, sections = [] }) {
  const pages = [];
  let studentCount = 0;
  for (const section of sections) {
    const papers = section.papers || [];
    const students = (section.students || []).map((student) => ({
      ...student, subjects: normalizeAssessmentSubjects(papers, student.subjects || []),
    }));
    const summative = section.summative === true;
    const componentGradeMode = exam?.exam_type === 'fa_results' && isSecondaryAssessmentClass(section.classSection)
      ? 'replace' : exam?.exam_type === 'sa_results' ? 'add' : null;
    const displayPapers = section.displayPapers ?? displayAssessmentPapers(papers, students);
    const component = summative || displayPapers.some((paper) => paper.assessment_schema === 'component');
    const groups = paperGroups(displayPapers, summative ? false : component, summative);
    const maximum = examMaximumForStudents(papers, students);
    const studentPages = paginateStudents(students, component);
    const pageCount = studentPages.length;
    studentCount += students.length;
    let start = 0;
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const pageStudents = studentPages[pageIndex];
      const rowHeight = Math.max(component ? 5.2 : 5.3, Math.min(7.5, 150 / Math.max(1, pageStudents.length)));
      // Give decimal totals/weightages more room than individual component
      // marks. Equal-width columns wrap 223.5 and create accidental extra pages.
      const paperWidths = groups.flatMap((group) => summative
        ? [...group.papers.flatMap(() => [1.5, 2, 1.5]), ...(group.papers.length === 2 ? [2] : []), 1, 1]
        : group.component
        ? [...group.papers.flatMap(() => [1, componentGradeMode === 'add' ? 1.2 : 1, 1, 1, 1.5]), ...(group.papers.length === 2 ? [1.5] : []), 1.5, ...(componentGradeMode === 'add' ? [1] : []), 1]
        : [1.5, 1]);
      const summaryWidths = summative ? [2.3, 2, 2, 1.5, 1.8] : component ? [2, 2, 1.8, 1.3, 1.5] : [1.8, 1, 1, 1.8];
      const numericWidths = [...paperWidths, ...summaryWidths];
      const totalWidth = numericWidths.reduce((total, width) => total + width, 0);
      const availableWidth = component ? 245 : 220;
      const widths = numericWidths.map((width) => `<col style="width:${round(width / totalWidth * availableWidth, 3)}mm">`).join('');
      const columnCount = 2 + numericWidths.length;
      const incomplete = pageStudents.some((student) => summative ? !student.is_complete
        : !summarizeStudentMarks({ papers, subjects: student.subjects }).is_complete);
      const absent = pageStudents.some((student) => summative ? student.has_absence
        : selectScoringSubjects(papers, student.subjects).subjects.some((subject) => subject.is_absent));
      const alternativeNote = scienceAlternativeNote(displayPapers);
      const missingLegend = summative
        ? '— = required FA/exam marks not entered; combined totals, grade, GPA and rank await complete marks.'
        : '— = marks not entered. * = total and percentage include entered papers only; overall grade/GPA awaits complete marks.';
      pages.push(`<section class="sheet ${component ? 'component' : 'consolidated'}" style="--row-height:${round(rowHeight, 3)}mm">
        <header><h1>${escapeHtml(String(schoolName || 'School').toUpperCase())}</h1><h2>${escapeHtml(assessmentTitle(exam, component))}</h2>
        <div class="metadata"><span>${component ? 'Name of the Class Teacher' : 'CLASS TEACHER NAME'} : ${escapeHtml(section.teacherName || '')}</span><span>${component ? 'Class/Sec' : 'CLASS'}: ${escapeHtml(section.classSection?.class_name)} - ${escapeHtml(section.classSection?.section_name)}</span></div></header>
        <table><colgroup><col class="number-col"><col class="name-col">${widths}</colgroup>
        <thead>${summative ? summativeTableHeader(groups, section.formative_keys) : tableHeader(groups, maximum, component, componentGradeMode)}</thead><tbody>
        ${pageStudents.length ? pageStudents.map((student, index) => summative
          ? summativeStudentRow(student, start + index, groups)
          : studentRow(student, start + index, groups, papers, component, componentGradeMode)).join('') : `<tr><td colspan="${columnCount}" class="empty">No students match the selected filters.</td></tr>`}
        </tbody></table>
        ${incomplete || absent || alternativeNote ? `<div class="legend">${incomplete ? missingLegend : ''}${absent ? ' AB = absent (counted as zero in totals).' : ''}${alternativeNote ? ` ${escapeHtml(alternativeNote)}` : ''}</div>` : ''}
        ${pageCount > 1 ? `<div class="page-number">${pageIndex + 1} / ${pageCount}</div>` : ''}
        </section>`);
      start += pageStudents.length;
    }
  }
  return {
    page_count: pages.length,
    student_count: studentCount,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${escapeHtml(exam?.name)} - Marks List</title><style>
      @page { size: A4 landscape; margin: 8mm; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #000; background: #fff; font-family: Arial, sans-serif; }
      .sheet { width: 281mm; min-height: 194mm; padding: 0; break-after: page; page-break-after: always; }
      .sheet:last-child { break-after: auto; page-break-after: auto; }
      h1 { text-align: center; font-size: 14pt; margin: 0 0 1.2mm; }
      h2 { text-align: center; font-size: 11pt; margin: 0 0 3mm; }
      .metadata { display: flex; justify-content: space-between; gap: 5mm; font-size: 9pt; margin-bottom: 1.2mm; }
      table { width: 100%; table-layout: fixed; border-collapse: collapse; }
      th, td { border: .2mm solid #000; text-align: center; padding: .8mm .4mm; overflow-wrap: anywhere; font-size: 8.5pt; }
      th { font-weight: 700; font-size: 7.5pt; }
      thead { display: table-header-group; }
      tr { break-inside: avoid; page-break-inside: avoid; }
      td { height: var(--row-height, 5.3mm); white-space: nowrap; line-height: 1.12; }
      .number-col { width: 8mm; } .name-col { width: 53mm; }
      .student-name { text-align: left; font-weight: 600; }
      td.student-name { text-transform: uppercase; white-space: normal; }
      .component { font-family: 'Times New Roman', serif; }
      .component h1 { font-size: 12pt; } .component h2 { font-size: 9pt; }
      .component .metadata { font-size: 8pt; }
      .component .name-col { width: 31mm; }
      .component .number-col { width: 5mm; }
      .component th, .component td { font-size: 6.2pt; padding: .6mm .25mm; }
      .component th { font-size: 5.6pt; white-space: nowrap; }
      .vertical { writing-mode: vertical-rl; }
      .legend, .page-number { font: 7pt Arial, sans-serif; margin-top: 2mm; }
      .page-number { text-align: right; } .empty { height: 15mm; }
      @media screen { body { background: #ddd; padding: 8mm; } .sheet { background: #fff; padding: 8mm; width: 297mm; min-height: 210mm; margin: 0 auto 8mm; box-shadow: 0 1mm 3mm #aaa; } }
      @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      </style></head><body>${pages.join('')}</body></html>`,
  };
}
