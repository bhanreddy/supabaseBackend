import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryOverdueFine, assertLibraryRenewable, libraryBookSchema, librarySettingsSchema, libraryPaymentSchema } from './libraryRules.js';
import { hasStudentLoginQrRole } from './studentLoginQr.js';
import { canIssueRoleLoginQr, primaryRoleLoginQrCode } from './roleLoginQr.js';

test('overdue fines use school calendar days and exact currency rounding', () => {
  assert.equal(libraryOverdueFine('2026-11-04', '2026-11-04', 5), 0);
  assert.equal(libraryOverdueFine('2026-11-05', '2026-11-04', 5), 0);
  assert.equal(libraryOverdueFine('2026-10-31', '2026-11-04', '2.35'), 9.4);
  assert.equal(libraryOverdueFine('2026-11-01', '2026-11-04', 0.1), 0.3);
});
test('renewals reject returned, overdue, capped, and reserved loans', () => {
  const loan = { due_date: '2026-11-05', returned_at: null, renewal_count: 0 };
  const policy = { max_renewals: 2 };
  assert.equal(assertLibraryRenewable(loan, policy, '2026-11-04', false), null);
  assert.ok(assertLibraryRenewable({ ...loan, returned_at: '2026-11-03' }, policy, '2026-11-04', false));
  assert.ok(assertLibraryRenewable({ ...loan, due_date: '2026-11-03' }, policy, '2026-11-04', false));
  assert.ok(assertLibraryRenewable({ ...loan, renewal_count: 2 }, policy, '2026-11-04', false));
  assert.ok(assertLibraryRenewable(loan, policy, '2026-11-04', true));
});
test('library validation rejects blank titles, invalid policy and fractional-paisa payments', () => {
  assert.equal(libraryBookSchema.safeParse({ title: '  ', author: 'Author' }).success, false);
  assert.equal(libraryBookSchema.parse({ title: ' Book ', author: ' Author ' }).title, 'Book');
  const policy = { loan_days: 14, max_loans: 3, max_renewals: 2, fine_per_day: 0.5 };
  assert.equal(librarySettingsSchema.safeParse(policy).success, true);
  for (const change of [{ loan_days: 0 }, { loan_days: 1.5 }, { max_loans: 0 }, { max_renewals: -1 }, { fine_per_day: -1 }]) {
    assert.equal(librarySettingsSchema.safeParse({ ...policy, ...change }).success, false);
  }
  for (const amount of [0, -1, 1.001, Infinity, NaN]) assert.equal(libraryPaymentSchema.safeParse({ amount }).success, false);
});
test('librarians manage student QR cards and only equal or lower role QR cards', () => {
  assert.equal(hasStudentLoginQrRole(['librarian']), true);
  assert.equal(primaryRoleLoginQrCode(['librarian']), 'librarian');
  for (const role of ['librarian', 'staff', 'teacher', 'driver', 'gate_keeper', 'parent']) assert.equal(canIssueRoleLoginQr(['librarian'], [role]), true);
  for (const role of ['accounts', 'principal', 'admin']) assert.equal(canIssueRoleLoginQr(['librarian'], [role]), false);
  assert.equal(canIssueRoleLoginQr(['librarian'], ['teacher', 'admin']), false);
  assert.equal(canIssueRoleLoginQr(['accounts'], ['librarian']), true);
});
