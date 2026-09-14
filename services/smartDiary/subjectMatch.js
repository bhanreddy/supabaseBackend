/**
 * Map AI subject names onto trusted class subjects. Never invent IDs.
 */

const ALIASES = {
  maths: 'mathematics',
  math: 'mathematics',
  mathematics: 'mathematics',
  sci: 'science',
  science: 'science',
  evs: 'science',
  sst: 'social studies',
  social: 'social studies',
  'social science': 'social studies',
  'social studies': 'social studies',
  eng: 'english',
  english: 'english',
  hin: 'hindi',
  hindi: 'hindi',
  tel: 'telugu',
  telugu: 'telugu',
  kan: 'kannada',
  tam: 'tamil',
};

export function normalizeSubjectKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u0c00-\u0c7f\u0900-\u097f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function aliasSubjectKey(name) {
  const key = normalizeSubjectKey(name);
  return ALIASES[key] || key;
}

export function matchSubjectName(rawName, subjects = []) {
  const raw = String(rawName || '').trim();
  if (!raw || !Array.isArray(subjects) || subjects.length === 0) {
    return { subject: null, confidence: 0, rawName: raw, unknown: Boolean(raw) };
  }

  const wanted = aliasSubjectKey(raw);
  const scored = subjects.map((subject) => {
    const name = String(subject.name || '');
    const key = aliasSubjectKey(name);
    let score = 0;
    if (key === wanted) score = 1;
    else if (key.startsWith(wanted) || wanted.startsWith(key)) score = Math.min(key.length, wanted.length) / Math.max(key.length, wanted.length);
    else if (key.includes(wanted) || wanted.includes(key)) score = 0.82;
    return { subject, score };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best && best.score >= 0.82) {
    return {
      subject: best.subject,
      confidence: best.score,
      rawName: raw,
      unknown: false,
    };
  }
  return { subject: null, confidence: best?.score || 0, rawName: raw, unknown: true };
}

export function confidenceLabel(score) {
  const value = Number(score || 0);
  if (value >= 0.85) return 'Looks good';
  if (value >= 0.65) return 'Check this';
  return "Couldn't read clearly";
}

export function needsFallback(overallConfidence, entries = []) {
  if (Number(overallConfidence || 0) < 0.65) return true;
  if (!entries.length) return true;
  const unclear = entries.filter((entry) => Number(entry.confidence || 0) < 0.65 || entry.unknown).length;
  return unclear / Math.max(entries.length, 1) >= 0.5;
}
