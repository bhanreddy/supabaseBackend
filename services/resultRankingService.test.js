import test from 'node:test';
import assert from 'node:assert/strict';
import { rankResultRows } from './resultRankingService.js';

const ranks = (rows, method) => rankResultRows(rows, method).map((row) => ({ id: row.student_id, rank: row.rank }));

test('competition ranking skips to fourth after three first ranks', () => {
  assert.deepEqual(ranks([
    { student_id: 'a', admission_no: '1', percentage: 90 },
    { student_id: 'b', admission_no: '2', percentage: 90 },
    { student_id: 'c', admission_no: '3', percentage: 90 },
    { student_id: 'd', admission_no: '4', percentage: 80 },
  ], 'competition'), [
    { id: 'a', rank: 1 }, { id: 'b', rank: 1 }, { id: 'c', rank: 1 }, { id: 'd', rank: 4 },
  ]);
});

test('attendance breaks equal academic-score ties', () => {
  assert.deepEqual(ranks([
    { student_id: 'a', admission_no: '1', percentage: 90, attendance_percentage: 92 },
    { student_id: 'b', admission_no: '2', percentage: 90, attendance_percentage: 98 },
    { student_id: 'c', admission_no: '3', percentage: 80, attendance_percentage: 100 },
  ], 'attendance_tiebreak'), [
    { id: 'b', rank: 1 }, { id: 'a', rank: 2 }, { id: 'c', rank: 3 },
  ]);
});

test('dense ranking keeps ranks consecutive after ties', () => {
  assert.deepEqual(ranks([
    { student_id: 'a', admission_no: '1', percentage: 90 },
    { student_id: 'b', admission_no: '2', percentage: 90 },
    { student_id: 'c', admission_no: '3', percentage: 80 },
  ], 'dense'), [
    { id: 'a', rank: 1 }, { id: 'b', rank: 1 }, { id: 'c', rank: 2 },
  ]);
});
