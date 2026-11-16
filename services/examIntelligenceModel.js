import { subjectObtained, selectScoringSubjects, summarizeStudentMarks } from './marksTotalsService.js';
import { rankResultRows } from './resultRankingService.js';
export const CALCULATION_VERSION = 'exam-intelligence/1.0.0';
export const DEFAULT_POLICY = Object.freeze({
  minimum_sample: 10,
  decline_pp: 10,
  participation_attention: 90,
  borderline_pp: 5,
  eligibility_confirmed: false,
  identical_fraction: .9
});
export const finite = value => value == null || String(value).trim() === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
export const ratio = (a, b) => b > 0 ? a / b * 100 : null;
export const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
export const quantile = (sorted, p) => {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * p,
    lo = Math.floor(at);
  return sorted[lo] + (sorted[Math.ceil(at)] - sorted[lo]) * (at - lo);
};
export function statistics(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b),
    mean = average(sorted);
  return {
    n: sorted.length,
    mean,
    median: quantile(sorted, .5),
    minimum: sorted[0] ?? null,
    maximum: sorted.at(-1) ?? null,
    standard_deviation: mean == null ? null : Math.sqrt(average(sorted.map(x => (x - mean) ** 2))),
    q1: quantile(sorted, .25),
    q3: quantile(sorted, .75)
  };
}

