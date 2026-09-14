/**
 * SchoolIMS — OMR Vision Engine (Engine B)
 * Deterministic Computer Vision pipeline for:
 * 1. Quality detection (sharpness via Laplacian variance, brightness, contrast)
 * 2. Corner registration fiducial detection
 * 3. Perspective & rotation calibration (4-point homography / bilinear interpolation)
 * 4. Fill-level and contrast bubble analysis (EMPTY, FILLED, AMBIGUOUS, DAMAGED)
 * 5. Margin-of-darkness confidence calculations
 * 6. Roll number digit decoding
 */

import sharp from 'sharp';
import { calculateTemplateGeometry } from './omrTemplateEngine.js';

export const QUALITY_STATUS = {
  GOOD: 'GOOD',
  WARNING: 'WARNING',
  REJECT: 'REJECT'
};

export const BUBBLE_STATUS = {
  EMPTY: 'EMPTY',
  FILLED: 'FILLED',
  AMBIGUOUS: 'AMBIGUOUS',
  DAMAGED: 'DAMAGED'
};

/**
 * Evaluates raw image buffer quality (sharpness, lighting, glare, contrast).
 */
export function assessScanQuality(rawGrayBuffer, width, height) {
  let sumLuminance = 0;
  let minLum = 255;
  let maxLum = 0;

  // Sample stride to keep evaluation under 5ms
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 300));
  let sampledCount = 0;

  for (let y = 0; y < height; y += stride) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += stride) {
      const val = rawGrayBuffer[rowOffset + x];
      sumLuminance += val;
      if (val < minLum) minLum = val;
      if (val > maxLum) maxLum = val;
      sampledCount++;
    }
  }

  const meanLuminance = sumLuminance / (sampledCount || 1);
  const contrastSpread = maxLum - minLum;

  // Discrete Laplacian variance for sharpness measurement
  let laplacianSum = 0;
  let laplacianSqSum = 0;
  let laplacianCount = 0;

  const lapStride = stride * 2;
  for (let y = lapStride; y < height - lapStride; y += lapStride) {
    const row = y * width;
    const prevRow = (y - 1) * width;
    const nextRow = (y + 1) * width;
    for (let x = lapStride; x < width - lapStride; x += lapStride) {
      const center = rawGrayBuffer[row + x];
      const lap = 4 * center -
        rawGrayBuffer[prevRow + x] -
        rawGrayBuffer[nextRow + x] -
        rawGrayBuffer[row + x - 1] -
        rawGrayBuffer[row + x + 1];
      laplacianSum += lap;
      laplacianSqSum += lap * lap;
      laplacianCount++;
    }
  }

  const lapMean = laplacianSum / (laplacianCount || 1);
  const sharpnessVariance = (laplacianSqSum / (laplacianCount || 1)) - (lapMean * lapMean);

  const metrics = {
    meanLuminance: Math.round(meanLuminance),
    contrastSpread,
    sharpnessScore: Math.round(sharpnessVariance),
    isDark: meanLuminance < 60,
    isBrightOrGlared: (meanLuminance > 254) || (meanLuminance > 230 && contrastSpread < 100),
    isBlurry: sharpnessVariance < 35,
    isLowContrast: contrastSpread < 80
  };

  let status = QUALITY_STATUS.GOOD;
  let guidance = 'Sheet detected and ready for evaluation';

  if (metrics.isBlurry && metrics.isDark) {
    status = QUALITY_STATUS.REJECT;
    guidance = 'Image is too blurry and dark. Hold device steady and improve lighting.';
  } else if (metrics.isBlurry) {
    status = QUALITY_STATUS.WARNING;
    guidance = 'Hold camera steady to improve sharpness.';
  } else if (metrics.isDark) {
    status = QUALITY_STATUS.WARNING;
    guidance = 'Lighting is low. Turn on torch or move to better light.';
  } else if (metrics.isBrightOrGlared) {
    status = QUALITY_STATUS.WARNING;
    guidance = 'Glare detected on page. Tilt camera slightly away from light source.';
  } else if (metrics.isLowContrast) {
    status = QUALITY_STATUS.WARNING;
    guidance = 'Low page contrast. Ensure page is printed clearly.';
  }

  return { status, guidance, metrics };
}

