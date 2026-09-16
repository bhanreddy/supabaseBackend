/**
 * SchoolIMS — OMR Template Engine (Engine A)
 * Defines parametric physical OMR sheet layouts, registration fiducials,
 * student admission-number matrices, QR header specifications, and printable SVG/HTML.
 */

export const TEMPLATE_PRESETS = {
  A4_20Q_4OPT: {
    code: 'A4_20Q_4OPT_V1',
    name: 'Quick Assessment 20-Question MCQ',
    totalQuestions: 20,
    optionsPerQuestion: 4,
    options: ['A', 'B', 'C', 'D'],
    answerType: 'mcq_single',
    layoutType: 'portrait',
    pageSize: 'A4',
    dimensions: { width: 1654, height: 2338 }, // A4 at 200 DPI
    columns: 1,
    questionsPerColumn: 20,
    hasRollNumberGrid: true,
    rollNumberDigits: 6,
    hasQrHeader: true,
    markers: {
      size: 50,
      margin: 60,
      type: 'concentric_square'
    },
    bubble: {
      radius: 18,
      optionSpacing: 58,
      questionSpacing: 52
    }
  },
  A4_50Q_4OPT: {
    code: 'A4_50Q_4OPT_V1',
    name: 'Standard 50-Question MCQ (4 Options)',
    totalQuestions: 50,
    optionsPerQuestion: 4,
    options: ['A', 'B', 'C', 'D'],
    answerType: 'mcq_single',
    layoutType: 'portrait',
    pageSize: 'A4',
    dimensions: { width: 1654, height: 2338 },
    columns: 2,
    questionsPerColumn: 25,
    hasRollNumberGrid: true,
    rollNumberDigits: 6,
    hasQrHeader: true,
    markers: {
      size: 48,
      margin: 60,
      type: 'concentric_square'
    },
    bubble: {
      radius: 16,
      optionSpacing: 50,
      questionSpacing: 44
    }
  },
  A4_100Q_4OPT: {
    code: 'A4_100Q_4OPT_V1',
    name: 'Standard 100-Question MCQ (4 Options)',
    totalQuestions: 100,
    optionsPerQuestion: 4,
    options: ['A', 'B', 'C', 'D'],
    answerType: 'mcq_single',
    layoutType: 'portrait',
    pageSize: 'A4',
    dimensions: { width: 1654, height: 2338 },
    columns: 4,
    questionsPerColumn: 25,
    hasRollNumberGrid: true,
    rollNumberDigits: 6,
    hasQrHeader: true,
    markers: {
      size: 44,
      margin: 60,
      type: 'concentric_square'
    },
    bubble: {
      radius: 14,
      optionSpacing: 42,
      questionSpacing: 42
    }
  },
  A4_50Q_5OPT: {
    code: 'A4_50Q_5OPT_V1',
    name: 'Competitive Exam 50-Question MCQ (5 Options)',
    totalQuestions: 50,
    optionsPerQuestion: 5,
    options: ['A', 'B', 'C', 'D', 'E'],
    answerType: 'mcq_single',
    layoutType: 'portrait',
    pageSize: 'A4',
    dimensions: { width: 1654, height: 2338 },
    columns: 2,
    questionsPerColumn: 25,
    hasRollNumberGrid: true,
    rollNumberDigits: 6,
    hasQrHeader: true,
    markers: {
      size: 48,
      margin: 60,
      type: 'concentric_square'
    },
    bubble: {
      radius: 15,
      optionSpacing: 46,
      questionSpacing: 44
    }
  },
  A4_25Q_TF: {
    code: 'A4_25Q_TF_V1',
    name: 'True/False 25-Question Sheet',
    totalQuestions: 25,
    optionsPerQuestion: 2,
    options: ['T', 'F'],
    answerType: 'true_false',
    layoutType: 'portrait',
    pageSize: 'A4',
    dimensions: { width: 1654, height: 2338 },
    columns: 1,
    questionsPerColumn: 25,
    hasRollNumberGrid: true,
    rollNumberDigits: 6,
    hasQrHeader: true,
    markers: {
      size: 48,
      margin: 60,
      type: 'concentric_square'
    },
    bubble: {
      radius: 17,
      optionSpacing: 70,
      questionSpacing: 48
    }
  }
};

