import express from 'express';
import sql from '../db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { sendNotificationToUsers } from '../services/notificationService.js';
import { studentCacheDelete, studentCacheDeleteByPrefix } from '../utils/studentDataCache.js';

const router = express.Router();

/** Cached once per process: which audit columns exist on timetable_slots (legacy DBs may omit them). */
let timetableSlotTimestampColumns = null;

async function getTimetableSlotTimestampColumns(sqlClient) {
  if (timetableSlotTimestampColumns) return timetableSlotTimestampColumns;
  const rows = await sqlClient`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'timetable_slots'
      AND column_name IN ('created_at', 'updated_at')
  `;
  const has = new Set(rows.map((r) => r.column_name));
  timetableSlotTimestampColumns = {
    created_at: has.has('created_at'),
    updated_at: has.has('updated_at'),
  };
  return timetableSlotTimestampColumns;
}

/** Delta-sync filter for GET routes; omitted if columns are missing (full fetch). */
function timetableSlotsLastSyncedSql(lastSyncedAt, cols) {
  if (!lastSyncedAt) return sql``;
  if (cols.updated_at && cols.created_at) {
    return sql`AND (ts.updated_at >= ${lastSyncedAt} OR ts.created_at >= ${lastSyncedAt})`;
  }
  if (cols.updated_at) {
    return sql`AND ts.updated_at >= ${lastSyncedAt}`;
  }
  if (cols.created_at) {
    return sql`AND ts.created_at >= ${lastSyncedAt}`;
  }
  return sql``;
}

function timetableSlotsCacheKey(schoolId, classSectionId, yearId) {
  return `${schoolId}:timetable:class_section:${classSectionId}:year:${yearId}`;
}

function invalidateTimetableClassSectionCache(schoolId, classSectionId, academicYearId) {
  if (!classSectionId || !academicYearId) return;
  studentCacheDelete(timetableSlotsCacheKey(schoolId, classSectionId, academicYearId));
}

function invalidateAllTimetableCacheForSchool(schoolId) {
  studentCacheDeleteByPrefix(`${schoolId}:timetable:`);
}

/**
 * Weekdays used by the timetable (Mon–Sat). Sunday is intentionally excluded —
 * SchoolIMS schedules a 6-day week. day_of_week_enum also defines 'sunday' but
 * it is never written by the timetable manager.
 */
const TIMETABLE_WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const VALID_TIMETABLE_MODES = ['uniform', 'per_day'];

/** Resolve a school's scheduling mode. Defaults to 'uniform' for legacy/empty rows. */
async function getSchoolTimetableMode(schoolId) {
  const [row] = await sql`SELECT timetable_mode FROM schools WHERE id = ${schoolId}`;
  return row?.timetable_mode === 'per_day' ? 'per_day' : 'uniform';
}

/** Resolve the school's current academic year id (null if none is active). */
async function getCurrentAcademicYearId(schoolId) {
  const [year] = await sql`
    SELECT id FROM academic_years
    WHERE start_date <= current_date AND end_date >= current_date
      AND school_id = ${schoolId}
    ORDER BY start_date DESC
    LIMIT 1
  `;
  return year?.id || null;
}

/**
 * GET /config
 * Returns the caller's school scheduling mode. Auth-gated (read).
 */
router.get('/config', requireAuth, asyncHandler(async (req, res) => {
  const timetable_mode = await getSchoolTimetableMode(req.schoolId);
  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, req.schoolId, { timetable_mode });
}));

/**
 * PATCH /config
 * Switch the school between 'uniform' and 'per_day'.
 *
 *  - uniform → per_day : NON-destructive. Fans the single (Monday) template
 *    out into Tue–Sat for every section in the current academic year, so each
 *    weekday becomes independently editable starting from the shared baseline.
 *  - per_day → uniform : DESTRUCTIVE. Requires { confirm: true } and an optional
 *    source_day (default 'monday'). Collapses all sections to the source day's
 *    schedule and discards the other days. Rejected without confirm.
 */