/**
 * Detects the 4 corner registration fiducial markers.
 * Searches in top-left, top-right, bottom-left, bottom-right quadrants.
 */
export function detectRegistrationMarkers(rawGrayBuffer, width, height, expectedGeom) {
  const searchFraction = 0.08; // cleanly isolates corner fiducial markers without stray text
  const searchW = Math.floor(width * searchFraction);
  const searchH = Math.floor(height * searchFraction);

  // Compute adaptive threshold for marker black vs paper white
  let cornerSum = 0;
  let count = 0;
  const sampleStride = 4;
  for (let y = 0; y < searchH; y += sampleStride) {
    for (let x = 0; x < searchW; x += sampleStride) {
      cornerSum += rawGrayBuffer[y * width + x];
      count++;
    }
  }
  const localPaperWhite = cornerSum / (count || 1);
  // Markers are dark solid squares compared to paper
  const threshold = Math.max(30, Math.floor(localPaperWhite * 0.45));

  const findQuadrantCentroid = (startX, startY, endX, endY) => {
    let sumX = 0;
    let sumY = 0;
    let darkPixels = 0;

    for (let y = startY; y < endY; y += 2) {
      const row = y * width;
      for (let x = startX; x < endX; x += 2) {
        if (rawGrayBuffer[row + x] <= threshold) {
          sumX += x;
          sumY += y;
          darkPixels++;
        }
      }
    }

    if (darkPixels < 30) {
      return null;
    }

    return {
      x: Math.round(sumX / darkPixels),
      y: Math.round(sumY / darkPixels),
      density: darkPixels,
      estimated: false
    };
  };

  const tlFound = findQuadrantCentroid(0, 0, searchW, searchH);
  const trFound = findQuadrantCentroid(width - searchW, 0, width, searchH);
  const blFound = findQuadrantCentroid(0, height - searchH, searchW, height);
  const brFound = findQuadrantCentroid(width - searchW, height - searchH, width, height);

  const found = [tlFound, trFound, blFound, brFound].filter(Boolean);
  const scaleX = width / expectedGeom.dimensions.width;
  const scaleY = height / expectedGeom.dimensions.height;

  const estimate = (expected) => ({
    x: Math.round(expected.x * scaleX),
    y: Math.round(expected.y * scaleY),
    estimated: true
  });

  return {
    topLeft: tlFound || estimate(expectedGeom.markers.topLeft),
    topRight: trFound || estimate(expectedGeom.markers.topRight),
    bottomLeft: blFound || estimate(expectedGeom.markers.bottomLeft),
    bottomRight: brFound || estimate(expectedGeom.markers.bottomRight),
    detectedCount: found.length,
    allMarkersDetected: found.length === 4,
    missingMarkers: [
      !tlFound ? 'top_left' : null,
      !trFound ? 'top_right' : null,
      !blFound ? 'bottom_left' : null,
      !brFound ? 'bottom_right' : null,
    ].filter(Boolean)
  };
}

/**
 * Classifies a single question from sampled option fill metrics.
 * Deterministic: never picks randomly among filled bubbles.
 */
