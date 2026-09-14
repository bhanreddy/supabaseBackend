/**
 * Unit & Integration Test Suite for SchoolIMS Premium OMR Engine
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  calculateTemplateGeometry,
  generateSheetSvg,
  TEMPLATE_PRESETS
} from '../services/omr/omrTemplateEngine.js';
import {
  assessScanQuality,
  sampleBubbleFill,
  projectCanonicalPoint,
  processOmrImage,
  QUALITY_STATUS,
  BUBBLE_STATUS,
  classifyQuestionBubbles,
} from '../services/omr/omrVisionEngine.js';
import {
  evaluateAnswers,
  MULTIPLE_ANSWER_BEHAVIOR
} from '../services/omr/omrEvaluationEngine.js';

describe('OMR Template Engine (Engine A)', () => {
  test('calculates correct geometry for A4 50-Question preset', () => {
    const geom = calculateTemplateGeometry({ code: 'A4_50Q_4OPT_V1' });

    assert.equal(geom.totalQuestions, 50);
    assert.equal(geom.optionsCount, 4);
    assert.equal(geom.questions.length, 50);

    // Verify 4 corner markers are present
    assert.ok(geom.markers.topLeft.x > 0 && geom.markers.topLeft.y > 0);
    assert.ok(geom.markers.topRight.x > geom.markers.topLeft.x);
    assert.ok(geom.markers.bottomLeft.y > geom.markers.topLeft.y);
    assert.ok(geom.markers.bottomRight.x > geom.markers.bottomLeft.x);

    // Verify each question has 4 option bubbles
    for (const q of geom.questions) {
      assert.equal(q.bubbles.length, 4);
      assert.deepEqual(q.bubbles.map(b => b.option), ['A', 'B', 'C', 'D']);
      // Ensure bubbles in the same question don't overlap
      for (let i = 0; i < q.bubbles.length - 1; i++) {
        assert.ok(q.bubbles[i + 1].cx - q.bubbles[i].cx >= q.bubbles[i].radius * 2);
      }
    }

    // Verify 6-digit roll number grid
    assert.equal(geom.rollGrid.columns, 6);
    assert.equal(geom.rollGrid.bubbles.length, 60); // 6 cols x 10 digits
  });

  test('calculates correct geometry for 100-Question and 20-Question presets', () => {
    const geom100 = calculateTemplateGeometry({ code: 'A4_100Q_4OPT_V1' });
    assert.equal(geom100.totalQuestions, 100);
    assert.equal(geom100.questions.length, 100);

    const geom20 = calculateTemplateGeometry({ code: 'A4_20Q_4OPT_V1' });
    assert.equal(geom20.totalQuestions, 20);
    assert.equal(geom20.questions.length, 20);
  });

  test('generates valid SVG sheet containing required elements', () => {
    const svg = generateSheetSvg({
      schoolName: 'Greenwood High International',
      examTitle: 'Mid-Term Science Exam',
      sheetId: 'SHT-TEST-9988',
      examId: 'EXAM-SCI-01'
    });

    assert.ok(svg.includes('<svg'));
    assert.ok(svg.includes('Greenwood High International'));
    assert.ok(svg.includes('Mid-Term Science Exam'));
    assert.ok(svg.includes('SHT-TEST-9988'));
    assert.ok(svg.includes('CANDIDATE RESPONSES'));
    assert.ok(svg.includes('ROLL NUMBER'));
    assert.ok(svg.endsWith('</svg>'));
  });
});

describe('OMR Vision Engine (Engine B)', () => {
  test('correctly identifies sharp, blurry, and dark images in scan quality assessment', () => {
    const width = 100;
    const height = 100;

    // 1. Crisp high-contrast pattern (checkerboard / edges)
    const sharpBuffer = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        sharpBuffer[y * width + x] = (Math.floor(x / 10) + Math.floor(y / 10)) % 2 === 0 ? 240 : 20;
      }
    }
    const sharpQuality = assessScanQuality(sharpBuffer, width, height);
    assert.equal(sharpQuality.status, QUALITY_STATUS.GOOD);
    assert.equal(sharpQuality.metrics.isBlurry, false);

    // 2. Extremely dark buffer
    const darkBuffer = Buffer.alloc(width * height, 30);
    const darkQuality = assessScanQuality(darkBuffer, width, height);
    assert.ok(darkQuality.metrics.isDark);

    // 3. Flat blurry image (low variance)
    const blurryBuffer = Buffer.alloc(width * height, 180);
    const blurryQuality = assessScanQuality(blurryBuffer, width, height);
    assert.ok(blurryQuality.metrics.isBlurry || blurryQuality.metrics.isLowContrast);
  });

  test('distinguishes filled bubble from empty and ambiguous bubble', () => {
    const imgW = 80;
    const imgH = 80;
    const cx = 40;
    const cy = 40;
    const r = 15;

    // 1. Completely white paper with empty circle outline
    const emptyBuf = Buffer.alloc(imgW * imgH, 230); // paper white 230
    // draw circle outline
    for (let angle = 0; angle < 360; angle += 2) {
      const rad = (angle * Math.PI) / 180;
      const px = Math.round(cx + r * Math.cos(rad));
      const py = Math.round(cy + r * Math.sin(rad));
      emptyBuf[py * imgW + px] = 40;
    }
    const emptySample = sampleBubbleFill(emptyBuf, imgW, imgH, cx, cy, r);
    assert.equal(emptySample.status, BUBBLE_STATUS.EMPTY);
    assert.ok(emptySample.fillRatio < 0.20);

    // 2. Fully inked black filled bubble
    const filledBuf = Buffer.alloc(imgW * imgH, 230);
    for (let y = 0; y < imgH; y++) {
      for (let x = 0; x < imgW; x++) {
        const dSq = (x - cx) ** 2 + (y - cy) ** 2;
        if (dSq <= r * r) {
          filledBuf[y * imgW + x] = 20; // jet black ink
        }
      }
    }
    const filledSample = sampleBubbleFill(filledBuf, imgW, imgH, cx, cy, r);
    assert.equal(filledSample.status, BUBBLE_STATUS.FILLED);
    assert.ok(filledSample.fillRatio >= 0.85);
    assert.ok(filledSample.compositeMetric >= 75);

    // 3. Light mark / faint pencil
    const lightBuf = Buffer.alloc(imgW * imgH, 230);
    for (let y = 0; y < imgH; y++) {
      for (let x = 0; x < imgW; x++) {
        const dSq = (x - cx) ** 2 + (y - cy) ** 2;
        if (dSq <= (r * 0.6) ** 2) {
          lightBuf[y * imgW + x] = 160; // faint gray
        }
      }
    }
    const lightSample = sampleBubbleFill(lightBuf, imgW, imgH, cx, cy, r);
    assert.ok(lightSample.status === BUBBLE_STATUS.AMBIGUOUS || lightSample.fillRatio < 0.40);
  });

  test('projects canonical coordinates correctly under simulated quadrilateral perspective', () => {
    const corners = {
      topLeft: { x: 50, y: 50 },
      topRight: { x: 950, y: 70 },
      bottomLeft: { x: 40, y: 1350 },
      bottomRight: { x: 960, y: 1360 }
    };

    const origin = projectCanonicalPoint(0, 0, corners);
    assert.equal(origin.x, 50);
    assert.equal(origin.y, 50);

    const bottomEnd = projectCanonicalPoint(1, 1, corners);
    assert.equal(bottomEnd.x, 960);
    assert.equal(bottomEnd.y, 1360);

    const center = projectCanonicalPoint(0.5, 0.5, corners);
    assert.ok(center.x > 450 && center.x < 550);
    assert.ok(center.y > 650 && center.y < 750);
  });
});

describe('OMR Evaluation Engine (Engine C)', () => {
  const answerKey = [
    { question_number: 1, correct_option: 'B', weightage: 2.0, negative_weightage: 0.5 },
    { question_number: 2, correct_option: 'A', weightage: 2.0, negative_weightage: 0.5 },
    { question_number: 3, correct_option: 'C', weightage: 2.0, negative_weightage: 0.5 },
    { question_number: 4, correct_option: 'D', weightage: 2.0, negative_weightage: 0.5 },
    { question_number: 5, correct_option: 'B', weightage: 2.0, negative_weightage: 0.5 }
  ];

  test('calculates correct marks with positive and negative marking', () => {
    const detectedAnswers = [
      { questionNumber: 1, detectedOption: 'B', confidence: 95 }, // Correct (+2)
      { questionNumber: 2, detectedOption: 'A', confidence: 92 }, // Correct (+2)
      { questionNumber: 3, detectedOption: 'D', confidence: 88 }, // Wrong (-0.5)
      { questionNumber: 4, detectedOption: 'BLANK', isBlank: true, confidence: 98 }, // Blank (0)
      { questionNumber: 5, detectedOption: 'MULTIPLE', isMultiple: true, confidence: 45 } // Multiple (0 or neg)
    ];

    const result = evaluateAnswers({
      detectedAnswers,
      answerKeyQuestions: answerKey,
      markingConfig: {
        positive_marks_per_question: 2.0,
        negative_marks_per_question: 0.5,
        blank_marks_per_question: 0.0,
        multiple_answer_behavior: 'invalid'
      }
    });

    assert.equal(result.correctCount, 2);
    assert.equal(result.wrongCount, 1);
    assert.equal(result.blankCount, 1);
    assert.equal(result.multipleCount, 1);
    assert.equal(result.totalScore, 3.5); // 2 + 2 - 0.5 = 3.5
    assert.equal(result.maxPossibleScore, 10.0);
    assert.equal(result.percentage, 35.0);
  });

  test('penalizes multiple answers when configured for negative penalty', () => {
    const detectedAnswers = [
      { questionNumber: 1, detectedOption: 'B', confidence: 95 }, // Correct (+2)
      { questionNumber: 2, detectedOption: 'MULTIPLE', isMultiple: true, confidence: 45 } // Multiple (-0.5)
    ];

    const result = evaluateAnswers({
      detectedAnswers,
      answerKeyQuestions: answerKey.slice(0, 2),
      markingConfig: {
        positive_marks_per_question: 2.0,
        negative_marks_per_question: 0.5,
        multiple_answer_behavior: 'negative'
      }
    });

    assert.equal(result.correctCount, 1);
    assert.equal(result.multipleCount, 1);
    assert.equal(result.totalScore, 1.5); // 2 - 0.5 = 1.5
  });

  test('respects manual teacher overrides over automated vision detection', () => {
    const detectedAnswers = [
      {
        questionNumber: 1,
        detectedOption: 'C', // Vision detected C (wrong)
        manualOverrideOption: 'B', // Teacher manually verified B
        confidence: 60
      }
    ];

    const result = evaluateAnswers({
      detectedAnswers,
      answerKeyQuestions: answerKey.slice(0, 1)
    });

    assert.equal(result.correctCount, 1);
    assert.equal(result.evaluatedAnswers[0].isCorrect, true);
    assert.equal(result.evaluatedAnswers[0].effectiveOption, 'B');
  });
});

describe('End-to-End Synthetic OMR Vision & Evaluation Integration', () => {
  test('renders synthetic OMR SVG, rasters to PNG buffer, and executes full vision pipeline', async () => {
    // 1. Generate clean SVG for 20-question sheet
    const geom = calculateTemplateGeometry({ code: 'A4_20Q_4OPT_V1' });

    // Target answers to ink:
    // Q1 -> B, Q2 -> C, Q3 -> A, Q4 -> D, Q5..Q20 -> BLANK
    const targetInks = [
      { q: 1, opt: 'B' },
      { q: 2, opt: 'C' },
      { q: 3, opt: 'A' },
      { q: 4, opt: 'D' }
    ];

    let svg = generateSheetSvg({
      schoolName: 'Integration Test Academy',
      examTitle: 'Autonomous OMR Test',
      sheetId: 'SHT-TEST-AUTO-01',
      templateCode: 'A4_20Q_4OPT_V1',
      rollNumber: '102030'
    });

    // Ink the bubbles directly in SVG: replace white fill with black for target bubbles
    for (const ink of targetInks) {
      const q = geom.questions.find(item => item.questionNumber === ink.q);
      const b = q.bubbles.find(item => item.option === ink.opt);
      const filledCircle = `<circle cx="${b.cx}" cy="${b.cy}" r="${b.radius}" fill="#111827" stroke="#111827" stroke-width="1.3"/>`;
      svg = svg.replace('</svg>', `${filledCircle}\n</svg>`);
    }

    // Also ink the roll number: col 0 -> 1, col 1 -> 0, col 2 -> 2, col 3 -> 0, col 4 -> 3, col 5 -> 0 (102030)
    const rollDigits = [1, 0, 2, 0, 3, 0];
    rollDigits.forEach((digit, col) => {
      const b = geom.rollGrid.bubbles.find(item => item.col === col && item.digit === digit);
      if (b) {
        const filledRollCircle = `<circle cx="${b.cx}" cy="${b.cy}" r="${b.radius}" fill="#111827" stroke="#111827" stroke-width="1.2"/>`;
        svg = svg.replace('</svg>', `${filledRollCircle}\n</svg>`);
      }
    });

    // 2. Convert SVG to PNG buffer with Sharp
    const pngBuffer = await sharp(Buffer.from(svg))
      .png()
      .toBuffer();

    assert.ok(pngBuffer.length > 1000);

    // 3. Run Vision Processing Pipeline
    const visionResult = await processOmrImage(pngBuffer, {
      templateCode: 'A4_20Q_4OPT_V1'
    });

    assert.equal(visionResult.quality.status, QUALITY_STATUS.GOOD);
    assert.equal(visionResult.detectedRollNumber, 102030);

    // Verify detected answers
    const q1 = visionResult.answers.find(a => a.questionNumber === 1);
    const q2 = visionResult.answers.find(a => a.questionNumber === 2);
    const q3 = visionResult.answers.find(a => a.questionNumber === 3);
    const q4 = visionResult.answers.find(a => a.questionNumber === 4);
    const q5 = visionResult.answers.find(a => a.questionNumber === 5);

    assert.equal(q1.detectedOption, 'B');
    assert.equal(q2.detectedOption, 'C');
    assert.equal(q3.detectedOption, 'A');
    assert.equal(q4.detectedOption, 'D');
    assert.equal(q5.detectedOption, 'BLANK');

    assert.ok(q1.confidence >= 80);
    assert.ok(q2.confidence >= 80);
    assert.ok(q3.confidence >= 80);
    assert.ok(q4.confidence >= 80);

    // 4. Run Evaluation against Master Answer Key
    const testKey = [
      { question_number: 1, correct_option: 'B', weightage: 1.0 },
      { question_number: 2, correct_option: 'C', weightage: 1.0 },
      { question_number: 3, correct_option: 'A', weightage: 1.0 },
      { question_number: 4, correct_option: 'D', weightage: 1.0 },
      { question_number: 5, correct_option: 'A', weightage: 1.0 }
    ];

    const evalResult = evaluateAnswers({
      detectedAnswers: visionResult.answers,
      answerKeyQuestions: testKey,
      markingConfig: { positive_marks_per_question: 1.0 }
    });

    assert.equal(evalResult.correctCount, 4); // Q1-Q4 correct
    assert.equal(evalResult.blankCount, 16); // Q5-Q20 blank
    assert.equal(evalResult.totalScore, 4.0);
  });
});

describe('OMR QR payload and sheet identity', () => {
  test('encodes safe metadata and rejects incomplete payloads', async () => {
    const { encodeOmrQrPayload, decodeOmrQrPayload, generateSheetId, validateQrAgainstExam } = await import('../services/omr/omrQr.js');
    const raw = encodeOmrQrPayload({
      examId: 'exam-1',
      sheetId: 'SHT-ABC',
      templateId: 'tpl-1',
      templateVersion: 2,
    });
    assert.equal(raw.includes('exam-1'), true);
    assert.equal(raw.includes('name'), false);

    const decoded = decodeOmrQrPayload(raw);
    assert.equal(decoded.examId, 'exam-1');
    assert.equal(decoded.sheetId, 'SHT-ABC');
    assert.equal(decodeOmrQrPayload('not-json'), null);
    assert.equal(decodeOmrQrPayload('{"foo":1}'), null);

    const idA = generateSheetId({ schoolId: 12, omrExamId: 'exam-1', studentEnrollmentId: 'enr-1' });
    const idB = generateSheetId({ schoolId: 12, omrExamId: 'exam-1', studentEnrollmentId: 'enr-1' });
    const idC = generateSheetId({ schoolId: 13, omrExamId: 'exam-1', studentEnrollmentId: 'enr-1' });
    assert.equal(idA, idB);
    assert.notEqual(idA, idC);

    const mismatch = validateQrAgainstExam(decoded, { id: 'other-exam', template_id: 'tpl-1' });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, 'EXAM_MISMATCH');
  });
});

describe('Bubble classification (deterministic)', () => {
  test('detects blank, filled, multiple, and ambiguous states', () => {
    const blank = classifyQuestionBubbles([
      { option: 'A', compositeMetric: 4, fillRatio: 0.02, status: BUBBLE_STATUS.EMPTY },
      { option: 'B', compositeMetric: 5, fillRatio: 0.03, status: BUBBLE_STATUS.EMPTY },
      { option: 'C', compositeMetric: 3, fillRatio: 0.01, status: BUBBLE_STATUS.EMPTY },
      { option: 'D', compositeMetric: 4, fillRatio: 0.02, status: BUBBLE_STATUS.EMPTY },
    ]);
    assert.equal(blank.detectedOption, 'BLANK');
    assert.equal(blank.isBlank, true);
    assert.ok(blank.confidence >= 90);

    const filled = classifyQuestionBubbles([
      { option: 'A', compositeMetric: 8, fillRatio: 0.05, status: BUBBLE_STATUS.EMPTY },
      { option: 'B', compositeMetric: 88, fillRatio: 0.92, status: BUBBLE_STATUS.FILLED },
      { option: 'C', compositeMetric: 6, fillRatio: 0.04, status: BUBBLE_STATUS.EMPTY },
      { option: 'D', compositeMetric: 7, fillRatio: 0.05, status: BUBBLE_STATUS.EMPTY },
    ]);
    assert.equal(filled.detectedOption, 'B');
    assert.equal(filled.isMultiple, false);
    assert.ok(filled.confidence >= 80);

    const multiple = classifyQuestionBubbles([
      { option: 'A', compositeMetric: 10, fillRatio: 0.04, status: BUBBLE_STATUS.EMPTY },
      { option: 'B', compositeMetric: 80, fillRatio: 0.8, status: BUBBLE_STATUS.FILLED },
      { option: 'C', compositeMetric: 78, fillRatio: 0.77, status: BUBBLE_STATUS.FILLED },
      { option: 'D', compositeMetric: 8, fillRatio: 0.03, status: BUBBLE_STATUS.EMPTY },
    ]);
    assert.equal(multiple.detectedOption, 'MULTIPLE');
    assert.equal(multiple.isMultiple, true);
  });
});

describe('True/False template geometry', () => {
  test('builds 25 T/F questions with two option bubbles', () => {
    const geom = calculateTemplateGeometry({ code: 'A4_25Q_TF_V1' });
    assert.equal(geom.totalQuestions, 25);
    assert.equal(geom.optionsCount, 2);
    assert.deepEqual(geom.options, ['T', 'F']);
    assert.equal(geom.questions[0].bubbles.length, 2);
  });
});

describe('Reproducible vision fixtures', () => {
  test('fixture_001 yields expected answers without a camera', async () => {
    const { renderOmrFixture } = await import('../services/omr/omrFixtureFactory.js');
    const { spec, buffer } = await renderOmrFixture('fixture_001');
    const visionResult = await processOmrImage(buffer, { templateCode: spec.templateCode });
    assert.equal(visionResult.quality.status, QUALITY_STATUS.GOOD);
    assert.equal(visionResult.answers.find((a) => a.questionNumber === 1).detectedOption, 'B');
    assert.equal(visionResult.answers.find((a) => a.questionNumber === 2).detectedOption, 'C');
    assert.equal(visionResult.answers.find((a) => a.questionNumber === 3).detectedOption, 'A');
    assert.equal(visionResult.answers.find((a) => a.questionNumber === 4).detectedOption, 'D');
    assert.equal(visionResult.answers.find((a) => a.questionNumber === 5).detectedOption, 'BLANK');
  });
});
