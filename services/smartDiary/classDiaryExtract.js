import { generateJsonFromImage } from '../ai/geminiVision.js';
import { composeHomeworkLine } from './composeContent.js';
import { heuristicExtract } from './heuristicExtract.js';
import { matchSubjectName, needsFallback } from './subjectMatch.js';

function buildClassDiaryPrompt(context = {}) {
  const subjects = (context.subjects || []).map((item) => item.name).filter(Boolean).join('\n');
  return `You are reading a full class diary page for an Indian school.
The image may contain homework/classwork for MULTIPLE subjects on one page.

School: ${context.school_name || ''}
Class: ${context.class_name || ''}
Section: ${context.section_name || ''}
Date: ${context.today || ''}

Available subjects for this class (map abbreviations to these names; never invent others):
${subjects || '(unknown)'}

Rules:
- Extract only information visible in the image.
- Do not invent homework, due dates, chapters, questions, or subjects.
- Use null when uncertain.
- Normalize obvious abbreviations: Maths→Mathematics, Ex 4.2 Q1-10 → Complete Exercise 4.2, Questions 1–10.
- Preserve exercise numbers and question ranges exactly as written.
- Distinguish classwork from homework when possible.
- Detect reminders, tests, bring-instructions, worksheets, projects.
- Never assign database IDs.
- Include confidence 0-1 per entry.

Return JSON only:
{
  "classDiary": true,
  "class": "${context.class_name || ''}",
  "section": "${context.section_name || ''}",
  "entries": [
    {
      "subject": "",
      "type": "HOMEWORK",
      "classwork": "",
      "homework": "",
      "chapter": "",
      "exercise": "",
      "questions": "",
      "dueDate": null,
      "reminders": [],
      "confidence": 0.9
    }
  ],
  "overallConfidence": 0.9
}
`;
}

function buildPhotoDiaryPrompt(context = {}) {
  return `You are reading one subject's school diary / homework photo (board, notebook, worksheet, or register).
Use context. Do not invent IDs, homework, chapters, or due dates. Use null when uncertain.
Expand "Ex 5.2 Q1-10" to homework "Complete Exercise 5.2, Questions 1–10."
Reminders like "Bring geometry box tomorrow" go in reminders[].

Context:
Class: ${context.class_name || ''}${context.section_name || ''}
Subject: ${context.subject_name || ''}
Date: ${context.today || ''}

Return JSON:
{
  "subject": "${context.subject_name || ''}",
  "title": "",
  "classwork": "",
  "homework": "",
  "chapter": "",
  "exercise": "",
  "questions": "",
  "dueDate": null,
  "test": null,
  "reminders": [],
  "materialsRequired": [],
  "additionalInstructions": "",
  "confidence": { "homework": 0.9, "reminders": 0.9 },
  "detectedLanguage": "en",
  "originalText": ""
}
`;
}

