import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateTourCoverage } from './tourCoverage.mjs';
import { fileURLToPath } from 'node:url';
import { validateCatalog, catalogClips, validateManifest, narrationHash } from './tourAudio.mjs';
const catalog = (await Promise.all(['catalog.json', 'extended-catalog.json'].map(async file => JSON.parse(await readFile(new URL(`../../SchoolIMS-Frontend/src/features/app-tour/content/${file}`, import.meta.url), 'utf8'))))).flat();
test('all seven portals have one welcome and two bilingual task guides', () => {
  validateCatalog(catalog);
  assert.equal(catalog.filter(t => ['welcome', 'task'].includes(t.kind)).length, 21);
  assert.ok(catalog.filter(t => t.kind === 'feature').length >= 218);
  for (const portal of new Set(catalog.map(t => t.portal))) {
    assert.equal(catalog.filter(t => t.portal === portal && t.kind === 'welcome').length, 1);
    assert.equal(catalog.filter(t => t.portal === portal && t.kind === 'task').length, 2);
    assert.equal(catalog.filter(t => t.portal === portal && t.kind === 'complete').length, 1);
  }
});
test('missing translations and action/read-only conflicts fail release validation', () => {
  const broken = structuredClone(catalog); delete broken[0].steps[0].narration.te;
  assert.throws(() => validateCatalog(broken), /Missing te/);
  const unsafe = structuredClone(catalog); unsafe[0].steps[0].event = 'submit';
  assert.throws(() => validateCatalog(unsafe), /Read-only/);
});
test('narration hashes change with text, locale, or version', () => {
  assert.notEqual(narrationHash('Hello', 'en', 1), narrationHash('Hello!', 'en', 1));
  assert.notEqual(narrationHash('Hello', 'en', 1), narrationHash('Hello', 'te', 1));
  assert.notEqual(narrationHash('Hello', 'en', 1), narrationHash('Hello', 'en', 2));
});
test('premium releases reject absent, stale, and orphaned audio', () => {
  assert.throws(() => validateManifest(catalog, { schemaVersion: 1, clips: {} }, true), /Missing premium/);
  const clip = catalogClips(catalog)[0];
  assert.throws(() => validateManifest(catalog, { schemaVersion: 1, clips: { [clip.key]: { hash: 'bad' } } }), /stale/);
  assert.throws(() => validateManifest(catalog, { schemaVersion: 1, clips: { orphan: {} } }), /Orphaned/);
});

test('every authenticated feature route and menu destination has a reviewed guide', async () => {
  const coverage = await validateTourCoverage(fileURLToPath(new URL('../../SchoolIMS-Frontend', import.meta.url)), catalog);
  assert.ok(coverage.routes > 210);
});
test('complete tours share verified narration with the feature chapters', () => {
  const broken = structuredClone(catalog); const full = broken.find(t => t.kind === 'complete');
  full.steps[0].narration.te[0] = 'Changed without updating the chapter';
  assert.throws(() => validateCatalog(broken), /narration alias/);
  const incomplete = structuredClone(catalog); incomplete.find(t => t.kind === 'complete').steps.pop();
  assert.throws(() => validateCatalog(incomplete), /Incomplete portal/);
  assert.ok(catalogClips(catalog).every(clip => !clip.key.includes('.complete:')));
});

test('complete walkthrough versions can change without replacing unchanged feature audio', () => {
  validateCatalog(catalog);
  const full = catalog.find(t => t.kind === 'complete');
  const unchanged = full.steps.find(s => s.audioSource.narrationVersion !== full.narrationVersion);
  assert.ok(unchanged);
  const owner = catalog.find(t => t.id === unchanged.audioSource.tourId);
  assert.equal(unchanged.audioSource.narrationVersion, owner.narrationVersion);
  const broken = structuredClone(catalog);
  broken.find(t => t.id === full.id).steps.find(s => s.id === unchanged.id).audioSource.narrationVersion++;
  assert.throws(() => validateCatalog(broken), /narration alias/);
});
