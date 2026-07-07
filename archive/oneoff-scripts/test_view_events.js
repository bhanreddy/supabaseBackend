import { readFileSync, appendFileSync } from 'fs';
import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    const policy = `
DROP POLICY IF EXISTS "View Events" ON events;
CREATE POLICY "View Events" ON events
FOR SELECT
USING (school_id = current_school_id() AND (
  is_public = true OR
  created_by = auth.uid() OR
  (target_audience = 'all' AND auth.role() = 'authenticated') OR
  (target_audience = 'staff' AND auth_has_role(ARRAY['admin', 'teacher', 'staff', 'accounts']))
) );`;

    try {
        await client.query(policy);
        console.log('SUCCESS');
    } catch (e) {
        console.error('ERROR:', e.message);
    }
    await client.end();
}
run();