router.patch('/config', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { timetable_mode, confirm, source_day } = req.body;

  if (!VALID_TIMETABLE_MODES.includes(timetable_mode)) {
    return res.status(400).json({ error: "timetable_mode must be 'uniform' or 'per_day'" });
  }

  const current = await getSchoolTimetableMode(schoolId);

  // No-op if unchanged.
  if (current === timetable_mode) {
    return sendSuccess(res, schoolId, { timetable_mode, changed: false });
  }

  const yearId = await getCurrentAcademicYearId(schoolId);

  if (timetable_mode === 'uniform') {
    // per_day → uniform : destructive collapse, must be explicitly confirmed.
    if (confirm !== true) {
      return res.status(400).json({
        error: 'Switching to uniform overwrites Tue–Sat with the source day. Resend with { confirm: true }.',
      });
    }

    const collapseDay = source_day || 'monday';
    if (!TIMETABLE_WEEKDAYS.includes(collapseDay)) {
      return res.status(400).json({ error: 'source_day must be one of Mon–Sat' });
    }

    if (yearId) {
      await sql.begin(async (sql) => {
        // 1. Discard every day that is not the source day.
        await sql`
          UPDATE timetable_slots ts
          SET deleted_at = now(), updated_at = now()
          FROM class_sections cs
          WHERE ts.class_section_id = cs.id
            AND cs.school_id = ${schoolId}
            AND ts.academic_year_id = ${yearId}
            AND ts.deleted_at IS NULL
            AND ts.day_of_week <> ${collapseDay}::day_of_week_enum
        `;
        // 2. The uniform template lives on Monday. If the source day isn't
        //    Monday, relabel the surviving rows (the old Monday rows were
        //    soft-deleted above, so no unique-index collision occurs).
        if (collapseDay !== 'monday') {
          await sql`
            UPDATE timetable_slots ts
            SET day_of_week = 'monday', updated_at = now()
            FROM class_sections cs
            WHERE ts.class_section_id = cs.id
              AND cs.school_id = ${schoolId}
              AND ts.academic_year_id = ${yearId}
              AND ts.deleted_at IS NULL
              AND ts.day_of_week = ${collapseDay}::day_of_week_enum
          `;
        }
      });
    }
  } else {
    // uniform → per_day : non-destructive fan-out of the Monday template.
    if (yearId) {
      await sql.begin(async (sql) => {
        for (const day of TIMETABLE_WEEKDAYS) {
          if (day === 'monday') continue;
          await sql`
            INSERT INTO timetable_slots (
              academic_year_id, class_section_id, period_number, day_of_week,
              subject_id, teacher_id, start_time, end_time, room_no, school_id
            )
            SELECT
              ts.academic_year_id, ts.class_section_id, ts.period_number, ${day}::day_of_week_enum,
              ts.subject_id, ts.teacher_id, ts.start_time, ts.end_time, ts.room_no, ts.school_id
            FROM timetable_slots ts
            JOIN class_sections cs ON ts.class_section_id = cs.id
            WHERE cs.school_id = ${schoolId}
              AND ts.academic_year_id = ${yearId}
              AND ts.day_of_week = 'monday'
              AND ts.deleted_at IS NULL
            ON CONFLICT (class_section_id, academic_year_id, day_of_week, period_number)
              WHERE deleted_at IS NULL DO NOTHING
          `;
        }
      });
    }
  }

  await sql`UPDATE schools SET timetable_mode = ${timetable_mode} WHERE id = ${schoolId}`;

  invalidateAllTimetableCacheForSchool(schoolId);

  // Notify every section affected in the current academic year.
  (async () => {
    try {
      if (!yearId) return;
      const affected = await sql`
        SELECT DISTINCT cs.id
        FROM class_sections cs
        WHERE cs.school_id = ${schoolId}
          AND EXISTS (
            SELECT 1 FROM timetable_slots ts
            WHERE ts.class_section_id = cs.id AND ts.academic_year_id = ${yearId}
          )
      `;
      if (affected.length > 0) {
        await notifyTimetableUpdate(affected.map((a) => a.id), schoolId);
      }
    } catch (err) {}
  })();

  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, schoolId, { timetable_mode, changed: true });
}));

/**
 * GET /:classSectionId/slots
 * TT1: requireAuth + requirePermission added
 * TT2: removed manual if(!req.user) guard
 */
