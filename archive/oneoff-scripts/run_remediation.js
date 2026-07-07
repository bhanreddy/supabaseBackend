import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function run() {
    await client.connect();
    console.log("Connected to database. Applying remediation...");

    const sql = fs.readFileSync('remediate_school_id.sql', 'utf8');

    try {
        await client.query(sql);
        console.log("✅ Remediation applied successfully!");
    } catch (e) {
        console.error("❌ Remediation failed:");
        console.error(e.message);
        if (e.detail) console.error(e.detail);
        if (e.hint) console.error(e.hint);
        if (e.where) console.error(e.where);
    } finally {
        await client.end();
    }
}

run().catch(console.error);
