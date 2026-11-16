import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyResult, statistics, buildSnapshot, compareSubjects, gradeFor, csvCell, insightsFor } from '../services/examIntelligenceModel.js';
const base = {
  class_id: 'grade5',
  class_section_id: '5A',
  class_name: '5',
  section_name: 'A',
  subject_id: 'math',
  subject_name: 'Math',
  assessment_schema: 'consolidated',
  max_marks: 100,
  passing_marks: 40,
  date_source: 'paper'
};
const row = (id, score, extra = {}) => ({
  ...base,
  student_id: id,
  enrollment_id: `e${id}`,
  display_name: id,
  admission_no: id,
  mark_id: `m${id}`,
  marks_obtained: score,
  ...extra
});
const exam = {
  id: 'exam',
  name: 'Exam',
  exam_type: 'custom',
  results_published: true
};
const make = (rows, extra = {}) => buildSnapshot({
  rows,
  exam,
  policy: {
    minimum_sample: 2,
    eligibility_confirmed: true
  },
  ...extra
});
test('zero, absence, exceptional states and invalid marks remain distinct', () => {
  assert.equal(classifyResult(row('zero', 0)).state, 'assessed');
  assert.equal(classifyResult(row('absent', 0, {
    is_absent: true
  })).state, 'absent');
  assert.equal(classifyResult(row('missing', null, {
    mark_id: null
  })).state, 'unsubmitted');
  assert.equal(classifyResult(row('null', null)).state, 'pending');
  assert.equal(classifyResult(row('invalid', 101)).state, 'invalid');
  assert.equal(classifyResult(row('nullstr', 'Null')).state, 'pending');
  assert.equal(classifyResult(row('range', 1, {
    max_marks: 0
  })).state, 'invalid');
  for (const state of ['exempt', 'withheld', 'medical_absence', 'pending']) assert.equal(classifyResult(row(state, 80, {
    analytics_result_state: state
  })).state, state);
  assert.equal(classifyResult(row('overlap', 90, {
    ambiguous_enrollment: true
  })).state, 'invalid');
});
test('independent population statistics and R7 quartiles', () => {
  assert.deepEqual(statistics([0, 20, 40, 60, 80]), {
    n: 5,
    mean: 40,
    median: 40,
    minimum: 0,
    maximum: 80,
    standard_deviation: Math.sqrt(800),
    q1: 20,
    q3: 60
  });
  assert.equal(statistics([0, 20, 80, 100]).q1, 15);
  assert.equal(statistics([]).mean, null);
});
test('achievement excludes invalid/absent/unpublished, retains ties and actual pass rules', () => {
  const s = make([row('a', 0), row('b', 50), row('c', 100), row('d', 100), row('e', null, {
    is_absent: true
  }), row('f', 150), row('g', 0, {
    analytics_result_state: 'exempt'
  })]);
  assert.equal(s.subjects[0].statistics.mean, 62.5);
  assert.equal(s.subjects[0].statistics.median, 75);
  assert.equal(s.subjects[0].highest_tied_n, 2);
  assert.equal(s.subjects[0].pass.percentage, 75);
  assert.equal(s.summary.participation.denominator, 6);
  assert.equal(s.summary.participation.numerator, 4);
  assert.equal(s.summary.invalid_records, 1);
  assert.equal(insightsFor(s).find(i => i.rule_id === 'data-quality').evidence.count, 1);
  const unpublished = make([row('a', 90)], {
    exam: {
      ...exam,
      results_published: false
    }
  });
  assert.equal(unpublished.subjects[0].statistics.n, 0);
  assert.equal(unpublished.students[0].percentage, null);
  assert.equal(unpublished.summary.participation.numerator, 1);
});
test('single-exam totals use maxima weights, explicit school weights and completeness', () => {
  const rows = [row('a', 25, {
    max_marks: 25,
    passing_marks: 10
  }), row('a', 50, {
    subject_id: 'english',
    subject_name: 'English',
    mark_id: 'eng',
    max_marks: 100
  })];
  assert.equal(make(rows).students[0].percentage, 60);
  assert.equal(make(rows, {
    policy: {
      eligibility_confirmed: true,
      subject_weights: {
        math: 1,
        english: 3
      }
    }
  }).students[0].percentage, 62.5);
  assert.equal(make(rows, {
    policy: {
      eligibility_confirmed: false
    }
  }).students[0].percentage, null);
  assert.equal(make([rows[0], {
    ...rows[1],
    mark_id: null
  }]).students[0].percentage, null);
  const absent = make([rows[0], {
    ...rows[1],
    is_absent: true
  }]);
  assert.equal(absent.students[0].percentage, 20);
  assert.equal(absent.students[0].all_subjects_passed, false);
});
test('component score replaces stale cached total', () => {
  const r = row('a', 99, {
    assessment_schema: 'component',
    max_marks: 50,
    participation_marks: 5,
    written_work_marks: 5,
    project_work_marks: 5,
    slip_test_marks: 10
  });
  assert.equal(classifyResult(r).score, 25);
  assert.equal(make([r]).subjects[0].statistics.mean, 50);
});
test('matched growth normalizes 25/100, excludes entrants/leavers, suppresses incompatible', () => {
  const before = make([row('a', 10, {
    max_marks: 25,
    passing_marks: 10
  }), row('left', 20, {
    max_marks: 25,
    passing_marks: 10
  })]).subjects[0];
  const after = make([row('a', 60), row('new', 80)]).subjects[0],
    c = compareSubjects(after, before, {
      minimum_sample: 10
    });
  assert.equal(c.status, 'normalized_with_limitations');
  assert.equal(c.matched_n, 1);
  assert.equal(c.mean_delta_pp, 20);
  assert.equal(c.entrants, 1);
  assert.equal(c.leavers, 1);
  assert.equal(c.coverage_percentage, 50);
  assert.equal(c.low_sample, true);
  assert.equal(compareSubjects({
    ...after,
    class_id: 'grade6'
  }, before).mean_delta_pp, null);
});
test('ranks reuse competition/dense and suppress low samples/unsupported tiebreaks', () => {
  const rows = [row('a', 100), row('b', 100), row('c', 50)];
  assert.deepEqual(make(rows).students.map(s => s.rank), [1, 1, 3]);
  assert.deepEqual(make(rows, {
    rankingMethod: 'dense'
  }).students.map(s => s.rank), [1, 1, 2]);
  assert.equal(make(rows, {
    policy: {
      minimum_sample: 10,
      eligibility_confirmed: true
    }
  }).students[0].rank, null);
  assert.equal(make(rows, {
    rankingMethod: 'attendance_tiebreak'
  }).students[0].rank, null);
  assert.equal(make(rows).students[0].percentile, 75);
});
test('grade ambiguity and CSV formula/Unicode protection', () => {
  const bands = [{
    grade: 'Pass',
    min_percentage: 40,
    max_percentage: 100
  }];
  assert.equal(gradeFor(100, bands), 'Pass');
  assert.equal(gradeFor(0, bands), null);
  assert.equal(gradeFor(60, [...bands, {
    grade: 'Other',
    min_percentage: 50,
    max_percentage: 70
  }]), null);
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell(' \t+cmd'), '"\' \t+cmd"');
  assert.equal(csvCell('తెలుగు'), '"తెలుగు"');
  assert.equal(csvCell(-10), '"-10"');
  assert.equal(csvCell('-10'), '"\'-10"');
});
test('test workers cannot implicitly use a remote school database', async () => {
  const {
    assertIsolatedTestDatabase
  } = await import('../utils/testDatabaseGuard.js');
  assert.throws(() => assertIsolatedTestDatabase('postgres://example.com/school', {
    NODE_TEST_CONTEXT: 'child'
  }), /dedicated local/);
  assert.throws(() => assertIsolatedTestDatabase('postgres://localhost/school', {
    NODE_TEST_CONTEXT: 'child'
  }), /dedicated local/);
  assert.doesNotThrow(() => assertIsolatedTestDatabase('postgres://127.0.0.1/school_exam_test', {
    NODE_TEST_CONTEXT: 'child'
  }));
  assert.doesNotThrow(() => assertIsolatedTestDatabase('postgres://example.com/school', {}));
});
test('borderline evidence uses actual pass marks and configured next-grade boundaries', () => {
  const snapshot = make([row('a', 39)], {
    grades: [{
      grade: 'Support',
      min_percentage: 0,
      max_percentage: 40
    }, {
      grade: 'Pass',
      min_percentage: 40,
      max_percentage: 80
    }, {
      grade: 'Distinction',
      min_percentage: 80,
      max_percentage: 100
    }]
  });
  const record = snapshot.students[0].subjects[0];
  assert.equal(record.pass_margin_marks, -1);
  assert.equal(record.next_grade, 'Pass');
  assert.equal(record.next_grade_gap_pp, 1);
  assert.equal(record.next_grade_gap_marks, 1);
  assert.equal(classifyResult(row('duplicate', 80, {
    duplicate_identity: true
  })).state, 'invalid');
});
test('revision and identical-mark signals remain neutral and require recorded evidence', () => {
  const data = make(Array.from({
    length: 12
  }, (_, i) => row(String(i), 60, {
    mark_updated_at: '2026-11-10T12:00:00Z'
  })), {
    exam: {
      ...exam,
      results_published_at: '2026-11-09T12:00:00Z'
    }
  });
  const signals = insightsFor(data);
  assert.ok(signals.some(i => i.rule_id === 'post-publication-revision'));
  assert.ok(signals.some(i => i.rule_id.startsWith('identical-marks:')));
  assert.ok(signals.find(i => i.rule_id.startsWith('identical-marks:')).evidence.interpretation.includes('legitimate'));
});
test('analytics HTTP/denied-access logs omit private search terms and selected student IDs', async () => {
  const {
    redactAnalyticsUrl
  } = await import('../utils/analyticsPrivacy.js');
  assert.equal(redactAnalyticsUrl('/api/v1/results/exam-intelligence/search?search=PrivateName&student_id=secret'), '/api/v1/results/exam-intelligence/search');
  assert.equal(redactAnalyticsUrl('/api/v1/results/exam-analytics?student_id=secret'), '/api/v1/results/exam-analytics');
  assert.equal(redactAnalyticsUrl('/api/v1/health?school_id=1'), '/api/v1/health?school_id=1');
});


