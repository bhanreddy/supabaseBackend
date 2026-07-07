import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function run() {
    await client.connect();

    const res = {};
    const cols = await client.query(`
        SELECT column_name, data_type, udt_name 
        FROM information_schema.columns 
        WHERE table_name = 'school_settings'
    `);
    res.columns = cols.rows;

    const consts = await client.query(`
        SELECT conname, contype, pg_get_constraintdef(c.oid)
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE conrelid = 'school_settings'::regclass
    `);
    res.constraints = consts.rows;

    const indexes = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'school_settings'
    `);
    res.indexes = indexes.rows;

    fs.writeFileSync('settings_details.json', JSON.stringify(res, null, 2));

    await client.end();
}

run().catch(console.error);
