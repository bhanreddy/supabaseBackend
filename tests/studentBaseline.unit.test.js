import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateBaselineDeviation } from '../services/intelligence/studentBaselineService.js';

test('Baseline Deviation: Meaningful drop below personal baseline is correctly quantified', () => {
  // Student normally scores 80%, currently scores 58%
  const deviation = calculateBaselineDeviation(58, 80);
  assert.equal(deviation, -27.5, '58 vs 80 baseline must produce -27.5% deviation');
});

test('Baseline Deviation: Meaningful growth above personal baseline is correctly quantified', () => {
  // Student normally scores 60%, currently scores 75%
  const deviation = calculateBaselineDeviation(75, 60);
  assert.equal(deviation, 25.0, '75 vs 60 baseline must produce +25.0% deviation');
});

test('Baseline Deviation: Identical performance produces 0 deviation', () => {
  const deviation = calculateBaselineDeviation(85, 85);
  assert.equal(deviation, 0);
});

test('Baseline Deviation: Handles edge cases gracefully (zero or null baseline)', () => {
  assert.equal(calculateBaselineDeviation(50, 0), 0);
  assert.equal(calculateBaselineDeviation(50, null), 0);
});
