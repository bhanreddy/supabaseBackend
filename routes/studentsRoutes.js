import express from 'express';
import sql, { supabaseAdmin } from '../db.js';
import { requirePermission, requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Get all students
router.get('/', requirePermission('students.view'), async (req, res) => {
  try {
    const { search, limit } = req.query;

    let query = sql`
      SELECT 
        s.id, s.admission_no, s.admission_date,
        p.first_name, p.middle_name, p.last_name, p.display_name, p.dob, p.gender_id,
        st.code as status,
        (SELECT contact_value FROM person_contacts pc WHERE pc.person_id = p.id AND pc.contact_type = 'email' AND pc.is_primary = true LIMIT 1) as email,
        (SELECT contact_value FROM person_contacts pc WHERE pc.person_id = p.id AND pc.contact_type = 'phone' AND pc.is_primary = true LIMIT 1) as phone,
        json_build_object(
            'roll_number', se.roll_number,
            'class_code', c.code,
            'section_name', sec.name
        ) as current_enrollment
      FROM students s
      JOIN persons p ON s.person_id = p.id
      JOIN student_statuses st ON s.status_id = st.id
      LEFT JOIN student_enrollments se ON s.id = se.student_id AND se.status = 'active' AND se.deleted_at IS NULL
      LEFT JOIN class_sections cs ON se.class_section_id = cs.id
      LEFT JOIN classes c ON cs.class_id = c.id
      LEFT JOIN sections sec ON cs.section_id = sec.id
      WHERE s.deleted_at IS NULL
    `;

    if (search) {
      query = sql`${query} AND (
        p.display_name ILIKE ${'%' + search + '%'} OR 
        s.admission_no ILIKE ${'%' + search + '%'}
      )`;
    }

    if (limit) {
      query = sql`${query} LIMIT ${limit}`;
    }

    const students = await query;
    res.json(students);
  } catch (error) {
    console.error('Error fetching students:', error);
    res.status(500).json({ error: 'Failed to fetch students', details: error.message });
  }
});

// Get current student profile
router.get('/profile/me', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get Person ID -> Student ID
    const [userRecord] = await sql`SELECT person_id FROM users WHERE id = ${userId}`;
    if (!userRecord) return res.status(404).json({ error: 'User not found' });

    const [studentRecord] = await sql`SELECT id FROM students WHERE person_id = ${userRecord.person_id}`;
    if (!studentRecord) return res.status(404).json({ error: 'Student profile not found for this user' });

    const id = studentRecord.id;

    // Reuse query from GET /:id
    const student = await sql`
      SELECT 
        s.id, s.admission_no, s.admission_date,
        p.first_name, p.middle_name, p.last_name, p.display_name, p.dob, p.gender_id,
        st.code as status,
        -- Fetch Primary Email
        (SELECT contact_value FROM person_contacts pc WHERE pc.person_id = p.id AND pc.contact_type = 'email' AND pc.is_primary = true LIMIT 1) as email,
        -- Fetch Primary Phone
        (SELECT contact_value FROM person_contacts pc WHERE pc.person_id = p.id AND pc.contact_type = 'phone' AND pc.is_primary = true LIMIT 1) as phone,
        -- Current Enrollment
        (
            SELECT json_build_object(
                'id', se.id,
                'roll_number', se.roll_number,
                'class_code', c.code,
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
      WHERE s.id = ${id}
    `;

    if (student.length === 0) return res.status(404).json({ error: 'Student not found' });
    res.json(student[0]);

  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Get student by ID
router.get('/:id', requirePermission('students.view'), async (req, res) => {
  try {
    const { id } = req.params;
    const student = await sql`
      SELECT 
        s.id, s.admission_no, s.admission_date,
        p.first_name, p.middle_name, p.last_name, p.display_name, p.dob, p.gender_id,
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
        ) as current_enrollment
      FROM students s
      JOIN persons p ON s.person_id = p.id
      JOIN student_statuses st ON s.status_id = st.id
      WHERE s.id = ${id}
    `;

    if (student.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    res.json(student[0]);
  } catch (error) {
    console.error('Error fetching student:', error);
    res.status(500).json({ error: 'Failed to fetch student' });
  }
});

// Insert new Student with optional User and Enrollment
router.post('/', requirePermission('students.create'), async (req, res) => {
  try {
    const {
      first_name, middle_name = null, last_name, dob = null, gender_id,
      admission_no, admission_date, status_id, category_id = null, religion_id = null, blood_group_id = null,
      email = null, phone = null,
      password = null, role_code = null, // For User Creation
      class_id = null, section_id = null, academic_year_id = null, // For Initial Enrollment
      parents // Array of { first_name, last_name, relation, phone, occupation, is_primary }
    } = req.body;

    console.log('Creating student payload:', JSON.stringify(req.body, null, 2));
    import('fs').then(fs => fs.appendFileSync('server_debug.log', new Date().toISOString() + ' REQ: ' + JSON.stringify(req.body) + '\n'));

    // Basic Validation
    if (!first_name || !last_name || !admission_no || !admission_date || !status_id || !gender_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await sql.begin(async sql => {
      // 1. Create Person
      const [person] = await sql`
        INSERT INTO persons (first_name, middle_name, last_name, dob, gender_id, display_name)
        VALUES (
            ${first_name}, ${middle_name}, ${last_name}, ${dob}, ${gender_id}, 
            ${first_name + ' ' + last_name}
        )
        RETURNING id
      `;

      // 2. Create Student
      const [student] = await sql`
        INSERT INTO students (
          person_id, admission_no, admission_date, status_id, 
          category_id, religion_id, blood_group_id
        )
        VALUES (
          ${person.id}, ${admission_no}, ${admission_date}, ${status_id},
          ${category_id}, ${religion_id}, ${blood_group_id}
        )
        RETURNING *
      `;

      // 3. Contacts
      if (email) {
        await sql`INSERT INTO person_contacts (person_id, contact_type, contact_value, is_primary) VALUES (${person.id}, 'email', ${email}, true)`;
      }
      if (phone) {
        await sql`INSERT INTO person_contacts (person_id, contact_type, contact_value, is_primary) VALUES (${person.id}, 'phone', ${phone}, true)`;
      }

      // 4. Create User Login (Optional)
      if (password && email) {
        let authUserId;

        // Try Create Supabase User
        const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
          email: email,
          password: password,
          email_confirm: true,
          user_metadata: {
            first_name, last_name, person_id: person.id
          }
        });

        if (authError) {
          console.log('Use Creation Auth Error:', authError.message);
          // If user already exists, try to reuse the ID (Orphaned Auth User case)
          if (authError.message.includes('already been registered')) {
            console.log('User already exists in Auth, attempting to link...');
            const { data: { users }, error: listError } = await supabaseAdmin.auth.admin.listUsers();
            if (listError) throw new Error('Auth List Error: ' + listError.message);

            const existingUser = users.find(u => u.email === email);
            if (!existingUser) throw new Error('User reported existing but not found in list');

            authUserId = existingUser.id;

            // Update metadata
            await supabaseAdmin.auth.admin.updateUserById(authUserId, {
              user_metadata: { first_name, last_name, person_id: person.id }
            });

          } else {
            throw new Error('Auth Error: ' + authError.message);
          }
        } else {
          authUserId = authUser.user.id;
        }

        // Create Local User
        // Check if local user already exists (consistency check)
        const [existingLocalUser] = await sql`SELECT id FROM users WHERE id = ${authUserId}`;
        if (!existingLocalUser) {
          const [user] = await sql`
              INSERT INTO users (id, person_id, account_status)
              VALUES (${authUserId}, ${person.id}, 'active')
              RETURNING id
            `;
          // Assign Role
          const roleCode = role_code || 'student';
          const [role] = await sql`SELECT id FROM roles WHERE code = ${roleCode}`;

          if (role) {
            await sql`INSERT INTO user_roles (user_id, role_id) VALUES (${user.id}, ${role.id})`;
          }
        }
      }

      // 5. Initial Enrollment (Optional)
      if (class_id && section_id && academic_year_id) {
        // Find Class Section
        const [classSection] = await sql`
            SELECT id FROM class_sections 
            WHERE class_id = ${class_id} AND section_id = ${section_id}
        `;

        if (classSection) {
          await sql`
                INSERT INTO student_enrollments (student_id, class_section_id, academic_year_id, status, start_date)
                VALUES (${student.id}, ${classSection.id}, ${academic_year_id}, 'active', ${admission_date})
             `;

          // 🆕 Post-commit Recalculation Trigger
          recalcParams = { classSectionId: classSection.id, academicYearId: academic_year_id };
        }
      }

      // 6. Create Parents (New Feature)
      if (parents && Array.isArray(parents) && parents.length > 0) {
        for (const parentData of parents) {
          // Check if mandatory fields exist
          if (!parentData.first_name || !parentData.last_name || !parentData.relation) continue;

          // 6a. Create Parent Person
          const [parentPerson] = await sql`
                INSERT INTO persons (first_name, last_name, gender_id, display_name)
                VALUES (
                    ${parentData.first_name}, ${parentData.last_name}, 
                    ${parentData.relation === 'Mother' ? 2 : 1}, -- Rudimentary gender logic
                    ${parentData.first_name + ' ' + parentData.last_name}
                )
                RETURNING id
            `;

          // 6b. Add Parent Contact (Phone)
          if (parentData.phone) {
            await sql`
                    INSERT INTO person_contacts (person_id, contact_type, contact_value, is_primary) 
                    VALUES (${parentPerson.id}, 'phone', ${parentData.phone}, true)
                 `;
          }

          // 6c. Create Parent Record
          const [parentRecord] = await sql`
                INSERT INTO parents (person_id, occupation)
                VALUES (${parentPerson.id}, ${parentData.occupation || null})
                RETURNING id
            `;

          // 6d. Link to Student
          const relationshipMap = { 'Father': 1, 'Mother': 2, 'Guardian': 3 };
          const relId = relationshipMap[parentData.relation] || 3;

          await sql`
                INSERT INTO student_parents (student_id, parent_id, relationship_id, is_primary_contact, is_legal_guardian)
                VALUES (
                    ${student.id}, ${parentRecord.id}, ${relId}, 
                    ${parentData.is_primary || false}, 
                    ${parentData.is_guardian || false}
                )
            `;
        }
      }

      return student;
    });

    if (recalcParams) {
      // Run Recalculation on committed data
      try {
        await sql`SELECT recalculate_section_rolls(${recalcParams.classSectionId}, ${recalcParams.academicYearId})`;
      } catch (e) {
        console.error('Post-transaction recalculation failed:', e);
      }
    }

    res.status(201).json({
      message: 'Student created successfully',
      student: result
    });
  } catch (error) {
    import('fs').then(fs => fs.appendFileSync('server_debug.log', new Date().toISOString() + ' ERR: ' + error.message + '\n' + error.stack + '\n'));
    console.error('Error creating student:', error);
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
            WHERE class_id = ${class_id} AND section_id = ${section_id}
        `;

    if (!classSection) return res.status(404).json({ error: 'Class section not found' });

    await sql`SELECT recalculate_section_rolls(${classSection.id}, ${academic_year_id})`;

    res.json({ message: 'Roll numbers recalculated successfully' });
  } catch (error) {
    console.error('Error recalculating rolls:', error);
    res.status(500).json({ error: 'Failed to recalculate rolls' });
  }
});

// Update student
router.put('/:id', requirePermission('students.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      first_name, middle_name, last_name, dob, gender_id,
      admission_no, admission_date, status_id, category_id, religion_id, blood_group_id,
      email, phone
    } = req.body;

    const result = await sql.begin(async sql => {
      // 1. Get Person ID from Student
      const [student] = await sql`SELECT person_id FROM students WHERE id = ${id}`;
      if (!student) throw new Error('Student not found');

      const personId = student.person_id;

      // 2. Update Person
      await sql`
        UPDATE persons
        SET 
          first_name = COALESCE(${first_name}, first_name),
          middle_name = COALESCE(${middle_name}, middle_name),
          last_name = COALESCE(${last_name}, last_name),
          dob = COALESCE(${dob}, dob),
          gender_id = COALESCE(${gender_id}, gender_id)
        WHERE id = ${personId}
      `;

      // 3. Update Student
      const [updatedStudent] = await sql`
        UPDATE students
        SET 
          admission_no = COALESCE(${admission_no}, admission_no),
          admission_date = COALESCE(${admission_date}, admission_date),
          status_id = COALESCE(${status_id}, status_id),
          category_id = COALESCE(${category_id}, category_id),
          religion_id = COALESCE(${religion_id}, religion_id),
          blood_group_id = COALESCE(${blood_group_id}, blood_group_id)
        WHERE id = ${id}
        RETURNING *
      `;

      // 4. Update Contacts 
      // Handle Email: If exists as primary, update. Else insert.
      if (email) {
        const [existingEmail] = await sql`
           SELECT id FROM person_contacts 
           WHERE person_id = ${personId} AND contact_type = 'email' AND is_primary = true
        `;
        if (existingEmail) {
          await sql`UPDATE person_contacts SET contact_value = ${email} WHERE id = ${existingEmail.id}`;
        } else {
          await sql`INSERT INTO person_contacts (person_id, contact_type, contact_value, is_primary) VALUES (${personId}, 'email', ${email}, true)`;
        }
      }

      // Handle Phone
      if (phone) {
        const [existingPhone] = await sql`
           SELECT id FROM person_contacts 
           WHERE person_id = ${personId} AND contact_type = 'phone' AND is_primary = true
        `;
        if (existingPhone) {
          await sql`UPDATE person_contacts SET contact_value = ${phone} WHERE id = ${existingPhone.id}`;
        } else {
          await sql`INSERT INTO person_contacts (person_id, contact_type, contact_value, is_primary) VALUES (${personId}, 'phone', ${phone}, true)`;
        }
      }

      return updatedStudent;
    });

    res.json({
      message: 'Student updated successfully',
      student: result
    });
  } catch (error) {
    console.error('Error updating student:', error);
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
      WHERE id = ${id} 
      RETURNING id
    `;

    if (result.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    res.json({ message: 'Student deleted successfully' });
  } catch (error) {
    console.error('Error deleting student:', error);
    res.status(500).json({ error: 'Failed to delete student', details: error.message });
  }
});

// ============== SUB-ROUTES ==============

/**
 * GET /students/:id/enrollments
 * Get enrollment history for a student
 */
router.get('/:id/enrollments', requirePermission('students.view'), async (req, res) => {
  try {
    const { id } = req.params;

    const enrollments = await sql`
      SELECT 
        se.id, se.status, se.start_date, se.end_date, se.created_at,
        c.name as class_name, s.name as section_name,
        ay.code as academic_year
      FROM student_enrollments se
      JOIN class_sections cs ON se.class_section_id = cs.id
      JOIN classes c ON cs.class_id = c.id
      JOIN sections s ON cs.section_id = s.id
      JOIN academic_years ay ON se.academic_year_id = ay.id
      WHERE se.student_id = ${id}
        AND se.deleted_at IS NULL
      ORDER BY se.start_date DESC
    `;

    res.json(enrollments);
  } catch (error) {
    console.error('Error fetching enrollments:', error);
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

    // Check access: Allow if user has 'students.view' OR if user is the student themselves
    const hasViewPermission = req.user.permissions?.includes('students.view') || req.user.roles?.includes('admin');
    let isOwner = false;

    if (!hasViewPermission) {
      const [student] = await sql`
            SELECT s.id 
            FROM students s
            JOIN users u ON s.person_id = u.person_id
            WHERE u.id = ${req.user.internal_id}
        `;
      if (student && student.id === id) {
        isOwner = true;
      }
    }

    if (!hasViewPermission && !isOwner) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { from_date, to_date, limit = 30 } = req.query;

    let attendance;
    if (from_date && to_date) {
      attendance = await sql`
        SELECT 
          da.attendance_date, da.status, da.marked_at,
          c.name as class_name, s.name as section_name
        FROM daily_attendance da
        JOIN student_enrollments se ON da.student_enrollment_id = se.id
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections s ON cs.section_id = s.id
        WHERE se.student_id = ${id}
          AND da.attendance_date BETWEEN ${from_date} AND ${to_date}
          AND da.deleted_at IS NULL
        ORDER BY da.attendance_date DESC
      `;
    } else {
      attendance = await sql`
        SELECT 
          da.attendance_date, da.status, da.marked_at,
          c.name as class_name, s.name as section_name
        FROM daily_attendance da
        JOIN student_enrollments se ON da.student_enrollment_id = se.id
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections s ON cs.section_id = s.id
        WHERE se.student_id = ${id}
          AND da.deleted_at IS NULL
        ORDER BY da.attendance_date DESC
        LIMIT ${limit}
      `;
    }

    // Calculate summary
    const summary = await sql`
      SELECT 
        COUNT(*) FILTER (WHERE da.status = 'present') as present,
        COUNT(*) FILTER (WHERE da.status = 'absent') as absent,
        COUNT(*) FILTER (WHERE da.status = 'late') as late,
        COUNT(*) as total
      FROM daily_attendance da
      JOIN student_enrollments se ON da.student_enrollment_id = se.id
      WHERE se.student_id = ${id}
        AND da.deleted_at IS NULL
    `;

    res.json({
      summary: summary[0],
      records: attendance
    });
  } catch (error) {
    console.error('Error fetching attendance:', error);
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

    // Check access
    const hasViewPermission = req.user.permissions?.includes('students.view') || req.user.roles?.includes('admin');
    let isOwner = false;

    if (!hasViewPermission) {
      const [student] = await sql`
            SELECT s.id 
            FROM students s
            JOIN users u ON s.person_id = u.person_id
            WHERE u.id = ${req.user.internal_id}
        `;
      if (student && student.id === id) {
        isOwner = true;
      }
    }

    if (!hasViewPermission && !isOwner) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { academic_year_id } = req.query;

    // Get fees
    let fees;
    if (academic_year_id) {
      fees = await sql`
        SELECT 
          sf.id, sf.amount_due, sf.amount_paid, sf.discount, sf.status,
          sf.due_date, sf.period_month, sf.period_year,
          ft.name as fee_type
        FROM student_fees sf
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        JOIN fee_types ft ON fs.fee_type_id = ft.id
        WHERE sf.student_id = ${id}
          AND fs.academic_year_id = ${academic_year_id}
        ORDER BY sf.due_date DESC
      `;
    } else {
      fees = await sql`
        SELECT 
          sf.id, sf.amount_due, sf.amount_paid, sf.discount, sf.status,
          sf.due_date, ft.name as fee_type, ay.code as academic_year
        FROM student_fees sf
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        JOIN fee_types ft ON fs.fee_type_id = ft.id
        JOIN academic_years ay ON fs.academic_year_id = ay.id
        WHERE sf.student_id = ${id}
        ORDER BY sf.due_date DESC
        LIMIT 20
      `;
    }

    // Calculate summary
    const summary = await sql`
      SELECT 
        COALESCE(SUM(amount_due - discount), 0) as total_due,
        COALESCE(SUM(amount_paid), 0) as total_paid,
        COALESCE(SUM(amount_due - discount - amount_paid), 0) as balance
      FROM student_fees
      WHERE student_id = ${id}
    `;

    res.json({
      student_id: id,
      summary: summary[0],
      fees
    });
  } catch (error) {
    console.error('Error fetching fees:', error);
    res.status(500).json({ error: 'Failed to fetch fees' });
  }
});

/**
 * GET /students/:id/results
 * Get exam results for a student
 */
router.get('/:id/results', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Check access
    const hasViewPermission = req.user.permissions?.includes('students.view') || req.user.roles?.includes('admin');
    let isOwner = false;

    if (!hasViewPermission) {
      const [student] = await sql`
            SELECT s.id 
            FROM students s
            JOIN users u ON s.person_id = u.person_id
            WHERE u.id = ${req.user.internal_id}
        `;
      if (student && student.id === id) {
        isOwner = true;
      }
    }

    if (!hasViewPermission && !isOwner) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { exam_id, academic_year_id } = req.query;

    let results;
    if (exam_id) {
      results = await sql`
        SELECT 
          m.marks_obtained, m.is_absent,
          s.name as subject_name,
          es.max_marks, es.passing_marks,
          e.name as exam_name
        FROM marks m
        JOIN exam_subjects es ON m.exam_subject_id = es.id
        JOIN subjects s ON es.subject_id = s.id
        JOIN exams e ON es.exam_id = e.id
        JOIN student_enrollments se ON m.student_enrollment_id = se.id
        WHERE se.student_id = ${id}
          AND es.exam_id = ${exam_id}
        ORDER BY s.name
      `;
    } else {
      results = await sql`
        SELECT 
          e.id as exam_id, e.name as exam_name, e.exam_type,
          ay.code as academic_year,
          COUNT(DISTINCT es.subject_id) as subjects_count,
          SUM(CASE WHEN m.is_absent THEN 0 ELSE m.marks_obtained END) as total_obtained,
          SUM(es.max_marks) as total_max
        FROM marks m
        JOIN exam_subjects es ON m.exam_subject_id = es.id
        JOIN exams e ON es.exam_id = e.id
        JOIN academic_years ay ON e.academic_year_id = ay.id
        JOIN student_enrollments se ON m.student_enrollment_id = se.id
        WHERE se.student_id = ${id}
          ${academic_year_id ? sql`AND e.academic_year_id = ${academic_year_id}` : sql``}
        GROUP BY e.id, e.name, e.exam_type, ay.code
        ORDER BY e.start_date DESC
        LIMIT 10
      `;
    }

    res.json({
      student_id: id,
      results
    });
  } catch (error) {
    console.error('Error fetching results:', error);
    res.status(500).json({ error: 'Failed to fetch results' });
  }
});

/**
 * GET /students/:id/parents
 * Get parent/guardian details for a student
 */
router.get('/:id/parents', requirePermission('students.view'), async (req, res) => {
  try {
    const { id } = req.params;

    const parents = await sql`
      SELECT 
        pa.id as parent_id, pa.occupation,
        p.display_name, p.photo_url,
        rt.name as relationship,
        sp.is_primary_contact, sp.is_legal_guardian,
        (SELECT contact_value FROM person_contacts pc 
         WHERE pc.person_id = p.id AND pc.contact_type = 'phone' AND pc.is_primary = true LIMIT 1) as phone,
        (SELECT contact_value FROM person_contacts pc 
         WHERE pc.person_id = p.id AND pc.contact_type = 'email' AND pc.is_primary = true LIMIT 1) as email
      FROM student_parents sp
      JOIN parents pa ON sp.parent_id = pa.id
      JOIN persons p ON pa.person_id = p.id
      LEFT JOIN relationship_types rt ON sp.relationship_id = rt.id
      WHERE sp.student_id = ${id}
        AND sp.deleted_at IS NULL
        AND pa.deleted_at IS NULL
      ORDER BY sp.is_primary_contact DESC
    `;

    res.json(parents);
  } catch (error) {
    console.error('Error fetching parents:', error);
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

    const [link] = await sql`
      INSERT INTO student_parents (student_id, parent_id, relationship_id, is_primary_contact, is_legal_guardian)
      VALUES (${id}, ${parent_id}, ${relationship_id}, ${is_primary_contact || false}, ${is_legal_guardian || false})
      RETURNING *
    `;

    res.status(201).json({ message: 'Parent linked successfully', link });
  } catch (error) {
    console.error('Error linking parent:', error);
    res.status(500).json({ error: 'Failed to link parent', details: error.message });
  }
});

export default router;