import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getStudentTransportDue,
  transportDueToStudentFee,
} from '../services/transportFeeService.js';

function transportDueDb({ baseFee, adjustmentTotal, addedAmount, waivedAmount, paidAmount }) {
  return async (strings) => {
    const query = strings.join(' ');

    if (query.includes('FROM student_transport st')) {
      return [{
        assignment_id: 'assignment-1',
        route_id: 'route-1',
        stop_id: 'stop-1',
        route_name: 'Route A',
        stop_name: 'Village A',
        transport_fee_id: 'transport-fee-1',
        fee_amount: String(baseFee),
        billing_cycle: 'term',
        adjustment_total: String(adjustmentTotal),
        added_amount: String(addedAmount),
        waived_amount: String(waivedAmount),
        adjustment_count: Number(addedAmount > 0) + Number(waivedAmount > 0),
        academic_year: '2026-27',
      }];
    }

    if (query.includes('FROM transport_fee_payments')) {
      return [{ paid_total: String(paidAmount) }];
    }

    throw new Error(`Unexpected query: ${query}`);
  };
}

test('transport waiver reduces the student-specific due without changing the base stop fee', async () => {
  const due = await getStudentTransportDue(
    'student-1',
    '2026-27',
    12,
    transportDueDb({
      baseFee: 1000,
      adjustmentTotal: -150,
      addedAmount: 0,
      waivedAmount: 150,
      paidAmount: 300,
    }),
  );

  assert.equal(due.base_fee_amount, 1000);
  assert.equal(due.fee_amount, 850);
  assert.equal(due.balance_due, 550);
  assert.equal(due.waived_amount, 150);
});

test('transport debit increases the adjusted due and remaining balance', async () => {
  const due = await getStudentTransportDue(
    'student-2',
    '2026-27',
    12,
    transportDueDb({
      baseFee: 1000,
      adjustmentTotal: 200,
      addedAmount: 200,
      waivedAmount: 0,
      paidAmount: 300,
    }),
  );

  assert.equal(due.base_fee_amount, 1000);
  assert.equal(due.fee_amount, 1200);
  assert.equal(due.balance_due, 900);
  assert.equal(due.added_amount, 200);
});

test('fully paid transport due remains visible as a paid student fee row', () => {
  const fee = transportDueToStudentFee({
    transport_fee_id: 'transport-fee-1',
    fee_amount: 1200,
    paid_amount: 1200,
    balance_due: 0,
    due_date: '2027-03-31',
    academic_year: '2026-27',
    fee_not_set: false,
  }, 'student-1');

  assert.equal(fee.id, 'transport-fee-1');
  assert.equal(fee.fee_type, 'Transport Fee');
  assert.equal(fee.status, 'paid');
  assert.equal(fee.amount_paid, 1200);
  assert.equal(fee.is_transport, true);
});

test('transport fee without a configured stop fee is not added to the ledger', () => {
  const fee = transportDueToStudentFee({
    transport_fee_id: null,
    fee_amount: null,
    paid_amount: 0,
    balance_due: null,
    fee_not_set: true,
  }, 'student-2');

  assert.equal(fee, null);
});
