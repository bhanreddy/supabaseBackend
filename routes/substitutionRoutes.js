import express from 'express';
import sql from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { sendNotificationToUsers } from '../services/notificationService.js';
import { rankSubstitutionCandidates } from '../services/substitutionRankingService.js';

const router = express.Router();
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function weekdayForDate(date) {
  return DAYS[new Date(`${date}T12:00:00.000Z`).getUTCDay()];
}

function requireDate(res, rawDate) {
  const date = String(rawDate || '');
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (
    !YMD_RE.test(date) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    res.status(400).json({ error: 'date must be a valid YYYY-MM-DD value' });
    return null;
  }
  return date;
}

function firstAfternoonPeriodNumber(schoolId) {
  return sql`
    (
      SELECT p.sort_order
      FROM periods p
      WHERE p.school_id = ${schoolId}
        AND COALESCE(p.is_break, false) = false
        AND p.sort_order > COALESCE(
          (SELECT sort_order FROM periods
            WHERE school_id = ${schoolId} AND name ILIKE '%lunch%'
            ORDER BY sort_order DESC LIMIT 1),
          (SELECT sort_order FROM periods
            WHERE school_id = ${schoolId} AND is_break = true
            ORDER BY (end_time - start_time) DESC, start_time LIMIT 1),
          (SELECT MIN(sort_order) - 1 FROM periods
            WHERE school_id = ${schoolId}
              AND COALESCE(is_break, false) = false
              AND start_time >= TIME '13:00')
        )
      ORDER BY p.sort_order
      LIMIT 1
    )
  `;
}

async function scheduleContext(exec, schoolId, date) {
  const [row] = await exec`
    SELECT ay.id AS academic_year_id, s.timetable_mode
    FROM academic_years ay
    JOIN schools s ON s.id = ay.school_id
    WHERE ay.school_id = ${schoolId}
      AND ${date}::date BETWEEN ay.start_date AND ay.end_date
    ORDER BY ay.start_date DESC
    LIMIT 1
  `;
  if (!row) return null;
  return {
    academicYearId: row.academic_year_id,
    mode: row.timetable_mode === 'per_day' ? 'per_day' : 'uniform',
    timetableDay: row.timetable_mode === 'per_day' ? weekdayForDate(date) : 'monday',
  };
}

async function todayForSchool(exec, schoolId) {
  const [row] = await exec`
    SELECT to_char(
      now() AT TIME ZONE COALESCE(
        (
          SELECT timezone.name
          FROM school_settings setting
          JOIN pg_timezone_names timezone ON timezone.name = setting.value
          WHERE setting.school_id = ${schoolId}
            AND setting.key = 'school_timezone'
          LIMIT 1
        ),
        'Asia/Kolkata'
      ),
      'YYYY-MM-DD'
    ) AS date
  `;
  return row.date;
}

async function targetSlot(exec, { schoolId, slotId, date, lock = false }) {
  const context = await scheduleContext(exec, schoolId, date);
  if (!context) return { context: null, slot: null };
  const [slot] = await exec`
    SELECT
      ts.id AS slot_id, ts.academic_year_id, ts.class_section_id,
      ts.period_number, ts.subject_id, ts.teacher_id AS absent_teacher_id,
      ts.start_time, ts.end_time,
      c.name AS class_name, sec.name AS section_name,
      sub.name AS subject_name,
      COALESCE(NULLIF(tp.display_name, ''), tp.first_name, st.staff_code) AS absent_teacher_name
    FROM timetable_slots ts
    JOIN class_sections cs ON cs.id = ts.class_section_id
    JOIN classes c ON c.id = cs.class_id
    JOIN sections sec ON sec.id = cs.section_id
    JOIN subjects sub ON sub.id = ts.subject_id
    LEFT JOIN staff st ON st.id = ts.teacher_id
    LEFT JOIN persons tp ON tp.id = st.person_id
    WHERE ts.id = ${slotId}
      AND ts.school_id = ${schoolId}
      AND cs.school_id = ${schoolId}
      AND ts.academic_year_id = ${context.academicYearId}
      AND LOWER(ts.day_of_week::text) = ${context.timetableDay}
      AND ts.deleted_at IS NULL
    ${lock ? sql`FOR UPDATE` : sql``}
  `;
  return { context, slot: slot || null };
}

