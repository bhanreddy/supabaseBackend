import assert from 'node:assert/strict';
import {
  ACTIVE_STUDENT_STATUS_ID,
  resolveStudentListLifecycle,
} from '../utils/activeStudentFilter.js';

assert.equal(ACTIVE_STUDENT_STATUS_ID, 1);
assert.equal(resolveStudentListLifecycle(undefined, undefined), 'active');
assert.equal(resolveStudentListLifecycle('', undefined), 'active');
assert.equal(resolveStudentListLifecycle('all', undefined), 'all');
assert.equal(resolveStudentListLifecycle('archived', undefined), 'archived');
assert.equal(resolveStudentListLifecycle('active', undefined), 'active');
assert.equal(resolveStudentListLifecycle('bogus', undefined), 'active');
assert.equal(resolveStudentListLifecycle(undefined, 3), 'status');
assert.equal(resolveStudentListLifecycle('all', 2), 'status');

console.log('activeStudentFilter tests passed');
