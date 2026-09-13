import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateProgressMetrics,
  SYLLABUS_HEALTH,
} from '../services/syllabusService.js';

test('evaluateProgressMetrics flags incomplete planning when 0 topics exist', () => {
  const result = evaluateProgressMetrics({
    totalTopics: 0,
    completedTopics: 0,
    expectedDueTopics: 0,
    targetDatesConfigured: 0,
  });

  assert.equal(result.planning_incomplete, true);
  assert.equal(result.status, SYLLABUS_HEALTH.PLANNING_INCOMPLETE);
  assert.equal(result.status_label, 'Planning incomplete');
  assert.equal(result.expected_pct, null);
  assert.equal(result.variance_pct, null);
});

test('evaluateProgressMetrics flags incomplete planning when no target dates are set', () => {
  const result = evaluateProgressMetrics({
    totalTopics: 10,
    completedTopics: 3,
    expectedDueTopics: 0,
    targetDatesConfigured: 0,
  });

  assert.equal(result.planning_incomplete, true);
  assert.equal(result.status, SYLLABUS_HEALTH.PLANNING_INCOMPLETE);
});

test('evaluateProgressMetrics calculates ON_TRACK status accurately', () => {
  // 10 topics total, 7 completed, 7 expected by today -> 70% actual, 70% expected, variance 0%
  const result = evaluateProgressMetrics({
    totalTopics: 10,
    completedTopics: 7,
    expectedDueTopics: 7,
    targetDatesConfigured: 10,
  });

  assert.equal(result.planning_incomplete, false);
  assert.equal(result.actual_pct, 70);
  assert.equal(result.expected_pct, 70);
  assert.equal(result.variance_pct, 0);
  assert.equal(result.status, SYLLABUS_HEALTH.ON_TRACK);
  assert.equal(result.topics_behind, 0);
  assert.equal(result.delay_days, null);
});

test('evaluateProgressMetrics calculates AT_RISK status when variance is between -5% and -15%', () => {
  // 20 topics total, 12 completed (60%), 14 expected (70%) -> variance -10%
  const result = evaluateProgressMetrics({
    totalTopics: 20,
    completedTopics: 12,
    expectedDueTopics: 14,
    targetDatesConfigured: 20,
  });

  assert.equal(result.planning_incomplete, false);
  assert.equal(result.actual_pct, 60);
  assert.equal(result.expected_pct, 70);
  assert.equal(result.variance_pct, -10);
  assert.equal(result.status, SYLLABUS_HEALTH.AT_RISK);
  assert.equal(result.topics_behind, 2);
  assert.equal(result.delay_days, null);
});

test('evaluateProgressMetrics calculates DELAYED status when variance < -15%', () => {
  // 20 topics total, 8 completed (40%), 14 expected (70%) -> variance -30%
  const result = evaluateProgressMetrics({
    totalTopics: 20,
    completedTopics: 8,
    expectedDueTopics: 14,
    targetDatesConfigured: 20,
  });

  assert.equal(result.planning_incomplete, false);
  assert.equal(result.actual_pct, 40);
  assert.equal(result.expected_pct, 70);
  assert.equal(result.variance_pct, -30);
  assert.equal(result.status, SYLLABUS_HEALTH.DELAYED);
  assert.equal(result.status_label, 'Delayed');
  assert.equal(result.topics_behind, 6);
  assert.equal(result.delay_days, null);
});
