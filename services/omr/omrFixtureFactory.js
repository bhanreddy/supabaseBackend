/**
 * Reproducible OMR vision fixtures — generate raster sheets with known answers
 * without opening a camera.
 */

import sharp from 'sharp';
import { calculateTemplateGeometry, generateSheetSvg, inkBubblesIntoSvg } from './omrTemplateEngine.js';

export const OMR_VISION_FIXTURES = {
  fixture_001: {
    id: 'fixture_001',
    description: 'Perfect scan — Q1-B Q2-C Q3-A Q4-D, roll 102030',
    templateCode: 'A4_20Q_4OPT_V1',
    answers: { 1: 'B', 2: 'C', 3: 'A', 4: 'D' },
    rollDigits: [1, 0, 2, 0, 3, 0],
    expected: { 1: 'B', 2: 'C', 3: 'A', 4: 'D', 5: 'BLANK' },
    expectedRoll: 102030,
    transform: 'none',
  },
  fixture_rotated: {
    id: 'fixture_rotated',
    description: 'Small rotation of a clean filled sheet',
    templateCode: 'A4_20Q_4OPT_V1',
    answers: { 1: 'B', 2: 'C', 3: 'A', 4: 'D' },
    rollDigits: [1, 0, 2, 0, 3, 0],
    expected: { 1: 'B', 2: 'C', 3: 'A', 4: 'D' },
    expectedRoll: 102030,
    transform: 'rotate',
  },
  fixture_multiple: {
    id: 'fixture_multiple',
    description: 'Q1 has B and C both filled',
    templateCode: 'A4_20Q_4OPT_V1',
    answers: { 1: 'B', 2: 'A' },
    extraAnswers: { 1: 'C' },
    rollDigits: [1, 2, 3, 4, 5, 6],
    expected: { 1: 'MULTIPLE', 2: 'A' },
    transform: 'none',
  },
  fixture_blank: {
    id: 'fixture_blank',
    description: 'All questions blank, roll filled',
    templateCode: 'A4_20Q_4OPT_V1',
    answers: {},
    rollDigits: [2, 2, 0, 0, 1, 1],
    expected: { 1: 'BLANK', 2: 'BLANK' },
    expectedRoll: 220011,
    transform: 'none',
  },
};

export async function renderOmrFixture(fixture) {
  const spec = typeof fixture === 'string' ? OMR_VISION_FIXTURES[fixture] : fixture;
  if (!spec) throw new Error('Unknown OMR fixture');

  const geom = calculateTemplateGeometry({ code: spec.templateCode });
  let svg = generateSheetSvg({
    schoolName: 'OMR Fixture Academy',
    examTitle: spec.description || spec.id,
    sheetId: spec.id,
    templateCode: spec.templateCode,
  });
  svg = inkBubblesIntoSvg(svg, geom, {
    answers: spec.answers || {},
    rollDigits: spec.rollDigits || [],
  });
  if (spec.extraAnswers) {
    svg = inkBubblesIntoSvg(svg, geom, { answers: spec.extraAnswers });
  }

  let pipeline = sharp(Buffer.from(svg)).png();
  if (spec.transform === 'rotate') {
    pipeline = pipeline.rotate(3, { background: '#FFFFFF' });
  } else if (spec.transform === 'dark') {
    pipeline = pipeline.modulate({ brightness: 0.55 });
  }

  const buffer = await pipeline.toBuffer();
  return { spec, geom, buffer };
}
