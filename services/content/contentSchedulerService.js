import sql from '../../db.js';
import { fromZonedTime } from 'date-fns-tz';
import { logContentAudit } from './contentAuditService.js';
import { notifyContentPublished } from './contentNotificationService.js';
import { getSchoolTimezone } from '../celebration/birthdayResolver.js';
import {
  DEFAULT_CONTENT_TIMEZONE,
  schoolLocalDate,
  schoolIsoWeekday,
} from './contentUtils.js';
import logger from '../../utils/logger.js';

const RECURRENCE_TYPES = new Set(['ONCE', 'DAILY', 'WEEKDAYS', 'CUSTOM_WEEKDAYS', 'SCHOOL_DAYS']);

let publishTimer = null;

async function occupyThoughtSlot(tx, { schoolId, contentId, overrideDuplicate = false }) {
  const [thought] = await tx`
    SELECT id, slot_date FROM public.content_thoughts
    WHERE content_id = ${contentId} AND school_id = ${schoolId}
  `;
  if (!thought) return;

  const [occupant] = await tx`
    SELECT content_id FROM public.content_thoughts
    WHERE school_id = ${schoolId}
      AND slot_date = ${thought.slot_date}
      AND occupies_slot IS TRUE
      AND content_id <> ${contentId}
    LIMIT 1
  `;

  if (occupant) {
    if (!overrideDuplicate) {
      const err = new Error(
        `A daily thought already occupies ${thought.slot_date}. Pass override_duplicate to replace it.`,
      );
      err.code = 'THOUGHT_SLOT_TAKEN';
      throw err;
    }
    await tx`
      UPDATE public.content_thoughts
      SET occupies_slot = FALSE, updated_at = NOW()
      WHERE school_id = ${schoolId} AND content_id = ${occupant.content_id}
    `;
  }

  await tx`
    UPDATE public.content_thoughts
    SET occupies_slot = TRUE, updated_at = NOW()
    WHERE content_id = ${contentId} AND school_id = ${schoolId}
  `;
}

export async function occupyPublishedThoughtSlot({ schoolId, contentId, overrideDuplicate = false }) {
  try {
    return await sql.begin(async (tx) => occupyThoughtSlot(tx, { schoolId, contentId, overrideDuplicate }));
  } catch (err) {
    if (String(err?.message || '').includes('occupies_slot')) {
      logger.warn({ err: err.message }, 'Thought slot occupancy unavailable until content hardening migration is applied');
      return;
    }
    throw err;
  }
}

