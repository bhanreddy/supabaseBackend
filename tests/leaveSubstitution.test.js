import test from 'node:test';
import assert from 'node:assert/strict';
import { rankSubstitutionCandidates } from '../services/substitutionRankingService.js';

test('rankSubstitutionCandidates gives highest score to subject match and familiar class teacher', () => {
  const candidate1 = {
    id: 't-1',
    teacher_name: 'Suresh Kumar',
    subject_match: true,
    class_familiarity: true,
    is_class_teacher: true,
    daily_load: 1,
    adjacent_load: 0,
    recent_substitution_count: 0,
    attendance_status: 'present',
    subject_name: 'Mathematics'
  };

  const candidate2 = {
    id: 't-2',
    teacher_name: 'Anita Roy',
    subject_match: false,
    class_familiarity: false,
    is_class_teacher: false,
    daily_load: 4,
    adjacent_load: 2,
    recent_substitution_count: 3,
    attendance_status: 'present',
    subject_name: 'Mathematics'
  };

  const ranked = rankSubstitutionCandidates([candidate2, candidate1]);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].id, 't-1');
  assert.ok(ranked[0].score > ranked[1].score);
  assert.equal(ranked[0].recommendation, 'Best match');
  assert.ok(ranked[0].reasons.some(r => r.includes('Mathematics')));
  assert.ok(ranked[0].reasons.some(r => r.includes('Class teacher')));
});

test('rankSubstitutionCandidates breaks equal scores by lowest recent substitutions and lowest daily load', () => {
  const candidateA = {
    id: 't-a',
    teacher_name: 'Teacher A',
    subject_match: false,
    class_familiarity: false,
    is_class_teacher: false,
    daily_load: 3,
    adjacent_load: 0,
    recent_substitution_count: 2,
    subject_name: 'Science'
  };

  const candidateB = {
    id: 't-b',
    teacher_name: 'Teacher B',
    subject_match: false,
    class_familiarity: false,
    is_class_teacher: false,
    daily_load: 2,
    adjacent_load: 0,
    recent_substitution_count: 0,
    subject_name: 'Science'
  };

  const ranked = rankSubstitutionCandidates([candidateA, candidateB]);
  assert.equal(ranked[0].id, 't-b');
});

test('handleStaffLeaveApproved validates input parameters and applicant staff existence', async () => {
  const { handleStaffLeaveApproved } = await import('../services/leaveSubstitutionService.js');

  // Case 1: Missing params
  const res1 = await handleStaffLeaveApproved({ schoolId: 1 });
  assert.equal(res1.success, false);
  assert.equal(res1.reason, 'INVALID_PARAMS');

  // Case 2: Applicant staff not found (mock DB returns empty array for user staff lookup)
  const mockDb = async () => [];
  const res2 = await handleStaffLeaveApproved({
    schoolId: 999,
    leaveId: '00000000-0000-0000-0000-000000000001',
    applicantId: '00000000-0000-0000-0000-000000000002',
    startDate: '2026-09-08',
    endDate: '2026-09-09',
  });
  // Since db.js is imported directly in leaveSubstitutionService, passing a non-existent ID yields STAFF_NOT_FOUND
  assert.equal(res2.success, false);
  assert.equal(res2.reason, 'STAFF_NOT_FOUND');
});

test('handleStaffLeaveCancelled cleanly handles missing parameters', async () => {
  const { handleStaffLeaveCancelled } = await import('../services/leaveSubstitutionService.js');

  assert.equal((await handleStaffLeaveCancelled({})).success, false);
  assert.equal((await handleStaffLeaveCancelled({ schoolId: 1 })).success, false);
  assert.equal((await handleStaffLeaveCancelled({ leaveId: 'uuid' })).success, false);
});