async function activeTeachingUserExists(exec, schoolId, staffId, academicYearId) {
  const [row] = await exec`
    SELECT u.id
    FROM staff st
    LEFT JOIN staff_statuses ss ON ss.id = st.status_id
    JOIN users u ON u.person_id = st.person_id
      AND u.school_id = ${schoolId}
      AND u.deleted_at IS NULL
      AND u.account_status = 'active'
    WHERE st.id = ${staffId}
      AND st.school_id = ${schoolId}
      AND st.deleted_at IS NULL
      AND (ss.id IS NULL OR ss.code = 'active')
      AND EXISTS (
        SELECT 1 FROM timetable_slots teaching
        WHERE teaching.teacher_id = st.id
          AND teaching.academic_year_id = ${academicYearId}
          AND teaching.deleted_at IS NULL
      )
    LIMIT 1
  `;
  return row || null;
}

/**
 * GET /substitutions/board?date=YYYY-MM-DD
 * A live operations board. Rows are the permanent schedule decorated with an
 * exact-date substitution; the underlying timetable is never mutated.
 */
router.get('/board', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const date = requireDate(res, req.query.date);
  if (!date) return;

  const context = await scheduleContext(sql, req.schoolId, date);
  if (!context) {
    return sendSuccess(res, req.schoolId, {
      date, academic_year_id: null, timetable_day: weekdayForDate(date),
      timetable_mode: 'uniform', periods: [], slots: [], teachers: [],
      summary: { total_slots: 0, covered_slots: 0, uncovered_slots: 0 },
    });
  }

  const [periods, slots, teachers] = await Promise.all([
    sql`
      SELECT id, name, start_time, end_time, sort_order
      FROM periods
      WHERE school_id = ${req.schoolId}
        AND COALESCE(is_break, false) = false
      ORDER BY sort_order, start_time
    `,
    sql`
      SELECT
        ts.id AS slot_id, ts.class_section_id, ts.period_number,
        ts.start_time, ts.end_time, ts.room_no,
        c.name AS class_name, sec.name AS section_name,
        sub.id AS subject_id, sub.name AS subject_name,
        ts.teacher_id AS regular_teacher_id,
        COALESCE(NULLIF(tp.display_name, ''), tp.first_name, regular_staff.staff_code) AS regular_teacher_name,
        cover.id AS substitution_id, cover.reason,
        cover.substitute_teacher_id,
        COALESCE(NULLIF(cp.display_name, ''), cp.first_name, cover_staff.staff_code) AS substitute_teacher_name,
        cover.created_at AS assigned_at
      FROM timetable_slots ts
      JOIN class_sections cs ON cs.id = ts.class_section_id
      JOIN classes c ON c.id = cs.class_id
      JOIN sections sec ON sec.id = cs.section_id
      JOIN subjects sub ON sub.id = ts.subject_id
      LEFT JOIN staff regular_staff ON regular_staff.id = ts.teacher_id
      LEFT JOIN persons tp ON tp.id = regular_staff.person_id
      LEFT JOIN timetable_substitutions cover
        ON cover.timetable_slot_id = ts.id
        AND cover.school_id = ${req.schoolId}
        AND cover.substitution_date = ${date}
        AND cover.cancelled_at IS NULL
      LEFT JOIN staff cover_staff ON cover_staff.id = cover.substitute_teacher_id
      LEFT JOIN persons cp ON cp.id = cover_staff.person_id
      WHERE ts.school_id = ${req.schoolId}
        AND cs.school_id = ${req.schoolId}
        AND ts.academic_year_id = ${context.academicYearId}
        AND LOWER(ts.day_of_week::text) = ${context.timetableDay}
        AND ts.deleted_at IS NULL
      ORDER BY ts.period_number, c.name, sec.name
    `,
    sql`
      SELECT DISTINCT
        st.id,
        COALESCE(NULLIF(p.display_name, ''), p.first_name, st.staff_code) AS teacher_name
      FROM timetable_slots ts
      JOIN staff st ON st.id = ts.teacher_id
      JOIN persons p ON p.id = st.person_id
      JOIN class_sections cs ON cs.id = ts.class_section_id
      WHERE ts.school_id = ${req.schoolId}
        AND cs.school_id = ${req.schoolId}
        AND ts.academic_year_id = ${context.academicYearId}
        AND LOWER(ts.day_of_week::text) = ${context.timetableDay}
        AND ts.deleted_at IS NULL
      ORDER BY teacher_name
    `,
  ]);

  const covered = slots.filter((slot) => slot.substitution_id).length;
  return sendSuccess(res, req.schoolId, {
    date,
    academic_year_id: context.academicYearId,
    timetable_day: context.timetableDay,
    timetable_mode: context.mode,
    periods,
    slots,
    teachers,
    summary: {
      total_slots: slots.length,
      covered_slots: covered,
      uncovered_slots: slots.length - covered,
    },
  });
}));

