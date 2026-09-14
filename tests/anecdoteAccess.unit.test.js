import assert from 'node:assert/strict';
import test from 'node:test';
import { AnecdoteAccessError, isFamilyRole, isPrivilegedStaff, isStaffRecorderRole } from '../services/anecdote/anecdoteAccessService.js';

test('Privileged staff roles include admin, principal, and coordinator', () => {
  assert.equal(isPrivilegedStaff(['admin']), true);
  assert.equal(isPrivilegedStaff(['principal']), true);
  assert.equal(isPrivilegedStaff(['coordinator']), true);
  assert.equal(isPrivilegedStaff(['teacher']), false);
  assert.equal(isPrivilegedStaff(['parent']), false);
});

test('Family roles are parent and student logins', () => {
  assert.equal(isFamilyRole(['parent']), true);
  assert.equal(isFamilyRole(['student']), true);
  assert.equal(isFamilyRole(['staff']), false);
});

test('Staff recorder roles can create observations', () => {
  assert.equal(isStaffRecorderRole(['teacher']), true);
  assert.equal(isStaffRecorderRole(['staff']), true);
  assert.equal(isStaffRecorderRole(['admin']), true);
  assert.equal(isStaffRecorderRole(['parent']), false);
  assert.equal(isStaffRecorderRole(['student']), false);
});

test('AnecdoteAccessError carries HTTP status for route mapping', () => {
  const err = new AnecdoteAccessError('Not authorized to access this student', 403);
  assert.equal(err.status, 403);
  assert.equal(err.name, 'AnecdoteAccessError');
});
