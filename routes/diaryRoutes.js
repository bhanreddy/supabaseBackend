import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendNotificationToUsers } from '../services/notificationService.js';
import fs from 'fs';
import { resolveDiaryTextFields } from '../services/geminiTranslator.js';

const router = express.Router();

/** Rolling window of diary entry dates kept and returned (today + prior 14 days). */
const DIARY_RETENTION_DAYS = 15;
const diaryRetentionOffsetDays = DIARY_RETENTION_DAYS - 1;

function logDebug(msg) {
  try {
    fs.appendFileSync('debug_log.txt', `${new Date().toISOString()} - ${msg}\n`);
  } catch (e) {}
}

async function validateDiaryTarget(schoolId, classSectionId, subjectId) {
  const [classSection] = await sql`
    SELECT id
    FROM class_sections
    WHERE id = ${classSectionId}
      AND school_id = ${schoolId}
      AND deleted_at IS NULL
  `;
  if (!classSection) {
    return { ok: false, status: 404, error: 'Class-section not found' };
  }

  // A null subject is intentional: it represents a class-wide diary entry.
  if (subjectId == null) return { ok: true };

  const [subject] = await sql`
    SELECT s.id
    FROM subjects s
    WHERE s.id = ${subjectId}
      AND s.school_id = ${schoolId}
      AND (
        EXISTS (
          SELECT 1
          FROM class_subjects csub
          WHERE csub.class_section_id = ${classSectionId}
            AND csub.subject_id = s.id
            AND csub.school_id = ${schoolId}
            AND csub.deleted_at IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM timetable_slots ts
          WHERE ts.class_section_id = ${classSectionId}
            AND ts.subject_id = s.id
            AND ts.school_id = ${schoolId}
            AND ts.deleted_at IS NULL
        )
      )
  `;

  if (!subject) {
    return { ok: false, status: 400, error: 'Subject is not assigned to this class-section' };
  }
  return { ok: true };
}

/**
 * GET /diary
 * DR1: All branches now filter by school_id via diary_entries.school_id
 */
