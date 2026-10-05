import { canonicalFinalSourceKey } from './finalResultCalculationService.js';
import { normalizeAssessmentSubjects, subjectContribution } from './marksTotalsService.js';
import { rankResultRows } from './resultRankingService.js';

const round = (value) => Number(value.toFixed(2));

export function usesSummativeMarksRegister(exam, classSection) {
  if (exam?.exam_type !== 'sa_results') return false;
  const name = String(classSection?.class_name || '').toUpperCase().replace(/CLASS|GRADE|STANDARD|STD|\s|[.-]/g, '');
  const romans = { VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
  const number = romans[name] ?? Number(name.replace(/(?:ST|ND|RD|TH)$/, ''));
  return number >= 6 && number <= 10;
}

export function summativeFormativeKeys(exam) {
  const key = canonicalFinalSourceKey(exam?.exam_type, exam?.name);
  if (!['sa1', 'sa2'].includes(key)) throw new Error('Name the summative exam SA-1 or SA-2 to select its formative assessments.');
  return key === 'sa1' ? ['fa1', 'fa2'] : ['fa3', 'fa4'];
}

function sourceContribution(source) {
  if (!source) return null;
  const result = subjectContribution(source);
  return result.counted ? result : null;
}

/** Add the entered exam score directly to the FA contribution (20, or 10 for a science half). */
export function calculateSummativePrintSubject(paper, mark, fa1, fa2, weight = 20) {
  const first = sourceContribution(fa1);
  const second = sourceContribution(fa2);
  const exam = sourceContribution({ ...mark, ...paper, mark_id: mark?.mark_id });
  const formative = first && second
    ? round((first.obtained + second.obtained) / (first.maximum + second.maximum) * weight)
    : null;
  const complete = exam !== null && formative !== null;
  return {
    exam_subject_id: paper.exam_subject_id,
    exam_marks: exam?.obtained ?? null,
    exam_absent: Boolean(mark?.is_absent),
    formative_contribution: formative,
    formative_absent: Boolean(fa1?.is_absent || fa2?.is_absent),
    total: complete ? round(exam.obtained + formative) : null,
    maximum: Number(paper.max_marks) + weight,
    is_complete: complete,
    missing_sources: [!first ? 'First FA' : null, !second ? 'Second FA' : null, !exam ? 'Exam' : null].filter(Boolean),
  };
}

function isScienceHalf(name, physical) {
  const normalized = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  return (physical ? ['physics', 'physicalscience', 'physicalsciences', 'ps']
    : ['biology', 'biologicalscience', 'biologicalsciences', 'bioscience', 'bs']).includes(normalized);
}

function matchesResultFilter(student, filter) {
  if (filter === 'pass') return student.result_status === 'Pass';
  if (filter === 'fail') return student.result_status.startsWith('Fail');
  if (filter === 'absent') return student.has_absence;
  if (filter === 'incomplete') return student.result_status === 'Incomplete';
  return true;
}

/** All cohort students enter ranking before filtering. Source rows must be newest-exam first. */
export function prepareSummativeMarksSection(section, exam, formativeRows, rankingMethod, resultFilter = 'all') {
  const keys = summativeFormativeKeys(exam);
  const papers = section.papers || [];
  const physics = papers.find((paper) => isScienceHalf(paper.subject_name, true));
  const biology = papers.find((paper) => isScienceHalf(paper.subject_name, false));
  const hasSplitScience = Boolean(physics && biology);
  const sources = new Map();
  for (const row of formativeRows) {
    if (String(row.class_section_id) !== String(section.classSection.id)) continue;
    const sourceKey = canonicalFinalSourceKey(row.exam_type, row.exam_name);
    if (!keys.includes(sourceKey)) continue;
    const key = `${row.student_id}:${row.subject_id}:${sourceKey}`;
    if (!sources.has(key)) sources.set(key, row);
  }
  const students = (section.students || []).map((student) => {
    const marks = new Map(normalizeAssessmentSubjects(papers, student.subjects || [])
      .map((mark) => [String(mark.exam_subject_id), mark]));
    const results = papers.map((paper) => calculateSummativePrintSubject(
      paper, marks.get(String(paper.exam_subject_id)),
      sources.get(`${student.student_id}:${paper.subject_id}:${keys[0]}`),
      sources.get(`${student.student_id}:${paper.subject_id}:${keys[1]}`),
      hasSplitScience && [physics, biology].includes(paper) ? 10 : 20,
    ));
    const complete = results.length > 0 && results.every((result) => result.is_complete);
    const total = complete ? round(results.reduce((sum, result) => sum + result.total, 0)) : null;
    const maximum = results.reduce((sum, result) => sum + result.maximum, 0);
    const hasExamAbsence = results.some((result) => result.exam_absent);
    const scienceResults = hasSplitScience ? results.filter((result) =>
      [physics.exam_subject_id, biology.exam_subject_id].includes(result.exam_subject_id)) : [];
    const hasFailedSubject = results.some((result) => !scienceResults.includes(result)
      && result.total / result.maximum * 100 < 35)
      || (hasSplitScience && scienceResults.reduce((sum, result) => sum + result.total, 0)
        / scienceResults.reduce((sum, result) => sum + result.maximum, 0) * 100 < 35);
    return {
      ...student,
      summative_subjects: results,
      total_obtained: total,
      total_max: maximum,
      percentage: complete ? round(total / maximum * 100) : null,
      is_complete: complete,
      has_absence: results.some((result) => result.exam_absent || result.formative_absent),
      result_status: !complete ? 'Incomplete' : hasExamAbsence ? 'Fail (Absent)'
        : hasFailedSubject ? 'Fail' : 'Pass',
    };
  });
  const ranked = rankResultRows(students.filter((student) => student.is_complete), rankingMethod);
  const ranks = new Map(ranked.map((student) => [String(student.student_id), student.rank]));
  return {
    ...section,
    summative: true,
    formative_keys: keys,
    students: students.map((student) => ({ ...student, rank: ranks.get(String(student.student_id)) ?? null }))
      .filter((student) => matchesResultFilter(student, resultFilter)),
  };
}
