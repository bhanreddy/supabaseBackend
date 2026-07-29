import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTranslationPrompt,
  prepareDiaryHybridFallback,
  restoreDiaryHybridFallback,
} from '../services/geminiTranslator.js';

test('diary hybrid prompt keeps academic English inside Telugu instructions', () => {
  const prompt = buildTranslationPrompt(
    { f0: 'Practice Straight lines.' },
    'en',
    'te',
    'diary-hybrid'
  );

  assert.match(prompt, /Straight lines ను practice చేయండి/);
  assert.match(prompt, /keep useful English academic terms/);
  assert.match(prompt, /Telugu grammar in Telugu script/);
});

test('standard translations do not inherit diary hybrid rules', () => {
  const prompt = buildTranslationPrompt(
    { f0: 'Practice Straight lines.' },
    'en',
    'te'
  );

  assert.doesNotMatch(prompt, /keep useful English academic terms/);
  assert.match(prompt, /Translate common school words/);
});

test('fallback protects a homework topic and restores natural hybrid Telugu', () => {
  const prepared = prepareDiaryHybridFallback('Practice Straight lines.');

  assert.equal(prepared.text, 'Practice the __SCHOOLTERM0__.');
  assert.equal(
    restoreDiaryHybridFallback('__SCHOOLTERM0__ని ప్రాక్టీస్ చేయండి.', prepared),
    'Straight lines ను practice చేయండి.'
  );
});

test('fallback handles another academic command without hardcoding its topic', () => {
  const prepared = prepareDiaryHybridFallback('Complete Chapter 5 Exercise 2.');

  assert.equal(prepared.text, 'Complete the __SCHOOLTERM0__.');
  assert.equal(
    restoreDiaryHybridFallback('__SCHOOLTERM0__ని పూర్తి చేయండి.', prepared),
    'Chapter 5 Exercise 2 ను పూర్తి చేయండి.'
  );
});
