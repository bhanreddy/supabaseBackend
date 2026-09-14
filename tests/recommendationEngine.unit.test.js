import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRecommendations, recommendationsForRule } from '../services/intelligence/recommendationEngine.js';

test('Recommendations are suggestions, never automatic discipline', () => {
  const recs = recommendationsForRule('BEHAVIOUR_RECURRENCE_001');
  assert.ok(recs.length > 0);
  assert.equal(recs.some((item) => /punish|suspend|expel|detention/i.test(item)), false);
});

test('Cross-module recommendations avoid causal language', () => {
  const recs = buildRecommendations({
    rule: { rule_code: 'CROSS_MODULE_CONCERN_001' },
    signals: [{ source_module: 'ATTENDANCE' }, { source_module: 'EXAMS' }],
  });
  assert.ok(recs.length > 0);
  assert.equal(recs.some((item) => /caused|because of/i.test(item)), false);
});

test('Unknown rules fall back to teacher review', () => {
  const recs = recommendationsForRule('UNKNOWN_RULE');
  assert.ok(recs.includes('Teacher review'));
});
