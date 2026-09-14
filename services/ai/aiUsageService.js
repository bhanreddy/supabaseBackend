import sql from '../../db.js';
import logger from '../../utils/logger.js';

const FEATURES = Object.freeze({
  DIARY_OCR: 'DIARY_OCR',
  DIARY_EXTRACTION: 'DIARY_EXTRACTION',
  DIARY_VOICE: 'DIARY_VOICE',
  DIARY_TRANSLATION: 'DIARY_TRANSLATION',
  DIARY_PHOTO_AI: 'DIARY_PHOTO_AI',
  CLASS_DIARY_AI: 'CLASS_DIARY_AI',
  DIARY_VOICE_AI: 'DIARY_VOICE_AI',
});

const DEFAULT_DAILY_LIMITS = Object.freeze({
  DIARY_OCR: 80,
  DIARY_EXTRACTION: 120,
  DIARY_VOICE: 40,
  DIARY_TRANSLATION: 80,
  DIARY_PHOTO_AI: 80,
  CLASS_DIARY_AI: 40,
  DIARY_VOICE_AI: 40,
});

export async function logAiUsage({
  schoolId,
  teacherId,
  feature,
  provider = null,
  model = null,
  inputType = null,
  tokensIn = null,
  tokensOut = null,
  processingMs = null,
  estimatedCostUsd = null,
  success = true,
  errorCode = null,
  db = sql,
}) {
  if (!schoolId || !feature) return;
  try {
    await db`
      INSERT INTO ai_usage_logs (
        school_id, teacher_id, feature, provider, model, input_type,
        tokens_in, tokens_out, processing_ms, estimated_cost_usd, success, error_code
      ) VALUES (
        ${schoolId}, ${teacherId || null}, ${feature}, ${provider}, ${model}, ${inputType},
        ${tokensIn}, ${tokensOut}, ${processingMs}, ${estimatedCostUsd}, ${success}, ${errorCode}
      )
    `;
  } catch (error) {
    logger.warn({ err: error, event: 'ai_usage_log_failed', schoolId, feature }, 'Failed to persist AI usage');
  }
}

export async function countTodayUsage(schoolId, feature, db = sql) {
  const [row] = await db`
    SELECT COUNT(*)::int AS count
    FROM ai_usage_logs
    WHERE school_id = ${schoolId}
      AND feature = ${feature}
      AND success = TRUE
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
  `;
  return row?.count || 0;
}

export async function assertWithinDailyLimit(schoolId, feature, db = sql) {
  const limit = DEFAULT_DAILY_LIMITS[feature] ?? 80;
  const used = await countTodayUsage(schoolId, feature, db);
  if (used >= limit) {
    const error = new Error('Today\'s text extraction limit has been reached. You can still send the diary photo.');
    error.code = 'AI_DAILY_LIMIT';
    error.status = 429;
    throw error;
  }
  return { used, limit };
}

export { FEATURES as AI_FEATURES, DEFAULT_DAILY_LIMITS };