export function resolveTemplatePreset(templateConfig = {}) {
  const code = templateConfig.code || templateConfig.templateCode;
  return Object.values(TEMPLATE_PRESETS).find((p) => p.code === code)
    || TEMPLATE_PRESETS[code]
    || TEMPLATE_PRESETS.A4_50Q_4OPT;
}

/**
 * Calculates complete pixel coordinates for every element on the OMR sheet
 * based on template parameters.
 */
export function calculateTemplateGeometry(templateConfig) {
  const preset = resolveTemplatePreset(templateConfig);
  const config = { ...preset, ...templateConfig };
  if (!config.dimensions) {
    config.dimensions = config.layoutType === 'landscape'
      ? { width: 2338, height: 1654 }
      : { width: 1654, height: 2338 };
  }

  const { width, height } = config.dimensions;
  const margin = config.markers.margin;
  const markerSize = config.markers.size;
  const contentLeft = margin + markerSize + 28;
  const contentRight = width - margin - markerSize - 28;
  const contentWidth = contentRight - contentLeft;
  const footerY = height - margin - markerSize - 28;

  // 1. Four corner registration markers
  const markers = {
    topLeft: { x: margin + markerSize / 2, y: margin + markerSize / 2, size: markerSize },
    topRight: { x: width - margin - markerSize / 2, y: margin + markerSize / 2, size: markerSize },
    bottomLeft: { x: margin + markerSize / 2, y: height - margin - markerSize / 2, size: markerSize },
    bottomRight: { x: width - margin - markerSize / 2, y: height - margin - markerSize / 2, size: markerSize }
  };

  // 2. Header & QR Area
  const qrSize = 92;
  const header = {
    x: contentLeft,
    y: margin + 8,
    width: contentWidth,
    height: 108,
    qr: {
      x: contentRight - qrSize,
      y: margin + 8,
      size: qrSize
    }
  };

  // 3. Admission Number Matrix Area
  const digits = config.rollNumberDigits || 6;
  const rollColSpacing = 44;
  const rollRowSpacing = 34;
  const rollBubbleRadius = 13;
  const rollHeaderH = 38;
  const rollPadX = 36;
  const rollGrid = {
    x: contentLeft,
    y: header.y + header.height + 18,
    columns: digits,
    rows: 10,
    colSpacing: rollColSpacing,
    rowSpacing: rollRowSpacing,
    bubbleRadius: rollBubbleRadius,
    headerHeight: rollHeaderH,
    width: Math.max(292, digits * rollColSpacing + rollPadX),
    height: rollHeaderH + 18 + 9 * rollRowSpacing + rollBubbleRadius + 18
  };

  const rollInnerWidth = (rollGrid.columns - 1) * rollGrid.colSpacing;
  const rollStartX = rollGrid.x + (rollGrid.width - rollInnerWidth) / 2;
  const rollStartY = rollGrid.y + rollHeaderH + 18;

  const rollBubbles = [];
  for (let col = 0; col < rollGrid.columns; col++) {
    for (let digit = 0; digit <= 9; digit++) {
      rollBubbles.push({
        col,
        digit,
        cx: rollStartX + col * rollGrid.colSpacing,
        cy: rollStartY + digit * rollGrid.rowSpacing,
        radius: rollGrid.bubbleRadius
      });
    }
  }

  // 4. Questions Section Geometry — always starts below identity boxes + answers header
  const answersHeaderH = 88;
  const answersBoxY = rollGrid.y + rollGrid.height + 20;
  const answersBoxH = Math.max(220, footerY - answersBoxY);
  const questionsStartY = answersBoxY + answersHeaderH;
  const lastQuestionY = footerY - 16;
  const questionRows = Math.max(1, config.questionsPerColumn);
  const availableQuestionSpan = lastQuestionY - questionsStartY;
  const minQuestionSpacing = config.bubble.radius * 2 + 12;
  const naturalSpacing = questionRows <= 1
    ? minQuestionSpacing
    : availableQuestionSpan / (questionRows - 1);
  const questionSpacing = Math.max(minQuestionSpacing, Math.min(naturalSpacing, 62));
  const bubbleRadius = Math.min(config.bubble.radius, questionSpacing * 0.38);
  const columnWidth = contentWidth / config.columns;
  const labelWidth = 52;
  const optionSpacing = Math.max(config.bubble.optionSpacing, bubbleRadius * 2 + 16);

  const questions = [];
  const options = config.options || ['A', 'B', 'C', 'D'];

  for (let q = 1; q <= config.totalQuestions; q++) {
    const colIndex = Math.floor((q - 1) / config.questionsPerColumn);
    const rowIndex = (q - 1) % config.questionsPerColumn;

    const colStartX = contentLeft + colIndex * columnWidth;
    const qY = questionsStartY + rowIndex * questionSpacing;
    const optionsStartX = colStartX + labelWidth;

    const optionBubbles = [];
    for (let optIdx = 0; optIdx < options.length; optIdx++) {
      optionBubbles.push({
        option: options[optIdx],
        cx: optionsStartX + optIdx * optionSpacing,
        cy: qY,
        radius: bubbleRadius
      });
    }

    questions.push({
      questionNumber: q,
      column: colIndex,
      row: rowIndex,
      labelX: colStartX + labelWidth - 12,
      labelY: qY + 5,
      bubbles: optionBubbles
    });
  }

  return {
    dimensions: { width, height },
    markers,
    header,
    rollGrid: { ...rollGrid, bubbles: rollBubbles },
    answers: {
      x: contentLeft,
      y: answersBoxY,
      width: contentWidth,
      height: answersBoxH,
      headerHeight: answersHeaderH,
      questionsStartY,
      questionSpacing,
      columnWidth
    },
    questions,
    totalQuestions: config.totalQuestions,
    optionsCount: options.length,
    options
  };
}

