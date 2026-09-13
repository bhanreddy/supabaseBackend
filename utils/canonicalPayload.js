/**
 * canonicalPayload.js — Deterministic RFC 8785 JSON Canonicalization Scheme (JCS).
 * Matches the frontend canonicalJsonStringify byte-for-byte.
 */

export function canonicalJsonStringify(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map((item) => canonicalJsonStringify(item)).join(',') + ']';
  }

  const sortedKeys = Object.keys(obj).sort();
  const pairs = [];
  for (const key of sortedKeys) {
    const val = obj[key];
    if (val !== undefined && typeof val !== 'function' && typeof val !== 'symbol') {
      pairs.push(JSON.stringify(key) + ':' + canonicalJsonStringify(val));
    }
  }

  return '{' + pairs.join(',') + '}';
}

export function canonicalizePayload(payload) {
  return Buffer.from(canonicalJsonStringify(payload), 'utf8');
}

export { canonicalJsonStringify as canonicalizeJson };