/**
 * GET /substitutions/candidates?date=...&slot_id=...
 * Returns only hard-available teachers, ranked by subject fit, familiarity,
 * workload, adjacent periods, and recent substitution fairness.
 */
router.get('/candidates', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const date = requireDate(res, req.query.date);
  if (!date) return;
  const slotId = String(req.query.slot_id || '');
  if (!UUID_RE.test(slotId)) return res.status(400).json({ error: 'slot_id must be a valid UUID' });

  const { context, slot } = await targetSlot(sql, {
    schoolId: req.schoolId, slotId, date,
  });
  if (!context || !slot) return res.status(404).json({ error: 'Timetable slot is not scheduled for this date' });
  if (!slot.absent_teacher_id) {
    return res.status(400).json({ error: 'This timetable slot has no regular teacher to substitute' });
  }

  const candidates = await sql`
    SELECT
      st.id, st.staff_code, p.photo_url,
      COALESCE(NULLIF(p.display_name, ''), p.first_name, st.staff_code) AS teacher_name,
      ${slot.subject_name}::text AS subject_name,
      EXISTS (
        SELECT 1 FROM timetable_slots own_subject
        WHERE own_subject.teacher_id = st.id
          AND own_subject.academic_year_id = ${context.academicYearId}
          AND own_subject.subject_id = ${slot.subject_id}
          AND own_subject.deleted_at IS NULL
      ) AS subject_match,
      EXISTS (
        SELECT 1 FROM timetable_slots known_class
        WHERE known_class.teacher_id = st.id
          AND known_class.academic_year_id = ${context.academicYearId}
          AND known_class.class_section_id = ${slot.class_section_id}
          AND known_class.deleted_at IS NULL
      ) AS class_familiarity,
      EXISTS (
        SELECT 1 FROM class_sections home_class
        WHERE home_class.id = ${slot.class_section_id}
          AND home_class.class_teacher_id = st.id
          AND home_class.deleted_at IS NULL
      ) AS is_class_teacher,
      (
        SELECT COUNT(DISTINCT day_slot.period_number)::int
        FROM timetable_slots day_slot
        WHERE day_slot.teacher_id = st.id
          AND day_slot.academic_year_id = ${context.academicYearId}
          AND LOWER(day_slot.day_of_week::text) = ${context.timetableDay}
          AND day_slot.deleted_at IS NULL
      ) AS daily_load,
      (
        SELECT COUNT(*)::int
        FROM timetable_slots adjacent
        WHERE adjacent.teacher_id = st.id
          AND adjacent.academic_year_id = ${context.academicYearId}
          AND LOWER(adjacent.day_of_week::text) = ${context.timetableDay}
          AND adjacent.period_number IN (${Number(slot.period_number) - 1}, ${Number(slot.period_number) + 1})
          AND adjacent.deleted_at IS NULL
      ) AS adjacent_load,
      (
        SELECT COUNT(*)::int
        FROM timetable_substitutions recent
        WHERE recent.school_id = ${req.schoolId}
          AND recent.substitute_teacher_id = st.id
          AND recent.cancelled_at IS NULL
          AND recent.substitution_date BETWEEN (${date}::date - INTERVAL '30 days') AND ${date}::date
      ) AS recent_substitution_count,
      (
        SELECT sa.status::text
        FROM staff_attendance sa
        WHERE sa.school_id = ${req.schoolId}
          AND sa.staff_id = st.id
          AND sa.attendance_date = ${date}
          AND sa.deleted_at IS NULL
        LIMIT 1
      ) AS attendance_status
    FROM staff st
    JOIN persons p ON p.id = st.person_id
    LEFT JOIN staff_statuses ss ON ss.id = st.status_id
    WHERE st.school_id = ${req.schoolId}
      AND st.id <> ${slot.absent_teacher_id}
      AND st.deleted_at IS NULL
      AND (ss.id IS NULL OR ss.code = 'active')
      AND EXISTS (
        SELECT 1 FROM timetable_slots teaching
        WHERE teaching.teacher_id = st.id
          AND teaching.academic_year_id = ${context.academicYearId}
          AND teaching.deleted_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM users u
        WHERE u.person_id = st.person_id
          AND u.school_id = ${req.schoolId}
          AND u.deleted_at IS NULL
          AND u.account_status = 'active'
      )
      AND NOT EXISTS (
        SELECT 1 FROM timetable_slots busy
        WHERE busy.teacher_id = st.id
          AND busy.academic_year_id = ${context.academicYearId}
          AND LOWER(busy.day_of_week::text) = ${context.timetableDay}
          AND busy.period_number = ${slot.period_number}
          AND busy.deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM timetable_substitutions other_cover
        WHERE other_cover.school_id = ${req.schoolId}
          AND other_cover.substitution_date = ${date}
          AND other_cover.substitute_teacher_id = st.id
          AND other_cover.period_number = ${slot.period_number}
          AND other_cover.cancelled_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM staff_attendance absent
        WHERE absent.school_id = ${req.schoolId}
          AND absent.staff_id = st.id
          AND absent.attendance_date = ${date}
          AND absent.status = 'absent'
          AND absent.deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM timetable_substitutions absent_cover
        WHERE absent_cover.school_id = ${req.schoolId}
          AND absent_cover.substitution_date = ${date}
          AND absent_cover.absent_teacher_id = st.id
          AND absent_cover.cancelled_at IS NULL
      )
    ORDER BY teacher_name
  `;

  return sendSuccess(res, req.schoolId, {
    date,
    target: slot,
    candidates: rankSubstitutionCandidates(candidates),
  });
}));

