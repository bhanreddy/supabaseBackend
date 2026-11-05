import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const warnings = [];
mock.module('../db.js', { defaultExport: async () => [] });
mock.module('../utils/logger.js', { defaultExport: { warn: (...args) => warnings.push(args) } });
const { logAiUsage } = await import('../services/ai/aiUsageService.js');

test('long provider failures and model names fit the existing AI usage schema', async () => {
  let values;
  await logAiUsage({
    schoolId: 17, teacherId: 'teacher', feature: 'DIARY_EXTRACTION',
    provider: 'gemini', model: 'model-'.repeat(30), inputType: 'text',
    success: false, errorCode: '[GoogleGenerativeAI Error]: '.repeat(20),
    db: async (_strings, ...args) => { values = args; },
  });
  assert.equal(values[2], 'DIARY_EXTRACTION');
  assert.equal(values[3], 'gemini');
  assert.equal(values[4], 'model-'.repeat(30).slice(0, 80));
  assert.equal(values[10], false);
  assert.equal(values[11], '[GoogleGenerativeAI Error]: '.repeat(20).slice(0, 80));
});

test('AI log limits preserve complete Unicode characters and bound all text columns', async () => {
  let values;
  await logAiUsage({
    schoolId: 17, feature: 'f'.repeat(41), provider: 'p'.repeat(41),
    inputType: 'i'.repeat(41), errorCode: '😀'.repeat(81),
    db: async (_strings, ...args) => { values = args; },
  });
  assert.equal(values[2], 'f'.repeat(40));
  assert.equal(values[3], 'p'.repeat(40));
  assert.equal(values[4], null);
  assert.equal(values[5], 'i'.repeat(40));
  assert.equal(values[11], '😀'.repeat(80));
});

test('successful AI calls retain short values and nullable diagnostics', async () => {
  let values;
  await logAiUsage({
    schoolId: 17, feature: 'DIARY_PHOTO_AI', provider: 'gemini', model: 'gemini-2.5-flash',
    db: async (_strings, ...args) => { values = args; },
  });
  assert.equal(values[4], 'gemini-2.5-flash');
  assert.equal(values[10], true);
  assert.equal(values[11], null);
});

test('AI logging failures remain best effort', async () => {
  warnings.length = 0;
  await logAiUsage({ schoolId: 17, feature: 'DIARY_OCR', db: async () => { throw new Error('offline'); } });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0].event, 'ai_usage_log_failed');
});
