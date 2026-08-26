// Self-check for feature-flag merge semantics. Run: node test_feature_registry.js
import assert from 'node:assert';
import { FEATURE_REGISTRY, mergeOverrides, registryDefaults, assertToggleableFeature } from './utils/featureRegistry.js';

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

// 6. Hostel is a school-admin-toggleable student dashboard card.
const hostel = FEATURE_REGISTRY.find((f) => f.key === 'quick.hostel');
assert.ok(hostel && hostel.toggleable === true && hostel.group === 'quick_actions', 'quick.hostel must be a toggleable student quick action');
assert.equal(assertToggleableFeature('quick.hostel').key, 'quick.hostel');
assert.throws(() => assertToggleableFeature('nav.home'), /cannot be turned off/);
assert.throws(() => assertToggleableFeature('not.a.real.feature'), /Unknown student feature/);

console.log(`OK — ${FEATURE_REGISTRY.length} features, merge semantics verified.`);