router.get('/', requirePermission('diary.view'), asyncHandler(async (req, res) => {
  const { class_section_id, entry_date, from_date, to_date, subject_id, page = 1, limit = 20, updated_since } = req.query;
  const offset = (page - 1) * limit;
  const schoolId = req.schoolId;

  logDebug(`[Diary] Fetch Request: class=${class_section_id}, updated_since=${updated_since}, user=${req.user?.id}`);

  let entries;

  // Sync Logic (read-only): old rows are excluded by the date window below.
  // Run periodic DELETE via pg_cron / scheduler, e.g.:
  // DELETE FROM diary_entries WHERE entry_date < CURRENT_DATE - INTERVAL '15 days' AND school_id = $school;
  if (updated_since && class_section_id) {
    const sinceDate = new Date(parseInt(updated_since));
    entries = await sql`
      SELECT
        d.id, d.entry_date, d.title, d.title_te, d.content, d.content_te, d.homework_due_date, d.attachments,
        d.class_section_id, d.subject_id, d.created_by, d.created_at, d.updated_at,
        s.name as subject_name,
        creator.display_name as created_by_name
      FROM diary_entries d
      LEFT JOIN subjects s ON d.subject_id = s.id
      JOIN users u ON d.created_by = u.id
      JOIN persons creator ON u.person_id = creator.id
      WHERE d.class_section_id = ${class_section_id} AND d.school_id = ${schoolId}
        AND d.entry_date >= (CURRENT_DATE - (${diaryRetentionOffsetDays}) * INTERVAL '1 day')
        AND (d.updated_at > ${sinceDate} OR d.created_at > ${sinceDate})
      ORDER BY d.updated_at DESC
    `;
    logDebug(`[Diary] Sync found ${entries.length} entries`);
    res.set('ETag', false);
    return sendSuccess(res, req.schoolId, entries);
  }

  if (class_section_id && entry_date) {
    entries = await sql`
      SELECT
        d.id, d.entry_date, d.title, d.title_te, d.content, d.content_te, d.homework_due_date, d.attachments,
        d.class_section_id,
        s.name as subject_name,
        creator.display_name as created_by_name,
        d.created_at
      FROM diary_entries d
      LEFT JOIN subjects s ON d.subject_id = s.id
      JOIN users u ON d.created_by = u.id
      JOIN persons creator ON u.person_id = creator.id
      WHERE d.class_section_id = ${class_section_id} AND d.school_id = ${schoolId}
        AND d.entry_date = ${entry_date}
        AND d.entry_date >= (CURRENT_DATE - (${diaryRetentionOffsetDays}) * INTERVAL '1 day')
        ${subject_id ? sql`AND d.subject_id = ${subject_id}` : sql``}
      ORDER BY s.name NULLS LAST
    `;
  } else if (class_section_id && from_date && to_date) {
    entries = await sql`
      SELECT
        d.id, d.entry_date, d.title, d.title_te, d.content, d.content_te, d.homework_due_date,
        d.class_section_id,
        s.name as subject_name,
        creator.display_name as created_by_name
      FROM diary_entries d
      LEFT JOIN subjects s ON d.subject_id = s.id
      JOIN users u ON d.created_by = u.id
      JOIN persons creator ON u.person_id = creator.id
      WHERE d.class_section_id = ${class_section_id} AND d.school_id = ${schoolId}
        AND d.entry_date BETWEEN ${from_date} AND ${to_date}
        AND d.entry_date >= (CURRENT_DATE - (${diaryRetentionOffsetDays}) * INTERVAL '1 day')
      ORDER BY d.entry_date DESC, s.name NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (class_section_id) {
    entries = await sql`
      SELECT
        d.id, d.entry_date, d.title, d.title_te, d.content, d.content_te, d.homework_due_date, d.attachments,
        d.subject_id, d.created_by, d.created_at, d.updated_at,
        d.class_section_id,
        s.name as subject_name
      FROM diary_entries d
      LEFT JOIN subjects s ON d.subject_id = s.id
      WHERE d.class_section_id = ${class_section_id} AND d.school_id = ${schoolId}
        AND d.entry_date >= (CURRENT_DATE - (${diaryRetentionOffsetDays}) * INTERVAL '1 day')
      ORDER BY d.entry_date DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    // Teacher's own entries — scoped to school (no class_section_id on query)
    if (entry_date) {
      entries = await sql`
        SELECT
          d.id, d.entry_date, d.title, d.title_te, d.content, d.content_te, d.homework_due_date,
          s.name as subject_name,
          c.name as class_name, sec.name as section_name,
          d.class_section_id, d.subject_id,
          d.created_at, d.updated_at
        FROM diary_entries d
        JOIN class_sections csec ON d.class_section_id = csec.id
        JOIN classes c ON csec.class_id = c.id
        JOIN sections sec ON csec.section_id = sec.id
        LEFT JOIN subjects s ON d.subject_id = s.id
        WHERE d.created_by = ${req.user.internal_id}
          AND d.school_id = ${schoolId}
          AND d.entry_date = ${entry_date}
          AND EXISTS (
            -- Match GET /teachers/me/classes: an assignment may live in
            -- class_subjects OR timetable_slots. Checking only class_subjects
            -- hid diary entries a teacher posted to a timetable-only class.
            SELECT 1 FROM class_subjects csub
            JOIN staff st ON csub.teacher_id = st.id
            JOIN users u ON st.person_id = u.person_id
            WHERE u.id = ${req.user.id}
              AND csub.class_section_id = d.class_section_id
              AND csub.subject_id = d.subject_id
            UNION
            SELECT 1 FROM timetable_slots ts
            JOIN staff st ON ts.teacher_id = st.id
            JOIN users u ON st.person_id = u.person_id
            WHERE u.id = ${req.user.id}
              AND ts.class_section_id = d.class_section_id
              AND ts.subject_id = d.subject_id
              AND ts.deleted_at IS NULL
          )
        ORDER BY d.created_at DESC
      `;
    } else if (from_date && to_date) {
      // Staff diary history: full window without the default LIMIT 20 (which hid older days)
      entries = await sql`
        SELECT
          d.id, d.entry_date, d.title, d.title_te, d.content, d.content_te, d.homework_due_date,
          s.name as subject_name,
          c.name as class_name, sec.name as section_name,
          d.class_section_id, d.subject_id,
          d.created_at, d.updated_at
        FROM diary_entries d
        JOIN class_sections csec ON d.class_section_id = csec.id
        JOIN classes c ON csec.class_id = c.id
        JOIN sections sec ON csec.section_id = sec.id
        LEFT JOIN subjects s ON d.subject_id = s.id
        WHERE d.created_by = ${req.user.internal_id}
          AND d.school_id = ${schoolId}
          AND d.entry_date BETWEEN ${from_date} AND ${to_date}
          AND EXISTS (
            -- Match GET /teachers/me/classes: an assignment may live in
            -- class_subjects OR timetable_slots. Checking only class_subjects
            -- hid diary entries a teacher posted to a timetable-only class.
            SELECT 1 FROM class_subjects csub
            JOIN staff st ON csub.teacher_id = st.id
            JOIN users u ON st.person_id = u.person_id
            WHERE u.id = ${req.user.id}
              AND csub.class_section_id = d.class_section_id
              AND csub.subject_id = d.subject_id
            UNION
            SELECT 1 FROM timetable_slots ts
            JOIN staff st ON ts.teacher_id = st.id
            JOIN users u ON st.person_id = u.person_id
            WHERE u.id = ${req.user.id}
              AND ts.class_section_id = d.class_section_id
              AND ts.subject_id = d.subject_id
              AND ts.deleted_at IS NULL
          )
        ORDER BY d.entry_date DESC, d.created_at DESC
      `;
    } else {
      entries = await sql`
        SELECT
          d.id, d.entry_date, d.title, d.title_te, d.content, d.content_te, d.homework_due_date,
          s.name as subject_name,
          c.name as class_name, sec.name as section_name,
          d.class_section_id, d.subject_id,
          d.created_at, d.updated_at
        FROM diary_entries d
        JOIN class_sections csec ON d.class_section_id = csec.id
        JOIN classes c ON csec.class_id = c.id
        JOIN sections sec ON csec.section_id = sec.id
        LEFT JOIN subjects s ON d.subject_id = s.id
        WHERE d.created_by = ${req.user.internal_id}
          AND d.school_id = ${schoolId}
          AND EXISTS (
            -- Match GET /teachers/me/classes: an assignment may live in
            -- class_subjects OR timetable_slots. Checking only class_subjects
            -- hid diary entries a teacher posted to a timetable-only class.
            SELECT 1 FROM class_subjects csub
            JOIN staff st ON csub.teacher_id = st.id
            JOIN users u ON st.person_id = u.person_id
            WHERE u.id = ${req.user.id}
              AND csub.class_section_id = d.class_section_id
              AND csub.subject_id = d.subject_id
            UNION
            SELECT 1 FROM timetable_slots ts
            JOIN staff st ON ts.teacher_id = st.id
            JOIN users u ON st.person_id = u.person_id
            WHERE u.id = ${req.user.id}
              AND ts.class_section_id = d.class_section_id
              AND ts.subject_id = d.subject_id
              AND ts.deleted_at IS NULL
          )
        ORDER BY d.homework_due_date DESC NULLS LAST, d.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    }
  }

  return sendSuccess(res, req.schoolId, entries);
}));

/**
 * GET /diary/:id
 * DR2: Ownership check via class_sections.school_id
 */
router.get('/:id', requirePermission('diary.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

  const [entry] = await sql`
    SELECT
      d.id, d.entry_date, d.title, d.title_te, d.content, d.content_te, d.homework_due_date, d.attachments,
      d.subject_id, d.created_by, d.created_at, d.updated_at,
      d.class_section_id,
      s.name as subject_name,
      c.name as class_name, sec.name as section_name,
      creator.display_name as created_by_name
    FROM diary_entries d
    LEFT JOIN subjects s ON d.subject_id = s.id
    JOIN class_sections cs ON d.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    JOIN users u ON d.created_by = u.id
    JOIN persons creator ON u.person_id = creator.id
    WHERE d.id = ${id}
      AND d.school_id = ${schoolId}
  `;

  if (!entry) {
    return res.status(404).json({ error: 'Diary entry not found' });
  }

  return sendSuccess(res, req.schoolId, entry);
}));

/**
 * POST /diary — Create diary entry
 */
router.post('/', requirePermission('diary.create'), asyncHandler(async (req, res) => {
  const { class_section_id, subject_id, entry_date, title, content, homework_due_date, attachments, input_language } = req.body;
  const schoolId = req.schoolId;

  logDebug(`[Diary] Creating entry: class=${class_section_id}, date=${entry_date}, subject=${subject_id}, user=${req.user.internal_id}`);

  if (!class_section_id || !content || !entry_date) {
    return res.status(400).json({ error: 'class_section_id, content, and entry_date are required' });
  }

  const normalizedSubjectId = subject_id || null;
  const target = await validateDiaryTarget(schoolId, class_section_id, normalizedSubjectId);
  if (!target.ok) return res.status(target.status).json({ error: target.error });

  const resolved = await resolveDiaryTextFields({ title, content, input_language });
  const { title: resolvedTitle, title_te, content: resolvedContent, content_te } = resolved;

  let entry;
  let createdNew = true;
  try {
    const result = await sql`
      INSERT INTO diary_entries (school_id, class_section_id, subject_id, entry_date, title, title_te, content, content_te, homework_due_date, attachments, created_by)
      VALUES (${schoolId}, ${class_section_id}, ${normalizedSubjectId}, ${entry_date}, ${resolvedTitle}, ${title_te}, ${resolvedContent}, ${content_te},
              ${homework_due_date || null}, ${attachments ? JSON.stringify(attachments) : null}, ${req.user.internal_id})
      ON CONFLICT (school_id, class_section_id, subject_id, entry_date, created_by)
      DO UPDATE SET
        title = EXCLUDED.title,
        title_te = EXCLUDED.title_te,
        content = EXCLUDED.content,
        content_te = EXCLUDED.content_te,
        homework_due_date = EXCLUDED.homework_due_date,
        attachments = EXCLUDED.attachments,
        deleted_at = NULL,
        updated_at = now()
      RETURNING *, (xmax = 0) AS _was_insert
    `;
    const row = result[0];
    createdNew = row._was_insert === true;
    const { _was_insert, ...rest } = row;
    entry = rest;
  } catch (dbErr) {
    logDebug(`[Diary] DB Insert Error: ${dbErr.message}`);
    throw dbErr;
  }

  await sql`
    DELETE FROM diary_entries
    WHERE school_id = ${schoolId}
      AND class_section_id = ${class_section_id}
      AND entry_date < (CURRENT_DATE - (${diaryRetentionOffsetDays}) * INTERVAL '1 day')
  `;

  // Notification: DIARY_UPDATED (Students in class section from this school only)
  (async () => {
    try {
      const recipients = await sql`
        SELECT DISTINCT u.id
        FROM users u
        JOIN students s ON u.person_id = s.person_id
        JOIN student_enrollments se ON s.id = se.student_id
        WHERE se.class_section_id = ${class_section_id} AND u.school_id = ${req.schoolId}
          AND se.status = 'active'
          AND u.account_status = 'active'
          AND s.school_id = ${schoolId}

        UNION

        SELECT DISTINCT u.id
        FROM users u
        JOIN parents p ON u.person_id = p.person_id
        JOIN student_parents sp ON p.id = sp.parent_id
        JOIN students s ON sp.student_id = s.id
        JOIN student_enrollments se ON s.id = se.student_id
        WHERE se.class_section_id = ${class_section_id} AND u.school_id = ${req.schoolId}
          AND se.status = 'active'
          AND u.account_status = 'active'
          AND s.school_id = ${schoolId}
      `;

      if (recipients.length > 0) {
        const userIds = recipients.map((r) => r.id);
        await sendNotificationToUsers(userIds, 'DIARY_UPDATED', { message: title_te || resolvedTitle || 'New diary entry posted.' });
      }
    } catch (err) {}
  })();

  const message = createdNew ? 'Diary entry created' : 'Diary entry updated';
  return sendSuccess(res, req.schoolId, { message, entry }, createdNew ? 201 : 200);
}));

/**
 * PUT /diary/:id
 * DR3: Ownership check query scoped to school_id
 */
router.put('/:id', requirePermission('diary.create'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { subject_id, title, content, homework_due_date, attachments, input_language } = req.body;
  const schoolId = req.schoolId;

  // DR3: Scoped ownership check
  const [existing] = await sql`
    SELECT created_by, class_section_id
    FROM diary_entries
    WHERE id = ${id} AND school_id = ${schoolId} AND deleted_at IS NULL
  `;
  if (!existing) return res.status(404).json({ error: 'Diary entry not found' });

  const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
  const permissions = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
  const canManageDiary = roles.includes('admin') || permissions.includes('diary.manage');
  if (!canManageDiary && existing.created_by !== req.user.internal_id) {
    return res.status(403).json({ error: 'Can only update your own entries' });
  }

  const hasSubjectId = Object.prototype.hasOwnProperty.call(req.body, 'subject_id');
  if (hasSubjectId) {
    const target = await validateDiaryTarget(schoolId, existing.class_section_id, subject_id || null);
    if (!target.ok) return res.status(target.status).json({ error: target.error });
  }

  if (content !== undefined && !String(content).trim()) {
    return res.status(400).json({ error: 'content cannot be empty' });
  }

  logDebug(`[Diary] Updating entry: id=${id}, subject=${subject_id}`);

  let sql_title = sql`title`;
  let sql_content = sql`content`;
  let sql_title_te = sql`title_te`;
  let sql_content_te = sql`content_te`;
  const sql_subject = hasSubjectId ? sql`${subject_id || null}` : sql`subject_id`;
  const hasHomeworkDueDate = Object.prototype.hasOwnProperty.call(req.body, 'homework_due_date');
  const sql_homework_due_date = hasHomeworkDueDate ? sql`${homework_due_date || null}` : sql`homework_due_date`;
  const hasAttachments = Object.prototype.hasOwnProperty.call(req.body, 'attachments');
  const sql_attachments = hasAttachments
    ? sql`${attachments ? JSON.stringify(attachments) : null}`
    : sql`attachments`;

  if (title !== undefined || content !== undefined) {
    const resolved = await resolveDiaryTextFields({
      title: title ?? '',
      content: content ?? '',
      input_language: input_language || 'en',
    });
    if (title !== undefined) {
      sql_title = sql`${resolved.title}`;
      sql_title_te = sql`${resolved.title_te}`;
    }
    if (content !== undefined) {
      sql_content = sql`${resolved.content}`;
      sql_content_te = sql`${resolved.content_te}`;
    }
  }

  let updated;
  try {
    const result = await sql`
      UPDATE diary_entries
      SET
        subject_id = ${sql_subject},
        title = ${sql_title},
        content = ${sql_content},
        title_te = ${sql_title_te},
        content_te = ${sql_content_te},
        homework_due_date = ${sql_homework_due_date},
        attachments = ${sql_attachments},
        updated_at = now()
      WHERE id = ${id}
      AND school_id = ${req.schoolId}
      RETURNING *
    `;
    updated = result[0];
  } catch (dbErr) {
    logDebug(`[Diary] DB Update Error: ${dbErr.message}`);
    throw dbErr;
  }

  return sendSuccess(res, req.schoolId, { message: 'Diary entry updated', entry: updated });
}));

/**
 * DELETE /diary/:id
 * DR3: Ownership check query scoped to school_id
 */
router.delete('/:id', requirePermission('diary.create'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

  // DR3: Scoped ownership check
  const [existing] = await sql`
    SELECT created_by FROM diary_entries WHERE id = ${id} AND school_id = ${schoolId}
  `;
  if (!existing) return res.status(404).json({ error: 'Diary entry not found' });

  const isAdmin = req.user?.roles.includes('admin');
  if (!isAdmin && existing.created_by !== req.user.internal_id) {
    return res.status(403).json({ error: 'Can only delete your own entries' });
  }

  await sql`DELETE FROM diary_entries WHERE id = ${id} AND school_id = ${req.schoolId}`;
  return sendSuccess(res, req.schoolId, { message: 'Diary entry deleted' });
}));

export default router;