router.get('/:classSectionId/slots', requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const { classSectionId } = req.params;
  const { academic_year_id, lastSyncedAt, day_of_week } = req.query;
  const schoolId = req.schoolId;

  if (day_of_week && !TIMETABLE_WEEKDAYS.includes(day_of_week)) {
    return res.status(400).json({ error: 'day_of_week must be one of Mon–Sat' });
  }

  if (!classSectionId) return res.status(400).json({ error: 'Class Section ID required' });

  // Ownership check: class_section must belong to this school
  const [cs] = await sql`SELECT id FROM class_sections WHERE id = ${classSectionId} AND school_id = ${schoolId}`;
  if (!cs) return res.status(404).json({ error: 'Class section not found' });

  let yearId = academic_year_id;
  if (!yearId) {
    const currentYear = await sql`
      SELECT id FROM academic_years
      WHERE start_date <= current_date AND end_date >= current_date
        AND school_id = ${schoolId}
      LIMIT 1
    `;
    if (currentYear.length > 0) yearId = currentYear[0].id;
    else return sendSuccess(res, req.schoolId, []);
  }

  // Admin class-slot editor must always read live DB rows (no in-memory cache).
  // Student delta sync uses lastSyncedAt; full-list cache was causing stale slots after delete.
  const slotTsCols = await getTimetableSlotTimestampColumns(sql);

  const slots = await sql`
    SELECT
      ts.id,
      ts.period_number,
      ts.day_of_week,
      ts.start_time,
      ts.end_time,
      ts.room_no,
      sub.name as subject_name,
      sub.name_te as subject_name_te,
      sub.id as subject_id,
      p.display_name as teacher_name,
      ts.teacher_id
    FROM timetable_slots ts
    JOIN subjects sub ON ts.subject_id = sub.id
    LEFT JOIN staff st ON ts.teacher_id = st.id
    LEFT JOIN persons p ON st.person_id = p.id
    JOIN class_sections cs ON ts.class_section_id = cs.id
    WHERE ts.class_section_id = ${classSectionId}
      AND cs.school_id = ${schoolId}
      AND ts.academic_year_id = ${yearId}
      AND ts.deleted_at IS NULL
      ${day_of_week ? sql`AND ts.day_of_week = ${day_of_week}::day_of_week_enum` : sql``}
      ${timetableSlotsLastSyncedSql(lastSyncedAt, slotTsCols)}
    ORDER BY ts.day_of_week, ts.period_number
  `;

  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, req.schoolId, slots);
}));

/**
 * POST /
 * TT1: requireAuth + requirePermission added
 * TT4: class_section ownership check before upsert
 */
