import translate from 'google-translate-api-x';

/**
 * Translate a single English string to Telugu using free Google Translate.
 * Returns empty string on failure — never throws.
 */
export async function translateToTelugu(text) {
  if (!text || text.trim() === '') return '';
  try {
    const res = await translate(text, { from: 'en', to: 'te' });
    return res.text || '';
  } catch (err) {
    console.error('[Translator] Error translating to Telugu:', err?.message || err);
    return '';
  }
}

/**
 * Translate multiple fields in one batch.
 * @param {Object} fields - { columnName: 'English text', ... }
 * @returns {Object} - { columnName: 'Telugu text', ... }
 * Never throws — returns {} on failure.
 */
export async function translateFields(fields) {
  const entries = Object.entries(fields).filter(([, v]) => v && v.trim() !== '');
  if (entries.length === 0) return {};

  const result = {};

  // Translate each field individually so partial failures don't lose everything
  await Promise.all(
    entries.map(async ([key, value]) => {
      try {
        const res = await translate(value, { from: 'en', to: 'te' });
        if (res.text) {
          result[key] = res.text;
        }
      } catch (err) {
        console.error(`[Translator] Error translating field "${key}":`, err?.message || err);
        // Skip this field — result[key] stays undefined
      }
    })
  );

  return result;
}

/**
 * Translate Telugu text fields to English (for diary entries authored in Telugu).
 */
export async function translateFieldsToEnglish(fields) {
  const entries = Object.entries(fields).filter(([, v]) => v && v.trim() !== '');
  if (entries.length === 0) return {};

  const result = {};

  await Promise.all(
    entries.map(async ([key, value]) => {
      try {
        const res = await translate(value, { from: 'te', to: 'en' });
        if (res.text) {
          result[key] = res.text;
        }
      } catch (err) {
        console.error(`[Translator] Error translating field "${key}" to English:`, err?.message || err);
      }
    })
  );

  return result;
}

/**
 * Resolve diary title/content for storage.
 * Staff portal sends input_language: 'te' — Telugu is canonical (_te columns); English is derived.
 */
export async function resolveDiaryTextFields({ title, content, input_language = 'en' }) {
  const trimmedTitle = (title || '').trim();
  const trimmedContent = (content || '').trim();

  if (input_language === 'te') {
    const title_te = trimmedTitle || null;
    const content_te = trimmedContent || null;
    let titleEn = trimmedTitle;
    let contentEn = trimmedContent;
    try {
      const en = await translateFieldsToEnglish({
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
        ...(trimmedContent ? { content: trimmedContent } : {}),
      });
      if (en.title) titleEn = en.title;
      if (en.content) contentEn = en.content;
    } catch {
      // keep Telugu in both columns if translation fails
    }
    return { title: titleEn, title_te, content: contentEn, content_te };
  }

  let title_te = null;
  let content_te = null;
  try {
    const te = await translateFields({
      ...(trimmedTitle ? { title: trimmedTitle } : {}),
      ...(trimmedContent ? { content: trimmedContent } : {}),
    });
    if (trimmedTitle) title_te = te.title || null;
    if (trimmedContent) content_te = te.content || null;
  } catch {
    // proceed without translation
  }
  return { title: trimmedTitle, title_te, content: trimmedContent, content_te };
}