/** Never interpret remarks or an absent/null score as an assessed zero. */
export function classifyResult(row) {
  if (row.duplicate_identity) return {
    state: 'invalid',
    score: null,
    reason: 'duplicate_assessment_identity'
  };
  if (row.ambiguous_enrollment) return {
    state: 'invalid',
    score: null,
    reason: 'overlapping_enrollments'
  };
  if (!row.mark_id) return {
    state: 'unsubmitted',
    score: null
  };
  const explicit = row.analytics_result_state;
  if (explicit && !['assessed', 'absent', 'exempt', 'medical_absence', 'pending', 'withheld', 'invalid'].includes(explicit)) return {
    state: 'invalid',
    score: null,
    reason: 'unknown_state'
  };
  if (explicit && explicit !== 'assessed') return {
    state: explicit,
    score: null
  };
  if (row.is_absent) return {
    state: explicit === 'assessed' ? 'invalid' : 'absent',
    score: null
  };
  const score = subjectObtained(row),
    maximum = finite(row.max_marks);
  if (maximum == null || maximum <= 0) return {
    state: 'invalid',
    score: null,
    reason: 'invalid_maximum'
  };
  if (score == null) return {
    state: 'pending',
    score: null
  };
  if (score < 0 || score > maximum) return {
    state: 'invalid',
    score: null,
    reason: 'score_out_of_range'
  };
  if (row.assessment_schema === 'component') {
    const fields = ['participation', 'written_work', 'project_work', 'slip_test'];
    if (fields.some(key => finite(row[`${key}_marks`]) != null && (finite(row[`${key}_marks`]) < 0 || finite(row[`${key}_max_marks`]) != null && finite(row[`${key}_marks`]) > finite(row[`${key}_max_marks`])))) return {
      state: 'invalid',
      score: null,
      reason: 'component_out_of_range'
    };
  }
  return {
    state: 'assessed',
    score,
    percentage: score / maximum * 100
  };
}
export function gradeFor(percentage, bands) {
  if (percentage == null) return null;
  const matches = bands.filter(b => percentage >= Number(b.min_percentage) && (percentage < Number(b.max_percentage) || percentage === 100 && Number(b.max_percentage) === 100));
  return matches.length === 1 ? matches[0].grade : null;
}
export function compareSubjects(current, baseline, policy = {}) {
  const reasons = [];
  if (!current || !baseline) reasons.push('Subject is not scheduled at both assessments.');else {
    if (!(finite(current.max_marks) > 0) || !(finite(baseline.max_marks) > 0)) reasons.push('A positive assessment maximum is required.');
    if (current.class_id !== baseline.class_id) reasons.push('Grade levels differ.');
    if (current.assessment_schema !== baseline.assessment_schema) reasons.push('Assessment formats differ.');
    if (current.exam_type !== baseline.exam_type) reasons.push('Assessment types differ.');
    if (current.policy_version !== baseline.policy_version) reasons.push('Grading/weight policy versions differ.');
    if (current.passing_marks == null || baseline.passing_marks == null || Math.abs(Number(current.passing_marks) / Number(current.max_marks) - Number(baseline.passing_marks) / Number(baseline.max_marks)) > 1e-10) reasons.push('Pass rules differ or are unavailable.');
  }
  const status = reasons.length ? 'unsuitable' : 'normalized_with_limitations';
  const before = new Map((baseline?.records || []).filter(r => r.state === 'assessed' && r.published).map(r => [r.student_id, r]));
  const after = (current?.records || []).filter(r => r.state === 'assessed' && r.published);
  const afterIds = new Set(after.map(r => r.student_id));
  const matched = after.filter(r => before.has(r.student_id)).map(r => ({
    student_id: r.student_id,
    display_name: r.display_name,
    before: before.get(r.student_id).percentage,
    after: r.percentage,
    delta_pp: r.percentage - before.get(r.student_id).percentage
  }));
  const currentRoster = new Set((current?.records || []).map(r => r.student_id));
  const baselineRoster = new Set((baseline?.records || []).map(r => r.student_id));
  const currentDate = current?.assessment_date ? new Date(current.assessment_date).getTime() : NaN;
  const baselineDate = baseline?.assessment_date ? new Date(baseline.assessment_date).getTime() : NaN;
  const chronology = Number.isFinite(currentDate) && Number.isFinite(baselineDate) ? currentDate > baselineDate ? 'forward' : currentDate === baselineDate ? 'same_date' : 'reverse' : 'undated';
  const minimum = policy.minimum_sample ?? 10;
  const band = value => Math.min(4, Math.floor(value / 20));
  const migration = Array.from({
    length: 5
  }, (_, from) => Array.from({
    length: 5
  }, (_, to) => ({
    from: from * 20,
    to: to * 20,
    n: matched.filter(r => band(r.before) === from && band(r.after) === to).length
  }))).flat();
  return {
    status,
    chronology,
    reasons,
    baseline_raw_statistics: baseline?.raw_statistics ?? null,
    current_raw_statistics: current?.raw_statistics ?? null,
    baseline_max_marks: baseline?.max_marks ?? null,
    current_max_marks: current?.max_marks ?? null,
    baseline_statistics: baseline?.statistics ?? null,
    current_statistics: current?.statistics ?? null,
    baseline_distribution: baseline?.distribution ?? [],
    current_distribution: current?.distribution ?? [],
    band_migration: status === 'unsuitable' ? [] : migration,
    reasons_detail: 'Band migration uses fixed analytical 20-percentage-point bands, not school grades.',
    limitations: ['Normalization does not establish equal difficulty, syllabus coverage or accommodations.', 'Change describes matched published records; it does not establish causation.', ...(chronology === 'forward' ? [] : ['Assessments are not in forward chronological order; differences are descriptive, not temporal growth.'])],
    matched_n: matched.length,
    current_n: after.length,
    baseline_n: before.size,
    coverage_percentage: ratio(matched.length, after.length),
    current_roster_n: currentRoster.size,
    baseline_roster_n: baselineRoster.size,
    entrants: [...currentRoster].filter(id => !baselineRoster.has(id)).length,
    leavers: [...baselineRoster].filter(id => !currentRoster.has(id)).length,
    new_valid_results: after.filter(r => baselineRoster.has(r.student_id) && !before.has(r.student_id)).length,
    lost_valid_results: [...before.keys()].filter(id => currentRoster.has(id) && !afterIds.has(id)).length,
    low_sample: matched.length < minimum,
    mean_delta_pp: status === 'unsuitable' ? null : average(matched.map(r => r.delta_pp)),
    improving_n: status === 'unsuitable' || chronology !== 'forward' ? null : matched.filter(r => r.delta_pp > 0).length,
    declining_n: status === 'unsuitable' || chronology !== 'forward' ? null : matched.filter(r => r.delta_pp < 0).length,
    matched: status === 'unsuitable' ? [] : matched
  };
}
export function buildSnapshot({
  rows,
  exam,
  policy = {},
  grades = [],
  rankingMethod = 'competition',
  asOf = new Date().toISOString(),
  filters = {}
}) {
  policy = {
    ...DEFAULT_POLICY,
    ...policy
  };
  const subjects = new Map(),
    learners = new Map(),
    offerings = new Map();
  for (const row of rows) {
    if (!offerings.has(row.class_section_id)) offerings.set(row.class_section_id, new Map());
    offerings.get(row.class_section_id).set(row.exam_subject_id || row.subject_id, row);
    const result = classifyResult(row);
    const grade = exam.results_published ? gradeFor(result.percentage, grades) : null;
    const nextGrade = grade == null ? null : [...grades].filter(b => Number(b.min_percentage) > result.percentage).sort((a, b) => Number(a.min_percentage) - Number(b.min_percentage))[0];
    const record = {
      student_id: row.student_id,
      enrollment_id: row.enrollment_id,
      display_name: row.display_name,
      admission_no: row.admission_no,
      class_section_id: row.class_section_id,
      state: result.state,
      reason: result.reason ?? null,
      score: result.score,
      max_marks: finite(row.max_marks),
      percentage: result.percentage ?? null,
      published: exam.results_published === true,
      grade,
      pass_margin_marks: result.state === 'assessed' && finite(row.passing_marks) != null ? result.score - Number(row.passing_marks) : null,
      next_grade: nextGrade?.grade ?? null,
      next_grade_gap_pp: nextGrade ? Number(nextGrade.min_percentage) - result.percentage : null,
      next_grade_gap_marks: nextGrade ? Number(nextGrade.min_percentage) / 100 * Number(row.max_marks) - result.score : null,
      mark_id: row.mark_id,
      updated_at: row.mark_updated_at,
      passed: result.state === 'assessed' && finite(row.passing_marks) != null && finite(row.passing_marks) >= 0 && finite(row.passing_marks) <= finite(row.max_marks) ? result.score >= Number(row.passing_marks) : null
    };
    const key = `${row.class_section_id}:${row.subject_id}`;
    if (!subjects.has(key)) subjects.set(key, {
      key,
      subject_id: row.subject_id,
      subject_name: row.subject_name,
      class_id: row.class_id,
      class_section_id: row.class_section_id,
      class_name: row.class_name,
      section_name: row.section_name,
      assessment_schema: row.assessment_schema,
      max_marks: finite(row.max_marks),
      passing_marks: finite(row.passing_marks),
      exam_type: exam.exam_type,
      policy_version: JSON.stringify({
        grades,
        weights: (policy.class_policies?.[row.class_id] || policy).subject_weights,
        required_subject_ids: (policy.class_policies?.[row.class_id] || policy).required_subject_ids,
        eligibility: (policy.class_policies?.[row.class_id] || policy).eligibility_confirmed
      }),
      assessment_date: row.assessment_date,
      date_source: row.date_source,
      records: []
    });
    subjects.get(key).records.push(record);
    if (!learners.has(row.student_id)) learners.set(row.student_id, {
      student_id: row.student_id,
      display_name: row.display_name,
      admission_no: row.admission_no,
      class_section_id: row.class_section_id,
      subjects: []
    });
    learners.get(row.student_id).subjects.push({
      ...row,
      ...record,
      has_marks: Boolean(row.mark_id),
      is_absent: ['absent', 'medical_absence'].includes(record.state),
      marks_obtained: record.score
    });
  }
  for (const subject of subjects.values()) {
    const valid = subject.records.filter(r => r.state === 'assessed' && r.published);
    subject.statistics = statistics(valid.map(r => r.percentage));
    subject.raw_statistics = statistics(valid.map(r => r.score));
    subject.states = Object.fromEntries(['assessed', 'absent', 'exempt', 'medical_absence', 'pending', 'withheld', 'invalid', 'unsubmitted'].map(s => [s, subject.records.filter(r => r.state === s).length]));
    subject.eligible_n = subject.records.length - subject.states.exempt;
    subject.participation = {
      numerator: subject.states.assessed,
      denominator: subject.eligible_n,
      percentage: ratio(subject.states.assessed, subject.eligible_n)
    };
    const entered = subject.records.filter(r => !['unsubmitted', 'pending', 'invalid'].includes(r.state)).length;
    subject.entry_completion = {
      numerator: entered,
      denominator: subject.records.length,
      percentage: ratio(entered, subject.records.length)
    };
    subject.pass = {
      numerator: valid.filter(r => r.passed === true).length,
      denominator: valid.filter(r => r.passed != null).length
    };
    subject.pass.percentage = ratio(subject.pass.numerator, subject.pass.denominator);
    subject.distinction_rate = finite(policy.distinction_percentage) == null ? null : ratio(valid.filter(r => r.percentage >= policy.distinction_percentage).length, valid.length);
    subject.grade_distribution = Object.entries(valid.reduce((a, r) => {
      const key = r.grade ?? 'Unmapped';
      a[key] = (a[key] || 0) + 1;
      return a;
    }, {})).map(([grade, n]) => ({
      grade,
      n
    }));
    subject.distribution = [0, 20, 40, 60, 80].map(from => ({
      from,
      to: from + 20,
      n: valid.filter(r => r.percentage >= from && (r.percentage < from + 20 || from === 80 && r.percentage === 100)).length
    }));
    subject.highest_tied_n = valid.filter(r => r.percentage === subject.statistics.maximum).length;
    subject.lowest_tied_n = valid.filter(r => r.percentage === subject.statistics.minimum).length;
    subject.low_sample = valid.length < policy.minimum_sample;
  }
  const students = [...learners.values()].map(learner => {
    const classPolicy = policy.class_policies?.[learner.subjects[0]?.class_id] || policy;
    const sectionIds = new Set(learner.subjects.map(r => r.class_section_id));
    const paperMap = new Map([...sectionIds].flatMap(id => [...offerings.get(id).entries()]));
    const selected = selectScoringSubjects([...paperMap.values()], learner.subjects);
    const effective = selected.subjects;
    const expectedSubjects = classPolicy.required_subject_ids || selected.papers.map(r => r.subject_id);
    const required = classPolicy.required_subject_ids ? effective.filter(s => classPolicy.required_subject_ids.includes(s.subject_id)) : effective;
    const validRequired = required.filter(s => ['assessed', 'absent'].includes(s.state));
    const stableCohort = new Set(required.map(s => s.class_section_id)).size === 1;
    const complete = stableCohort && exam.results_published === true && classPolicy.eligibility_confirmed === true && required.length > 0 && validRequired.length === required.length && expectedSubjects.length === required.length;
    const totals = summarizeStudentMarks({
      papers: required,
      subjects: required
    });
    let percentage = complete && totals.total_max > 0 ? totals.total_obtained / totals.total_max * 100 : null;
    if (complete && classPolicy.subject_weights) {
      const weights = required.map(s => finite(classPolicy.subject_weights[s.subject_id]));
      percentage = weights.some(w => w == null || w <= 0) ? null : required.reduce((a, s, i) => a + (s.score ?? 0) / s.max_marks * weights[i], 0) / weights.reduce((a, b) => a + b, 0) * 100;
    }
    return {
      ...learner,
      subjects: learner.subjects,
      compatibility_signature: JSON.stringify(required.map(s => [s.subject_id, s.assessment_schema, classPolicy.subject_weights?.[s.subject_id] ?? s.max_marks]).sort()),
      complete: complete && percentage != null,
      percentage,
      obtained: complete ? totals.total_obtained : null,
      maximum: complete ? totals.total_max : null,
      all_subjects_passed: complete && required.every(s => s.passed != null || ['absent', 'medical_absence'].includes(s.state)) ? required.every(s => s.passed === true) : null,
      support_subjects: learner.subjects.filter(s => s.passed === false && s.published).map(s => s.subject_id),
      rank: null,
      percentile: null
    };
  });
  const bySection = new Map();
  for (const s of students.filter(s => s.complete)) {
    const groupKey = `${s.class_section_id}:${s.compatibility_signature}`;
    if (!bySection.has(groupKey)) bySection.set(groupKey, []);
    bySection.get(groupKey).push(s);
  }
  for (const group of bySection.values()) {
    // Attendance tie breaking needs verified period attendance; never invent it.
    if (group.length < policy.minimum_sample || rankingMethod === 'attendance_tiebreak') continue;
    const ranked = rankResultRows(group, rankingMethod);
    for (const r of ranked) {
      const original = group.find(s => s.student_id === r.student_id);
      original.rank = r.rank;
      original.percentile = group.length > 1 ? (group.filter(s => s.percentage < r.percentage).length + (group.filter(s => s.percentage === r.percentage).length - 1) / 2) / (group.length - 1) * 100 : null;
    }
  }
  const completeStudents = students.filter(s => s.complete),
    list = [...subjects.values()];
  const counts = list.reduce((a, s) => {
    for (const [k, v] of Object.entries(s.states)) a[k] = (a[k] || 0) + v;
    return a;
  }, {});
  const passKnown = completeStudents.filter(s => s.all_subjects_passed != null);
  const totalEntries = rows.length,
    eligible = totalEntries - (counts.exempt || 0);
  const validMarks = list.flatMap(s => s.records).filter(r => r.state === 'assessed' && r.published);
  const comparableGroups = [...new Set(list.map(s => s.class_id))];
  const summary = {
    students: students.length,
    subjects: list.length,
    complete_students: completeStudents.length,
    mean_percentage: average(completeStudents.map(s => s.percentage)),
    median_percentage: statistics(completeStudents.map(s => s.percentage)).median,
    distinction_rate: finite(policy.distinction_percentage) == null ? null : ratio(completeStudents.filter(s => s.percentage >= policy.distinction_percentage).length, completeStudents.length),
    aggregate_definition: 'Mean of complete eligible single-exam student totals; raw paper maxima supply weights unless explicit subject weights are configured. This is not a final-term report.',
    pass_rate: {
      numerator: passKnown.filter(s => s.all_subjects_passed).length,
      denominator: passKnown.length,
      percentage: ratio(passKnown.filter(s => s.all_subjects_passed).length, passKnown.length)
    },
    participation: {
      numerator: counts.assessed || 0,
      denominator: eligible,
      percentage: ratio(counts.assessed || 0, eligible)
    },
    entry_completion: {
      numerator: totalEntries - (counts.unsubmitted || 0) - (counts.pending || 0) - (counts.invalid || 0),
      denominator: totalEntries
    },
    needing_support: new Set(validMarks.filter(r => r.passed === false).map(r => r.student_id)).size,
    states: counts,
    invalid_records: counts.invalid || 0,
    verified_completion: null
  };
  summary.entry_completion.percentage = ratio(summary.entry_completion.numerator, totalEntries);
  const provenance = {
    calculation_version: CALCULATION_VERSION,
    data_as_of: asOf,
    filters,
    publication: exam.results_published ? 'published' : 'unpublished',
    cohort_definition: 'Enrollment inclusive start/end dates at each scheduled paper date; exam start date fallback is disclosed. Current student/enrollment status is not used.',
    achievement_definition: 'Valid assessed published results only; zero is assessed; absence/pending/withheld/exempt/invalid/unsubmitted are excluded from achievement statistics.',
    participation_definition: 'Valid assessed / scheduled students excluding explicit exemptions. Entry completion counts assessed, absent, medical absence, exempt and withheld entries, published or unpublished.',
    quartiles: 'R-7 linear interpolation: index (n−1)p',
    standard_deviation: 'Population (divide by n)',
    percentile: 'Midrank excluding self: 100 × (below + (tied−1)/2) / (n−1); unavailable for n<2 or suppressed rankings.',
    ranking_method: rankingMethod,
    ranking_suppression: rankingMethod === 'attendance_tiebreak' ? 'Period-specific attendance tie-break evidence is unavailable.' : 'Ranks require complete compatible results and at least the configured minimum sample.',
    minimum_sample: policy.minimum_sample,
    exclusions: counts,
    eligibility_confirmed: policy.eligibility_confirmed === true || students.length > 0 && students.every(s => policy.class_policies?.[s.subjects[0]?.class_id]?.eligibility_confirmed === true),
    comparable_grade_groups: comparableGroups.length,
    limitations: ['Elective eligibility must be confirmed before overall totals/ranks are available.', 'Historical teacher assignments, verification records and competency mappings are not inferred.', 'Grading uses current school configuration; historical policy equivalence is not established.', ...(comparableGroups.length > 1 ? ['School mean combines configured single-exam results across grade contexts; grade-level extremes and rankings are not combined.'] : []), ...(list.some(s => s.date_source !== 'paper') ? ['Some cohorts use the exam start date because a paper date is missing.'] : [])]
  };
  return {
    exam,
    summary,
    subjects: list,
    students,
    provenance,
    policy
  };
}
export function insightsFor(snapshot, comparisons = []) {
  const {
    summary,
    provenance,
    policy
  } = snapshot;
  const out = [];
  const add = (rule, severity, title, evidence, filters = provenance.filters, n = summary.students) => out.push({
    id: `${snapshot.exam.id}:${rule}:${JSON.stringify(filters)}`,
    rule_id: rule,
    rule_version: '1',
    severity,
    title,
    evidence,
    filters,
    n,
    sufficient_data: n >= policy.minimum_sample,
    data_as_of: provenance.data_as_of,
    calculation_version: CALCULATION_VERSION,
    deep_link: `/admin/exam-analytics?${new URLSearchParams(Object.entries(filters).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))}`
  });
  if (snapshot.exam.results_published_at) {
    const revised = snapshot.subjects.flatMap(s => s.records).filter(r => r.updated_at && new Date(r.updated_at).getTime() > new Date(snapshot.exam.results_published_at).getTime());
    if (revised.length) add('post-publication-revision', 'attention', 'Review marks updated after recorded publication', {
      count: revised.length,
      publication_at: snapshot.exam.results_published_at,
      interpretation: 'A review signal; not proof of misconduct.'
    });
  }
  if (summary.invalid_records) add('data-quality', 'attention', 'Review invalid result records', {
    count: summary.invalid_records,
    denominator: summary.entry_completion.denominator
  });
  if (summary.participation.percentage != null && summary.participation.percentage < policy.participation_attention) add('participation', 'attention', 'Review assessment participation', summary.participation);
  if (summary.entry_completion.percentage != null && summary.entry_completion.percentage < 100) add('entry-incomplete', 'attention', 'Marks entry is incomplete', summary.entry_completion);
  if (!snapshot.exam.results_published) add('unpublished', 'information', 'Achievement is unavailable until results are published', {
    publication: 'unpublished'
  });
  for (const s of snapshot.subjects) {
    const failures = s.records.filter(r => r.published && r.passed === false);
    const assessed = s.records.filter(r => r.published && r.state === 'assessed');
    const frequencies = new Map();
    for (const record of assessed) frequencies.set(record.score, (frequencies.get(record.score) || 0) + 1);
    const most = [...frequencies.entries()].sort((a, b) => b[1] - a[1])[0];
    if (assessed.length >= policy.minimum_sample && most && most[1] / assessed.length >= policy.identical_fraction) add(`identical-marks:${s.key}`, 'attention', `Review concentrated marks in ${s.subject_name}`, {
      identical_n: most[1],
      assessed_n: assessed.length,
      score: most[0],
      maximum: s.max_marks,
      interpretation: 'Identical marks can be legitimate; this is a review signal only.'
    }, {
      ...provenance.filters,
      class_section_id: s.class_section_id,
      subject_id: s.subject_id
    }, assessed.length);
    if (failures.length) add(`subject-support:${s.key}`, 'attention', `Review support in ${s.subject_name}`, {
      below_pass_n: failures.length,
      assessed_n: s.statistics.n,
      passing_marks: s.passing_marks,
      maximum: s.max_marks
    }, {
      ...provenance.filters,
      class_section_id: s.class_section_id,
      subject_id: s.subject_id
    }, s.statistics.n);
  }
  for (const c of comparisons) if (c.comparison.status !== 'unsuitable' && c.comparison.chronology === 'forward' && !c.comparison.low_sample && c.comparison.mean_delta_pp < 0 && c.comparison.mean_delta_pp <= -policy.decline_pp) add(`matched-decline:${c.key}`, 'attention', `Observed decline in ${c.subject_name}`, {
    mean_delta_pp: c.comparison.mean_delta_pp,
    matched_n: c.comparison.matched_n,
    coverage_percentage: c.comparison.coverage_percentage,
    baseline_exam_id: provenance.filters.baseline_exam_id
  }, {
    ...provenance.filters,
    subject_id: c.subject_id,
    class_section_id: c.class_section_id
  }, c.comparison.matched_n);
  return out.slice(0, 100);
}
export const csvCell = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return `"${value}"`;
  let s = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(s) || /^[\t\r\n]/u.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