export function computeNextRunAt({
  recurrenceType,
  timeOfDay = '08:00',
  timezone = DEFAULT_CONTENT_TIMEZONE,
  weekdays = [],
  fromDate = new Date(),
}) {
  const [hours, minutes] = String(timeOfDay).split(':').map((n) => parseInt(n, 10) || 0);
  const probe = new Date(fromDate.getTime() + 60 * 1000);

  for (let i = 0; i < 14; i += 1) {
    const candidateDay = new Date(probe.getTime() + i * 24 * 60 * 60 * 1000);
    const localDate = schoolLocalDate(timezone, candidateDay);
    const weekday = schoolIsoWeekday(timezone, candidateDay);
    const allowed =
      recurrenceType === 'DAILY' ||
      (recurrenceType === 'WEEKDAYS' && weekday >= 1 && weekday <= 5) ||
      (recurrenceType === 'SCHOOL_DAYS' && weekday >= 1 && weekday <= 6) ||
      (recurrenceType === 'CUSTOM_WEEKDAYS' && weekdays.map(Number).includes(weekday)) ||
      recurrenceType === 'ONCE';

    if (!allowed) continue;

    const wall = `${localDate}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
    const resolved = fromZonedTime(wall, timezone);
    if (resolved > fromDate) return resolved;
    if (recurrenceType === 'ONCE') return resolved;
  }
  return new Date(fromDate.getTime() + 24 * 60 * 60 * 1000);
}

async function isSchoolHoliday(schoolId, localDate) {
  const [row] = await sql`
    SELECT 1
    FROM public.calendar_events
    WHERE school_id = ${schoolId}
      AND deleted_at IS NULL
      AND status = 'PUBLISHED'
      AND start_date <= ${localDate}::date
      AND end_date >= ${localDate}::date
      AND (
        event_type IN ('HOLIDAY', 'VACATION')
        OR holiday_type IN ('PUBLIC_HOLIDAY', 'SCHOOL_HOLIDAY', 'VACATION', 'EMERGENCY_HOLIDAY')
      )
    LIMIT 1
  `;
  return Boolean(row);
}

/**
 * Publish overdue one-shot SCHEDULED items. Uses a transaction + SKIP LOCKED.
 */
export async function processScheduledPublishing(schoolId = null) {
  try {
    return await sql.begin(async (tx) => {
      const overdueItems = schoolId
        ? await tx`
            SELECT id, school_id, type, title, summary, scheduled_at
            FROM public.content_items
            WHERE status = 'SCHEDULED'
              AND scheduled_at <= NOW()
              AND school_id = ${schoolId}
              AND deleted_at IS NULL
            FOR UPDATE SKIP LOCKED
          `
        : await tx`
            SELECT id, school_id, type, title, summary, scheduled_at
            FROM public.content_items
            WHERE status = 'SCHEDULED'
              AND scheduled_at <= NOW()
              AND deleted_at IS NULL
            FOR UPDATE SKIP LOCKED
          `;

      if (!overdueItems.length) return { publishedCount: 0 };

      let publishedCount = 0;
      const published = [];

      for (const item of overdueItems) {
        try {
          if (item.type === 'THOUGHT') {
            await occupyThoughtSlot(tx, { schoolId: item.school_id, contentId: item.id });
          }
        } catch (slotErr) {
          if (String(slotErr?.message || '').includes('occupies_slot')) {
            logger.warn({ err: slotErr.message, contentId: item.id }, 'Thought slot occupancy unavailable until content hardening migration is applied');
          } else {
            logger.warn({ err: slotErr.message, contentId: item.id }, 'Scheduled thought skipped — slot occupied');
            continue;
          }
        }

        await tx`
          UPDATE public.content_items
          SET
            status = 'PUBLISHED',
            published_at = NOW(),
            updated_at = NOW()
          WHERE id = ${item.id} AND school_id = ${item.school_id}
        `;

        await logContentAudit({
          schoolId: item.school_id,
          contentId: item.id,
          action: 'SCHEDULED_PUBLISH_AUTO',
          performedBy: null,
          changedFields: { status: 'PUBLISHED', previousScheduledAt: item.scheduled_at },
          previousState: { status: 'SCHEDULED' },
          newState: { status: 'PUBLISHED' },
          tx,
        });

        publishedCount += 1;
        published.push(item);
      }

      return { publishedCount, published };
    }).then(async (result) => {
      for (const item of result.published || []) {
        void notifyContentPublished({
          schoolId: item.school_id,
          contentId: item.id,
          type: item.type,
          title: item.title,
          summary: item.summary,
        });
      }
      return { publishedCount: result.publishedCount };
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Error in processScheduledPublishing');
    return { publishedCount: 0, error: err.message };
  }
}

export async function upsertContentSchedule({
  schoolId,
  contentId,
  recurrenceType = 'ONCE',
  timeOfDay = '08:00',
  weekdays = [],
  timezone,
  overrideDuplicate = false,
  scheduledAt = null,
}) {
  const type = RECURRENCE_TYPES.has(recurrenceType) ? recurrenceType : 'ONCE';
  const tz = timezone || (await getSchoolTimezone(schoolId)) || DEFAULT_CONTENT_TIMEZONE;
  const nextRunAt = scheduledAt
    ? new Date(scheduledAt)
    : computeNextRunAt({ recurrenceType: type, timeOfDay, timezone: tz, weekdays });

  const [row] = await sql`
    INSERT INTO public.content_schedules (
      school_id,
      content_id,
      recurrence_type,
      weekdays,
      time_of_day,
      timezone,
      next_run_at,
      is_active,
      override_duplicate
    ) VALUES (
      ${schoolId},
      ${contentId},
      ${type},
      ${weekdays || []},
      ${timeOfDay},
      ${tz},
      ${nextRunAt},
      TRUE,
      ${Boolean(overrideDuplicate)}
    )
    ON CONFLICT (content_id) DO UPDATE SET
      recurrence_type = EXCLUDED.recurrence_type,
      weekdays = EXCLUDED.weekdays,
      time_of_day = EXCLUDED.time_of_day,
      timezone = EXCLUDED.timezone,
      next_run_at = EXCLUDED.next_run_at,
      is_active = TRUE,
      override_duplicate = EXCLUDED.override_duplicate,
      updated_at = NOW()
    RETURNING *
  `;
  return row;
}

export async function processRecurringSchedules() {
  try {
    const claimed = await sql.begin(async (tx) => {
      const due = await tx`
        SELECT *
        FROM public.content_schedules
        WHERE is_active IS TRUE
          AND next_run_at IS NOT NULL
          AND next_run_at <= NOW()
        FOR UPDATE SKIP LOCKED
      `;
      const rows = [];
      for (const schedule of due) {
        const timezone = schedule.timezone || DEFAULT_CONTENT_TIMEZONE;
        const next = schedule.recurrence_type === 'ONCE'
          ? null
          : computeNextRunAt({
              recurrenceType: schedule.recurrence_type,
              timeOfDay: schedule.time_of_day,
              timezone,
              weekdays: schedule.weekdays,
            });
        await tx`
          UPDATE public.content_schedules
          SET
            last_run_at = NOW(),
            next_run_at = ${next},
            is_active = ${schedule.recurrence_type !== 'ONCE'},
            updated_at = NOW()
          WHERE id = ${schedule.id}
        `;
        rows.push(schedule);
      }
      return rows;
    });

    if (!claimed.length) return { processed: 0 };

    let processed = 0;
    for (const schedule of claimed) {
      try {
        const timezone = schedule.timezone || DEFAULT_CONTENT_TIMEZONE;
        const localDate = schoolLocalDate(timezone);
        if (schedule.recurrence_type === 'SCHOOL_DAYS' && await isSchoolHoliday(schedule.school_id, localDate)) {
          continue;
        }

        const [item] = await sql`
          SELECT id, type, title, summary, status
          FROM public.content_items
          WHERE id = ${schedule.content_id}
            AND school_id = ${schedule.school_id}
            AND deleted_at IS NULL
        `;
        if (!item) {
          await sql`UPDATE public.content_schedules SET is_active = FALSE WHERE id = ${schedule.id}`;
          continue;
        }

        if (item.type === 'THOUGHT') {
          await sql`
            UPDATE public.content_thoughts
            SET slot_date = ${localDate}::date, updated_at = NOW()
            WHERE content_id = ${item.id} AND school_id = ${schedule.school_id}
          `;
          try {
            await occupyPublishedThoughtSlot({
              schoolId: schedule.school_id,
              contentId: item.id,
              overrideDuplicate: schedule.override_duplicate,
            });
          } catch (slotErr) {
            logger.warn({ err: slotErr.message, contentId: item.id }, 'Recurring thought skipped — slot occupied');
            continue;
          }
        }

        if (item.status !== 'PUBLISHED') {
          await sql`
            UPDATE public.content_items
            SET status = 'PUBLISHED', published_at = NOW(), updated_at = NOW()
            WHERE id = ${item.id} AND school_id = ${schedule.school_id}
          `;
        }

        await logContentAudit({
          schoolId: schedule.school_id,
          contentId: item.id,
          action: 'SCHEDULED_PUBLISH_AUTO',
          performedBy: null,
          changedFields: { recurrenceType: schedule.recurrence_type, slotDate: localDate },
          previousState: { status: item.status },
          newState: { status: 'PUBLISHED' },
        });

        void notifyContentPublished({
          schoolId: schedule.school_id,
          contentId: item.id,
          type: item.type,
          title: item.title,
          summary: item.summary,
        });
        processed += 1;
      } catch (itemErr) {
        logger.error({ err: itemErr.message, scheduleId: schedule.id }, 'Recurring schedule tick failed');
      }
    }
    return { processed };
  } catch (err) {
    if (String(err?.message || '').includes('content_schedules')) {
      return { processed: 0 };
    }
    logger.error({ err: err.message }, 'Error in processRecurringSchedules');
    return { processed: 0, error: err.message };
  }
}

export async function processDueContentPublishing(schoolId = null) {
  const oneShot = await processScheduledPublishing(schoolId);
  const recurring = schoolId ? { processed: 0 } : await processRecurringSchedules();
  return { publishedCount: oneShot.publishedCount || 0, recurringProcessed: recurring.processed || 0 };
}

export function startContentPublishWorker() {
  if (publishTimer) return;
  setTimeout(() => {
    processDueContentPublishing().catch((err) => {
      logger.error({ err: err.message }, 'content_initial_publish_tick_failed');
    });
  }, 8000);
  publishTimer = setInterval(() => {
    processDueContentPublishing().catch((err) => {
      logger.error({ err: err.message }, 'content_interval_publish_tick_failed');
    });
  }, 60 * 1000);
  if (typeof publishTimer.unref === 'function') publishTimer.unref();
}

export function stopContentPublishWorker() {
  if (publishTimer) {
    clearInterval(publishTimer);
    publishTimer = null;
  }
}
