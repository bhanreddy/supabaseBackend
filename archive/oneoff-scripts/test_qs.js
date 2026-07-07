const { Client } = require('pg');
require('dotenv').config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

const queries = [
    `SELECT 1 FROM events WHERE school_id = current_school_id() LIMIT 1`,
    `SELECT 1 FROM events WHERE created_by = auth.uid() LIMIT 1`,
    `SELECT 1 FROM events WHERE target_audience = 'all' LIMIT 1`,
    `SELECT 1 FROM events WHERE target_audience = 'staff' LIMIT 1`,
    `SELECT 1 FROM events WHERE auth_has_role(ARRAY['admin', 'teacher', 'staff', 'accounts']) LIMIT 1`
];

client.connect().then(() => {
    let p = Promise.resolve();
    queries.forEach((q, i) => {
        p = p.then(() => {
            return client.query(q).then(() => {
                console.log(`✅ OK: ${q}`);
            }).catch(err => {
                console.log(`❌ ERROR on ${q}: ${err.message}`);
            });
        });
    });
    return p.then(() => client.end());
}).catch(console.error);
