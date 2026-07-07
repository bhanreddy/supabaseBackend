import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';
dotenv.config();

const client = new Client({
    connectionString: process.env.DATABASE_URL,
});

async function introspect() {
    await client.connect();
    const tables = ['countries', 'genders', 'student_categories', 'religions', 'blood_groups', 'relationship_types', 'staff_designations'];
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

    console.log(JSON.stringify(columnsByTable, null, 2));
    await client.end();
}

introspect().catch(console.error);
