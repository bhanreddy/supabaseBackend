import sharp from 'sharp';

/**
 * Normalise a principal signature for documents:
 * - honour device orientation
 * - trim empty borders
 * - fit into a predictable landscape box
 * - flatten transparency onto white for reliable PDF rendering
 */
export async function normalizePrincipalSignature(inputBuffer) {
  const metadata = await sharp(inputBuffer, { failOn: 'error' }).metadata();
  if (!metadata?.width || !metadata?.height) {
    throw new Error('Uploaded file is not a valid image');
  }

  const buffer = await sharp(inputBuffer, { failOn: 'error' })
    .rotate()
    .trim({ threshold: 12 })
    .resize({
      width: 800,
      height: 240,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

  return { buffer };
}
