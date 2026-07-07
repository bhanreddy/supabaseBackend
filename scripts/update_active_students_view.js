
import sql from '../db.js';

async function updateActiveStudentsView() {
  try {

    await sql`
            CREATE OR REPLACE VIEW active_students AS
            SELECT * FROM students 
            WHERE deleted_at IS NULL 
              AND status_id = 1;
        `;

    // Verification
    const count = await sql`SELECT COUNT(*) FROM active_students`;

  } catch (error) {

  } finally {
    process.exit();
  }
}

updateActiveStudentsView();