import assert from 'node:assert/strict';
import test from 'node:test';

import { generateReceiptNo } from './receiptNumberService.js';

test('allocates receipt numbers through the school-scoped database function', async () => {
  let capturedStrings;
  let capturedValues;
  const tx = async (strings, ...values) => {
    capturedStrings = strings;
    capturedValues = values;
    return [{ receipt_no: 'RCT-20260731-0235' }];
  };

  const result = await generateReceiptNo(tx, 17);

  assert.equal(result, 'RCT-20260731-0235');
  assert.match(capturedStrings.join('?'), /public\.get_next_receipt_no\(\?\)/);
  assert.deepEqual(capturedValues, [17]);
});

test('fails closed when the database does not return a receipt number', async () => {
  const tx = async () => [];

  await assert.rejects(
    generateReceiptNo(tx, 17),
    /Failed to allocate a receipt number/,
  );
});
