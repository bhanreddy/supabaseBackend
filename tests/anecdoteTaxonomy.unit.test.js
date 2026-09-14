import assert from 'node:assert/strict';
import test from 'node:test';
import { inferAnecdoteTaxonomy } from '../services/anecdote/anecdoteTaxonomyService.js';

test('Taxonomy Inference: Peer Support observation is classified accurately', () => {
  const result = inferAnecdoteTaxonomy("Rahul helped two classmates understand today's mathematics activity.");
  assert.equal(result.category_code, 'SOCIAL');
  assert.equal(result.subcategory_code, 'PEER_SUPPORT');
  assert.equal(result.sentiment, 'POSITIVE');
  assert.equal(result.observation_type, 'RECOGNITION');
  assert.ok(result.suggested_skills.includes('Peer Support'));
  assert.equal(result.context, 'classroom');
  assert.equal(result.confidence, 'HIGH');
});

test('Taxonomy Inference: Leadership observation is recognized', () => {
  const result = inferAnecdoteTaxonomy('Pooja took initiative and led the group project presentation effectively.');
  assert.equal(result.category_code, 'SOCIAL');
  assert.equal(result.subcategory_code, 'LEADERSHIP');
  assert.equal(result.sentiment, 'POSITIVE');
  assert.ok(result.suggested_skills.includes('Leadership'));
});

test('Taxonomy Inference: Incomplete homework concern is identified', () => {
  const result = inferAnecdoteTaxonomy('Student has incomplete homework and forgot notebook for the second time.');
  assert.equal(result.category_code, 'ACADEMIC');
  assert.equal(result.subcategory_code, 'HOMEWORK');
  assert.equal(result.sentiment, 'ATTENTION');
  assert.equal(result.observation_type, 'CONCERN');
  assert.equal(result.severity, 'LEVEL_2_WATCH');
});

test('Taxonomy Inference: Sports and competition achievement is recognized', () => {
  const result = inferAnecdoteTaxonomy('Won 1st prize in the inter-school athletics race at the district sports meet.');
  assert.equal(result.category_code, 'ACHIEVEMENT');
  assert.equal(result.sentiment, 'ACHIEVEMENT');
  assert.equal(result.observation_type, 'ACHIEVEMENT');
  assert.equal(result.severity, 'LEVEL_1_POSITIVE');
});

test('Taxonomy Inference: Classroom disruption is flagged as watch', () => {
  const result = inferAnecdoteTaxonomy('Disrupting the lesson by talking during lecture and distracting others.');
  assert.equal(result.category_code, 'BEHAVIOUR');
  assert.equal(result.subcategory_code, 'DISRUPTION');
  assert.equal(result.sentiment, 'CONCERN');
  assert.equal(result.observation_type, 'INCIDENT');
  assert.equal(result.severity, 'LEVEL_2_WATCH');
});

test('Taxonomy Inference: Context detection picks playground and lab correctly', () => {
  const labResult = inferAnecdoteTaxonomy('Conducted science lab experiment with exceptional understanding.');
  assert.equal(labResult.context, 'laboratory');

  const playgroundResult = inferAnecdoteTaxonomy('Welcomed a lonely classmate to play during lunch break recess in the playground.');
  assert.equal(playgroundResult.context, 'playground');
  assert.equal(playgroundResult.category_code, 'SOCIAL');
  assert.equal(playgroundResult.subcategory_code, 'INCLUSIVENESS');
});
