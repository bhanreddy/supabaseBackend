import sql from './db.js';

async function check() {
    try {
        const enrollments = await sql`
            SELECT 
                se.roll_number, p.first_name
            FROM student_enrollments se
            JOIN students s ON se.student_id = s.id
            JOIN persons p ON s.person_id = p.id
            WHERE s.admission_no LIKE 'ROLL-TEST%'
            ORDER BY se.roll_number ASC
        `;

        console.log('--- RESULTS ---');
        enrollments.forEach(e => {
            console.log(`${e.first_name} : ${e.roll_number}`);
        });
        console.log('--- END ---');
    } catch (e) {
        console.error(e);
    } process.exit();
}

check();
