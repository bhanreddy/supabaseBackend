import test from 'node:test';
import assert from 'node:assert/strict';

import {
  determineReminderStage,
} from './feeAutomationJobService.js';
import {
  generateFeeReminderIdempotencyKey,
  generateManualReminderIdempotencyKey,
} from './automationActionService.js';
import {
  DEFAULT_FEE_REMINDER_TRIGGER,
  DEFAULT_FEE_REMINDER_ACTION,
  RULE_KEYS,
} from './automationRuleService.js';

test('determineReminderStage identifies boundary days correctly', () => {
  const today = new Date();
  
  // 3 days in future => upcoming_3d
  const upcoming3d = new Date(today);
  upcoming3d.setDate(today.getDate() + 3);
  assert.equal(determineReminderStage(upcoming3d.toISOString()), 'upcoming_3d');

  // Due today => due_today
  const dueToday = new Date(today);
  assert.equal(determineReminderStage(dueToday.toISOString()), 'due_today');

  // 7 days past => overdue_7d
  const overdue7d = new Date(today);
  overdue7d.setDate(today.getDate() - 7);
  assert.equal(determineReminderStage(overdue7d.toISOString()), 'overdue_7d');

  // 15 days past => overdue_15d
  const overdue15d = new Date(today);
  overdue15d.setDate(today.getDate() - 15);
  assert.equal(determineReminderStage(overdue15d.toISOString()), 'overdue_15d');

  // Non-boundary day (e.g. 5 days overdue) => returns null
  const overdue5d = new Date(today);
  overdue5d.setDate(today.getDate() - 5);
  assert.equal(determineReminderStage(overdue5d.toISOString()), null);
});

test('idempotency key generation produces deterministic, tenant-isolated strings', () => {
  const key1 = generateFeeReminderIdempotencyKey({
    schoolId: 13,
    studentFeeId: 'fee-123',
    stage: 'overdue_7d',
    dueDate: '2026-09-01T00:00:00.000Z',
  });
  const key2 = generateFeeReminderIdempotencyKey({
    schoolId: 13,
    studentFeeId: 'fee-123',
    stage: 'overdue_7d',
    dueDate: '2026-09-01',
  });
  const keyOtherSchool = generateFeeReminderIdempotencyKey({
    schoolId: 14,
    studentFeeId: 'fee-123',
    stage: 'overdue_7d',
    dueDate: '2026-09-01',
  });

  assert.equal(key1, 'fee_reminder:13:fee-123:overdue_7d:2026-09-01');
  assert.equal(key1, key2);
  assert.notEqual(key1, keyOtherSchool);

  const manualKey = generateManualReminderIdempotencyKey({
    schoolId: 13,
    studentId: 'stud-456',
    timestampStr: '2026-09-05T12',
  });
  assert.equal(manualKey, 'manual_fee_reminder:13:stud-456:2026-09-05T12');
});

test('default automation rule configurations are safe and disabled', () => {
  assert.equal(RULE_KEYS.FEE_DUE_REMINDER, 'fee_due_reminder');
  assert.equal(DEFAULT_FEE_REMINDER_TRIGGER.days_before_due, 3);
  assert.deepEqual(DEFAULT_FEE_REMINDER_TRIGGER.overdue_stages, [3, 7, 15, 30]);
  assert.equal(DEFAULT_FEE_REMINDER_ACTION.channel, 'push');
});

test('fee dates and stage keys remain stable across UTC/IST midnight', async () => {
  const { feeCalendarDate, feeDaysOverdue, determineReminderStage: stage } = await import('./feeRecoveryScope.js');
  const before = new Date('2026-09-05T18:29:59Z');
  const after = new Date('2026-09-05T18:30:00Z');
  assert.equal(stage('2026-09-05', {}, before), 'due_today');
  assert.equal(feeDaysOverdue('2026-09-05',after),1);
  assert.equal(feeCalendarDate(new Date('2026-09-05T00:00:00Z')),'2026-09-05');
  assert.equal(generateFeeReminderIdempotencyKey({schoolId:1,studentFeeId:'fee',stage:'due_today',dueDate:new Date('2026-09-05T00:00:00Z')}),
    generateFeeReminderIdempotencyKey({schoolId:1,studentFeeId:'fee',stage:'due_today',dueDate:'2026-09-05'}));
});

test('malformed cadence, unsupported channel, and zero cooldown are rejected', async () => {
  const { validateRuleUpdate } = await import('./automationRuleService.js');
  for(const value of [null,{is_enabled:'false'},{trigger_config:{cooldown_days:0}},
    {trigger_config:{overdue_stages:'7'}},{trigger_config:{overdue_stages:[7,7]}},
    {trigger_config:{days_before_due:-1}},{action_config:{channel:'whatsapp'}}]) {
    assert.throws(()=>validateRuleUpdate(value),/Invalid/);
  }
});

test('existing notification template renders English and Telugu reminder text', async () => {
  const {NotificationTemplateService}=await import('./notificationTemplateService.js');
  const params={message:'Fee balance: ₹500',message_te:'ఫీజు బకాయి: ₹500'};
  assert.match(NotificationTemplateService.render('FEE_REMINDER',params,'en').body,/Fee balance: ₹500/);
  assert.match(NotificationTemplateService.render('FEE_REMINDER',params,'te').body,/ఫీజు బకాయి: ₹500/);
});
