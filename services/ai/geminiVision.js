/**
 * Shared Gemini vision client for diary OCR+structure.
 * Primary: Gemini 2.5 Flash-Lite. One fallback: Gemini 2.5 Flash.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';

export const PRIMARY_DIARY_MODEL = process.env.GEMINI_DIARY_PRIMARY || 'gemini-2.5-flash-lite';
export const FALLBACK_DIARY_MODEL = process.env.GEMINI_DIARY_FALLBACK || 'gemini-2.5-flash';

function getGenAI() {
  const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) return null;
  return new GoogleGenerativeAI(apiKey);
}

export function parseJsonObject(raw) {
  try {
    const match = String(raw || '').match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  } catch {
    return {};
  }
}

function usageFrom(result) {
  const meta = result?.response?.usageMetadata || {};
  return {
    tokensIn: Number(meta.promptTokenCount || 0) || null,
    tokensOut: Number(meta.candidatesTokenCount || meta.totalTokenCount || 0) || null,
  };
}

async function runModel(genAI, modelId, prompt, imageBuffer, mimeType) {
  const model = genAI.getGenerativeModel({
    model: modelId,
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  });
  const base64 = Buffer.isBuffer(imageBuffer) ? imageBuffer.toString('base64') : String(imageBuffer);
  const result = await model.generateContent([
    { text: prompt },
    { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64 } },
  ]);
  const parsed = parseJsonObject(result?.response?.text?.() || '');
  return { parsed, model: modelId, ...usageFrom(result) };
}

/**
 * One vision call. Fallback only when primary throws or shouldFallback(parsed) is true.
 * Maximum one fallback request.
 */
export async function generateJsonFromImage({
  imageBuffer,
  mimeType = 'image/jpeg',
  prompt,
  shouldFallback,
} = {}) {
  const genAI = getGenAI();
  if (!genAI || !imageBuffer) {
    return { parsed: {}, provider: 'none', error: 'unavailable', usedFallback: false };
  }

  try {
    const primary = await runModel(genAI, PRIMARY_DIARY_MODEL, prompt, imageBuffer, mimeType);
    const weak = typeof shouldFallback === 'function' ? shouldFallback(primary.parsed) : false;
    if (!weak) {
      return { ...primary, provider: 'gemini', usedFallback: false };
    }
    try {
      const fallback = await runModel(genAI, FALLBACK_DIARY_MODEL, prompt, imageBuffer, mimeType);
      return { ...fallback, provider: 'gemini', usedFallback: true, primaryModel: PRIMARY_DIARY_MODEL };
    } catch (fallbackError) {
      logger.warn({ err: fallbackError, event: 'diary_vision_fallback_failed' }, 'Diary vision fallback failed; keeping primary');
      return { ...primary, provider: 'gemini', usedFallback: false, weak: true };
    }
  } catch (primaryError) {
    logger.warn({ err: primaryError, event: 'diary_vision_primary_failed', model: PRIMARY_DIARY_MODEL }, 'Diary vision primary failed');
    try {
      const fallback = await runModel(genAI, FALLBACK_DIARY_MODEL, prompt, imageBuffer, mimeType);
      return { ...fallback, provider: 'gemini', usedFallback: true };
    } catch (fallbackError) {
      return {
        parsed: {},
        provider: 'gemini',
        error: fallbackError?.message || primaryError?.message || 'vision_failed',
        usedFallback: true,
      };
    }
  }
}
