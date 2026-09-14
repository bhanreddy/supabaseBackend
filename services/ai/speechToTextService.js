/**
 * SpeechToTextService — vendor-agnostic audio-to-text.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../../config/env.js';
import logger from '../../utils/logger.js';

const DEFAULT_MODELS = ['gemini-3.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest'];

function modelIds() {
  const fromEnv = (process.env.GEMINI_STT_MODELS || process.env.GEMINI_TRANSLATION_MODELS || '')
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

const STT_PROMPT = `Transcribe this teacher's diary / homework voice note.
The speaker may use English, Telugu, Hindi, or mixed languages.
Preserve numbers, exercise names, and homework intent.
Return JSON: { "text": string, "detectedLanguage": "en"|"te"|"hi"|"mixed-en-te"|"mixed-en-hi" }
Do not translate unless the words were spoken in that language.
`;

export async function transcribeAudio({ audioBuffer, mimeType = 'audio/mp4', context = {} } = {}) {
  const genAI = getGenAI();
  if (!genAI || !audioBuffer) {
    return { text: '', detectedLanguage: 'en', provider: 'none', error: 'unavailable' };
  }

  const base64 = Buffer.isBuffer(audioBuffer) ? audioBuffer.toString('base64') : String(audioBuffer);
  const contextLine = [
    context.subject_name && `Current subject: ${context.subject_name}`,
    context.class_name && `Current class: ${context.class_name}${context.section_name || ''}`,
  ].filter(Boolean).join('. ');

  let lastError = null;
  for (const modelId of modelIds()) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
      });
      const result = await model.generateContent([
        { text: `${STT_PROMPT}\n${contextLine}` },
        { inlineData: { mimeType: mimeType || 'audio/mp4', data: base64 } },
      ]);
      const parsed = safeJson(result?.response?.text?.() || '');
      return {
        text: String(parsed.text || '').trim(),
        detectedLanguage: parsed.detectedLanguage || 'en',
        provider: 'gemini',
        model: modelId,
      };
    } catch (error) {
      lastError = error;
      logger.warn({ err: error, event: 'diary_stt_model_failed', modelId }, 'Speech model failed; trying next');
    }
  }

  return {
    text: '',
    detectedLanguage: 'en',
    provider: 'gemini',
    error: lastError?.message || 'stt_failed',
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
