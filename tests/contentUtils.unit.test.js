import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNextRunAt } from '../services/content/contentSchedulerService.js';
import { isSafeHttpUrl, sanitizeRichText, normalizeTargetId } from '../services/content/contentUtils.js';
import { isValidTransition, CONTENT_STATUSES } from '../services/content/contentWorkflowService.js';

test('content utils reject javascript URLs and strip script tags', () => {
  assert.equal(isSafeHttpUrl('https://www.isro.gov.in'), true);
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(sanitizeRichText('<script>alert(1)</script>Hello'), 'Hello');
  assert.equal(normalizeTargetId('SCHOOL', 'ALL'), 'all');
});

test('staff cannot skip from draft to published in the public transition table', () => {
  assert.equal(isValidTransition(CONTENT_STATUSES.DRAFT, CONTENT_STATUSES.SUBMITTED), true);
  assert.equal(isValidTransition(CONTENT_STATUSES.SUBMITTED, CONTENT_STATUSES.PUBLISHED), false);
  assert.equal(isValidTransition(CONTENT_STATUSES.APPROVED, CONTENT_STATUSES.PUBLISHED), true);
  assert.equal(isValidTransition(CONTENT_STATUSES.PUBLISHED, CONTENT_STATUSES.APPROVED), true);
});

test('recurring weekday schedules compute a future next_run_at', () => {
  const from = new Date('2026-09-14T02:00:00.000Z');
  const next = computeNextRunAt({
    recurrenceType: 'WEEKDAYS',
    timeOfDay: '08:00',
    timezone: 'Asia/Kolkata',
    fromDate: from,
  });
  assert.ok(next instanceof Date);
  assert.ok(next.getTime() > from.getTime());
});
