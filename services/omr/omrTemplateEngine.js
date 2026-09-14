/**
 * SchoolIMS — OMR Template Engine (Engine A)
 * Defines parametric physical OMR sheet layouts, registration fiducials,
 * student roll number matrices, QR header specifications, and printable SVG/HTML.
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
      optionSpacing: 56,
      questionSpacing: 48
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
      radius: 14,
      optionSpacing: 46,
      questionSpacing: 38
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
      radius: 12,
      optionSpacing: 36,
      questionSpacing: 34
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
      radius: 13,
      optionSpacing: 42,
      questionSpacing: 38
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
      radius: 16,
      optionSpacing: 64,
      questionSpacing: 42
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

  // 1. Four corner registration markers
  const markers = {
    topLeft: { x: margin + markerSize / 2, y: margin + markerSize / 2, size: markerSize },
    topRight: { x: width - margin - markerSize / 2, y: margin + markerSize / 2, size: markerSize },
    bottomLeft: { x: margin + markerSize / 2, y: height - margin - markerSize / 2, size: markerSize },
    bottomRight: { x: width - margin - markerSize / 2, y: height - margin - markerSize / 2, size: markerSize }
  };

  // 2. Header & QR Area
  const header = {
    x: margin + markerSize + 30,
    y: margin + 10,
    width: width - (margin + markerSize + 30) * 2,
    height: 140,
    qr: {
      x: width - margin - markerSize - 160,
      y: margin + 10,
      size: 130
    }
  };

  // 3. Roll Number Matrix Area
  const rollGrid = {
    x: margin + markerSize + 40,
    y: margin + 180,
    columns: config.rollNumberDigits || 6,
    rows: 10, // digits 0-9
    colSpacing: 38,
    rowSpacing: 32,
    bubbleRadius: 11,
    width: (config.rollNumberDigits || 6) * 38 + 20,
    height: 10 * 32 + 50
  };

  // Compute exact coordinates for each roll number bubble
  const rollBubbles = [];
  for (let col = 0; col < rollGrid.columns; col++) {
    for (let digit = 0; digit <= 9; digit++) {
      const cx = rollGrid.x + 30 + col * rollGrid.colSpacing;
      const cy = rollGrid.y + 40 + digit * rollGrid.rowSpacing;
      rollBubbles.push({
        col,
        digit,
        cx,
        cy,
        radius: rollGrid.bubbleRadius
      });
    }
  }

  // 4. Questions Section Geometry
  const questionsStartY = margin + 540;
  const availableWidth = width - (margin + markerSize + 30) * 2;
  const columnWidth = availableWidth / config.columns;

  const questions = [];
  const options = config.options || ['A', 'B', 'C', 'D'];

  for (let q = 1; q <= config.totalQuestions; q++) {
    const colIndex = Math.floor((q - 1) / config.questionsPerColumn);
    const rowIndex = (q - 1) % config.questionsPerColumn;

    const colStartX = margin + markerSize + 30 + colIndex * columnWidth;
    const qY = questionsStartY + rowIndex * config.bubble.questionSpacing;

    const optionBubbles = [];
    const optionsStartX = colStartX + 80;

    for (let optIdx = 0; optIdx < options.length; optIdx++) {
      const opt = options[optIdx];
      const optX = optionsStartX + optIdx * config.bubble.optionSpacing;
      optionBubbles.push({
        option: opt,
        cx: optX,
        cy: qY,
        radius: config.bubble.radius
      });
    }

    questions.push({
      questionNumber: q,
      column: colIndex,
      row: rowIndex,
      labelX: colStartX + 20,
      labelY: qY + 4,
      bubbles: optionBubbles
    });
  }

  return {
    dimensions: { width, height },
    markers,
    header,
    rollGrid: { ...rollGrid, bubbles: rollBubbles },
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
  rollNumber = ''
}) {
  const geom = calculateTemplateGeometry({ code: templateCode });
  const { width, height } = geom.dimensions;

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .title { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 24px; font-weight: 800; fill: #0F172A; text-anchor: middle; }
    .subtitle { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 16px; font-weight: 600; fill: #334155; text-anchor: middle; }
    .meta-label { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 12px; font-weight: 700; fill: #475569; }
    .meta-val { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 13px; font-weight: 600; fill: #0F172A; }
    .sec-title { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 14px; font-weight: 700; fill: #1E293B; letter-spacing: 1px; }
    .q-num { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 13px; font-weight: 700; fill: #1E293B; text-anchor: end; }
    .b-label { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11px; font-weight: 700; fill: #334155; text-anchor: middle; dominant-baseline: central; }
    .roll-digit-label { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 11px; font-weight: 600; fill: #64748B; text-anchor: middle; dominant-baseline: central; }
    .border-box { fill: none; stroke: #CBD5E1; stroke-width: 1.5; }
    .marker { fill: #000000; }
  </style>

  <!-- Background Paper -->
  <rect width="${width}" height="${height}" fill="#FFFFFF"/>
`;

  // Draw 4 Corner Registration Fiducials (Concentric Square Targets with Quiet Zones)
  const markerPositions = [geom.markers.topLeft, geom.markers.topRight, geom.markers.bottomLeft, geom.markers.bottomRight];
  markerPositions.forEach((m) => {
    const s = m.size;
    const h = s / 2;
    // Outer black square
    svg += `  <rect x="${m.x - h}" y="${m.y - h}" width="${s}" height="${s}" class="marker"/>\n`;
    // Middle white square
    svg += `  <rect x="${m.x - h * 0.55}" y="${m.y - h * 0.55}" width="${s * 0.55}" height="${s * 0.55}" fill="#FFFFFF"/>\n`;
    // Center solid black square
    svg += `  <rect x="${m.x - h * 0.25}" y="${m.y - h * 0.25}" width="${s * 0.25}" height="${s * 0.25}" class="marker"/>\n`;
  });

  // Sheet Boundary / Calibration Border
  svg += `  <rect x="${geom.markers.topLeft.x}" y="${geom.markers.topLeft.y}" width="${geom.markers.topRight.x - geom.markers.topLeft.x}" height="${geom.markers.bottomLeft.y - geom.markers.topLeft.y}" fill="none" stroke="#94A3B8" stroke-width="0.8" stroke-dasharray="4,4"/>\n`;

  // Header Title & School Info
  const headerCenterX = width / 2 - 40;
  svg += `  <text x="${headerCenterX}" y="${geom.header.y + 36}" class="title">${escapeXml(schoolName)}</text>\n`;
  svg += `  <text x="${headerCenterX}" y="${geom.header.y + 68}" class="subtitle">${escapeXml(examTitle)}</text>\n`;
  svg += `  <text x="${headerCenterX}" y="${geom.header.y + 95}" font-family="Helvetica, Arial" font-size="12px" fill="#64748B" text-anchor="middle">OFFICIAL OMR EVALUATION SHEET • DO NOT FOLD OR DAMAGE</text>\n`;

  // QR Code Area
  if (qrDataUrl) {
    svg += `  <image href="${qrDataUrl}" x="${geom.header.qr.x}" y="${geom.header.qr.y}" width="${geom.header.qr.size}" height="${geom.header.qr.size}"/>\n`;
  } else {
    svg += `  <rect x="${geom.header.qr.x}" y="${geom.header.qr.y}" width="${geom.header.qr.size}" height="${geom.header.qr.size}" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="1.5"/>\n`;
    svg += `  <text x="${geom.header.qr.x + geom.header.qr.size / 2}" y="${geom.header.qr.y + geom.header.qr.size / 2}" font-family="monospace" font-size="10px" fill="#475569" text-anchor="middle" dominant-baseline="central">QR CODE</text>\n`;
  }
  svg += `  <text x="${geom.header.qr.x + geom.header.qr.size / 2}" y="${geom.header.qr.y + geom.header.qr.size + 16}" font-family="monospace" font-size="9px" fill="#64748B" text-anchor="middle">${sheetId}</text>\n`;

  // Header Details Box (Student Info)
  const infoBoxY = geom.rollGrid.y;
  const infoBoxX = geom.rollGrid.x + geom.rollGrid.width + 40;
  const infoBoxW = width - infoBoxX - geom.markers.topRight.size - 80;
  const infoBoxH = geom.rollGrid.height;

  svg += `  <rect x="${infoBoxX}" y="${infoBoxY}" width="${infoBoxW}" height="${infoBoxH}" rx="8" class="border-box"/>\n`;
  svg += `  <rect x="${infoBoxX}" y="${infoBoxY}" width="${infoBoxW}" height="32" rx="8" fill="#F1F5F9"/>\n`;
  svg += `  <text x="${infoBoxX + 16}" y="${infoBoxY + 21}" class="sec-title">STUDENT DETAILS &amp; INSTRUCTIONS</text>\n`;

  svg += `  <text x="${infoBoxX + 20}" y="${infoBoxY + 65}" class="meta-label">CANDIDATE NAME:</text>\n`;
  svg += `  <line x1="${infoBoxX + 140}" y1="${infoBoxY + 70}" x2="${infoBoxX + infoBoxW - 20}" y2="${infoBoxY + 70}" stroke="#94A3B8" stroke-width="1"/>\n`;
  if (studentName) {
    svg += `  <text x="${infoBoxX + 145}" y="${infoBoxY + 66}" class="meta-val">${escapeXml(studentName)}</text>\n`;
  }

  svg += `  <text x="${infoBoxX + 20}" y="${infoBoxY + 115}" class="meta-label">EXAM ID / CODE:</text>\n`;
  svg += `  <text x="${infoBoxX + 145}" y="${infoBoxY + 115}" class="meta-val">${escapeXml(examId)}</text>\n`;

  svg += `  <text x="${infoBoxX + 20}" y="${infoBoxY + 155}" class="meta-label">INSTRUCTIONS:</text>\n`;
  svg += `  <text x="${infoBoxX + 20}" y="${infoBoxY + 180}" font-family="Helvetica, Arial" font-size="11px" fill="#475569">• Use Blue/Black Ballpoint pen or 2B Pencil only.</text>\n`;
  svg += `  <text x="${infoBoxX + 20}" y="${infoBoxY + 200}" font-family="Helvetica, Arial" font-size="11px" fill="#475569">• Darken completely: <tspan fill="#10B981" font-weight="700">● Correct</tspan> &#160; <tspan fill="#EF4444">✕ ◯ ✔ Incorrect</tspan></text>\n`;
  svg += `  <text x="${infoBoxX + 20}" y="${infoBoxY + 220}" font-family="Helvetica, Arial" font-size="11px" fill="#475569">• Do not make stray marks on registration corners or barcode.</text>\n`;
  svg += `  <text x="${infoBoxX + 20}" y="${infoBoxY + 240}" font-family="Helvetica, Arial" font-size="11px" fill="#475569">• In case of erasure, ensure mark is completely removed.</text>\n`;

  // Student Roll Number Matrix Box
  svg += `  <rect x="${geom.rollGrid.x}" y="${geom.rollGrid.y}" width="${geom.rollGrid.width}" height="${geom.rollGrid.height}" rx="8" class="border-box"/>\n`;
  svg += `  <rect x="${geom.rollGrid.x}" y="${geom.rollGrid.y}" width="${geom.rollGrid.width}" height="32" rx="8" fill="#F1F5F9"/>\n`;
  svg += `  <text x="${geom.rollGrid.x + 16}" y="${geom.rollGrid.y + 21}" class="sec-title">ROLL NUMBER</text>\n`;

  geom.rollGrid.bubbles.forEach((b) => {
    svg += `  <circle cx="${b.cx}" cy="${b.cy}" r="${b.radius}" fill="#FFFFFF" stroke="#475569" stroke-width="1.2"/>\n`;
    svg += `  <text x="${b.cx}" y="${b.cy}" class="roll-digit-label">${b.digit}</text>\n`;
  });

  // Questions Box & Bubbles
  const qBoxY = geom.header.y + 510;
  const qBoxH = height - qBoxY - geom.markers.bottomLeft.size - 80;
  const qBoxW = width - (geom.markers.topLeft.x) * 2;

  svg += `  <rect x="${geom.markers.topLeft.x}" y="${qBoxY}" width="${qBoxW}" height="${qBoxH}" rx="8" class="border-box"/>\n`;
  svg += `  <rect x="${geom.markers.topLeft.x}" y="${qBoxY}" width="${qBoxW}" height="32" rx="8" fill="#F1F5F9"/>\n`;
  svg += `  <text x="${geom.markers.topLeft.x + 20}" y="${qBoxY + 21}" class="sec-title">CANDIDATE RESPONSES (MCQ ANSWERS)</text>\n`;

  // Draw Questions and Answer Bubbles
  geom.questions.forEach((q) => {
    svg += `  <text x="${q.labelX}" y="${q.labelY}" class="q-num">${q.questionNumber}.</text>\n`;
    q.bubbles.forEach((b) => {
      svg += `  <circle cx="${b.cx}" cy="${b.cy}" r="${b.radius}" fill="#FFFFFF" stroke="#334155" stroke-width="1.3"/>\n`;
      svg += `  <text x="${b.cx}" y="${b.cy}" class="b-label">${b.option}</text>\n`;
    });
  });

  // Footer bar with calibration tick marks and Sheet ID
  const footerY = height - geom.markers.bottomLeft.size - 25;
  svg += `  <text x="${width / 2}" y="${footerY}" font-family="Helvetica, Arial" font-size="11px" font-weight="600" fill="#64748B" text-anchor="middle">SchoolIMS Automated OMR Engine • Template: ${geom.optionsCount}-Option v1 • Sheet UID: ${sheetId}</text>\n`;

  svg += `</svg>`;
  return svg;
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