router.post('/', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const {
    academic_year_id,
    class_section_id,
    period_number,
    subject_id,
    teacher_id: provided_teacher_id,
    room_no,
    day_of_week = 'monday'
  } = req.body;
  const schoolId = req.schoolId;

  if (!academic_year_id || !class_section_id || !period_number || !subject_id) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // TT4: Ownership check — class_section must belong to this school
  const [csCheck] = await sql`SELECT id FROM class_sections WHERE id = ${class_section_id} AND school_id = ${schoolId}`;
  if (!csCheck) return res.status(404).json({ error: 'Class section not found' });

  // TT4: academic_year must belong to this school
  const [ayCheck] = await sql`SELECT id FROM academic_years WHERE id = ${academic_year_id} AND school_id = ${schoolId}`;
  if (!ayCheck) return res.status(404).json({ error: 'Academic year not found' });

  const periodDef = await sql`
    SELECT start_time, end_time
    FROM periods
    WHERE sort_order = ${period_number}
      AND school_id = ${schoolId}
    LIMIT 1
  `;

  if (periodDef.length === 0) {
    return res.status(400).json({ error: `Invalid Period Number: ${period_number}. Only configured periods are allowed.` });
  }

  const { start_time, end_time } = periodDef[0];
  const final_teacher_id = provided_teacher_id || null;
  const final_room_no = room_no || null;

  // Mode-aware day resolution:
  //  - uniform mode keeps a single template stored on Monday (client day ignored).
  //  - per_day mode writes the requested weekday (Mon–Sat).
  const mode = await getSchoolTimetableMode(schoolId);
  const effectiveDay = mode === 'per_day' ? (day_of_week || 'monday') : 'monday';
  if (mode === 'per_day' && !TIMETABLE_WEEKDAYS.includes(effectiveDay)) {
    return res.status(400).json({ error: 'day_of_week must be one of Mon–Sat' });
  }

  const slotTsCols = await getTimetableSlotTimestampColumns(sql);

  await sql.begin(async (sql) => {
    const [existingSlot] = await sql`
      SELECT id FROM timetable_slots
      WHERE class_section_id = ${class_section_id}
        AND academic_year_id = ${academic_year_id}
        AND day_of_week = ${effectiveDay}::day_of_week_enum
        AND period_number = ${period_number}
        AND deleted_at IS NULL
      LIMIT 1
    `;

    if (final_teacher_id) {
      // Teacher double-booking guard — same period + weekday in another section.
      const overlap = await sql`
        SELECT 1 FROM timetable_slots
        WHERE teacher_id = ${final_teacher_id}
          AND academic_year_id = ${academic_year_id}
          AND day_of_week = ${effectiveDay}::day_of_week_enum
          AND period_number = ${period_number}
          AND class_section_id != ${class_section_id}
          AND deleted_at IS NULL
      `;

      if (overlap.length > 0) {
        const err = new Error(`Teacher Collision: Teacher is already booked for period ${period_number} on ${effectiveDay}`);
        err.statusCode = 409;
        throw err;
      }
    }

    if (existingSlot) {
      if (slotTsCols.updated_at) {
        await sql`
          UPDATE timetable_slots SET
            subject_id = ${subject_id},
            teacher_id = ${final_teacher_id},
            start_time = ${start_time},
            end_time = ${end_time},
            room_no = ${final_room_no},
            school_id = ${schoolId},
            updated_at = now()
          WHERE id = ${existingSlot.id}
        `;
      } else {
        await sql`
          UPDATE timetable_slots SET
            subject_id = ${subject_id},
            teacher_id = ${final_teacher_id},
            start_time = ${start_time},
            end_time = ${end_time},
            room_no = ${final_room_no},
            school_id = ${schoolId}
          WHERE id = ${existingSlot.id}
        `;
      }
    } else if (slotTsCols.updated_at) {
      await sql`
        INSERT INTO timetable_slots (
          academic_year_id, class_section_id, period_number, day_of_week,
          subject_id, teacher_id, start_time, end_time, room_no, school_id
        ) VALUES (
          ${academic_year_id}, ${class_section_id}, ${period_number}, ${effectiveDay}::day_of_week_enum,
          ${subject_id}, ${final_teacher_id}, ${start_time}, ${end_time}, ${final_room_no}, ${schoolId}
        )
      `;
    } else {
      await sql`
        INSERT INTO timetable_slots (
          academic_year_id, class_section_id, period_number, day_of_week,
          subject_id, teacher_id, start_time, end_time, room_no, school_id
        ) VALUES (
          ${academic_year_id}, ${class_section_id}, ${period_number}, ${effectiveDay}::day_of_week_enum,
          ${subject_id}, ${final_teacher_id}, ${start_time}, ${end_time}, ${final_room_no}, ${schoolId}
        )
      `;
    }

    // "First-period teacher is the class teacher": keep the authoritative
    // class_sections.class_teacher_id in sync with the Monday Period-1 slot. This is
    // the same slot the attendance auto-detection resolves to (ORDER BY day_of_week,
    // monday first), so editing the Period-1 teacher here immediately drives the
    // student list shown in that teacher's portal. final_teacher_id may be null,
    // which vacates the class teacher when Period 1 is cleared.
    if (Number(period_number) === 1 && effectiveDay === 'monday') {
      await sql`
        UPDATE class_sections
        SET class_teacher_id = ${final_teacher_id}
        WHERE id = ${class_section_id} AND school_id = ${schoolId}
      `;
    }
  });

  invalidateTimetableClassSectionCache(schoolId, class_section_id, academic_year_id);
  invalidateAllTimetableCacheForSchool(schoolId);

  (async () => {
    try {
      await notifyTimetableUpdate([class_section_id], schoolId);
    } catch (err) {}
  })();

  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, req.schoolId, { message: 'Timetable updated successfully' });
}));

/**
 * DELETE /:id
 * TT1: requireAuth added
 * TT4: school_id ownership check via class_sections join
 */
