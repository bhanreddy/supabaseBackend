import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rankResultRows } from './resultRankingService.js';

import {
  MARK_ENTRY_STATUS,
  displayAssessmentPapers,
  examTotalMaximum,
  marksEntryStatusLabel,
  normalizeAssessmentSubjects,
  subjectContribution,
  subjectObtained,
  subjectPercentage,
  summarizeStudentMarks,
} from './marksTotalsService.js';

const paper = (id, maxMarks) => ({ exam_subject_id: id, max_marks: maxMarks });
const graded = (id, maxMarks, marksObtained) => ({
  exam_subject_id: id, max_marks: maxMarks, mark_id: `mark-${id}`, marks_obtained: marksObtained, is_absent: false,
});
const absent = (id, maxMarks) => ({
  exam_subject_id: id, max_marks: maxMarks, mark_id: `mark-${id}`, marks_obtained: null, is_absent: true,
});
const notEntered = (id, maxMarks) => ({
  exam_subject_id: id, max_marks: maxMarks, mark_id: null, marks_obtained: null, is_absent: false,
});

describe('marks totals service', () => {
  it('display selection keeps zeroes, absences and partial components, and hides only the wholly unused alternative', () => {
    const papers = [{ ...paper('sci', 25), subject_name: 'Science' }, { ...paper('evs', 25), subject_name: 'EVS' }, { ...paper('math', 25), subject_name: 'Math' }];
    for (const row of [graded('evs', 25, 0), absent('evs', 25)]) {
      assert.deepEqual(displayAssessmentPapers(papers, [{ subjects: [row] }]).map((item) => item.subject_name), ['EVS', 'Math']);
    }
    const componentPapers = papers.map((item) => ({ ...item, assessment_schema: 'component' }));
    const componentRows = [graded('sci', 25, 25), { ...graded('evs', 25, 12), written_work_marks: 0 }];
    assert.deepEqual(displayAssessmentPapers(componentPapers, [{ subjects: componentRows }]).map((item) => item.subject_name), ['EVS', 'Math']);
    assert.deepEqual(displayAssessmentPapers(papers, []).map((item) => item.subject_name), ['Science', 'EVS', 'Math']);
    assert.deepEqual(displayAssessmentPapers(papers, [{ subjects: [] }]).map((item) => item.subject_name), ['Science', 'EVS', 'Math']);
  });

  it('display selection preserves FA-only summative contributions and does not hide required subjects outside the alternatives', () => {
    const papers = [{ ...paper('sci', 80), subject_name: 'Science' }, { ...paper('evs', 80), subject_name: 'EVS' }, { ...paper('eng', 80), subject_name: 'English' }];
    const students = [{ subjects: [graded('evs', 80, 70)], summative_subjects: [{ exam_subject_id: 'sci', exam_marks: null, formative_contribution: 0 }] }];
    assert.deepEqual(displayAssessmentPapers(papers, students), papers);
    assert.deepEqual(displayAssessmentPapers([papers[0], papers[2]], [{ subjects: [] }]), [papers[0], papers[2]]);
  });

  it('Science and EVS share one paper slot, so the screenshot cohort is complete at 150/150', () => {
    const papers = ['Telugu', 'Hindi', 'English', 'Math', 'Science', 'Social', 'EVS'].map((name) => ({
      ...paper(name, 25), subject_name: name,
    }));
    for (const enteredAlternative of ['Science', 'EVS']) {
      const subjects = papers.filter((item) => !['Science', 'EVS'].includes(item.subject_name) || item.subject_name === enteredAlternative)
        .map((item) => graded(item.exam_subject_id, 25, 25));
      const totals = summarizeStudentMarks({ papers, subjects });
      assert.deepEqual([totals.total_obtained, totals.total_max, totals.exam_total_max, totals.percentage], [150, 150, 150, 100]);
      assert.deepEqual([totals.subject_count, totals.entered_subjects, totals.counted_subjects, totals.missing_subjects], [6, 6, 6, 0]);
      assert.equal(totals.is_complete, true);
      assert.equal(marksEntryStatusLabel(totals, papers.length), 'Complete');
      assert.equal(examTotalMaximum(papers), 150);
    }
  });

  it('both entered Science and EVS retain their values but count Science once, independent of row order or score', () => {
    const papers = [{ ...paper('sci', 25), subject_name: 'Science' }, { ...paper('evs', 25), subject_name: 'EVS' }];
    const subjects = [graded('sci', 25, 15), graded('evs', 25, 25)];
    for (const order of [papers, [...papers].reverse()]) {
      const totals = summarizeStudentMarks({ papers: order, subjects });
      assert.equal(totals.total_obtained, 15);
      assert.equal(totals.total_max, 25);
      assert.equal(totals.percentage, 60);
      assert.equal(totals.is_complete, true);
    }
    assert.deepEqual(subjects.map((subject) => subject.marks_obtained), [15, 25]);
  });

  it('EVS aliases, saved zeroes and absences select an entered alternative without turning a missing paper into zero', () => {
    for (const name of ['EVS', 'E.V.S.', 'Environmental Studies', 'Environmental Science']) {
      const papers = [{ ...paper('sci', 25), subject_name: 'General Science' }, { ...paper('evs', 50), subject_name: name }];
      const zero = summarizeStudentMarks({ papers, subjects: [graded('evs', 50, 0)] });
      assert.deepEqual([zero.total_obtained, zero.total_max, zero.exam_total_max, zero.is_complete], [0, 50, 50, true]);
      const absence = summarizeStudentMarks({ papers, subjects: [absent('evs', 50)] });
      assert.deepEqual([absence.total_obtained, absence.total_max, absence.absent_subjects, absence.is_complete], [0, 50, 1, true]);
      const entered = summarizeStudentMarks({ papers, subjects: [absent('sci', 25), graded('evs', 50, 40)] });
      assert.deepEqual([entered.total_obtained, entered.total_max, entered.absent_subjects, entered.is_complete], [40, 50, 0, true]);
      const missing = summarizeStudentMarks({ papers, subjects: [] });
      assert.equal(missing.is_complete, false);
      assert.equal(missing.missing_subjects, 1);
      assert.equal(missing.total_obtained, null);
    }
  });

  it('component EVS totals come from the components when the unused Science row has a stale cached score', () => {
    const papers = [{ ...paper('sci', 50), subject_name: 'Science', assessment_schema: 'component' },
      { ...paper('evs', 50), subject_name: 'EVS', assessment_schema: 'component' }];
    const subjects = [graded('sci', 50, 50), { ...graded('evs', 50, 17.5),
      participation_marks: 10, written_work_marks: 10, project_work_marks: 10, slip_test_marks: 17.5 }];
    const totals = summarizeStudentMarks({ papers, subjects });
    assert.equal(totals.total_obtained, 47.5);
    assert.equal(totals.percentage, 95);
    assert.equal(totals.is_complete, true);
    assert.equal(totals.subject_count, 1);
  });

  it('Physics, Biology and Social remain independent and only missing required papers mark a row incomplete', () => {
    const papers = ['Science', 'EVS', 'Physics', 'Biology', 'Social'].map((name) => ({ ...paper(name, 25), subject_name: name }));
    const subjects = papers.filter((item) => item.subject_name !== 'EVS').map((item) => graded(item.exam_subject_id, 25, 20));
    const totals = summarizeStudentMarks({ papers, subjects });
    assert.deepEqual([totals.total_obtained, totals.total_max, totals.subject_count, totals.is_complete], [80, 100, 4, true]);
    const partial = summarizeStudentMarks({ papers, subjects: subjects.filter((subject) => subject.exam_subject_id !== 'Social') });
    assert.equal(partial.is_complete, false);
    assert.equal(partial.missing_subjects, 1);
    assert.equal(marksEntryStatusLabel(partial, papers.length), '3/4 entered');
  });

  it('sums Social components and uses that score for grand totals and class ranking', () => {
    const papers = [{ ...paper('soc', 50), assessment_schema: 'component' }, { ...paper('eng', 25), assessment_schema: 'consolidated' }];
    const subjects = [{ ...graded('soc', 50, 17.5), consolidated_marks_obtained: 17.5,
      participation_marks: '10.00', written_work_marks: 10, project_work_marks: 10, slip_test_marks: '17.50' }, graded('eng', 25, 20)];
    const totals = summarizeStudentMarks({ papers, subjects });
    assert.equal(normalizeAssessmentSubjects(papers, subjects)[0].marks_obtained, 47.5);
    assert.equal(subjects[0].marks_obtained, 17.5, 'report calculation must not mutate saved data');
    assert.equal(totals.total_obtained, 67.5);
    assert.equal(totals.total_max, 75);
    assert.equal(totals.percentage, 90);
    assert.equal(totals.is_complete, true);
    const ranked = rankResultRows([{ student_id: 'social-student', percentage: totals.percentage }, { student_id: 'other-student', percentage: 85 }]);
    assert.equal(ranked[0].student_id, 'social-student');
    assert.equal(ranked[0].rank, 1);
  });

  it('uses paper schema even when the stored mark row says consolidated', () => {
    const subjects = [{ ...graded('soc', 50, 1), assessment_schema: 'consolidated',
      participation_marks: 8, written_work_marks: 8, project_work_marks: 10, slip_test_marks: 1 }];
    const totals = summarizeStudentMarks({ papers: [{ ...paper('soc', 50), assessment_schema: 'component' }], subjects });
    assert.equal(totals.total_obtained, 27);
    assert.equal(totals.percentage, 54);
  });

  it('keeps direct scores independent of leftover components', () => {
    const subjects = [{ ...graded('soc', 25, 17.5), assessment_schema: 'component',
      participation_marks: 10, written_work_marks: 10, project_work_marks: 10, slip_test_marks: 17.5 }];
    const totals = summarizeStudentMarks({ papers: [{ ...paper('soc', 25), assessment_schema: 'consolidated' }], subjects });
    assert.equal(totals.total_obtained, 17.5);
    assert.equal(totals.percentage, 70);
  });

  it('handles component zeroes and individual absences without falling back to consolidated marks', () => {
    const base = { ...graded('soc', 50, 23), assessment_schema: 'component' };
    assert.equal(subjectObtained({ ...base, participation_marks: 0, written_work_marks: 0, project_work_marks: 0, slip_test_marks: 0 }), 0);
    assert.equal(subjectObtained({ ...base, participation_marks: 10, written_work_marks: null, project_work_marks: 9, slip_test_marks: 15.25 }), 34.25);
    assert.equal(subjectObtained({ ...base, participation_marks: 0.1, written_work_marks: 0.2, project_work_marks: 0.3, slip_test_marks: 0.4 }), 1);
    assert.equal(subjectObtained({ ...base, participation_marks: 10, written_work_marks: 'bad' }), null);
    const missing = summarizeStudentMarks({ subjects: [base] });
    assert.equal(missing.total_obtained, null);
    assert.equal(missing.is_complete, false);
    const absence = summarizeStudentMarks({ subjects: [{ ...base, is_absent: true }] });
    assert.equal(absence.total_obtained, 0);
    assert.equal(absence.total_max, 50);
    assert.equal(absence.is_complete, true);
  });

  it('totals equal-maximum subjects and divides the grand total once', () => {
    const papers = [paper('eng', 100), paper('math', 100), paper('sci', 100)];
    const totals = summarizeStudentMarks({
      papers,
      subjects: [graded('eng', 100, 85), graded('math', 100, 90), graded('sci', 100, 80)],
    });
    assert.equal(totals.total_obtained, 255);
    assert.equal(totals.total_max, 300);
    assert.equal(totals.percentage, 85);
    assert.equal(totals.exam_total_max, 300);
    assert.equal(totals.is_complete, true);
  });

  it('totals subjects whose maximum is not 100', () => {
    const papers = [paper('eng', 50), paper('math', 50), paper('sci', 50)];
    const totals = summarizeStudentMarks({
      papers,
      subjects: [graded('eng', 50, 45), graded('math', 50, 40), graded('sci', 50, 35)],
    });
    assert.equal(totals.total_obtained, 120);
    assert.equal(totals.total_max, 150);
    assert.equal(totals.percentage, 80);
  });

  it('mixes different maximums per subject without averaging subject percentages', () => {
    const papers = [paper('eng', 100), paper('math', 50), paper('draw', 25)];
    const totals = summarizeStudentMarks({
      papers,
      subjects: [graded('eng', 100, 40), graded('math', 50, 45), graded('draw', 25, 25)],
    });
    assert.equal(totals.total_obtained, 110);
    assert.equal(totals.total_max, 175);
    // Averaging subject percentages would give 71.67; the aggregate is 62.86.
    assert.equal(totals.percentage, 62.86);
  });

  it('sums decimal marks exactly and rounds only the percentage', () => {
    const papers = [paper('a', 33.33), paper('b', 33.33), paper('c', 33.34)];
    const totals = summarizeStudentMarks({
      papers,
      subjects: [graded('a', 33.33, 30.15), graded('b', 33.33, 28.7), graded('c', 33.34, 31.05)],
    });
    assert.equal(totals.total_obtained, 89.9);
    assert.equal(totals.total_max, 100);
    assert.equal(totals.percentage, 89.9);
    assert.ok(Math.abs(totals.percentage - 89.9) < 1e-9);
  });

  it('scores an absence as zero obtained while keeping its maximum in the denominator', () => {
    const papers = [paper('eng', 100), paper('math', 100)];
    const totals = summarizeStudentMarks({
      papers,
      subjects: [graded('eng', 100, 80), absent('math', 100)],
    });
    assert.equal(totals.total_obtained, 80);
    assert.equal(totals.total_max, 200);
    assert.equal(totals.percentage, 40);
    assert.equal(totals.absent_subjects, 1);
    assert.equal(totals.is_complete, true);
  });

  it('excludes subjects with no marks row from both sides of the percentage', () => {
    const papers = [paper('eng', 100), paper('math', 100), paper('sci', 100)];
    const totals = summarizeStudentMarks({
      papers,
      subjects: [graded('eng', 100, 85), graded('math', 100, 90), notEntered('sci', 100)],
    });
    assert.equal(totals.total_obtained, 175);
    assert.equal(totals.total_max, 200);
    assert.equal(totals.percentage, 87.5);
    assert.equal(totals.exam_total_max, 300);
    assert.equal(totals.missing_subjects, 1);
    assert.equal(totals.is_complete, false);
  });

  it('never turns a saved row with no score into a zero', () => {
    const contribution = subjectContribution({
      exam_subject_id: 'eng', mark_id: 'mark-eng', max_marks: 100, marks_obtained: null, is_absent: false,
    });
    assert.equal(contribution.counted, false);
    assert.equal(contribution.status, MARK_ENTRY_STATUS.MISSING);
    assert.equal(contribution.exclusion_reason, 'score_missing');
  });

  it('keeps an optional subject the student did not take out of the totals', () => {
    const papers = [paper('eng', 100), paper('math', 100), paper('sanskrit', 100)];
    const totals = summarizeStudentMarks({
      papers,
      subjects: [graded('eng', 100, 70), graded('math', 100, 60), notEntered('sanskrit', 100)],
    });
    assert.equal(totals.total_obtained, 130);
    assert.equal(totals.total_max, 200);
    assert.equal(totals.percentage, 65);
    assert.equal(totals.counted_subjects, 2);
  });

  it('excludes a subject configured with zero maximum marks instead of dividing by zero', () => {
    const papers = [paper('eng', 100), paper('games', 0)];
    const totals = summarizeStudentMarks({
      papers,
      subjects: [graded('eng', 100, 90), graded('games', 0, 5)],
    });
    assert.equal(totals.total_obtained, 90);
    assert.equal(totals.total_max, 100);
    assert.equal(totals.percentage, 90);
    assert.equal(totals.unassessable_subjects, 1);
    assert.equal(totals.is_complete, false);
    assert.equal(totals.exam_total_max, 100);
  });

  it('reports no total for a student with no marks at all', () => {
    const papers = [paper('eng', 100), paper('math', 100)];
    const totals = summarizeStudentMarks({
      papers,
      subjects: [notEntered('eng', 100), notEntered('math', 100)],
    });
    assert.equal(totals.total_obtained, null);
    assert.equal(totals.total_max, 0);
    assert.equal(totals.percentage, null);
    assert.equal(totals.missing_subjects, 2);
  });

  it('coerces the strings postgres returns for DECIMAL columns', () => {
    const totals = summarizeStudentMarks({
      papers: [{ exam_subject_id: 'eng', max_marks: '100.00' }, { exam_subject_id: 'math', max_marks: '100.00' }],
      subjects: [
        { exam_subject_id: 'eng', mark_id: 'm1', max_marks: '100.00', marks_obtained: '85.00' },
        { exam_subject_id: 'math', mark_id: 'm2', max_marks: '100.00', marks_obtained: '90.50' },
      ],
    });
    assert.equal(totals.total_obtained, 175.5);
    assert.equal(totals.total_max, 200);
    assert.equal(totals.percentage, 87.75);
  });

  it('ignores a duplicated row for the same paper', () => {
    const papers = [paper('eng', 100)];
    const totals = summarizeStudentMarks({
      papers,
      subjects: [graded('eng', 100, 85), graded('eng', 100, 85)],
    });
    assert.equal(totals.total_obtained, 85);
    assert.equal(totals.total_max, 100);
    assert.equal(totals.percentage, 85);
  });

  it('flags marks above the configured maximum without silently clamping them', () => {
    const totals = summarizeStudentMarks({
      papers: [paper('eng', 50)],
      subjects: [graded('eng', 50, 55)],
    });
    assert.equal(totals.exceeds_maximum, true);
    assert.equal(totals.total_obtained, 55);
    assert.equal(totals.total_max, 50);
  });

  it('keeps each examination independent when the same subjects repeat', () => {
    const fa1Papers = [paper('fa1-eng', 25), paper('fa1-math', 25)];
    const sa1Papers = [paper('sa1-eng', 80), paper('sa1-math', 80)];
    const fa1 = summarizeStudentMarks({
      papers: fa1Papers,
      subjects: [graded('fa1-eng', 25, 20), graded('fa1-math', 25, 22)],
    });
    const sa1 = summarizeStudentMarks({
      papers: sa1Papers,
      subjects: [graded('sa1-eng', 80, 64), graded('sa1-math', 80, 72)],
    });
    assert.deepEqual(
      [fa1.total_obtained, fa1.total_max, fa1.percentage],
      [42, 50, 84],
    );
    assert.deepEqual(
      [sa1.total_obtained, sa1.total_max, sa1.percentage],
      [136, 160, 85],
    );
  });

  it('computes subject percentages and exam maximums consistently', () => {
    assert.equal(subjectPercentage(45, 50), 90);
    assert.equal(subjectPercentage(1, 3), 33.33);
    assert.equal(subjectPercentage(10, 0), null);
    assert.equal(subjectPercentage(null, 50), null);
    assert.equal(examTotalMaximum([paper('a', 100), paper('b', 0), paper('c', 50)]), 150);
    assert.equal(examTotalMaximum([]), 0);
  });

  it('labels entry status from the same summary the totals come from', () => {
    const papers = [paper('eng', 100), paper('math', 100)];
    const complete = summarizeStudentMarks({
      papers, subjects: [graded('eng', 100, 50), graded('math', 100, 50)],
    });
    const partial = summarizeStudentMarks({
      papers, subjects: [graded('eng', 100, 50), notEntered('math', 100)],
    });
    assert.equal(marksEntryStatusLabel(complete, papers.length), 'Complete');
    assert.equal(marksEntryStatusLabel(partial, papers.length), '1/2 entered');
    assert.equal(marksEntryStatusLabel(complete, 0), 'No exam papers configured');
  });
});
