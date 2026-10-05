import { createHash } from 'node:crypto';
export const TOUR_VOICES = { en: 'en-IN-Chirp3-HD-Achernar', te: 'te-IN-Chirp3-HD-Achernar' };
export function narrationHash(text, locale, version) {
  return createHash('sha256').update(JSON.stringify([text, `${locale}-IN`, TOUR_VOICES[locale], version])).digest('hex');
}
export const audioChecksum = buffer => createHash('sha256').update(buffer).digest('hex');
export function validateCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) throw new Error('Tour catalog must be a nonempty array');
  const tourIds = new Set();
  for (const tour of catalog) {
    if (!/^[a-z]+\.[a-z-]+$/.test(tour.id) || tourIds.has(tour.id)) throw new Error(`Invalid or duplicate tour ID: ${tour.id}`);
    tourIds.add(tour.id);
    if (!['student', 'staff', 'admin', 'accounts', 'driver', 'gatekeeper', 'applicant'].includes(tour.portal)) throw new Error(`Invalid portal: ${tour.id}`);
    if (!Number.isInteger(tour.version) || tour.version < 1 || !Number.isInteger(tour.narrationVersion) || tour.narrationVersion < 1) throw new Error(`Invalid version: ${tour.id}`);
    if (!['welcome', 'task', 'feature', 'complete'].includes(tour.kind) || !Array.isArray(tour.steps) || !tour.steps.length) throw new Error(`Invalid tour: ${tour.id}`);
    const stepIds = new Set();
    for (const locale of ['en', 'te']) if (!tour.title?.[locale]?.trim() || !tour.description?.[locale]?.trim()) throw new Error(`Missing ${locale} tour copy: ${tour.id}`);
    for (const step of tour.steps) {
      if (!/^[a-z][a-z0-9-]*$/.test(step.id) || stepIds.has(step.id)) throw new Error(`Duplicate step: ${tour.id}/${step.id}`);
      stepIds.add(step.id);
      if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(step.target) || !(step.target.startsWith(`${tour.portal}.`) || step.target.startsWith('screen.')) || !step.route?.startsWith('/') || step.route.includes('://') || step.route.includes('..')) throw new Error(`Invalid target/route: ${tour.id}/${step.id}`);
      if (step.event && step.readOnly) throw new Error(`Read-only step cannot require an action: ${tour.id}/${step.id}`);
      for (const locale of ['en', 'te']) {
        if (!step.title?.[locale]?.trim() || !step.body?.[locale]?.trim() || !Array.isArray(step.narration?.[locale]) || !step.narration[locale].length) throw new Error(`Missing ${locale} step copy: ${tour.id}/${step.id}`);
        for (const text of step.narration[locale]) if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 4500) throw new Error(`Invalid ${locale} narration length: ${tour.id}/${step.id}`);
      }
    }
  }
  const byId = new Map(catalog.map(tour => [tour.id, tour]));
  for (const tour of catalog) for (const step of tour.steps) if (step.audioSource) {
    const owner = byId.get(step.audioSource.tourId);
    const original = owner?.steps.find(s => s.id === step.audioSource.stepId);
    if (tour.kind !== 'complete' || owner?.kind !== 'feature' || owner.portal !== tour.portal || owner.version !== step.audioSource.version || owner.narrationVersion !== (step.audioSource.narrationVersion ?? tour.narrationVersion) || !original || original.target !== step.target || original.route !== step.route || JSON.stringify(original.narration) !== JSON.stringify(step.narration)) throw Error(`Invalid narration alias: ${tour.id}/${step.id}`);
  }
  for (const tour of catalog.filter(t => t.kind === 'complete')) {
    const expected = catalog.filter(t => t.kind === 'feature' && t.portal === tour.portal).flatMap(t => t.steps.map(s => `${t.id}:${s.id}`));
    const actual = tour.steps.map(s => `${s.audioSource?.tourId}:${s.audioSource?.stepId}`);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw Error(`Incomplete portal walkthrough: ${tour.id}`);
  }
  return catalog;
}

export function catalogClips(catalog) {
  return catalog.flatMap(tour => tour.steps.filter(step => !step.audioSource).flatMap(step => ['en', 'te'].flatMap(locale => step.narration[locale].map((text, index) => ({
    key: `${tour.id}:${tour.version}:${step.id}:${locale}:${index}`, text, locale,
    voice: TOUR_VOICES[locale], hash: narrationHash(text, locale, tour.narrationVersion),
  })))));
}
export function validateManifest(catalog, manifest, requireAudio = false) {
  if (manifest?.schemaVersion !== 1 || !manifest.clips || typeof manifest.clips !== 'object') throw new Error('Invalid audio manifest');
  const expected = catalogClips(catalog);
  const keys = new Set(expected.map(clip => clip.key));
  for (const key of Object.keys(manifest.clips)) if (!keys.has(key)) throw new Error(`Orphaned audio clip: ${key}`);
  for (const clip of expected) {
    const asset = manifest.clips[clip.key];
    if (!asset) { if (requireAudio) throw new Error(`Missing premium audio: ${clip.key}`); continue; }
    if (asset.hash !== clip.hash || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 8 * 1024 * 1024 || !asset.url?.startsWith('https://')) throw new Error(`Invalid or stale audio: ${clip.key}`);
  }
  return expected.length;
}