router.delete('/:id', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

  // TT4: Ownership check
  const [slot] = await sql`
    SELECT ts.id, ts.class_section_id, ts.academic_year_id, ts.period_number, ts.day_of_week, ts.teacher_id
    FROM timetable_slots ts
    JOIN class_sections cs ON ts.class_section_id = cs.id
    WHERE ts.id = ${id} AND cs.school_id = ${schoolId}
  `;
  if (!slot) return res.status(404).json({ error: 'Timetable slot not found' });

  await sql`
    UPDATE timetable_slots ts
    SET deleted_at = NOW(), updated_at = NOW()
    FROM class_sections cs
    WHERE ts.id = ${id}
      AND ts.class_section_id = cs.id
      AND cs.school_id = ${schoolId}
      AND ts.deleted_at IS NULL
  `;

  // Keep class teacher in sync: removing the Monday Period-1 slot vacates the
  // class_sections.class_teacher_id when it pointed at that slot's teacher, so the
  // teacher's portal stops listing that class's students.
  if (Number(slot.period_number) === 1 && slot.day_of_week === 'monday' && slot.teacher_id) {
    await sql`
      UPDATE class_sections
      SET class_teacher_id = NULL
      WHERE id = ${slot.class_section_id}
        AND school_id = ${schoolId}
        AND class_teacher_id = ${slot.teacher_id}
    `;
  }

  invalidateTimetableClassSectionCache(schoolId, slot.class_section_id, slot.academic_year_id);
  invalidateAllTimetableCacheForSchool(schoolId);

  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, req.schoolId, { message: 'Slot deleted' });
}));

/**
 * GET /my-timetable
 * TT1: requireAuth added
 * TT2: removed manual if(!req.user) guard
 */
router.get('/my-timetable', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const schoolId = req.schoolId;

  const enrollment = await sql`
    SELECT se.class_section_id, se.academic_year_id
    FROM student_enrollments se
    JOIN students s ON se.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    JOIN users u ON u.person_id = p.id
    WHERE u.id = ${userId}
      AND se.status = 'active'
      AND s.school_id = ${schoolId}
    LIMIT 1
  `;

  if (enrollment.length === 0) {
    return sendSuccess(res, req.schoolId, []);
  }

  const { class_section_id, academic_year_id } = enrollment[0];

  const slotTsCols = await getTimetableSlotTimestampColumns(sql);

  const slots = await sql`
    SELECT
      ts.period_number,
      ts.day_of_week,
      ts.start_time,
      ts.end_time,
      ts.room_no,
      sub.name as subject_name,
      sub.name_te as subject_name_te,
      p.display_name as teacher_name
    FROM timetable_slots ts
    JOIN subjects sub ON ts.subject_id = sub.id
    LEFT JOIN staff st ON ts.teacher_id = st.id
    LEFT JOIN persons p ON st.person_id = p.id
    JOIN class_sections cs ON ts.class_section_id = cs.id
    WHERE ts.class_section_id = ${class_section_id}
      AND cs.school_id = ${schoolId}
      AND ts.academic_year_id = ${academic_year_id}
      AND ts.deleted_at IS NULL
      ${timetableSlotsLastSyncedSql(req.query.lastSyncedAt, slotTsCols)}
    ORDER BY ts.day_of_week, ts.period_number, ts.start_time
  `;

  return sendSuccess(res, req.schoolId, slots);
}));

/**
 * GET /teacher-timetable
 * TT1/TT2: requireAuth replaces manual guard; academic_year scoped to school.
 * Optional ?staff_id= lets an admin view another staff member's timetable
 * (e.g. "view as" from Manage Staff) — requires admin role or staff.view.
 */
