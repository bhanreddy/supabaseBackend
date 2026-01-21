import express from 'express';
import sql, { supabaseAdmin } from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * GET /staff
 * List all staff members
 */
router.get('/', requirePermission('staff.view'), asyncHandler(async (req, res) => {
    const { status, designation_id } = req.query;

    const staff = await sql`
    SELECT 
      st.id, st.staff_code, st.joining_date, st.salary,
      p.first_name, p.middle_name, p.last_name, p.display_name, p.dob, p.photo_url,
      g.name as gender,
      sd.name as designation,
      ss.name as status,
      (SELECT contact_value FROM person_contacts pc 
       WHERE pc.person_id = p.id AND pc.contact_type = 'email' AND pc.is_primary = true LIMIT 1) as email,
      (SELECT contact_value FROM person_contacts pc 
       WHERE pc.person_id = p.id AND pc.contact_type = 'phone' AND pc.is_primary = true LIMIT 1) as phone
    FROM staff st
    JOIN persons p ON st.person_id = p.id
    LEFT JOIN genders g ON p.gender_id = g.id
    LEFT JOIN staff_designations sd ON st.designation_id = sd.id
    LEFT JOIN staff_statuses ss ON st.status_id = ss.id
    WHERE st.deleted_at IS NULL
      ${status ? sql`AND ss.code = ${status}` : sql``}
      ${designation_id ? sql`AND st.designation_id = ${designation_id}` : sql``}
    ORDER BY p.display_name
  `;

    res.json(staff);
}));

/**
 * GET /staff/:id
 * Get single staff member details
 */
router.get('/:id', requirePermission('staff.view'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [staff] = await sql`
    SELECT 
      st.id, st.staff_code, st.joining_date, st.salary, st.created_at,
      p.id as person_id, p.first_name, p.middle_name, p.last_name, p.display_name, p.dob, p.photo_url,
      g.name as gender,
      sd.name as designation, sd.id as designation_id,
      ss.name as status, ss.id as status_id,
      u.id as user_id, u.account_status,
      (SELECT json_agg(json_build_object('type', pc.contact_type, 'value', pc.contact_value, 'is_primary', pc.is_primary))
       FROM person_contacts pc WHERE pc.person_id = p.id AND pc.deleted_at IS NULL) as contacts
    FROM staff st
    JOIN persons p ON st.person_id = p.id
    LEFT JOIN genders g ON p.gender_id = g.id
    LEFT JOIN staff_designations sd ON st.designation_id = sd.id
    LEFT JOIN staff_statuses ss ON st.status_id = ss.id
    LEFT JOIN users u ON u.person_id = p.id
    WHERE st.id = ${id} AND st.deleted_at IS NULL
  `;

    if (!staff) {
        return res.status(404).json({ error: 'Staff not found' });
    }

    res.json(staff);
}));

/**
 * POST /staff
 * Create new staff member (and optionally user login)
 */
router.post('/', requirePermission('staff.create'), asyncHandler(async (req, res) => {
    const {
        first_name, middle_name, last_name, dob, gender_id,
        staff_code, joining_date, status_id, designation_id, salary,
        email, phone, password, role_code // Added password and role_code
    } = req.body;

    if (!first_name || !last_name || !staff_code || !joining_date) {
        return res.status(400).json({ error: 'Missing required fields: first_name, last_name, staff_code, joining_date' });
    }

    // Check if user creation is requested but password missing
    if (role_code && !password) {
        return res.status(400).json({ error: 'Password is required when creating a login user' });
    }

    try {
        const result = await sql.begin(async sql => {
            // 1. Create Person
            const [person] = await sql`
                INSERT INTO persons (first_name, middle_name, last_name, dob, gender_id)
                VALUES (${first_name}, ${middle_name || null}, ${last_name}, ${dob || null}, ${gender_id})
                RETURNING id
            `;

            // 2. Create Staff
            const [staff] = await sql`
                INSERT INTO staff (person_id, staff_code, joining_date, status_id, designation_id, salary)
                VALUES (${person.id}, ${staff_code}, ${joining_date}, ${status_id || 1}, ${designation_id}, ${salary || null})
                RETURNING *
            `;

            // 3. Contacts
            if (email) {
                await sql`INSERT INTO person_contacts (person_id, contact_type, contact_value, is_primary) 
                    VALUES (${person.id}, 'email', ${email}, true)`;
            }
            if (phone) {
                await sql`INSERT INTO person_contacts (person_id, contact_type, contact_value, is_primary) 
                    VALUES (${person.id}, 'phone', ${phone}, true)`;
            }

            // 4. Create User Login (Optional)
            if (password && email) {
                // Ensure Supabase Admin is available
                if (!supabaseAdmin) {
                    throw new Error('Server misconfiguration: Admin client not initialized');
                }

                // Create Supabase User
                const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
                    email,
                    password,
                    email_confirm: true,
                    user_metadata: { person_id: person.id }
                });

                if (authError) {
                    throw new Error(`Supabase Auth Error: ${authError.message}`);
                }

                const supabaseUserId = authData.user.id;

                // Create Local User
                const [user] = await sql`
                    INSERT INTO users (id, person_id, account_status)
                    VALUES (${supabaseUserId}, ${person.id}, 'active')
                    RETURNING id
                `;

                // Assign Role (default to 'staff' if not provided)
                const userRole = role_code || 'staff';
                const [role] = await sql`SELECT id FROM roles WHERE code = ${userRole}`;

                if (role) {
                    await sql`
                        INSERT INTO user_roles (user_id, role_id, granted_by)
                        VALUES (${user.id}, ${role.id}, ${req.user.internal_id})
                    `;
                }
            }

            return staff;
        });

        res.status(201).json({ message: 'Staff created successfully', staff: result });
    } catch (error) {
        console.error('Error creating staff:', error);
        if (error.message.includes('Supabase Auth Error')) {
            return res.status(400).json({ error: error.message });
        }
        res.status(500).json({ error: 'Failed to create staff', details: error.message });
    }
}));

