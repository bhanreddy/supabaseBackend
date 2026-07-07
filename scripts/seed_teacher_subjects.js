import sql from '../db.js';

async function run() {
  try {

    // Debug: List all staff

    const allStaff = await sql`
            SELECT s.id, p.display_name, p.first_name, p.last_name 
            FROM staff s 
            JOIN persons p ON s.person_id = p.id
        `;

    allStaff.forEach((s) => {});

    try {
      const allTeachers = await sql`
                SELECT t.id, p.display_name 
                FROM teachers t 
                JOIN persons p ON t.person_id = p.id
            `;

      allTeachers.forEach((t) => {});
    } catch (e) {

    }

    const teachers = await sql`
            SELECT s.id, p.display_name, p.first_name 
            FROM staff s 
            JOIN persons p ON s.person_id = p.id 
            WHERE p.first_name ILIKE '%Bharath%' OR p.last_name ILIKE '%Bharath%' OR p.display_name ILIKE '%Bharath%'
        `;

    if (teachers.length === 0) {

      // Try matching with specific ID if known
      const byId = await sql`SELECT * FROM staff WHERE person_id = '29459ec7-b755-4b26-a32d-0b14d6651633'`;
      if (byId.length > 0) {

        teachers.push(byId[0]);
      } else {
        process.exit(1);
      }
    }

    const teacher = teachers[0];

    const assignments = await sql`
            SELECT cs.id, c.name as class_name, s.name as subject_name
            FROM class_subjects cs
            JOIN class_sections csec ON cs.class_section_id = csec.id
            JOIN classes c ON csec.class_id = c.id
            JOIN subjects s ON cs.subject_id = s.id
            WHERE cs.teacher_id = ${teacher.id}
        `;

    if (assignments.length === 0) {

      // Get Class 10 A
      const classSections = await sql`
                SELECT cs.id, c.name, sec.name as section 
                FROM class_sections cs 
                JOIN classes c ON cs.class_id = c.id
                JOIN sections sec ON cs.section_id = sec.id
                WHERE c.name = 'Class 10' AND sec.name = 'A'
            `;

      // Get Subjects
      const subjects = await sql`SELECT id, name FROM subjects WHERE name IN ('Mathematics', 'Physics', 'English')`;

      if (classSections.length > 0 && subjects.length > 0) {
        const csId = classSections[0].id;

        for (const subj of subjects) {
          try {
            await sql`
                            INSERT INTO class_subjects (class_section_id, subject_id, teacher_id)
                            VALUES (${csId}, ${subj.id}, ${teacher.id})
                            ON CONFLICT (class_section_id, subject_id) 
                            DO UPDATE SET teacher_id = ${teacher.id}
                        `;

          } catch (e) {

          }
        }
      } else {

      }
    }
  } catch (err) {

  } finally {
    process.exit(0);
  }
}

run();