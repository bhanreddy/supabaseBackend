/**
 * TranslationService — wraps the existing Gemini translator so diary code
 * never imports a vendor client directly.
 */

import { resolveDiaryTextFields } from '../geminiTranslator.js';

export async function translateDiaryFields({ title, content, inputLanguage = 'auto' }) {
  return resolveDiaryTextFields({
    title,
    content,
    input_language: inputLanguage,
  });
}
