import crypto from 'node:crypto';
import fs from 'node:fs';

const MAGIC_HEADER = Buffer.from('SCHLBACKUP', 'ascii'); // 10 bytes
const FORMAT_VERSION = 0x01; // 1 byte
const IV_LENGTH = 12; // 12 bytes for AES-GCM
const TAG_LENGTH = 16; // 16 bytes auth tag
const MAGIC_FOOTER = Buffer.from('ENDTAG', 'ascii'); // 6 bytes

/**
 * Encrypts an input file to an output file using AES-256-GCM.
 * Writes header with IV, ciphertext, and footer with Auth Tag.
 *
 * @param {string} inputFilePath
 * @param {string} outputFilePath
 * @param {Buffer} key 32-byte Buffer
 * @returns {Promise<{ fileSizeBytes: number, iv: string, tag: string }>}
 */
export async function encryptFile(inputFilePath, outputFilePath, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Encryption key must be a 32-byte Buffer');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const inputStream = fs.createReadStream(inputFilePath);
  const outputStream = fs.createWriteStream(outputFilePath, { mode: 0o600 });

  // Write header: MAGIC (10 bytes) + VERSION (1 byte) + IV (12 bytes) = 23 bytes
  const header = Buffer.concat([MAGIC_HEADER, Buffer.from([FORMAT_VERSION]), iv]);
  outputStream.write(header);

  // Stream ciphertext
  for await (const chunk of inputStream) {
    const encrypted = cipher.update(chunk);
    if (encrypted.length > 0) {
      outputStream.write(encrypted);
    }
  }

  const finalChunk = cipher.final();
  if (finalChunk.length > 0) {
    outputStream.write(finalChunk);
  }

  // Get authentication tag (16 bytes)
  const tag = cipher.getAuthTag();

  // Write footer: TAG (16 bytes) + MAGIC_FOOTER (6 bytes)
  outputStream.write(Buffer.concat([tag, MAGIC_FOOTER]));

  await new Promise((resolve, reject) => {
    outputStream.end((err) => (err ? reject(err) : resolve()));
  });

  const stats = fs.statSync(outputFilePath);
  return {
    fileSizeBytes: stats.size,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

/**
 * Decrypts an encrypted backup file to an output file using AES-256-GCM.
 * Validates header, extracts IV, verifies auth tag.
 *
 * @param {string} encryptedFilePath
 * @param {string} outputFilePath
 * @param {Buffer} key 32-byte Buffer
 * @returns {Promise<{ restoredSizeBytes: number }>}
 */
export async function decryptFile(encryptedFilePath, outputFilePath, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Decryption key must be a 32-byte Buffer');
  }

  const stats = fs.statSync(encryptedFilePath);
  const minLength = MAGIC_HEADER.length + 1 + IV_LENGTH + TAG_LENGTH + MAGIC_FOOTER.length;
  if (stats.size < minLength) {
    throw new Error(`File too small to be a valid encrypted backup archive: ${stats.size} bytes`);
  }

  const fd = fs.openSync(encryptedFilePath, 'r');
  try {
    // 1. Read header
    const headerBuffer = Buffer.alloc(MAGIC_HEADER.length + 1 + IV_LENGTH);
    fs.readSync(fd, headerBuffer, 0, headerBuffer.length, 0);

    const magic = headerBuffer.subarray(0, MAGIC_HEADER.length);
    if (!magic.equals(MAGIC_HEADER)) {
      throw new Error('Invalid archive header: magic signature mismatch');
    }

    const version = headerBuffer[MAGIC_HEADER.length];
    if (version !== FORMAT_VERSION) {
      throw new Error(`Unsupported archive version: ${version}`);
    }

    const iv = headerBuffer.subarray(MAGIC_HEADER.length + 1, headerBuffer.length);

    // 2. Read footer
    const footerLen = TAG_LENGTH + MAGIC_FOOTER.length;
    const footerBuffer = Buffer.alloc(footerLen);
    fs.readSync(fd, footerBuffer, 0, footerLen, stats.size - footerLen);

    const footerMagic = footerBuffer.subarray(TAG_LENGTH, footerLen);
    if (!footerMagic.equals(MAGIC_FOOTER)) {
      throw new Error('Invalid archive footer: end tag signature mismatch');
    }

    const tag = footerBuffer.subarray(0, TAG_LENGTH);

    // 3. Decrypt ciphertext
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const ciphertextStart = headerBuffer.length;
    const ciphertextEnd = stats.size - footerLen;

    const readStream = fs.createReadStream(encryptedFilePath, {
      start: ciphertextStart,
      end: ciphertextEnd - 1,
    });
    const writeStream = fs.createWriteStream(outputFilePath, { mode: 0o600 });

    for await (const chunk of readStream) {
      const decrypted = decipher.update(chunk);
      if (decrypted.length > 0) {
        writeStream.write(decrypted);
      }
    }

    const finalChunk = decipher.final();
    if (finalChunk.length > 0) {
      writeStream.write(finalChunk);
    }

    await new Promise((resolve, reject) => {
      writeStream.end((err) => (err ? reject(err) : resolve()));
    });

    const outStats = fs.statSync(outputFilePath);
    return { restoredSizeBytes: outStats.size };
  } finally {
    fs.closeSync(fd);
  }
}