export function heuristicSplitClassDiary(rawText, subjects = []) {
  const lines = String(rawText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const buckets = [];
  let current = null;

  const startBucket = (match, rest) => {
    current = {
      subject: match.subject?.name || match.rawName,
      subject_id: match.subject?.id || null,
      unknown: !match.subject,
      rawName: match.rawName,
      lines: rest ? [rest] : [],
      confidence: match.subject ? 0.78 : 0.4,
    };
    buckets.push(current);
  };

  for (const line of lines) {
    const heading = line.replace(/[:.\-–]+$/, '').trim();
    const match = matchSubjectName(heading, subjects);
    if (match.subject && heading.split(/\s+/).length <= 4) {
      startBucket(match, '');
      continue;
    }
    const prefix = heading.split(/\s+/)[0];
    const prefixMatch = matchSubjectName(prefix, subjects);
    if (prefixMatch.subject && prefix.length >= 3) {
      const rest = heading.slice(prefix.length).trim();
      startBucket(prefixMatch, rest);
      continue;
    }
    if (!current) {
      const fallback = matchSubjectName(heading, subjects);
      if (fallback.subject) startBucket(fallback, '');
      else {
        current = {
          subject: '',
          subject_id: null,
          unknown: true,
          rawName: '',
          lines: [line],
          confidence: 0.4,
        };
        buckets.push(current);
      }
      continue;
    }
    current.lines.push(line);
  }

  return buckets.map((bucket) => {
    const text = bucket.lines.filter(Boolean).join('\n');
    const extracted = heuristicExtract(text, { subject_name: bucket.subject });
    return normalizeClassEntry({
      subject: bucket.subject,
      subject_id: bucket.subject_id,
      unknown: bucket.unknown,
      rawName: bucket.rawName,
      homework: extracted.homework,
      classwork: extracted.classwork,
      chapter: extracted.chapter,
      exercise: extracted.exercise,
      questions: extracted.questions,
      reminders: extracted.reminders,
      dueDate: extracted.dueDate,
      confidence: bucket.unknown ? 0.4 : Math.max(0.8, Number(extracted.confidence?.homework || 0.7)),
      originalText: text,
    }, subjects);
  }).filter((entry) => entry.homework || entry.classwork || entry.reminders.length || entry.unknown);
}

export function normalizeClassEntry(entry, subjects = []) {
  const match = entry.subject_id
    ? { subject: { id: entry.subject_id, name: entry.subject }, unknown: false, rawName: entry.subject }
    : matchSubjectName(entry.subject || entry.rawName, subjects);
  const homework = composeHomeworkLine(entry)
    || String(entry.homework || '').trim()
    || String(entry.originalText || '').replace(/\n+/g, '. ').trim();
  const reminders = Array.isArray(entry.reminders) ? entry.reminders.map((item) => String(item).trim()).filter(Boolean) : [];
  const confidence = Number(entry.confidence || 0);
  const classwork = String(entry.classwork || '').trim();
  return {
    subject: match.subject?.name || entry.subject || entry.rawName || 'Unknown Subject',
    subject_id: match.subject?.id || null,
    unknown: !match.subject,
    rawName: match.rawName || entry.rawName || entry.subject || '',
    type: entry.type || (homework ? 'HOMEWORK' : 'CLASSWORK'),
    classwork,
    homework,
    chapter: String(entry.chapter || '').trim(),
    exercise: String(entry.exercise || '').trim(),
    questions: String(entry.questions || '').trim(),
    dueDate: entry.dueDate || null,
    reminders,
    confidence,
    selected: Boolean(match.subject) && confidence >= 0.5 && Boolean(homework || classwork || reminders.length),
  };
}

export async function extractClassDiaryFromImage({ imageBuffer, mimeType, context = {} } = {}) {
  const heuristic = heuristicSplitClassDiary(context.rawText || '', context.subjects || []);
  const vision = await generateJsonFromImage({
    imageBuffer,
    mimeType,
    prompt: buildClassDiaryPrompt(context),
    shouldFallback: (parsed) => {
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      return needsFallback(parsed?.overallConfidence, entries);
    },
  });

  const aiEntries = Array.isArray(vision.parsed?.entries) ? vision.parsed.entries : [];
  const mapped = (aiEntries.length ? aiEntries : heuristic).map((entry) => normalizeClassEntry(entry, context.subjects));
  const overall = Number(vision.parsed?.overallConfidence)
    || (mapped.length ? mapped.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / mapped.length : 0);

  return {
    classDiary: true,
    class: context.class_name || vision.parsed?.class || '',
    section: context.section_name || vision.parsed?.section || '',
    entries: mapped,
    overallConfidence: overall,
    provider: vision.provider,
    model: vision.model,
    usedFallback: Boolean(vision.usedFallback),
    tokensIn: vision.tokensIn,
    tokensOut: vision.tokensOut,
    error: vision.error || null,
    raw: vision.parsed,
  };
}

export async function extractPhotoDiaryFromImage({ imageBuffer, mimeType, context = {} } = {}) {
  const vision = await generateJsonFromImage({
    imageBuffer,
    mimeType,
    prompt: buildPhotoDiaryPrompt(context),
    shouldFallback: (parsed) => Number(parsed?.confidence?.homework || parsed?.confidence || 0) < 0.65 && !String(parsed?.homework || '').trim(),
  });
  const parsed = vision.parsed || {};
  const heuristic = heuristicExtract(parsed.originalText || parsed.homework || '', context);
  const homework = composeHomeworkLine({ ...heuristic, ...parsed }) || parsed.homework || heuristic.homework;
  return {
    subject: parsed.subject || context.subject_name || heuristic.subject,
    title: parsed.title || '',
    classwork: parsed.classwork || '',
    homework,
    chapter: parsed.chapter || heuristic.chapter,
    exercise: parsed.exercise || heuristic.exercise,
    questions: parsed.questions || heuristic.questions,
    dueDate: parsed.dueDate || heuristic.dueDate,
    test: parsed.test || heuristic.test,
    reminders: Array.isArray(parsed.reminders) && parsed.reminders.length ? parsed.reminders : heuristic.reminders,
    materialsRequired: parsed.materialsRequired || heuristic.materialsRequired,
    additionalInstructions: parsed.additionalInstructions || '',
    confidence: parsed.confidence || heuristic.confidence,
    detectedLanguage: parsed.detectedLanguage || heuristic.detectedLanguage,
    originalText: parsed.originalText || '',
    provider: vision.provider,
    model: vision.model,
    usedFallback: Boolean(vision.usedFallback),
    tokensIn: vision.tokensIn,
    tokensOut: vision.tokensOut,
    error: vision.error || null,
    source: vision.error ? 'heuristic' : 'vision',
  };
}
