import express from 'express';
import sql, { supabaseAdmin } from '../db.js';
import { requirePermission, requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import {
  assertSchoolEmailAvailable,
  createSchoolScopedAuthUser,
  sendSchoolEmailConflict,
  updateSchoolScopedAuthEmail
} from '../utils/schoolEmail.js';
import {
  assertPenNumberAvailable,
  isPenConflict,
  validatePenNumber,
} from '../utils/studentPen.js';
import {
  resolveStudentIdFromParam,
  resolveStudentParamWithAccess,
} from '../utils/studentPortal.js';
import { normalizeOptionalString } from '../utils/normalizeOptionalString.js';
import { hardDeleteStudent } from '../services/hardDeleteStudent.js';

const router = express.Router();

const blankToNull = (value) => {
  if (typeof value === 'string' && value.trim() === '') return null;
  return value ?? null;
};

/** Optional person name fields — rejects junk literals like "Null", "None", etc. */
const normalizeOptionalName = (value) => normalizeOptionalString(value);

const RELATIONSHIP_MAP = { Father: 1, Mother: 2, Guardian: 3 };

const PARENTS_SUBQUERY = sql`
  (
    SELECT json_agg(
      json_build_object(
        'first_name', pp.first_name,
        'last_name', pp.last_name,
        'relation', rt.name,
        'phone', (
          SELECT contact_value FROM person_contacts pc2
          WHERE pc2.person_id = pp.id AND pc2.contact_type = 'phone'
          LIMIT 1
        ),
        'occupation', par.occupation,
        'is_primary', sp.is_primary_contact,
        'is_guardian', sp.is_legal_guardian
      )
    )
    FROM student_parents sp
    JOIN parents par ON sp.parent_id = par.id
    JOIN persons pp ON par.person_id = pp.id
    LEFT JOIN relationship_types rt ON sp.relationship_id = rt.id
    WHERE sp.student_id = s.id
      AND sp.deleted_at IS NULL
      AND par.deleted_at IS NULL
  ) as parents
`;

// Relationship ids this student form owns end-to-end. Only these are reconciled
// (soft-deleted when absent from the payload); any others attached via the
// standalone /:id/parents endpoint are left untouched.
const MANAGED_RELATIONSHIP_IDS = [1, 2, 3]; // Father, Mother, Guardian

async function syncStudentParents(sql, schoolId, studentId, parents) {
  // `undefined` means "caller didn't touch parents" -> leave existing links as-is.
  // An explicit array (including []) is the full desired set and drives reconcile.
  if (parents === undefined || parents === null || !Array.isArray(parents)) return;

  const desiredRelIds = new Set();

  for (const rawParent of parents) {
    const parentFirstName = typeof rawParent.first_name === 'string'
      ? rawParent.first_name.trim()
      : rawParent.first_name;
    const parentLastName = normalizeOptionalName(rawParent.last_name);
    const parentRelation = rawParent.relation;

    // A first name and a relation are required; last name is optional (mononyms).
    if (!parentFirstName || !parentRelation) continue;

    const parentData = {
      ...rawParent,
      first_name: parentFirstName,
      last_name: parentLastName,
      relation: parentRelation,
    };

    const relId = RELATIONSHIP_MAP[parentData.relation] || 3;
    desiredRelIds.add(relId);
    const displayName = [parentData.first_name, parentData.last_name].filter(Boolean).join(' ');

    const [existingLink] = await sql`
      SELECT pa.id as parent_id, pp.id as person_id
      FROM student_parents sp
      JOIN parents pa ON sp.parent_id = pa.id
      JOIN persons pp ON pa.person_id = pp.id
      WHERE sp.student_id = ${studentId}
        AND sp.relationship_id = ${relId}
        AND sp.school_id = ${schoolId}
        AND sp.deleted_at IS NULL
        AND pa.deleted_at IS NULL
      LIMIT 1
    `;

    let personId;
    let parentId;

    if (existingLink) {
      personId = existingLink.person_id;
      parentId = existingLink.parent_id;

      await sql`
        UPDATE persons
        SET first_name = ${parentData.first_name},
            last_name = ${parentData.last_name},
            display_name = ${displayName},
            gender_id = ${parentData.relation === 'Mother' ? 2 : 1}
        WHERE id = ${personId}
          AND school_id = ${schoolId}
      `;
      await sql`
        UPDATE parents
        SET occupation = ${parentData.occupation || null}
        WHERE id = ${parentId}
          AND school_id = ${schoolId}
      `;
    } else {
      const [parentPerson] = await sql`
        INSERT INTO persons (school_id, first_name, last_name, gender_id, display_name)
        VALUES (
          ${schoolId}, ${parentData.first_name}, ${parentData.last_name},
          ${parentData.relation === 'Mother' ? 2 : 1},
          ${displayName}
        )
        RETURNING id
      `;
      personId = parentPerson.id;

      const [parentRecord] = await sql`
        INSERT INTO parents (school_id, person_id, occupation)
        VALUES (${schoolId}, ${personId}, ${parentData.occupation || null})
        RETURNING id
      `;
      parentId = parentRecord.id;

      await sql`
        INSERT INTO student_parents (school_id, student_id, parent_id, relationship_id, is_primary_contact, is_legal_guardian)
        VALUES (
          ${schoolId}, ${studentId}, ${parentId}, ${relId},
          ${parentData.is_primary || false},
          ${parentData.is_guardian || false}
        )
      `;
    }

    if (parentData.phone) {
      const [existingPhone] = await sql`
        SELECT id FROM person_contacts
        WHERE person_id = ${personId} AND contact_type = 'phone' AND is_primary = true
      `;
      if (existingPhone) {
        await sql`
          UPDATE person_contacts
          SET contact_value = ${parentData.phone}
          WHERE id = ${existingPhone.id}
            AND school_id = ${schoolId}
        `;
      } else {
        await sql`
          INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary)
          VALUES (${schoolId}, ${personId}, 'phone', ${parentData.phone}, true)
        `;
      }
    }
  }

  // Reconcile removals: any managed relation the payload no longer includes gets
  // its link soft-deleted, so clearing a parent in edit mode actually removes it.
  const relIdsToRemove = MANAGED_RELATIONSHIP_IDS.filter((r) => !desiredRelIds.has(r));
  if (relIdsToRemove.length > 0) {
    await sql`
      UPDATE student_parents
      SET deleted_at = NOW()
      WHERE student_id = ${studentId}
        AND school_id = ${schoolId}
        AND relationship_id = ANY(${relIdsToRemove})
        AND deleted_at IS NULL
    `;
  }
}

// Get all students
router.get('/', requirePermission('students.view'), async (req, res) => {
  try {
    const { search, page = 1, class_id, section_id, status_id, sort_by = 'name', sort_order = 'asc' } = req.query;
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const offset = (pageNum - 1) * limit;

    let whereClause = sql`s.deleted_at IS NULL AND s.school_id = ${req.schoolId}`;

    if (class_id) {
      whereClause = sql`${whereClause} AND c.id = ${class_id}`;
    }
    if (section_id) {
      whereClause = sql`${whereClause} AND sec.id = ${section_id}`;
    }
    if (status_id) {
      whereClause = sql`${whereClause} AND s.status_id = ${status_id}`;
    }
    if (search && String(search).trim() !== '') {
      const term = `%${String(search).trim()}%`;
      whereClause = sql`${whereClause} AND (
        p.display_name ILIKE ${term} OR
        p.first_name ILIKE ${term} OR
        p.last_name ILIKE ${term} OR
        CONCAT(p.first_name, ' ', p.last_name) ILIKE ${term} OR
        s.admission_no ILIKE ${term}
      )`;
    }

    // Dynamic sorting
    const direction = sort_order.toLowerCase() === 'desc' ? sql`DESC` : sql`ASC`;
    let orderBy;
    switch (sort_by) {
      case 'roll_number':
        orderBy = sql`se.roll_number ${direction}, p.first_name ASC`;
        break;
      case 'admission_no':
        orderBy = sql`s.admission_no ${direction}`;
        break;
      case 'name':
      default:
        orderBy = sql`p.first_name ${direction}, p.last_name ${direction}`;
    }

    const students = await sql`
      SELECT 
        s.id, s.admission_no, s.pen_number, s.apar_number, s.admission_date, s.status_id,
        p.first_name, p.middle_name, p.last_name, p.display_name, p.dob, p.gender_id,
        st.code as status,
        (SELECT contact_value FROM person_contacts pc WHERE pc.person_id = p.id AND pc.contact_type = 'email' AND pc.is_primary = true LIMIT 1) as email,
        (SELECT contact_value FROM person_contacts pc WHERE pc.person_id = p.id AND pc.contact_type = 'phone' AND pc.is_primary = true LIMIT 1) as phone,
        json_build_object(
            'id', p.id,
            'first_name', p.first_name,
            'middle_name', p.middle_name,
            'last_name', p.last_name,
            'display_name', p.display_name,
            'dob', p.dob,
            'gender_id', p.gender_id,
            'photo_url', p.photo_url
        ) as person,
        json_build_object(
            'roll_number', se.roll_number,
            'class_code', c.code,
            'class_name', c.name,
            'class_id', c.id,
            'section_name', sec.name,
            'section_id', sec.id,
            'id', se.id,
            'academic_year', ay.code,
            'academic_year_id', ay.id
        ) as current_enrollment
      FROM students s
      JOIN persons p ON s.person_id = p.id
      JOIN student_statuses st ON s.status_id = st.id
      LEFT JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active' AND se.deleted_at IS NULL
      LEFT JOIN class_sections cs ON se.class_section_id = cs.id
      LEFT JOIN classes c ON cs.class_id = c.id
      LEFT JOIN sections sec ON cs.section_id = sec.id
      LEFT JOIN academic_years ay ON se.academic_year_id = ay.id
      WHERE ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [countResult] = await sql`
      SELECT count(*)::int as total
      FROM students s
      JOIN persons p ON s.person_id = p.id
      LEFT JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active' AND se.deleted_at IS NULL
      LEFT JOIN class_sections cs ON se.class_section_id = cs.id
      LEFT JOIN classes c ON cs.class_id = c.id
      LEFT JOIN sections sec ON cs.section_id = sec.id
      LEFT JOIN academic_years ay ON se.academic_year_id = ay.id
      WHERE ${whereClause}
    `;

    sendSuccess(res, req.schoolId, {
      data: students,
      meta: {
        total: countResult.total,
        page: pageNum,
        limit,
        total_pages: Math.ceil(countResult.total / limit)
      }
    });
  } catch (error) {

    res.status(500).json({ error: 'Failed to fetch students', details: error.message });
  }
});

// Get student statuses
router.get('/statuses', requirePermission('students.view'), async (req, res) => {
  try {
    const statuses = await sql`SELECT id, code as name FROM student_statuses ORDER BY id`;
    sendSuccess(res, req.schoolId, statuses);
  } catch (error) {

    res.status(500).json({ error: 'Failed to fetch student statuses' });
  }
});

// Get current student profile
router.get('/profile/me', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get Person ID -> Student ID
    const [userRecord] = await sql`
      SELECT person_id
      FROM users
      WHERE id = ${userId}
        AND school_id = ${req.schoolId}
        AND deleted_at IS NULL
    `;
    if (!userRecord) return res.status(404).json({ error: 'User not found' });

    // S1 FIX: Add school_id filter to student lookup to prevent cross-school profile access
    const [studentRecord] = await sql`SELECT id FROM students WHERE person_id = ${userRecord.person_id} AND school_id = ${req.schoolId}`;
    if (!studentRecord) return res.status(404).json({ error: 'Student profile not found for this user' });

    const id = studentRecord.id;

    // Reuse query from GET /:id
    const student = await sql`
      SELECT 
        s.id, s.admission_no, s.apar_number, s.admission_date,
        p.first_name, p.middle_name, p.last_name, p.display_name, p.dob, p.gender_id, p.photo_url,
        st.code as status,
        -- Fetch Primary Email
        (SELECT contact_value FROM person_contacts pc WHERE pc.person_id = p.id AND pc.contact_type = 'email' AND pc.is_primary = true LIMIT 1) as email,
        -- Fetch Primary Phone
        (SELECT contact_value FROM person_contacts pc WHERE pc.person_id = p.id AND pc.contact_type = 'phone' AND pc.is_primary = true LIMIT 1) as phone,
        json_build_object(
            'id', p.id,
            'first_name', p.first_name,
            'middle_name', p.middle_name,
            'last_name', p.last_name,
            'display_name', p.display_name,
            'dob', p.dob,
            'gender_id', p.gender_id,
            'photo_url', p.photo_url
        ) as person,
        -- Current Enrollment
        (
            SELECT json_build_object(
                'id', se.id,
                'roll_number', se.roll_number,
                'class_code', c.code,
                'class_name', c.name,
                'class_id', c.id,
                'section_name', sec.name,
                'section_id', sec.id,
                'class_section_id', cs.id,
                'academic_year', ay.code,
                'academic_year_id', ay.id,
                'class_teacher', (
                    SELECT p_t.display_name 
                    FROM staff st_t
                    JOIN persons p_t ON st_t.person_id = p_t.id
                    WHERE st_t.id = cs.class_teacher_id
                )
            )
            FROM student_enrollments se
            JOIN class_sections cs ON se.class_section_id = cs.id
            JOIN classes c ON cs.class_id = c.id
            JOIN sections sec ON cs.section_id = sec.id
            JOIN academic_years ay ON se.academic_year_id = ay.id
            WHERE se.student_id = s.id AND se.status = 'active'
            LIMIT 1
        ) as current_enrollment,
        -- Parents
        (
             SELECT json_agg(
                 json_build_object(
                     'first_name', pp.first_name,
                     'last_name', pp.last_name,
                     'relation', rt.name,
                     'phone', (SELECT contact_value FROM person_contacts pc2 WHERE pc2.person_id = pp.id AND pc2.contact_type = 'phone' LIMIT 1),
                     'occupation', par.occupation
                 )
             )
             FROM student_parents sp 
             JOIN parents par ON sp.parent_id = par.id
             JOIN persons pp ON par.person_id = pp.id
             LEFT JOIN relationship_types rt ON sp.relationship_id = rt.id
             WHERE sp.student_id = s.id AND sp.deleted_at IS NULL
        ) as parents
      FROM students s
      JOIN persons p ON s.person_id = p.id
      JOIN student_statuses st ON s.status_id = st.id
      WHERE s.id = ${id} AND s.school_id = ${req.schoolId}
    `;

    if (student.length === 0) return res.status(404).json({ error: 'Student not found' });
    sendSuccess(res, req.schoolId, student[0]);

  } catch (error) {

    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Get student by ID
/**
 * GET /students/unenrolled
 * Get active students without an active enrollment. When academic_year_id is
 * supplied, scope the check to that year; otherwise this powers the accounts
 * "Pending Enrollments" page and only returns students with no active class
 * assignment at all.
 */
router.get('/unenrolled', requirePermission('students.view'), async (req, res) => {
  try {
    const { academic_year_id } = req.query;

    const unenrolledStudents = academic_year_id
      ? await sql`
            SELECT 
                s.id, s.admission_no, s.admission_date,
                p.first_name, p.middle_name, p.last_name, p.display_name,
                st.code as status
            FROM students s
            JOIN persons p ON s.person_id = p.id
            JOIN student_statuses st ON s.status_id = st.id
            WHERE s.deleted_at IS NULL
            AND s.school_id = ${req.schoolId}
            AND st.code = 'active'
            AND NOT EXISTS (
                SELECT 1 FROM student_enrollments se 
                WHERE se.student_id = s.id 
                AND se.school_id = ${req.schoolId}
                AND se.academic_year_id = ${academic_year_id}
                AND se.status = 'active'
                AND se.deleted_at IS NULL
            )
            ORDER BY p.first_name ASC
        `
      : await sql`
            SELECT
                s.id, s.admission_no, s.admission_date,
                p.first_name, p.middle_name, p.last_name, p.display_name,
                st.code as status
            FROM students s
            JOIN persons p ON s.person_id = p.id
            JOIN student_statuses st ON s.status_id = st.id
            WHERE s.deleted_at IS NULL
            AND s.school_id = ${req.schoolId}
            AND st.code = 'active'
            AND NOT EXISTS (
                SELECT 1 FROM student_enrollments se
                WHERE se.student_id = s.id
                AND se.school_id = ${req.schoolId}
                AND se.status = 'active'
                AND se.deleted_at IS NULL
            )
            ORDER BY p.first_name ASC
        `;

    sendSuccess(res, req.schoolId, unenrolledStudents);
  } catch (error) {

    res.status(500).json({ error: 'Failed to fetch unenrolled students' });
  }
});
router.get('/:id', requirePermission('students.view'), async (req, res) => {
  try {
    const { id } = req.params;
    const student = await sql`
      SELECT 
        s.id, s.admission_no, s.pen_number, s.apar_number,
        s.status_id, s.category_id, s.religion_id, s.blood_group_id,
        to_char(s.admission_date, 'YYYY-MM-DD') as admission_date,
        p.first_name, p.middle_name, p.last_name, p.display_name,
        to_char(p.dob, 'YYYY-MM-DD') as dob,
        p.gender_id,
        st.code as status,
        -- Fetch Primary Email
        (SELECT contact_value FROM person_contacts pc WHERE pc.person_id = p.id AND pc.contact_type = 'email' AND pc.is_primary = true LIMIT 1) as email,
        -- Fetch Primary Phone
        (SELECT contact_value FROM person_contacts pc WHERE pc.person_id = p.id AND pc.contact_type = 'phone' AND pc.is_primary = true LIMIT 1) as phone,
        -- Current Enrollment
        (SELECT json_build_object(
                'id', se.id,
                'roll_number', se.roll_number,
                'class_code', c.code,
                'class_name', c.name,
                'class_id', c.id,
                'section_name', sec.name,
                'section_id', sec.id,
                'class_section_id', cs.id,
                'academic_year', ay.code,
                'academic_year_id', ay.id
            )
            FROM student_enrollments se
            JOIN class_sections cs ON se.class_section_id = cs.id
            JOIN classes c ON cs.class_id = c.id
            JOIN sections sec ON cs.section_id = sec.id
            JOIN academic_years ay ON se.academic_year_id = ay.id
            WHERE se.student_id = s.id AND se.status = 'active'
            LIMIT 1
        ) as current_enrollment,
        ${PARENTS_SUBQUERY}
      FROM students s
      JOIN persons p ON s.person_id = p.id
      JOIN student_statuses st ON s.status_id = st.id
      WHERE s.id = ${id} AND s.school_id = ${req.schoolId}
    `;

    if (student.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    sendSuccess(res, req.schoolId, student[0]);
  } catch (error) {
    console.error('[GET /students/:id] Error:', error?.message || error);
    res.status(500).json({ error: 'Failed to fetch student' });
  }
});

// Insert new Student with optional User and Enrollment
router.post('/', requirePermission('students.create'), async (req, res) => {
  let recalcParams = null;

  try {
    const {
      first_name, middle_name = null, last_name, dob = null, gender_id,
      admission_no, pen_number = null, apar_number = null, admission_date, status_id, category_id = null, religion_id = null, blood_group_id = null,
      email = null, phone = null,
      password = null, role_code = null, // For User Creation
      class_id = null, section_id = null, academic_year_id = null, // For Initial Enrollment
      parents // Array of { first_name, last_name, relation, phone, occupation, is_primary }
    } = req.body;

    // RecalcParams already declared above

    // Basic Validation
    if (!first_name || !admission_no || !admission_date || !status_id || !gender_id || !class_id || !section_id) {
      return res.status(400).json({ error: 'Missing required fields: First Name, Admission No, Status, Gender, Class, and Section are mandatory.' });
    }

    const normalizedMiddleName = normalizeOptionalName(middle_name);
    const normalizedLastName = normalizeOptionalName(last_name);
    const normalizedDob = blankToNull(dob);

    const schoolId = req.user.schoolId;
    req.schoolId = String(schoolId);

    // Check for duplicate Admission Number
    const [existingAdm] = await sql`SELECT id FROM students WHERE admission_no = ${admission_no} AND school_id = ${req.schoolId} AND deleted_at IS NULL`;
    if (existingAdm) {
      return res.status(400).json({ error: `Admission Number '${admission_no}' already exists.` });
    }

    const penValidation = validatePenNumber(pen_number);
    if (!penValidation.ok) {
      return res.status(400).json({ error: penValidation.error });
    }
    const normalizedPenNumber = await assertPenNumberAvailable(sql, schoolId, pen_number);

    const canonicalEmail = email
      ? await assertSchoolEmailAvailable(sql, schoolId, email)
      : null;

    const result = await sql.begin(async (sql) => {
      // 1. Create Person
      const [person] = await sql`
        INSERT INTO persons (school_id, first_name, middle_name, last_name, dob, gender_id)
        VALUES (
            ${req.schoolId}, ${first_name}, ${normalizedMiddleName}, ${normalizedLastName}, ${normalizedDob}, ${gender_id}
        )
        RETURNING id
      `;

      // 2. Create Student
      const [student] = await sql`
        INSERT INTO students (
          school_id, person_id, admission_no, pen_number, apar_number, admission_date, status_id, 
          category_id, religion_id, blood_group_id
        )
        VALUES (
          ${req.schoolId}, ${person.id}, ${admission_no}, ${normalizedPenNumber}, ${apar_number ?? null}, ${admission_date}, ${status_id},
          ${category_id}, ${religion_id}, ${blood_group_id}
        )
        RETURNING id, person_id, admission_no, pen_number, apar_number, admission_date, status_id, category_id, religion_id, blood_group_id, school_id, created_at, updated_at
      `;

      // 3. Contacts
      if (canonicalEmail) {
        await sql`INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary) VALUES (${schoolId}, ${person.id}, 'email', ${canonicalEmail}, true)`;
      }
      if (phone) {
        await sql`INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary) VALUES (${req.schoolId}, ${person.id}, 'phone', ${phone}, true)`;
      }

      // 4. Create User Login (Optional)
      if (password && canonicalEmail) {
        let authUserId;

        // Try Create Supabase User
        const { data: authUser } = await createSchoolScopedAuthUser(supabaseAdmin, {
          schoolId,
          email: canonicalEmail,
          password,
          userMetadata: {
            first_name, last_name: normalizedLastName, person_id: person.id
          }
        });

        authUserId = authUser.user.id;

        // Create Local User
        // Check if local user already exists (consistency check)
        const [existingLocalUser] = await sql`SELECT id FROM users WHERE id = ${authUserId}`;
        if (!existingLocalUser) {
           const [user] = await sql`
              INSERT INTO users (id, school_id, person_id, account_status)
              VALUES (${authUserId}, ${req.schoolId}, ${person.id}, 'active')
              RETURNING id
            `;
          // Assign Role
          const roleCode = role_code || 'student';
          const [role] = await sql`SELECT id FROM roles WHERE code = ${roleCode} AND school_id = ${req.schoolId}`;

          if (role) {
            await sql`INSERT INTO user_roles (user_id, role_id, school_id) VALUES (${user.id}, ${role.id}, ${req.schoolId})`;
          }
        }
      }

      // 5. Auto-Enrollment (Mandatory but Fail-Safe)
      let targetAcademicYearId = academic_year_id;
      let enrollmentStatus = 'active';

      // 5a. Resolve Academic Year if not provided
      if (!targetAcademicYearId) {
        const [ay] = await sql`SELECT id FROM academic_years WHERE now() BETWEEN start_date AND end_date AND school_id = ${req.schoolId} LIMIT 1`;
        if (ay) targetAcademicYearId = ay.id;
      }

      if (!targetAcademicYearId) {
        throw new Error('Active Academic Year not found. Please create or select an academic year before adding students.');
      }

      // 5b. Resolve Class Section
      let targetClassSectionId = null;
      let nextRoll = null;

      if (enrollmentStatus === 'active') {
        const [cs] = await sql`
          INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
          VALUES (${req.schoolId}, ${class_id}, ${section_id}, ${targetAcademicYearId})
          ON CONFLICT (school_id, class_id, section_id, academic_year_id)
          DO UPDATE SET deleted_at = NULL
          RETURNING id
        `;

        targetClassSectionId = cs.id;

        // 5c. Insert Enrollment with Roll Number
        // Calculate Next Roll Number
        const [rollData] = await sql`
          SELECT COALESCE(MAX(roll_number), 0) + 1 as next_roll
          FROM student_enrollments
          WHERE class_section_id = ${targetClassSectionId} AND school_id = ${req.schoolId}
          AND academic_year_id = ${targetAcademicYearId}
          AND deleted_at IS NULL
        `;
        nextRoll = rollData ? rollData.next_roll : 1;
      }

      // Insert Enrollment Record (Even if pending/failed)
      // Note: We need academic_year_id for potential future reconciliation, even if pending.
      // If we couldn't resolve AY, we might have to skip AY or insert NULL if schema allows, but schema has NOT NULL constraint on AY.
      // If AY is missing, we must fail or find a fallback. The logic above tries to find current AY.

      await sql`
        INSERT INTO student_enrollments (school_id, student_id, class_section_id, academic_year_id, status, start_date, roll_number)
        VALUES (${req.schoolId}, ${student.id}, ${targetClassSectionId}, ${targetAcademicYearId}, ${enrollmentStatus}, ${admission_date}, ${nextRoll})
      `;

      // 6. Create Parents
      await syncStudentParents(sql, req.schoolId, student.id, parents);

      return student;
    });

    if (recalcParams) {
      // Run Recalculation on committed data
      try {
        await sql`SELECT recalculate_section_rolls(${recalcParams.classSectionId}, ${recalcParams.academicYearId})`;
      } catch (e) {

      }
    }

    sendSuccess(res, req.schoolId, {
      message: 'Student created successfully',
      student: result
    }, 201);
  } catch (error) {
    console.error('[POST /students] Error:', error.message, error.stack);
    if (sendSchoolEmailConflict(res, error)) return;
    if (error.code === 'PEN_VALIDATION' || error.code === 'PEN_CONFLICT') {
      return res.status(400).json({ error: error.message });
    }
    if (isPenConflict(error)) {
      return res.status(400).json({ error: 'PEN Number already exists.' });
    }
    res.status(500).json({ error: 'Failed to create student', details: error.message });
  }
});

/**
 * POST /students/recalculate-rolls
 * Manually trigger roll number recalculation
 */
router.post('/recalculate-rolls', requirePermission('students.create'), async (req, res) => {
  try {
    const { class_id, section_id, academic_year_id } = req.body;

    const [classSection] = await sql`
            SELECT id FROM class_sections 
            WHERE class_id = ${class_id} AND section_id = ${section_id} AND school_id = ${req.schoolId}
        `;

    if (!classSection) return res.status(404).json({ error: 'Class section not found' });

    await sql`SELECT recalculate_section_rolls(${classSection.id}, ${academic_year_id})`;

    sendSuccess(res, req.schoolId, { message: 'Roll numbers recalculated successfully' });
  } catch (error) {

    res.status(500).json({ error: 'Failed to recalculate rolls' });
  }
});

// Update student
router.put('/:id', requirePermission('students.edit'), async (req, res) => {
  try {
    req.schoolId = String(req.user.schoolId);
    const { id } = req.params;
    const {
      first_name, middle_name, last_name, dob, gender_id,
      admission_no, pen_number, apar_number, admission_date, status_id, category_id, religion_id, blood_group_id,
      email, phone, password, role_code = null,
      class_id = null, section_id = null, academic_year_id = null,
      parents
    } = req.body;

    if ((class_id && !section_id) || (!class_id && section_id)) {
      return res.status(400).json({ error: 'Both class and section are required to change enrollment.' });
    }

    const normalizedMiddleName = normalizeOptionalName(middle_name);
    const normalizedLastName = last_name !== undefined ? normalizeOptionalName(last_name) : undefined;
    const normalizedDob = blankToNull(dob);

    // Ownership check must short-circuit as 404, not throw into catch/500.
    const [student] = await sql`
      SELECT 
        s.id, s.person_id,
        u.id as user_id,
        (SELECT contact_value FROM person_contacts pc 
         WHERE pc.person_id = s.person_id AND pc.contact_type = 'email' AND pc.is_primary = true LIMIT 1) as current_email,
        (SELECT contact_value FROM person_contacts pc 
         WHERE pc.person_id = s.person_id AND pc.contact_type = 'phone' AND pc.is_primary = true LIMIT 1) as current_phone
      FROM students s
      LEFT JOIN users u ON u.person_id = s.person_id
      WHERE s.id = ${id}
        AND s.school_id = ${req.schoolId}
        AND s.deleted_at IS NULL
    `;
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const personId = student.person_id;
    let authUserId = student.user_id;
    const canonicalEmail = email
      ? await assertSchoolEmailAvailable(sql, req.user.schoolId, email, personId)
      : null;

    let normalizedPenNumber;
    let shouldUpdatePen = false;
    if (pen_number !== undefined && String(pen_number).trim() !== '') {
      const penValidation = validatePenNumber(pen_number);
      if (!penValidation.ok) {
        return res.status(400).json({ error: penValidation.error });
      }
      normalizedPenNumber = await assertPenNumberAvailable(sql, req.user.schoolId, pen_number, {
        excludeStudentId: id,
      });
      shouldUpdatePen = true;
    }

    const enrollmentRecalcTargets = [];

    const result = await sql.begin(async (sql) => {

      // 2. Update Person
      await sql`
        UPDATE persons
        SET 
          first_name = COALESCE(${first_name ?? null}, first_name),
          middle_name = COALESCE(${normalizedMiddleName}, middle_name),
          ${normalizedLastName !== undefined ? sql`last_name = ${normalizedLastName},` : sql``}
          dob = COALESCE(${normalizedDob}, dob),
          gender_id = COALESCE(${gender_id ?? null}, gender_id)
        WHERE id = ${personId}
          AND school_id = ${req.schoolId}
      `;

      // 3. Update Student
      // Check for duplicate Admission Number (if changing)
      if (admission_no) {
        const [existingAdm] = await sql`
          SELECT id FROM students 
          WHERE admission_no = ${admission_no} 
          AND school_id = ${req.schoolId}
          AND id != ${id} 
          AND deleted_at IS NULL
        `;
        if (existingAdm) {
          throw new Error(`Admission Number '${admission_no}' already exists.`);
        }
      }

      const penAssignment = shouldUpdatePen
        ? sql`pen_number = ${normalizedPenNumber},`
        : sql``;

      const [updatedStudent] = await sql`
        UPDATE students
        SET 
          admission_no = COALESCE(${admission_no ?? null}, admission_no),
          ${penAssignment}
          apar_number = COALESCE(${apar_number ?? null}, apar_number),
          admission_date = COALESCE(${admission_date ?? null}, admission_date),
          status_id = COALESCE(${status_id ?? null}, status_id),
          category_id = COALESCE(${category_id ?? null}, category_id),
          religion_id = COALESCE(${religion_id ?? null}, religion_id),
          blood_group_id = COALESCE(${blood_group_id ?? null}, blood_group_id)
        WHERE id = ${id}
          AND school_id = ${req.schoolId}
        RETURNING *
      `;

      if (!updatedStudent) {
        throw Object.assign(new Error('Student not found or update failed.'), { code: 'STUDENT_UPDATE_FAILED' });
      }

      // 3b. Update active enrollment when class/section changes
      if (class_id && section_id) {
        let targetAcademicYearId = academic_year_id;
        if (!targetAcademicYearId) {
          const [ay] = await sql`
            SELECT id FROM academic_years
            WHERE now() BETWEEN start_date AND end_date
              AND school_id = ${req.schoolId}
            LIMIT 1
          `;
          if (ay) targetAcademicYearId = ay.id;
        }
        if (!targetAcademicYearId) {
          throw new Error('Active Academic Year not found. Please select an academic year.');
        }

        const [targetCs] = await sql`
          INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
          VALUES (${req.schoolId}, ${class_id}, ${section_id}, ${targetAcademicYearId})
          ON CONFLICT (school_id, class_id, section_id, academic_year_id)
          DO UPDATE SET deleted_at = NULL
          RETURNING id
        `;

        const [currentEnrollment] = await sql`
          SELECT se.id, se.class_section_id, se.academic_year_id, se.roll_number
          FROM student_enrollments se
          WHERE se.student_id = ${id}
            AND se.school_id = ${req.schoolId}
            AND se.academic_year_id = ${targetAcademicYearId}
            AND se.status = 'active'
            AND se.deleted_at IS NULL
        `;

        if (currentEnrollment?.class_section_id === targetCs.id) {
          // Already enrolled in this class-section for the academic year — no-op
        } else {
          const oldClassSectionId = currentEnrollment?.class_section_id ?? null;
          const oldAcademicYearId = currentEnrollment?.academic_year_id ?? targetAcademicYearId;

          const [rollData] = await sql`
            SELECT COALESCE(MAX(roll_number), 0) + 1 AS next_roll
            FROM student_enrollments
            WHERE class_section_id = ${targetCs.id}
              AND school_id = ${req.schoolId}
              AND academic_year_id = ${targetAcademicYearId}
              AND deleted_at IS NULL
          `;
          const nextRoll = rollData?.next_roll ?? 1;

          if (currentEnrollment) {
            const [updatedEnrollment] = await sql`
              UPDATE student_enrollments
              SET class_section_id = ${targetCs.id},
                  roll_number = ${nextRoll}
              WHERE id = ${currentEnrollment.id}
                AND student_id = ${id}
                AND school_id = ${req.schoolId}
                AND academic_year_id = ${targetAcademicYearId}
              RETURNING id
            `;
            if (!updatedEnrollment) {
              throw Object.assign(
                new Error('Failed to update student enrollment for the selected class and section.'),
                { code: 'ENROLLMENT_UPDATE_FAILED' }
              );
            }
          } else {
            const enrollmentStartDate = admission_date ?? updatedStudent.admission_date;
            const [newEnrollment] = await sql`
              INSERT INTO student_enrollments (
                school_id, student_id, class_section_id, academic_year_id, status, start_date, roll_number
              )
              VALUES (
                ${req.schoolId}, ${id}, ${targetCs.id}, ${targetAcademicYearId},
                'active', ${enrollmentStartDate}, ${nextRoll}
              )
              RETURNING id
            `;
            if (!newEnrollment) {
              throw Object.assign(
                new Error('Failed to create student enrollment for the selected class and section.'),
                { code: 'ENROLLMENT_CREATE_FAILED' }
              );
            }
          }

          if (oldClassSectionId && oldClassSectionId !== targetCs.id) {
            enrollmentRecalcTargets.push({
              classSectionId: oldClassSectionId,
              academicYearId: oldAcademicYearId,
            });
          }
        }
      }

      // 4. Update Contacts 
      // Handle Email: If exists as primary, update. Else insert.
      if (canonicalEmail) {
        const [existingEmail] = await sql`
           SELECT id FROM person_contacts 
           WHERE person_id = ${personId} AND contact_type = 'email' AND is_primary = true
        `;
        if (existingEmail) {
          await sql`UPDATE person_contacts SET contact_value = ${canonicalEmail} WHERE id = ${existingEmail.id}
      AND school_id = ${req.schoolId}`;
        } else {
          await sql`INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary) VALUES (${req.schoolId}, ${personId}, 'email', ${canonicalEmail}, true)`;
        }
      }

      // Handle Phone
      if (phone) {
        const [existingPhone] = await sql`
           SELECT id FROM person_contacts 
           WHERE person_id = ${personId} AND contact_type = 'phone' AND is_primary = true
        `;
        if (existingPhone) {
          await sql`UPDATE person_contacts SET contact_value = ${phone} WHERE id = ${existingPhone.id}
      AND school_id = ${req.schoolId}`;
        } else {
          await sql`INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary) VALUES (${req.schoolId}, ${personId}, 'phone', ${phone}, true)`;
        }
      }

      await syncStudentParents(sql, req.schoolId, id, parents);

      return updatedStudent;
    });

    for (const target of enrollmentRecalcTargets) {
      try {
        await sql`SELECT recalculate_section_rolls(${target.classSectionId}, ${target.academicYearId})`;
      } catch (recalcErr) {
        console.error('[PUT /students/:id] Roll recalculation failed:', recalcErr.message);
      }
    }

    // 5. Update Auth Credentials (Supabase auth.users via Admin API)
    let authUpdateResult = null;
    const emailForAuth = canonicalEmail || student.current_email;

    if (!authUserId && supabaseAdmin && password && password.length >= 6 && emailForAuth) {
      try {
        const roleCode = role_code || 'student';
        const { data: authUser } = await createSchoolScopedAuthUser(supabaseAdmin, {
          schoolId: req.user.schoolId,
          email: emailForAuth,
          password,
          userMetadata: { person_id: personId }
        });
        authUserId = authUser.user.id;

        const [existingLocalUser] = await sql`SELECT id FROM users WHERE id = ${authUserId}`;
        if (!existingLocalUser) {
          const [user] = await sql`
            INSERT INTO users (id, school_id, person_id, account_status)
            VALUES (${authUserId}, ${req.schoolId}, ${personId}, 'active')
            RETURNING id
          `;
          const [role] = await sql`SELECT id FROM roles WHERE code = ${roleCode} AND school_id = ${req.schoolId}`;
          if (role) {
            await sql`
              INSERT INTO user_roles (user_id, role_id, school_id, granted_by)
              VALUES (${user.id}, ${role.id}, ${req.schoolId}, ${req.user.internal_id})
              ON CONFLICT (user_id, role_id) DO NOTHING
            `;
          }
        }
        authUpdateResult = { created: true, updated: ['password', 'email'] };
      } catch (authCreateErr) {
        if (sendSchoolEmailConflict(res, authCreateErr)) return;
        return res.status(207).json({
          success: true,
          message: 'Profile updated but login account could not be created',
          student: result,
          authError: authCreateErr.message || 'Failed to create login account'
        });
      }
    } else if (authUserId && supabaseAdmin) {
      const authUpdates = {};
      const updatedAuthFields = [];

      if (canonicalEmail && canonicalEmail !== student.current_email) {
        await updateSchoolScopedAuthEmail(supabaseAdmin, authUserId, {
          schoolId: req.user.schoolId,
          email: canonicalEmail
        });
        updatedAuthFields.push('email');
      }
      if (phone && phone !== student.current_phone) {
        authUpdates.phone = phone;
      }
      if (password && password.length >= 6) {
        authUpdates.password = password;
      }

      if (Object.keys(authUpdates).length > 0) {
        const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(
          authUserId,
          authUpdates
        );

        if (authError) {
          return res.status(207).json({
            success: true,
            message: 'Profile updated but login credentials failed to update',
            student: result,
            authError: authError.message
          });
        }
        updatedAuthFields.push(...Object.keys(authUpdates));
      }

      if (updatedAuthFields.length > 0) {
        authUpdateResult = { updated: updatedAuthFields };
      }
    } else if (password && password.length >= 6 && !emailForAuth) {
      return res.status(400).json({ error: 'Email is required to set or reset a student password.' });
    }

    sendSuccess(res, req.schoolId, {
      message: 'Student updated successfully',
      student: result,
      ...(authUpdateResult && { authUpdate: authUpdateResult })
    });
  } catch (error) {
    console.error('[PUT /students/:id] Error:', error.message, error.code, error.detail);

    if (sendSchoolEmailConflict(res, error)) return;
    if (error.code === 'PEN_VALIDATION' || error.code === 'PEN_CONFLICT') {
      return res.status(400).json({ error: error.message });
    }
    if (isPenConflict(error)) {
      return res.status(400).json({ error: 'PEN Number already exists.' });
    }
    if (error.code === 'STUDENT_UPDATE_FAILED' || error.code === 'ENROLLMENT_UPDATE_FAILED' || error.code === 'ENROLLMENT_CREATE_FAILED') {
      return res.status(404).json({ error: error.message });
    }
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Roll number conflict in the target class-section. Please retry the update.',
      });
    }
    if (error.code === '42703' && String(error.message).includes('pen_number')) {
      return res.status(400).json({
        error: 'PEN Number is not enabled for this school database yet. Leave PEN blank and try again.',
      });
    }
    res.status(500).json({ error: 'Failed to update student', details: error.message });
  }
});

// Delete student
router.delete('/:id', requirePermission('students.delete'), async (req, res) => {
  try {
    const { id } = req.params;

    // Soft delete
    const result = await sql`
      UPDATE students 
      SET deleted_at = NOW() 
      WHERE id = ${id} AND school_id = ${req.schoolId}
      RETURNING id
    `;

    if (result.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    sendSuccess(res, req.schoolId, { message: 'Student deleted successfully' });
  } catch (error) {

    res.status(500).json({ error: 'Failed to delete student', details: error.message });
  }
});

/**
 * POST /students/:id/hard-delete
 * PERMANENT, irreversible wipe of a student and ALL data belonging to them
 * (fees, receipts, marks, attendance, transport, parent links, login accounts…).
 * Requires an explicit `{ confirm: true }` body so it can never fire by accident,
 * and is gated by the same `students.delete` permission as soft delete.
 */
router.post('/:id/hard-delete', requirePermission('students.delete'), async (req, res) => {
  try {
    const { id } = req.params;

    if (req.body?.confirm !== true) {
      return res.status(400).json({
        error: 'Hard delete must be explicitly confirmed',
        details: 'Send { "confirm": true } to permanently delete this student.',
      });
    }

    // Ownership check — include already soft-deleted rows so a soft-deleted
    // student can still be fully purged. 404 keeps other tenants' ids opaque.
    const [student] = await sql`
      SELECT id FROM students WHERE id = ${id} AND school_id = ${req.schoolId}
    `;
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const result = await hardDeleteStudent(req.schoolId, id);

    if (!result.deleted) {
      return res.status(404).json({ error: 'Student not found' });
    }

    sendSuccess(res, req.schoolId, {
      message: 'Student and all associated data permanently deleted',
      stats: result.stats,
      authFailures: result.authFailures,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to permanently delete student', details: error.message });
  }
});

// ============== SUB-ROUTES ==============

/**
 * POST /students/:id/enrollments
 * Manually enroll a student
 */
router.post('/:id/enrollments', requirePermission('students.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { class_id, section_id, academic_year_id } = req.body;

    if (!class_id || !section_id) {
      return res.status(400).json({ error: 'Class and Section are required' });
    }

    // Verify Ownership
    const [studentCheck] = await sql`SELECT id FROM students WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL`;
    if (!studentCheck) return res.status(404).json({ error: 'Student not found' });

    let targetAcademicYearId = academic_year_id;
    if (!targetAcademicYearId) {
      const [ay] = await sql`SELECT id FROM academic_years WHERE now() BETWEEN start_date AND end_date AND school_id = ${req.schoolId} LIMIT 1`;
      if (ay) targetAcademicYearId = ay.id;
    }

    if (!targetAcademicYearId) return res.status(400).json({ error: 'Active Academic Year not found' });

    const [cs] = await sql`
      INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
      VALUES (${req.schoolId}, ${class_id}, ${section_id}, ${targetAcademicYearId})
      ON CONFLICT (school_id, class_id, section_id, academic_year_id)
      DO UPDATE SET deleted_at = NULL
      RETURNING id
    `;

    // Check if already enrolled
    const [existing] = await sql`
            SELECT id FROM student_enrollments 
            WHERE student_id = ${id} 
            AND academic_year_id = ${targetAcademicYearId} 
            AND status = 'active'
            AND deleted_at IS NULL
        `;

    if (existing) return res.status(400).json({ error: 'Student is already enrolled in this Academic Year' });

    // Calculate Roll Number
    const [rollData] = await sql`
            SELECT COALESCE(MAX(roll_number), 0) + 1 as next_roll 
            FROM student_enrollments 
            WHERE class_section_id = ${cs.id} AND school_id = ${req.schoolId} 
            AND academic_year_id = ${targetAcademicYearId}
            AND deleted_at IS NULL
        `;

    const nextRoll = rollData ? rollData.next_roll : 1;

    // Create Enrollment
    const [enrollment] = await sql`
            INSERT INTO student_enrollments (
                school_id, student_id, class_section_id, academic_year_id, 
                status, start_date, roll_number
            )
            VALUES (
                ${req.schoolId}, ${id}, ${cs.id}, ${targetAcademicYearId}, 
                'active', NOW(), ${nextRoll}
            )
            RETURNING *
        `;

    sendSuccess(res, req.schoolId, { message: 'Enrollment created', enrollment }, 201);

  } catch (error) {
    console.error('[POST /:id/enrollments] Error:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to create enrollment', details: error.message });
  }
});

/**
 * GET /students/:id/enrollments
 * Get enrollment history for a student
 */
router.get('/:id/enrollments', requirePermission('students.view'), async (req, res) => {
  try {
    const { id } = req.params;
    let targetStudentId = (await resolveStudentIdFromParam(req, id)) ?? id;

    // S3 FIX: Student ownership check before returning enrollment data
    const [studentCheck] = await sql`SELECT id FROM students WHERE id = ${targetStudentId} AND school_id = ${req.schoolId} AND deleted_at IS NULL`;
    if (!studentCheck) return res.status(404).json({ error: 'Student not found' });

    const { page, limit } = req.query;
    const usePaging = page !== undefined || limit !== undefined;
    const lim = Math.min(parseInt(limit, 10) || 20, 100);
    const pg = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (pg - 1) * lim;

    const enrollments = usePaging
      ? await sql`
      SELECT
        se.id, se.status, se.start_date, se.end_date, se.created_at,
        c.name as class_name, c.code as class_code, c.id as class_id, c.sort_order as class_sort_order,
        s.name as section_name, s.id as section_id,
        ay.code as academic_year, ay.id as academic_year_id,
        ay.start_date as academic_year_start_date, ay.end_date as academic_year_end_date
      FROM student_enrollments se
      JOIN class_sections cs ON se.class_section_id = cs.id
      JOIN classes c ON cs.class_id = c.id
      JOIN sections s ON cs.section_id = s.id
      JOIN academic_years ay ON se.academic_year_id = ay.id
      WHERE se.student_id = ${targetStudentId}
        AND se.school_id = ${req.schoolId}
        AND se.deleted_at IS NULL
      ORDER BY ay.start_date ASC, c.sort_order ASC, se.start_date ASC, se.created_at ASC
      LIMIT ${lim} OFFSET ${offset}
    `
      : await sql`
      SELECT
        se.id, se.status, se.start_date, se.end_date, se.created_at,
        c.name as class_name, c.code as class_code, c.id as class_id, c.sort_order as class_sort_order,
        s.name as section_name, s.id as section_id,
        ay.code as academic_year, ay.id as academic_year_id,
        ay.start_date as academic_year_start_date, ay.end_date as academic_year_end_date
      FROM student_enrollments se
      JOIN class_sections cs ON se.class_section_id = cs.id
      JOIN classes c ON cs.class_id = c.id
      JOIN sections s ON cs.section_id = s.id
      JOIN academic_years ay ON se.academic_year_id = ay.id
      WHERE se.student_id = ${targetStudentId}
        AND se.school_id = ${req.schoolId}
        AND se.deleted_at IS NULL
      ORDER BY ay.start_date ASC, c.sort_order ASC, se.start_date ASC, se.created_at ASC
    `;

    if (usePaging) {
      const [countResult] = await sql`
        SELECT count(*)::int as total
        FROM student_enrollments se
        WHERE se.student_id = ${targetStudentId}
          AND se.school_id = ${req.schoolId}
          AND se.deleted_at IS NULL
      `;
      return sendSuccess(res, req.schoolId, {
        records: enrollments,
        meta: {
          total: countResult.total,
          page: pg,
          limit: lim,
          total_pages: Math.ceil(countResult.total / lim) || 1,
        },
      });
    }

    sendSuccess(res, req.schoolId, enrollments);
  } catch (error) {

    res.status(500).json({ error: 'Failed to fetch enrollments' });
  }
});

/**
 * GET /students/:id/attendance
 * Get attendance records for a student
 */
router.get('/:id/attendance', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const targetStudentId = await resolveStudentParamWithAccess(req, res, id);
    if (!targetStudentId) return;

    const { from_date, to_date, limit = 30, page } = req.query;
    const usePaging = page !== undefined;
    const lim = Math.min(parseInt(limit, 10) || 30, 200);
    const pg = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (pg - 1) * lim;

    let attendance;
    if (from_date && to_date) {
      attendance = usePaging
        ? await sql`
        SELECT 
          da.attendance_date, da.status, da.marked_at,
          c.name as class_name, s.name as section_name
        FROM daily_attendance da
        JOIN student_enrollments se ON da.student_enrollment_id = se.id
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections s ON cs.section_id = s.id
        WHERE se.student_id = ${targetStudentId}
          AND se.school_id = ${req.schoolId}
          AND da.attendance_date BETWEEN ${from_date} AND ${to_date}
          AND da.deleted_at IS NULL
        ORDER BY da.attendance_date DESC
        LIMIT ${lim} OFFSET ${offset}
      `
        : await sql`
        SELECT 
          da.attendance_date, da.status, da.marked_at,
          c.name as class_name, s.name as section_name
        FROM daily_attendance da
        JOIN student_enrollments se ON da.student_enrollment_id = se.id
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections s ON cs.section_id = s.id
        WHERE se.student_id = ${targetStudentId}
          AND se.school_id = ${req.schoolId}
          AND da.attendance_date BETWEEN ${from_date} AND ${to_date}
          AND da.deleted_at IS NULL
        ORDER BY da.attendance_date DESC
      `;
    } else {
      attendance = usePaging
        ? await sql`
        SELECT 
          da.attendance_date, da.status, da.marked_at,
          c.name as class_name, s.name as section_name
        FROM daily_attendance da
        JOIN student_enrollments se ON da.student_enrollment_id = se.id
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections s ON cs.section_id = s.id
        WHERE se.student_id = ${targetStudentId}
          AND se.school_id = ${req.schoolId}
          AND da.deleted_at IS NULL
        ORDER BY da.attendance_date DESC
        LIMIT ${lim} OFFSET ${offset}
      `
        : await sql`
        SELECT 
          da.attendance_date, da.status, da.marked_at,
          c.name as class_name, s.name as section_name
        FROM daily_attendance da
        JOIN student_enrollments se ON da.student_enrollment_id = se.id
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections s ON cs.section_id = s.id
        WHERE se.student_id = ${targetStudentId}
          AND se.school_id = ${req.schoolId}
          AND da.deleted_at IS NULL
        ORDER BY da.attendance_date DESC
        LIMIT ${lim}
      `;
    }

    // Calculate summary
    const summary = await sql`
      SELECT 
        COUNT(*) FILTER (WHERE da.status = 'present')::int as present,
        COUNT(*) FILTER (WHERE da.status = 'absent')::int as absent,
        COUNT(*) FILTER (WHERE da.status = 'late')::int as late,
        COUNT(*) FILTER (WHERE da.status = 'half_day')::int as half_day,
        (
          COUNT(*) FILTER (WHERE da.status IN ('present', 'late'))
          + 0.5 * COUNT(*) FILTER (WHERE da.status = 'half_day')
        )::float as effective_present,
        (
          COUNT(*) FILTER (WHERE da.status = 'absent')
          + 0.5 * COUNT(*) FILTER (WHERE da.status = 'half_day')
        )::float as effective_absent,
        ROUND(
          (
            COUNT(*) FILTER (WHERE da.status IN ('present', 'late'))
            + 0.5 * COUNT(*) FILTER (WHERE da.status = 'half_day')
          )::numeric / NULLIF(COUNT(*), 0) * 100,
          1
        )::float as attendance_percentage,
        COUNT(*)::int as total
      FROM daily_attendance da
      JOIN student_enrollments se ON da.student_enrollment_id = se.id
      WHERE se.student_id = ${targetStudentId}
        AND se.school_id = ${req.schoolId}
        AND da.deleted_at IS NULL
    `;

    if (usePaging) {
      let countQuery;
      if (from_date && to_date) {
        countQuery = sql`
          SELECT count(*)::int as total
          FROM daily_attendance da
          JOIN student_enrollments se ON da.student_enrollment_id = se.id
          WHERE se.student_id = ${targetStudentId}
            AND se.school_id = ${req.schoolId}
            AND da.attendance_date BETWEEN ${from_date} AND ${to_date}
            AND da.deleted_at IS NULL
        `;
      } else {
        countQuery = sql`
          SELECT count(*)::int as total
          FROM daily_attendance da
          JOIN student_enrollments se ON da.student_enrollment_id = se.id
          WHERE se.student_id = ${targetStudentId}
            AND se.school_id = ${req.schoolId}
            AND da.deleted_at IS NULL
        `;
      }
      const [countResult] = await countQuery;
      return sendSuccess(res, req.schoolId, {
        summary: summary[0],
        records: attendance,
        meta: {
          total: countResult.total,
          page: pg,
          limit: lim,
          total_pages: Math.ceil(countResult.total / lim) || 1,
        },
      });
    }

    sendSuccess(res, req.schoolId, {
      summary: summary[0],
      records: attendance
    });
  } catch (error) {

    res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

/**
 * GET /students/:id/fees
 * Get fee details for a student
 */
router.get('/:id/fees', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const targetStudentId = await resolveStudentParamWithAccess(req, res, id);
    if (!targetStudentId) return;

    const { academic_year_id, page, limit } = req.query;
    const usePaging = page !== undefined || limit !== undefined;
    const lim = Math.min(parseInt(limit, 10) || 20, 100);
    const pg = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (pg - 1) * lim;

    // Get fees
    let fees;
    if (academic_year_id) {
      fees = usePaging
        ? await sql`
        SELECT 
          sf.id, sf.amount_due, sf.amount_paid, sf.discount, sf.status,
          sf.due_date, sf.period_month, sf.period_year,
          ft.name as fee_type,
          (SELECT COUNT(*)::int FROM fee_adjustments fa WHERE fa.student_fee_id = sf.id) as adjustment_count
        FROM student_fees sf
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        JOIN fee_types ft ON fs.fee_type_id = ft.id
        WHERE sf.student_id = ${targetStudentId}
          AND sf.school_id = ${req.schoolId}
          AND sf.deleted_at IS NULL
          AND fs.deleted_at IS NULL
          AND fs.academic_year_id = ${academic_year_id}
        ORDER BY sf.due_date DESC
        LIMIT ${lim} OFFSET ${offset}
      `
        : await sql`
        SELECT 
          sf.id, sf.amount_due, sf.amount_paid, sf.discount, sf.status,
          sf.due_date, sf.period_month, sf.period_year,
          ft.name as fee_type,
          (SELECT COUNT(*)::int FROM fee_adjustments fa WHERE fa.student_fee_id = sf.id) as adjustment_count
        FROM student_fees sf
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        JOIN fee_types ft ON fs.fee_type_id = ft.id
        WHERE sf.student_id = ${targetStudentId}
          AND sf.school_id = ${req.schoolId}
          AND sf.deleted_at IS NULL
          AND fs.deleted_at IS NULL
          AND fs.academic_year_id = ${academic_year_id}
        ORDER BY sf.due_date DESC
      `;
    } else {
      fees = usePaging
        ? await sql`
        SELECT 
          sf.id, sf.amount_due, sf.amount_paid, sf.discount, sf.status,
          sf.due_date, ft.name as fee_type, ay.code as academic_year,
          (SELECT COUNT(*)::int FROM fee_adjustments fa WHERE fa.student_fee_id = sf.id) as adjustment_count
        FROM student_fees sf
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        JOIN fee_types ft ON fs.fee_type_id = ft.id
        JOIN academic_years ay ON fs.academic_year_id = ay.id
        WHERE sf.student_id = ${targetStudentId}
          AND sf.school_id = ${req.schoolId}
          AND sf.deleted_at IS NULL
          AND fs.deleted_at IS NULL
        ORDER BY sf.due_date DESC
        LIMIT ${lim} OFFSET ${offset}
      `
        : await sql`
        SELECT 
          sf.id, sf.amount_due, sf.amount_paid, sf.discount, sf.status,
          sf.due_date, ft.name as fee_type, ay.code as academic_year,
          (SELECT COUNT(*)::int FROM fee_adjustments fa WHERE fa.student_fee_id = sf.id) as adjustment_count
        FROM student_fees sf
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        JOIN fee_types ft ON fs.fee_type_id = ft.id
        JOIN academic_years ay ON fs.academic_year_id = ay.id
        WHERE sf.student_id = ${targetStudentId}
          AND sf.school_id = ${req.schoolId}
          AND sf.deleted_at IS NULL
          AND fs.deleted_at IS NULL
        ORDER BY sf.due_date DESC
        LIMIT 20
      `;
    }

    // Calculate summary — only active-mode fee structures
    const [schoolRow] = await sql`SELECT COALESCE(fee_mode, 'per_class') as fee_mode FROM schools WHERE id = ${req.schoolId}`;
    const feeMode = schoolRow?.fee_mode === 'per_section' ? 'per_section' : 'per_class';
    const structureFilter = feeMode === 'per_section'
      ? sql`AND fs.section_id IS NOT NULL`
      : sql`AND fs.section_id IS NULL`;

    const summary = await sql`
      SELECT 
        COALESCE(SUM(sf.amount_due - sf.discount), 0) as total_due,
        COALESCE(SUM(sf.amount_paid), 0) as total_paid,
        COALESCE(SUM(sf.amount_due - sf.discount - sf.amount_paid), 0) as balance
      FROM student_fees sf
      JOIN fee_structures fs ON sf.fee_structure_id = fs.id
      WHERE sf.student_id = ${targetStudentId}
        AND sf.school_id = ${req.schoolId}
        AND sf.deleted_at IS NULL
        AND fs.deleted_at IS NULL
        ${structureFilter}
    `;

    if (usePaging) {
      let countSql;
      if (academic_year_id) {
        countSql = sql`
          SELECT count(*)::int as total
          FROM student_fees sf
          JOIN fee_structures fs ON sf.fee_structure_id = fs.id
          WHERE sf.student_id = ${targetStudentId}
            AND sf.school_id = ${req.schoolId}
            AND sf.deleted_at IS NULL
            AND fs.deleted_at IS NULL
            AND fs.academic_year_id = ${academic_year_id}
        `;
      } else {
        countSql = sql`
          SELECT count(*)::int as total
          FROM student_fees sf
          WHERE sf.student_id = ${targetStudentId}
            AND sf.school_id = ${req.schoolId}
            AND sf.deleted_at IS NULL
        `;
      }
      const [countResult] = await countSql;
      return sendSuccess(res, req.schoolId, {
        student_id: targetStudentId,
        summary: summary[0],
        fees,
        meta: {
          total: countResult.total,
          page: pg,
          limit: lim,
          total_pages: Math.ceil(countResult.total / lim) || 1,
        },
      });
    }

    sendSuccess(res, req.schoolId, {
      student_id: targetStudentId,
      summary: summary[0],
      fees
    });
  } catch (error) {

    res.status(500).json({ error: 'Failed to fetch fees' });
  }
});

/**
 * GET /students/:id/parents
 * Get parent/guardian details for a student
 */
router.get('/:id/parents', requirePermission('students.view'), async (req, res) => {
  try {
    const { id } = req.params;
    const targetStudentId = await resolveStudentIdFromParam(req, id) ?? id;

    const parents = await sql`
      SELECT 
        pa.id as parent_id, pa.occupation,
        p.first_name, p.last_name, p.display_name, p.photo_url,
        rt.name as relationship,
        rt.name as relation,
        sp.is_primary_contact, sp.is_legal_guardian,
        (SELECT contact_value FROM person_contacts pc 
         WHERE pc.person_id = p.id AND pc.contact_type = 'phone' AND pc.is_primary = true LIMIT 1) as phone,
        (SELECT contact_value FROM person_contacts pc 
         WHERE pc.person_id = p.id AND pc.contact_type = 'email' AND pc.is_primary = true LIMIT 1) as email
      FROM student_parents sp
      JOIN parents pa ON sp.parent_id = pa.id
      JOIN persons p ON pa.person_id = p.id
      LEFT JOIN relationship_types rt ON sp.relationship_id = rt.id
      WHERE sp.student_id = ${targetStudentId}
        AND pa.school_id = ${req.schoolId}
        AND sp.deleted_at IS NULL
        AND pa.deleted_at IS NULL
      ORDER BY sp.is_primary_contact DESC
    `;

    sendSuccess(res, req.schoolId, parents);
  } catch (error) {

    res.status(500).json({ error: 'Failed to fetch parents' });
  }
});

/**
 * POST /students/:id/parents
 * Link a parent to a student
 */
router.post('/:id/parents', requirePermission('students.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { parent_id, relationship_id, is_primary_contact, is_legal_guardian } = req.body;

    if (!parent_id) {
      return res.status(400).json({ error: 'parent_id is required' });
    }

    // Verify Ownership
    const [studentCheck] = await sql`SELECT id FROM students WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL`;
    if (!studentCheck) return res.status(404).json({ error: 'Student not found' });

    // Verify parent belongs to this school
    const [parentCheck] = await sql`SELECT id FROM parents WHERE id = ${parent_id} AND school_id = ${req.schoolId} AND deleted_at IS NULL`;
    if (!parentCheck) return res.status(404).json({ error: 'Parent not found' });

    const [link] = await sql`
      INSERT INTO student_parents (school_id, student_id, parent_id, relationship_id, is_primary_contact, is_legal_guardian)
    VALUES (${req.schoolId}, ${id}, ${parent_id}, ${relationship_id}, ${is_primary_contact || false}, ${is_legal_guardian || false})
      RETURNING *
    `;

    sendSuccess(res, req.schoolId, { message: 'Parent linked successfully', link }, 201);
  } catch (error) {

    res.status(500).json({ error: 'Failed to link parent', details: error.message });
  }
});

/**
 * GET /students/:id/results
 * Get exam results (marks), attendance %, grading scale for progress report
 */
router.get('/:id/results', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const targetStudentId = await resolveStudentParamWithAccess(req, res, id);
    if (!targetStudentId) return;

    // 1. Find student's active enrollment
    const [enrollment] = await sql`
      SELECT se.id, se.academic_year_id, se.class_section_id,
             ay.code as academic_year_code
      FROM student_enrollments se
      JOIN academic_years ay ON se.academic_year_id = ay.id
      WHERE se.student_id = ${targetStudentId}
        AND se.school_id = ${req.schoolId}
        AND se.status = 'active'
        AND se.deleted_at IS NULL
      LIMIT 1
    `;

    if (!enrollment) {
      return sendSuccess(res, req.schoolId, {
        exams: [],
        attendance: { present: 0, absent: 0, late: 0, total: 0, percentage: 0 },
        academic_year: 'N/A',
        grading_scale: []
      });
    }

    const subjectMarksRows = await sql`
      SELECT
        e.id AS exam_id,
        e.name AS exam_name,
        e.exam_type,
        e.start_date,
        e.end_date,
        COALESCE(
          json_agg(
            json_build_object(
              'subject', sub.name,
              'maxMarks', es.max_marks,
              'passingMarks', es.passing_marks,
              'obtained', COALESCE(m.marks_obtained, 0),
              'is_absent', COALESCE(m.is_absent, false),
              'remarks', m.remarks
            ) ORDER BY sub.name
          ) FILTER (WHERE es.id IS NOT NULL),
          '[]'::json
        ) AS subjects
      FROM exams e
      LEFT JOIN exam_subjects es ON es.exam_id = e.id
        AND es.school_id = ${req.schoolId}
        AND es.deleted_at IS NULL
      LEFT JOIN subjects sub ON es.subject_id = sub.id
      LEFT JOIN marks m ON m.exam_subject_id = es.id
        AND m.student_enrollment_id = ${enrollment.id}
      WHERE e.academic_year_id = ${enrollment.academic_year_id}
        AND e.school_id = ${req.schoolId}
        AND e.deleted_at IS NULL
        AND e.status != 'cancelled'
      GROUP BY e.id, e.name, e.exam_type, e.start_date, e.end_date
      ORDER BY e.start_date ASC
    `;

    const examResults = subjectMarksRows.map((row) => ({
      exam_id: row.exam_id,
      exam_name: row.exam_name,
      exam_type: row.exam_type,
      start_date: row.start_date,
      end_date: row.end_date,
      subjects: (row.subjects || []).map((sm) => ({
        subject: sm.subject,
        maxMarks: Number(sm.maxMarks),
        passingMarks: Number(sm.passingMarks),
        obtained: sm.is_absent ? 0 : Number(sm.obtained),
        is_absent: sm.is_absent,
        remarks: sm.remarks,
      })),
    }));

    // 4. Attendance summary
    const [attSummary] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE da.status = 'present')::int as present,
        COUNT(*) FILTER (WHERE da.status = 'absent')::int as absent,
        COUNT(*) FILTER (WHERE da.status = 'late')::int as late,
        COUNT(*)::int as total
      FROM daily_attendance da
      JOIN student_enrollments se ON da.student_enrollment_id = se.id
      WHERE se.student_id = ${targetStudentId}
        AND se.school_id = ${req.schoolId}
        AND da.deleted_at IS NULL
    `;
    const total = attSummary.total || 0;
    const presentCount = (attSummary.present || 0) + (attSummary.late || 0);
    const attendancePercentage = total > 0 ? parseFloat(((presentCount / total) * 100).toFixed(1)) : 0;

    // 5. Grading scale
    const gradingScale = await sql`
      SELECT grade, min_percentage, max_percentage, grade_point
      FROM grading_scales
      WHERE school_id = ${req.schoolId}
        AND deleted_at IS NULL
      ORDER BY min_percentage DESC
    `;

    // 6. Compute grades for each subject if grading scale exists
    if (gradingScale.length > 0) {
      for (const exam of examResults) {
        for (const sub of exam.subjects) {
          if (sub.maxMarks > 0) {
            const pct = (sub.obtained / sub.maxMarks) * 100;
            const matched = gradingScale.find(g =>
              pct >= Number(g.min_percentage) && pct <= Number(g.max_percentage)
            );
            sub.grade = matched ? matched.grade : '-';
          } else {
            sub.grade = '-';
          }
        }
      }
    }

    sendSuccess(res, req.schoolId, {
      exams: examResults,
      attendance: {
        present: attSummary.present || 0,
        absent: attSummary.absent || 0,
        late: attSummary.late || 0,
        total,
        percentage: attendancePercentage
      },
      academic_year: enrollment.academic_year_code,
      grading_scale: gradingScale.map(g => ({
        grade: g.grade,
        min: Number(g.min_percentage),
        max: Number(g.max_percentage),
        gpa: Number(g.grade_point)
      }))
    });

  } catch (error) {
    console.error('[GET /:id/results] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch results', details: error.message });
  }
});

export default router;
