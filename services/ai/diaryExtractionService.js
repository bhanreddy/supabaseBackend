/**
 * DiaryExtractionService — unstructured text → structured diary fields.
 * Never returns database IDs. Callers map semantics onto trusted entities.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';
import { heuristicExtract, mergeExtraction } from '../smartDiary/heuristicExtract.js';

const DEFAULT_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];

function modelIds() {
  const fromEnv = (process.env.GEMINI_DIARY_MODELS || process.env.GEMINI_TRANSLATION_MODELS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_MODELS;
}

function getGenAI() {
  const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) return null;
  return new GoogleGenerativeAI(apiKey);
}

function buildPrompt(rawText, context = {}) {
  const recent = Array.isArray(context.recentEntries)
    ? context.recentEntries.slice(0, 3).map((entry) => `- ${entry.subject_name || ''}: ${String(entry.content || '').slice(0, 120)}`).join('\n')
    : '';

  return `You convert a teacher's diary / homework note into structured fields for a school app.
Use the provided school context. Do NOT invent class IDs, section IDs, subject IDs, or teacher IDs.
If the current subject is known, use it unless the note clearly names a different subject.
Expand shorthand: "Ex 4.2 Q1-10" → homework "Complete Exercise 4.2, Questions 1–10."
"Ch 4 Fractions" → chapter "Chapter 4 - Fractions".
Reminders like "Bring geometry box tomorrow" go in reminders[].
Return JSON only with this shape:
{
  "subject": "",
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
  "confidence": {},
  "detectedLanguage": ""
}

Context:
School: ${context.school_name || ''}
Class: ${context.class_name || ''}${context.section_name || ''}
Subject: ${context.subject_name || ''}
Teacher: ${context.teacher_name || ''}
Date: ${context.today || ''}
Period: ${context.period_number || ''}
Recent diary:
${recent || '(none)'}

Teacher note:
"""${String(rawText || '').slice(0, 4000)}"""
`;
}

export async function extractDiaryFields({ rawText, context = {}, extractor } = {}) {
  const heuristic = heuristicExtract(rawText, context);
  if (typeof extractor === 'function') {
    try {
      const ai = await extractor({ rawText, context });
      return { ...mergeExtraction(ai, heuristic), source: 'ai+heuristic' };
    } catch {
      return { ...heuristic, source: 'heuristic' };
    }
  }

  const genAI = getGenAI();
  if (!genAI || !String(rawText || '').trim()) {
    return { ...heuristic, source: String(rawText || '').trim() ? 'heuristic' : 'empty' };
  }

  let lastError = null;
  for (const modelId of modelIds()) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        generationConfig: { temperature: 0.15, responseMimeType: 'application/json' },
      });
      const result = await model.generateContent(buildPrompt(rawText, context));
      const parsed = safeJson(result?.response?.text?.() || '');
      return {
        ...mergeExtraction(parsed, heuristic),
        source: 'ai+heuristic',
        provider: 'gemini',
        model: modelId,
      };
    } catch (error) {
      lastError = error;
      logger.warn({ err: error, event: 'diary_extract_model_failed', modelId }, 'Diary extraction model failed');
    }
  }

  return {
    ...heuristic,
    source: 'heuristic',
    error: lastError?.message || 'extraction_failed',
  };
}

function safeJson(raw) {
  try {
    const match = String(raw).match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  } catch {
    return {};
  }
}
