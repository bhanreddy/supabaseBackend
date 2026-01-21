import sql from './db.js';

async function check() {
    try {
        console.log('Checking DB...');
        const enrollments = await sql`
            SELECT 
                se.id, se.student_id, se.roll_number, se.class_section_id, s.admission_no, p.first_name
            FROM student_enrollments se
            JOIN students s ON se.student_id = s.id
            JOIN persons p ON s.person_id = p.id
            WHERE s.admission_no LIKE 'ROLL-TEST%'
        `;

        console.log('Enrollments found:', enrollments.length);
        console.log(JSON.stringify(enrollments, null, 2));
    } catch (e) {
        console.error(e);
    } process.exit();
}

check();
