import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHealth, allocateTopicsToSlots } from '../services/academicPlannerMath.js';

test('classifyHealth uses weighted variance thresholds from the product spec', () => {
  assert.equal(classifyHealth(2, 76), 'ON_TRACK');
  assert.equal(classifyHealth(8, 84), 'AHEAD');
  assert.equal(classifyHealth(-7, 69), 'SLIGHT_DELAY');
  assert.equal(classifyHealth(-18, 58), 'AT_RISK');
  assert.equal(classifyHealth(-30, 40), 'CRITICAL');
  assert.equal(classifyHealth(0, 100), 'COMPLETED');
});

test('allocateTopicsToSlots uses estimated periods as weight, not chapter count', () => {
  const topics = [
    { id: 't1', title: 'Integers', chapter_id: 'c1', estimated_periods: 2, sequence: 1 },
    { id: 't2', title: 'Fractions', chapter_id: 'c1', estimated_periods: 5, sequence: 2, is_optional: true },
  ];
  const slots = [
    { date: '2026-06-15' },
    { date: '2026-06-16' },
    { date: '2026-06-17' },
    { date: '2026-06-18' },
    { date: '2026-06-19' },
    { date: '2026-06-22' },
    { date: '2026-06-23' },
  ];
  const { scheduledItems, totalEstimatedPeriods, consumedSlots } =
    allocateTopicsToSlots(topics, slots, '2026-06-15');

  assert.equal(totalEstimatedPeriods, 7);
  assert.equal(consumedSlots, 7);
  assert.equal(scheduledItems[0].planned_start_date, '2026-06-15');
  assert.equal(scheduledItems[0].planned_end_date, '2026-06-16');
  assert.equal(scheduledItems[0].planned_periods, 2);
  assert.equal(scheduledItems[1].planned_start_date, '2026-06-17');
  assert.equal(scheduledItems[1].planned_end_date, '2026-06-23');
  assert.equal(scheduledItems[1].priority, 'LOW');
});
