const fs = require('fs');
const { Client } = require('pg');
require('dotenv').config();

async function run() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    const parts = [
        `school_id = current_school_id()`,
        `is_public = true`,
        `created_by = auth.uid()`,
        `target_audience = 'all'`,
        `auth.role() = 'authenticated'`,
        `target_audience = 'staff'`,
        `auth_has_role(ARRAY['admin', 'teacher', 'staff', 'accounts'])`
    ];

    let out = '';
    for (const part of parts) {
        const q = `SELECT 1 FROM events WHERE ${part} LIMIT 1`;
        try {
            await client.query(q);
            out += `✅ OK: ${part}\n`;
        } catch (err) {
            out += `❌ ERROR: ${part} -> ${err.message}\n`;
        }
    }

    fs.writeFileSync('test_out.txt', out);
    console.log('Done!');
    await client.end();
}
run().catch(console.error);
