import sharp from 'sharp';

export const MAX_GALLERY_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_DIMENSION = 2400;

/**
 * Re-encode every public gallery upload as an auto-oriented JPEG. This removes
 * untrusted metadata and keeps public school pages fast without forcing a
 * square crop or changing the original aspect ratio.
 */
export async function normalizeWebsiteGalleryImage(inputBuffer) {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0) {
    throw new Error('Uploaded file is not a valid image');
  }

  const metadata = await sharp(inputBuffer, { failOn: 'error' }).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('Uploaded file is not a valid image');
  }

  let dimension = MAX_DIMENSION;
  let quality = 86;
  let buffer;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    buffer = await sharp(inputBuffer, { failOn: 'error' })
      .rotate()
      .resize(dimension, dimension, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
      .toBuffer();

    if (buffer.length <= MAX_GALLERY_IMAGE_BYTES) break;
    dimension = Math.max(1200, Math.round(dimension * 0.8));
    quality = Math.max(68, quality - 6);
  }

  if (!buffer || buffer.length > MAX_GALLERY_IMAGE_BYTES) {
    throw new Error('Could not optimize this image below the 3 MB storage limit');
  }

  const output = await sharp(buffer).metadata();
  return {
    buffer,
    width: output.width,
    height: output.height,
    size: buffer.length,
  };
}
