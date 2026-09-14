/**
 * Deterministic fallback when OCR/AI is unavailable.
 * Never invents database IDs — only semantic strings the app can map.
 */

import {
  composeHomeworkLine,
  normalizeQuestionRange,
  stripExercisePrefix,
} from './composeContent.js';

const HIGH = 0.9;
const MED = 0.7;
const LOW = 0.45;

export function heuristicExtract(rawText, context = {}) {
  const text = String(rawText || '').replace(/\u00a0/g, ' ').trim();
  const collapsed = text.replace(/\s+/g, ' ');
  const detectedLanguage = detectLanguage(text);

  const exerciseMatch = collapsed.match(/\b(?:ex(?:ercise)?\.?\s*)(\d+(?:\.\d+)?)/i);
  const questionMatch = collapsed.match(/\b(?:q(?:uestions?)?\.?\s*)(\d+)\s*[-–to]+\s*(\d+)/i)
    || collapsed.match(/\bquestions?\s+(\d+)\s*(?:[-–]|to)\s*(\d+)/i);
  const chapterMatch = collapsed.match(/\b(?:ch(?:apter)?\.?\s*)(\d+)(?:\s*[-–:]?\s*([A-Za-z][\w\s]{1,40}))?/i);
  const bringMatch = collapsed.match(/\b(bring\s+[^.]{3,80}?)(?:\.|$)/i);
  const dueMatch = collapsed.match(/\b(tomorrow|day after tomorrow|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/i);

  const exercise = exerciseMatch ? stripExercisePrefix(exerciseMatch[1]) : '';
  const questions = questionMatch ? `${questionMatch[1]}–${questionMatch[2]}` : '';
  const chapterNumber = chapterMatch ? chapterMatch[1] : '';
  const chapterTitle = chapterMatch?.[2] ? chapterMatch[2].trim() : '';
  const chapter = chapterNumber
    ? `Chapter ${chapterNumber}${chapterTitle ? ` - ${chapterTitle}` : ''}`
    : '';

  const subject = inferSubject(collapsed, context.subject_name);
  const reminders = [];
  if (bringMatch) reminders.push(capitalize(bringMatch[1].trim().replace(/\.$/, '')));

  const homework = composeHomeworkLine({ exercise, questions })
    || inferHomeworkSentence(collapsed);

  const dueDate = dueMatch ? normalizeDueDate(dueMatch[1], context.today) : null;

  const confidence = {
    subject: subject && context.subject_name ? HIGH : (subject ? MED : LOW),
    title: homework ? MED : LOW,
    homework: homework ? (exercise && questions ? HIGH : MED) : LOW,
    chapter: chapter ? MED : 0,
    exercise: exercise ? HIGH : 0,
    questions: questions ? HIGH : 0,
    dueDate: dueDate ? LOW : 0,
    reminders: reminders.length ? MED : 0,
  };

  return {
    subject,
    title: homework ? `${subject || 'Homework'}` : '',
    classwork: '',
    homework,
    chapter,
    exercise,
    questions: questions ? normalizeQuestionRange(questions) : '',
    dueDate,
    test: /test|exam/i.test(collapsed) ? collapsed.match(/[^.]*(?:test|exam)[^.]*\.?/i)?.[0]?.trim() || null : null,
    reminders,
    materialsRequired: reminders
      .filter((item) => /^bring /i.test(item))
      .map((item) => item.replace(/^bring\s+/i, '')),
    additionalInstructions: '',
    confidence,
    detectedLanguage,
    originalText: text,
  };
}

export function mergeExtraction(aiFields, heuristicFields) {
  const ai = aiFields && typeof aiFields === 'object' ? aiFields : {};
  const base = heuristicFields && typeof heuristicFields === 'object' ? heuristicFields : heuristicExtract('');
  const confidence = { ...(base.confidence || {}), ...(ai.confidence || {}) };
  const merged = { ...base };

  for (const key of [
    'subject', 'title', 'classwork', 'homework', 'chapter', 'exercise',
    'questions', 'dueDate', 'test', 'additionalInstructions', 'detectedLanguage',
  ]) {
    const aiValue = ai[key];
    const score = Number(ai.confidence?.[key] ?? 0);
    if (aiValue != null && String(aiValue).trim() && score >= 0.55) {
      merged[key] = aiValue;
    } else if (!trim(merged[key]) && trim(aiValue)) {
      merged[key] = aiValue;
      confidence[key] = Math.max(Number(confidence[key] || 0), 0.5);
    }
  }

  merged.reminders = uniqueStrings([
    ...(Array.isArray(ai.reminders) ? ai.reminders : []),
    ...(Array.isArray(base.reminders) ? base.reminders : []),
  ]);
  merged.materialsRequired = uniqueStrings([
    ...(Array.isArray(ai.materialsRequired) ? ai.materialsRequired : []),
    ...(Array.isArray(base.materialsRequired) ? base.materialsRequired : []),
  ]);
  merged.confidence = confidence;
  merged.originalText = trim(ai.originalText) || base.originalText || '';
  if (!trim(merged.homework)) {
    merged.homework = composeHomeworkLine(merged) || base.homework || '';
  }
  return merged;
}

export function lowConfidenceFields(extraction, threshold = 0.7) {
  const confidence = extraction?.confidence || {};
  return Object.entries(confidence)
    .filter(([, score]) => Number(score) > 0 && Number(score) < threshold)
    .map(([field]) => field);
}

function inferSubject(text, contextSubject) {
  if (contextSubject) return contextSubject;
  if (/\bmaths?(?:ematics)?\b/i.test(text)) return 'Mathematics';
  if (/\bscience\b/i.test(text)) return 'Science';
  if (/\benglish\b/i.test(text)) return 'English';
  if (/\btelugu\b/i.test(text)) return 'Telugu';
  if (/\bhindi\b/i.test(text)) return 'Hindi';
  if (/\bsocial\b/i.test(text)) return 'Social Studies';
  return '';
}

function inferHomeworkSentence(text) {
  const line = text.split(/\n/).map((s) => s.trim()).find((s) => /complete|homework|hw\b|exercise|worksheet/i.test(s));
  return line || '';
}

function normalizeDueDate(raw, today) {
  const value = String(raw || '').trim().toLowerCase();
  const base = today ? new Date(`${today}T00:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) return null;
  if (value === 'tomorrow') {
    base.setDate(base.getDate() + 1);
    return toYmd(base);
  }
  if (value === 'day after tomorrow') {
    base.setDate(base.getDate() + 2);
    return toYmd(base);
  }
  return null;
}

function detectLanguage(text) {
  const telugu = (text.match(/[\u0C00-\u0C7F]/g) || []).length;
  const hindi = (text.match(/[\u0900-\u097F]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (telugu > latin && telugu >= hindi) return 'te';
  if (hindi > latin && hindi >= telugu) return 'hi';
  if (telugu > 0 && latin > 0) return 'mixed-en-te';
  if (hindi > 0 && latin > 0) return 'mixed-en-hi';
  return 'en';
}

function toYmd(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function capitalize(value) {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function uniqueStrings(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const text = String(item || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function trim(value) {
  if (value == null) return '';
  return String(value).trim();
}