router.get('/teacher-timetable', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const schoolId = req.schoolId;
  const { academic_year_id, staff_id } = req.query;

  let teacherStaffId;
  if (staff_id) {
    if (req.staffPortalAccess && String(staff_id) !== String(req.staffPortalAccess.target_staff_id)) {
      return res.status(403).json({ error: 'Staff portal target mismatch' });
    }
    const isAdmin = req.user.roles.includes('admin');
    const canView = req.user.permissions.includes('staff.view');
    if (!isAdmin && !canView && !req.staffPortalAccess) {
      return res.status(403).json({ error: 'Forbidden: Missing permission staff.view' });
    }
    const [targetStaff] = await sql`SELECT id FROM staff WHERE id = ${staff_id} AND school_id = ${schoolId}`;
    if (!targetStaff) {
      return res.status(404).json({ error: 'Staff member not found' });
    }
    teacherStaffId = targetStaff.id;
  } else {
    const [staff] = await sql`
      SELECT st.id
      FROM staff st
      JOIN persons p ON st.person_id = p.id
      JOIN users u ON u.person_id = p.id
      WHERE u.id = ${userId} AND st.school_id = ${schoolId}
    `;
    if (!staff) {
      return res.status(404).json({ error: 'Staff profile not found' });
    }
    teacherStaffId = staff.id;
  }

  let yearId = academic_year_id;
  if (!yearId) {
    const currentYear = await sql`
      SELECT id FROM academic_years
      WHERE start_date <= current_date AND end_date >= current_date
        AND school_id = ${schoolId}
      LIMIT 1
    `;
    if (currentYear.length > 0) yearId = currentYear[0].id;
    else return sendSuccess(res, req.schoolId, []);
  }

  const slotTsCols = await getTimetableSlotTimestampColumns(sql);

  const slots = await sql`
    SELECT
      -- Display the teaching-period index (breaks excluded), not the raw
      -- sort_order. Slots store period_number = periods.sort_order, which
      -- counts breaks, causing labels to skip (1,2,4,5...). Count non-break
      -- periods up to this slot's position; fall back to the raw value when
      -- no period structure is configured so it never shows "Period 0".
      COALESCE(
        NULLIF((
          SELECT COUNT(*)::int
          FROM periods pp
          WHERE pp.school_id = cs.school_id
            AND COALESCE(pp.is_break, false) = false
            AND pp.sort_order <= ts.period_number
        ), 0),
        ts.period_number
      ) AS period_number,
      ts.day_of_week,
      ts.start_time,
      ts.end_time,
      ts.room_no,
      c.name as class_name,
      sec.name as section_name,
      sub.name as subject_name,
      sub.name_te as subject_name_te
    FROM timetable_slots ts
    JOIN class_sections cs ON ts.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    JOIN subjects sub ON ts.subject_id = sub.id
    WHERE ts.teacher_id = ${teacherStaffId}
      AND ts.academic_year_id = ${yearId}
      AND cs.school_id = ${schoolId}
      AND ts.deleted_at IS NULL
      ${timetableSlotsLastSyncedSql(req.query.lastSyncedAt, slotTsCols)}
    ORDER BY ts.day_of_week, ts.period_number, ts.start_time
  `;

  return sendSuccess(res, req.schoolId, slots);
}));

/**
 * GET /teacher-options
 * Minimal staff lookup for timetable assignment. This intentionally uses the
 * academics permission instead of the broader staff.view permission.
 */
router.get('/teacher-options', requirePermission('academics.view'), asyncHandler(async (req, res) => {
  const teachers = await sql`
    SELECT
      st.id,
      st.person_id,
      st.staff_code,
      p.first_name,
      p.last_name,
      p.display_name
    FROM staff st
    JOIN persons p ON st.person_id = p.id
    LEFT JOIN staff_statuses ss ON st.status_id = ss.id
    WHERE st.school_id = ${req.schoolId}
      AND st.deleted_at IS NULL
      AND (ss.id IS NULL OR ss.code = 'active')
    ORDER BY COALESCE(NULLIF(p.display_name, ''), p.first_name, st.staff_code)
  `;

  return sendSuccess(res, req.schoolId, teachers);
}));

/**
 * GET /periods/list
 * TT3: requireAuth added (periods shared structure, but at least auth-gated)
 */
router.get('/periods/list', requireAuth, asyncHandler(async (req, res) => {
  const periods = await sql`
    SELECT id, school_id, name, start_time, end_time, sort_order, is_break
    FROM periods
    WHERE school_id = ${req.schoolId}
    ORDER BY sort_order ASC, start_time ASC
  `;
  return sendSuccess(res, req.schoolId, periods);
}));

/**
 * POST /periods/create
 * TT3: requirePermission added
 */
router.post('/periods/create', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { name, start_time, end_time, is_break } = req.body;

  if (!name || !start_time || !end_time) {
    return res.status(400).json({ error: 'name, start_time, and end_time are required' });
  }

  if (start_time >= end_time) {
    return res.status(400).json({ error: 'End time must be after start time' });
  }

  const [maxRow] = await sql`
    SELECT COALESCE(MAX(sort_order), 0) AS max_order
    FROM periods
    WHERE school_id = ${req.schoolId}
  `;
  const sort_order = maxRow.max_order + 1;

  const [created] = await sql`
    INSERT INTO periods (school_id, name, start_time, end_time, sort_order, is_break)
    VALUES (${req.schoolId}, ${name}, ${start_time}, ${end_time}, ${sort_order}, ${is_break === true})
    RETURNING id, school_id, name, start_time, end_time, sort_order, is_break
  `;

  return sendSuccess(res, req.schoolId, created, 201);
}));