/**
 * PUT /staff/:id
 * Update staff member
 */
router.put('/:id', requirePermission('staff.edit'), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
        first_name, middle_name, last_name, dob, gender_id,
        staff_code, joining_date, status_id, designation_id, salary,
        email, phone
    } = req.body;

    const result = await sql.begin(async sql => {
        // 1. Get Person ID from Staff
        const [staff] = await sql`SELECT person_id FROM staff WHERE id = ${id} AND deleted_at IS NULL`;
        if (!staff) throw new Error('Staff not found');

        const personId = staff.person_id;

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

        // 3. Update Staff
        const [updatedStaff] = await sql`
      UPDATE staff
      SET 
        staff_code = COALESCE(${staff_code}, staff_code),
        joining_date = COALESCE(${joining_date}, joining_date),
        status_id = COALESCE(${status_id}, status_id),
        designation_id = COALESCE(${designation_id}, designation_id),
        salary = COALESCE(${salary}, salary)
      WHERE id = ${id}
      RETURNING *
    `;

        // 4. Update Contacts
        if (email) {
            const [existing] = await sql`
        SELECT id FROM person_contacts 
        WHERE person_id = ${personId} AND contact_type = 'email' AND is_primary = true
      `;
            if (existing) {
                await sql`UPDATE person_contacts SET contact_value = ${email} WHERE id = ${existing.id}`;
            } else {
                await sql`INSERT INTO person_contacts (person_id, contact_type, contact_value, is_primary) 
                  VALUES (${personId}, 'email', ${email}, true)`;
            }
        }

        if (phone) {
            const [existing] = await sql`
        SELECT id FROM person_contacts 
        WHERE person_id = ${personId} AND contact_type = 'phone' AND is_primary = true
      `;
            if (existing) {
                await sql`UPDATE person_contacts SET contact_value = ${phone} WHERE id = ${existing.id}`;
            } else {
                await sql`INSERT INTO person_contacts (person_id, contact_type, contact_value, is_primary) 
                  VALUES (${personId}, 'phone', ${phone}, true)`;
            }
        }

        return updatedStaff;
    });

    res.json({ message: 'Staff updated successfully', staff: result });
}));

/**
 * DELETE /staff/:id
 * Soft delete staff member
 */
router.delete('/:id', requirePermission('staff.delete'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [result] = await sql`
    UPDATE staff SET deleted_at = NOW() WHERE id = ${id} AND deleted_at IS NULL RETURNING id
  `;

    if (!result) {
        return res.status(404).json({ error: 'Staff not found' });
    }

    res.json({ message: 'Staff deleted successfully' });
}));

// ============== SUB-ROUTES ==============

/**
 * GET /staff/:id/classes
 * Get classes assigned to staff (placeholder - needs class_teachers table)
 */
router.get('/:id/classes', requirePermission('staff.view'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Placeholder - would need class_teachers junction table
    res.json({
        staff_id: id,
        message: 'Class assignment feature requires class_teachers table',
        classes: []
    });
}));

/**
 * GET /staff/:id/timetable
 * Get staff timetable (placeholder - needs timetable tables)
 */
router.get('/:id/timetable', requirePermission('staff.view'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Placeholder - will be implemented in Phase 3
    res.json({
        staff_id: id,
        message: 'Timetable will be implemented in Phase 3',
        schedule: []
    });
}));

/**
 * GET /staff/:id/payslip
 * Get staff payslip (placeholder - needs payroll tables)
 */
router.get('/:id/payslip', requirePermission('staff.view'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Get basic salary info
    const [staff] = await sql`
    SELECT st.salary, p.display_name, sd.name as designation
    FROM staff st
    JOIN persons p ON st.person_id = p.id
    LEFT JOIN staff_designations sd ON st.designation_id = sd.id
    WHERE st.id = ${id} AND st.deleted_at IS NULL
  `;

    if (!staff) {
        return res.status(404).json({ error: 'Staff not found' });
    }

    res.json({
        staff_id: id,
        name: staff.display_name,
        designation: staff.designation,
        basic_salary: staff.salary,
        message: 'Full payroll system will be implemented in a future phase'
    });
}));

export default router;
