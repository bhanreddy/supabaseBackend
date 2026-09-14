/**
 * OCRService — vendor-agnostic image-to-text.
 * Application code depends on `extractTextFromImage`, not a vendor SDK.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';
import { heuristicExtract } from '../smartDiary/heuristicExtract.js';

const DEFAULT_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];

function modelIds() {
  const fromEnv = (process.env.GEMINI_OCR_MODELS || process.env.GEMINI_TRANSLATION_MODELS || '')
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

const OCR_PROMPT = `You are reading a school teacher's diary / homework photo.
The photo may be a blackboard, whiteboard, notebook, textbook, printed worksheet, or handwritten register.
Extract ALL readable text. Preserve numbers, exercise IDs, and mixed English/Telugu/Hindi.
Do not invent content that is not visible. If a word is unreadable, skip it.
Return JSON: { "text": string, "detectedLanguage": "en"|"te"|"hi"|"mixed-en-te"|"mixed-en-hi", "confidence": number }
`;

export async function extractTextFromImage({ imageBuffer, mimeType = 'image/jpeg', context = {} } = {}) {
  const genAI = getGenAI();
  if (!genAI || !imageBuffer) {
    return { text: '', detectedLanguage: 'en', confidence: 0, provider: 'none', error: 'unavailable' };
  }

  const base64 = Buffer.isBuffer(imageBuffer) ? imageBuffer.toString('base64') : String(imageBuffer);
  const contextLine = [
    context.subject_name && `Subject: ${context.subject_name}`,
    context.class_name && `Class: ${context.class_name}${context.section_name || ''}`,
    context.teacher_name && `Teacher: ${context.teacher_name}`,
  ].filter(Boolean).join('. ');

  let lastError = null;
  for (const modelId of modelIds()) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      });
      const result = await model.generateContent([
        { text: `${OCR_PROMPT}\n${contextLine}` },
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64 } },
      ]);
      const parsed = safeJson(result?.response?.text?.() || '');
      const text = String(parsed.text || parsed.raw || '').trim();
      return {
        text,
        detectedLanguage: parsed.detectedLanguage || heuristicExtract(text).detectedLanguage,
        confidence: Number(parsed.confidence || (text ? 0.8 : 0)),
        provider: 'gemini',
        model: modelId,
      };
    } catch (error) {
      lastError = error;
      logger.warn({ err: error, event: 'diary_ocr_model_failed', modelId }, 'OCR model failed; trying next');
    }
  }

  return {
    text: '',
    detectedLanguage: 'en',
    confidence: 0,
    provider: 'gemini',
    error: lastError?.message || 'ocr_failed',
  };
}

function safeJson(raw) {
  try {
    const match = String(raw).match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  } catch {
    return { text: String(raw || '').trim() };
  }
}
