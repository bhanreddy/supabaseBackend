import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';
dotenv.config();

const client = new Client({
    connectionString: process.env.DATABASE_URL,
});

async function remediate() {
    await client.connect();
    console.log('Remediating persons and users tables...');
    await client.query(`
    ALTER TABLE IF EXISTS persons ADD COLUMN IF NOT EXISTS school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE;
    ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS school_id INTEGER NOT NULL DEFAULT 1 REFERENCES schools(id) ON DELETE CASCADE;
  `);
    console.log('Fixed persons and users columns in DB.');
    await client.end();
}

remediate().catch(console.error);
