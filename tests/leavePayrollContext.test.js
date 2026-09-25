import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMonthlyDecisionSummary,
  defaultPayrollTreatment,
  effectiveLeaveType,
} from '../services/leavePayrollContextService.js';

test('leave approval defaults preserve historical payroll behaviour', () => {
  assert.equal(defaultPayrollTreatment('casual'), 'PAID_CL');
  assert.equal(defaultPayrollTreatment('sick'), 'PAID_LEAVE');
  assert.equal(defaultPayrollTreatment('other'), 'UNPAID');
});

test('an explicit admin treatment is authoritative for payroll', () => {
  assert.equal(effectiveLeaveType({ type: 'other', payrollTreatment: 'PAID_CL' }), 'casual');
  assert.equal(effectiveLeaveType({ type: 'casual', payrollTreatment: 'UNPAID' }), 'unpaid');
  assert.equal(effectiveLeaveType({ type: 'sick', payrollTreatment: 'PAID_LEAVE' }), 'paid');
});

test('monthly preview explains existing CL and projected salary days', () => {
  assert.deepEqual(buildMonthlyDecisionSummary({
    year: 2026,
    month: 9,
    requestedPayrollDays: 2,
    clUsed: 0.5,
    clEntitlement: 1,
    entitlementReason: 'Monthly entitlement',
  }), {
    year: 2026,
    month: 9,
    month_key: '2026-09',
    requested_payroll_days: 2,
    cl_used_days: 0.5,
    cl_entitlement_days: 1,
    cl_remaining_days: 0.5,
    projected_paid_cl_days: 0.5,
    projected_unpaid_days: 1.5,
    unpaid_days_without_cl: 2,
    entitlement_reason: 'Monthly entitlement',
  });
});
