import express from 'express';
import sql from '../db.js';

const router = express.Router();

// Get all teachers
router.get('/', async (req, res) => {
    try {
        const teachers = await sql`
      SELECT 
        t.id, t.employee_code, t.joining_date,
        p.first_name, p.middle_name, p.last_name, p.display_name, p.email, p.phone, p.gender_id
        -- est.code as status
      FROM teachers t
      JOIN persons p ON t.person_id = p.id
      -- LEFT JOIN employment_statuses est ON t.status_id = est.id
    `;
        res.json(teachers);
    } catch (error) {
        console.error('Error fetching teachers:', error);
        res.status(500).json({ error: 'Failed to fetch teachers', details: error.message });
    }
});

// Create Teacher
router.post('/', async (req, res) => {
    try {
        const {
            first_name, middle_name, last_name, dob, gender_id,
            employee_code, joining_date, status_id,
            email, phone
        } = req.body;

        if (!first_name || !last_name || !employee_code || !joining_date) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const result = await sql.begin(async sql => {
            // 1. Create Person
            const [person] = await sql`
        INSERT INTO persons (first_name, middle_name, last_name, dob, gender_id)
        VALUES (${first_name}, ${middle_name}, ${last_name}, ${dob}, ${gender_id})
        RETURNING id
      `;

            // 2. Create Teacher
            const [teacher] = await sql`
        INSERT INTO teachers (
          person_id, employee_code, joining_date, status_id
        )
        VALUES (
          ${person.id}, ${employee_code}, ${joining_date}, ${status_id}
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

            return teacher;
        });

        res.status(201).json({
            message: 'Teacher created successfully',
            teacher: result
        });
    } catch (error) {
        console.error('Error creating teacher:', error);
        res.status(500).json({ error: 'Failed to create teacher', details: error.message });
    }
});

export default router;
