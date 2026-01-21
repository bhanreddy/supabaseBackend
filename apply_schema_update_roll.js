import sql from './db.js';

async function applyUpdate() {
    try {
        console.log('Applying Schema Update...');

        // 1. Add roll_number column
        try {
            await sql`ALTER TABLE student_enrollments ADD COLUMN IF NOT EXISTS roll_number INTEGER`;
            console.log('✅ Added roll_number column');
        } catch (e) {
            console.log('⚠️ roll_number column might already exist:', e.message);
        }

        // 2. Add Unique Constraint
        try {
            await sql`ALTER TABLE student_enrollments ADD CONSTRAINT uq_section_roll UNIQUE (class_section_id, academic_year_id, roll_number)`;
            console.log('✅ Added unique constraint');
        } catch (e) {
            console.log('⚠️ Constraint might already exist:', e.message);
        }

        // 3. Create Function
        await sql`
        CREATE OR REPLACE FUNCTION recalculate_section_rolls(
            p_class_section_id UUID,
            p_academic_year_id UUID
        )
        RETURNS VOID AS $$
        DECLARE
            r RECORD;
            counter INTEGER := 1;
        BEGIN
            FOR r IN
                SELECT se.id
                FROM student_enrollments se
                JOIN students s ON se.student_id = s.id
                JOIN persons p ON s.person_id = p.id
                WHERE se.class_section_id = p_class_section_id
                AND se.academic_year_id = p_academic_year_id
                AND se.status = 'active'
                AND se.deleted_at IS NULL
                AND s.deleted_at IS NULL
                ORDER BY p.first_name ASC, p.last_name ASC
            LOOP
                UPDATE student_enrollments
                SET roll_number = counter
                WHERE id = r.id;
                
                counter := counter + 1;
            END LOOP;
        END;
        $$ LANGUAGE plpgsql;
    `;
        console.log('✅ Created recalculate_section_rolls function');

        console.log('Schema update complete.');
    } catch (err) {
        console.error('Error applying update:', err);
    } finally {
        process.exit();
    }
}

applyUpdate();