export function classifyQuestionBubbles(sampledOptions, { confidenceThreshold = 70, reviewThreshold = 50 } = {}) {
  const sorted = [...sampledOptions].sort((a, b) => b.compositeMetric - a.compositeMetric);
  const first = sorted[0] || { option: 'BLANK', compositeMetric: 0, fillRatio: 0, status: BUBBLE_STATUS.EMPTY };
  const second = sorted[1] || { compositeMetric: 0 };

  const filledOptions = sampledOptions.filter((opt) => opt.status === BUBBLE_STATUS.FILLED);
  const ambiguousOptions = sampledOptions.filter((opt) => opt.status === BUBBLE_STATUS.AMBIGUOUS);

  let detectedOption = 'BLANK';
  let isBlank = false;
  let isMultiple = false;
  let isAmbiguous = false;
  let confidence = 0;

  if (filledOptions.length === 1 && second.compositeMetric < 30) {
    detectedOption = first.option;
    const delta = first.compositeMetric - second.compositeMetric;
    confidence = Math.min(99, Math.round(75 + delta * 0.4));
  } else if (filledOptions.length > 1) {
    detectedOption = 'MULTIPLE';
    isMultiple = true;
    confidence = 45;
  } else if (filledOptions.length === 0 && ambiguousOptions.length === 1) {
    detectedOption = first.option;
    isAmbiguous = true;
    confidence = Math.max(reviewThreshold - 12, Math.min(confidenceThreshold - 1, 58));
  } else if (filledOptions.length === 0 && ambiguousOptions.length > 1) {
    detectedOption = 'AMBIGUOUS';
    isAmbiguous = true;
    confidence = 40;
  } else if (filledOptions.length === 1) {
    detectedOption = first.option;
    const delta = first.compositeMetric - second.compositeMetric;
    isAmbiguous = delta < 15;
    confidence = isAmbiguous ? 62 : Math.min(99, Math.round(70 + delta * 0.35));
  } else {
    detectedOption = 'BLANK';
    isBlank = true;
    confidence = 98;
  }

  const allOptionsMap = {};
  sampledOptions.forEach((o) => {
    allOptionsMap[o.option] = {
      metric: o.compositeMetric,
      fillRatio: o.fillRatio,
      status: o.status
    };
  });

  return {
    detectedOption,
    confidence,
    fillRatio: first.fillRatio || 0,
    isMultiple,
    isBlank,
    isAmbiguous,
    allOptions: allOptionsMap
  };
}

/**
 * Projects canonical template coordinates (u, v in 0..1) to actual image coordinates (x, y)
 * using 4-point bilinear / projective transformation.
 */
export function projectCanonicalPoint(normX, normY, corners) {
  const { topLeft: tl, topRight: tr, bottomLeft: bl, bottomRight: br } = corners;

  // Bilinear interpolation between the 4 corners:
  // Top edge point: (1 - normX) * tl + normX * tr
  // Bottom edge point: (1 - normX) * bl + normX * br
  const topX = (1 - normX) * tl.x + normX * tr.x;
  const topY = (1 - normX) * tl.y + normX * tr.y;

  const botX = (1 - normX) * bl.x + normX * br.x;
  const botY = (1 - normX) * bl.y + normX * br.y;

  const finalX = Math.round((1 - normY) * topX + normY * botX);
  const finalY = Math.round((1 - normY) * topY + normY * botY);

  return { x: finalX, y: finalY };
}

/**
 * Samples a circular bubble region and determines its fill metric against local background paper white.
 */
export function sampleBubbleFill(rawGrayBuffer, imgWidth, imgHeight, centerX, centerY, radius) {
  const rSq = radius * radius;
  const outerR1 = radius * 1.3;
  const outerR2 = radius * 1.8;
  const outerR1Sq = outerR1 * outerR1;
  const outerR2Sq = outerR2 * outerR2;

  // 1. Measure local background paper luminance in outer quiet ring
  let bgSum = 0;
  let bgCount = 0;
  const maxSearch = Math.ceil(outerR2);

  for (let dy = -maxSearch; dy <= maxSearch; dy++) {
    const py = centerY + dy;
    if (py < 0 || py >= imgHeight) continue;
    const rowOffset = py * imgWidth;
    for (let dx = -maxSearch; dx <= maxSearch; dx++) {
      const px = centerX + dx;
      if (px < 0 || px >= imgWidth) continue;

      const dSq = dx * dx + dy * dy;
      if (dSq >= outerR1Sq && dSq <= outerR2Sq) {
        bgSum += rawGrayBuffer[rowOffset + px];
        bgCount++;
      }
    }
  }

  const paperWhite = bgCount > 0 ? bgSum / bgCount : 220;
  const fillThreshold = Math.max(30, paperWhite - 45); // threshold significantly darker than background

  // 2. Measure inside bubble
  let darkPixelCount = 0;
  let bubblePixelCount = 0;
  let totalDarknessDelta = 0;

  for (let dy = -radius; dy <= radius; dy++) {
    const py = centerY + dy;
    if (py < 0 || py >= imgHeight) continue;
    const rowOffset = py * imgWidth;
    for (let dx = -radius; dx <= radius; dx++) {
      const px = centerX + dx;
      if (px < 0 || px >= imgWidth) continue;

      const dSq = dx * dx + dy * dy;
      if (dSq <= rSq) {
        const val = rawGrayBuffer[rowOffset + px];
        bubblePixelCount++;
        const delta = Math.max(0, paperWhite - val);
        totalDarknessDelta += delta;

        if (val <= fillThreshold) {
          darkPixelCount++;
        }
      }
    }
  }

  const fillRatio = bubblePixelCount > 0 ? darkPixelCount / bubblePixelCount : 0;
  const meanDarkness = bubblePixelCount > 0 ? totalDarknessDelta / bubblePixelCount : 0;

  // Composite fill metric (0 to 100)
  const compositeMetric = Math.min(100, Math.round((fillRatio * 70) + (meanDarkness / 255 * 100 * 0.3)));

  let status = BUBBLE_STATUS.EMPTY;
  if (fillRatio >= 0.42 || compositeMetric >= 52) {
    status = BUBBLE_STATUS.FILLED;
  } else if (fillRatio >= 0.20 || compositeMetric >= 28) {
    status = BUBBLE_STATUS.AMBIGUOUS;
  }

  return {
    fillRatio: Number(fillRatio.toFixed(4)),
    meanDarkness: Number(meanDarkness.toFixed(2)),
    compositeMetric,
    paperWhite: Math.round(paperWhite),
    status
  };
}

