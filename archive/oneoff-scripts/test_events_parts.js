import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function run() {
    await client.connect();

    const tests = [
        { label: "school_id = current_school_id()", q: "SELECT 1 FROM events WHERE school_id = current_school_id() LIMIT 1" },
        { label: "is_public = true", q: "SELECT 1 FROM events WHERE is_public = true LIMIT 1" },
        { label: "created_by = auth.uid()", q: "SELECT 1 FROM events WHERE created_by = auth.uid() LIMIT 1" },
        { label: "target_audience = 'all'", q: "SELECT 1 FROM events WHERE target_audience = 'all'::notice_audience_enum LIMIT 1" },
        { label: "auth.role() = 'authenticated'", q: "SELECT 1 FROM events WHERE auth.role() = 'authenticated' LIMIT 1" },
        { label: "target_audience = 'staff'", q: "SELECT 1 FROM events WHERE target_audience = 'staff'::notice_audience_enum LIMIT 1" },
        { label: "auth_has_role", q: "SELECT 1 FROM events WHERE auth_has_role(ARRAY['admin', 'teacher', 'staff', 'accounts']) LIMIT 1" }
    ];

    let results = "";
    for (const test of tests) {
        try {
            await client.query(test.q);
            results += `✅ OK: ${test.label}\n`;
        } catch (e) {
            results += `❌ FAIL: ${test.label} -> ${e.message}\n`;
        }
    }

    fs.writeFileSync('test_results.txt', results);
    await client.end();
}

run().catch(console.error);
