import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isResultPublicationGated,
  isResultVisibleToFamilies,
} from './examResultVisibility.js';

test('only formative and summative results require publication', () => {
  assert.equal(isResultPublicationGated('fa_results'), true);
  assert.equal(isResultPublicationGated('sa_results'), true);
  assert.equal(isResultPublicationGated('slip_test'), false);
  assert.equal(isResultPublicationGated('special'), false);
});

test('unpublished formative and summative results stay hidden', () => {
  assert.equal(isResultVisibleToFamilies({ examType: 'fa_results', resultsPublished: false }), false);
  assert.equal(isResultVisibleToFamilies({ examType: 'sa_results', resultsPublished: false }), false);
  assert.equal(isResultVisibleToFamilies({ examType: 'fa_results', resultsPublished: true }), true);
  assert.equal(isResultVisibleToFamilies({ examType: 'sa_results', resultsPublished: true }), true);
});

test('other exam results are visible without publication', () => {
  assert.equal(isResultVisibleToFamilies({ examType: 'slip_test', resultsPublished: false }), true);
  assert.equal(isResultVisibleToFamilies({ examType: 'weekend', resultsPublished: false }), true);
});