/**
 * Main Vision Processing Pipeline.
 * Consumes image buffer, performs quality audit, aligns markers, samples bubbles,
 * decodes roll number, and generates question-level confidence and answers.
 */
export async function processOmrImage(imageBuffer, options = {}) {
  const {
    templateCode = 'A4_50Q_4OPT_V1',
    expectedExamId = null,
    confidenceThreshold = 70,
    reviewThreshold = 50
  } = options;

  // 1. Convert input to grayscale raw buffer using Sharp (handles any image format: JPEG, PNG, WebP)
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();

  // Normalize image dimensions if extremely large to maintain sub-100ms processing speed
  let targetImage = image;
  const maxDim = 2400;
  if (metadata.width > maxDim || metadata.height > maxDim) {
    targetImage = image.resize({
      width: metadata.width >= metadata.height ? maxDim : undefined,
      height: metadata.height > metadata.width ? maxDim : undefined,
      fit: 'inside'
    });
  }

  const { data: rawGrayBuffer, info } = await targetImage
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;

  // 2. Assess Scan Quality
  const quality = assessScanQuality(rawGrayBuffer, width, height);

  // 3. Load Template Geometry and Detect Corner Registration Markers
  const geom = calculateTemplateGeometry({ code: templateCode });
  const detectedCorners = detectRegistrationMarkers(rawGrayBuffer, width, height, geom);

  if (detectedCorners.detectedCount < 3) {
    const missing = detectedCorners.missingMarkers.join(', ') || 'registration markers';
    quality.status = QUALITY_STATUS.REJECT;
    quality.guidance = missing.includes('bottom_right')
      ? 'Bottom-right marker unavailable. Align the full page and scan again.'
      : 'Unable to read the sheet. Please align the page so all four corner squares are visible and scan again.';
    return {
      templateCode,
      quality,
      corners: detectedCorners,
      detectedRollString: null,
      detectedRollNumber: null,
      overallConfidence: 0,
      scanStatus: 'REJECTED',
      exceptionType: 'DAMAGED_SHEET',
      stats: { totalQuestions: geom.questions.length, answeredCount: 0, blankCount: 0, multipleCount: 0, ambiguousCount: 0 },
      answers: []
    };
  }

  if (quality.status === QUALITY_STATUS.REJECT) {
    return {
      templateCode,
      quality,
      corners: detectedCorners,
      detectedRollString: null,
      detectedRollNumber: null,
      overallConfidence: 0,
      scanStatus: 'REJECTED',
      exceptionType: 'POOR_SCAN_QUALITY',
      stats: { totalQuestions: geom.questions.length, answeredCount: 0, blankCount: 0, multipleCount: 0, ambiguousCount: 0 },
      answers: []
    };
  }

  const spanX = geom.markers.topRight.x - geom.markers.topLeft.x;
  const spanY = geom.markers.bottomLeft.y - geom.markers.topLeft.y;

  // 4. Process Roll Number Grid
  const rollDigits = [];
  const rollCols = geom.rollGrid.columns;

  for (let col = 0; col < rollCols; col++) {
    const colBubbles = geom.rollGrid.bubbles.filter((b) => b.col === col);
    let bestDigit = null;
    let bestMetric = -1;
    let secondBestMetric = -1;

    for (const b of colBubbles) {
      const normX = (b.cx - geom.markers.topLeft.x) / spanX;
      const normY = (b.cy - geom.markers.topLeft.y) / spanY;
      const pt = projectCanonicalPoint(normX, normY, detectedCorners);
      const rad = Math.max(6, Math.round(b.radius * (width / geom.dimensions.width)));

      const sample = sampleBubbleFill(rawGrayBuffer, width, height, pt.x, pt.y, rad);
      if (sample.compositeMetric > bestMetric) {
        secondBestMetric = bestMetric;
        bestMetric = sample.compositeMetric;
        bestDigit = b.digit;
      } else if (sample.compositeMetric > secondBestMetric) {
        secondBestMetric = sample.compositeMetric;
      }
    }

    if (bestMetric >= 40 && (bestMetric - secondBestMetric) >= 15) {
      rollDigits.push(bestDigit);
    } else {
      rollDigits.push(null);
    }
  }

  const detectedRollString = rollDigits.some((d) => d != null) ? rollDigits.map((d) => (d != null ? String(d) : '?')).join('') : null;
  const detectedRollNumber = detectedRollString && !detectedRollString.includes('?') ? parseInt(detectedRollString, 10) : null;

  // 5. Process Questions & Option Bubbles
  const detectedAnswers = [];
  let totalConfidence = 0;
  let ambiguousCount = 0;
  let multipleCount = 0;
  let blankCount = 0;

  for (const q of geom.questions) {
    const sampledOptions = [];

    for (const b of q.bubbles) {
      const normX = (b.cx - geom.markers.topLeft.x) / spanX;
      const normY = (b.cy - geom.markers.topLeft.y) / spanY;
      const pt = projectCanonicalPoint(normX, normY, detectedCorners);
      const rad = Math.max(6, Math.round(b.radius * (width / geom.dimensions.width)));

      const sample = sampleBubbleFill(rawGrayBuffer, width, height, pt.x, pt.y, rad);
      sampledOptions.push({
        option: b.option,
        ...sample
      });
    }

    const classified = classifyQuestionBubbles(sampledOptions, { confidenceThreshold, reviewThreshold });
    if (classified.isMultiple) multipleCount++;
    if (classified.isAmbiguous) ambiguousCount++;
    if (classified.isBlank) blankCount++;
    totalConfidence += classified.confidence;

    detectedAnswers.push({
      questionNumber: q.questionNumber,
      ...classified
    });
  }

  const overallConfidence = geom.questions.length > 0
    ? Number((totalConfidence / geom.questions.length).toFixed(2))
    : 0;

  // Determine Scan Status
  let scanStatus = 'PROCESSED';
  let exceptionType = null;

  if (quality.status === QUALITY_STATUS.REJECT) {
    scanStatus = 'REJECTED';
    exceptionType = 'POOR_SCAN_QUALITY';
  } else if (!detectedRollNumber) {
    scanStatus = 'REVIEW_REQUIRED';
    exceptionType = 'UNIDENTIFIED_STUDENT';
  } else if (ambiguousCount > 0 || multipleCount > 0 || overallConfidence < confidenceThreshold) {
    scanStatus = 'REVIEW_REQUIRED';
    exceptionType = ambiguousCount > 0 ? 'AMBIGUOUS_BUBBLE' : (multipleCount > 0 ? 'MULTIPLE_ANSWERS' : 'LOW_CONFIDENCE');
  }

  return {
    templateCode,
    quality,
    corners: detectedCorners,
    detectedRollString,
    detectedRollNumber,
    overallConfidence,
    scanStatus,
    exceptionType,
    stats: {
      totalQuestions: geom.questions.length,
      answeredCount: geom.questions.length - blankCount,
      blankCount,
      multipleCount,
      ambiguousCount
    },
    answers: detectedAnswers
  };
}
