/**
 * The single source of truth for progress-report marks totals.
 *
 * Every progress report surface (staff screen, staff class Excel register,
 * accounts school-wide Excel register, class ranking) must derive Total
 * Obtained, Total Maximum and Percentage from this module. Adding a second
 * formula anywhere is what made the Excel register disagree with the screen.
 *
 * Business rules, in the order they are applied to each exam paper:
 *
 *  1. A subject only enters the totals when a marks row was saved for it.
 *     A saved zero and a saved absence are both real results and are kept.
 *     A paper with no marks row is "missing": it is excluded from both the
 *     numerator and the denominator and reported separately, so an incomplete
 *     student is never silently penalised with an implicit zero.
 *  2. An absence contributes 0 obtained and still contributes its configured
 *     maximum, because the student sat the exam schedule and missed the paper.
 *  3. A paper with no positive configured maximum cannot be scored. It is
 *     excluded from both sides and reported as unassessable rather than
 *     dividing by zero or inflating the percentage.
 *  4. A saved row whose score is null / non-numeric (and which is not an
 *     absence) is treated as missing data, never as zero.
 *
 * Percentage = Total Obtained / Total Maximum * 100, computed from the
 * unrounded sums and rounded only once, at the end. Subject percentages are
 * never averaged.
 */

/** Marks are DECIMAL(5,2); summing in hundredths keeps the arithmetic exact. */
const SCALE = 100;

export const MARK_ENTRY_STATUS = Object.freeze({
  GRADED: 'graded',
  ABSENT: 'absent',
  MISSING: 'missing',
});

export const MARK_EXCLUSION_REASON = Object.freeze({
  NO_MARKS_ENTERED: 'no_marks_entered',
  SCORE_MISSING: 'score_missing',
  NO_MAXIMUM_CONFIGURED: 'no_maximum_configured',
});

/** postgres.js returns DECIMAL columns as strings, so coerce before arithmetic. */
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const toHundredths = (value) => Math.round(value * SCALE);
const fromHundredths = (value) => value / SCALE;
const round2 = (value) => Math.round(value * 100) / 100;

/** A marks row exists. Accepts every shape the progress-report queries return. */
export function hasSavedMark(subject) {
  return subject?.mark_id != null
    || subject?.hasMarks === true
    || subject?.has_marks === true;
}

function isAbsent(subject) {
  return subject?.is_absent === true || subject?.isAbsent === true;
}

export function subjectMaximum(subject) {
  return finiteNumber(subject?.max_marks);
}

export function subjectObtained(subject) {
  return finiteNumber(subject?.marks_obtained);
}

export function markEntryStatus(subject) {
  if (!hasSavedMark(subject)) return MARK_ENTRY_STATUS.MISSING;
  return isAbsent(subject) ? MARK_ENTRY_STATUS.ABSENT : MARK_ENTRY_STATUS.GRADED;
}

/** One subject's contribution to the grand total, or why it cannot contribute. */
export function subjectContribution(subject) {
  const entryStatus = markEntryStatus(subject);
  const excluded = (status, reason) => ({
    status, counted: false, obtained: null, maximum: null, exclusion_reason: reason,
  });

  if (entryStatus === MARK_ENTRY_STATUS.MISSING) {
    return excluded(entryStatus, MARK_EXCLUSION_REASON.NO_MARKS_ENTERED);
  }

  const maximum = subjectMaximum(subject);
  if (maximum === null || maximum <= 0) {
    return excluded(entryStatus, MARK_EXCLUSION_REASON.NO_MAXIMUM_CONFIGURED);
  }

  if (entryStatus === MARK_ENTRY_STATUS.ABSENT) {
    return { status: entryStatus, counted: true, obtained: 0, maximum, exclusion_reason: null };
  }

  const obtained = subjectObtained(subject);
  if (obtained === null) {
    return excluded(MARK_ENTRY_STATUS.MISSING, MARK_EXCLUSION_REASON.SCORE_MISSING);
  }
  return { status: entryStatus, counted: true, obtained, maximum, exclusion_reason: null };
}

