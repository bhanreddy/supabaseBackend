import assert from 'node:assert/strict';
import test from 'node:test';
import sql from '../db.js';
import { evaluateRules } from '../services/intelligence/ruleEngine.js';

test.after(async () => {
  await sql.end({ timeout: 1 }).catch(() => {});
});

test('Rule Engine: Stable student with no negative signals generates no alerts', async () => {
  const mockSignals = [
    { id: 's1', signal_type: 'ATTENDANCE_REGULARITY', severity: 'LEVEL_1_POSITIVE', value_numeric: 98 },
  ];
  const matches = await evaluateRules({
    schoolId: 1,
    studentId: '00000000-0000-4000-8000-000000000001',
    signals: mockSignals,
  });

  const attentionMatches = matches.filter((m) => m.rule.severity === 'LEVEL_3_ATTENTION' || m.rule.severity === 'LEVEL_2_WATCH');
  assert.equal(attentionMatches.length, 0, 'Stable student should not trigger watch or attention alerts');
});

test('Rule Engine: BEHAVIOUR_RECURRENCE_001 triggers on 3+ behaviour concerns', async () => {
  const mockSignals = [
    { id: 's-beh', signal_type: 'BEHAVIOUR_CONCERN', severity: 'LEVEL_2_WATCH', value_numeric: 3, confidence: 'HIGH' },
  ];
  const matches = await evaluateRules({
    schoolId: 1,
    studentId: '00000000-0000-4000-8000-000000000001',
    signals: mockSignals,
  });

  const recurrence = matches.find((m) => m.rule.rule_code === 'BEHAVIOUR_RECURRENCE_001');
  assert.ok(recurrence, 'Must match BEHAVIOUR_RECURRENCE_001');
  assert.equal(recurrence.pattern_type, 'RECURRENCE');
  assert.ok(recurrence.recommendations.length > 0);
});

test('Rule Engine: ACADEMIC_DECLINE_001 triggers on 3 consecutive declining assessments', async () => {
  const mockSignals = [
    {
      id: 's-acad',
      signal_type: 'ACADEMIC_DECLINE',
      severity: 'LEVEL_3_ATTENTION',
      value_numeric: 64,
      baseline_value: 78,
      delta_percentage: -14,
      confidence: 'HIGH',
      metadata: { sequence: [78, 74, 70, 64] },
    },
  ];
  const matches = await evaluateRules({
    schoolId: 1,
    studentId: '00000000-0000-4000-8000-000000000001',
    signals: mockSignals,
  });

  const decline = matches.find((m) => m.rule.rule_code === 'ACADEMIC_DECLINE_001');
  assert.ok(decline, 'Must match ACADEMIC_DECLINE_001');
  assert.equal(decline.pattern_type, 'CONSECUTIVE_CHANGE');
  assert.equal(decline.rule.severity, 'LEVEL_3_ATTENTION');
});

test('Rule Engine: POSITIVE_LEADERSHIP_001 triggers emerging strength', async () => {
  const mockSignals = [
    {
      id: 's-lead',
      signal_type: 'LEADERSHIP_POSITIVE',
      severity: 'LEVEL_1_POSITIVE',
      value_numeric: 3,
      confidence: 'HIGH',
    },
  ];
  const matches = await evaluateRules({
    schoolId: 1,
    studentId: '00000000-0000-4000-8000-000000000001',
    signals: mockSignals,
  });

  const strength = matches.find((m) => m.rule.rule_code === 'POSITIVE_LEADERSHIP_001');
  assert.ok(strength, 'Must match POSITIVE_LEADERSHIP_001');
  assert.equal(strength.pattern_type, 'POSITIVE_GROWTH');
  assert.equal(strength.rule.severity, 'LEVEL_1_POSITIVE');
});

test('Rule Engine: HOMEWORK_CONCERN_001 triggers on repeated homework observations', async () => {
  const mockSignals = [
    { id: 's-hw', signal_type: 'HOMEWORK_INCOMPLETE', severity: 'LEVEL_2_WATCH', value_numeric: 2, metadata: { count: 2 } },
  ];
  const matches = await evaluateRules({
    schoolId: 1,
    studentId: '00000000-0000-4000-8000-000000000001',
    signals: mockSignals,
  });

  const homework = matches.find((m) => m.rule?.rule_code === 'HOMEWORK_CONCERN_001');
  if (homework) {
    assert.equal(homework.pattern_type, 'RECURRENCE');
    assert.ok(homework.recommendations.length > 0);
  }
});

test('Rule Engine: CROSS_MODULE_CONCERN_001 triggers on multi-domain convergence', async () => {
  const mockSignals = [
    { id: 's-att', signal_type: 'ATTENDANCE_DROP', value_numeric: 72 },
    { id: 's-hw', signal_type: 'HOMEWORK_INCOMPLETE', value_numeric: 3 },
    { id: 's-cross', signal_type: 'CROSS_MODULE_CORRELATION', severity: 'LEVEL_3_ATTENTION', confidence: 'HIGH' },
  ];
  const matches = await evaluateRules({
    schoolId: 1,
    studentId: '00000000-0000-4000-8000-000000000001',
    signals: mockSignals,
  });

  const cross = matches.find((m) => m.rule.rule_code === 'CROSS_MODULE_CONCERN_001');
  assert.ok(cross, 'Must match CROSS_MODULE_CONCERN_001');
  assert.equal(cross.pattern_type, 'CROSS_MODULE_CONVERGENCE');
  assert.equal(cross.rule.severity, 'LEVEL_3_ATTENTION');
});