test('medical absence stays incomplete when no explicit medical grading policy exists',()=>{
 const snapshot=make([row('medical',0,{analytics_result_state:'medical_absence'})]);
 assert.equal(snapshot.students[0].percentage,null);
 assert.equal(snapshot.students[0].all_subjects_passed,null);
 assert.equal(snapshot.summary.states.medical_absence,1);
 assert.equal(snapshot.summary.participation.numerator,0);
 assert.equal(snapshot.summary.entry_completion.numerator,1);
});

test('roster composition stays distinct from changes in valid result availability', () => {
  const before = make([row('returning', null, { is_absent: true }), row('missing', 80)]).subjects[0];
  const after = make([row('returning', 60), row('missing', null)]).subjects[0];
  const result = compareSubjects(after, before);
  assert.equal(result.entrants, 0);
  assert.equal(result.leavers, 0);
  assert.equal(result.new_valid_results, 1);
  assert.equal(result.lost_valid_results, 1);
  assert.equal(result.matched_n, 0);
});
test('reverse, same-date and undated comparisons never claim temporal improvement', () => {
  const baseline = { ...make([row('a', 40)]).subjects[0], assessment_date: '2026-07-01' };
  const current = { ...make([row('a', 60)]).subjects[0], assessment_date: '2026-09-01' };
  assert.equal(compareSubjects(current, baseline).improving_n, 1);
  assert.equal(compareSubjects(current, baseline).chronology, 'forward');
  assert.equal(compareSubjects(current, baseline).current_raw_statistics.mean, 60);
  for (const date of ['2026-07-01', '2026-06-01', undefined]) {
    const result = compareSubjects({ ...current, assessment_date: date }, baseline);
    assert.equal(result.mean_delta_pp, 20);
    assert.equal(result.improving_n, null);
    assert.equal(result.declining_n, null);
    const snapshot = make([row('a', 60)]);
    assert.equal(insightsFor(snapshot, [{ key: current.key, subject_name: 'Math', comparison: { ...result, mean_delta_pp: -30, low_sample: false } }]).some(i => i.rule_id.startsWith('matched-decline')), false);
  }
});
