/**
 * encryption.js
 * AES-256-GCM authenticated encryption for per-school PG credentials.
 *
 * Encoding: ALL three stored fields (encrypted, iv, tag) are BASE64 strings.
 * Key: obtained from secretManager.getEncryptionKey() (GCP Secret Manager in production).
 *      This module never reads, derives, or hardcodes a key itself.
 *
 * No plaintext, key, or intermediate buffer is ever logged in this file.
 */

import crypto from 'crypto';
import { getEncryptionKey } from './secretManager.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;          // 96-bit nonce — recommended size for GCM
const ENCODING = 'base64';    // single, consistent encoding for all fields

/**
 * Encrypt a string. A fresh random IV is generated per call, so calling encrypt()
 * twice on different fields (e.g. app_id and secret) never reuses a nonce.
 *
 * @param {string} plaintext
 * @returns {Promise<{ encrypted: string, iv: string, tag: string }>} all base64
 */
export async function encrypt(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt() requires a string plaintext.');
  }

  const key = await getEncryptionKey();           // 32-byte Buffer (throws if unavailable)
  const iv = crypto.randomBytes(IV_BYTES);        // unique per call
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    encrypted: ciphertext.toString(ENCODING),
    iv: iv.toString(ENCODING),
    tag: tag.toString(ENCODING),
  };
}

/**
 * Decrypt a { encrypted, iv, tag } triple produced by encrypt().
 * Throws if the auth tag does not verify (tampering / wrong key).
 *
 * @param {{ encrypted: string, iv: string, tag: string }} payload
 * @returns {Promise<string>} original plaintext
 */
export async function decrypt({ encrypted, iv, tag } = {}) {
  if (!encrypted || !iv || !tag) {
    throw new Error('decrypt() requires { encrypted, iv, tag }.');
  }

  const key = await getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, ENCODING));
  decipher.setAuthTag(Buffer.from(tag, ENCODING));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted, ENCODING)),
    decipher.final(), // throws on auth failure
  ]);

  return plaintext.toString('utf8');
}
