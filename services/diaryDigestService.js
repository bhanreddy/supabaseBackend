import sql from '../db.js';
import logger from '../utils/logger.js';
import { sendNotificationToUsers } from './notificationService.js';

export const DIARY_DIGEST_MESSAGE = Object.freeze({
  message: 'The latest diary is ready. Please check all subject updates.',
  message_te: 'తాజా డైరీ సిద్ధంగా ఉంది. అన్ని సబ్జెక్టుల నవీకరణలను చూడండి.',
});

/**
 * Resolve parent accounts whose children received a diary update since the
 * previous daily cutoff. A post made after 5 PM is therefore included in the
 * following day's digest instead of being silently missed.
 *
 * The DISTINCT pair is the core guarantee: multiple subjects and multiple
 * children in the same school still resolve to one notification recipient.
 * Student accounts are intentionally excluded from the daily digest.
 */
export async function getDailyDiaryDigestRecipients(timezone, cutoffHour, db = sql) {
  return db`
    WITH digest_window AS (
      SELECT (
        date_trunc('day', now() AT TIME ZONE ${timezone})
        + (${cutoffHour} * INTERVAL '1 hour')
      ) AT TIME ZONE ${timezone} AS window_end
    )
    SELECT DISTINCT d.school_id, u.id AS user_id
    FROM diary_entries d
    CROSS JOIN digest_window dw
    JOIN schools school
      ON school.id = d.school_id
     AND school.is_active = TRUE
    JOIN student_enrollments se
      ON se.class_section_id = d.class_section_id
     AND se.school_id = d.school_id
     AND se.status = 'active'
     AND se.deleted_at IS NULL
    JOIN students student
      ON student.id = se.student_id
     AND student.school_id = d.school_id
     AND student.deleted_at IS NULL
    JOIN student_parents sp
      ON sp.student_id = student.id
     AND sp.school_id = d.school_id
     AND sp.deleted_at IS NULL
    JOIN parents parent
      ON parent.id = sp.parent_id
     AND parent.school_id = d.school_id
     AND parent.deleted_at IS NULL
    JOIN users u
      ON u.person_id = parent.person_id
     AND u.school_id = d.school_id
     AND u.account_status = 'active'
     AND u.deleted_at IS NULL
    WHERE GREATEST(COALESCE(d.updated_at, d.created_at), d.created_at)
            > dw.window_end - INTERVAL '1 day'
      AND GREATEST(COALESCE(d.updated_at, d.created_at), d.created_at)
            <= dw.window_end
      AND d.deleted_at IS NULL
      AND se.start_date <= (dw.window_end AT TIME ZONE ${timezone})::date
      AND (se.end_date IS NULL OR se.end_date >= (dw.window_end AT TIME ZONE ${timezone})::date)
      AND (sp.valid_from IS NULL OR sp.valid_from <= (dw.window_end AT TIME ZONE ${timezone})::date)
      AND (sp.valid_to IS NULL OR sp.valid_to >= (dw.window_end AT TIME ZONE ${timezone})::date)
    ORDER BY d.school_id, u.id
  `;
}

/**
 * Send one generic diary digest per parent account, grouped by school.
 * A failure for one tenant is isolated so it cannot duplicate notifications
 * already delivered to another tenant through a pg-boss job retry.
 */
export async function sendDailyDiaryDigests({
  timezone = 'Asia/Kolkata',
  cutoffHour = 17,
  db = sql,
  notify = sendNotificationToUsers,
} = {}) {
  const rows = await getDailyDiaryDigestRecipients(timezone, cutoffHour, db);
  const userIdsBySchool = new Map();

  for (const row of rows) {
    if (!userIdsBySchool.has(row.school_id)) userIdsBySchool.set(row.school_id, new Set());
    userIdsBySchool.get(row.school_id).add(row.user_id);
  }

  const summary = {
    schoolsProcessed: 0,
    schoolsFailed: 0,
    parentsTargeted: 0,
    tokensSent: 0,
    tokensFailed: 0,
  };

  for (const [schoolId, userIdSet] of userIdsBySchool) {
    const userIds = [...userIdSet];
    summary.parentsTargeted += userIds.length;

    try {
      const result = await notify(
        userIds,
        'DIARY_UPDATED',
        DIARY_DIGEST_MESSAGE,
        { role: 'parent' },
      );
      summary.schoolsProcessed += 1;
      summary.tokensSent += Number(result?.successCount || 0);
      summary.tokensFailed += Number(result?.failureCount || 0);
    } catch (error) {
      summary.schoolsFailed += 1;
      logger.error(
        { err: error, event: 'diary_digest_dispatch_failed', schoolId },
        'Daily diary digest failed for school',
      );
    }
  }

  return summary;
}
