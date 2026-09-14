/**
 * Pure helpers that turn structured diary fields into parent-readable text
 * without exposing OCR internals or JSON.
 */

const PHOTO_FALLBACK_CONTENT = 'Please view the attached diary photo.';
const VOICE_FALLBACK_CONTENT = "Please view today's diary update.";

export const DIARY_PHOTO_FALLBACK = PHOTO_FALLBACK_CONTENT;

export function renderTemplateContent(content, values = {}) {
  const source = String(content || '');
  return source.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const value = values[key];
    if (value == null) return '';
    return String(value).trim();
  }).replace(/\s{2,}/g, ' ').replace(/\s+\./g, '.').trim();
}

export function composeDiaryContent(fields = {}, options = {}) {
  const parts = [];
  const classwork = trimText(fields.classwork);
  const homework = trimText(fields.homework) || composeHomeworkLine(fields);
  const reminders = normalizeList(fields.reminders);
  const materials = normalizeList(fields.materialsRequired);
  const extra = trimText(fields.additionalInstructions);
  const test = trimText(fields.test);

  if (classwork) parts.push(`Classwork: ${classwork}`);
  if (homework) parts.push(parts.length ? `Homework: ${homework}` : homework);
  if (test) parts.push(`Test: ${test}`);
  for (const reminder of reminders) parts.push(`Reminder: ${reminder}`);
  if (materials.length) parts.push(`Materials: ${materials.join(', ')}`);
  if (extra) parts.push(extra);

  const composed = parts.join('\n\n').trim();
  if (composed) return composed;
  if (options.hasPhoto) return PHOTO_FALLBACK_CONTENT;
  if (options.hasVoice) return VOICE_FALLBACK_CONTENT;
  return trimText(fields.originalText) || trimText(fields.title) || PHOTO_FALLBACK_CONTENT;
}

export function composeHomeworkLine(fields = {}) {
  const exercise = trimText(fields.exercise);
  const questions = trimText(fields.questions);
  const homework = trimText(fields.homework);
  if (homework) return homework;
  if (exercise && questions) return `Complete Exercise ${stripExercisePrefix(exercise)}, Questions ${normalizeQuestionRange(questions)}.`;
  if (exercise) return `Complete Exercise ${stripExercisePrefix(exercise)}.`;
  if (questions) return `Complete Questions ${normalizeQuestionRange(questions)}.`;
  return '';
}

export function composeDiaryTitle(fields = {}, context = {}) {
  const title = trimText(fields.title);
  if (title) return title.slice(0, 200);
  const subject = trimText(fields.subject) || trimText(context.subject_name) || 'Diary';
  const homework = composeHomeworkLine(fields);
  if (homework) return `${subject} Homework`.slice(0, 200);
  if (fields.hasPhoto || context.hasPhoto) return `${subject} Diary`.slice(0, 200);
  return `${subject} Homework`.slice(0, 200);
}

export function publicStructuredFields(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const reminders = normalizeList(metadata.reminders);
  const materials = normalizeList(metadata.materialsRequired);
  const structured = {
    classwork: trimText(metadata.classwork),
    homework: trimText(metadata.homework) || composeHomeworkLine(metadata),
    chapter: trimText(metadata.chapter),
    exercise: trimText(metadata.exercise),
    questions: trimText(metadata.questions),
    reminders,
    materialsRequired: materials,
    additionalInstructions: trimText(metadata.additionalInstructions),
    test: trimText(metadata.test),
  };
  const hasAny = Object.values(structured).some((value) => (
    Array.isArray(value) ? value.length > 0 : Boolean(value)
  ));
  return hasAny ? structured : null;
}

export function parentNotificationCopy(fields = {}, context = {}) {
  const subject = trimText(fields.subject) || trimText(context.subject_name) || 'Diary';
  const homework = composeHomeworkLine(fields) || trimText(fields.homework);
  if (homework) {
    return {
      title: `${subject} Homework`,
      message: homework,
    };
  }
  if (fields.hasPhoto || context.hasPhoto) {
    return {
      title: `New ${subject} Diary`,
      message: "Tap to view today's homework.",
    };
  }
  const content = composeDiaryContent(fields, { hasPhoto: fields.hasPhoto });
  return {
    title: `${subject} Diary`,
    message: content.slice(0, 160),
  };
}

export function stripExercisePrefix(value) {
  return String(value || '').replace(/^(exercise|ex)\s*/i, '').trim();
}

export function normalizeQuestionRange(value) {
  const text = String(value || '').trim();
  const match = text.match(/(\d+)\s*[-–to]+\s*(\d+)/i);
  if (match) return `${match[1]}–${match[2]}`;
  return text.replace(/^q(?:uestions?)?\s*/i, '').trim();
}

function trimText(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  const text = String(value).trim();
  if (!text) return [];
  return text.split(/\n+|;\s*|,\s+(?=[A-Z])/).map((item) => item.trim()).filter(Boolean);
}
