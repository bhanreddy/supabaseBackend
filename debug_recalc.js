import sql from './db.js';

async function fix() {
    try {
        console.log('Finding target section...');
        const enrollments = await sql`
            SELECT se.class_section_id, se.academic_year_id
            FROM student_enrollments se
            JOIN students s ON se.student_id = s.id
            WHERE s.admission_no LIKE 'ROLL-TEST%'
            LIMIT 1
        `;

        if (enrollments.length === 0) {
            console.log('No enrollments found to fix.');
            return;
        }

        const { class_section_id, academic_year_id } = enrollments[0];
        console.log(`Fixing ClassSection: ${class_section_id}, Year: ${academic_year_id}`);

        await sql`SELECT recalculate_section_rolls(${class_section_id}, ${academic_year_id})`;

        console.log('Recalculation triggered.');

        // Verify
        const verify = await sql`
            SELECT se.roll_number, p.first_name
            FROM student_enrollments se
            JOIN students s ON se.student_id = s.id
            JOIN persons p ON s.person_id = p.id
            WHERE se.class_section_id = ${class_section_id}
            AND s.admission_no LIKE 'ROLL-TEST%'
            ORDER BY se.roll_number ASC
        `;

        console.log('--- RESULTS ---');
        verify.forEach(e => console.log(`${e.first_name} : ${e.roll_number}`));

    } catch (e) {
        console.error(e);
    } process.exit();
}

fix();
