import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canIssueRoleLoginQr,
  highestRoleRank,
  labelForRoleLoginQr,
  primaryRoleLoginQrCode,
  ROLE_LOGIN_QR_SUBJECT_CODES,
  roleLoginQrRankSql,
} from './roleLoginQr.js';

test('role login QR rank lets an issuer print equal or lower roles only', () => {
  assert.equal(canIssueRoleLoginQr(['admin'], ['admin']), true);
  assert.equal(canIssueRoleLoginQr(['admin'], ['principal', 'staff']), true);
  assert.equal(canIssueRoleLoginQr(['accounts'], ['staff', 'teacher']), true);
  assert.equal(canIssueRoleLoginQr(['accounts'], ['driver', 'gate_keeper', 'parent']), true);
  assert.equal(canIssueRoleLoginQr(['accounts'], ['accounts']), true);
  assert.equal(canIssueRoleLoginQr(['accountant'], ['teacher']), true);
  assert.equal(canIssueRoleLoginQr(['principal'], ['principal']), true);
  assert.equal(canIssueRoleLoginQr(['principal'], ['management']), true);
  assert.equal(canIssueRoleLoginQr(['accounts'], ['admin']), false);
  assert.equal(canIssueRoleLoginQr(['accounts'], ['principal']), false);
  assert.equal(canIssueRoleLoginQr(['principal'], ['admin']), false);
  assert.equal(canIssueRoleLoginQr(['staff'], ['teacher']), true);
  assert.equal(canIssueRoleLoginQr(['teacher'], ['principal']), false);
  assert.equal(canIssueRoleLoginQr([], ['staff']), false);
  assert.equal(canIssueRoleLoginQr(['admin'], ['student']), false);
  assert.equal(canIssueRoleLoginQr(['admin'], []), false);
});

test('a mixed-role account is judged by its highest role', () => {
  assert.equal(highestRoleRank(['teacher', 'admin']), 100);
  assert.equal(primaryRoleLoginQrCode(['parent', 'driver', 'staff']), 'staff');
  assert.equal(canIssueRoleLoginQr(['accounts'], ['staff', 'admin']), false);
  assert.equal(labelForRoleLoginQr('gate_keeper'), 'Gate Keeper');
  assert.equal(ROLE_LOGIN_QR_SUBJECT_CODES.includes('student'), false);
  assert.match(roleLoginQrRankSql('r.code'), /WHEN 'admin' THEN 100/);
  assert.throws(() => roleLoginQrRankSql('r.code; drop table users'), /Invalid role rank column/);
});
