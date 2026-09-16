import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAnecdoteContext, normalizeClientGeneratedId } from '../services/anecdote/anecdoteNormalize.js';

test('normalizes teacher-facing location labels to database context values', () => {
  assert.equal(normalizeAnecdoteContext('Classroom'), 'classroom');
  assert.equal(normalizeAnecdoteContext('Sports Ground'), 'sports_field');
  assert.equal(normalizeAnecdoteContext('Bus / Transport'), 'bus');
  assert.equal(normalizeAnecdoteContext('Dining Hall'), 'cafeteria');
  assert.equal(normalizeAnecdoteContext('Library'), 'other');
  assert.equal(normalizeAnecdoteContext(''), 'classroom');
});

test('keeps valid UUID client ids and drops invalid ones', () => {
  assert.equal(
    normalizeClientGeneratedId('2d1c0a6e-3b7f-4c91-9e2a-1f8b7c6d5e4a'),
    '2d1c0a6e-3b7f-4c91-9e2a-1f8b7c6d5e4a',
  );
  assert.equal(normalizeClientGeneratedId('anecdote_123_abc'), null);
  assert.equal(normalizeClientGeneratedId(null), null);
});
