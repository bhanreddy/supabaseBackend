import test from 'node:test';
import assert from 'node:assert/strict';
import { postTermFeePayment } from '../services/feePaymentService.js';

function queryText(strings) {
  return strings.join(' ? ').replace(/\s+/g, ' ').trim();
}

test('fee transaction deduplication scopes the reference to the active school', async () => {
  const queries = [];
  const tx = async (strings, ...values) => {
    const text = queryText(strings);
    queries.push({ text, values });
    if (text.includes('FROM fee_transactions')) return [];
    if (text.includes('FROM student_fees')) {
      return [{ id: 'fee-1', amount_due: 1000, amount_paid: 0, discount: 0, student_id: 'student-1' }];
    }
    if (text.includes('INSERT INTO fee_transactions')) return [{ id: 'transaction-1' }];
    if (text.includes('UPDATE student_fees')) return [{ id: 'fee-1' }];
    return [];
  };

  const result = await postTermFeePayment(tx, {
    student_fee_id: 'fee-1',
    amount: 100,
    payment_method: 'upi',
    transaction_ref: 'SHARED-UPI-REF',
    user: { internal_id: 'user-1' },
    schoolId: 42,
  });

  assert.equal(result.transaction.id, 'transaction-1');
  assert.match(queries[0].text, /WHERE school_id = \? AND transaction_ref = \?/);
  assert.deepEqual(queries[0].values, [42, 'SHARED-UPI-REF']);
});

test('duplicate reference in the same school remains a conflict', async () => {
  const tx = async () => [{ id: 'existing-transaction' }];
  await assert.rejects(
    () => postTermFeePayment(tx, {
      student_fee_id: 'fee-1',
      amount: 100,
      payment_method: 'upi',
      transaction_ref: 'DUPLICATE',
      user: { internal_id: 'user-1' },
      schoolId: 42,
    }),
    (error) => error.status === 409,
  );
});
