import express from 'express';
import sql from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { assertSchoolEmailAvailable } from '../utils/schoolEmail.js';

const router = express.Router();

// ── GET / ─────────────────────────────────────────────────────────────────────
// Returns all teachers belonging to the authenticated user's school only.
// TCH1: requireAuth + requirePermission guard
// TCH2: Scoped to req.schoolId
router.get(
  '/',
  requireAuth,
  requirePermission('teachers.view'),
  asyncHandler(async (req, res) => {
    const schoolId = req.user.schoolId;
    req.schoolId = String(schoolId);

    const teachers = await sql`
      SELECT
        t.id,
        t.employee_code,
        t.joining_date,
        t.school_id,
        p.first_name,
        p.middle_name,
        p.last_name,
        p.display_name,
        p.email,
        p.phone,
        p.gender_id
      FROM staff t
      JOIN persons p ON t.person_id = p.id
      WHERE t.school_id = ${schoolId}
        AND t.deleted_at IS NULL
    `;

    return sendSuccess(res, req.schoolId, teachers);
  })
);

// ── GET /me/classes ────────────────────────────────────────────────────────────
// Returns the classes & subjects assigned to the currently logged-in teacher.
// Sources: timetable_slots AND class_subjects (UNION) so teachers see their
// classes regardless of which table holds the assignment.
// TCH1/TCH3: requireAuth guard
// TCH3: school_id scoped on staff and class_sections joins
router.get(
  '/me/classes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.internal_id;
    const schoolId = req.schoolId;

    // 1. Get Staff record scoped to this school
    const [staff] = await sql`
      SELECT s.id
      FROM staff s
      JOIN persons p ON s.person_id = p.id
      JOIN users u ON u.person_id = p.id
      WHERE u.id = ${userId}
        AND s.school_id = ${schoolId}
        AND s.deleted_at IS NULL
    `;

    if (!staff) {
      return res.status(404).json({ error: 'Staff profile not found' });
    }

    // 2. Fetch class assignments from BOTH timetable_slots AND class_subjects
    //    so teachers see their classes regardless of which table holds the mapping.
    const assignments = await sql`
      SELECT DISTINCT ON (class_section_id, subject_id)
        class_section_id,
        class_id,
        class_name,
        section_id,
        section_name,
        subject_id,
        subject_name,
        class_section_id || '-' || subject_id AS assignment_id
      FROM (
        -- Source 1: timetable_slots
        SELECT
          ts.class_section_id,
          c.id   AS class_id,
          c.name AS class_name,
          sec.id   AS section_id,
          sec.name AS section_name,
          s.id   AS subject_id,
          s.name AS subject_name
        FROM timetable_slots ts
        JOIN class_sections csec ON ts.class_section_id = csec.id
          AND csec.school_id = ${schoolId}
        JOIN classes c ON csec.class_id = c.id
          AND c.school_id = ${schoolId}
        JOIN sections sec ON csec.section_id = sec.id
        JOIN subjects s ON ts.subject_id = s.id
          AND s.school_id = ${schoolId}
        WHERE ts.teacher_id = ${staff.id}
          AND ts.deleted_at IS NULL

        UNION

        -- Source 2: class_subjects
        SELECT
          csub.class_section_id,
          c.id   AS class_id,
          c.name AS class_name,
          sec.id   AS section_id,
          sec.name AS section_name,
          s.id   AS subject_id,
          s.name AS subject_name
        FROM class_subjects csub
        JOIN class_sections csec ON csub.class_section_id = csec.id
          AND csec.school_id = ${schoolId}
        JOIN classes c ON csec.class_id = c.id
          AND c.school_id = ${schoolId}
        JOIN sections sec ON csec.section_id = sec.id
        JOIN subjects s ON csub.subject_id = s.id
          AND s.school_id = ${schoolId}
        WHERE csub.teacher_id = ${staff.id}
          AND csub.school_id  = ${schoolId}
      ) combined
      ORDER BY class_section_id, subject_id, class_name, section_name, subject_name
    `;

    return sendSuccess(res, req.schoolId, assignments);
  })
);

