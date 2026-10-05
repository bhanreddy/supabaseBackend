#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTourCoverage } from './tourCoverage.mjs';
import { execFileSync } from 'node:child_process';
import { validateCatalog, validateManifest, catalogClips, audioChecksum } from './tourAudio.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const frontend = resolve(value('--frontend', resolve(here, '../../SchoolIMS-Frontend')));
const contentDir = resolve(frontend, 'src/features/app-tour/content');
const staging = resolve(value('--staging', resolve(here, '../.tour-audio')));
const catalog = validateCatalog((await Promise.all(['catalog.json', 'extended-catalog.json'].map(async name => JSON.parse(await readFile(resolve(contentDir, name), 'utf8'))))).flat());
const clips = catalogClips(catalog);
// Enforce current translations, access rules and real targets before paid synthesis or uploads.
execFileSync(process.execPath, [resolve(frontend, 'scripts/build-tour-catalog.cjs'), '--check']);
const coverage = await validateTourCoverage(frontend, catalog);

// Checks are entirely local, require no cloud credentials and incur no charges.
if (!args.includes('--generate') && !args.includes('--publish')) {
  const manifest = JSON.parse(await readFile(resolve(contentDir, 'audio-manifest.json'), 'utf8'));
  validateManifest(catalog, manifest, args.includes('--require-audio'));
  console.log(`Validated ${catalog.length} tours, ${catalog.reduce((n, t) => n + t.steps.length, 0)} bilingual steps, ${clips.length} narration clips. Premium assets: ${Object.keys(manifest.clips).length}. Coverage: ${coverage.features} feature guides / ${coverage.routes} app routes.`);
  process.exit(0);
}
if (args.includes('--generate') && args.includes('--publish')) throw new Error('Generate and publish separately so audio can be reviewed between stages');
await mkdir(staging, { recursive: true });
if (args.includes('--generate')) {
  const { TextToSpeechClient } = await import('@google-cloud/text-to-speech');
  const client = new TextToSpeechClient();
  try {
    const staged = { schemaVersion: 1, clips: {} };
    // One content hash is synthesized once, even when reused by multiple tours.
    for (const clip of clips) {
      const path = resolve(staging, `${clip.hash}.mp3`);
      let buffer;
      try { buffer = await readFile(path); } catch {
        const [response] = await client.synthesizeSpeech({ input: { text: clip.text }, voice: { languageCode: `${clip.locale}-IN`, name: clip.voice }, audioConfig: { audioEncoding: 'MP3' } }, { timeout: 30000 });
        if (!response.audioContent) throw new Error(`No audio generated: ${clip.key}`);
        buffer = Buffer.isBuffer(response.audioContent) ? response.audioContent : typeof response.audioContent === 'string' ? Buffer.from(response.audioContent, 'base64') : Buffer.from(response.audioContent);
        await writeFile(path, buffer);
      }
      if (!buffer.length || buffer.length > 8 * 1024 * 1024) throw new Error(`Invalid audio size: ${clip.key}`);
      staged.clips[clip.key] = { hash: clip.hash, sha256: audioChecksum(buffer), bytes: buffer.length };
    }
    await writeFile(resolve(staging, 'manifest.json'), JSON.stringify(staged, null, 2) + '\n');
    console.log(`Generated ${clips.length} staged clips. Listen to both languages in ${staging}, then publish with --publish --reviewed.`);
  } finally { await client.close(); }
} else {
  if (!args.includes('--reviewed')) throw new Error('Publishing requires --reviewed after listening to English and Telugu narration');
  const { default: dotenv } = await import('dotenv'); dotenv.config({ quiet: true });
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for publishing');
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = 'schoolims-tour-audio';
  const staged = JSON.parse(await readFile(resolve(staging, 'manifest.json'), 'utf8'));
  // Validate every staged byte before making any remote changes.
  const buffers = new Map();
  for (const clip of clips) {
    const asset = staged.clips[clip.key];
    const buffer = await readFile(resolve(staging, `${clip.hash}.mp3`));
    if (!asset || asset.hash !== clip.hash || asset.bytes !== buffer.length || asset.sha256 !== audioChecksum(buffer)) throw new Error(`Stale or corrupted staged audio: ${clip.key}`);
    buffers.set(clip.hash, buffer);
  }
  const { data: existing, error: getError } = await client.storage.getBucket(bucket);
  if (getError && !/not found|does not exist/i.test(getError.message)) throw getError;
  if (!existing) { const { error } = await client.storage.createBucket(bucket, { public: true, allowedMimeTypes: ['audio/mpeg'], fileSizeLimit: '8MB' }); if (error) throw error; }
  if (existing && !existing.public) throw new Error('Tour audio bucket must serve the generic reviewed narration publicly');
  for (const [hash, buffer] of buffers) {
    const { error } = await client.storage.from(bucket).upload(`${hash}.mp3`, buffer, { contentType: 'audio/mpeg', cacheControl: '31536000', upsert: false });
    if (error && !/already exists|duplicate/i.test(error.message)) throw error;
  }
  const manifest = { schemaVersion: 1, clips: Object.fromEntries(clips.map(clip => [clip.key, { ...staged.clips[clip.key], url: client.storage.from(bucket).getPublicUrl(`${clip.hash}.mp3`).data.publicUrl }])) };
  validateManifest(catalog, manifest, true);
  const output = resolve(contentDir, 'audio-manifest.json');
  await writeFile(output + '.tmp', JSON.stringify(manifest, null, 2) + '\n'); await rename(output + '.tmp', output);
  console.log(`Published ${buffers.size} audio files and wrote the verified release manifest.`);
}
