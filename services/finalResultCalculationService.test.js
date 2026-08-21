import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAnnualResult,
  calculateSummativeOne,
  calculateSummativeTwo,
  canonicalFinalSourceKey,
  weightedContribution,
} from './finalResultCalculationService.js';

const mark = (score, maximum) => ({ score, maximum, status: 'graded' });

test('normalizes a 44/50 formative score to 17.6 out of 20', () => {
  assert.equal(weightedContribution(mark(44, 50), 20), 17.6);
});

test('calculates Summative I from FA-1, FA-2 and SA-1', () => {
  const result = calculateSummativeOne({
    fa1: mark(41, 50),
    fa2: mark(44, 50),
    sa1: mark(47, 80),
  });
  assert.equal(result.formative_contribution, 17);
  assert.equal(result.exam_contribution, 47);
  assert.equal(result.total, 64);
  assert.equal(result.grade, 'C1');
});

test('calculates Summative II from FA-3, FA-4 and SA-2', () => {
  const result = calculateSummativeTwo({
    fa3: mark(43.5, 50),
    fa4: mark(41, 50),
    sa2: mark(48, 80),
  });
  assert.equal(result.formative_contribution, 16.9);
  assert.equal(result.exam_contribution, 48);
  assert.equal(result.total, 64.9);
});

test('calculates annual contribution from all four FAs and both SAs', () => {
  const result = calculateAnnualResult({
    fa1: mark(41, 50), fa2: mark(44, 50), fa3: mark(43.5, 50), fa4: mark(41, 50),
    sa1: mark(47, 80), sa2: mark(48, 80),
  });
  assert.equal(result.formative_contribution, 16.95);
  assert.equal(result.summative_contribution, 47.5);
  assert.equal(result.total, 64.45);
});

test('missing inputs propagate instead of silently becoming zero', () => {
  const result = calculateAnnualResult({
    fa1: mark(41, 50), fa2: mark(44, 50), fa3: null, fa4: mark(41, 50),
    sa1: mark(47, 80), sa2: mark(48, 80),
  });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.total, null);
  assert.deepEqual(result.missing_sources, ['FA-3']);
});

test('absent assessments contribute zero but remain complete', () => {
  assert.equal(weightedContribution({ status: 'absent' }, 20), 0);
});

test('recognizes numeric and roman formative/summative names', () => {
  assert.equal(canonicalFinalSourceKey('fa_results', 'FA-3'), 'fa3');
  assert.equal(canonicalFinalSourceKey('fa_results', 'FA 2026 - 3'), 'fa3');
  assert.equal(canonicalFinalSourceKey('fa_results', 'Formative - IV'), 'fa4');
  assert.equal(canonicalFinalSourceKey('sa_results', 'Summative II'), 'sa2');
});