/**
 * PUT /periods
 * TT3: requirePermission added
 */
router.put('/periods', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { periods } = req.body;
  const schoolId = req.schoolId;

  if (!periods || !Array.isArray(periods)) {
    return res.status(400).json({ error: 'Invalid payload: periods array required' });
  }

  const isTempId = (id) => !id || String(id).startsWith('temp_');
  const normalizedPeriods = periods.map((p, index) => ({
    ...p,
    id: p.id ? String(p.id) : null,
    name: String(p.name || '').trim(),
    sort_order: index + 1,
    is_break: p.is_break === true,
  }));

  // ── Server-side validation (do not rely on client checks) ───────────────
  // 1. Each period must have end_time strictly after start_time.
  for (const p of normalizedPeriods) {
    if (!p.name || !p.start_time || !p.end_time) {
      return res.status(400).json({ error: 'Each period requires name, start_time and end_time' });
    }
    if (p.start_time >= p.end_time) {
      return res.status(400).json({ error: `Period "${p.name}": end time must be after start time` });
    }
  }
  // 2. No two periods may overlap in time.
  const ordered = [...normalizedPeriods].sort((a, b) => (a.start_time < b.start_time ? -1 : 1));
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start_time < ordered[i - 1].end_time) {
      return res.status(400).json({
        error: `Periods overlap: "${ordered[i - 1].name}" and "${ordered[i].name}"`,
      });
    }
  }

  const submittedIds = normalizedPeriods.filter((p) => !isTempId(p.id)).map((p) => p.id);
  if (new Set(submittedIds).size !== submittedIds.length) {
    return res.status(400).json({ error: 'Duplicate period id in payload' });
  }

  const existingPeriods = await sql`
    SELECT id, sort_order
    FROM periods
    WHERE school_id = ${schoolId}
  `;
  const existingIds = new Set(existingPeriods.map((p) => p.id));
  const unknownIds = submittedIds.filter((id) => !existingIds.has(id));
  if (unknownIds.length > 0) {
    return res.status(404).json({ error: 'One or more periods no longer exist. Refresh and try again.' });
  }

  const submittedIdSet = new Set(submittedIds);
  const removedPeriods = existingPeriods.filter((p) => !submittedIdSet.has(p.id));
  const existingSortById = new Map(existingPeriods.map((p) => [p.id, p.sort_order]));

  const updatedPeriodNumbers = [];
  let savedPeriods = [];

  await sql.begin(async (tx) => {
    if (removedPeriods.length > 0) {
      const removedIds = removedPeriods.map((p) => p.id);
      const removedSortOrders = removedPeriods.map((p) => p.sort_order).filter((n) => n != null);

      if (removedSortOrders.length > 0) {
        await tx`
          DELETE FROM timetable_slots ts
          USING class_sections cs
          WHERE ts.class_section_id = cs.id
            AND ts.period_number IN ${tx(removedSortOrders)}
            AND cs.school_id = ${schoolId}
        `;
      }

      await tx`
        DELETE FROM timetable_entries
        WHERE period_id IN ${tx(removedIds)}
          AND school_id = ${schoolId}
      `;

      await tx`
        DELETE FROM periods
        WHERE id IN ${tx(removedIds)}
          AND school_id = ${schoolId}
      `;
    }

    const movedPeriods = normalizedPeriods
      .filter((p) => !isTempId(p.id))
      .map((p) => ({
        oldSort: existingSortById.get(p.id),
        newSort: p.sort_order,
      }))
      .filter((p) => p.oldSort != null && p.oldSort !== p.newSort);

    // Move existing timetable assignments with their period rows when a break/period
    // is inserted or removed before them. A temporary negative slot avoids unique
    // collisions while several period numbers are shifting at once.
    for (const moved of movedPeriods) {
      await tx`
        UPDATE timetable_slots ts
        SET period_number = ${-(1000 + moved.oldSort)}
        FROM class_sections cs
        WHERE ts.class_section_id = cs.id
          AND ts.period_number = ${moved.oldSort}
          AND cs.school_id = ${schoolId}
      `;
    }

    for (const moved of movedPeriods) {
      await tx`
        UPDATE timetable_slots ts
        SET period_number = ${moved.newSort}
        FROM class_sections cs
        WHERE ts.class_section_id = cs.id
          AND ts.period_number = ${-(1000 + moved.oldSort)}
          AND cs.school_id = ${schoolId}
      `;
    }

    for (const p of normalizedPeriods) {
      if (isTempId(p.id)) {
        const [created] = await tx`
          INSERT INTO periods (school_id, name, start_time, end_time, sort_order, is_break)
          VALUES (${schoolId}, ${p.name}, ${p.start_time}, ${p.end_time}, ${p.sort_order}, ${p.is_break === true})
          RETURNING id, school_id, name, start_time, end_time, sort_order, is_break
        `;
        p.id = created.id;
      } else {
        await tx`
          UPDATE periods
          SET
            name = ${p.name},
            start_time = ${p.start_time},
            end_time = ${p.end_time},
            sort_order = ${p.sort_order},
            is_break = ${p.is_break === true}
          WHERE id = ${p.id}
            AND school_id = ${schoolId}
        `;
      }

      // Only update slots belonging to this school's class sections.
      await tx`
        UPDATE timetable_slots ts
        SET
          start_time = ${p.start_time},
          end_time = ${p.end_time}
        FROM class_sections cs
        WHERE ts.class_section_id = cs.id
          AND ts.period_number = ${p.sort_order}
          AND cs.school_id = ${schoolId}
      `;
      updatedPeriodNumbers.push(p.sort_order);
    }

    savedPeriods = await tx`
      SELECT id, school_id, name, start_time, end_time, sort_order, is_break
      FROM periods
      WHERE school_id = ${schoolId}
      ORDER BY sort_order ASC, start_time ASC
    `;
  });

  if (updatedPeriodNumbers.length > 0) {
    const uniqueUpdatedPeriodNumbers = [...new Set(updatedPeriodNumbers)];
    (async () => {
      try {
        const affected = await sql`
          SELECT DISTINCT ts.class_section_id
          FROM timetable_slots ts
          JOIN class_sections cs ON ts.class_section_id = cs.id
          WHERE ts.period_number IN ${sql(uniqueUpdatedPeriodNumbers)}
            AND cs.school_id = ${schoolId}
        `;

        if (affected.length > 0) {
          const classSectionIds = affected.map((a) => a.class_section_id);
          await notifyTimetableUpdate(classSectionIds, schoolId);
        }
      } catch (err) {}
    })();
  }

  invalidateAllTimetableCacheForSchool(schoolId);

  return sendSuccess(res, req.schoolId, {
    message: 'Periods updated successfully',
    periods: savedPeriods,
  });
}));

