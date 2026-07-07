import assert from 'node:assert/strict';
import { normalizeOptionalString } from './normalizeOptionalString.js';

const cases = [
  { input: 'Null', expected: null, label: 'capital Null junk literal' },
  { input: 'null', expected: null, label: 'lowercase null junk literal' },
  { input: '  ', expected: null, label: 'whitespace-only' },
  { input: '', expected: null, label: 'empty string' },
  { input: 'undefined', expected: null, label: 'undefined junk literal' },
  { input: 'None', expected: null, label: 'None junk literal' },
  { input: 'Reddy', expected: 'Reddy', label: 'real surname preserved' },
  { input: null, expected: null, label: 'null input' },
  { input: undefined, expected: null, label: 'undefined input' },
  { input: '  Reddy  ', expected: 'Reddy', label: 'trimmed real surname' },
];

let failed = 0;

for (const { input, expected, label } of cases) {
  const actual = normalizeOptionalString(input);
  try {
    assert.equal(actual, expected);
    console.log(`PASS: ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

if (failed > 0) {
  process.exitCode = 1;
  console.error(`\n${failed} test(s) failed`);
} else {
  console.log(`\nAll ${cases.length} normalizeOptionalString tests passed`);
}
