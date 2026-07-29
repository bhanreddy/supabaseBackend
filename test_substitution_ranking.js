import assert from 'node:assert/strict';
import { rankSubstitutionCandidates } from './services/substitutionRankingService.js';

const ranked = rankSubstitutionCandidates([
  {
    id: 'busy-subject-teacher',
    teacher_name: 'Busy Teacher',
    subject_name: 'Mathematics',
    subject_match: true,
    class_familiarity: false,
    is_class_teacher: false,
    daily_load: 6,
    adjacent_load: 2,
    recent_substitution_count: 3,
  },
  {
    id: 'balanced-subject-teacher',
    teacher_name: 'Balanced Teacher',
    subject_name: 'Mathematics',
    subject_match: true,
    class_familiarity: true,
    is_class_teacher: false,
    daily_load: 2,
    adjacent_load: 0,
    recent_substitution_count: 0,
  },
  {
    id: 'free-generalist',
    teacher_name: 'Free Teacher',
    subject_name: 'Mathematics',
    subject_match: false,
    class_familiarity: false,
    is_class_teacher: false,
    daily_load: 1,
    adjacent_load: 0,
    recent_substitution_count: 0,
  },
]);

assert.equal(ranked[0].id, 'balanced-subject-teacher');
assert.ok(ranked[0].reasons.includes('Teaches Mathematics'));
assert.ok(ranked[0].reasons.includes('Free before and after'));
assert.ok(ranked[0].score > ranked[1].score);
assert.equal(ranked[ranked.length - 1].id, 'busy-subject-teacher');

const tie = rankSubstitutionCandidates([
  { id: 'b', teacher_name: 'B', daily_load: 2, recent_substitution_count: 1 },
  { id: 'a', teacher_name: 'A', daily_load: 1, recent_substitution_count: 1 },
]);
assert.equal(tie[0].id, 'a', 'lighter daily load wins an equal-score tie');

console.log('substitution ranking tests passed');
