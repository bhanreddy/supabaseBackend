import sharp from 'sharp';

/**
 * Server-side avatar normalisation.
 *
 * The client is free to send a full-resolution photo — this is the single
 * source of truth for the stored image. We always re-encode to a square JPEG
 * and drive the output into a target byte band (default 50–100 KB).
 *
 * Strategy (per dimension, JPEG quality is the fine lever):
 *   - If the whole quality range sits UNDER the band, the image is highly
 *     compressible → grow the pixel dimension to add real detail/bytes.
 *   - If the whole quality range sits OVER the band, shrink the dimension.
 *   - Otherwise the band lies between two qualities → binary-search quality so a
 *     coarse step can never skip over the band.
 *
 * Always returns a decodable JPEG buffer. If the band genuinely cannot be met
 * (e.g. a tiny near-solid image that can't reach the floor even at max size),
 * the closest achievable buffer is returned rather than throwing.
 */

const TARGET_MIN_BYTES = 50 * 1024;
const TARGET_MAX_BYTES = 100 * 1024;

const QUALITY_MIN = 40;
const QUALITY_MAX = 92;

// Ascending — index of the 512 "home" dimension is DIM_HOME_INDEX. We walk down
// for over-band images and up for under-band (highly compressible) images.
const DIMENSIONS = [256, 320, 384, 448, 512, 640, 768, 896, 1024];
const DIM_HOME_INDEX = 4; // 512

async function encodeJpeg(input, size, quality) {
  return sharp(input, { failOn: 'error' })
    .rotate() // honour EXIF orientation before metadata is stripped
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toBuffer();
}

/**
 * @param {Buffer} inputBuffer raw uploaded image bytes
 * @param {object} [opts]
 * @param {number} [opts.minBytes]
 * @param {number} [opts.maxBytes]
 * @returns {Promise<{ buffer: Buffer, size: number, dimension: number, quality: number }>}
 */
export async function normalizeAvatar(inputBuffer, opts = {}) {
  const minBytes = opts.minBytes ?? TARGET_MIN_BYTES;
  const maxBytes = opts.maxBytes ?? TARGET_MAX_BYTES;

  // Validate the input is a decodable image up front (throws otherwise).
  const meta = await sharp(inputBuffer).metadata();
  if (!meta || !meta.width || !meta.height) {
    throw new Error('Uploaded file is not a valid image');
  }

  let best = null; // closest-to-band candidate seen so far
  const distance = (size) => (size > maxBytes ? size - maxBytes : minBytes - size);
  const record = (buffer, dimension, quality) => {
    const size = buffer.length;
    const candidate = { buffer, size, dimension, quality };
    if (!best || distance(size) < distance(best.size)) best = candidate;
    return size >= minBytes && size <= maxBytes ? candidate : null;
  };

  // Encode + record helper.
  const attempt = async (dimension, quality) => {
    const buffer = await encodeJpeg(inputBuffer, dimension, quality);
    return { hit: record(buffer, dimension, quality), size: buffer.length };
  };

  let idx = DIM_HOME_INDEX;
  // Bound the dimension walk so we never loop forever on a pathological image.
  for (let guard = 0; guard < DIMENSIONS.length; guard++) {
    const dimension = DIMENSIONS[idx];

    const hi = await attempt(dimension, QUALITY_MAX);
    if (hi.hit) return hi.hit;

    if (hi.size < minBytes) {
      // Even max quality is under the band → too compressible at this size.
      // Grow the dimension (more real detail = more bytes). If already largest,
      // accept the closest (max-quality) result.
      if (idx >= DIMENSIONS.length - 1) break;
      idx += 1;
      continue;
    }

    // hi.size > maxBytes here (== band would have been a hit). Probe min quality.
    const lo = await attempt(dimension, QUALITY_MIN);
    if (lo.hit) return lo.hit;

    if (lo.size > maxBytes) {
      // Even min quality overflows the band → shrink the dimension. If already
      // smallest, accept the closest (min-quality) result.
      if (idx <= 0) break;
      idx -= 1;
      continue;
    }

    // Band lies strictly between QUALITY_MIN and QUALITY_MAX → binary-search it.
    let loQ = QUALITY_MIN;
    let hiQ = QUALITY_MAX;
    while (hiQ - loQ > 1) {
      const midQ = Math.round((loQ + hiQ) / 2);
      const mid = await attempt(dimension, midQ);
      if (mid.hit) return mid.hit;
      if (mid.size > maxBytes) hiQ = midQ;
      else loQ = midQ;
    }
    break; // closest endpoint already captured in `best`
  }

  return best;
}

export const AVATAR_BAND = { minBytes: TARGET_MIN_BYTES, maxBytes: TARGET_MAX_BYTES };