/**
 * DELETE /periods/:id
 * TT3: requirePermission added
 */
router.delete('/periods/:id', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

  const [period] = await sql`
    SELECT id, school_id, name, start_time, end_time, sort_order
    FROM periods
    WHERE id = ${id} AND school_id = ${schoolId}
  `;
  if (!period) {
    return res.status(404).json({ error: 'Period not found' });
  }

  await sql.begin(async (sql) => {
    // Only delete slots that belong to this school
    await sql`
      DELETE FROM timetable_slots ts
      USING class_sections cs
      WHERE ts.class_section_id = cs.id
        AND ts.period_number = ${period.sort_order}
        AND cs.school_id = ${schoolId}
    `;
    await sql`DELETE FROM periods WHERE id = ${id} AND school_id = ${req.schoolId}`;
  });

  invalidateAllTimetableCacheForSchool(schoolId);

  return sendSuccess(res, req.schoolId, { message: 'Period deleted successfully' });
}));

// Helper to notify students of timetable updates (scoped to school)
async function notifyTimetableUpdate(classSectionIds, schoolId) {
  if (!classSectionIds || classSectionIds.length === 0) return;

  const uniqueIds = [...new Set(classSectionIds)];

  const recipients = await sql`
    SELECT DISTINCT u.id
    FROM users u
    JOIN students s ON u.person_id = s.person_id
    JOIN student_enrollments se ON s.id = se.student_id
    WHERE se.class_section_id IN ${sql(uniqueIds)}
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
    WHERE se.class_section_id IN ${sql(uniqueIds)}
      AND se.status = 'active'
      AND u.account_status = 'active'
      AND s.school_id = ${schoolId}
  `;

  if (recipients.length > 0) {
    const userIds = recipients.map((r) => r.id);
    await sendNotificationToUsers(userIds, 'TIMETABLE_UPDATED', { message: 'Your class timetable has been updated.' });
  }
}

export default router;
