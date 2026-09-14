import sharp from 'sharp';
import logger from '../utils/logger.js';

const OCR_MAX_EDGE = 1920;
const PARENT_MAX_EDGE = 1280;

/**
 * Prepare a capture for OCR without aggressive compression.
 * EXIF rotation is applied. Contrast is lifted lightly. We never shrink
 * below the original size unless the long edge exceeds OCR_MAX_EDGE.
 */
export async function preprocessForOcr(buffer) {
  try {
    const image = sharp(buffer, { failOn: 'none' }).rotate();
    const meta = await image.metadata();
    const width = meta.width || OCR_MAX_EDGE;
    const height = meta.height || OCR_MAX_EDGE;
    const longEdge = Math.max(width, height);
    const pipeline = image
      .normalize()
      .modulate({ brightness: 1.04, saturation: 0.92 });

    if (longEdge > OCR_MAX_EDGE) {
      pipeline.resize({
        width: OCR_MAX_EDGE,
        height: OCR_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    return pipeline.jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  } catch (error) {
    logger.warn({ err: error, event: 'diary_image_preprocess_failed' }, 'Diary OCR preprocess failed; using original bytes');
    return buffer;
  }
}

/** Smaller JPEG for parent viewing. Stored separately from the OCR source. */
export async function optimizeForParentView(buffer) {
  try {
    return await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({
        width: PARENT_MAX_EDGE,
        height: PARENT_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 78, progressive: true })
      .toBuffer();
  } catch (error) {
    logger.warn({ err: error, event: 'diary_image_optimize_failed' }, 'Diary parent-image optimize failed');
    return buffer;
  }
}
