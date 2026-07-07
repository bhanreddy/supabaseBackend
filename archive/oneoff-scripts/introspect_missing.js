import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';
dotenv.config();

const client = new Client({
    connectionString: process.env.DATABASE_URL,
});

async function introspect() {
    await client.connect();
    const tables = ['persons', 'users', 'students', 'staff', 'academic_years', 'academic_terms', 'classes', 'notices', 'events', 'complaints', 'daily_attendance', 'expenses', 'lms_courses', 'timetable_slots', 'school_settings'];
    const res = await client.query(`
    SELECT table_name, column_name 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = ANY($1)
  `, [tables]);

    const columnsByTable = {};
    res.rows.forEach(row => {
        if (!columnsByTable[row.table_name]) columnsByTable[row.table_name] = [];
        columnsByTable[row.table_name].push(row.column_name);
    });

    // Show only tables that MISS school_id
    const missing = [];
    tables.forEach(table => {
        if (columnsByTable[table] && !columnsByTable[table].includes('school_id')) {
            missing.push(table);
        } else if (!columnsByTable[table]) {
            // table might not exist
        }
    });

    console.log('Tables missing school_id:', missing);
    await client.end();
}

introspect().catch(console.error);