/**
 * POST /substitutions
 * Atomically rechecks availability before assigning. Partial unique indexes
 * protect against two admins assigning the same teacher at the same time.
 */
router.post('/', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const date = requireDate(res, req.body.date);
  if (!date) return;
  const slotId = String(req.body.slot_id || '');
  const substituteTeacherId = String(req.body.substitute_teacher_id || '');
  const reason = String(req.body.reason || '').trim().slice(0, 500) || null;
  if (!UUID_RE.test(slotId) || !UUID_RE.test(substituteTeacherId)) {
    return res.status(400).json({ error: 'slot_id and substitute_teacher_id must be valid UUIDs' });
  }

  const today = await todayForSchool(sql, req.schoolId);
  if (date < today) {
    return res.status(400).json({ error: 'Past dates cannot receive new substitutions' });
  }

  let created;
  try {
    created = await sql.begin(async (tx) => {
      const { context, slot } = await targetSlot(tx, {
        schoolId: req.schoolId, slotId, date, lock: true,
      });
      if (!context || !slot) {
        const error = new Error('Timetable slot is not scheduled for this date');
        error.status = 404;
        throw error;
      }
      if (!slot.absent_teacher_id) {
        const error = new Error('This timetable slot has no regular teacher to substitute');
        error.status = 400;
        throw error;
      }
      if (slot.absent_teacher_id === substituteTeacherId) {
        const error = new Error('The regular teacher cannot substitute for their own class');
        error.status = 400;
        throw error;
      }

      const substituteUser = await activeTeachingUserExists(
        tx, req.schoolId, substituteTeacherId, context.academicYearId
      );
      if (!substituteUser) {
        const error = new Error('Selected teacher is inactive or is not scheduled to teach this academic year');
        error.status = 400;
        throw error;
      }

      const [blocked] = await tx`
        SELECT
          EXISTS (
            SELECT 1 FROM timetable_slots busy
            WHERE busy.teacher_id = ${substituteTeacherId}
              AND busy.academic_year_id = ${context.academicYearId}
              AND LOWER(busy.day_of_week::text) = ${context.timetableDay}
              AND busy.period_number = ${slot.period_number}
              AND busy.deleted_at IS NULL
          ) AS has_regular_class,
          EXISTS (
            SELECT 1 FROM timetable_substitutions other_cover
            WHERE other_cover.school_id = ${req.schoolId}
              AND other_cover.substitution_date = ${date}
              AND other_cover.substitute_teacher_id = ${substituteTeacherId}
              AND other_cover.period_number = ${slot.period_number}
              AND other_cover.cancelled_at IS NULL
          ) AS has_other_cover,
          EXISTS (
            SELECT 1 FROM staff_attendance absent
            WHERE absent.school_id = ${req.schoolId}
              AND absent.staff_id = ${substituteTeacherId}
              AND absent.attendance_date = ${date}
              AND absent.status = 'absent'
              AND absent.deleted_at IS NULL
          ) AS is_absent,
          EXISTS (
            SELECT 1 FROM timetable_substitutions absent_cover
            WHERE absent_cover.school_id = ${req.schoolId}
              AND absent_cover.substitution_date = ${date}
              AND absent_cover.absent_teacher_id = ${substituteTeacherId}
              AND absent_cover.cancelled_at IS NULL
          ) AS declared_absent
      `;
      if (blocked.has_regular_class || blocked.has_other_cover) {
        const error = new Error('That teacher is no longer free in this period. Refresh and choose another teacher.');
        error.status = 409;
        throw error;
      }
      if (blocked.is_absent || blocked.declared_absent) {
        const error = new Error('That teacher is marked absent for the selected date');
        error.status = 409;
        throw error;
      }

      const [row] = await tx`
        INSERT INTO timetable_substitutions (
          school_id, academic_year_id, substitution_date, timetable_slot_id,
          period_number, absent_teacher_id, substitute_teacher_id, reason, created_by
        ) VALUES (
          ${req.schoolId}, ${context.academicYearId}, ${date}, ${slot.slot_id},
          ${slot.period_number}, ${slot.absent_teacher_id}, ${substituteTeacherId},
          ${reason}, ${req.user.internal_id || null}
        )
        RETURNING *
      `;
      return { ...row, ...slot, substitute_user_id: substituteUser.id };
    });
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({
        error: 'This class or teacher was assigned by someone else. Refresh and try again.',
      });
    }
    throw error;
  }

  (async () => {
    try {
      const time = String(created.start_time || '').slice(0, 5);
      const message = `Substitution assigned: ${created.class_name}-${created.section_name}, ${created.subject_name}, ${time} on ${date}.`;
      await sendNotificationToUsers(
        [created.substitute_user_id],
        'TIMETABLE_UPDATED',
        { message, message_te: message },
        { deepLink: '/staff/timetable', senderId: req.user.internal_id }
      );
    } catch {}
  })();

  return sendSuccess(res, req.schoolId, {
    message: 'Substitute assigned for this date only',
    substitution: created,
  }, 201);
}));

