import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function run() {
    await client.connect();

    const res = await client.query(`
        SELECT column_name, data_type, udt_name 
        FROM information_schema.columns 
        WHERE table_name = 'schools' 
        ORDER BY ordinal_position
    `);

    fs.writeFileSync('schools_schema.json', JSON.stringify(res.rows, null, 2));

    await client.end();
}

run().catch(console.error);