/** Percentage for a single subject, or null when it cannot be scored. */
export function subjectPercentage(obtained, maximum) {
  const score = finiteNumber(obtained);
  const total = finiteNumber(maximum);
  if (score === null || total === null || total <= 0) return null;
  return round2((score / total) * 100);
}

/** Full configured maximum for an exam, used for headers and completeness. */
export function examTotalMaximum(papers = []) {
  if (!Array.isArray(papers)) return 0;
  const scaled = papers.reduce((total, paper) => {
    const maximum = subjectMaximum(paper);
    return maximum !== null && maximum > 0 ? total + toHundredths(maximum) : total;
  }, 0);
  return fromHundredths(scaled);
}

/** Drops repeated rows for the same paper so a duplicate join cannot inflate totals. */
function uniqueSubjects(subjects) {
  if (!Array.isArray(subjects)) return [];
  const seen = new Set();
  return subjects.filter((subject) => {
    const key = subject?.exam_subject_id ?? subject?.mark_id ?? subject?.subject_id;
    if (key == null) return true;
    const identity = String(key);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/**
 * Grand total, maximum and percentage for one student in one examination.
 *
 * @param {object} input
 * @param {Array} [input.papers] every configured exam paper for the class
 * @param {Array} [input.subjects] the student's rows, one per paper
 */
export function summarizeStudentMarks({ papers = [], subjects = [] } = {}) {
  const rows = uniqueSubjects(subjects);
  const contributions = rows.map(subjectContribution);
  const counted = contributions.filter((contribution) => contribution.counted);

  const obtainedHundredths = counted.reduce(
    (total, contribution) => total + toHundredths(contribution.obtained),
    0,
  );
  const maximumHundredths = counted.reduce(
    (total, contribution) => total + toHundredths(contribution.maximum),
    0,
  );
  const totalObtained = counted.length > 0 ? fromHundredths(obtainedHundredths) : null;
  const totalMax = fromHundredths(maximumHundredths);

  const enteredSubjects = rows.filter(hasSavedMark).length;
  const unassessableSubjects = contributions.filter((contribution) =>
    contribution.exclusion_reason === MARK_EXCLUSION_REASON.NO_MAXIMUM_CONFIGURED,
  ).length;
  const subjectCount = Array.isArray(papers) && papers.length > 0 ? papers.length : rows.length;

  return {
    total_obtained: totalObtained,
    total_max: totalMax,
    percentage: totalObtained === null ? null : subjectPercentage(totalObtained, totalMax),
    exam_total_max: examTotalMaximum(papers),
    subject_count: subjectCount,
    entered_subjects: enteredSubjects,
    counted_subjects: counted.length,
    graded_subjects: contributions.filter((c) => c.counted && c.status === MARK_ENTRY_STATUS.GRADED).length,
    absent_subjects: contributions.filter((c) => c.counted && c.status === MARK_ENTRY_STATUS.ABSENT).length,
    missing_subjects: Math.max(0, subjectCount - enteredSubjects),
    unassessable_subjects: unassessableSubjects,
    is_complete: subjectCount > 0
      && enteredSubjects === subjectCount
      && counted.length === subjectCount,
    exceeds_maximum: counted.some((contribution) => contribution.obtained > contribution.maximum),
  };
}

/** Human-readable entry status for report headers and Excel registers. */
export function marksEntryStatusLabel(summary, paperCount) {
  if (!paperCount) return 'No exam papers configured';
  const base = summary.entered_subjects >= paperCount
    ? 'Complete'
    : `${summary.entered_subjects}/${paperCount} entered`;
  return summary.unassessable_subjects > 0
    ? `${base} · ${summary.unassessable_subjects} without maximum marks`
    : base;
}
