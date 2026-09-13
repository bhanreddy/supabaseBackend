import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapLegacyEventType,
  normalizeEventConfiguration,
  splitDateTime,
  isModuleEnabled,
  nextApprovalStage,
  mapBoardingStatus,
  pickField,
} from '../services/eventModuleUtils.js';

test('mapLegacyEventType keeps enum values and maps wizard ids', () => {
  assert.equal(mapLegacyEventType('sports'), 'sports');
  assert.equal(mapLegacyEventType('TRIP'), 'other');
  assert.equal(mapLegacyEventType('CELEBRATION'), 'cultural');
  assert.equal(mapLegacyEventType('unknown-kind'), 'other');
});

test('normalizeEventConfiguration aliases ticketing and budget module keys', () => {
  const cfg = normalizeEventConfiguration({
    config: {
      modules: { ticketing: true, budget: true, competitions: true, consent: true },
      constraints: { max_capacity: 200, fee_amount: 150 },
    },
  });
  assert.equal(cfg.modules.qr_passes, true);
  assert.equal(cfg.modules.ticketing, true);
  assert.equal(cfg.modules.expenses, true);
  assert.equal(cfg.modules.competition, true);
  assert.equal(cfg.constraints.capacity_limit, 200);
  assert.equal(cfg.constraints.fee_amount, 150);
  assert.equal(cfg.modules.payments, true);
  assert.equal(isModuleEnabled(cfg, 'ticketing'), true);
});

test('splitDateTime extracts date columns from wizard payloads', () => {
  assert.deepEqual(splitDateTime('2026-10-10 09:00:00').date, '2026-10-10');
  assert.equal(splitDateTime('2026-10-10 09:00:00').time, '09:00:00');
  assert.equal(splitDateTime('2026-10-10T17:30:00Z').time, '17:30:00');
});

test('approval flow advances until the last required stage', () => {
  const flow = ['PRINCIPAL', 'MANAGEMENT', 'ACCOUNTS'];
  assert.equal(nextApprovalStage(flow, 'PRINCIPAL'), 'MANAGEMENT');
  assert.equal(nextApprovalStage(flow, 'ACCOUNTS'), null);
});

test('boarding status aliases map onto schema values', () => {
  assert.equal(mapBoardingStatus('NOT_BOARDED'), 'PENDING');
  assert.equal(mapBoardingStatus('DROPPED'), 'RETURNED');
  assert.equal(mapBoardingStatus('ON_BUS'), 'ON_BUS');
});

test('pickField accepts camelCase and snake_case', () => {
  assert.equal(pickField({ studentId: 'abc' }, 'student_id', 'studentId'), 'abc');
});