/**
 * Generates an ultra-crisp, printable SVG string of the OMR sheet
 */
export function generateSheetSvg({
  schoolName = 'SCHOOLIMS DEMONSTRATION ACADEMY',
  examTitle = 'MATHEMATICS FORMATIVE ASSESSMENT (FA-2)',
  sheetId = 'SHT-1001-DEMO',
  examId = 'EXAM-DEMO-01',
  templateCode = 'A4_50Q_4OPT_V1',
  qrDataUrl = null,
  studentName = '',
  rollNumber = '',
  admissionNumber = ''
}) {
  const geom = calculateTemplateGeometry({ code: templateCode });
  const { width, height } = geom.dimensions;
  const inkedId = String(admissionNumber || rollNumber || '');

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .title { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 34px; font-weight: 700; fill: #111827; text-anchor: middle; }
    .subtitle { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 18px; font-weight: 500; fill: #4B5563; text-anchor: middle; }
    .meta-line { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 500; fill: #9CA3AF; text-anchor: middle; letter-spacing: 0.8px; }
    .meta-label { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; fill: #6B7280; }
    .meta-val { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 16px; font-weight: 600; fill: #111827; }
    .sec-title { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 700; fill: #6B7280; letter-spacing: 1.2px; }
    .q-num { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 16px; font-weight: 600; fill: #374151; text-anchor: end; }
    .b-label { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 600; fill: #4B5563; text-anchor: middle; dominant-baseline: central; }
    .opt-head { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 700; fill: #9CA3AF; text-anchor: middle; }
    .roll-digit-label { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 12px; font-weight: 600; fill: #6B7280; text-anchor: middle; dominant-baseline: central; }
    .hint { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 400; fill: #6B7280; }
    .frame { fill: none; stroke: #E5E7EB; stroke-width: 1.25; }
    .marker { fill: #111827; }
  </style>

  <rect width="${width}" height="${height}" fill="#FFFFFF"/>
`;

  const markerPositions = [geom.markers.topLeft, geom.markers.topRight, geom.markers.bottomLeft, geom.markers.bottomRight];
  markerPositions.forEach((m) => {
    const s = m.size;
    const h = s / 2;
    svg += `  <rect x="${m.x - h}" y="${m.y - h}" width="${s}" height="${s}" class="marker"/>\n`;
    svg += `  <rect x="${m.x - h * 0.55}" y="${m.y - h * 0.55}" width="${s * 0.55}" height="${s * 0.55}" fill="#FFFFFF"/>\n`;
    svg += `  <rect x="${m.x - h * 0.25}" y="${m.y - h * 0.25}" width="${s * 0.25}" height="${s * 0.25}" class="marker"/>\n`;
  });

  const headerCenterX = (geom.header.x + geom.header.qr.x - 24) / 2;
  svg += `  <text x="${headerCenterX}" y="${geom.header.y + 38}" class="title">${escapeXml(schoolName)}</text>\n`;
  svg += `  <line x1="${headerCenterX - 210}" y1="${geom.header.y + 50}" x2="${headerCenterX + 210}" y2="${geom.header.y + 50}" stroke="#E5E7EB" stroke-width="1"/>\n`;
  svg += `  <text x="${headerCenterX}" y="${geom.header.y + 76}" class="subtitle">${escapeXml(examTitle)}</text>\n`;
  svg += `  <text x="${headerCenterX}" y="${geom.header.y + 98}" class="meta-line">OFFICIAL OMR SHEET · DO NOT FOLD</text>\n`;

  if (qrDataUrl) {
    svg += `  <image href="${qrDataUrl}" x="${geom.header.qr.x}" y="${geom.header.qr.y}" width="${geom.header.qr.size}" height="${geom.header.qr.size}"/>\n`;
  } else {
    svg += `  <rect x="${geom.header.qr.x}" y="${geom.header.qr.y}" width="${geom.header.qr.size}" height="${geom.header.qr.size}" rx="4" fill="#FAFAFA" stroke="#E5E7EB" stroke-width="1"/>\n`;
    svg += `  <text x="${geom.header.qr.x + geom.header.qr.size / 2}" y="${geom.header.qr.y + geom.header.qr.size / 2}" font-family="Helvetica, Arial" font-size="11px" fill="#9CA3AF" text-anchor="middle" dominant-baseline="central">QR</text>\n`;
  }
  svg += `  <text x="${geom.header.qr.x + geom.header.qr.size / 2}" y="${geom.header.qr.y + geom.header.qr.size + 16}" font-family="Helvetica, Arial" font-size="11px" fill="#9CA3AF" text-anchor="middle">${escapeXml(sheetId)}</text>\n`;

  const infoBoxY = geom.rollGrid.y;
  const infoBoxX = geom.rollGrid.x + geom.rollGrid.width + 24;
  const infoBoxW = geom.header.x + geom.header.width - infoBoxX;
  const infoBoxH = geom.rollGrid.height;

  svg += `  <rect x="${infoBoxX}" y="${infoBoxY}" width="${infoBoxW}" height="${infoBoxH}" rx="6" class="frame"/>\n`;
  svg += `  <text x="${infoBoxX + 18}" y="${infoBoxY + 28}" class="sec-title">STUDENT DETAILS</text>\n`;
  svg += `  <line x1="${infoBoxX + 18}" y1="${infoBoxY + 38}" x2="${infoBoxX + infoBoxW - 18}" y2="${infoBoxY + 38}" stroke="#F3F4F6" stroke-width="1"/>\n`;

  svg += `  <text x="${infoBoxX + 18}" y="${infoBoxY + 68}" class="meta-label">Candidate name</text>\n`;
  svg += `  <line x1="${infoBoxX + 18}" y1="${infoBoxY + 92}" x2="${infoBoxX + infoBoxW - 18}" y2="${infoBoxY + 92}" stroke="#D1D5DB" stroke-width="1"/>\n`;
  if (studentName) {
    svg += `  <text x="${infoBoxX + 18}" y="${infoBoxY + 86}" class="meta-val">${escapeXml(studentName)}</text>\n`;
  }

  svg += `  <text x="${infoBoxX + 18}" y="${infoBoxY + 122}" class="meta-label">Exam / code</text>\n`;
  svg += `  <text x="${infoBoxX + 18}" y="${infoBoxY + 144}" class="meta-val">${escapeXml(examId)}</text>\n`;

  svg += `  <text x="${infoBoxX + 18}" y="${infoBoxY + 180}" class="meta-label">Instructions</text>\n`;
  svg += `  <text x="${infoBoxX + 18}" y="${infoBoxY + 204}" class="hint">Use a blue or black ballpoint pen, or a 2B pencil.</text>\n`;
  svg += `  <text x="${infoBoxX + 18}" y="${infoBoxY + 226}" class="hint">Darken the circle fully. Do not tick, cross, or leave a light mark.</text>\n`;
  svg += `  <text x="${infoBoxX + 18}" y="${infoBoxY + 248}" class="hint">Keep corner markers and the QR area clear of stray marks.</text>\n`;
  svg += `  <text x="${infoBoxX + 18}" y="${infoBoxY + 270}" class="hint">If you erase, remove the mark completely before filling another option.</text>\n`;

  svg += `  <rect x="${geom.rollGrid.x}" y="${geom.rollGrid.y}" width="${geom.rollGrid.width}" height="${geom.rollGrid.height}" rx="6" class="frame"/>\n`;
  svg += `  <text x="${geom.rollGrid.x + geom.rollGrid.width / 2}" y="${geom.rollGrid.y + 26}" class="sec-title" text-anchor="middle">ADMISSION NUMBER</text>\n`;
  svg += `  <line x1="${geom.rollGrid.x + 16}" y1="${geom.rollGrid.y + 36}" x2="${geom.rollGrid.x + geom.rollGrid.width - 16}" y2="${geom.rollGrid.y + 36}" stroke="#F3F4F6" stroke-width="1"/>\n`;

  geom.rollGrid.bubbles.forEach((b) => {
    svg += `  <circle cx="${b.cx}" cy="${b.cy}" r="${b.radius}" fill="#FFFFFF" stroke="#9CA3AF" stroke-width="1.15"/>\n`;
    svg += `  <text x="${b.cx}" y="${b.cy}" class="roll-digit-label">${b.digit}</text>\n`;
  });

  const answers = geom.answers;
  svg += `  <rect x="${answers.x}" y="${answers.y}" width="${answers.width}" height="${answers.height}" rx="6" class="frame"/>\n`;
  svg += `  <text x="${answers.x + 18}" y="${answers.y + 26}" class="sec-title">ANSWERS</text>\n`;
  svg += `  <line x1="${answers.x + 18}" y1="${answers.y + 36}" x2="${answers.x + answers.width - 18}" y2="${answers.y + 36}" stroke="#F3F4F6" stroke-width="1"/>\n`;

  const firstByColumn = new Map();
  geom.questions.forEach((q) => {
    if (!firstByColumn.has(q.column)) firstByColumn.set(q.column, q);
  });
  for (let col = 1; col < firstByColumn.size; col += 1) {
    const x = answers.x + col * answers.columnWidth;
    svg += `  <line x1="${x}" y1="${answers.y + 44}" x2="${x}" y2="${answers.y + answers.height - 16}" stroke="#F3F4F6" stroke-width="1"/>\n`;
  }
  firstByColumn.forEach((q) => {
    q.bubbles.forEach((b) => {
      svg += `  <text x="${b.cx}" y="${answers.y + 56}" class="opt-head">${b.option}</text>\n`;
    });
  });

  geom.questions.forEach((q) => {
    svg += `  <text x="${q.labelX}" y="${q.labelY}" class="q-num">${q.questionNumber}.</text>\n`;
    q.bubbles.forEach((b) => {
      svg += `  <circle cx="${b.cx}" cy="${b.cy}" r="${b.radius}" fill="#FFFFFF" stroke="#6B7280" stroke-width="1.2"/>\n`;
      svg += `  <text x="${b.cx}" y="${b.cy}" class="b-label">${b.option}</text>\n`;
    });
  });

  svg += `  <text x="${width / 2}" y="${height - geom.markers.bottomLeft.size - 22}" font-family="Helvetica, Arial" font-size="12px" fill="#9CA3AF" text-anchor="middle">${escapeXml(schoolName)}  ·  ${geom.optionsCount}-option sheet  ·  ${escapeXml(sheetId)}</text>\n`;

  svg += `</svg>`;

  if (inkedId) {
    svg = inkBubblesIntoSvg(svg, geom, {
      rollDigits: parseRollDigits(inkedId, geom.rollGrid.columns),
    });
  }

  return svg;
}

/**
 * Wraps one or more scanner-aligned OMR SVGs into a print-ready A4 HTML document.
 * Each page is a full A4 sheet with the same fiducials, admission-number grid, and bubbles
 * the staff OMR scanner expects.
 */
export function wrapOmrSheetsForPrint({ schoolName = 'School', examTitle = 'OMR Assessment', sheets = [] } = {}) {
  const pages = (Array.isArray(sheets) ? sheets : [])
    .map((svg, index) => {
      const body = String(svg || '').replace(/^<\?xml[^>]*>\s*/i, '');
      return `<section class="omr-page" data-page="${index + 1}">${body}</section>`;
    })
    .join('\n');

  const safeSchool = escapeXml(schoolName);
  const safeTitle = escapeXml(examTitle);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${safeSchool} — ${safeTitle}</title>
  <style>
    @page { size: A4 portrait; margin: 0; }
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      color: #0f172a;
    }
    .omr-page {
      width: 210mm;
      height: 297mm;
      overflow: hidden;
      page-break-after: always;
      break-after: page;
    }
    .omr-page:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .omr-page svg {
      width: 210mm;
      height: 297mm;
      display: block;
    }
    @media print {
      html, body { background: #ffffff; }
      * {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
    }
  </style>
</head>
<body>
${pages}
</body>
</html>`;
}

function parseRollDigits(rollNumber, columns = 6) {
  const digits = String(rollNumber ?? '').replace(/\D/g, '');
  if (!digits) return [];
  return digits.padStart(columns, '0').slice(-columns).split('').map((d) => Number(d));
}

/**
 * Inks filled bubbles into an existing SVG string. Used by printable keys,
 * vision fixtures, and answer-key master sheets.
 * answers: { 1: 'B', 2: 'C' }  rollDigits: [1,0,2,0,3,0]
 */
export function inkBubblesIntoSvg(svg, geom, { answers = {}, rollDigits = [] } = {}) {
  let next = svg;
  Object.entries(answers).forEach(([qNum, opt]) => {
    const q = geom.questions.find((item) => item.questionNumber === Number(qNum));
    const b = q?.bubbles.find((item) => item.option === String(opt).toUpperCase());
    if (!b) return;
    next = next.replace(
      '</svg>',
      `<circle cx="${b.cx}" cy="${b.cy}" r="${b.radius}" fill="#111827" stroke="#111827" stroke-width="1.3"/>\n</svg>`
    );
  });
  (rollDigits || []).forEach((digit, col) => {
    if (digit == null || digit === '') return;
    const b = geom.rollGrid.bubbles.find((item) => item.col === col && item.digit === Number(digit));
    if (!b) return;
    next = next.replace(
      '</svg>',
      `<circle cx="${b.cx}" cy="${b.cy}" r="${b.radius}" fill="#111827" stroke="#111827" stroke-width="1.2"/>\n</svg>`
    );
  });
  return next;
}

function escapeXml(unsafe) {
  if (unsafe == null) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
