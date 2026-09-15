import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Computes SHA-256 checksum of a file.
 * @param {string} filePath
 * @returns {Promise<string>} Hexadecimal SHA-256 string
 */
export async function calculateFileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

/**
 * Computes MD5 checksum of a file as standard base64 (GCS md5Hash format).
 * Used to independently verify GCS-computed object hashes after upload.
 * @param {string} filePath
 * @returns {Promise<string>} Base64 MD5 string
 */
export async function calculateFileMd5Base64(filePath) {
  const hash = crypto.createHash('md5');
  const stream = fs.createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return hash.digest('base64');
}

/**
 * Computes SHA-256 checksum of a buffer.
 * @param {Buffer} buffer
 * @returns {string} Hexadecimal SHA-256 string
 */
export function calculateBufferSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
