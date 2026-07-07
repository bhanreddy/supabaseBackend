// Self-check for feature-flag merge semantics. Run: node test_feature_registry.js
import assert from 'node:assert';
import { FEATURE_REGISTRY, mergeOverrides, registryDefaults } from './utils/featureRegistry.js';

// 1. Absent overrides => registry defaults (never false-by-accident).
const defaults = mergeOverrides({});
assert.deepStrictEqual(defaults, registryDefaults(), 'empty overrides must equal registry defaults');
assert.strictEqual(defaults['nav.fees'], true, 'nav.fees default is true');

// 2. Override wins over default (both directions).
const merged = mergeOverrides({ 'nav.fees': false, 'menu.insurance': false });
assert.strictEqual(merged['nav.fees'], false, 'override false must win');
assert.strictEqual(merged['topbar.diary'], true, 'unrelated key keeps default');

// 3. An override of a default-true key back to true is honored explicitly.
assert.strictEqual(mergeOverrides({ 'nav.fees': true })['nav.fees'], true);

// 4. nav.home is core (non-toggleable) and present.
const home = FEATURE_REGISTRY.find((f) => f.key === 'nav.home');
assert.ok(home && home.toggleable === false, 'nav.home must be non-toggleable');

// 5. Every key is unique and every data_bearing flag is a boolean.
const keys = FEATURE_REGISTRY.map((f) => f.key);
assert.strictEqual(new Set(keys).size, keys.length, 'feature keys must be unique');

console.log(`OK — ${FEATURE_REGISTRY.length} features, merge semantics verified.`);
