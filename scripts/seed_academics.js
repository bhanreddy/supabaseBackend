import sql from '../db.js';

async function seedAcademics() {
  try {

    // 1. Seed Classes (1 to 12)
    const classes = [
    'Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5',
    'Class 6', 'Class 7', 'Class 8', 'Class 9', 'Class 10',
    'Class 11', 'Class 12'];

    for (const className of classes) {
      const code = className.replace('Class ', '');
      await sql`
                INSERT INTO classes (name, code)
                VALUES (${className}, ${code})
                ON CONFLICT (name) DO NOTHING
            `;

    }

    // 2. Seed Sections (A to D)
    const sections = ['Section A', 'Section B', 'Section C', 'Section D'];
    for (const sectionName of sections) {
      const code = sectionName.replace('Section ', '');
      await sql`
                INSERT INTO sections (name, code)
                VALUES (${sectionName}, ${code})
                ON CONFLICT (name) DO NOTHING
            `;

    }

    // 3. Seed Academic Year (Current)
    const currentYearCode = '2025-2026';
    const startDate = '2025-06-01';
    const endDate = '2026-05-31';

    await sql`
            INSERT INTO academic_years (code, start_date, end_date)
            VALUES (${currentYearCode}, ${startDate}, ${endDate})
            ON CONFLICT (code) DO NOTHING
        `;

  } catch (error) {

  } finally {
    process.exit();
  }
}

seedAcademics();