/**
 * secretManager.js
 * Source of the AES-256 key used to encrypt per-school PG credentials.
 *
 * HARD RULES:
 *   - The key is NEVER hardcoded.
 *   - In production the key MUST come from GCP Secret Manager.
 *   - There is NO silent fallback to a default/derived key. If the key cannot be
 *     obtained, every call throws loudly so encryption fails closed.
 *
 * CURRENT STATE: @google-cloud/secret-manager is NOT installed in this repo and no
 * GCP credentials are configured, so the real fetch path below is a clearly-marked
 * stub that throws. A NON-PRODUCTION-ONLY env override (PG_ENC_KEY_BASE64) exists
 * solely so local round-trip tests can run. That branch is hard-disabled when
 * NODE_ENV === 'production'.
 */

import config from './../config/env.js';

const AES_256_KEY_BYTES = 32;

// Cached in-memory after first successful fetch. Never logged.
let cachedKey = null;

/**
 * Real Secret Manager fetch. Stubbed until the dependency + GCP credentials are wired.
 * @returns {Promise<Buffer>} 32-byte key
 */
async function fetchKeyFromSecretManager() {
  // TODO: replace with real GCP Secret Manager call once @google-cloud/secret-manager
  // is added to package.json and workload identity / GOOGLE_APPLICATION_CREDENTIALS is set:
  //
  //   const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
  //   const client = new SecretManagerServiceClient();
  //   const name = process.env.PG_ENC_KEY_SECRET_RESOURCE; // e.g. projects/<p>/secrets/pg-cred-key/versions/latest
  //   const [version] = await client.accessSecretVersion({ name });
  //   return Buffer.from(version.payload.data); // raw 32 bytes (or base64-decode if stored as base64)
  //
  throw new Error(
    'SecretManagerNotWired: GCP Secret Manager is not configured ' +
      '(@google-cloud/secret-manager is not installed and no GCP credentials are present). ' +
      'Cannot obtain the PG credential-encryption key. Wire fetchKeyFromSecretManager() before enabling PG.'
  );
}

/**
 * Returns the 32-byte AES-256 key, fetching once and caching in memory.
 * @returns {Promise<Buffer>}
 */
export async function getEncryptionKey() {
  if (cachedKey) return cachedKey;

  const isProduction = config.nodeEnv === 'production';

  // NON-PRODUCTION ONLY: allow an explicit base64 key so local/test encryption works.
  // Hard-disabled in production to guarantee the key can only come from Secret Manager there.
  if (!isProduction && process.env.PG_ENC_KEY_BASE64) {
    const buf = Buffer.from(process.env.PG_ENC_KEY_BASE64, 'base64');
    if (buf.length !== AES_256_KEY_BYTES) {
      throw new Error(
        `InvalidDevEncryptionKey: PG_ENC_KEY_BASE64 must decode to exactly ${AES_256_KEY_BYTES} bytes (AES-256), got ${buf.length}.`
      );
    }
    // Note: no key material is logged — only the fact that the dev path is in use.
    console.warn('[secretManager] Using NON-PRODUCTION dev encryption key from PG_ENC_KEY_BASE64. Never use this path in production.');
    cachedKey = buf;
    return cachedKey;
  }

  // Production (and any environment without the dev override) must use Secret Manager.
  const key = await fetchKeyFromSecretManager();
  if (!Buffer.isBuffer(key) || key.length !== AES_256_KEY_BYTES) {
    throw new Error(`InvalidEncryptionKey: Secret Manager must return exactly ${AES_256_KEY_BYTES} bytes (AES-256).`);
  }
  cachedKey = key;
  return cachedKey;
}

/** Test-only: clear the in-memory key cache. Not for production code paths. */
export function _resetEncryptionKeyCache() {
  cachedKey = null;
}
