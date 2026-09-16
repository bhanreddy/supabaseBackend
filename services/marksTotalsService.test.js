import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MARK_ENTRY_STATUS,
  examTotalMaximum,
  marksEntryStatusLabel,
  subjectContribution,
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
