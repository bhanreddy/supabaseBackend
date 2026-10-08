import { hasSavedMark, normalizeAssessmentSubjects, subjectObtained } from './marksTotalsService.js';
import { componentMaximumsFromRow } from '../utils/componentMaximums.js';

export const ASSESSMENT_PRINT_MARKS_MODES = Object.freeze(['original', 'passing_criteria']);

const finiteMark = (value) => value == null || value === '' || !Number.isFinite(Number(value))
  ? null : Number(value);

/** Round upward to a hundredth so the printed score is never below 36%. */
export function minimumPassingPrintMark(maximum) {
  const max = finiteMark(maximum);
  return max !== null && max > 0 ? Math.ceil(Math.round(max * 100) * 36 / 100) / 100 : null;
}

/** Build disposable print rows; never mutate a saved mark or paper. */
export function assessmentPrintSubjects(papers = [], subjects = [], marksMode = 'original') {
  const normalized = normalizeAssessmentSubjects(papers, subjects);
  const identity = (row) => String(row.exam_subject_id ?? row.subject_id);
  const byId = new Map(papers.map((paper) => [identity(paper), paper]));
  return normalized.map((subject) => {
    const paper = byId.get(identity(subject));
    if (paper?.print_component_recovery) subject = { ...subject, passing_marks: paper.passing_marks };
    if (marksMode !== 'passing_criteria') return subject;
    if (!hasSavedMark(subject) || subject.is_absent || subject.isAbsent) return subject;
    const component = subject.assessment_schema === 'component';
    const field = component ? 'slip_test_marks' : 'marks_obtained';
    const score = finiteMark(subject[field]);
    const maximum = component
      ? componentMaximumsFromRow({ ...subject, ...byId.get(identity(subject)) }).slip_test
      : subject.max_marks;
    const minimum = minimumPassingPrintMark(maximum);
    // Null component marks represent missing entries or component absences.
    if (score === null || minimum === null || score >= minimum) return subject;
    const adjusted = { ...subject, [field]: minimum };
    return { ...adjusted, marks_obtained: subjectObtained(adjusted) };
  });
}