// ── POST / ────────────────────────────────────────────────────────────────────
// Creates a new teacher record for the authenticated admin's school.
// TCH1/TCH4: requireAuth + requirePermission('teachers.manage')
// TCH4: person and staff records written with school_id
router.post(
  '/',
  requireAuth,
  requirePermission('teachers.manage'),
  asyncHandler(async (req, res) => {
    const schoolId = req.schoolId;
    const {
      first_name,
      middle_name,
      last_name,
      dob,
      gender_id,
      employee_code,
      joining_date,
      status_id,
      email,
      phone,
    } = req.body;

    if (!first_name || !last_name || !employee_code || !joining_date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const canonicalEmail = email
      ? await assertSchoolEmailAvailable(sql, schoolId, email)
      : null;

    const result = await sql.begin(async (sql) => {
      // 1. Create Person (scoped to school)
      const [person] = await sql`
        INSERT INTO persons (school_id, first_name, middle_name, last_name, dob, gender_id)
        VALUES (${schoolId}, ${first_name}, ${middle_name || null}, ${last_name}, ${dob || null}, ${gender_id || null})
        RETURNING id
      `;

      // 2. Create Staff record (scoped to school)
      const [teacher] = await sql`
        INSERT INTO staff (school_id, person_id, employee_code, joining_date, status_id)
        VALUES (${schoolId}, ${person.id}, ${employee_code}, ${joining_date}, ${status_id || null})
        RETURNING *
      `;

      // 3. Contacts
      if (canonicalEmail) {
        await sql`
          INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary)
          VALUES (${schoolId}, ${person.id}, 'email', ${canonicalEmail}, true)
        `;
      }
      if (phone) {
        await sql`
          INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary)
          VALUES (${req.schoolId}, ${person.id}, 'phone', ${phone}, true)
        `;
      }

      return teacher;
    });

    return sendSuccess(res, req.schoolId, {
      message: 'Teacher created successfully',
      teacher: result,
    }, 201);
  })
);

// ── PUT /:id ───────────────────────────────────────────────────────────────────
// Updates a teacher record. Ownership check ensures only this school's data.
// TCH5: Ownership-first pattern — 404 on miss, then UPDATE
router.put(
  '/:id',
  requireAuth,
  requirePermission('teachers.manage'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const schoolId = req.schoolId;
    const { employee_code, joining_date, status_id } = req.body;

    // Ownership check
    const [existing] = await sql`
      SELECT id FROM staff
      WHERE id = ${id}
        AND school_id = ${schoolId}
        AND deleted_at IS NULL
    `;
    if (!existing) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    const [updated] = await sql`
      UPDATE staff
      SET
        employee_code = COALESCE(${employee_code || null}, employee_code),
        joining_date  = COALESCE(${joining_date  || null}, joining_date),
        status_id     = COALESCE(${status_id     || null}, status_id),
        updated_at    = now()
      WHERE id = ${id}
        AND school_id = ${schoolId}
      RETURNING *
    `;

    return sendSuccess(res, req.schoolId, { message: 'Teacher updated successfully', teacher: updated });
  })
);

// ── DELETE /:id ────────────────────────────────────────────────────────────────
// Soft-deletes a teacher record. Ownership check scoped to school.
// TCH5: Ownership-first pattern — 404 on miss, then soft-delete
router.delete(
  '/:id',
  requireAuth,
  requirePermission('teachers.manage'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const schoolId = req.schoolId;

    // Ownership check
    const [existing] = await sql`
      SELECT id FROM staff
      WHERE id = ${id}
        AND school_id = ${schoolId}
        AND deleted_at IS NULL
    `;
    if (!existing) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    await sql`
      UPDATE staff
      SET deleted_at = now()
      WHERE id = ${id}
        AND school_id = ${schoolId}
    `;

    return sendSuccess(res, req.schoolId, { message: 'Teacher deleted successfully' });
  })
);

export default router;