router.delete('/:id', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid substitution id' });

  const [cancelled] = await sql`
    UPDATE timetable_substitutions
    SET cancelled_at = now(), cancelled_by = ${req.user.internal_id || null}
    WHERE id = ${id}
      AND school_id = ${req.schoolId}
      AND cancelled_at IS NULL
    RETURNING id
  `;
  if (!cancelled) return res.status(404).json({ error: 'Active substitution not found' });
  return sendSuccess(res, req.schoolId, { message: 'Substitution cancelled' });
}));

/** Staff-facing exact-date assignments, used by the timetable screen. */
router.get('/mine', requireAuth, asyncHandler(async (req, res) => {
  const date = requireDate(res, req.query.date);
  if (!date) return;

  const rows = await sql`
    SELECT
      cover.id, cover.substitution_date, cover.period_number, cover.reason,
      period.name AS period_name,
      ts.id AS timetable_slot_id, ts.class_section_id, ts.subject_id,
      ts.start_time, ts.end_time, ts.room_no,
      c.name AS class_name, sec.name AS section_name, subject.name AS subject_name,
      COALESCE(NULLIF(ap.display_name, ''), ap.first_name, absent_staff.staff_code) AS absent_teacher_name,
      CASE
        WHEN cover.period_number = 1 THEN 'morning'
        WHEN cover.period_number = ${firstAfternoonPeriodNumber(req.schoolId)} THEN 'afternoon'
        ELSE NULL
      END AS attendance_session
    FROM staff substitute_staff
    JOIN timetable_substitutions cover
      ON cover.substitute_teacher_id = substitute_staff.id
      AND cover.school_id = ${req.schoolId}
      AND cover.substitution_date = ${date}
      AND cover.cancelled_at IS NULL
    JOIN timetable_slots ts ON ts.id = cover.timetable_slot_id
    LEFT JOIN periods period
      ON period.school_id = ${req.schoolId}
      AND period.sort_order = cover.period_number
    JOIN class_sections cs ON cs.id = ts.class_section_id AND cs.school_id = ${req.schoolId}
    JOIN classes c ON c.id = cs.class_id
    JOIN sections sec ON sec.id = cs.section_id
    JOIN subjects subject ON subject.id = ts.subject_id
    JOIN staff absent_staff ON absent_staff.id = cover.absent_teacher_id
    JOIN persons ap ON ap.id = absent_staff.person_id
    WHERE substitute_staff.person_id = ${req.user.person_id}
      AND substitute_staff.school_id = ${req.schoolId}
      AND substitute_staff.deleted_at IS NULL
    ORDER BY cover.period_number
  `;
  return sendSuccess(res, req.schoolId, rows);
}));

export default router;
