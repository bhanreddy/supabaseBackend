import { hasSavedMark } from './marksTotalsService.js';

const fields = ['participation_marks', 'written_work_marks', 'project_work_marks', 'slip_test_marks'];
const maximumFields = fields.map((field) => field.replace('_marks', '_max_marks'));
const number = (value) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const identity = (row) => String(row.exam_subject_id ?? row.subject_id);

/** Recover a legacy component paper for this section's FA print only.
 * A shared direct paper can still be correct for another section. Require all
 * scored rows to agree with valid saved components, and an impossible direct
 * score, before overriding its schema/maximum in a disposable copy.
 */
export function resolveFormativePrintPapers(papers = [], students = []) {
  return papers.map((paper) => {
    if (paper.assessment_schema !== 'consolidated') return paper;
    const directMaximum = number(paper.max_marks);
    const maxima = maximumFields.map((field) => number(paper[field]));
    if (!(directMaximum > 0) || maxima.some((max) => !(max > 0))) return paper;
    const componentMaximum = maxima.reduce((sum, max) => sum + max, 0);
    if (componentMaximum <= directMaximum) return paper;
    const rows = students.flatMap((student) => (student.subjects || []).filter((row) =>
      identity(row) === identity(paper) && hasSavedMark(row) && !row.is_absent && !row.isAbsent
      && number(row.marks_obtained) !== null));
    if (!rows.some((row) => number(row.marks_obtained) > directMaximum)) return paper;
    if (!rows.every((row) => {
      const values = fields.map((field) => number(row[field]));
      return values.every((value, index) => value !== null && value >= 0 && value <= maxima[index])
        && Math.round(values.reduce((sum, value) => sum + value, 0) * 100) === Math.round(number(row.marks_obtained) * 100);
    })) return paper;
    const passing = number(paper.passing_marks);
    return { ...paper, assessment_schema: 'component', max_marks: componentMaximum,
      passing_marks: passing === null ? paper.passing_marks : Number((passing / directMaximum * componentMaximum).toFixed(2)),
      print_component_recovery: true };
  });
}
